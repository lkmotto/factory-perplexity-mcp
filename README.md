# Factory Droid Swarm MCP Server

A [FastMCP](https://github.com/modelcontextprotocol) server that wraps the [Factory.ai](https://www.factory.ai) Droid Swarm API, deployed as a Cloudflare Worker. Designed for use as a Composio MCP tool (`factory_droid_swarm`) integrated with Perplexity.

## Setup

1. **Environment secrets** (set via `wrangler secret put`):

   - `FACTORY_API_KEY` — Your Factory.ai API key (stored in Doppler)
   - `FACTORY_SHIM_URL` — Base URL for the Legion shim (e.g. `https://<...>.trycloudflare.com`)
   - `FACTORY_SHIM_SECRET` — Shared HMAC secret used to sign shim requests
   - `MCP_CLIENTS` — KV namespace binding for registered OAuth clients, auth codes, and tokens

2. **Deploy** (Cloudflare Workers):

   ```bash
   npx wrangler deploy
   ```

3. **Endpoint**: `https://<your-worker>.workers.dev/mcp`

## OAuth 2.1 + Dynamic Client Registration (RFC 7591)

This worker now exposes a minimal authorization server for Perplexity custom MCP connectors:

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- `POST /register`
- `GET /authorize` (single-user auto-approve mode)
- `POST /token`

Flow:

1. Connector reads OAuth metadata from `/.well-known/oauth-authorization-server`.
2. Connector dynamically registers with `POST /register` and receives `client_id` + `client_secret` (confidential client default: `token_endpoint_auth_method=client_secret_post`).
3. Connector sends user to `GET /authorize` with PKCE (`code_challenge_method=S256`).
4. Worker auto-approves (single-user mode) and redirects with `code`.
5. Connector exchanges code at `POST /token` for `access_token` + `refresh_token` using either `client_secret_post` (form body) or `client_secret_basic` (HTTP Basic auth).
6. `POST /mcp` requires `Authorization: Bearer <access_token>` and validates token from KV.

The shim HMAC flow (`factory_exec` -> `FACTORY_SHIM_URL`) is unchanged.

## Tools

### 1. `list_computers`

List all connected Factory Droid computers (execution hosts).

- Returns: computer IDs, names, provider types, and status.
- No parameters.

### 2. `spawn_droid`

Launch a new Factory Droid session.

- `prompt` (string, required) — Task prompt for the droid.
- `computerId` (string, optional) — Target computer (defaults to first active).
- `model` (string, optional) — Model to use (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`, `gpt-5`).
- `autonomy` (enum, optional) — `off`, `low`, `medium`, `high`.
- `reasoningEffort` (enum, optional) — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

### 3. `spawn_swarm`

Launch multiple droids in parallel (fan-out).

- `prompts` (string[], required) — List of 1–50 prompt strings.
- `computerId` (string, optional).
- `model` (string, optional).
- `autonomy` (enum, optional).

### 4. `spawn_and_watch` (NEW)

Spawn a droid, poll until it completes (goes idle), then return the full message log. Single-call alternative to spawn + poll + fetch messages.

- `prompt` (string, required) — Task prompt for the droid.
- `model` (string, optional).
- `autonomy` (enum, optional).
- `reasoningEffort` (enum, optional).
- `computerId` (string, optional).
- `pollIntervalSeconds` (number, optional, default 15) — Seconds between status polls (5–60).
- `timeoutSeconds` (number, optional, default 600) — Max seconds to wait (30–3600).

### 5. `list_droids`

List recent droid sessions with **full session UUIDs**.

- `status` (enum, optional) — Filter by `idle`, `pending`, or `running`.
- `limit` (number, optional, default 20, max 100) — Max sessions to return.

### 6. `get_all_active_droids` (NEW)

Get all currently active (pending/running) droid sessions.

- Full session IDs, current status, message count, last message preview, and elapsed time.
- No parameters.

### 7. `get_droid`

Get detailed status and recent messages for a specific droid session.

- `sessionId` (string, required) — Droid session ID to fetch.

### 8. `get_droid_messages_full` (NEW)

Get ALL messages from a droid session (not just recent ones), with role labels (user/assistant) and timestamps.

- `sessionId` (string, required) — Droid session ID.
- `maxMessages` (number, optional, default 200, max 500) — Max messages to return.

### 9. `message_droid`

Send a message to a running droid session.

- `sessionId` (string, required) — Target droid session ID.
- `text` (string, required) — Message text to send.

### 10. `respawn_with_context` (NEW)

Continue a dead (idle) session by fetching its full message log and spawning a NEW droid with that context plus a follow-up prompt.

- `sessionId` (string, required) — Completed session ID to resume from.
- `followupPrompt` (string, required) — Follow-up task for the new droid.
- `model` (string, optional).
- `autonomy` (enum, optional).
- `computerId` (string, optional).

### 11. `interrupt_droid`

Interrupt a running droid session. Idempotent — safe to call on already-idle droids.

- `sessionId` (string, required) — Droid session ID to interrupt.

### 12. `factory_exec` (NEW)

Execute a prompt through the Legion shim endpoint (`POST /factory/exec`) with HMAC-SHA256 request signing and streamed SSE output aggregation.

- `prompt` (string, required) — Prompt to execute.
- `cwd` (string, optional) — Working directory hint forwarded to shim.
- `auto` (enum, optional) — `high`, `medium`, `off` (mapped to shim modes `auto-high`, `auto-medium`, `normal`).
- `mission` (string, optional) — Forwarded as `mission` and `session_id` for mission/session continuity.

### 13. `factory_healthz` (NEW)

Call Legion shim health endpoint (`GET /healthz`).

- No parameters.
- Returns raw shim health JSON/text.

## Factory API

Base URL: `https://api.factory.ai/api/v0`

| Endpoint                  | Method | Description                         |
| ------------------------- | ------ | ----------------------------------- |
| `/computers`              | GET    | List computers                      |
| `/sessions`               | GET    | List sessions (supports `?limit=N`) |
| `/sessions`               | POST   | Create a new session                |
| `/sessions/:id`           | GET    | Get session details                 |
| `/sessions/:id/messages`  | GET    | Get messages (supports `?limit=N`)  |
| `/sessions/:id/messages`  | POST   | Send a message to a session         |
| `/sessions/:id/interrupt` | POST   | Interrupt a running session         |

## License

ISC
