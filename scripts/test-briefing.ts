// Briefing pipeline test (fixture-driven, no outbound API calls).
//
// [1/4] Empty-day fast path: zero deals returns the canned no-deals message
//        WITHOUT calling the briefer.
// [2/4] With recent deals, the briefer is called once and the markdown
//        round-trips through generateBriefing.
// [3/4] Second call within the cache TTL re-uses the cached result and
//        does NOT re-call the briefer (cached: true).
// [4/4] After cache reset, a fresh call generates again.

import { db, closeDb } from '../lib/db';
import { generateBriefing, _resetBriefingCache, type Briefer } from '../lib/briefing';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Identity helper: defeats `asserts` narrowing of literal numeric fields. Each
// callsite returns a fresh `number`-typed expression, so a previous
// `assert(n(state.calls) === 0)` doesn't pin the type.
const n = (x: number): number => x;

async function cleanState() {
  await db().query(
    `DELETE FROM deal_news_items WHERE news_item_id IN (
      SELECT id FROM news_items WHERE external_id LIKE 'brief-test-%'
    )`
  );
  await db().query(`DELETE FROM deals WHERE primary_url LIKE 'https://example.test/brief-%'`);
  await db().query(`DELETE FROM news_items WHERE external_id LIKE 'brief-test-%'`);
}

async function seedDeals() {
  const ids = ['brief-test-1', 'brief-test-2', 'brief-test-3'];
  for (let i = 0; i < ids.length; i++) {
    await db().query(
      `INSERT INTO news_items (source_id, external_id, url, title, summary, published_at)
       VALUES ('edgar', $1, $2, $3, null, NOW() - INTERVAL '2 hours')`,
      [ids[i], `https://example.test/${ids[i]}`, `[brief-test] sample deal #${i + 1}`]
    );
  }
  await db().query(
    `INSERT INTO deals (headline, sector, geography, deal_type, deal_size_usd,
                        announced_at, primary_source_id, primary_url)
     VALUES
       ('[brief-test] MegaCorp acquires WidgetCo', 'technology', 'north_america', 'm_and_a', 4200000000,
        NOW() - INTERVAL '2 hours', 'edgar', 'https://example.test/brief-1'),
       ('[brief-test] Lagos fintech raises $25M', 'fintech', 'sub_saharan_africa', 'vc_round', 25000000,
        NOW() - INTERVAL '3 hours', 'edgar', 'https://example.test/brief-2'),
       ('[brief-test] European wind IPO',          'energy',  'europe',             'ipo',     null,
        NOW() - INTERVAL '4 hours', 'edgar', 'https://example.test/brief-3')`
  );
}

async function main() {
  await cleanState();
  // Empty briefer counter — increments each time it's called so we can prove
  // the cache + empty-day paths skip it.
  // Wrap in an object AND annotate the field as `number` — the `asserts`
  // narrowing on assert(state.calls === N) would otherwise pin the literal
  // type, even though the closure increments it between checks.
  const state: { calls: number } = { calls: 0 };
  const stub: Briefer = async (deals) => {
    state.calls++;
    return `# Test briefing\n${deals.length} deals.\n\n## Top deals\n- one\n- two`;
  };

  try {
    _resetBriefingCache();

    // [1/4] Empty day — no deals in last 24h, briefer NOT called.
    const empty = await generateBriefing(stub);
    assert(empty.window_count === 0, `expected 0 deals, got ${empty.window_count}`);
    assert(empty.markdown === 'No qualifying deals in the last 24 hours.', `bad empty markdown: ${empty.markdown}`);
    assert(n(state.calls) === 0, `briefer should not be called for empty day, got ${state.calls} call(s)`);
    console.log('[1/4] empty-day fast path: OK (briefer not called)');

    // [2/4] Seed three deals, reset cache, generate.
    await seedDeals();
    _resetBriefingCache();
    const r1 = await generateBriefing(stub);
    assert(r1.window_count === 3, `expected 3 deals, got ${r1.window_count}`);
    assert(r1.cached === false, 'first call after cache reset should not be cached');
    assert(r1.markdown.includes('Test briefing'), 'briefer output not surfaced');
    assert(n(state.calls) === 1, `briefer should be called once, got ${state.calls}`);
    console.log(`[2/4] seeded briefing: window=${r1.window_count} cached=${r1.cached}: OK`);

    // [3/4] Second call — should serve from cache.
    const r2 = await generateBriefing(stub);
    assert(r2.cached === true, 'second call should be cached');
    assert(r2.markdown === r1.markdown, 'cached markdown should match');
    assert(n(state.calls) === 1, `briefer should NOT be called again, got ${state.calls}`);
    assert(r2.generated_at === r1.generated_at, 'cached timestamp should match original');
    console.log('[3/4] cache hit on second call: OK (briefer not re-called)');

    // [4/4] After reset, regenerate from scratch.
    _resetBriefingCache();
    const r3 = await generateBriefing(stub);
    assert(r3.cached === false, 'after reset, should not be cached');
    assert(n(state.calls) === 2, `briefer should be called again after reset, got ${state.calls}`);
    console.log('[4/4] cache reset triggers regen: OK');
  } finally {
    await cleanState();
  }
  console.log('\nAll briefing checks passed.');
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exitCode = 1; }).finally(() => closeDb());
