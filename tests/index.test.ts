import { describe, it, expect } from "vitest";
import worker from "../src/index";

// Minimal mock KV for tests that don't hit KV
function mockKV(): KVNamespace {
  return {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    getWithMetadata: () => Promise.resolve({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

const baseEnv = {
  FACTORY_API_KEY: "test-key",
  FACTORY_SHIM_URL: "https://shim.example.com",
  FACTORY_SHIM_SECRET: "test-secret",
  MCP_CLIENTS: mockKV(),
};

describe("factory-perplexity-mcp worker", () => {
  it("exports an object with a fetch function", () => {
    expect(worker).toBeDefined();
    expect(typeof worker.fetch).toBe("function");
  });

  it("responds to GET / with status ok", async () => {
    const req = new Request("https://example.com/");
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("factory-perplexity-mcp");
  });

  it("responds to GET /health with status ok", async () => {
    const req = new Request("https://example.com/health");
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
  });

  it("returns OAuth authorization server metadata on GET /.well-known/oauth-authorization-server", async () => {
    const req = new Request(
      "https://example.com/.well-known/oauth-authorization-server"
    );
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.issuer).toBe("https://example.com");
    expect(body.authorization_endpoint).toBe(
      "https://example.com/authorize"
    );
    expect(body.token_endpoint).toBe("https://example.com/token");
    expect(body.response_types_supported).toEqual(["code"]);
    expect(Array.isArray(body.grant_types_supported)).toBe(true);
  });

  it("returns OAuth protected resource metadata on GET /.well-known/oauth-protected-resource", async () => {
    const req = new Request(
      "https://example.com/.well-known/oauth-protected-resource"
    );
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.resource).toBe("https://example.com/mcp");
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect(body.authorization_servers).toContain("https://example.com");
  });

  it("handles OPTIONS preflight requests with CORS headers", async () => {
    const req = new Request("https://example.com/", { method: "OPTIONS" });
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Methods")).toBeTruthy();
    expect(resp.headers.get("Access-Control-Allow-Headers")).toBeTruthy();
  });

  it("rejects POST /token without client credentials with proper OAuth error", async () => {
    const req = new Request("https://example.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code" }),
    });
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  it("returns 405 for methods not allowed on GET-only endpoints", async () => {
    const req = new Request("https://example.com/authorize", {
      method: "POST",
    });
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(405);
  });

  it("rejects registration without redirect_uris with proper error", async () => {
    const req = new Request("https://example.com/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resp = await worker.fetch(req, baseEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("invalid_client_metadata");
  });
});
