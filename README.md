# resource-gateway

Minimal auth gateway + metering proxy for browser, sandbox, and terminal resources.

**No framework. No shared backend code.**

## What it does

1. **tRPC API** — Create/manage browser sessions and sandbox VMs
2. **WebSocket proxy** — Relay with auth + per-minute billing
3. **Edge token generation** — Sandbox VMs get a temporary API key so bridge inside can connect back to the backend

## Supported Resources

| Path | Upstream | Cost/min |
|------|----------|----------|
| `/browser/:sessionId` | `ws://browser:8085/cdp/:id` | $0.005 |
| `/sandbox/:sandboxId` | `ws://sandbox-manager:9000/sandbox/:id/tty` | $0.01 |

## tRPC Endpoints

| Endpoint | Description |
|----------|-------------|
| `browser.create` | Create browser session |
| `browser.list` | List user's browser sessions |
| `browser.get` | Get browser session details |
| `browser.delete` | Close browser session |
| `browser.deleteAll` | Close all browser sessions |
| `sandbox.create` | Create sandbox VM (generates edge token) |
| `sandbox.get` | Get sandbox details |
| `sandbox.delete` | Delete sandbox VM |
| `sandbox.exec` | Execute command in sandbox |
| `sandbox.pause` | Pause sandbox VM |
| `sandbox.resume` | Resume sandbox VM |

## Files

```
server.ts   — HTTP server + URL routing + WebSocket upgrade
proxy.ts    — ResourceProxy class (auth + relay + meter)
redis.ts    — Redis ops: key lookup, balance deduct, edge token CRUD
trpc.ts     — tRPC router for browser + sandbox lifecycle
nginx.conf  — Subdomain → proxy routing
```

## Run

```bash
DRAGONFLY_URL=redis://:password@localhost:41337 bun server.ts

# With sandbox manager
DRAGONFLY_URL=redis://... SANDBOX_MANAGER_URL=http://localhost:9000 bun server.ts
```

## Client usage

```typescript
// Browser (Playwright)
const browser = await chromium.connectOverCDP(
  'wss://browser.todofor.ai/abc-session-id',
  { headers: { Authorization: 'Bearer todo_xxx' } }
);

// Sandbox — create via tRPC, connect via WebSocket
const sandbox = await trpc.sandbox.create.mutate({ template: 'alpine-edge', size: 'medium' });
const ws = new WebSocket(sandbox.wsUrl + '?api_key=todo_xxx');
ws.onmessage = (e) => console.log(e.data);  // PTY output
ws.send('ls -la\n');  // PTY input
```

## Edge Token Flow (Sandbox → Backend)

```
1. Client calls sandbox.create via tRPC
2. resource-gateway creates temporary API key in Redis (apikey:<token>, 2h TTL)
3. Passes edge_token to sandbox-manager → Firecracker kernel cmdline
4. bridge inside VM reads /proc/cmdline, extracts edge.token=xxx
5. bridge connects to wss://api.todofor.ai/ws/v2/edge-shell with Bearer token
6. Backend validates via ApiKeyService → Redis apikey:<token> → userId
7. Edge is registered, PTY sessions can be created
```

## Architecture

```
vm.todofor.ai/:sandboxId
        │
        │  nginx rewrite → /sandbox/:sandboxId
        ▼
  resource-gateway :6000
        │
        │  1. HGETALL apikey:{token}     → userId
        │  2. HGET appuser:{userId} balance > 0?
        │  3. ws://sandbox-manager:9000/sandbox/:id/tty
        │  4. relay PTY I/O (binary-safe)
        │  5. every 60s: EVAL deduct $0.01
        ▼
  sandbox-manager :9000
        │
        ▼
  Firecracker VM (bridge → backend)
```
