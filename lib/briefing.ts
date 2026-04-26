// Claude-generated morning briefing.
//
// Pulls the last 24h of deals from Postgres, hands them to Claude Opus 4.7
// with adaptive thinking, and returns a tight markdown briefing (≤ 800
// words) — opening summary, top deals by size, sector + geo roll-ups, ones
// to watch.
//
// The Anthropic call is injectable so tests run offline. Production uses
// claudeBriefer() which wraps client.messages.create with prompt caching on
// the stable system prompt; the volatile deal payload follows the cache
// breakpoint so the cache reads on every regeneration after the first.

import Anthropic from '@anthropic-ai/sdk';
import { db } from './db';

export const BRIEFING_MODEL = 'claude-opus-4-7';
const SYSTEM_PROMPT = `You are a junior analyst at Safyr Capital Partners writing the morning briefing for the deal team.

Audience: senior bankers reviewing M&A, PE, VC, and IPO activity from the last 24 hours.

Voice:
- Tight, factual, no marketing language ("game-changing", "transformative", "leading", etc.).
- Cite specific deal sizes (in USD) and target/acquirer names where the data supports it.
- No speculation about strategic rationale unless the source headline already says it.
- Treat the data as the only source of truth — do NOT introduce facts that are not in the input.

Structure (markdown, in this order):
1. **Top of the morning** — one-paragraph opening: count of deals, total volume, dominant sector/geo.
2. **Top deals by size** — bulleted list of up to 5 largest transactions, each one line: target, acquirer (if known), size, sector, geo.
3. **By sector** — bullet list of sectors with deal counts and total volume.
4. **By geography** — bullet list of regions with deal counts.
5. **Ones to watch** — up to 3 deals worth follow-up (smaller-volume but novel — emerging-market entrants, distressed targets, first-of-kind structures). Skip if the input doesn't support an interesting pick.

Constraints:
- Total length ≤ 800 words.
- No headers beyond the five above.
- If there are zero deals, return only "No qualifying deals in the last 24 hours."
- Do not include any contact information, decision-maker names, or speculation about who is behind a deal.`;

export interface BriefingInputDeal {
  headline: string;
  sector: string | null;
  geography: string | null;
  deal_type: string | null;
  deal_size_usd: number | null;
  announced_at: string;
}

export type Briefer = (deals: BriefingInputDeal[]) => Promise<string>;

export function claudeBriefer(): Briefer {
  const client = new Anthropic();
  return async (deals) => {
    const userPayload =
      `Generated at: ${new Date().toISOString()}\n` +
      `Deals in the last 24 hours: ${deals.length}\n\n` +
      deals.map((d, i) => {
        const size = d.deal_size_usd != null
          ? `$${d.deal_size_usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
          : 'undisclosed';
        return `${i + 1}. ${d.headline}\n` +
               `   sector=${d.sector ?? '—'} geo=${d.geography ?? '—'} ` +
               `type=${d.deal_type ?? '—'} size=${size} announced=${d.announced_at}`;
      }).join('\n');

    const response = await client.messages.create({
      model: BRIEFING_MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userPayload }],
    });

    // Concatenate every text block. We don't surface thinking blocks — they're
    // useful for debugging quality but not for the analyst output.
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') parts.push(block.text);
    }
    const text = parts.join('\n').trim();
    if (text.length === 0) {
      throw new Error('Briefer returned no text content');
    }
    return text;
  };
}

export async function fetchRecentDeals(): Promise<BriefingInputDeal[]> {
  const { rows } = await db().query<{
    headline: string;
    sector: string | null;
    geography: string | null;
    deal_type: string | null;
    deal_size_usd: string | null;
    announced_at: string;
  }>(
    `SELECT headline, sector, geography, deal_type,
            deal_size_usd::text AS deal_size_usd,
            announced_at::text  AS announced_at
       FROM deals
      WHERE announced_at > NOW() - INTERVAL '24 hours'
      ORDER BY deal_size_usd DESC NULLS LAST, announced_at DESC
      LIMIT 100`
  );
  return rows.map((r) => ({
    ...r,
    deal_size_usd: r.deal_size_usd === null ? null : Number(r.deal_size_usd),
  }));
}

// In-memory cache keyed by 30-minute bucket. Multi-pod deployments would put
// this in Redis; Phase 1.5 single-pod assumption keeps it process-local.
interface CacheEntry { generated_at: number; window_count: number; markdown: string; }
let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface BriefingResult {
  markdown: string;
  generated_at: string;
  window_count: number;
  cached: boolean;
}

export async function generateBriefing(briefer: Briefer): Promise<BriefingResult> {
  if (cache && Date.now() - cache.generated_at < CACHE_TTL_MS) {
    return {
      markdown: cache.markdown,
      generated_at: new Date(cache.generated_at).toISOString(),
      window_count: cache.window_count,
      cached: true,
    };
  }
  const deals = await fetchRecentDeals();
  const markdown = deals.length === 0
    ? 'No qualifying deals in the last 24 hours.'
    : await briefer(deals);
  cache = { generated_at: Date.now(), window_count: deals.length, markdown };
  return {
    markdown,
    generated_at: new Date(cache.generated_at).toISOString(),
    window_count: cache.window_count,
    cached: false,
  };
}

// Test hook — production never needs this.
export function _resetBriefingCache(): void { cache = null; }
