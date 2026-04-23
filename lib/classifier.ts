// Claude-backed classifier for Safyr deal ingestion.
//
// Input: a single news_items row (title + summary + source hint).
// Output: sector / geography / deal_type / deal_size_usd, drawn from the
//         controlled taxonomies in lib/taxonomy.ts.
//
// The classifier is injectable — pass a stub to tests; production uses
// claudeClassifier() which calls the Anthropic SDK.
//
// Design notes:
// - Model: claude-opus-4-7 with adaptive thinking. No sampling params on 4.7.
// - Structured outputs via output_config.format (JSON Schema) so the response
//   is parsed and validated server-side; we read message.parsed_output.
// - Prompt caching: the large system block (taxonomy definitions + rubric)
//   is identical across every call, so we mark it cache_control: ephemeral.
//   The volatile per-item text goes in the user turn, after the breakpoint.
// - deal_size_usd is nullable — the model returns null when it cannot be
//   extracted with reasonable confidence, rather than hallucinating a number.

import Anthropic from '@anthropic-ai/sdk';
import {
  SECTORS,
  GEOGRAPHIES,
  DEAL_TYPES,
  type Sector,
  type Geography,
  type DealType,
} from './taxonomy';

export interface ClassifierInput {
  title: string;
  summary?: string | null;
  sourceKind: string; // e.g. 'edgar', 'rss', 'newsapi'
}

export interface Classification {
  sector: Sector;
  geography: Geography;
  deal_type: DealType;
  deal_size_usd: number | null;
}

export type Classifier = (item: ClassifierInput) => Promise<Classification>;

const SYSTEM_PROMPT = `You classify corporate finance and M&A news for a deal-sourcing terminal at an impact investment bank.

Your job is to map one headline + summary to four fields, each drawn from a fixed taxonomy:

sector (one of): ${SECTORS.join(', ')}
geography (one of): ${GEOGRAPHIES.join(', ')}
deal_type (one of): ${DEAL_TYPES.join(', ')}
deal_size_usd: a number in US dollars, or null if not stated or not reasonably inferable.

Rules:
- Pick the single best value from each list. Do not invent new values.
- Use 'unknown' for geography or deal_type when the text genuinely does not say.
  Use 'other' for sector when the industry is clear but does not match a listed bucket.
- 'geography' refers to the region of the TARGET / primary operating entity, not the acquirer.
- deal_size_usd: if the text states a value in another currency, convert using a
  reasonable spot rate; if a range is given, use the midpoint; if only equity
  value or enterprise value is given, use enterprise value when available.
  Return null rather than guessing. Do not extract share prices or market caps
  as deal size — only transaction value.
- This is structured data for a database. Be conservative. When in doubt, prefer
  'unknown' / 'other' / null over an over-confident guess.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    sector:        { type: 'string', enum: [...SECTORS] },
    geography:     { type: 'string', enum: [...GEOGRAPHIES] },
    deal_type:     { type: 'string', enum: [...DEAL_TYPES] },
    deal_size_usd: { type: ['number', 'null'] },
  },
  required: ['sector', 'geography', 'deal_type', 'deal_size_usd'],
  additionalProperties: false,
} as const;

export const CLASSIFIER_MODEL = 'claude-opus-4-7';

function isValidClassification(x: unknown): x is Classification {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.sector === 'string' && (SECTORS as readonly string[]).includes(r.sector) &&
    typeof r.geography === 'string' && (GEOGRAPHIES as readonly string[]).includes(r.geography) &&
    typeof r.deal_type === 'string' && (DEAL_TYPES as readonly string[]).includes(r.deal_type) &&
    (r.deal_size_usd === null || typeof r.deal_size_usd === 'number')
  );
}

export function claudeClassifier(): Classifier {
  const client = new Anthropic();
  return async (item) => {
    const userText =
      `Source: ${item.sourceKind}\n` +
      `Headline: ${item.title}\n` +
      (item.summary ? `Summary: ${item.summary}\n` : '');

    const response = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          // Prompt caching: the system block is identical across calls, so we
          // write once and read it back on every subsequent classification.
          cache_control: { type: 'ephemeral' },
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: OUTPUT_SCHEMA,
        },
      },
      messages: [{ role: 'user', content: userText }],
    });

    const parsed = (response as { parsed_output?: unknown }).parsed_output;
    if (!isValidClassification(parsed)) {
      throw new Error(
        `Classifier returned invalid structure: ${JSON.stringify(parsed).slice(0, 200)}`
      );
    }
    return parsed;
  };
}
