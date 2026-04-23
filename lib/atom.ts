// Tiny Atom parser — just enough for EDGAR and a handful of RSS/Atom feeds.
// Hand-rolled to avoid pulling in an XML dependency for the ~5 fields we need.

export interface AtomEntry {
  id: string;
  title: string;
  link: string;
  summary?: string;
  updated?: string;
  published?: string;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);
}

function stripCData(s: string): string {
  const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : s;
}

function tagText(entry: string, tag: string): string | undefined {
  // Matches the first <tag>…</tag> — Atom entries are small so this is fine.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = entry.match(re);
  if (!m) return undefined;
  return decodeEntities(stripCData(m[1].trim()));
}

function linkHref(entry: string): string | undefined {
  // Atom: <link href="..." />. Fallback to <link>…</link> for RSS-style feeds.
  const m = entry.match(/<link\b[^>]*\bhref="([^"]+)"/i);
  if (m) return m[1];
  return tagText(entry, 'link');
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
