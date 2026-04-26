'use client';

// Safyr Terminal — single-page, dense, Bloomberg-style.
//
// Filter state is shared across the Deals and News tabs so flipping from
// Deals (sector=fintech) to News shows only fintech news — the spec's "News
// tab auto-filters to the same sector as the deals filter" behavior is a
// direct consequence of using the same filter object for both endpoints.
//
// Data refresh: 30s polling. Phase 2 replaces this with a WebSocket push.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SECTORS, GEOGRAPHIES, DEAL_TYPES } from '@/lib/taxonomy';

type Tab = 'deals' | 'news' | 'sources';

interface DashboardStats {
  deals_24h: number;
  deals_7d: number;
  volume_24h_usd: number;
  volume_7d_usd: number;
  top_sector_24h:    { sector: string;    count: number } | null;
  top_geography_24h: { geography: string; count: number } | null;
  news_24h: number;
  unclassified_pending: number;
}

interface SourceHealth {
  id: string;
  kind: string;
  display_name: string;
  enabled: boolean;
  last_polled_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  items_total: number;
  items_24h: number;
  items_since_poll: number;
  is_stale: boolean;
}

interface Filters {
  sector: string;
  geography: string;
  deal_type: string;
  min_size: string;
  max_size: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  sector: '', geography: '', deal_type: '',
  min_size: '', max_size: '', from: '', to: '',
};

interface Deal {
  id: string;
  headline: string;
  sector: string | null;
  geography: string | null;
  deal_type: string | null;
  deal_size_usd: number | null;
  announced_at: string;
  status: string;
  primary_source_id: string | null;
  primary_url: string | null;
}

interface NewsItem {
  id: string;
  source_id: string;
  title: string;
  url: string;
  published_at: string;
  sector: string | null;
  geography: string | null;
  deal_type: string | null;
}

interface DealSource {
  news_item_id: string;
  source_id: string;
  external_id: string;
  url: string;
  title: string;
  summary: string | null;
  published_at: string;
}

interface DealWithSources {
  deal: Deal;
  sources: DealSource[];
}

function buildQuery(f: Filters, limit = 100): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  p.set('limit', String(limit));
  return p.toString();
}

function formatSize(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
}

function labelize(s: string | null): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').toUpperCase();
}

// ────────────────────────────────────────────────────────────────────────────

export default function Terminal({ authEnabled = false }: { authEnabled?: boolean }) {
  const [tab, setTab] = useState<Tab>('deals');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [news,  setNews]  = useState<NewsItem[]>([]);
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [totalDeals, setTotalDeals] = useState(0);
  const [totalNews,  setTotalNews]  = useState(0);
  const [totalSources, setTotalSources] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // AbortController ensures a slow in-flight fetch doesn't overwrite the
  // results of a newer one after the user changes filters.
  const inflight = useRef<AbortController | null>(null);

  // Live push indicator — pulses briefly each time the WebSocket pushes a
  // new_deal that matches the current filter. Purely visual; the actual row
  // insertion is driven by a refresh triggered from the ws handler below.
  const [liveTick, setLiveTick] = useState(0);

  // Detail drawer state — null when closed, a deal id when open. The drawer
  // fetches /api/deals/[id] on its own; we just hold the selection here.
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);

  // Help overlay toggle (shown when the user presses '?').
  const [showHelp, setShowHelp] = useState(false);

  // Imperative handles for keyboard shortcuts.
  const firstFilterRef = useRef<HTMLSelectElement | null>(null);

  const fetchAll = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const qs = buildQuery(filters);
      const [dealsRes, newsRes, sourcesRes, statsRes] = await Promise.all([
        fetch(`/api/deals?${qs}`,  { signal: ctrl.signal, cache: 'no-store' }),
        fetch(`/api/news?${qs}`,   { signal: ctrl.signal, cache: 'no-store' }),
        fetch(`/api/sources`,      { signal: ctrl.signal, cache: 'no-store' }),
        fetch(`/api/stats`,        { signal: ctrl.signal, cache: 'no-store' }),
      ]);
      if (!dealsRes.ok) {
        setError(((await dealsRes.json()) as { error?: string }).error ?? `deals ${dealsRes.status}`);
        return;
      }
      if (!newsRes.ok) {
        setError(((await newsRes.json()) as { error?: string }).error ?? `news ${newsRes.status}`);
        return;
      }
      const dealsJson   = (await dealsRes.json())   as { deals: Deal[]; total: number };
      const newsJson    = (await newsRes.json())    as { news: NewsItem[]; total: number };
      const sourcesJson = sourcesRes.ok
        ? (await sourcesRes.json()) as { sources: SourceHealth[]; total: number }
        : { sources: [], total: 0 };
      const statsJson = statsRes.ok ? (await statsRes.json()) as DashboardStats : null;
      setDeals(dealsJson.deals);
      setNews(newsJson.news);
      setSources(sourcesJson.sources);
      setStats(statsJson);
      setTotalDeals(dealsJson.total);
      setTotalNews(newsJson.total);
      setTotalSources(sourcesJson.total);
      setLastRefresh(new Date());
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // Fetch on mount, on filter change, and every 30s as a fallback.
  useEffect(() => { void fetchAll(); }, [fetchAll]);
  useEffect(() => {
    const id = setInterval(() => { void fetchAll(); }, 30_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // WebSocket push — connects once per mount, reconnects with backoff on
  // close. When a new_deal frame arrives we pulse the indicator and trigger
  // a fetch so the table reflects the new row (and respects the active
  // filter server-side rather than us shipping filter logic to the client).
  //
  // Auth: the WS server runs on a different port than Next.js, so the
  // session cookie can't be sent across the origin boundary. We fetch a
  // short ticket from a same-origin endpoint (which IS gated by middleware)
  // and pass it as a ?token= query param on the upgrade.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const port = process.env.NEXT_PUBLIC_WS_PORT ?? '3030';
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = async () => {
      if (closed) return;
      let token = '';
      try {
        const res = await fetch('/api/auth/ws-ticket', { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as { ticket?: string };
          token = body.ticket ?? '';
        }
      } catch { /* network — fall through with empty token */ }
      if (closed) return;
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      const url = `${scheme}://${window.location.hostname}:${port}/ws/deals${qs}`;
      ws = new WebSocket(url);
      ws.onopen = () => { retry = 0; };
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(ev.data as string) as { type?: string };
          if (frame.type === 'new_deal') {
            setLiveTick((t) => t + 1);
            void fetchAll();
          }
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        if (closed) return;
        const delay = Math.min(30_000, 500 * 2 ** retry++);
        timer = setTimeout(() => { void connect(); }, delay);
      };
      ws.onerror = () => { ws?.close(); };
    };
    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [fetchAll]);

  // Keyboard shortcuts (Bloomberg-style quick keys). Only fires when the user
  // isn't typing into a form control — that's the critical UX invariant here.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape') {
        if (showHelp) setShowHelp(false);
        else if (selectedDealId) setSelectedDealId(null);
        else if (isEditable) (target as HTMLElement).blur();
        return;
      }
      if (isEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'd': setTab('deals'); break;
        case 'n': setTab('news'); break;
        case 's': setTab('sources'); break;
        case 'f': firstFilterRef.current?.focus(); e.preventDefault(); break;
        case 'c': setFilters(EMPTY_FILTERS); break;
        case 'r': void fetchAll(); break;
        case '?': setShowHelp((s) => !s); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showHelp, selectedDealId, fetchAll]);

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((v) => v !== '').length,
    [filters]
  );

  const degradedSources = useMemo(
    () => sources.filter((s) => s.enabled && (s.is_stale || s.last_error)).length,
    [sources]
  );

  return (
    <div className="min-h-screen flex flex-col">
      <Header lastRefresh={lastRefresh} loading={loading} liveTick={liveTick} />

      <FilterBar
        filters={filters}
        onChange={(next) => setFilters(next)}
        onClear={() => setFilters(EMPTY_FILTERS)}
        activeCount={activeFilterCount}
        firstFilterRef={firstFilterRef}
        tab={tab}
      />

      <StatsStrip stats={stats} />

      <nav className="flex border-b border-grid bg-surface">
        <TabButton active={tab === 'deals'}   onClick={() => setTab('deals')}   label="DEALS"   count={totalDeals} />
        <TabButton active={tab === 'news'}    onClick={() => setTab('news')}    label="NEWS"    count={totalNews} />
        <TabButton active={tab === 'sources'} onClick={() => setTab('sources')} label="SOURCES" count={totalSources} degraded={degradedSources} />
        {error && (
          <div data-testid="error" className="ml-auto px-4 py-2 text-[11px] text-neg">
            ERR {error}
          </div>
        )}
      </nav>

      <main className="flex-1 overflow-auto">
        {tab === 'deals'   && <DealsTable rows={deals} onSelect={setSelectedDealId} />}
        {tab === 'news'    && <NewsTable rows={news} />}
        {tab === 'sources' && <SourcesTable rows={sources} />}
      </main>

      <footer className="border-t border-grid bg-surface px-3 py-1.5 text-[10px] text-fg-mute flex justify-between">
        <span>SAFYR CAPITAL PARTNERS · PHASE 1 · PUBLIC DATA ONLY — contact data via licensed provider in Phase 2</span>
        <span className="flex gap-3 items-center">
          <button onClick={() => setShowHelp(true)} className="hover:text-amber" type="button">?</button>
          {authEnabled && (
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST', cache: 'no-store' });
                window.location.replace('/login');
              }}
              className="hover:text-amber"
              data-testid="logout"
            >
              SIGN OUT
            </button>
          )}
          <span>v0.1</span>
        </span>
      </footer>

      {selectedDealId && (
        <DealDrawer dealId={selectedDealId} onClose={() => setSelectedDealId(null)} />
      )}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function Header({ lastRefresh, loading, liveTick }: { lastRefresh: Date; loading: boolean; liveTick: number }) {
  const [now, setNow] = useState<Date | null>(null);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // Flash the PUSH indicator for 400ms on every new_deal frame.
  useEffect(() => {
    if (liveTick === 0) return;
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 400);
    return () => clearTimeout(id);
  }, [liveTick]);
  return (
    <header className="flex items-center justify-between border-b border-grid-strong bg-surface px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="text-amber font-bold tracking-wider">SAFYR</span>
        <span className="text-fg-dim text-[11px]">DEAL TERMINAL</span>
      </div>
      <div className="flex items-center gap-4 text-[11px] text-fg-dim">
        <span className={pulse ? 'text-amber' : 'text-fg-mute'} data-testid="push-indicator">
          {pulse ? '◆ PUSH' : '◇ ws'}
          {liveTick > 0 && <span className="text-fg-mute ml-1">[{liveTick}]</span>}
        </span>
        <span className={loading ? 'text-info' : 'text-pos'}>
          {loading ? '● SYNC' : '● LIVE'}
        </span>
        <span suppressHydrationWarning>
          LAST {lastRefresh.toISOString().slice(11, 19)}Z
        </span>
        <span suppressHydrationWarning>
          UTC {now ? now.toISOString().slice(11, 19) : '--:--:--'}
        </span>
      </div>
    </header>
  );
}

function TabButton({
  active, onClick, label, count, degraded,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  degraded?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-4 py-2 text-[11px] tracking-wider border-r border-grid',
        active ? 'bg-surface-2 text-amber' : 'text-fg-dim hover:text-fg',
      ].join(' ')}
    >
      {label} <span className="text-fg-mute ml-1">[{count}]</span>
      {degraded !== undefined && degraded > 0 && (
        <span className="ml-2 text-neg" title={`${degraded} source(s) stale or errored`}>
          ● {degraded}
        </span>
      )}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function FilterBar({
  filters, onChange, onClear, activeCount, firstFilterRef, tab,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  onClear: () => void;
  activeCount: number;
  firstFilterRef: React.RefObject<HTMLSelectElement | null>;
  tab: Tab;
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...filters, [k]: v });

  // Build an export URL carrying the current filter set. The browser handles
  // the download via Content-Disposition; no JS fetch required.
  const exportHref = (() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    p.set('format', 'csv');
    return `/api/${tab}?${p.toString()}`;
  })();

  return (
    <section
      data-testid="filter-bar"
      className="flex flex-wrap items-center gap-2 border-b border-grid bg-surface px-3 py-2 text-[11px]"
    >
      <FilterSelect label="SECTOR"    value={filters.sector}    onChange={(v) => set('sector', v)}    options={SECTORS}     selectRef={firstFilterRef} />
      <FilterSelect label="GEO"       value={filters.geography} onChange={(v) => set('geography', v)} options={GEOGRAPHIES} />
      <FilterSelect label="DEAL TYPE" value={filters.deal_type} onChange={(v) => set('deal_type', v)} options={DEAL_TYPES}  />

      <FilterInput label="SIZE MIN $" value={filters.min_size} onChange={(v) => set('min_size', v)} placeholder="0"       width={20} />
      <FilterInput label="SIZE MAX $" value={filters.max_size} onChange={(v) => set('max_size', v)} placeholder="∞"       width={20} />
      <FilterInput label="FROM"       value={filters.from}     onChange={(v) => set('from', v)}     placeholder="YYYY-MM-DD" type="date" />
      <FilterInput label="TO"         value={filters.to}       onChange={(v) => set('to', v)}       placeholder="YYYY-MM-DD" type="date" />

      <div className="ml-auto flex items-center gap-2">
        <a
          href={exportHref}
          download
          className="px-2 py-1 border border-grid text-fg-dim hover:text-amber hover:border-amber"
          title={`Export current ${tab} filter as CSV`}
          data-testid="export-csv"
        >
          EXPORT CSV
        </a>
        <button
          type="button"
          onClick={onClear}
          disabled={activeCount === 0}
          className="px-2 py-1 border border-grid text-fg-dim hover:text-amber hover:border-amber disabled:opacity-30 disabled:cursor-not-allowed"
        >
          CLEAR{activeCount > 0 ? ` [${activeCount}]` : ''}
        </button>
      </div>
    </section>
  );
}

function FilterSelect({
  label, value, onChange, options, selectRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  selectRef?: React.RefObject<HTMLSelectElement | null>;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-fg-mute">{label}</span>
      <select
        ref={selectRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-grid px-1.5 py-0.5 text-fg min-w-[9ch] focus:outline-none focus:border-amber"
      >
        <option value="">ALL</option>
        {options.map((o) => <option key={o} value={o}>{labelize(o)}</option>)}
      </select>
    </label>
  );
}

function FilterInput({
  label, value, onChange, placeholder, type = 'text', width,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  width?: number;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-fg-mute">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="border border-grid px-1.5 py-0.5 text-fg focus:outline-none focus:border-amber"
        style={width ? { width: `${width}ch` } : undefined}
      />
    </label>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function DealsTable({ rows, onSelect }: { rows: Deal[]; onSelect: (id: string) => void }) {
  if (rows.length === 0) return <EmptyState message="No deals match the current filters." />;
  return (
    <table data-testid="deals-table" className="w-full text-[11px]">
      <thead className="sticky top-0 bg-surface border-b border-grid-strong">
        <tr className="text-fg-mute">
          <Th className="w-[12ch]">DATE</Th>
          <Th>HEADLINE</Th>
          <Th className="w-[14ch]">SECTOR</Th>
          <Th className="w-[18ch]">GEO</Th>
          <Th className="w-[14ch]">TYPE</Th>
          <Th className="w-[10ch] text-right">SIZE</Th>
          <Th className="w-[12ch]">SOURCE</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr
            key={d.id}
            onClick={() => onSelect(d.id)}
            className="border-b border-grid hover:bg-surface-2 cursor-pointer"
          >
            <Td className="text-fg-dim">{formatDate(d.announced_at)}</Td>
            <Td>
              <span className="text-fg">{d.headline}</span>
              {d.primary_url && (
                <a
                  href={d.primary_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="ml-2 text-fg-mute hover:text-amber"
                  aria-label="open primary source"
                >↗</a>
              )}
            </Td>
            <Td className="text-info">{labelize(d.sector)}</Td>
            <Td className="text-fg-dim">{labelize(d.geography)}</Td>
            <Td className="text-amber">{labelize(d.deal_type)}</Td>
            <Td className="text-right text-pos">{formatSize(d.deal_size_usd)}</Td>
            <Td className="text-fg-mute">{(d.primary_source_id ?? '—').toUpperCase()}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NewsTable({ rows }: { rows: NewsItem[] }) {
  if (rows.length === 0) return <EmptyState message="No news items match the current filters." />;
  return (
    <table data-testid="news-table" className="w-full text-[11px]">
      <thead className="sticky top-0 bg-surface border-b border-grid-strong">
        <tr className="text-fg-mute">
          <Th className="w-[12ch]">DATE</Th>
          <Th>TITLE</Th>
          <Th className="w-[14ch]">SECTOR</Th>
          <Th className="w-[18ch]">GEO</Th>
          <Th className="w-[14ch]">TYPE</Th>
          <Th className="w-[12ch]">SOURCE</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((n) => (
          <tr key={n.id} className="border-b border-grid hover:bg-surface-2">
            <Td className="text-fg-dim">{formatDate(n.published_at)}</Td>
            <Td>
              <a href={n.url} target="_blank" rel="noreferrer" className="text-fg hover:text-amber">
                {n.title}
              </a>
            </Td>
            <Td className="text-info">{labelize(n.sector)}</Td>
            <Td className="text-fg-dim">{labelize(n.geography)}</Td>
            <Td className="text-amber">{labelize(n.deal_type)}</Td>
            <Td className="text-fg-mute">{n.source_id.toUpperCase()}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-64 text-fg-mute text-[11px]">
      {message}
    </div>
  );
}

function SourcesTable({ rows }: { rows: SourceHealth[] }) {
  if (rows.length === 0) return <EmptyState message="No sources registered." />;
  return (
    <table data-testid="sources-table" className="w-full text-[11px]">
      <thead className="sticky top-0 bg-surface border-b border-grid-strong">
        <tr className="text-fg-mute">
          <Th className="w-[3ch]">●</Th>
          <Th className="w-[18ch]">SOURCE</Th>
          <Th>NAME</Th>
          <Th className="w-[14ch]">KIND</Th>
          <Th className="w-[14ch]">LAST POLL</Th>
          <Th className="w-[10ch] text-right">24H</Th>
          <Th className="w-[10ch] text-right">TOTAL</Th>
          <Th>LAST ERROR</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const status = !s.enabled ? 'OFF'
            : s.last_error    ? 'ERR'
            : s.is_stale      ? 'STALE'
            : 'OK';
          const statusColor =
            status === 'OFF'   ? 'text-fg-mute' :
            status === 'OK'    ? 'text-pos'     :
            status === 'STALE' ? 'text-amber'   :
                                 'text-neg';
          return (
            <tr key={s.id} className="border-b border-grid hover:bg-surface-2">
              <Td className={statusColor} title={status}>●</Td>
              <Td className="text-fg">{s.id}</Td>
              <Td className="text-fg-dim">{s.display_name}</Td>
              <Td className="text-info">{s.kind.toUpperCase()}</Td>
              <Td className="text-fg-dim">
                {s.last_polled_at ? formatRelative(s.last_polled_at) : '—'}
              </Td>
              <Td className="text-right text-pos">{s.items_24h.toLocaleString()}</Td>
              <Td className="text-right text-fg-dim">{s.items_total.toLocaleString()}</Td>
              <Td className="text-neg truncate max-w-[40ch]" title={s.last_error ?? undefined}>
                {s.last_error ?? ''}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatsStrip({ stats }: { stats: DashboardStats | null }) {
  // Bloomberg-style ticker. Falls back to em-dashes while stats load so the
  // strip occupies its space immediately and the layout doesn't jump.
  return (
    <section
      data-testid="stats-strip"
      className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-grid bg-surface px-3 py-1.5 text-[10px] tracking-wider"
    >
      <Stat label="DEALS 24H" value={stats ? stats.deals_24h.toLocaleString() : '—'} tone="amber" />
      <Stat label="VOL 24H"   value={stats ? formatVolume(stats.volume_24h_usd)  : '—'} tone="pos"   />
      <Stat label="DEALS 7D"  value={stats ? stats.deals_7d.toLocaleString()     : '—'} />
      <Stat label="VOL 7D"    value={stats ? formatVolume(stats.volume_7d_usd)   : '—'} />
      <Stat
        label="TOP SECTOR 24H"
        value={stats?.top_sector_24h
          ? `${labelize(stats.top_sector_24h.sector)} (${stats.top_sector_24h.count})`
          : '—'}
        tone="info"
      />
      <Stat
        label="TOP GEO 24H"
        value={stats?.top_geography_24h
          ? `${labelize(stats.top_geography_24h.geography)} (${stats.top_geography_24h.count})`
          : '—'}
      />
      <Stat label="NEWS 24H" value={stats ? stats.news_24h.toLocaleString() : '—'} />
      <Stat
        label="UNCLASSIFIED"
        value={stats ? stats.unclassified_pending.toLocaleString() : '—'}
        tone={stats && stats.unclassified_pending > 0 ? 'amber' : undefined}
      />
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'pos' | 'info' }) {
  const cls = tone === 'amber' ? 'text-amber'
    : tone === 'pos' ? 'text-pos'
    : tone === 'info' ? 'text-info'
    : 'text-fg';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-fg-mute">{label}</span>
      <span className={cls}>{value}</span>
    </span>
  );
}

function formatVolume(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)        return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000)     return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-1.5 text-left font-normal tracking-wider ${className}`}>{children}</th>;
}
function Td({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={`px-3 py-1.5 align-top ${className}`} title={title}>{children}</td>;
}

// ────────────────────────────────────────────────────────────────────────────

function DealDrawer({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const [data, setData]   = useState<DealWithSources | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/deals/${dealId}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<DealWithSources>;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [dealId]);

  return (
    <div
      data-testid="deal-drawer"
      className="fixed inset-0 z-40 flex"
      onClick={onClose}
    >
      <div className="flex-1 bg-black/40" />
      <aside
        className="w-[560px] max-w-full bg-surface border-l border-grid-strong flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-grid px-3 py-2 text-[11px]">
          <span className="text-fg-mute tracking-wider">DEAL DETAIL</span>
          <button type="button" onClick={onClose} className="text-fg-dim hover:text-amber" aria-label="close">
            [ESC] ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3 text-[11px]">
          {error && <div className="text-neg">ERR {error}</div>}
          {!error && !data && <div className="text-fg-mute">Loading…</div>}
          {data && (
            <>
              <h2 className="text-fg text-[13px] leading-snug mb-3">{data.deal.headline}</h2>
              <dl className="grid grid-cols-[10ch_1fr] gap-y-1 mb-4">
                <dt className="text-fg-mute">DATE</dt>       <dd className="text-fg-dim">{formatDate(data.deal.announced_at)}</dd>
                <dt className="text-fg-mute">SECTOR</dt>     <dd className="text-info">{labelize(data.deal.sector)}</dd>
                <dt className="text-fg-mute">GEO</dt>        <dd>{labelize(data.deal.geography)}</dd>
                <dt className="text-fg-mute">TYPE</dt>       <dd className="text-amber">{labelize(data.deal.deal_type)}</dd>
                <dt className="text-fg-mute">SIZE</dt>       <dd className="text-pos">{formatSize(data.deal.deal_size_usd)}</dd>
                <dt className="text-fg-mute">STATUS</dt>     <dd>{data.deal.status.toUpperCase()}</dd>
                <dt className="text-fg-mute">SOURCE</dt>
                <dd>
                  {(data.deal.primary_source_id ?? '—').toUpperCase()}
                  {data.deal.primary_url && (
                    <a href={data.deal.primary_url} target="_blank" rel="noreferrer" className="ml-2 text-fg-mute hover:text-amber">↗</a>
                  )}
                </dd>
              </dl>

              <div className="text-fg-mute tracking-wider mb-1.5">
                SOURCES <span className="text-fg-mute">[{data.sources.length}]</span>
              </div>
              <ul className="space-y-2">
                {data.sources.map((s) => (
                  <li key={s.news_item_id} className="border-l border-grid pl-2">
                    <a href={s.url} target="_blank" rel="noreferrer" className="text-fg hover:text-amber">
                      {s.title}
                    </a>
                    <div className="text-fg-mute text-[10px] mt-0.5">
                      {s.source_id.toUpperCase()} · {formatDate(s.published_at)}
                    </div>
                    {s.summary && <div className="text-fg-dim mt-1 line-clamp-3">{s.summary}</div>}
                  </li>
                ))}
              </ul>

              <div className="border-t border-grid mt-5 pt-3 text-[10px] text-fg-mute">
                Contact data for decision-makers at the target / acquirer is not
                shown: Phase 1 ingests public deal data only. Contact enrichment
                is Phase 2 and will be sourced from Apollo.io (licensed provider).
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['D',   'Switch to DEALS tab'],
    ['N',   'Switch to NEWS tab'],
    ['S',   'Switch to SOURCES tab'],
    ['F',   'Focus filter bar (sector)'],
    ['C',   'Clear all filters'],
    ['R',   'Refresh now'],
    ['ESC', 'Close drawer / help / blur input'],
    ['?',   'Toggle this help'],
    ['Click row', 'Open deal detail drawer'],
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 text-[11px]"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-grid-strong p-4 min-w-[340px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-fg-mute tracking-wider">KEYBOARD SHORTCUTS</span>
          <button type="button" onClick={onClose} className="text-fg-dim hover:text-amber">✕</button>
        </div>
        <table className="text-[11px]">
          <tbody>
            {rows.map(([key, desc]) => (
              <tr key={key}>
                <td className="text-amber pr-4 py-0.5 font-bold">{key}</td>
                <td className="text-fg-dim py-0.5">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
