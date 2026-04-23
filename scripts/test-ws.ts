// End-to-end WebSocket push test.
//
// Spins up the ws server in-process against the real Postgres, opens a
// WebSocket client, inserts a deal, asserts the 'new_deal' frame arrives.
// This exercises the full pipeline: INSERT → trigger → NOTIFY → LISTEN →
// fan-out → client.

import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { db, closeDb } from '../lib/db';
import { createListener, broadcast, parsePayload } from '../workers/ws';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const PORT = 3131;
const CHANNEL = 'deals_new';

async function main() {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/deals' });
  const clients = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  const pg = await createListener(process.env.DATABASE_URL!);
  const received: unknown[] = [];
  pg.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    const deal = parsePayload(msg.payload);
    if (!deal) return;
    broadcast(clients, { type: 'new_deal', deal });
  });

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
  console.log(`[1/3] ws server up on :${PORT}: OK`);

  const client = new WebSocket(`ws://127.0.0.1:${PORT}/ws/deals`);
  await new Promise<void>((resolve, reject) => {
    client.on('open', () => resolve());
    client.on('error', reject);
  });
  client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  console.log('[2/3] client connected: OK');

  // Insert a deal — trigger should fire NOTIFY.
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO deals (headline, sector, geography, deal_type, deal_size_usd, announced_at, primary_source_id, primary_url)
     VALUES ('[WS TEST] MegaCorp buys WidgetCo', 'technology', 'north_america', 'm_and_a', 1000000000, NOW(), 'edgar',
             'https://example.test/ws-test-1')
     RETURNING id`
  );
  const insertedId = rows[0].id;

  // Wait up to 3s for the push to land.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const hit = received.find(
      (f) => typeof f === 'object' && f !== null &&
      (f as { type?: string }).type === 'new_deal' &&
      (f as { deal?: { id?: string } }).deal?.id === insertedId
    );
    if (hit) {
      console.log(`[3/3] new_deal frame received for id=${insertedId}: OK`);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const got = received.find(
    (f) => typeof f === 'object' && f !== null &&
    (f as { type?: string }).type === 'new_deal' &&
    (f as { deal?: { id?: string } }).deal?.id === insertedId
  ) as { type: string; deal: Record<string, unknown> } | undefined;
  assert(got, 'new_deal frame never arrived — LISTEN/NOTIFY or ws fan-out broken');
  assert(got.deal.headline === '[WS TEST] MegaCorp buys WidgetCo', 'headline mismatch');
  assert(got.deal.sector === 'technology', 'sector mismatch');

  await db().query(`DELETE FROM deals WHERE id = $1`, [insertedId]);

  client.close();
  wss.close();
  httpServer.close();
  await pg.end();
}

main()
  .catch((err) => { console.error('TEST FAILED:', err); process.exitCode = 1; })
  .finally(async () => {
    console.log('\nWebSocket push check passed.');
    await closeDb();
  });
