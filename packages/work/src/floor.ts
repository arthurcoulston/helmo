/* The release floor: the numbers, and the reading of one served document
 * against them. It ships rather than sitting in the test folder because two
 * things run it — `test/view-release-floor.test.ts` against a seeded record
 * at declared capacity, and `scripts/live-floor.mjs` against a deployed
 * service holding a real one (H-202).
 *
 * A budget measured on a record smaller than the real one is not a budget. The
 * first version of these checks asserted 300,000 bytes on an 80-row seed of
 * one-line tickets while the record it shipped against served 2,718,021 bytes
 * — nine times the ceiling, and the ship passed. Every number below is
 * measured, and the measurement it came from is written beside it.
 */

/** The deployed Good Plumb record, measured 2026-09-29 on the service at
 *  localhost:4420 and in a `.backup` copy of its store. This is the thing the
 *  budget has to be appropriate to. */
export const REAL_RECORD = {
  measured: '2026-09-29',
  tickets: 207,
  /** Rows the current record draws: live work plus the closed tail. */
  currentRows: 79,
  /** title + body + evidence JSON over every ticket in the store. */
  storedTextBytes: 1_256_513,
  averageBodyBytes: 3_958,
  longestBodyBytes: 37_308,
  mostEvidenceItems: 118,
  /** The longest run of non-space characters the page draws: a workspace
   *  path. */
  longestUnbrokenToken: 128,
  /** The longest run with no break opportunity in it at all — a 64-character
   *  digest, and there are 220 runs over 30 characters on the record. This is
   *  the number that matters and the one easy to get wrong: a browser breaks
   *  a long path after its slashes whatever the CSS says, so a fixture full
   *  of paths lays out fine with `overflow-wrap: anywhere` deleted. A digest
   *  has nowhere to break, needs about 450px to draw, and is given a 290px
   *  card on a phone. */
  longestUnbreakableRun: 64,
  /** Bytes on the wire, warm: `/`, `/?whole=1`, `/?section=awaiting`. */
  documentBytes: { current: 838_498, whole: 2_718_020, section: 136_548 },
  /** Bytes per row drawn, the scale-invariant reading of the same fetch. */
  bytesPerRow: { current: 10_613, whole: 13_130 },
} as const;

/** What the page is built to hold. The seed in `served-record.ts` is built to
 *  this profile and asserts it exceeds REAL_RECORD before anything is timed,
 *  so the budget is measured above the record it protects, never below it. */
export const CAPACITY = {
  rows: 240,
  /** Checked, not claimed: see `seedCapacityRecord`'s return value. */
  minimumStoredTextBytes: REAL_RECORD.storedTextBytes,
} as const;

export const FLOOR = {
  /* Measured as warm render CPU time, three runs, on the capacity seed: current record
     1,706,985 bytes / 146 rows / 100ms, whole record 3,836,822 / 246 / 137ms,
     embedded section 53,698 / 4 / 25ms. The deployed record, measured
     2026-09-29: 838,498 / 79 / 85ms, 2,718,020 / 207 / 128ms, 136,548 / 2 /
     15ms. Five consecutive isolated capacity runs on 2026-10-01 bounded the
     current view at 91–100ms and the whole record at 133–137ms; a release run
     on the same candidate saw a single 485ms current-view sample under host
     contention.

     The time budget is four times the slowest of those. It is not tighter
     because a laptop under load is several times slower than an idle one and
     a flaky floor check is worse than none; it is not looser because the
     regression worth catching has to fail it, and one extra store-wide query
     per row — the shape a render turns quadratic in — takes the whole record
     to roughly 3s. The byte budgets are deterministic and sit 20% above the
     capacity measurement. */
  RENDER_MS: 600,

  /* Per served document, at declared capacity. The whole record at 244 rows
     of real-sized bodies and evidence is the largest document Helmo draws. */
  DOCUMENT_BYTES: 4_200_000,

  /* The scale-invariant half of the same budget, and the one that still means
     something when the record grows past capacity: what one row costs on a
     document long enough for the fixed chrome (sprite, tokens, stylesheet,
     script) to stop dominating. Under this, the ceiling above is mostly
     arithmetic; over it, the row renderer has started drawing something it
     did not draw before. */
  BYTES_PER_ROW: 18_000,
  /** Below this many rows a document is mostly chrome and per-row says nothing. */
  BYTES_PER_ROW_MIN_ROWS: 40,
} as const;

/** Rows the document actually drew. Every row shape — question card, sitting,
 *  work in motion, closed row — carries the ticket id as the element id, and
 *  the floor's own uniqueness check is what keeps that countable. */
export function rowsDrawn(html: string): number {
  return new Set([...html.matchAll(/\bid="(H-\d+)"/g)].map((m) => m[1]!)).size;
}

/** The ceiling one document is allowed, given what it drew. Used by the test
 *  at capacity and by `scripts/live-floor.mjs` against the deployed record. */
export function overBudget(doc: { bytes: number; ms: number; rows: number }, floor: typeof FLOOR = FLOOR): string[] {
  const failures: string[] = [];
  if (doc.ms >= floor.RENDER_MS) failures.push(`took ${doc.ms.toFixed(0)}ms, budget ${floor.RENDER_MS}ms`);
  if (doc.bytes >= floor.DOCUMENT_BYTES) failures.push(`is ${doc.bytes} bytes, budget ${floor.DOCUMENT_BYTES}`);
  if (doc.rows >= floor.BYTES_PER_ROW_MIN_ROWS) {
    const perRow = doc.bytes / doc.rows;
    if (perRow >= floor.BYTES_PER_ROW)
      failures.push(`costs ${perRow.toFixed(0)} bytes per row over ${doc.rows} rows, budget ${floor.BYTES_PER_ROW}`);
  }
  return failures;
}

/** CPU time spent rendering, reported by the view process through the
 * standard Server-Timing header. Timing the parent process's fetch instead
 * makes unrelated host contention look like render work when the child is
 * descheduled between accepting the request and sending its response. */
export function renderMs(headers: { get(name: string): string | null }): number {
  const timing = headers.get('server-timing') ?? '';
  const match = timing.match(/(?:^|,)\s*helmo-render;dur=([0-9]+(?:\.[0-9]+)?)(?:\s*(?:,|$))/);
  const ms = Number(match?.[1]);
  if (!Number.isFinite(ms)) throw new Error('response carries no valid helmo-render Server-Timing value');
  return ms;
}

// ---------- reading the served document ----------

export type Element = { name: string; attrs: Record<string, string>; end: number };

/** Script and style bodies are cut before anything is scanned: both are
 *  program text, and a `<` inside either is not markup. */
export function markupOf(html: string): string {
  return html
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
    .replace(/<!--[\s\S]*?-->/g, '');
}

export function elements(markup: string): Element[] {
  const found: Element[] = [];
  const tag = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  for (let m = tag.exec(markup); m; m = tag.exec(markup)) {
    const attrs: Record<string, string> = {};
    const attr = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
    for (let a = attr.exec(m[2] ?? ''); a; a = attr.exec(m[2] ?? '')) {
      attrs[a[1]!.toLowerCase()] = (a[2] ?? '').replace(/^["']|["']$/g, '');
    }
    found.push({ name: m[1]!.toLowerCase(), attrs, end: m.index + m[0].length });
  }
  return found;
}

export const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** The text a reader — or a screen reader with no better label — gets from an
 *  element. Anchors, buttons and summaries do not nest inside themselves, so
 *  the first matching close tag is the right one. */
export function textOf(markup: string, el: Element): string {
  const close = markup.indexOf(`</${el.name}>`, el.end);
  const inner = close === -1 ? '' : markup.slice(el.end, close);
  return decode(inner.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
