// End-to-end test for the Companies House worker (fixture-driven).
//
// [1/4] Watchlist is respected; disabled rows are skipped
// [2/4] Fixture fetcher drives a full poll; filings upsert with
//        transaction_id as external_id
// [3/4] Second run dedupes (ON CONFLICT DO NOTHING via unique constraint)
// [4/4] One failing company does not block the rest

import { db, closeDb } from '../lib/db';
import { pollAll, type CHFetcher } from '../workers/companies_house';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const COMPANY_A = '00000001';
const COMPANY_B = '00000002';
const COMPANY_DISABLED = '00000003';
const COMPANY_BROKEN = '00000004';

async function seed() {
  await db().query(
    `DELETE FROM news_items WHERE external_id LIKE 'ch-test-%' AND source_id = 'companies_house'`
  );
  await db().query(`DELETE FROM ch_watchlist WHERE company_number LIKE '0000000%'`);
  await db().query(
    `INSERT INTO ch_watchlist (company_number, display_name, enabled) VALUES
       ($1, 'Acme UK Ltd',    TRUE),
       ($2, 'Beta Group PLC', TRUE),
       ($3, 'Disabled Co',    FALSE),
       ($4, 'Broken Co',      TRUE)`,
    [COMPANY_A, COMPANY_B, COMPANY_DISABLED, COMPANY_BROKEN]
  );
}

async function cleanup() {
  await db().query(
    `DELETE FROM news_items WHERE external_id LIKE 'ch-test-%' AND source_id = 'companies_house'`
  );
  await db().query(`DELETE FROM ch_watchlist WHERE company_number LIKE '0000000%'`);
}

const fetcher: CHFetcher = async (companyNumber, apiKey) => {
  assert(apiKey === 'test-key', `expected test-key, got ${apiKey}`);
  if (companyNumber === COMPANY_A) {
    return {
      items: [
        { transaction_id: 'ch-test-a1', description: 'allotment-of-shares', date: '2026-04-22', type: 'SH01' },
        { transaction_id: 'ch-test-a2', description: 'change-of-name-by-resolution', date: '2026-04-21', type: 'NM01' },
      ],
      total_count: 2,
    };
  }
  if (companyNumber === COMPANY_B) {
    return {
      items: [
        { transaction_id: 'ch-test-b1', description: 'accounts-with-accounts-type-full', date: '2026-04-20', type: 'AA' },
      ],
      total_count: 1,
    };
  }
  if (companyNumber === COMPANY_BROKEN) {
    throw new Error('simulated 500');
  }
  if (companyNumber === COMPANY_DISABLED) {
    throw new Error('disabled company should not be polled');
  }
  throw new Error(`unexpected company: ${companyNumber}`);
};

async function main() {
  await seed();
  try {
    const r1 = await pollAll(fetcher, 'test-key');
    console.log(
      `[1/4] pollAll: companies=${r1.companies} fetched=${r1.totals.fetched} ` +
      `inserted=${r1.totals.inserted} errored=${r1.totals.errored}`
    );
    assert(r1.companies === 3, `expected 3 enabled companies (disabled skipped), got ${r1.companies}`);
    assert(r1.totals.inserted === 3, `expected 3 inserts (2+1+0), got ${r1.totals.inserted}`);
    assert(r1.totals.errored === 1, `expected 1 errored (broken), got ${r1.totals.errored}`);

    const { rows: got } = await db().query<{ external_id: string; title: string }>(
      `SELECT external_id, title FROM news_items
        WHERE source_id = 'companies_house' AND external_id LIKE 'ch-test-%'
        ORDER BY external_id`
    );
    assert(got.length === 3, `expected 3 rows, got ${got.length}`);
    assert(got[0].title.startsWith('[Acme UK Ltd]'), `acme title: ${got[0].title}`);
    assert(got[2].title.startsWith('[Beta Group PLC]'), `beta title: ${got[2].title}`);
    console.log('[2/4] filings persisted with company-scoped titles: OK');

    const r2 = await pollAll(fetcher, 'test-key');
    assert(r2.totals.inserted === 0, `dedupe failed — inserted=${r2.totals.inserted}`);
    assert(r2.totals.skipped === 3, `expected 3 skipped, got ${r2.totals.skipped}`);
    console.log('[3/4] dedupe on second poll: OK');

    const broken = r1.results.find((r) => r.company_number === COMPANY_BROKEN);
    assert(broken?.error?.includes('500'), `broken company should have error`);
    const beta = r1.results.find((r) => r.company_number === COMPANY_B);
    assert(beta?.inserted === 1, 'beta should have inserted despite broken sibling');
    console.log('[4/4] one failing company did not block the rest: OK');
  } finally {
    await cleanup().catch(() => void 0);
  }
  console.log('\nAll Companies House checks passed.');
}

main()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
