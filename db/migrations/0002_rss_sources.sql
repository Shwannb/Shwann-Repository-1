-- Seed 10 RSS feeds relevant to global deal sourcing.
--
-- URLs are best-effort as of ingestion date; operators should verify these
-- endpoints against the publishers' current RSS pages before relying on them
-- in production. Each feed is a stable public endpoint — no scraping, no
-- credentials, no circumvention of paywalls. If a publisher removes their
-- RSS, the corresponding sources.enabled should be set to FALSE rather than
-- switching to scraping (see COMPLIANCE.md).

INSERT INTO sources (id, kind, display_name, url) VALUES
  ('rss:reuters_deals',      'rss', 'Reuters — Deals',                 'https://feeds.reuters.com/reuters/mergersNews'),
  ('rss:pe_hub',             'rss', 'PE Hub — private equity news',    'https://www.pehub.com/feed/'),
  ('rss:dealstreetasia',     'rss', 'DealStreetAsia',                  'https://www.dealstreetasia.com/feed/'),
  ('rss:african_business',   'rss', 'African Business',                'https://african.business/feed'),
  ('rss:techcrunch_venture', 'rss', 'TechCrunch — Venture',            'https://techcrunch.com/category/venture/feed/'),
  ('rss:finsmes',            'rss', 'FinSMEs — funding announcements', 'https://www.finsmes.com/feed'),
  ('rss:pymnts_ma',          'rss', 'PYMNTS — M&A',                    'https://www.pymnts.com/category/mergers-acquisitions/feed/'),
  ('rss:seeking_alpha_ma',   'rss', 'Seeking Alpha — M&A',             'https://seekingalpha.com/market-news/m-a.xml'),
  ('rss:altassets',          'rss', 'AltAssets — private equity',      'https://www.altassets.net/feed'),
  ('rss:pei',                'rss', 'Private Equity International',    'https://www.privateequityinternational.com/feed/')
ON CONFLICT (id) DO NOTHING;
