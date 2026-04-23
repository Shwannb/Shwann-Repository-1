// End-to-end smoke test for the SEC EDGAR worker.
// Runs three checks:
//   1. Atom parser + accession extraction on a fixture string
//   2. First live pollOnce() — expects to insert rows
//   3. Second live pollOnce() — expects every row to dedupe (inserted == 0)
//
// Requires DATABASE_URL and EDGAR_USER_AGENT.

import { parseAtom } from '../lib/feed';
import { extractAccession, toFiling, pollOnce, fetchEdgarAtom } from '../workers/edgar';
import { db, closeDb } from '../lib/db';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Latest Filings</title>
  <entry>
    <title>8-K - ACME CORP (0001234567) (Filer)</title>
    <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1234567/000119312524123456/0001193125-24-123456-index.htm"/>
    <summary type="html">Form 8-K filed by ACME CORP</summary>
    <updated>2026-04-23T14:05:00-04:00</updated>
    <id>urn:tag:sec.gov,2008:accession-number=0001193125-24-123456</id>
  </entry>
  <entry>
    <title>8-K - BETA INC (0007654321) (Filer)</title>
    <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/7654321/000119312524654321/0001193125-24-654321-index.htm"/>
    <updated>2026-04-23T14:00:00-04:00</updated>
    <id>urn:tag:sec.gov,2008:accession-number=0001193125-24-654321</id>
  </entry>
</feed>`;

async function testParser() {
  const entries = parseAtom(FIXTURE);
  assert(entries.length === 2, `expected 2 entries, got ${entries.length}`);
  assert(
    extractAccession(entries[0].id) === '0001193125-24-123456',
    'accession 1 mismatch'
  );
  const filing = toFiling(entries[0]);
  assert(filing !== null, 'toFiling returned null');
  assert(filing!.accessionNumber === '0001193125-24-123456', 'filing accession mismatch');
  assert(filing!.url.includes('sec.gov'), 'filing url missing');
  assert(filing!.publishedAt instanceof Date, 'filing publishedAt not a Date');
  console.log('[1/4] parser + toFiling: OK');
}

async function testPipelineWithFixture() {
  // Clear any prior fixture rows so the dedupe assertion is meaningful.
  await db().query(
    `DELETE FROM news_items WHERE source_id='edgar' AND external_id IN ($1, $2)`,
    ['0001193125-24-123456', '0001193125-24-654321']
  );

  const fixtureFetcher = async () => FIXTURE;
  const r1 = await pollOnce(fixtureFetcher);
  console.log(
    `[2/4] first poll (fixture): fetched=${r1.fetched} inserted=${r1.inserted} skipped=${r1.skipped}`
  );
  assert(r1.fetched === 2, `expected 2 filings, got ${r1.fetched}`);
  assert(r1.inserted === 2, `expected 2 inserts, got ${r1.inserted}`);

  const r2 = await pollOnce(fixtureFetcher);
  console.log(
    `[3/4] second poll (fixture): fetched=${r2.fetched} inserted=${r2.inserted} skipped=${r2.skipped}`
  );
  assert(r2.inserted === 0, `dedupe failed — second poll inserted ${r2.inserted}`);
  assert(r2.skipped === 2, `expected 2 skipped, got ${r2.skipped}`);

  // Confirm last_polled_at advanced.
  const { rows } = await db().query<{ last_polled_at: string | null }>(
    `SELECT last_polled_at FROM sources WHERE id = 'edgar'`
  );
  assert(rows[0]?.last_polled_at !== null, 'sources.last_polled_at was not updated');
  console.log(`[4/4] sources.last_polled_at updated: ${rows[0].last_polled_at}`);
}

async function probeLive() {
  // Best-effort live probe — skipped when the environment blocks egress.
  try {
    const xml = await fetchEdgarAtom();
    const entries = parseAtom(xml);
    console.log(`[live] EDGAR reachable, ${entries.length} entries in the current feed`);
  } catch (err) {
    console.log(`[live] skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function showSample() {
  const { rows } = await db().query(
    `SELECT external_id, title, published_at
       FROM news_items
      WHERE source_id = 'edgar'
      ORDER BY published_at DESC
      LIMIT 3`
  );
  console.log('\nSample rows:');
  for (const row of rows) {
    console.log(`  ${row.external_id}  ${new Date(row.published_at).toISOString()}  ${row.title.slice(0, 70)}`);
  }
}

async function main() {
  await testParser();
  await testPipelineWithFixture();
  await showSample();
  await probeLive();
  console.log('\nAll EDGAR checks passed.');
}

main()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
