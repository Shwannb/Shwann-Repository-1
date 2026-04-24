import { NextResponse } from 'next/server';
import { parseFilters } from '@/lib/filters';
import { queryNews } from '@/lib/repository';
import { encodeCsv } from '@/lib/csv';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = parseFilters(url.searchParams);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  const { rows, total } = await queryNews(result.filters, result.limit, result.offset);

  if (result.format === 'csv') {
    const csv = encodeCsv(
      ['id', 'published_at', 'source_id', 'external_id', 'title',
       'sector', 'geography', 'deal_type', 'deal_size_usd', 'url'],
      rows.map((n) => [
        n.id, n.published_at, n.source_id, n.external_id, n.title,
        n.sector, n.geography, n.deal_type, n.deal_size_usd, n.url,
      ])
    );
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="safyr-news-${stamp}.csv"`,
        'X-Total-Count': String(total),
      },
    });
  }

  return NextResponse.json({
    news: rows,
    total,
    limit: result.limit,
    offset: result.offset,
  });
}
