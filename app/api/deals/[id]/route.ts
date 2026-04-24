import { NextResponse } from 'next/server';
import { fetchDealWithSources } from '@/lib/repository';

export const dynamic = 'force-dynamic';

// UUID v4-ish shape check. Keeps us from issuing a DB query with a bogus value
// (pg would 400 on type mismatch anyway, but we prefer a clean 400 here).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const result = await fetchDealWithSources(id);
  if (!result) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json(result);
}
