import { NextResponse } from 'next/server';
import { generateBriefing, claudeBriefer } from '@/lib/briefing';

export const dynamic = 'force-dynamic';

// First request in a 30-minute window calls Claude; subsequent requests serve
// the cached markdown. Errors surface as 503 with a usable JSON body so the
// terminal can render them in place rather than blanking the briefing tab.
export async function GET() {
  try {
    const result = await generateBriefing(claudeBriefer());
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        markdown: '',
        error: err instanceof Error ? err.message : String(err),
        generated_at: new Date().toISOString(),
        window_count: 0,
        cached: false,
      },
      { status: 503 }
    );
  }
}
