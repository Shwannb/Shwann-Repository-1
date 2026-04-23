// Feed parser — handles both Atom (EDGAR, some outlets) and RSS 2.0 (most
// news feeds). Hand-rolled to avoid an XML dependency for the 5-6 fields we
// actually care about per item.
//
// The edgar worker imports parseAtom directly; new sources use parseFeed,
// which auto-detects the flavor and returns a unified FeedItem[].

export interface AtomEntry {
  id: string;
  title: string;
  link: string;
  summary?: string;
  updated?: string;
  published?: string;
}

export interface FeedItem {
  externalId: string;    // guid / id / link hash — whatever is stable per feed
  title: string;
  link: string;
  summary?: string;
  publishedAt: Date;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripCData(s: string): string {
  const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : s;
}

function tagText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return undefined;
  return decodeEntities(stripCData(m[1].trim()));
}

function linkHref(block: string): string | undefined {
  // Atom: <link href="..."/>. RSS 2.0: <link>...</link>.
  const m = block.match(/<link\b[^>]*\bhref="([^"]+)"/i);
  if (m) return m[1];
  return tagText(block, 'link');
}

export function parseAtom(xml: string): AtomEntry[] {
  const entries: AtomEntry[] = [];
  const re = /<entry\b[\s\S]*?<\/entry>/gi;
  for (const match of xml.matchAll(re)) {
    const block = match[0];
    const id = tagText(block, 'id');
    const title = tagText(block, 'title');
    const link = linkHref(block);
    if (!id || !title || !link) continue;
    entries.push({
      id,
      title,
      link,
      summary: tagText(block, 'summary'),
      updated: tagText(block, 'updated'),
      published: tagText(block, 'published'),
    });
  }
  return entries;
}

function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  for (const match of xml.matchAll(re)) {
    const block = match[0];
    const title = tagText(block, 'title');
    const link = linkHref(block);
    if (!title || !link) continue;
    // RSS 2.0: <guid>. Fall back to the link when the feed omits it.
    const guid = tagText(block, 'guid') ?? link;
    const pub  = tagText(block, 'pubDate') ?? tagText(block, 'dc:date');
    const publishedAt = pub ? new Date(pub) : new Date();
    if (Number.isNaN(publishedAt.getTime())) continue;
    // RSS 2.0 description is often full HTML; we keep the raw text and let
    // the classifier strip tags as needed.
    const summary = tagText(block, 'description') ?? tagText(block, 'content:encoded');
    items.push({ externalId: guid, title, link, summary, publishedAt });
  }
  return items;
}

function atomToFeedItems(entries: AtomEntry[]): FeedItem[] {
  return entries
    .map<FeedItem | null>((e) => {
      const when = e.published ?? e.updated;
      const publishedAt = when ? new Date(when) : new Date();
      if (Number.isNaN(publishedAt.getTime())) return null;
      return {
        externalId: e.id,
        title: e.title,
        link: e.link,
        summary: e.summary,
        publishedAt,
      };
    })
    .filter((x): x is FeedItem => x !== null);
}

// Auto-detect RSS 2.0 vs Atom by inspecting the first root element. This is
// cheap (O(few hundred bytes)) and reliable across the feeds we've seen.
export function parseFeed(xml: string): FeedItem[] {
  const head = xml.slice(0, 500).toLowerCase();
  if (head.includes('<rss')) return parseRss(xml);
  if (head.includes('<feed')) return atomToFeedItems(parseAtom(xml));
  // Some oddball feeds omit the wrapper but still use <item> or <entry>.
  if (head.includes('<item')) return parseRss(xml);
  if (head.includes('<entry')) return atomToFeedItems(parseAtom(xml));
  return [];
}
