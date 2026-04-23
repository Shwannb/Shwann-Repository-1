// Read repository for deals and news_items. Builds parameterized SQL from the
// shared Filters shape. No ORM — hand-rolled SQL keeps the query obvious and
// the EXPLAIN plan predictable.

import { db } from './db';
import type { Filters } from './filters';

export interface Deal {
  id: string;
  headline: string;
  sector: string | null;
  geography: string | null;
  deal_type: string | null;
  deal_size_usd: number | null;
  announced_at: string;
  status: string;
  primary_source_id: string | null;
  primary_url: string | null;
}

export interface NewsItem {
  id: string;
  source_id: string;
  external_id: string;
  title: string;
  summary: string | null;
  url: string;
  published_at: string;
  sector: string | null;
  geography: string | null;
  deal_type: string | null;
  deal_size_usd: number | null;
  classified_at: string | null;
}

interface WhereBuild {
  clauses: string[];
  params: unknown[];
}

// column alias -> filter key, so we can reuse the same whereBuilder for both
// deals and news_items (the column names overlap).
function buildWhere(
  filters: Filters,
  cols: {
    sector: string;
    geography: string;
    deal_type: string;
    deal_size: string;
    date: string;
  }
): WhereBuild {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(clause.replace('$?', `$${params.length}`));
  };
  if (filters.sector)    add(`${cols.sector}    = $?`, filters.sector);
  if (filters.geography) add(`${cols.geography} = $?`, filters.geography);
  if (filters.deal_type) add(`${cols.deal_type} = $?`, filters.deal_type);
  if (filters.min_size !== undefined) add(`${cols.deal_size} >= $?`, filters.min_size);
  if (filters.max_size !== undefined) add(`${cols.deal_size} <= $?`, filters.max_size);
  if (filters.from)      add(`${cols.date} >= $?`, filters.from.toISOString());
  if (filters.to)        add(`${cols.date} <= $?`, filters.to.toISOString());
  return { clauses, params };
}

export async function queryDeals(
  filters: Filters,
  limit: number,
  offset: number
): Promise<{ rows: Deal[]; total: number }> {
  const { clauses, params } = buildWhere(filters, {
    sector: 'sector',
    geography: 'geography',
    deal_type: 'deal_type',
    deal_size: 'deal_size_usd',
    date: 'announced_at',
  });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows: total } = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM deals ${where}`,
    params
  );
  const { rows } = await db().query<Deal>(
    `SELECT id, headline, sector, geography, deal_type,
            deal_size_usd::float8 AS deal_size_usd,
            announced_at, status, primary_source_id, primary_url
       FROM deals
       ${where}
       ORDER BY announced_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total: Number(total[0].count) };
}

export async function queryNews(
  filters: Filters,
  limit: number,
  offset: number
): Promise<{ rows: NewsItem[]; total: number }> {
  const { clauses, params } = buildWhere(filters, {
    sector: 'sector',
    geography: 'geography',
    deal_type: 'deal_type',
    deal_size: 'deal_size_usd',
    date: 'published_at',
  });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { rows: total } = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM news_items ${where}`,
    params
  );
  const { rows } = await db().query<NewsItem>(
    `SELECT id, source_id, external_id, title, summary, url, published_at,
            sector, geography, deal_type,
            deal_size_usd::float8 AS deal_size_usd,
            classified_at
       FROM news_items
       ${where}
       ORDER BY published_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total: Number(total[0].count) };
}
