import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Used by docker-compose healthcheck and by deployment probes. Returns 200
// when the web process can reach the database, 503 otherwise. Deliberately
// narrow: a successful response means "ready to serve requests," nothing more.
export async function GET() {
  try {
    await db().query('SELECT 1');
    return NextResponse.json({ status: 'ok', db: 'up' });
  } catch (err) {
    return NextResponse.json(
      { status: 'degraded', db: 'down', error: err instanceof Error ? err.message : String(err) },
      { status: 503 }
    );
  }
}
