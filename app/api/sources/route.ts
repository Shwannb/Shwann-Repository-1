import { NextResponse } from 'next/server';
import { querySources } from '@/lib/repository';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sources = await querySources();
  return NextResponse.json({ sources, total: sources.length });
}
