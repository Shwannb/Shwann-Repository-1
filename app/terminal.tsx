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

type Tab = 'deals' | 'news';

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

export default function Terminal() {
  const [tab, setTab] = useState<Tab>('deals');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [news,  setNews]  = useState<NewsItem[]>([]);
  const [totalDeals, setTotalDeals] = useState(0);
  const [totalNews,  setTotalNews]  = useState(0);
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

  const fetchAll = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const qs = buildQuery(filters);
      const [dealsRes, newsRes] = await Promise.all([
        fetch(`/api/deals?${qs}`,  { signal: ctrl.signal, cache: 'no-store' }),
        fetch(`/api/news?${qs}`,   { signal: ctrl.signal, cache: 'no-store' }),
      ]);
      if (!dealsRes.ok) {
        setError(((await dealsRes.json()) as { error?: string }).error ?? `deals ${dealsRes.status}`);
        return;
      }
      if (!newsRes.ok) {
        setError(((await newsRes.json()) as { error?: string }).error ?? `news ${newsRes.status}`);
        return;
      }
      const dealsJson = (await dealsRes.json()) as { deals: Deal[]; total: number };
      const newsJson  = (await newsRes.json())  as { news: NewsItem[]; total: number };
      setDeals(dealsJson.deals);
      setNews(newsJson.news);
      setTotalDeals(dealsJson.total);
      setTotalNews(newsJson.total);
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
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const port = process.env.NEXT_PUBLIC_WS_PORT ?? '3030';
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${window.location.hostname}:${port}/ws/deals`;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
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
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => { ws?.close(); };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [fetchAll]);

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((v) => v !== '').length,
    [filters]
  );

  return (
    <div className="min-h-screen flex flex-col">
      <Header lastRefresh={lastRefresh} loading={loading} liveTick={liveTick} />

      <FilterBar
        filters={filters}
        onChange={(next) => setFilters(next)}
        onClear={() => setFilters(EMPTY_FILTERS)}
        activeCount={activeFilterCount}
      />

      <nav className="flex border-b border-grid bg-surface">
        <TabButton active={tab === 'deals'} onClick={() => setTab('deals')} label="DEALS" count={totalDeals} />
        <TabButton active={tab === 'news'}  onClick={() => setTab('news')}  label="NEWS"  count={totalNews} />
        {error && (
          <div data-testid="error" className="ml-auto px-4 py-2 text-[11px] text-neg">
            ERR {error}
          </div>
        )}
      </nav>

      <main className="flex-1 overflow-auto">
        {tab === 'deals' ? <DealsTable rows={deals} /> : <NewsTable rows={news} />}
      </main>

      <footer className="border-t border-grid bg-surface px-3 py-1.5 text-[10px] text-fg-mute flex justify-between">
        <span>SAFYR CAPITAL PARTNERS · PHASE 1 · PUBLIC DATA ONLY — contact data via licensed provider in Phase 2</span>
        <span>v0.1</span>
      </footer>
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

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
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
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function FilterBar({
  filters, onChange, onClear, activeCount,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  onClear: () => void;
  activeCount: number;
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...filters, [k]: v });

  return (
    <section
      data-testid="filter-bar"
      className="flex flex-wrap items-center gap-2 border-b border-grid bg-surface px-3 py-2 text-[11px]"
    >
      <FilterSelect label="SECTOR"    value={filters.sector}    onChange={(v) => set('sector', v)}    options={SECTORS}     />
      <FilterSelect label="GEO"       value={filters.geography} onChange={(v) => set('geography', v)} options={GEOGRAPHIES} />
      <FilterSelect label="DEAL TYPE" value={filters.deal_type} onChange={(v) => set('deal_type', v)} options={DEAL_TYPES}  />

      <FilterInput label="SIZE MIN $" value={filters.min_size} onChange={(v) => set('min_size', v)} placeholder="0"       width={20} />
      <FilterInput label="SIZE MAX $" value={filters.max_size} onChange={(v) => set('max_size', v)} placeholder="∞"       width={20} />
      <FilterInput label="FROM"       value={filters.from}     onChange={(v) => set('from', v)}     placeholder="YYYY-MM-DD" type="date" />
      <FilterInput label="TO"         value={filters.to}       onChange={(v) => set('to', v)}       placeholder="YYYY-MM-DD" type="date" />

      <button
        type="button"
        onClick={onClear}
        disabled={activeCount === 0}
        className="ml-auto px-2 py-1 border border-grid text-fg-dim hover:text-amber hover:border-amber disabled:opacity-30 disabled:cursor-not-allowed"
      >
        CLEAR{activeCount > 0 ? ` [${activeCount}]` : ''}
      </button>
    </section>
  );
}

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-fg-mute">{label}</span>
      <select
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

function DealsTable({ rows }: { rows: Deal[] }) {
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
          <tr key={d.id} className="border-b border-grid hover:bg-surface-2">
            <Td className="text-fg-dim">{formatDate(d.announced_at)}</Td>
            <Td>
              {d.primary_url
                ? <a href={d.primary_url} target="_blank" rel="noreferrer" className="text-fg hover:text-amber">{d.headline}</a>
                : <span>{d.headline}</span>}
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

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-1.5 text-left font-normal tracking-wider ${className}`}>{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-1.5 align-top ${className}`}>{children}</td>;
}
