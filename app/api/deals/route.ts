import { NextResponse } from 'next/server';
import { parseFilters } from '@/lib/filters';
import { queryDeals } from '@/lib/repository';
import { encodeCsv } from '@/lib/csv';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = parseFilters(url.searchParams);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }
  const { rows, total } = await queryDeals(result.filters, result.limit, result.offset);

  if (result.format === 'csv') {
    const csv = encodeCsv(
      ['id', 'announced_at', 'headline', 'sector', 'geography', 'deal_type',
       'deal_size_usd', 'status', 'primary_source_id', 'primary_url'],
      rows.map((d) => [
        d.id, d.announced_at, d.headline, d.sector, d.geography, d.deal_type,
        d.deal_size_usd, d.status, d.primary_source_id, d.primary_url,
      ])
    );
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="safyr-deals-${stamp}.csv"`,
        'X-Total-Count': String(total),
      },
    });
  }

  return NextResponse.json({
    deals: rows,
    total,
    limit: result.limit,
    offset: result.offset,
  });
}
