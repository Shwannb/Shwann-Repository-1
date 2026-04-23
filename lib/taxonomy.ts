// Controlled taxonomies for the deal-sourcing terminal.
//
// The classifier is constrained to pick exactly one value from each list so that
// downstream filters can equality-match instead of fuzzy-match. When a value
// truly doesn't fit, the classifier returns 'unknown' (or the sector/geography
// 'other' bucket) rather than inventing a new label.

export const SECTORS = [
  'energy',
  'materials',
  'industrials',
  'consumer_discretionary',
  'consumer_staples',
  'healthcare',
  'financials',
  'fintech',
  'technology',
  'media_telecom',
  'utilities',
  'real_estate',
  'agriculture',
  'infrastructure',
  'education',
  'other',
] as const;

export const GEOGRAPHIES = [
  'north_america',
  'latin_america',
  'europe',
  'uk',
  'mena',
  'sub_saharan_africa',
  'south_asia',
  'east_asia',
  'southeast_asia',
  'oceania',
  'global',
  'unknown',
] as const;

// Must remain in sync with the CHECK constraint in 0001_init.sql.
export const DEAL_TYPES = [
  'm_and_a',
  'pe_buyout',
  'vc_round',
  'ipo',
  'secondary',
  'debt_financing',
  'restructuring',
  'joint_venture',
  'other',
  'unknown',
] as const;

export type Sector    = typeof SECTORS[number];
export type Geography = typeof GEOGRAPHIES[number];
export type DealType  = typeof DEAL_TYPES[number];
