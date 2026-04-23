# Compliance Notes — Safyr Deal Terminal

## Data scope (Phase 1)

Phase 1 ingests only **publicly available company-level and transaction-level
information** from official filings and published news:

- SEC EDGAR (public filings, governed by SEC fair-access policy)
- Companies House UK (public register)
- NewsAPI, GDELT, RSS feeds (published editorial content)

No personal contact data (email, direct-dial phone, LinkedIn handles, etc.) is
collected, derived, or stored by Phase 1 workers. The `news_items` and `deals`
tables intentionally contain **no PII columns**.

## Phase 2 — contact enrichment

Contact data (decision-maker names, emails, phones) is **out of scope for
Phase 1** and must not be introduced via scraping, HTML parsing, or
LinkedIn/public-profile extraction. Any such pathway — even if technically
feasible — is prohibited.

When Phase 2 begins, contact data will be sourced **exclusively** through a
licensed commercial provider (Apollo.io) under that provider's data-use terms.
The `APOLLO_API_KEY` env var in `.env.example` is a placeholder for that
integration and is not wired up in Phase 1.

## SEC EDGAR fair-access

All EDGAR requests must:

- Include a descriptive `User-Agent` with a contact email (see `EDGAR_USER_AGENT`)
- Stay under 10 requests per second in aggregate
- Respect robots and Retry-After on any 429/5xx response

The 10-minute poll cadence used by the worker is well below this ceiling.
