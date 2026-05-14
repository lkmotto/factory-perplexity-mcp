import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Environment bindings (set via `wrangler secret put`)
// ---------------------------------------------------------------------------
interface Env {
  FACTORY_API_KEY: string;
  MCP_AUTH_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Factory API helpers
// ---------------------------------------------------------------------------
const FACTORY_BASE = "https://api.factory.ai/api/v0";

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

// ---------------------------------------------------------------------------
// MCP Server factory – creates a fresh server + tools on every request
// ---------------------------------------------------------------------------
function createMcpServer(apiKey: string): McpServer {
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

  // ── 4. list_droids ───────────────────────────────────────────────
  server.registerTool(
    "list_droids",
    {
      description:
        "List recent droid sessions. Filter by status (idle, pending, running) and limit results.",
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
      let path = `/sessions?limit=${args.limit ?? 20}`;
      const data = (await factoryFetch(path, apiKey)) as {
        sessions: Array<{
          sessionId: string;
          title: string;
          status: string;
          createdAt: number;
          messageCount: number;
          computerId?: string;
        }>;
      };

      let sessions = data.sessions;
      if (args.status) {
        sessions = sessions.filter((s) => s.status === args.status);
      }

      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No droid sessions found." }],
        };
      }

      const lines = sessions.map((s) => {
        const title =
          (s.title ?? "untitled").slice(0, 60) +
          ((s.title?.length ?? 0) > 60 ? "..." : "");
        const date = new Date(s.createdAt).toISOString();
        return `${s.sessionId.slice(0, 8)}...  [${s.status}]  ${title}  msgs=${s.messageCount}  ${date}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${sessions.length} droid(s):\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );

  // ── 5. get_droid ─────────────────────────────────────────────────
  server.registerTool(
    "get_droid",
    {
      description:
        "Get detailed status and recent messages for a specific droid session.",
      inputSchema: {
        sessionId: z.string().describe("The droid session ID to fetch"),
      },
    },
    async (args) => {
      const session = (await factoryFetch(
        `/sessions/${args.sessionId}`,
        apiKey,
      )) as Record<string, unknown>;

      const messages = (await factoryFetch(
        `/sessions/${args.sessionId}/messages?limit=10`,
        apiKey,
      )) as { messages: Array<{ role: string; content: unknown }> };

      const recentMsgs = (messages.messages ?? [])
        .slice(-5)
        .map(
          (m: { role: string; content: unknown }) =>
            `  [${m.role}] ${JSON.stringify(m.content).slice(0, 200)}`,
        )
        .join("\n");

      const ss = session.sessionSettings as Record<string, unknown> | undefined;

      return {
        content: [
          {
            type: "text",
            text: [
              `Droid ${args.sessionId}:`,
              `  status:       ${session.status ?? "?"}`,
              `  title:        ${(session.title as string) ?? "untitled"}`,
              `  computer:     ${session.computerId ?? "?"}`,
              `  model:        ${ss?.model ?? "?"}`,
              `  messageCount: ${session.messageCount ?? "?"}`,
              `  createdAt:    ${new Date((session.createdAt as number) ?? 0).toISOString()}`,
              ``,
              `Recent messages:`,
              recentMsgs || "  (none)",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ── 6. message_droid ─────────────────────────────────────────────
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

  // ── 7. interrupt_droid ───────────────────────────────────────────
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
      const server = createMcpServer(env.FACTORY_API_KEY);
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
