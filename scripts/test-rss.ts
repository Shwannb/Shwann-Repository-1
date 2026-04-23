// End-to-end test for the RSS bundle.
//
// [1/5] parseFeed detects Atom vs RSS 2.0 correctly
// [2/5] RSS 2.0 parsing: title, link, guid, pubDate, description/CDATA
// [3/5] pollSource with a fixture fetcher: inserts, cursor update,
//        last_polled_at bump
// [4/5] Second run is a no-op (dedupe via (source_id, external_id))
// [5/5] One failing feed does not block the rest of the bundle; failed
//        source still gets last_polled_at updated
//
// Live egress is skipped — sandbox has no outbound HTTPS. Same pattern as
// the edgar test.

import { db, closeDb } from '../lib/db';
import { parseFeed } from '../lib/feed';
import { pollAll, pollSource, type FeedFetcher } from '../workers/rss';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Test Deals Feed</title>
    <item>
      <title>MegaCorp agrees to buy WidgetCo for $2.5B</title>
      <link>https://example.test/rss/megacorp-widgetco</link>
      <description><![CDATA[All-cash deal values <b>WidgetCo</b> at $2.5B &amp; creates synergies.]]></description>
      <pubDate>Wed, 22 Apr 2026 14:05:00 GMT</pubDate>
      <guid isPermaLink="false">test-rss-guid-1</guid>
    </item>
    <item>
      <title>European fintech raises €40M Series C</title>
      <link>https://example.test/rss/eu-fintech-series-c</link>
      <description>Berlin-based payments company closes round.</description>
      <dc:date>2026-04-22T12:00:00Z</dc:date>
      <guid>test-rss-guid-2</guid>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom-flavored deal announcement</title>
    <link rel="alternate" href="https://example.test/atom/deal-1"/>
    <summary>Atom feed item</summary>
    <updated>2026-04-22T10:00:00Z</updated>
    <id>urn:atom:test:deal-1</id>
  </entry>
</feed>`;

async function cleanup() {
  await db().query(
    `DELETE FROM news_items WHERE external_id LIKE 'test-rss-guid-%' OR external_id = 'urn:atom:test:deal-1'`
  );
  await db().query(
    `INSERT INTO sources (id, kind, display_name, url, enabled)
       VALUES ('rss:test_rss', 'rss', 'Test RSS', 'https://example.test/rss', TRUE),
              ('rss:test_atom', 'rss', 'Test Atom', 'https://example.test/atom', TRUE),
              ('rss:test_broken', 'rss', 'Test Broken', 'https://example.test/broken', TRUE)
       ON CONFLICT (id) DO UPDATE SET enabled = TRUE, url = EXCLUDED.url`
  );
  // Disable the 10 seeded real sources so pollAll only sees our test ones.
  await db().query(
    `UPDATE sources SET enabled = FALSE WHERE kind = 'rss' AND id NOT LIKE 'rss:test_%'`
  );
}

async function restoreSources() {
  await db().query(`DELETE FROM sources WHERE id LIKE 'rss:test_%'`);
  await db().query(
    `UPDATE sources SET enabled = TRUE WHERE kind = 'rss' AND id NOT LIKE 'rss:test_%'`
  );
}

async function testAutoDetect() {
  const rssItems = parseFeed(RSS_FIXTURE);
  assert(rssItems.length === 2, `RSS: expected 2 items, got ${rssItems.length}`);
  assert(rssItems[0].externalId === 'test-rss-guid-1', 'RSS guid mismatch');
  assert(rssItems[0].title.includes('MegaCorp'), 'RSS title mismatch');
  assert(rssItems[0].link === 'https://example.test/rss/megacorp-widgetco', 'RSS link mismatch');
  assert(rssItems[0].summary?.includes('WidgetCo'), 'RSS CDATA summary mismatch');
  assert(rssItems[0].publishedAt.toISOString() === '2026-04-22T14:05:00.000Z', 'RSS pubDate parse');

  const atomItems = parseFeed(ATOM_FIXTURE);
  assert(atomItems.length === 1, `Atom: expected 1 item, got ${atomItems.length}`);
  assert(atomItems[0].externalId === 'urn:atom:test:deal-1', 'Atom id mismatch');

  console.log('[1/5] parseFeed auto-detects Atom vs RSS 2.0: OK');
  console.log('[2/5] RSS 2.0: title, link, guid, pubDate, CDATA summary all parsed: OK');
}

async function testPollPipeline() {
  await cleanup();

  const fetcher: FeedFetcher = async (url) => {
    if (url === 'https://example.test/rss')  return RSS_FIXTURE;
    if (url === 'https://example.test/atom') return ATOM_FIXTURE;
    if (url === 'https://example.test/broken') throw new Error('simulated network failure');
    throw new Error(`unexpected url: ${url}`);
  };

  const r1 = await pollAll(fetcher);
  console.log(
    `[3/5] pollAll: sources=${r1.sources} fetched=${r1.totals.fetched} ` +
    `inserted=${r1.totals.inserted} errored=${r1.totals.errored}`
  );
  assert(r1.sources === 3, `expected 3 test sources, got ${r1.sources}`);
  assert(r1.totals.inserted === 3, `expected 3 inserted (2 RSS + 1 Atom), got ${r1.totals.inserted}`);
  assert(r1.totals.errored === 1, `expected 1 errored (broken source), got ${r1.totals.errored}`);

  // Cursor and last_polled_at should be set for all three sources (even broken).
  const { rows: cursors } = await db().query<{ id: string; last_cursor: string | null; last_polled_at: string | null }>(
    `SELECT id, last_cursor, last_polled_at FROM sources WHERE id LIKE 'rss:test_%' ORDER BY id`
  );
  const byId = Object.fromEntries(cursors.map((c) => [c.id, c]));
  assert(byId['rss:test_rss'].last_polled_at !== null, 'rss cursor polled_at');
  assert(byId['rss:test_rss'].last_cursor === 'test-rss-guid-1', 'rss cursor value');
  assert(byId['rss:test_atom'].last_cursor === 'urn:atom:test:deal-1', 'atom cursor value');
  assert(byId['rss:test_broken'].last_polled_at !== null, 'broken source still updated polled_at');
  assert(byId['rss:test_broken'].last_cursor === null, 'broken source cursor stays null');
  console.log('[3/5] cursor + last_polled_at updated per source (including failed): OK');

  // Dedupe on second run.
  const r2 = await pollAll(fetcher);
  assert(r2.totals.inserted === 0, `dedupe failed — inserted=${r2.totals.inserted} on second run`);
  assert(r2.totals.skipped === 3, `expected 3 skipped, got ${r2.totals.skipped}`);
  console.log(`[4/5] second poll deduped: inserted=0 skipped=${r2.totals.skipped}: OK`);

  // The broken source must not have blocked the others — check all 3 news rows are present.
  const { rows: inserted } = await db().query<{ source_id: string; external_id: string }>(
    `SELECT source_id, external_id FROM news_items
      WHERE external_id LIKE 'test-rss-guid-%' OR external_id = 'urn:atom:test:deal-1'
      ORDER BY source_id, external_id`
  );
  assert(inserted.length === 3, `expected 3 persisted items, got ${inserted.length}`);
  console.log('[5/5] failed feed did not block other sources: OK');
}

async function probeLive() {
  // Run a single source through the real fetcher, best-effort. This hits the
  // network; skipped with a clear message when egress is blocked.
  try {
    await db().query(`INSERT INTO sources (id, kind, display_name, url, enabled)
       VALUES ('rss:live_probe', 'rss', 'Live Probe', 'https://feeds.reuters.com/reuters/mergersNews', FALSE)
       ON CONFLICT (id) DO NOTHING`);
    const { rows } = await db().query<{ id: string; url: string; display_name: string }>(
      `SELECT id, url, display_name FROM sources WHERE id = 'rss:live_probe'`
    );
    const result = await pollSource(rows[0], async (url) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Safyr Capital Deal Terminal (compliance@safyr.capital)' },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.text();
    });
    if (result.error) {
      console.log(`[live] skipped (${result.error})`);
    } else {
      console.log(`[live] fetched=${result.fetched} inserted=${result.inserted}`);
    }
  } finally {
    await db().query(`DELETE FROM sources WHERE id = 'rss:live_probe'`);
  }
}

async function main() {
  try {
    await testAutoDetect();
    await testPollPipeline();
    await probeLive();
  } finally {
    await cleanup().catch(() => void 0);
    await restoreSources().catch(() => void 0);
  }
  console.log('\nAll RSS checks passed.');
}

main()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
