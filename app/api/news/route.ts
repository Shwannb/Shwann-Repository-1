import { NextResponse } from 'next/server';
import { parseFilters } from '@/lib/filters';
import { queryNews } from '@/lib/repository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = parseFilters(url.searchParams);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  const { rows, total } = await queryNews(result.filters, result.limit, result.offset);
  return NextResponse.json({
    news: rows,
    total,
    limit: result.limit,
    offset: result.offset,
  });
}
