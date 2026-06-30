# AGENTS.md for factory-perplexity-mcp

## Overview
A FastMCP server that wraps the Factory.ai Droid Swarm API, deployed as a Cloudflare Worker. Supports OAuth 2.1 with Dynamic Client Registration (RFC 7591) for Perplexity custom MCP connectors.

## Development

### Setup
```bash
npm install
```

### Run
```bash
npx wrangler dev
```

### Test
```bash
npm test
```

### Type Check
```bash
npx tsc --noEmit
```

### Deploy
```bash
npx wrangler deploy
```

## Deployment
Deployed as a Cloudflare Worker. Environment secrets set via `wrangler secret put`.
