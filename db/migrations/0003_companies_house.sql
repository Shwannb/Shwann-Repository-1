-- Companies House UK — adds the source row and a small watchlist table.
-- Each row in ch_watchlist is one UK company whose filing-history we poll.
--
-- This is a deliberately narrow ingestion pattern: we do NOT scrape or
-- brute-force the register — operators explicitly add companies to watch.
-- API usage is subject to the Companies House fair-usage policy (~600
-- req/5-min window); our per-10-min cadence across a handful of companies
-- stays well inside it.

INSERT INTO sources (id, kind, display_name, url) VALUES
  ('companies_house', 'companies_house', 'Companies House UK — filing history',
   'https://api.company-information.service.gov.uk')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ch_watchlist (
  company_number  TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_polled_at  TIMESTAMPTZ,
  last_cursor     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ch_watchlist_enabled_idx ON ch_watchlist (enabled) WHERE enabled = TRUE;
