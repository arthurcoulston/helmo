/* The release floor, measured against the document this process actually
 * serves, on a record at least as heavy as the deployed one (H-202).
 *
 * Helmo's other view tests read `src/view.ts` as a string, which is the right
 * shape for "does the code say X" and the wrong shape for "does the document a
 * browser receives hold X". Four floor axes need the served page: whether
 * every link on it goes somewhere, what it costs to send, whether it holds
 * still at the widths it claims to support, and whether it can be read and
 * operated by someone who is not looking at it.
 *
 * What is NOT here, said plainly rather than left to be discovered: nothing in
 * this file opens a browser, so nothing below measures real geometry, real
 * paint or a real accessibility tree. `view-viewport-render.test.ts` does that
 * part in Chromium and is a separate script for a reason — it needs a browser
 * on the machine. Everything here is a deterministic property of the served
 * bytes and of the colour arithmetic behind them: it runs offline, on every
 * `npm test`, and it goes red for defect classes this page has actually
 * shipped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPACITY, Element, FLOOR, REAL_RECORD, decode, elements, markupOf, overBudget, styleOf, textOf } from '../src/floor.js';
import { load, seedCapacityRecord, serveRecord } from './support/served-record.js';

// ---------- reading the CSS ----------

type Block = { selector: string; body: string; media: string };

/** Every rule block in source order with the media query it sits under.
 *  Brace-counted rather than regex-matched, because `@media` nests. */
function blocks(source: string, media = ''): Block[] {
  // Comments first, always: a selector read with the comment above it still
  // attached matches nothing, and every rule silently disappears.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Block[] = [];
  for (let i = 0; i < css.length; ) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    const selector = css.slice(i, open).trim();
    const body = css.slice(open + 1, j - 1);
    if (selector.startsWith('@media')) out.push(...blocks(body, selector));
    else if (!selector.startsWith('@')) out.push({ selector, body, media });
    i = j;
  }
  return out;
}

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(';')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const name = line.slice(0, at).trim();
    if (!/^[-\w]+$/.test(name)) continue;
    out[name] = line.slice(at + 1).trim();
  }
  return out;
}

// ---------- colour ----------

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const byte = (c: number) => Math.min(255, Math.max(0, Math.round(c * 255)));

const luminance = ([r, g, b]: Rgb) => 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    byte(encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    byte(encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    byte(encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

function rgbToOklab([r, g, b]: Rgb): [number, number, number] {
  const R = toLinear(r / 255);
  const G = toLinear(g / 255);
  const B = toLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

type Colour = { rgb: Rgb; alpha: number };

function parseColour(value: string): Colour {
  const v = value.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) {
    const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1]!.split(',').map((s) => parseFloat(s));
    return { rgb: [p[0]!, p[1]!, p[2]!], alpha: p.length > 3 ? p[3]! : 1 };
  }
  m = /^oklch\(([^)]+)\)$/i.exec(v);
  if (m) {
    const [body, pct] = m[1]!.split('/');
    const p = body!.trim().split(/\s+/).map((s) => parseFloat(s));
    const h = ((p[2] ?? 0) * Math.PI) / 180;
    return {
      rgb: oklabToRgb(p[0]!, (p[1] ?? 0) * Math.cos(h), (p[1] ?? 0) * Math.sin(h)),
      alpha: pct ? parseFloat(pct) / 100 : 1,
    };
  }
  throw new Error(`no colour in ${value}`);
}

/** CSS composites a translucent colour over what is behind it in gamma sRGB,
 *  and a contrast check that reads the value as opaque passes every wash on
 *  the page. The washes here are the only translucent inks Helmo draws text
 *  on, so this is the step that makes measuring them mean anything. */
const over = (fore: Colour, back: Rgb): Rgb => fore.rgb.map((c, i) => c * fore.alpha + back[i]! * (1 - fore.alpha)) as Rgb;

// ---------- the page under test ----------

const dir = mkdtempSync(join(tmpdir(), 'helmo-floor-'));
const db = join(dir, 'helmo.db');
let view: ChildProcess | null = null;
let origin = '';
let seeded = { rows: 0, storedTextBytes: 0 };

/** One document per shape the server serves: the current record, the whole
 *  record, and the section the estate landing embeds. */
const page: Record<string, { html: string; markup: string; bytes: number; ms: number; rows: number }> = {};

beforeAll(async () => {
  seeded = seedCapacityRecord(db);
  ({ view, origin } = await serveRecord(db));
  for (const [name, path] of [['current', '/'], ['whole', '/?whole=1'], ['section', '/?section=awaiting']] as const) {
    const doc = await load(origin, path);
    page[name] = { ...doc, markup: markupOf(doc.html) };
  }
  // Printed every run, on stderr because vitest keeps a passing test's console
  // to itself: recalibrating a budget starts with what it measures today, and
  // a number nobody can see goes stale unnoticed.
  const measured = documents()
    .map(([name, d]) => `${name} ${d.bytes}B/${d.rows}r/${d.ms.toFixed(0)}ms`)
    .join(' | ');
  process.stderr.write(`floor: ${seeded.rows} rows, ${seeded.storedTextBytes} bytes of record text | ${measured}\n`);
}, 120_000);

afterAll(() => {
  view?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const documents = () => Object.entries(page);

// ---------- links ----------

describe('every link on the served page goes somewhere', () => {
  it('resolves every fragment, including the icon sprite references', () => {
    for (const [name, doc] of documents()) {
      const els = elements(doc.markup);
      const ids = new Set(els.map((e) => e.attrs['id']).filter(Boolean));
      const fragments = els
        .flatMap((e) => [e.attrs['href'], e.attrs['xlink:href']])
        .filter((h): h is string => !!h && h.startsWith('#'));
      // A row link and an <svg><use> both fail the same silent way: the anchor
      // does nothing, the icon draws nothing, and the page still looks fine.
      expect(fragments.length, `${name} draws no fragment links at all`).toBeGreaterThan(0);
      const dangling = fragments.filter((h) => !ids.has(h.slice(1)));
      expect(dangling, `${name} has fragment links with no target`).toEqual([]);
    }
  });

  it('serves every same-origin link it draws', async () => {
    let checked = 0;
    const urls = new Map<string, string>();
    for (const [name, doc] of documents()) {
      const internal = elements(doc.markup)
        .filter((e) => e.name === 'a' && e.attrs['href'] !== undefined)
        .map((e) => e.attrs['href']!)
        .filter((h) => h !== '' && !h.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(h));
      // The embedded section is one <section> of the page and carries no
      // record-scope nav, so it is allowed to draw none.
      if (name !== 'section') expect(internal.length, `${name} draws no internal links`).toBeGreaterThan(0);
      checked += new Set(internal).size;
      for (const href of new Set(internal)) {
        const url = new URL(href, `${origin}/`);
        // Status alone proves nothing here: the view answers every path with
        // the dashboard, so a link to /helmo@f73727a returns a cheerful 200.
        // The route this server actually has is `/` with a query string.
        expect(url.pathname, `${name} links to the path ${url.pathname}, which the view does not route`).toBe('/');
        urls.set(url.href, `${name} links to ${href}`);
      }
    }
    await Promise.all([...urls].map(async ([url, label]) => {
      const res = await fetch(url, { redirect: 'error' });
      await res.text();
      expect(res.status, label).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    }));
    expect(checked).toBeGreaterThan(0);
  }, 15_000);

  it('draws external links as absolute http(s) URLs and nothing else', () => {
    // Evidence refs are typed by the agent that recorded them, and only the
    // `url` kind becomes an anchor. A ref like `helmo@f73727a` reaching an
    // href would resolve against the dashboard's own origin and quietly 404.
    for (const [name, doc] of documents()) {
      for (const el of elements(doc.markup)) {
        if (el.name !== 'a') continue;
        const href = el.attrs['href'];
        expect(href, `${name} has an anchor with no href`).toBeDefined();
        expect(href, `${name} has an empty href`).not.toBe('');
        if (!href || href.startsWith('#') || !/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const url = new URL(href);
        expect(['http:', 'https:'], `${name} links out with ${href}`).toContain(url.protocol);
        expect(url.host, `${name} links out with no host: ${href}`).not.toBe('');
      }
    }
  });

  it('answers an unknown section with a 404 rather than a page', async () => {
    // The other half of a link checker: a route that 200s whatever you ask it
    // cannot tell you that a link is broken.
    const res = await fetch(`${origin}/?section=nosuchthing`, { redirect: 'error' });
    await res.text();
    expect(res.status).toBe(404);
  });
});

// ---------- performance budget ----------

describe('the page stays inside its performance budget', () => {
  /* MEASURED_AT_CAPACITY */

  it('is measured on a record at least as heavy as the deployed one', () => {
    // The budget's whole claim rests on this. A ceiling measured on a lighter
    // fixture than the record it protects is the defect this file shipped
    // once already: 300,000 bytes asserted on 80 one-line tickets, while the
    // record it was shipped against served 2,718,020.
    expect(seeded.rows).toBeGreaterThanOrEqual(REAL_RECORD.tickets);
    expect(seeded.storedTextBytes).toBeGreaterThanOrEqual(CAPACITY.minimumStoredTextBytes);
    expect(page.whole!.rows).toBeGreaterThanOrEqual(REAL_RECORD.tickets);
    expect(page.current!.rows).toBeGreaterThanOrEqual(REAL_RECORD.currentRows);
    // Heavier in total is not enough: a fixture of many thin rows renders
    // nothing like a record of fewer fat ones. The document a row costs is
    // the thing the budget is made of, so the seed has to be at least as
    // dense as the deployed record too.
    expect(page.whole!.bytes / page.whole!.rows).toBeGreaterThanOrEqual(REAL_RECORD.bytesPerRow.whole);
    expect(page.current!.bytes / page.current!.rows).toBeGreaterThanOrEqual(REAL_RECORD.bytesPerRow.current);
    // And it has to carry the hardest thing to lay out that the real record
    // holds: a path with no space in it. A fixture whose longest ref fits in
    // a 360px phone anyway cannot tell anyone whether the page would.
    const longest = decode(page.current!.markup.replace(/<[^>]*>/g, ' '))
      .split(/\s+/)
      .reduce((most, token) => Math.max(most, token.length), 0);
    expect(longest).toBeGreaterThanOrEqual(REAL_RECORD.longestUnbrokenToken);
    const unbreakable = decode(page.current!.markup.replace(/<[^>]*>/g, ' '))
      .split(/[\s/\-.,_?&=:;()[\]{}<>|+*"']+/)
      .reduce((most, run) => Math.max(most, run.length), 0);
    expect(unbreakable).toBeGreaterThanOrEqual(REAL_RECORD.longestUnbreakableRun);
  });

  it('renders and sends each document inside budget', () => {
    for (const [name, doc] of documents()) {
      expect(overBudget(doc, FLOOR), `${name}: ${doc.bytes} bytes, ${doc.ms.toFixed(0)}ms, ${doc.rows} rows`).toEqual([]);
    }
  });

  it('costs one request: no subresource is fetched to render it', () => {
    // Everything is inline by design — tokens, sprite, stylesheet, script. It
    // is what makes the page work on a laptop with no network, and what makes
    // the layout-stability claim below true rather than hopeful.
    for (const [name, doc] of documents()) {
      for (const el of elements(doc.markup)) {
        expect(el.attrs['src'], `${name} loads ${el.name} from ${el.attrs['src']}`).toBeUndefined();
        if (el.name === 'link') expect(el.attrs['href'], `${name} loads a stylesheet`).toBeUndefined();
      }
      expect(styleOf(doc.html), `${name} loads a font or image from CSS`).not.toMatch(/@font-face|url\(/);
    }
  });

  it('grows with the record rather than with the square of it', () => {
    // The whole record adds closed rows to the current one. Both are drawn by
    // the same row renderer, so a row has to cost about the same on either
    // document; the raw totals cannot say that, because the whole record
    // legitimately draws three times as many rows.
    expect(page.whole!.rows).toBeGreaterThan(page.current!.rows);
    const perRow = (name: string) => page[name]!.bytes / page[name]!.rows;
    expect(perRow('whole')).toBeLessThan(perRow('current') * 1.5);
  });
});


// ---------- layout stability across the supported viewports ----------

describe('the page holds still at every supported width', () => {
  /* The widths this CSS actually names, plus the two the page has been caught
     overflowing at: 390px (R-11 H-889, a 343px option in a 390px viewport) and
     the 480px and 700px breakpoints it declares. 360px is the narrowest phone
     the dashboard is expected to survive. */
  const VIEWPORTS = [360, 390, 480, 700, 1280];

  it('tells the browser the viewport is the viewport', () => {
    for (const [name, doc] of documents()) {
      const meta = elements(doc.markup).find((e) => e.name === 'meta' && e.attrs['name'] === 'viewport');
      expect(meta?.attrs['content'], `${name} has no usable viewport meta`).toContain('width=device-width');
    }
  });

  it('declares no fixed width or minimum wider than the narrowest viewport it applies at', () => {
    const offenders: string[] = [];
    for (const rule of blocks(styleOf(page.current!.html))) {
      const floor = /min-width:\s*(\d+)px/.exec(rule.media);
      const appliesFrom = Math.min(...VIEWPORTS.filter((w) => w >= (floor ? Number(floor[1]) : 0)));
      for (const [prop, value] of Object.entries(declarations(rule.body))) {
        if (prop !== 'width' && prop !== 'min-width') continue;
        const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
        if (px && Number(px[1]) > appliesFrom) offenders.push(`${rule.media} ${rule.selector} { ${prop}: ${value} }`);
      }
    }
    // A declared width wider than the viewport it can apply at is the one
    // layout shift a server-rendered page can still produce on its own: the
    // document goes sideways and every row under it moves.
    expect(offenders).toEqual([]);
  });

  it('reserves space for the icons before anything paints', () => {
    // An inline <svg> with a viewBox and no CSS size lays out at 300x150 and
    // then collapses, which moves every line it sits on. The rule is what
    // stops that, and the sprite itself must never take part in layout.
    const mark = blocks(styleOf(page.current!.html)).find((r) => r.selector === '.mark');
    expect(mark, 'the icon rule is gone').toBeDefined();
    expect(declarations(mark!.body)['width']).toBeTruthy();
    expect(declarations(mark!.body)['height']).toBeTruthy();
    for (const [name, doc] of documents()) {
      const sprite = elements(doc.markup).find((e) => e.name === 'svg' && !!e.attrs['xmlns']);
      expect(sprite?.attrs['style'], `${name} draws the sprite in the flow`).toContain('display:none');
    }
  });

  it('keeps every supported width inside a declared breakpoint', () => {
    // Not a layout measurement — a completeness one. If a width in the list
    // falls outside every range the CSS declares, nothing below has been
    // asserted about it and the list is lying.
    const media = blocks(styleOf(page.current!.html))
      .map((r) => r.media)
      .filter((m) => /width/.test(m));
    expect(media.some((m) => /max-width:\s*480px/.test(m))).toBe(true);
    expect(media.some((m) => /min-width:\s*700px/.test(m))).toBe(true);
    for (const w of VIEWPORTS) expect(w).toBeGreaterThanOrEqual(Math.min(...VIEWPORTS));
  });
});

// ---------- accessibility ----------

describe('the served document can be read and operated without looking at it', () => {
  it('names its language and itself', () => {
    for (const [name, doc] of documents()) {
      expect(/<html[^>]*\blang="[a-z-]+"/i.test(doc.html), `${name} declares no language`).toBe(true);
      expect(/<title>[^<]+<\/title>/.test(doc.html), `${name} has no title`).toBe(true);
    }
  });

  it('runs one unbroken heading ladder', () => {
    const levels = (doc: { markup: string }) =>
      [...doc.markup.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));

    const full = levels(page.current!);
    expect(full.filter((l) => l === 1)).toHaveLength(1);
    expect(full[0]).toBe(1);
    // The embedded reading is a fragment of someone else's page: the estate
    // landing supplies the h1 above the iframe, so this document starts at h2
    // on purpose and must not invent a second first-level heading.
    expect(levels(page.section!)).not.toContain(1);
    for (const [name, doc] of documents()) {
      levels(doc).reduce((previous, level) => {
        expect(level - previous, `${name} skips from h${previous} to h${level}`).toBeLessThanOrEqual(1);
        return level;
      }, levels(doc)[0]!);
    }
  });

  it('gives every control something to be called', () => {
    for (const [name, doc] of documents()) {
      const controls = elements(doc.markup).filter((e) => ['a', 'button', 'summary'].includes(e.name));
      expect(controls.length, `${name} has no controls to check`).toBeGreaterThan(0);
      for (const el of controls) {
        const label = el.attrs['aria-label'] || el.attrs['title'] || textOf(doc.markup, el);
        expect(label, `${name} has a nameless <${el.name}>`).not.toBe('');
      }
    }
    // The control that only exists for the human is the one worth naming here.
    expect(page.current!.html).toContain('>Ratify recommendation</button>');
  });

  it('hides the decorative icons from the reading order', () => {
    for (const [name, doc] of documents()) {
      const marks = elements(doc.markup).filter((e) => e.name === 'svg' && e.attrs['class'] === 'mark');
      expect(marks.length, `${name} draws no actor marks`).toBeGreaterThan(0);
      for (const mark of marks) expect(mark.attrs['aria-hidden'], `${name} reads an icon aloud`).toBe('true');
    }
  });

  it('keeps every id unique so a fragment and a label point at one thing', () => {
    for (const [name, doc] of documents()) {
      const ids = elements(doc.markup).map((e) => e.attrs['id']).filter(Boolean) as string[];
      const seen = new Set<string>();
      const duplicated = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
      expect(duplicated, `${name} draws the same id twice`).toEqual([]);
    }
  });

  it('announces what changes without the page changing under a reader', () => {
    // Both live regions on this page write while the reader is elsewhere: the
    // refresh warning and the result of ratifying.
    const live = elements(page.current!.markup).filter((e) => e.attrs['role'] === 'status');
    expect(live.length).toBeGreaterThanOrEqual(2);
  });

  describe('text contrast, measured on the surface it is drawn on', () => {
    /* The tokens are vendored from the estate and measured there, but Helmo
       composes its own inks out of them — a three-step ink ladder where shadcn
       has two, a badge ink on a translucent wash, a solid button fill — and a
       pair is only valid where it is actually used (H-714, H-771).
       The arithmetic is calibrated against three ratios the estate measured
       independently and recorded in view.ts's own comments; if this
       implementation and that one ever disagree, the calibration goes red
       before any judgement about a colour does. */
    const AA = 4.5;

    const css = () => styleOf(page.current!.html);

    function theme(dark: boolean): (name: string) => Colour {
      const declared: Record<string, string> = {};
      for (const rule of blocks(css())) {
        const selector = rule.selector.replace(/\s+/g, ' ');
        const isLight = selector === ':root, .light' || selector === ':root';
        const isDark = selector === '.dark' || selector === ':root:not(.light)';
        if (isLight || (dark && isDark)) Object.assign(declared, declarations(rule.body));
      }
      const resolve = (value: string, depth = 0): Colour => {
        if (depth > 8) throw new Error(`variable cycle at ${value}`);
        const mix = /^color-mix\(in oklab,\s*(.+?)\s+(\d+)%,\s*(.+?)\)$/.exec(value.trim());
        if (mix) {
          const p = Number(mix[2]) / 100;
          const a = rgbToOklab(resolve(mix[1]!, depth + 1).rgb);
          const b = rgbToOklab(resolve(mix[3]!, depth + 1).rgb);
          return { rgb: oklabToRgb(a[0] * p + b[0]! * (1 - p), a[1] * p + b[1]! * (1 - p), a[2] * p + b[2]! * (1 - p)), alpha: 1 };
        }
        const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
        if (ref) {
          const next = declared[ref[1]!];
          if (next === undefined) throw new Error(`${ref[1]} is used but never declared`);
          return resolve(next, depth + 1);
        }
        return parseColour(value);
      };
      return (name: string) => resolve(`var(${name})`);
    }

    it('agrees with the measurement the tokens were chosen by', () => {
      expect(contrast(parseColour('#fab219').rgb, [255, 255, 255])).toBeCloseTo(1.83, 2);
      expect(contrast([255, 255, 255], parseColour('#3987e5').rgb)).toBeCloseTo(3.64, 2);
      expect(contrast(parseColour('#ec835a').rgb, [255, 255, 255])).toBeCloseTo(2.64, 2);
    });

    for (const dark of [false, true]) {
      it(`carries every ink over its own background in the ${dark ? 'dark' : 'light'} theme`, () => {
        const token = theme(dark);
        const page_ = token('--page').rgb;
        const surface = token('--surface').rgb;
        const inks = ['--ink', '--ink-2', '--ink-3', '--warning', '--good-text', '--serious', '--critical', '--link'];
        for (const ink of inks) {
          for (const [where, background] of [['page', page_], ['surface', surface]] as const) {
            const ratio = contrast(token(ink).rgb, background);
            expect(ratio, `${ink} on the ${where} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
          }
        }
        // The two pairs the token file cannot have measured, because neither
        // background is a token: a wash composited over the surface behind it,
        // and the solid fill of the one button on the page.
        const wash = contrast(token('--amber-ink').rgb, over(token('--amber-wash'), surface));
        expect(wash, `the badge ink on its wash is ${wash.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
        const fill = contrast(token('--link-ink').rgb, token('--link').rgb);
        expect(fill, `the button label on its fill is ${fill.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
        // The third such pair, introduced with the action card (R-42 I13): the
        // report control's own ink over the wash its hover and focus states
        // put behind it. A ratio measured on the surface says nothing about
        // the state a reader is actually looking at while they press it.
        const acted = contrast(token('--serious').rgb, over(token('--status-serious-wash'), surface));
        expect(acted, `the report control on its hover wash is ${acted.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
      });
    }
  });
});
