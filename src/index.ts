import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Environment bindings (set via `wrangler secret put`)
// ---------------------------------------------------------------------------
interface Env {
  FACTORY_API_KEY: string;
  FACTORY_SHIM_URL: string;
  FACTORY_SHIM_SECRET: string;
  MCP_CLIENTS: KVNamespace;
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

async function createShimSignature(
  rawBody: string,
  secret: string,
): Promise<string> {
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

type TokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic";

type RegisteredClient = {
  clientId: string;
  clientSecret?: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  grantTypes: string[];
  responseTypes: string[];
  scope: string;
  clientIdIssuedAt: number;
  clientSecretExpiresAt: number;
};

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  issuedAt: number;
};

type AccessTokenRecord = {
  clientId: string;
  scope: string;
  issuedAt: number;
};

type RefreshTokenRecord = {
  clientId: string;
  scope: string;
  issuedAt: number;
};

const OAUTH_SCOPE_DEFAULT = "mcp";
const AUTH_CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function clientKey(clientId: string): string {
  return `oauth:client:${clientId}`;
}

function authCodeKey(code: string): string {
  return `oauth:code:${code}`;
}

function accessTokenKey(accessToken: string): string {
  return `oauth:token:${accessToken}`;
}

function refreshTokenKey(refreshToken: string): string {
  return `oauth:refresh:${refreshToken}`;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...(headers ?? {}),
    },
  });
}

function oauthErrorResponse(
  error: string,
  status = 400,
  description?: string,
): Response {
  return jsonResponse(status, {
    error,
    ...(description ? { error_description: description } : {}),
  });
}

function oauthRedirectError(
  redirectUri: string | null,
  state: string | null,
  error: string,
  description: string,
): Response {
  if (!redirectUri) {
    return oauthErrorResponse(error, 400, description);
  }
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("error_description", description);
  if (state) redirect.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.toString() },
  });
}

async function kvGetJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const value = await kv.get(key);
  if (!value) return null;
  return JSON.parse(value) as T;
}

function uint8ToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return uint8ToBase64Url(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(input),
  );
  return uint8ToBase64Url(new Uint8Array(digest));
}

function normalizeScope(scope: string | null | undefined): string {
  return scope && scope.trim().length > 0 ? scope.trim() : OAUTH_SCOPE_DEFAULT;
}

function scopeSet(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).filter(Boolean));
}

function isScopeSubset(requestedScope: string, allowedScope: string): boolean {
  const requested = scopeSet(requestedScope);
  const allowed = scopeSet(allowedScope);
  for (const s of requested) {
    if (!allowed.has(s)) return false;
  }
  return true;
}

function oauthMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [OAUTH_SCOPE_DEFAULT],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
    ],
  };
}

function oauthProtectedResourceMetadata(
  origin: string,
): Record<string, unknown> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [OAUTH_SCOPE_DEFAULT],
    bearer_methods_supported: ["header"],
  };
}

async function parseTokenRequestParams(
  request: Request,
): Promise<URLSearchParams> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string") params.set(k, v);
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

function parseBasicClientCredentials(
  authHeader: string | null,
): { clientId: string; clientSecret: string } | null {
  if (!authHeader || !/^Basic\s+/i.test(authHeader)) return null;
  const encoded = authHeader.replace(/^Basic\s+/i, "").trim();
  if (!encoded) return null;
  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    const clientId = decoded.slice(0, separator);
    const clientSecret = decoded.slice(separator + 1);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } catch {
    return null;
  }
}

async function validateBearerToken(
  env: Env,
  bearerToken: string,
): Promise<AccessTokenRecord | null> {
  return kvGetJson<AccessTokenRecord>(
    env.MCP_CLIENTS,
    accessTokenKey(bearerToken),
  );
}

function wantsJsonMcpResponse(request: Request): boolean {
  const accept = request.headers.get("Accept");
  return !accept || accept.toLowerCase().includes("application/json");
}

async function convertSseToJsonRpcResponse(
  response: Response,
): Promise<Response> {
  const contentType = (
    response.headers.get("Content-Type") ?? ""
  ).toLowerCase();
  if (!contentType.includes("text/event-stream")) return response;

  const sseBody = await response.text();
  const lines = sseBody.split(/\r?\n/);
  let event = "";
  let dataLines: string[] = [];
  let firstPayload: unknown = null;

  const flushEvent = () => {
    if (dataLines.length === 0 || firstPayload !== null) {
      event = "";
      dataLines = [];
      return;
    }
    if (event && event !== "message") {
      event = "";
      dataLines = [];
      return;
    }

    const raw = dataLines.join("\n");
    try {
      firstPayload = JSON.parse(raw);
    } catch {
      firstPayload = {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON" },
        id: null,
      };
    }
    event = "";
    dataLines = [];
  };

  for (const line of lines) {
    if (line === "") {
      flushEvent();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flushEvent();

  const payload = firstPayload ?? {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Empty MCP SSE response" },
    id: null,
  };

  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
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
        (c) =>
          `- ${c.id}  name=${c.name ?? "?"}  status=${c.status}  provider=${
            c.providerType ?? "?"
          }`,
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
        if (active.length === 0)
          throw new Error("No active computers available");
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
        (
          sessionBody.sessionSettings as Record<string, unknown>
        ).reasoningEffort = args.reasoningEffort;
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
        if (active.length === 0)
          throw new Error("No active computers available");
        computerId = active[0].id;
      }

      const model = args.model ?? "claude-sonnet-4-6";

      // Base session body
      const sessionSettings: Record<string, unknown> = { model };
      if (args.autonomy) sessionSettings.autonomyLevel = args.autonomy;

      const results: Array<{
        index: number;
        sessionId: string;
        prompt: string;
      }> = [];
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
        lines.push(
          ``,
          `Errors:`,
          ...errors.map((e) => `  ${e.index}: ${e.error}`),
        );
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
          .describe(
            "Max seconds to wait before giving up (30–3600, default 600)",
          ),
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
        if (active.length === 0)
          throw new Error("No active computers available");
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
        (
          sessionBody.sessionSettings as Record<string, unknown>
        ).reasoningEffort = args.reasoningEffort;
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
          ? computerNames.get(s.computerId) ?? "unknown"
          : "?";
        const computerLabel = s.computerId
          ? `${computerName} (${s.computerId})`
          : "?";
        return [
          `[${idx + 1}] id=${s.sessionId}  status=${
            s.status
          }  computer=${computerLabel}`,
          `    msgs=${s.messageCount}  created=${created}`,
          `    title: ${title}`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `${sessions.length} droid session(s):\n\n${blocks.join(
              "\n\n",
            )}`,
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
                : `${Math.floor(elapsed / 3600)}h ${Math.floor(
                    (elapsed % 3600) / 60,
                  )}m`;

          // Get last message preview
          let lastMsg = "(no messages)";
          try {
            const msgs = (await factoryFetch(
              `/sessions/${s.sessionId}/messages?limit=1`,
              apiKey,
            )) as { messages: Array<{ role: string; content: unknown }> };
            if (msgs.messages && msgs.messages.length > 0) {
              const m = msgs.messages[msgs.messages.length - 1];
              lastMsg = `[${m.role}] ${JSON.stringify(m.content).slice(
                0,
                120,
              )}`;
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
          `/sessions/${args.sessionId}/messages?limit=${
            args.messageLimit ?? 200
          }`,
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
        const blocks = Array.isArray(msg.content)
          ? (msg.content as MsgBlock[])
          : [];
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
            parts.push(
              `<thinking>${snippet}${
                snippet.length >= 300 ? "..." : ""
              }</thinking>`,
            );
          } else if (block.type === "text") {
            const text = ((block.text as string) ?? "").slice(0, 600);
            parts.push(text);
          } else if (block.type === "tool_use") {
            parts.push(
              `[tool_use: ${block.name}(${JSON.stringify(block.input).slice(
                0,
                200,
              )})]`,
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
        `  title:         ${((session.title as string) ?? "untitled").slice(
          0,
          120,
        )}`,
        `  computer:      ${session.computerId ?? "?"}`,
        `  model:         ${ss?.model ?? "?"}`,
        `  messageCount:  ${session.messageCount ?? msgs.length}`,
        `  createdAt:     ${new Date(
          (session.createdAt as number) ?? 0,
        ).toISOString()}`,
        `  updatedAt:     ${new Date(
          (session.updatedAt as number) ?? 0,
        ).toISOString()}`,
        ``,
      ];

      if (pendingTools.size > 0) {
        lines.push(
          `Active/pending tools (${pendingTools.size}) — currently in progress:`,
        );
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
        sessionId: z
          .string()
          .describe("The droid session ID to fetch messages for"),
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
        (
          m: { role: string; content: unknown; createdAt?: number },
          i: number,
        ) => {
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
        throw new Error(
          `Session ${args.sessionId} has no messages to resume from`,
        );
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
        if (active.length === 0)
          throw new Error("No active computers available");
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
          .describe(
            "Auto mode mapping: high=auto-high, medium=auto-medium, off=normal",
          ),
        mission: z
          .string()
          .optional()
          .describe(
            "Optional mission/session identifier forwarded as session_id",
          ),
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
      const output =
        result.output.trim().length > 0
          ? result.output
          : "(shim returned no streamed output)";
      const doneSuffix = result.done
        ? `\n\n[done] ${JSON.stringify(result.done)}`
        : "";

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
const PERPLEXITY_ORIGINS = [
  "https://www.perplexity.ai",
  "https://perplexity.ai",
];

function isPerplexityOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return PERPLEXITY_ORIGINS.some(
    (allowed) => origin === allowed || origin.endsWith(".perplexity.ai"),
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

function addCors(response: Response, origin: string | null): Response {
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
    const issuer = url.origin;

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

    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      return addCors(jsonResponse(200, oauthMetadata(issuer)), origin);
    }

    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return addCors(
        jsonResponse(200, oauthProtectedResourceMetadata(issuer)),
        origin,
      );
    }

    if (url.pathname === "/register") {
      if (request.method !== "POST") {
        return addCors(
          new Response("Method Not Allowed", { status: 405 }),
          origin,
        );
      }

      let bodyUnknown: unknown;
      try {
        bodyUnknown = await request.json();
      } catch {
        return addCors(
          oauthErrorResponse(
            "invalid_client_metadata",
            400,
            "Registration request body must be JSON",
          ),
          origin,
        );
      }

      if (
        !bodyUnknown ||
        typeof bodyUnknown !== "object" ||
        Array.isArray(bodyUnknown)
      ) {
        return addCors(
          oauthErrorResponse(
            "invalid_client_metadata",
            400,
            "Invalid JSON body",
          ),
          origin,
        );
      }
      const body = bodyUnknown as Record<string, unknown>;

      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((v): v is string => typeof v === "string")
        : [];
      if (redirectUris.length === 0) {
        return addCors(
          oauthErrorResponse(
            "invalid_client_metadata",
            400,
            "redirect_uris must contain at least one URI",
          ),
          origin,
        );
      }

      const tokenEndpointAuthMethod = (
        typeof body.token_endpoint_auth_method === "string"
          ? body.token_endpoint_auth_method
          : "client_secret_post"
      ) as TokenEndpointAuthMethod;
      if (
        tokenEndpointAuthMethod !== "client_secret_post" &&
        tokenEndpointAuthMethod !== "client_secret_basic"
      ) {
        return addCors(
          oauthErrorResponse(
            "invalid_client_metadata",
            400,
            "token_endpoint_auth_method must be client_secret_post or client_secret_basic",
          ),
          origin,
        );
      }

      const grantTypes = Array.isArray(body.grant_types)
        ? body.grant_types.filter((v): v is string => typeof v === "string")
        : ["authorization_code", "refresh_token"];
      if (!grantTypes.includes("authorization_code")) {
        return addCors(
          oauthErrorResponse(
            "invalid_client_metadata",
            400,
            "authorization_code grant_type is required",
          ),
          origin,
        );
      }

      const responseTypes = Array.isArray(body.response_types)
        ? body.response_types.filter((v): v is string => typeof v === "string")
        : ["code"];
      if (!responseTypes.includes("code")) {
        return addCors(
          oauthErrorResponse(
            "invalid_client_metadata",
            400,
            "response_types must include code",
          ),
          origin,
        );
      }

      const requestedScope = normalizeScope(
        typeof body.scope === "string" ? body.scope : OAUTH_SCOPE_DEFAULT,
      );
      if (!isScopeSubset(requestedScope, OAUTH_SCOPE_DEFAULT)) {
        return addCors(
          oauthErrorResponse(
            "invalid_client_metadata",
            400,
            `scope must be within "${OAUTH_SCOPE_DEFAULT}"`,
          ),
          origin,
        );
      }

      const clientId = crypto.randomUUID();
      const clientSecret = randomOpaqueToken(32);
      const now = Math.floor(Date.now() / 1000);

      const client: RegisteredClient = {
        clientId,
        clientSecret,
        clientName:
          typeof body.client_name === "string" ? body.client_name : undefined,
        redirectUris,
        tokenEndpointAuthMethod,
        grantTypes,
        responseTypes,
        scope: requestedScope,
        clientIdIssuedAt: now,
        clientSecretExpiresAt: 0,
      };

      await env.MCP_CLIENTS.put(clientKey(clientId), JSON.stringify(client));

      return addCors(
        jsonResponse(201, {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          client_id_issued_at: client.clientIdIssuedAt,
          client_secret_expires_at: client.clientSecretExpiresAt,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          grant_types: client.grantTypes,
          response_types: client.responseTypes,
          scope: client.scope,
        }),
        origin,
      );
    }

    if (url.pathname === "/authorize") {
      if (request.method !== "GET") {
        return addCors(
          new Response("Method Not Allowed", { status: 405 }),
          origin,
        );
      }

      const responseType = url.searchParams.get("response_type");
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");
      const codeChallengeMethod = url.searchParams.get("code_challenge_method");

      if (!clientId) {
        return addCors(
          oauthErrorResponse("invalid_request", 400, "client_id is required"),
          origin,
        );
      }
      const client = await kvGetJson<RegisteredClient>(
        env.MCP_CLIENTS,
        clientKey(clientId),
      );
      if (!client) {
        return addCors(
          oauthErrorResponse("unauthorized_client", 400, "Unknown client_id"),
          origin,
        );
      }

      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        return addCors(
          oauthErrorResponse(
            "invalid_request",
            400,
            "redirect_uri is missing or not registered for this client",
          ),
          origin,
        );
      }

      if (responseType !== "code") {
        return addCors(
          oauthRedirectError(
            redirectUri,
            state,
            "unsupported_response_type",
            "Only response_type=code is supported",
          ),
          origin,
        );
      }

      if (!codeChallenge || !codeChallengeMethod) {
        return addCors(
          oauthRedirectError(
            redirectUri,
            state,
            "invalid_request",
            "code_challenge and code_challenge_method are required",
          ),
          origin,
        );
      }

      if (codeChallengeMethod !== "S256") {
        return addCors(
          oauthRedirectError(
            redirectUri,
            state,
            "invalid_request",
            "Only S256 code_challenge_method is supported",
          ),
          origin,
        );
      }

      const requestedScope = normalizeScope(
        url.searchParams.get("scope") ?? client.scope,
      );
      if (!isScopeSubset(requestedScope, client.scope)) {
        return addCors(
          oauthRedirectError(
            redirectUri,
            state,
            "invalid_scope",
            "Requested scope is not allowed for this client",
          ),
          origin,
        );
      }

      const authorizationCode = randomOpaqueToken(24);
      const codeRecord: AuthorizationCodeRecord = {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: "S256",
        scope: requestedScope,
        issuedAt: Math.floor(Date.now() / 1000),
      };
      await env.MCP_CLIENTS.put(
        authCodeKey(authorizationCode),
        JSON.stringify(codeRecord),
        { expirationTtl: AUTH_CODE_TTL_SECONDS },
      );

      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", authorizationCode);
      if (state) redirect.searchParams.set("state", state);
      return addCors(
        new Response(null, {
          status: 302,
          headers: { Location: redirect.toString() },
        }),
        origin,
      );
    }

    if (url.pathname === "/token") {
      if (request.method !== "POST") {
        return addCors(
          new Response("Method Not Allowed", { status: 405 }),
          origin,
        );
      }

      let params: URLSearchParams;
      try {
        params = await parseTokenRequestParams(request);
      } catch {
        return addCors(
          oauthErrorResponse(
            "invalid_request",
            400,
            "Unable to parse token request body",
          ),
          origin,
        );
      }

      const grantType = params.get("grant_type");
      const bodyClientId = params.get("client_id");
      const bodyClientSecret = params.get("client_secret");
      const basicCredentials = parseBasicClientCredentials(
        request.headers.get("Authorization"),
      );
      if (request.headers.has("Authorization") && !basicCredentials) {
        return addCors(
          oauthErrorResponse(
            "invalid_client",
            401,
            "Malformed Authorization header for client_secret_basic",
          ),
          origin,
        );
      }

      const clientId = basicCredentials?.clientId ?? bodyClientId;
      const presentedClientSecret =
        basicCredentials?.clientSecret ?? bodyClientSecret;
      if (!grantType) {
        return addCors(
          oauthErrorResponse("invalid_request", 400, "grant_type is required"),
          origin,
        );
      }
      if (!clientId) {
        return addCors(
          oauthErrorResponse("invalid_client", 401, "client_id is required"),
          origin,
        );
      }
      if (
        basicCredentials &&
        bodyClientId &&
        bodyClientId !== basicCredentials.clientId
      ) {
        return addCors(
          oauthErrorResponse(
            "invalid_client",
            401,
            "client_id mismatch between body and basic auth",
          ),
          origin,
        );
      }

      const client = await kvGetJson<RegisteredClient>(
        env.MCP_CLIENTS,
        clientKey(clientId),
      );
      if (!client) {
        return addCors(
          oauthErrorResponse("invalid_client", 401, "Unknown client_id"),
          origin,
        );
      }

      if (!presentedClientSecret) {
        return addCors(
          oauthErrorResponse(
            "invalid_client",
            401,
            "client_secret is required",
          ),
          origin,
        );
      }

      if (
        !client.clientSecret ||
        presentedClientSecret !== client.clientSecret
      ) {
        return addCors(
          oauthErrorResponse("invalid_client", 401, "Invalid client_secret"),
          origin,
        );
      }

      if (grantType === "authorization_code") {
        const code = params.get("code");
        const redirectUri = params.get("redirect_uri");
        const codeVerifier = params.get("code_verifier");
        if (!code || !redirectUri || !codeVerifier) {
          return addCors(
            oauthErrorResponse(
              "invalid_request",
              400,
              "code, redirect_uri, and code_verifier are required",
            ),
            origin,
          );
        }

        const codeRecord = await kvGetJson<AuthorizationCodeRecord>(
          env.MCP_CLIENTS,
          authCodeKey(code),
        );
        if (!codeRecord) {
          return addCors(
            oauthErrorResponse(
              "invalid_grant",
              400,
              "Invalid or expired authorization code",
            ),
            origin,
          );
        }

        if (
          codeRecord.clientId !== clientId ||
          codeRecord.redirectUri !== redirectUri
        ) {
          return addCors(
            oauthErrorResponse(
              "invalid_grant",
              400,
              "Authorization code does not match client",
            ),
            origin,
          );
        }

        const expectedChallenge = await sha256Base64Url(codeVerifier);
        if (expectedChallenge !== codeRecord.codeChallenge) {
          return addCors(
            oauthErrorResponse(
              "invalid_grant",
              400,
              "Invalid PKCE code_verifier",
            ),
            origin,
          );
        }

        await env.MCP_CLIENTS.delete(authCodeKey(code));

        const now = Math.floor(Date.now() / 1000);
        const accessToken = randomOpaqueToken(32);
        const refreshToken = randomOpaqueToken(32);
        const accessRecord: AccessTokenRecord = {
          clientId,
          scope: codeRecord.scope,
          issuedAt: now,
        };
        const refreshRecord: RefreshTokenRecord = {
          clientId,
          scope: codeRecord.scope,
          issuedAt: now,
        };

        await env.MCP_CLIENTS.put(
          accessTokenKey(accessToken),
          JSON.stringify(accessRecord),
          { expirationTtl: ACCESS_TOKEN_TTL_SECONDS },
        );
        await env.MCP_CLIENTS.put(
          refreshTokenKey(refreshToken),
          JSON.stringify(refreshRecord),
          { expirationTtl: REFRESH_TOKEN_TTL_SECONDS },
        );

        return addCors(
          jsonResponse(200, {
            token_type: "Bearer",
            access_token: accessToken,
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: refreshToken,
            scope: codeRecord.scope,
          }),
          origin,
        );
      }

      if (grantType === "refresh_token") {
        const refreshToken = params.get("refresh_token");
        if (!refreshToken) {
          return addCors(
            oauthErrorResponse(
              "invalid_request",
              400,
              "refresh_token is required",
            ),
            origin,
          );
        }

        const refreshRecord = await kvGetJson<RefreshTokenRecord>(
          env.MCP_CLIENTS,
          refreshTokenKey(refreshToken),
        );
        if (!refreshRecord || refreshRecord.clientId !== clientId) {
          return addCors(
            oauthErrorResponse("invalid_grant", 400, "Invalid refresh_token"),
            origin,
          );
        }

        const requestedScope = params.get("scope");
        const scope = normalizeScope(requestedScope ?? refreshRecord.scope);
        if (!isScopeSubset(scope, refreshRecord.scope)) {
          return addCors(
            oauthErrorResponse(
              "invalid_scope",
              400,
              "Requested scope exceeds original refresh token scope",
            ),
            origin,
          );
        }

        const now = Math.floor(Date.now() / 1000);
        const nextAccessToken = randomOpaqueToken(32);
        const nextRefreshToken = randomOpaqueToken(32);
        const nextAccessRecord: AccessTokenRecord = {
          clientId,
          scope,
          issuedAt: now,
        };
        const nextRefreshRecord: RefreshTokenRecord = {
          clientId,
          scope,
          issuedAt: now,
        };

        await env.MCP_CLIENTS.put(
          accessTokenKey(nextAccessToken),
          JSON.stringify(nextAccessRecord),
          { expirationTtl: ACCESS_TOKEN_TTL_SECONDS },
        );
        await env.MCP_CLIENTS.put(
          refreshTokenKey(nextRefreshToken),
          JSON.stringify(nextRefreshRecord),
          { expirationTtl: REFRESH_TOKEN_TTL_SECONDS },
        );
        await env.MCP_CLIENTS.delete(refreshTokenKey(refreshToken));

        return addCors(
          jsonResponse(200, {
            token_type: "Bearer",
            access_token: nextAccessToken,
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: nextRefreshToken,
            scope,
          }),
          origin,
        );
      }

      return addCors(
        oauthErrorResponse(
          "unsupported_grant_type",
          400,
          `Unsupported grant_type: ${grantType}`,
        ),
        origin,
      );
    }

    // Only /mcp endpoint
    if (url.pathname !== "/mcp") {
      return addCors(new Response("Not Found", { status: 404 }), origin);
    }

    // Auth check — OAuth bearer access_token (stored in KV)
    const authHeader = request.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      return addCors(
        jsonResponse(
          401,
          { error: "invalid_token", error_description: "Missing bearer token" },
          { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        ),
        origin,
      );
    }

    const tokenRecord = await validateBearerToken(env, token);
    if (!tokenRecord) {
      return addCors(
        jsonResponse(
          401,
          {
            error: "invalid_token",
            error_description: "Unknown or expired access token",
          },
          { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        ),
        origin,
      );
    }

    if (!scopeSet(tokenRecord.scope).has(OAUTH_SCOPE_DEFAULT)) {
      return addCors(
        jsonResponse(403, {
          error: "insufficient_scope",
          error_description: `Token must include "${OAUTH_SCOPE_DEFAULT}" scope`,
        }),
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
      const jsonOnlyMode = wantsJsonMcpResponse(request);

      // Compatibility: some MCP clients (including Perplexity) send Accept: application/json only.
      // We still route through Streamable HTTP transport, then convert SSE payload to JSON when needed.
      const forwardedHeaders = new Headers(request.headers);
      forwardedHeaders.set("Accept", "application/json, text/event-stream");
      const forwardedRequest = new Request(request, {
        headers: forwardedHeaders,
      });

      await server.connect(transport);
      const mcpResponse = await transport.handleRequest(forwardedRequest);
      if (jsonOnlyMode) {
        const jsonMcpResponse = await convertSseToJsonRpcResponse(mcpResponse);
        return addCors(jsonMcpResponse, origin);
      }
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
