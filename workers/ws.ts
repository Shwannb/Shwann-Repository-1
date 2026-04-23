// WebSocket push server for live deal updates.
//
// Architecture: Postgres LISTEN/NOTIFY is the fan-in — every INSERT on deals
// fires a NOTIFY (see 0005_deal_notify.sql). This process holds a persistent
// LISTEN connection and relays every payload to all connected WebSocket
// clients. No Redis / message broker required for single-instance Phase 1.
//
// Clients connect to ws://host:PORT/ws/deals and get a stream of JSON frames
// with the shape { type: 'new_deal', deal: {...} }.
//
// This process is deliberately separate from the Next.js app — Next.js app
// router does not expose a WebSocket upgrade hook. Run both together in
// production (docker-compose handles this).

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { Client } from 'pg';

const PORT = Number(process.env.WS_PORT ?? 3030);
const CHANNEL = 'deals_new';

interface DealPayload {
  id: string;
  headline: string;
  sector: string | null;
  geography: string | null;
  deal_type: string | null;
  deal_size_usd: number | null;
  announced_at: string;
}

export function parsePayload(raw: string): DealPayload | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.id !== 'string' || typeof obj.headline !== 'string') return null;
    return obj as unknown as DealPayload;
  } catch {
    return null;
  }
}

export async function createListener(connectionString: string): Promise<Client> {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  await client.query(`LISTEN ${CHANNEL}`);
  return client;
}

// Broadcast helper — kept exported for test visibility.
export function broadcast(clients: Set<WebSocket>, frame: unknown): number {
  const json = JSON.stringify(frame);
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
      sent++;
    }
  }
  return sent;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const httpServer = createServer((_req, res) => {
    // Lightweight readiness endpoint for docker-compose health checks.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('safyr ws\n');
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws/deals' });
  const clients = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', connected: clients.size }));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  const pg = await createListener(connectionString);
  pg.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    const deal = parsePayload(msg.payload);
    if (!deal) return;
    const sent = broadcast(clients, { type: 'new_deal', deal });
    console.log(`[ws] relay id=${deal.id} clients=${sent}`);
  });
  pg.on('error', (err) => console.error('[ws] pg error:', err));

  httpServer.listen(PORT, () => {
    console.log(`[ws] listening on :${PORT} (ws path /ws/deals, pg channel ${CHANNEL})`);
  });

  const shutdown = async () => {
    console.log('[ws] shutting down');
    wss.close();
    httpServer.close();
    await pg.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirectRun =
  typeof require !== 'undefined' && require.main === module ||
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
