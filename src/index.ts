import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Environment bindings (set via `wrangler secret put`)
// ---------------------------------------------------------------------------
interface Env {
  FACTORY_API_KEY: string;
  MCP_AUTH_TOKEN: string;
  FACTORY_SHIM_URL: string;
  FACTORY_SHIM_SECRET: string;
}

// ---------------------------------------------------------------------------
// Factory API helpers
// ---------------------------------------------------------------------------
const FACTORY_BASE = "https://api.factory.ai/api/v0";
const textEncoder = new TextEncoder();

async function factoryFetch(
  path: string,
  apiKey: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${FACTORY_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Factory API ${res.status}: ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  return body;
}

function normalizeShimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createShimSignature(rawBody: string, secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${ts}.${rawBody}`),
  );
  return `t=${ts},v1=${bufferToHex(signature)}`;
}

async function shimHealthz(shimUrl: string): Promise<unknown> {
  const res = await fetch(`${normalizeShimUrl(shimUrl)}/healthz`);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Shim /healthz ${res.status}: ${body.slice(0, 400)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function shimExec(
  shimUrl: string,
  shimSecret: string,
  payload: Record<string, unknown>,
): Promise<{ output: string; done: unknown }> {
  const rawBody = JSON.stringify(payload);
  const signature = await createShimSignature(rawBody, shimSecret);
  const res = await fetch(`${normalizeShimUrl(shimUrl)}/factory/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": signature,
    },
    body: rawBody,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shim /factory/exec ${res.status}: ${body.slice(0, 400)}`);
  }

  if (!res.body) {
    return { output: await res.text(), done: null };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let dataLines: string[] = [];
  let output = "";
  let done: unknown = null;

  const flushEvent = () => {
    if (dataLines.length === 0) {
      event = "";
      return;
    }
    const raw = dataLines.join("\n");
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (event === "chunk") {
      if (
        parsed &&
        typeof parsed === "object" &&
        "data" in parsed &&
        typeof (parsed as { data?: unknown }).data === "string"
      ) {
        output += (parsed as { data: string }).data;
      } else if (typeof parsed === "string") {
        output += parsed;
      } else {
        output += `${JSON.stringify(parsed)}\n`;
      }
    } else if (event === "done") {
      done = parsed;
    }

    event = "";
    dataLines = [];
  };

  const processBufferedLines = (flushTail: boolean) => {
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        flushEvent();
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      idx = buffer.indexOf("\n");
    }

    if (flushTail && buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      buffer = "";
      flushEvent();
    }
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    processBufferedLines(false);
  }
  buffer += decoder.decode();
  processBufferedLines(true);

  return { output, done };
}

// ---------------------------------------------------------------------------
// MCP Server factory – creates a fresh server + tools on every request
// ---------------------------------------------------------------------------
function createMcpServer(
  apiKey: string,
  shimUrl: string,
  shimSecret: string,
): McpServer {
  const server = new McpServer(
    { name: "factory-perplexity-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Factory Droid swarm orchestration via Perplexity. " +
        "Spawn, monitor, and control AI coding agents at scale through Factory's Sessions API.",
    },
  );

  // ── 1. list_computers ────────────────────────────────────────────
  server.registerTool(
    "list_computers",
    {
      description:
        "List all connected Factory Droid computers (execution hosts). " +
        "Returns computer IDs, names, provider types, and status.",
    },
    async () => {
      const data = (await factoryFetch("/computers", apiKey)) as {
        computers: Array<Record<string, unknown>>;
      };
      const lines = data.computers.map(
        (c) => `- ${c.id}  name=${c.name ?? "?"}  status=${c.status}  provider=${c.providerType ?? "?"}`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              `Found ${data.computers.length} computer(s):\n` +
              lines.join("\n"),
          },
        ],
      };
    },
  );

  // ── 2. spawn_droid ───────────────────────────────────────────────
  server.registerTool(
    "spawn_droid",
    {
      description:
        "Launch a new Factory Droid session. Creates an AI coding agent that executes " +
        "the given prompt on the specified computer. Returns the session ID for tracking.",
      inputSchema: {
        prompt: z
          .string()
          .describe(
            "The task prompt for the droid to execute (required, max 100k chars)",
          ),
        computerId: z
          .string()
          .optional()
          .describe(
            "Computer ID to execute on (defaults to first available active computer)",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Model to use (e.g. claude-opus-4-7, claude-sonnet-4-6, gpt-5)",
          ),
        autonomy: z
          .enum(["off", "low", "medium", "high"])
          .optional()
          .describe("Autonomy level: off, low, medium, high"),
        reasoningEffort: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Reasoning effort for the model"),
      },
    },
    async (args) => {
      // Resolve computer if not specified
      let computerId = args.computerId;
      if (!computerId) {
        const data = (await factoryFetch("/computers", apiKey)) as {
          computers: Array<{ id: string; status: string }>;
        };
        const active = data.computers.filter((c) => c.status === "active");
        if (active.length === 0) throw new Error("No active computers available");
        computerId = active[0].id;
      }

      const model = args.model ?? "claude-sonnet-4-6";

      // Step 1: Create the session
      const sessionBody: Record<string, unknown> = {
        computerId,
        sessionSettings: { model },
      };
      if (args.autonomy) {
        (sessionBody.sessionSettings as Record<string, unknown>).autonomyLevel =
          args.autonomy;
      }
      if (args.reasoningEffort) {
        (sessionBody.sessionSettings as Record<string, unknown>).reasoningEffort =
          args.reasoningEffort;
      }

      const session = (await factoryFetch("/sessions", apiKey, {
        method: "POST",
        body: JSON.stringify(sessionBody),
      })) as { sessionId: string; status: string };

      // Step 2: Send the initial prompt as a message
      await factoryFetch(`/sessions/${session.sessionId}/messages`, apiKey, {
        method: "POST",
        body: JSON.stringify({ text: args.prompt }),
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `Droid spawned successfully!`,
              `  sessionId: ${session.sessionId}`,
              `  status:   ${session.status}`,
              `  computer: ${computerId}`,
              `  model:    ${model}`,
              ``,
              `Track with get_droid("${session.sessionId}")`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 3. spawn_swarm ───────────────────────────────────────────────
  server.registerTool(
    "spawn_swarm",
    {
      description:
        "Launch multiple droids in parallel. Fans out N prompts as independent sessions. " +
        "All share the same computer and model. Returns all session IDs.",
      inputSchema: {
        prompts: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe("List of prompt strings (1–50). Each launches one droid."),
        computerId: z
          .string()
          .optional()
          .describe("Computer ID (defaults to first active)"),
        model: z.string().optional().describe("Model for all swarm members"),
        autonomy: z
          .enum(["off", "low", "medium", "high"])
          .optional()
          .describe("Autonomy level for all swarm members"),
      },
    },
    async (args) => {
      // Resolve computer
      let computerId = args.computerId;
      if (!computerId) {
        const data = (await factoryFetch("/computers", apiKey)) as {
          computers: Array<{ id: string; status: string }>;
        };
        const active = data.computers.filter((c) => c.status === "active");
        if (active.length === 0) throw new Error("No active computers available");
        computerId = active[0].id;
      }

      const model = args.model ?? "claude-sonnet-4-6";

      // Base session body
      const sessionSettings: Record<string, unknown> = { model };
      if (args.autonomy) sessionSettings.autonomyLevel = args.autonomy;

      const results: Array<{ index: number; sessionId: string; prompt: string }> = [];
      const errors: Array<{ index: number; error: string }> = [];

      // Process in batches of 10 to avoid overwhelming the API
      const batchSize = 10;
      for (let i = 0; i < args.prompts.length; i += batchSize) {
        const batch = args.prompts.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map(async (prompt, bi) => {
            const idx = i + bi;
            // Create session
            const session = (await factoryFetch("/sessions", apiKey, {
              method: "POST",
              body: JSON.stringify({ computerId, sessionSettings }),
            })) as { sessionId: string };
            // Send prompt as message
            await factoryFetch(
              `/sessions/${session.sessionId}/messages`,
              apiKey,
              { method: "POST", body: JSON.stringify({ text: prompt }) },
            );
            return session;
          }),
        );

        batchResults.forEach((result, bi) => {
          const idx = i + bi;
          if (result.status === "fulfilled") {
            results.push({
              index: idx,
              sessionId: result.value.sessionId,
              prompt: args.prompts[idx],
            });
          } else {
            errors.push({ index: idx, error: String(result.reason) });
          }
        });
      }

      const lines = [
        `Swarm launched: ${results.length} succeeded, ${errors.length} failed`,
        ``,
        ...results.map(
          (r) => `${r.index}: ${r.sessionId} — ${r.prompt.slice(0, 80)}...`,
        ),
      ];
      if (errors.length > 0) {
        lines.push(``, `Errors:`, ...errors.map((e) => `  ${e.index}: ${e.error}`));
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  // ── 4. spawn_and_watch ──────────────────────────────────────────
  server.registerTool(
    "spawn_and_watch",
    {
      description:
        "Spawn a droid and poll until it completes (goes idle), then return the full " +
        "message log. This is a single-call alternative to spawn + poll + fetch messages.",
      inputSchema: {
        prompt: z
          .string()
          .describe("The task prompt for the droid to execute (required)"),
        model: z
          .string()
          .optional()
          .describe("Model to use (e.g. claude-opus-4-7, claude-sonnet-4-6, gpt-5)"),
        autonomy: z
          .enum(["off", "low", "medium", "high"])
          .optional()
          .describe("Autonomy level: off, low, medium, high"),
        reasoningEffort: z
          .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Reasoning effort for the model"),
        computerId: z
          .string()
          .optional()
          .describe("Computer ID (defaults to first active)"),
        pollIntervalSeconds: z
          .number()
          .int()
          .min(5)
          .max(60)
          .optional()
          .default(15)
          .describe("Seconds between status polls (5–60, default 15)"),
        timeoutSeconds: z
          .number()
          .int()
          .min(30)
          .max(3600)
          .optional()
          .default(600)
          .describe("Max seconds to wait before giving up (30–3600, default 600)"),
      },
    },
    async (args) => {
      // Resolve computer
      let computerId = args.computerId;
      if (!computerId) {
        const data = (await factoryFetch("/computers", apiKey)) as {
          computers: Array<{ id: string; status: string }>;
        };
        const active = data.computers.filter((c) => c.status === "active");
        if (active.length === 0) throw new Error("No active computers available");
        computerId = active[0].id;
      }

      const model = args.model ?? "claude-sonnet-4-6";
      const pollMs = (args.pollIntervalSeconds ?? 15) * 1000;
      const deadline = Date.now() + (args.timeoutSeconds ?? 600) * 1000;

      // Step 1: Create session and send prompt
      const sessionBody: Record<string, unknown> = {
        computerId,
        sessionSettings: { model },
      };
      if (args.autonomy) {
        (sessionBody.sessionSettings as Record<string, unknown>).autonomyLevel =
          args.autonomy;
      }
      if (args.reasoningEffort) {
        (sessionBody.sessionSettings as Record<string, unknown>).reasoningEffort =
          args.reasoningEffort;
      }

      const session = (await factoryFetch("/sessions", apiKey, {
        method: "POST",
        body: JSON.stringify(sessionBody),
      })) as { sessionId: string; status: string };

      await factoryFetch(`/sessions/${session.sessionId}/messages`, apiKey, {
        method: "POST",
        body: JSON.stringify({ text: args.prompt }),
      });

      // Step 2: Poll until idle or timeout
      let finalStatus = "";
      while (Date.now() < deadline) {
        const statusData = (await factoryFetch(
          `/sessions/${session.sessionId}`,
          apiKey,
        )) as { status: string };
        if (statusData.status === "idle" || statusData.status === "error") {
          finalStatus = statusData.status;
          break;
        }
        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      if (!finalStatus) {
        // Try to interrupt the timed-out session
        try {
          await factoryFetch(
            `/sessions/${session.sessionId}/interrupt`,
            apiKey,
            { method: "POST" },
          );
        } catch {
          // Best effort
        }
        finalStatus = "timeout";
      }

      // Step 3: Fetch all messages
      const messages = (await factoryFetch(
        `/sessions/${session.sessionId}/messages?limit=200`,
        apiKey,
      )) as { messages: Array<{ role: string; content: unknown }> };

      const msgLines = (messages.messages ?? []).map(
        (m: { role: string; content: unknown }, i: number) =>
          `  [${i}] ${m.role}: ${JSON.stringify(m.content).slice(0, 500)}`,
      );

      return {
        content: [
          {
            type: "text",
            text: [
              `Droid completed!`,
              `  sessionId: ${session.sessionId}`,
              `  status:    ${finalStatus}`,
              `  messages:  ${messages.messages?.length ?? 0}`,
              ``,
              `Full message log:`,
              ...msgLines,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 5. list_droids ───────────────────────────────────────────────
  server.registerTool(
    "list_droids",
    {
      description:
        "List recent droid sessions with full session UUIDs, status, computer name, and metadata. " +
        "Filter by status (idle, pending, running) and limit results.",
      inputSchema: {
        status: z
          .enum(["idle", "pending", "running"])
          .optional()
          .describe("Filter by session status"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Max sessions to return (default 20, max 100)"),
      },
    },
    async (args) => {
      // Parallel fetch sessions + computers (for name lookup)
      const [sessionsData, computersData] = await Promise.all([
        factoryFetch(`/sessions?limit=${args.limit ?? 20}`, apiKey) as Promise<{
          sessions: Array<{
            sessionId: string;
            title: string;
            status: string;
            createdAt: number;
            updatedAt?: number;
            messageCount: number;
            computerId?: string;
          }>;
        }>,
        factoryFetch("/computers", apiKey) as Promise<{
          computers: Array<{ id: string; name?: string; status: string }>;
        }>,
      ]);

      // Build computer name lookup: id -> name
      const computerNames = new Map<string, string>(
        computersData.computers.map((c) => [c.id, c.name ?? c.id]),
      );

      let sessions = sessionsData.sessions;
      if (args.status) {
        sessions = sessions.filter((s) => s.status === args.status);
      }

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No droid sessions found." }],
        };
      }

      const blocks = sessions.map((s, idx) => {
        const title =
          (s.title ?? "untitled").slice(0, 80) +
          ((s.title?.length ?? 0) > 80 ? "..." : "");
        const created = new Date(s.createdAt).toISOString();
        const computerName = s.computerId
          ? (computerNames.get(s.computerId) ?? "unknown")
          : "?";
        const computerLabel = s.computerId
          ? `${computerName} (${s.computerId})`
          : "?";
        return [
          `[${idx + 1}] id=${s.sessionId}  status=${s.status}  computer=${computerLabel}`,
          `    msgs=${s.messageCount}  created=${created}`,
          `    title: ${title}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `${sessions.length} droid session(s):\n\n${blocks.join("\n\n")}`,
          },
        ],
      };
    },
  );

  // ── 6. get_all_active_droids ─────────────────────────────────────
  server.registerTool(
    "get_all_active_droids",
    {
      description:
        "Get all currently active (pending or running) droid sessions with full session IDs, " +
        "current status, message count, last message preview, and elapsed time.",
    },
    async () => {
      const data = (await factoryFetch("/sessions?limit=100", apiKey)) as {
        sessions: Array<{
          sessionId: string;
          title: string;
          status: string;
          createdAt: number;
          messageCount: number;
          computerId?: string;
        }>;
      };

      const active = data.sessions.filter(
        (s) => s.status === "pending" || s.status === "running",
      );

      if (active.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No active (pending/running) droid sessions found.",
            },
          ],
        };
      }

      const now = Date.now();
      const lines = await Promise.all(
        active.map(async (s) => {
          const elapsed = Math.floor((now - s.createdAt) / 1000);
          const elapsedStr =
            elapsed < 60
              ? `${elapsed}s`
              : elapsed < 3600
                ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                : `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;

          // Get last message preview
          let lastMsg = "(no messages)";
          try {
            const msgs = (await factoryFetch(
              `/sessions/${s.sessionId}/messages?limit=1`,
              apiKey,
            )) as { messages: Array<{ role: string; content: unknown }> };
            if (msgs.messages && msgs.messages.length > 0) {
              const m = msgs.messages[msgs.messages.length - 1];
              lastMsg = `[${m.role}] ${JSON.stringify(m.content).slice(0, 120)}`;
            }
          } catch {
            lastMsg = "(error fetching)";
          }

          return (
            `${s.sessionId}  [${s.status}]  elapsed=${elapsedStr}  ` +
            `msgs=${s.messageCount}  last=${lastMsg}`
          );
        }),
      );

      return {
        content: [
          {
            type: "text",
            text: `${active.length} active droid(s):\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );

  // ── 7. get_droid ─────────────────────────────────────────────────
  server.registerTool(
    "get_droid",
    {
      description:
        "Get detailed status, full message history, tool execution timeline, current tool in use, " +
        "timestamps per message, and running/pending sub-tasks for a specific droid session.",
      inputSchema: {
        sessionId: z.string().describe("The droid session ID to fetch"),
        messageLimit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(200)
          .describe("Max messages to fetch (default 200, max 500)"),
      },
    },
    async (args) => {
      type MsgBlock = Record<string, unknown>;
      type Msg = {
        id?: string;
        role: string;
        content: MsgBlock[] | unknown;
        createdAt?: number;
        updatedAt?: number;
        parentId?: string;
      };

      const [session, messagesData] = await Promise.all([
        factoryFetch(`/sessions/${args.sessionId}`, apiKey) as Promise<
          Record<string, unknown>
        >,
        factoryFetch(
          `/sessions/${args.sessionId}/messages?limit=${args.messageLimit ?? 200}`,
          apiKey,
        ) as Promise<{ messages: Msg[] }>,
      ]);

      const msgs = messagesData.messages ?? [];
      const ss = session.sessionSettings as Record<string, unknown> | undefined;

      // Build tool execution timeline and track pending (in-progress) tool calls
      const toolTimeline: string[] = [];
      const pendingTools = new Map<
        string,
        { name: string; inputSummary: string; startedAt: string }
      >();

      for (const msg of msgs) {
        const blocks = Array.isArray(msg.content) ? (msg.content as MsgBlock[]) : [];
        const msgTs = msg.createdAt
          ? new Date(msg.createdAt).toISOString()
          : "?";

        for (const block of blocks) {
          if (block.type === "tool_use") {
            const toolId = block.id as string;
            const toolName = (block.name as string) ?? "unknown";
            const inputSummary = JSON.stringify(block.input).slice(0, 150);
            pendingTools.set(toolId, {
              name: toolName,
              inputSummary,
              startedAt: msgTs,
            });
            toolTimeline.push(
              `  ${msgTs}  [CALL]  ${toolName}  args=${inputSummary}`,
            );
          } else if (block.type === "tool_result") {
            const toolUseId = block.toolUseId as string;
            const pending = pendingTools.get(toolUseId);
            if (pending) {
              pendingTools.delete(toolUseId);
              const errFlag = block.isError ? " (ERROR)" : "";
              toolTimeline.push(
                `  ${msgTs}  [DONE]  ${pending.name}${errFlag}`,
              );
            }
          }
        }
      }

      // Format full message history with timestamps and parsed content
      const msgLines: string[] = [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const ts = m.createdAt
          ? new Date(m.createdAt).toISOString()
          : "unknown";
        const blocks = Array.isArray(m.content)
          ? (m.content as MsgBlock[])
          : [];

        const parts: string[] = [];
        for (const block of blocks) {
          if (block.type === "thinking") {
            const snippet = ((block.thinking as string) ?? "").slice(0, 300);
            parts.push(`<thinking>${snippet}${snippet.length >= 300 ? "..." : ""}</thinking>`);
          } else if (block.type === "text") {
            const text = ((block.text as string) ?? "").slice(0, 600);
            parts.push(text);
          } else if (block.type === "tool_use") {
            parts.push(
              `[tool_use: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})]`,
            );
          } else if (block.type === "tool_result") {
            const resultContent = JSON.stringify(
              block.content ?? block.output,
            ).slice(0, 300);
            const errFlag = block.isError ? " ERROR" : "";
            parts.push(`[tool_result${errFlag}: ${resultContent}]`);
          }
        }

        msgLines.push(
          `  [${i}] ${ts}  ${m.role}:\n    ${parts.join(" | ").slice(0, 800)}`,
        );
      }

      // Assemble final output
      const lines: string[] = [
        `Droid ${args.sessionId}:`,
        `  status:        ${session.status ?? "?"}`,
        `  title:         ${((session.title as string) ?? "untitled").slice(0, 120)}`,
        `  computer:      ${session.computerId ?? "?"}`,
        `  model:         ${ss?.model ?? "?"}`,
        `  messageCount:  ${session.messageCount ?? msgs.length}`,
        `  createdAt:     ${new Date((session.createdAt as number) ?? 0).toISOString()}`,
        `  updatedAt:     ${new Date((session.updatedAt as number) ?? 0).toISOString()}`,
        ``,
      ];

      if (pendingTools.size > 0) {
        lines.push(`Active/pending tools (${pendingTools.size}) — currently in progress:`);
        for (const [, t] of pendingTools) {
          lines.push(
            `  [IN-PROGRESS] ${t.name}  started=${t.startedAt}  args=${t.inputSummary}`,
          );
        }
        lines.push(``);
      }

      if (toolTimeline.length > 0) {
        const shown = toolTimeline.slice(-40);
        lines.push(
          `Tool execution timeline (showing last ${shown.length} of ${toolTimeline.length} events):`,
        );
        lines.push(...shown);
        lines.push(``);
      }

      lines.push(`Full message history (${msgs.length} messages):`);
      lines.push(...msgLines);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  // ── 8. get_droid_messages_full ───────────────────────────────────
  server.registerTool(
    "get_droid_messages_full",
    {
      description:
        "Get ALL messages from a droid session (not just recent ones), with role labels " +
        "(user/assistant) and timestamps. Useful for reviewing droid outputs and file contents.",
      inputSchema: {
        sessionId: z.string().describe("The droid session ID to fetch messages for"),
        maxMessages: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(200)
          .describe("Max messages to return (1–500, default 200)"),
      },
    },
    async (args) => {
      const session = (await factoryFetch(
        `/sessions/${args.sessionId}`,
        apiKey,
      )) as Record<string, unknown>;

      const messages = (await factoryFetch(
        `/sessions/${args.sessionId}/messages?limit=${args.maxMessages ?? 200}`,
        apiKey,
      )) as {
        messages: Array<{
          role: string;
          content: unknown;
          createdAt?: number;
        }>;
      };

      const msgs = messages.messages ?? [];
      const msgLines = msgs.map(
        (m: { role: string; content: unknown; createdAt?: number }, i: number) => {
          const ts = m.createdAt
            ? new Date(m.createdAt).toISOString()
            : "unknown";
          const body = JSON.stringify(m.content).slice(0, 600);
          return `  [${i}] ${ts}  ${m.role}:\n    ${body}`;
        },
      );

      const ss = session.sessionSettings as Record<string, unknown> | undefined;

      return {
        content: [
          {
            type: "text",
            text: [
              `Droid ${args.sessionId} — Full Message Log`,
              `  status:       ${session.status ?? "?"}`,
              `  title:        ${(session.title as string) ?? "untitled"}`,
              `  model:        ${ss?.model ?? "?"}`,
              `  total msgs:   ${msgs.length}`,
              ``,
              ...msgLines,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 9. message_droid ─────────────────────────────────────────────
  server.registerTool(
    "message_droid",
    {
      description:
        "Send a message to a running droid session. The droid will process and respond.",
      inputSchema: {
        sessionId: z.string().describe("Target droid session ID"),
        text: z.string().describe("Message text to send"),
      },
    },
    async (args) => {
      await factoryFetch(`/sessions/${args.sessionId}/messages`, apiKey, {
        method: "POST",
        body: JSON.stringify({ text: args.text }),
      });

      return {
        content: [
          {
            type: "text",
            text: `Message sent to droid ${args.sessionId}. It will process and respond.`,
          },
        ],
      };
    },
  );

  // ── 10. respawn_with_context ─────────────────────────────────────
  server.registerTool(
    "respawn_with_context",
    {
      description:
        "Continue a dead (idle) session by fetching its full message log and spawning " +
        "a NEW droid with that context prepended plus a follow-up prompt. Simulates " +
        "session continuation.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("The completed droid session ID to resume from"),
        followupPrompt: z
          .string()
          .describe("The follow-up task or question for the new droid"),
        model: z
          .string()
          .optional()
          .describe("Model for the new droid (defaults to claude-sonnet-4-6)"),
        autonomy: z
          .enum(["off", "low", "medium", "high"])
          .optional()
          .describe("Autonomy level for the new droid"),
        computerId: z
          .string()
          .optional()
          .describe("Computer ID (defaults to first active)"),
      },
    },
    async (args) => {
      // Step 1: Fetch full message log from completed session
      const oldMessages = (await factoryFetch(
        `/sessions/${args.sessionId}/messages?limit=200`,
        apiKey,
      )) as {
        messages: Array<{ role: string; content: unknown }>;
      };

      const msgs = oldMessages.messages ?? [];
      if (msgs.length === 0) {
        throw new Error(`Session ${args.sessionId} has no messages to resume from`);
      }

      // Step 2: Build context from old messages
      const contextLines = [
        `=== CONTEXT FROM PREVIOUS SESSION (${args.sessionId}) ===`,
        "",
      ];
      for (const m of msgs) {
        contextLines.push(
          `[${m.role}]: ${JSON.stringify(m.content).slice(0, 2000)}`,
        );
        contextLines.push("");
      }
      contextLines.push("=== END CONTEXT ===");
      contextLines.push("");
      contextLines.push("NEW INSTRUCTION (follow-up):");
      contextLines.push(args.followupPrompt);

      const fullPrompt = contextLines.join("\n");

      // Step 3: Resolve computer
      let computerId = args.computerId;
      if (!computerId) {
        const data = (await factoryFetch("/computers", apiKey)) as {
          computers: Array<{ id: string; status: string }>;
        };
        const active = data.computers.filter((c) => c.status === "active");
        if (active.length === 0) throw new Error("No active computers available");
        computerId = active[0].id;
      }

      const model = args.model ?? "claude-sonnet-4-6";
      const sessionSettings: Record<string, unknown> = { model };
      if (args.autonomy) sessionSettings.autonomyLevel = args.autonomy;

      // Step 4: Spawn new droid with full context
      const session = (await factoryFetch("/sessions", apiKey, {
        method: "POST",
        body: JSON.stringify({ computerId, sessionSettings }),
      })) as { sessionId: string; status: string };

      await factoryFetch(`/sessions/${session.sessionId}/messages`, apiKey, {
        method: "POST",
        body: JSON.stringify({ text: fullPrompt }),
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `Respawned droid with context from ${args.sessionId}:`,
              `  new sessionId:  ${session.sessionId}`,
              `  status:         ${session.status}`,
              `  model:          ${model}`,
              `  context msgs:   ${msgs.length}`,
              `  follow-up:      "${args.followupPrompt.slice(0, 100)}..."`,
              ``,
              `Track with get_droid("${session.sessionId}")`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 11. interrupt_droid ──────────────────────────────────────────
  server.registerTool(
    "interrupt_droid",
    {
      description:
        "Interrupt a running droid session. Idempotent — safe to call on already-idle droids.",
      inputSchema: {
        sessionId: z.string().describe("Droid session ID to interrupt"),
      },
    },
    async (args) => {
      await factoryFetch(`/sessions/${args.sessionId}/interrupt`, apiKey, {
        method: "POST",
      });

      return {
        content: [
          {
            type: "text",
            text: `Interrupt signal sent to droid ${args.sessionId}.`,
          },
        ],
      };
    },
  );

  // ── 12. factory_exec ─────────────────────────────────────────────
  server.registerTool(
    "factory_exec",
    {
      description:
        "Execute a prompt through the Legion Factory CLI shim and stream output text.",
      inputSchema: {
        prompt: z.string().describe("Prompt to execute via the shim"),
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory hint forwarded to the shim"),
        auto: z
          .enum(["high", "medium", "off"])
          .optional()
          .describe("Auto mode mapping: high=auto-high, medium=auto-medium, off=normal"),
        mission: z
          .string()
          .optional()
          .describe("Optional mission/session identifier forwarded as session_id"),
      },
    },
    async (args) => {
      if (!shimUrl || !shimSecret) {
        throw new Error("Missing FACTORY_SHIM_URL or FACTORY_SHIM_SECRET");
      }

      const mode =
        args.auto === "medium"
          ? "auto-medium"
          : args.auto === "off"
            ? "normal"
            : "auto-high";

      const payload: Record<string, unknown> = {
        prompt: args.prompt,
        mode,
      };
      if (args.cwd) payload.cwd = args.cwd;
      if (args.mission) {
        payload.mission = args.mission;
        payload.session_id = args.mission;
      }

      const result = await shimExec(shimUrl, shimSecret, payload);
      const output = result.output.trim().length > 0
        ? result.output
        : "(shim returned no streamed output)";
      const doneSuffix = result.done ? `\n\n[done] ${JSON.stringify(result.done)}` : "";

      return {
        content: [
          {
            type: "text",
            text: `${output}${doneSuffix}`,
          },
        ],
      };
    },
  );

  // ── 13. factory_healthz ──────────────────────────────────────────
  server.registerTool(
    "factory_healthz",
    {
      description: "Check Legion shim /healthz status.",
    },
    async () => {
      if (!shimUrl) {
        throw new Error("Missing FACTORY_SHIM_URL");
      }
      const health = await shimHealthz(shimUrl);
      return {
        content: [
          {
            type: "text",
            text: typeof health === "string" ? health : JSON.stringify(health),
          },
        ],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------
const PERPLEXITY_ORIGINS = ["https://www.perplexity.ai", "https://perplexity.ai"];

function isPerplexityOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return PERPLEXITY_ORIGINS.some(
    (allowed) =>
      origin === allowed || origin.endsWith(".perplexity.ai"),
  );
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Session-Id",
  };
  if (origin && isPerplexityOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function addCors(
  response: Response,
  origin: string | null,
): Response {
  const headers = new Headers(response.headers);
  const ch = corsHeaders(origin);
  for (const [k, v] of Object.entries(ch)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return addCors(
        new Response(
          JSON.stringify({ status: "ok", service: "factory-perplexity-mcp" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    }

    // Only /mcp endpoint
    if (url.pathname !== "/mcp") {
      return addCors(new Response("Not Found", { status: 404 }), origin);
    }

    // Auth check — Bearer MCP_AUTH_TOKEN
    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    if (!token || token !== env.MCP_AUTH_TOKEN) {
      return addCors(
        new Response(
          JSON.stringify({ error: "Unauthorized — invalid or missing Bearer token" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
        origin,
      );
    }

    // Build MCP server + transport (stateless — no sessionIdGenerator)
    try {
      const server = createMcpServer(
        env.FACTORY_API_KEY,
        env.FACTORY_SHIM_URL,
        env.FACTORY_SHIM_SECRET,
      );
      const transport = new WebStandardStreamableHTTPServerTransport();

      await server.connect(transport);
      const mcpResponse = await transport.handleRequest(request);
      return addCors(mcpResponse, origin);
    } catch (err) {
      console.error("MCP handler error:", err);
      return addCors(
        new Response(
          JSON.stringify({
            error: "Internal server error",
            detail: String(err),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
        origin,
      );
    }
  },
};
