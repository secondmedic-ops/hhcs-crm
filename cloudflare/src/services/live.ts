// Live screens: open browsers keep one WebSocket to the LiveHub Durable Object (SQLite class, Workers Free plan,
// hibernation API so idle sockets cost nothing). After any request or webhook that changed data, the Worker posts the
// changed table names here and the hub pushes {"tables": [...]} to every open screen, which reloads what it shows.
// Only table names travel, never row data: each screen re-reads through the API with its own login and RLS.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

export class LiveHub extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/notify' && req.method === 'POST') {
      const msg = await req.text();
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(msg); } catch { /* closed socket */ }
      }
      return new Response('ok');
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'caredesk' } });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong');
  }
  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, 'bye'); } catch { /* already closed */ }
  }
}

const hub = (env: Env) => env.LIVE.get(env.LIVE.idFromName('hub'));

export function notifyLive(env: Env, exec: ExecutionContext, tables: string[]) {
  if (!tables.length || !env.LIVE) return;
  exec.waitUntil(hub(env).fetch('https://live/notify', { method: 'POST', body: JSON.stringify({ tables }) }).then(() => {}).catch(() => {}));
}

/** The browser's WebSocket, after the Worker checked its login (token in the Sec-WebSocket-Protocol header). */
export const openLive = (env: Env, req: Request) => hub(env).fetch(req);

/** Token sent as the second WebSocket sub-protocol: new WebSocket(url, ['caredesk', token]). */
export function liveToken(req: Request): string | null {
  const parts = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
  return parts[0] === 'caredesk' && parts[1] ? parts[1] : null;
}
