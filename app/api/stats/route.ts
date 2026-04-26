import { NextResponse } from 'next/server';
import { queryStats } from '@/lib/repository';

export const dynamic = 'force-dynamic';

export async function GET() {
  const stats = await queryStats();
  return NextResponse.json(stats);
}
