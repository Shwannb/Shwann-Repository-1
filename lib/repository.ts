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
    text: string; // headline (deals) or title (news_items)
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
  if (filters.q) {
    // ILIKE %q% — escape any user-supplied % and _ so they're literal.
    const escaped = filters.q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    add(`${cols.text} ILIKE '%' || $? || '%'`, escaped);
  }
  return { clauses, params };
}

// Map the public sort key to the table-specific column. Whitelisted in
// FilterSchema so no user input ever lands in the SQL string.
function sortColumn(
  key: 'date' | 'sector' | 'geography' | 'deal_type' | 'deal_size_usd' | undefined,
  cols: { date: string; sector: string; geography: string; deal_type: string; deal_size: string }
): string {
  switch (key) {
    case 'sector':        return cols.sector;
    case 'geography':     return cols.geography;
    case 'deal_type':     return cols.deal_type;
    case 'deal_size_usd': return cols.deal_size;
    case 'date':
    case undefined:
    default:              return cols.date;
  }
}

export async function queryDeals(
  filters: Filters,
  limit: number,
  offset: number
): Promise<{ rows: Deal[]; total: number }> {
  const cols = {
    sector: 'sector',
    geography: 'geography',
    deal_type: 'deal_type',
    deal_size: 'deal_size_usd',
    date: 'announced_at',
    text: 'headline',
  };
  const { clauses, params } = buildWhere(filters, cols);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const sortCol = sortColumn(filters.sort, cols);
  const direction = filters.order === 'asc' ? 'ASC' : 'DESC';
  // NULLS LAST keeps undisclosed-size rows out of the top of the list when
  // the user sorts by deal_size_usd.
  const orderBy = `ORDER BY ${sortCol} ${direction} NULLS LAST, id DESC`;

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
       ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total: Number(total[0].count) };
}

export interface DealSource {
  news_item_id: string;
  source_id: string;
  external_id: string;
  url: string;
  title: string;
  summary: string | null;
  published_at: string;
}

export interface DealWithSources {
  deal: Deal;
  sources: DealSource[];
}

export async function fetchDealWithSources(id: string): Promise<DealWithSources | null> {
  const { rows: dealRows } = await db().query<Deal>(
    `SELECT id, headline, sector, geography, deal_type,
            deal_size_usd::float8 AS deal_size_usd,
            announced_at, status, primary_source_id, primary_url
       FROM deals
      WHERE id = $1`,
    [id]
  );
  if (dealRows.length === 0) return null;

  const { rows: sources } = await db().query<DealSource>(
    `SELECT n.id AS news_item_id, n.source_id, n.external_id, n.url,
            n.title, n.summary, n.published_at
       FROM deal_news_items d
       JOIN news_items      n ON n.id = d.news_item_id
      WHERE d.deal_id = $1
      ORDER BY n.published_at DESC`,
    [id]
  );
  return { deal: dealRows[0], sources };
}

export interface DashboardStats {
  deals_24h: number;
  deals_7d: number;
  volume_24h_usd: number;
  volume_7d_usd: number;
  top_sector_24h:    { sector: string; count: number } | null;
  top_geography_24h: { geography: string; count: number } | null;
  news_24h: number;
  unclassified_pending: number;
}

export async function queryStats(): Promise<DashboardStats> {
  const { rows: [r] } = await db().query<{
    deals_24h: string;
    deals_7d: string;
    volume_24h_usd: string | null;
    volume_7d_usd: string | null;
    news_24h: string;
    unclassified_pending: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE d.announced_at > NOW() - INTERVAL '24 hours')::text         AS deals_24h,
       COUNT(*) FILTER (WHERE d.announced_at > NOW() - INTERVAL '7 days')::text           AS deals_7d,
       SUM(d.deal_size_usd) FILTER (WHERE d.announced_at > NOW() - INTERVAL '24 hours')::text AS volume_24h_usd,
       SUM(d.deal_size_usd) FILTER (WHERE d.announced_at > NOW() - INTERVAL '7 days')::text   AS volume_7d_usd,
       (SELECT COUNT(*)::text FROM news_items WHERE ingested_at > NOW() - INTERVAL '24 hours') AS news_24h,
       (SELECT COUNT(*)::text FROM news_items WHERE classified_at IS NULL)                AS unclassified_pending
       FROM deals d`
  );

  const { rows: topSector } = await db().query<{ sector: string; count: string }>(
    `SELECT sector, COUNT(*)::text AS count
       FROM deals
      WHERE announced_at > NOW() - INTERVAL '24 hours' AND sector IS NOT NULL
      GROUP BY sector ORDER BY COUNT(*) DESC LIMIT 1`
  );
  const { rows: topGeo } = await db().query<{ geography: string; count: string }>(
    `SELECT geography, COUNT(*)::text AS count
       FROM deals
      WHERE announced_at > NOW() - INTERVAL '24 hours' AND geography IS NOT NULL
      GROUP BY geography ORDER BY COUNT(*) DESC LIMIT 1`
  );

  return {
    deals_24h:           Number(r.deals_24h),
    deals_7d:            Number(r.deals_7d),
    volume_24h_usd:      Number(r.volume_24h_usd ?? 0),
    volume_7d_usd:       Number(r.volume_7d_usd  ?? 0),
    top_sector_24h:      topSector[0] ? { sector: topSector[0].sector, count: Number(topSector[0].count) } : null,
    top_geography_24h:   topGeo[0]    ? { geography: topGeo[0].geography, count: Number(topGeo[0].count) } : null,
    news_24h:            Number(r.news_24h),
    unclassified_pending:Number(r.unclassified_pending),
  };
}

export interface SourceHealth {
  id: string;
  kind: string;
  display_name: string;
  enabled: boolean;
  last_polled_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  items_total: number;
  items_24h: number;
  items_since_poll: number;
  is_stale: boolean;
}

// Stale = enabled, hasn't been polled in the last 30 minutes (3× the standard
// 10-minute cadence). Disabled sources are never marked stale because operators
// turn them off deliberately.
const STALE_AFTER_MS = 30 * 60 * 1000;

export async function querySources(): Promise<SourceHealth[]> {
  const { rows } = await db().query<{
    id: string;
    kind: string;
    display_name: string;
    enabled: boolean;
    last_polled_at: string | null;
    last_error: string | null;
    last_error_at: string | null;
    items_total: string;
    items_24h: string;
    items_since_poll: string;
  }>(
    `SELECT s.id, s.kind, s.display_name, s.enabled,
            s.last_polled_at, s.last_error, s.last_error_at,
            COALESCE(c.items_total, 0)::text     AS items_total,
            COALESCE(c.items_24h,   0)::text     AS items_24h,
            COALESCE(c.items_since_poll, 0)::text AS items_since_poll
       FROM sources s
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE TRUE)                                              AS items_total,
                COUNT(*) FILTER (WHERE n.ingested_at > NOW() - INTERVAL '24 hours')        AS items_24h,
                COUNT(*) FILTER (WHERE s.last_polled_at IS NOT NULL
                                   AND n.ingested_at > s.last_polled_at - INTERVAL '15 min') AS items_since_poll
           FROM news_items n
          WHERE n.source_id = s.id
       ) c ON TRUE
      ORDER BY s.kind, s.id`
  );

  const now = Date.now();
  return rows.map((r) => {
    const lastPolledMs = r.last_polled_at ? new Date(r.last_polled_at).getTime() : 0;
    const isStale =
      r.enabled && (lastPolledMs === 0 || now - lastPolledMs > STALE_AFTER_MS);
    return {
      id: r.id,
      kind: r.kind,
      display_name: r.display_name,
      enabled: r.enabled,
      last_polled_at: r.last_polled_at,
      last_error: r.last_error,
      last_error_at: r.last_error_at,
      items_total: Number(r.items_total),
      items_24h: Number(r.items_24h),
      items_since_poll: Number(r.items_since_poll),
      is_stale: isStale,
    };
  });
}

export async function queryNews(
  filters: Filters,
  limit: number,
  offset: number
): Promise<{ rows: NewsItem[]; total: number }> {
  const cols = {
    sector: 'sector',
    geography: 'geography',
    deal_type: 'deal_type',
    deal_size: 'deal_size_usd',
    date: 'published_at',
    text: 'title',
  };
  const { clauses, params } = buildWhere(filters, cols);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const sortCol = sortColumn(filters.sort, cols);
  const direction = filters.order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `ORDER BY ${sortCol} ${direction} NULLS LAST, id DESC`;

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
       ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return { rows, total: Number(total[0].count) };
}
