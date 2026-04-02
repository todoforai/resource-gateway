/**
 * resource-gateway
 *
 * Auth gateway + metering for browser, terminal, VM resources.
 *
 * HTTP API (tRPC):
 *   /trpc/browser.create     Create session
 *   /trpc/browser.list       List my sessions
 *   /trpc/browser.get        Get session details
 *   /trpc/browser.delete     Close session
 *   /trpc/browser.deleteAll  Close all my sessions
 *
 * WebSocket:
 *   /browser/:sessionId?api_key=xxx   CDP relay with billing ($0.005/min)
 *
 * Auth: x-api-key header or ?api_key= query param
 * Both validate against shared Redis (apikey:* or resource:token:*)
 *
 * ENV:
 *   PORT            (default: 6000)
 *   DRAGONFLY_URL   (required) redis://...
 *   BROWSER_HTTP    (default: http://localhost:8086)
 *   BROWSER_WS      (default: ws://localhost:8085)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { ResourceProxy } from './proxy.ts';
import { appRouter, createContext } from './trpc.ts';

const PORT = parseInt(process.env.PORT ?? '6000');

const BROWSER_WS = process.env.BROWSER_WS ??
  (process.env.NODE_ENV === 'production' ? 'ws://browser:8085' : 'ws://localhost:8085');

// ── HTTP Helpers ──────────────────────────────────────────────────────────────

function jsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
  };
}

// Convert Node.js IncomingMessage to Web Request for tRPC fetch adapter
function toWebRequest(req: IncomingMessage): Promise<Request> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host || 'localhost';
      const url = `${protocol}://${host}${req.url}`;
      resolve(new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : body,
      }));
    });
  });
}

// ── HTTP Handler ──────────────────────────────────────────────────────────────

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, jsonHeaders());
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // ── tRPC API ────────────────────────────────────────────────────────────────

  if (url.pathname.startsWith('/trpc')) {
    const webReq = await toWebRequest(req);
    const webRes = await fetchRequestHandler({
      endpoint: '/trpc',
      req: webReq,
      router: appRouter,
      createContext: () => createContext({ req, res }),
    });

    // Copy response back to Node.js ServerResponse
    res.writeHead(webRes.status, {
      ...Object.fromEntries(webRes.headers.entries()),
      'Access-Control-Allow-Origin': '*',
    });
    const body = await webRes.text();
    res.end(body);
    return;
  }

  // 404
  res.writeHead(404, jsonHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── WebSocket Proxy ───────────────────────────────────────────────────────────

const browserProxy = new ResourceProxy({
  name: 'browser',
  upstreamUrl: (id) => `${BROWSER_WS}/cdp/${id}`,
  costPerMinute: 0.005,
});


const server = createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';

  // /browser/:sessionId (not /browser/sessions)
  const browserMatch = url.match(/^\/browser\/([^/?]+)/);
  if (browserMatch && browserMatch[1] !== 'sessions') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      browserProxy.handle(ws, req, browserMatch[1]).catch((e) => {
        console.error(`[browser] error:`, e);
        if (ws.readyState === WebSocket.OPEN) ws.close(4500, 'Internal error');
      });
    });
    return;
  }

  socket.destroy();
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🔌 resource-gateway on :${PORT}`);
  console.log(`   tRPC:      /trpc/browser.*`);
  console.log(`   WebSocket: /browser/:sessionId`);
  console.log(`   Browser:   ${BROWSER_WS}`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
