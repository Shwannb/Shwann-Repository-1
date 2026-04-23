-- Safyr Deal Terminal — Phase 1 schema
-- Two primary object types: deals (structured transactions) and news_items (raw
-- articles awaiting classification). Both share a sector/geography taxonomy so
-- the News tab can auto-filter to the same sector as the Deals filter.
--
-- PII / contact data is intentionally absent from this schema. Contact
-- enrichment is Phase 2 and must go through a licensed provider (Apollo.io).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Upstream sources we ingest from (edgar, companies_house, newsapi, gdelt, rss:*).
CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('edgar','companies_house','newsapi','gdelt','rss')),
  display_name   TEXT NOT NULL,
  url            TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  last_polled_at TIMESTAMPTZ,
  last_cursor    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Raw ingested items before classification. external_id is the source-specific
-- stable identifier (EDGAR accession no., RSS guid, NewsAPI url hash, etc.) and
-- combined with source_id gives us idempotent upserts.
CREATE TABLE IF NOT EXISTS news_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     TEXT NOT NULL REFERENCES sources(id),
  external_id   TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,
  published_at  TIMESTAMPTZ NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Classification output (nullable until the classifier runs).
  sector        TEXT,
  geography     TEXT,
  deal_type     TEXT,
  deal_size_usd NUMERIC(20, 2),
  classified_at TIMESTAMPTZ,
  classifier_model TEXT,

  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS news_items_published_idx ON news_items (published_at DESC);
CREATE INDEX IF NOT EXISTS news_items_sector_idx    ON news_items (sector)    WHERE sector    IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_items_geography_idx ON news_items (geography) WHERE geography IS NOT NULL;

-- A deal is a structured transaction extracted from one or more news_items.
-- We keep it separate so the Deals grid stays clean even when the same deal is
-- reported by multiple outlets.
CREATE TABLE IF NOT EXISTS deals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  headline       TEXT NOT NULL,
  target_name    TEXT,
  acquirer_name  TEXT,
  sector         TEXT,
  geography      TEXT,
  deal_type      TEXT CHECK (deal_type IN (
    'm_and_a','pe_buyout','vc_round','ipo','secondary',
    'debt_financing','restructuring','joint_venture','other'
  )),
  deal_size_usd  NUMERIC(20, 2),
  announced_at   TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'announced'
                  CHECK (status IN ('rumored','announced','completed','terminated')),
  primary_source_id TEXT REFERENCES sources(id),
  primary_url    TEXT,
  raw            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deals_announced_idx  ON deals (announced_at DESC);
CREATE INDEX IF NOT EXISTS deals_sector_idx     ON deals (sector)    WHERE sector    IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_geography_idx  ON deals (geography) WHERE geography IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_deal_type_idx  ON deals (deal_type) WHERE deal_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_size_idx       ON deals (deal_size_usd) WHERE deal_size_usd IS NOT NULL;

-- Linkage between news_items and deals (many-to-many — one deal can be sourced
-- from multiple news items; one news item can mention multiple deals).
CREATE TABLE IF NOT EXISTS deal_news_items (
  deal_id      UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  news_item_id UUID NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  PRIMARY KEY (deal_id, news_item_id)
);

-- Seed the SEC EDGAR source row. Other sources get inserted as their workers come online.
INSERT INTO sources (id, kind, display_name, url) VALUES
  ('edgar', 'edgar', 'SEC EDGAR 8-K filings', 'https://www.sec.gov/cgi-bin/browse-edgar')
ON CONFLICT (id) DO NOTHING;
