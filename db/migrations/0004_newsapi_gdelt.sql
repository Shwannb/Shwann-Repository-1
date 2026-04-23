INSERT INTO sources (id, kind, display_name, url) VALUES
  ('newsapi', 'newsapi', 'NewsAPI /v2/everything — deal keywords',
   'https://newsapi.org/v2/everything'),
  ('gdelt',   'gdelt',   'GDELT DOC API — M&A themes + deal keywords',
   'https://api.gdeltproject.org/api/v2/doc/doc')
ON CONFLICT (id) DO NOTHING;
