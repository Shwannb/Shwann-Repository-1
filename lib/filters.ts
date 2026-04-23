// Filter schema shared by /api/deals and /api/news.
//
// The News tab auto-filters to the same sector as the Deals filter, so both
// endpoints accept the same parameter set. Everything parses out of a Next.js
// URLSearchParams object.

import { z } from 'zod';
import { SECTORS, GEOGRAPHIES, DEAL_TYPES } from './taxonomy';

const numericString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be numeric')
  .transform((s) => Number(s));

const positiveInt = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform((s) => Number(s));

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 date')
  .transform((s) => new Date(s));

export const FilterSchema = z.object({
  sector:     z.enum(SECTORS).optional(),
  geography:  z.enum(GEOGRAPHIES).optional(),
  deal_type:  z.enum(DEAL_TYPES).optional(),
  min_size:   numericString.optional(),
  max_size:   numericString.optional(),
  from:       isoDate.optional(),
  to:         isoDate.optional(),
  limit:      positiveInt.pipe(z.number().max(200)).optional(),
  offset:     positiveInt.optional(),
});

export type Filters = z.infer<typeof FilterSchema>;

export interface FilterResult {
  ok: true;
  filters: Filters;
  limit: number;
  offset: number;
}
export interface FilterError {
  ok: false;
  message: string;
}

export function parseFilters(params: URLSearchParams): FilterResult | FilterError {
  const raw: Record<string, string> = {};
  for (const key of ['sector', 'geography', 'deal_type', 'min_size', 'max_size', 'from', 'to', 'limit', 'offset']) {
    const v = params.get(key);
    if (v !== null && v !== '') raw[key] = v;
  }
  const parsed = FilterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue.path.join('.')}: ${issue.message}` };
  }
  const f = parsed.data;
  if (f.min_size !== undefined && f.max_size !== undefined && f.min_size > f.max_size) {
    return { ok: false, message: 'min_size must be <= max_size' };
  }
  if (f.from && f.to && f.from > f.to) {
    return { ok: false, message: 'from must be <= to' };
  }
  return {
    ok: true,
    filters: f,
    limit: f.limit ?? 50,
    offset: f.offset ?? 0,
  };
}
