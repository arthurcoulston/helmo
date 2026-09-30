/* The page in a browser, at every width it claims to support (H-202).
 *
 * `view-release-floor.test.ts` reads the served bytes and the CSS in them.
 * That catches a declared width wider than the viewport it applies at, and it
 * cannot catch anything that only exists once a layout engine has run: a long
 * unbreakable ref pushing its row sideways, an icon laying out at its default
 * 300x150, a badge row that does not wrap. This file puts the same document
 * in Chromium and measures the boxes.
 *
 * It needs a browser on the machine, which is why it is `npm run viewport`
 * and not part of `npm test`: the rest of the suite runs offline on a laptop
 * with nothing installed, and quietly skipping a check when the browser is
 * missing would make a release gate that passes hardest when it is doing
 * least. It requires Playwright's managed headless shell; it never launches
 * the installed desktop browser. `npm run browser` installs the right build.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, Page } from 'playwright-core';
import { launchBrowser } from '../scripts/browser.mjs';
import { seedCapacityRecord, serveRecord } from './support/served-record.js';

/* The widths the CSS names, plus the two the page has been caught overflowing
   at: 390px (R-11 H-889, a 343px option in a 390px viewport) and the 480px and
   700px breakpoints it declares. 360px is the narrowest phone the dashboard is
   expected to survive; 1280 is the laptop it is read on. */
const VIEWPORTS = [360, 390, 480, 700, 1280];

/** The current record at every width; the whole record — the same rows, drawn
 *  by the same renderer, three times as many of them — at the two extremes,
 *  which is where a layout gives way. Checking 3.5MB at all five widths costs
 *  a minute and says nothing the extremes do not. */
const AT_EVERY_WIDTH = '/';
const AT_THE_EXTREMES = '/?whole=1';

const dir = mkdtempSync(join(tmpdir(), 'helmo-viewport-'));
const db = join(dir, 'helmo.db');
let view: ChildProcess | null = null;
let browser: Browser | null = null;
let origin = '';

beforeAll(async () => {
  seedCapacityRecord(db);
  ({ view, origin } = await serveRecord(db));
  browser = await launchBrowser();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  view?.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** One page, laid out at one width, with a layout-shift observer installed
 *  before the document runs.
 *
 *  `opened` is not a detail. Every row is a collapsed `<details>`, so a
 *  browser that only loads the document lays out the summaries and nothing
 *  else — and the bodies and evidence refs, which is where the 128-character
 *  workspace paths are, never touch the layout engine at all. A harness that
 *  skips this measures the page nobody has read yet. */
async function laidOut(path: string, width: number, opened = false): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width, height: 900 } });
  await page.addInitScript(() => {
    (window as unknown as { __shift: number }).__shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) (window as unknown as { __shift: number }).__shift += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  if (opened) {
    await page.evaluate(() => {
      for (const d of Array.from(document.querySelectorAll('details'))) d.open = true;
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  }
  return page;
}

/** Everything that reaches past the right edge of the viewport — boxes AND
 *  the text drawn inside them — named well enough to find. An assertion that
 *  only says "something overflows" sends the next reader back to a browser to
 *  do the work again.
 *
 *  Text has to be measured with a Range. An element whose overflow is
 *  `visible` reports scrollWidth equal to its own padding box no matter how
 *  far its text spills, so the obvious check silently passes on exactly the
 *  defect it was written for; the rectangle around the text run does not. */
async function pastTheEdge(page: Page, width: number) {
  return page.evaluate((limit) => {
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.right <= limit + 1) continue;
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      out.push(`${el.tagName.toLowerCase()}${id}${cls} right=${Math.round(box.right)} width=${Math.round(box.width)}`);
    }
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.textContent?.trim();
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width === 0 || box.right <= limit + 1) continue;
      out.push(`text right=${Math.round(box.right)} "${text.slice(0, 60)}"`);
    }
    return out.slice(0, 8);
  }, width);
}

describe('the page holds still in a browser at every width it supports', () => {
  for (const width of VIEWPORTS) {
    for (const opened of [false, true]) {
      it(`fits the ${opened ? 'opened' : 'delivered'} document inside a ${width}px viewport`, async () => {
        const page = await laidOut(AT_EVERY_WIDTH, width, opened);
        try {
          const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
          // A page wider than its viewport is the defect a phone reader hits
          // first: the whole record slides sideways under the thumb and the
          // right-hand end of every row goes off-screen.
          expect(scrollWidth, `the document scrolls sideways at ${width}px`).toBeLessThanOrEqual(width + 1);
          expect(await pastTheEdge(page, width), `something reaches past the right edge at ${width}px`).toEqual([]);
        } finally {
          await page.close();
        }
      }, 180_000);
    }
  }

  for (const width of [VIEWPORTS[0]!, VIEWPORTS[VIEWPORTS.length - 1]!]) {
    it(`fits the opened whole record inside a ${width}px viewport`, async () => {
      const page = await laidOut(AT_THE_EXTREMES, width, true);
      try {
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth, `the whole record scrolls sideways at ${width}px`).toBeLessThanOrEqual(width + 1);
        expect(await pastTheEdge(page, width), `something reaches past the right edge at ${width}px`).toEqual([]);
      } finally {
        await page.close();
      }
    }, 300_000);
  }

  it('lays the icons out at the size the CSS gives them', async () => {
    const page = await laidOut(AT_EVERY_WIDTH, 390);
    try {
      const marks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('svg.mark')).map((el) => {
          const box = el.getBoundingClientRect();
          return { w: Math.round(box.width), h: Math.round(box.height) };
        }),
      );
      // An inline <svg> with a viewBox and no CSS size lays out at 300x150.
      // Nothing in the served bytes can tell you whether the rule that stops
      // that actually reached the element; the box can.
      expect(marks.length, 'no actor marks were drawn').toBeGreaterThan(0);
      for (const mark of marks) {
        expect(mark.w, `an actor mark laid out ${mark.w}px wide`).toBeGreaterThan(6);
        expect(mark.w, `an actor mark laid out ${mark.w}px wide`).toBeLessThan(40);
        expect(mark.h, `an actor mark laid out ${mark.h}px tall`).toBeLessThan(40);
      }
    } finally {
      await page.close();
    }
  }, 120_000);

  it('breaks the long refs instead of letting them widen their row', async () => {
    // The page draws absolute paths and 40-character commit hashes inside
    // narrow cards, and it survives that on one CSS declaration
    // (`overflow-wrap: anywhere`). This is the check that notices if it goes:
    // a box wider than the space it was given is text that cannot be read.
    const page = await laidOut(AT_EVERY_WIDTH, 360, true);
    try {
      const spilling = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('.rtitle, .ev, .body, .badge, summary, .qcard, .scard'))) {
          const limit = el.getBoundingClientRect().right;
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let node = walk.nextNode(); node; node = walk.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            if (box.width > 0 && box.right > limit + 1)
              out.push(`${el.className || el.tagName.toLowerCase()} text to ${Math.round(box.right)} past ${Math.round(limit)}`);
          }
        }
        return out.slice(0, 8);
      });
      expect(spilling, 'text is drawn outside the box given to it').toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('settles without moving what it has already drawn', async () => {
    // Cheap, and it stays honest as the page changes: a document that fetches
    // nothing should score exactly zero, so any reading above it means
    // something new arrives after first paint.
    const page = await laidOut(AT_EVERY_WIDTH, 390);
    try {
      await page.waitForTimeout(400);
      const shift = await page.evaluate(() => (window as unknown as { __shift: number }).__shift);
      expect(shift, 'the layout moved after it was first drawn').toBe(0);
    } finally {
      await page.close();
    }
  }, 120_000);
});

/* The copy control, exercised rather than described (H-2428, I12).
 *
 * `view-accessibility.test.ts` holds the shape of the rendered markup. What
 * it cannot see is the only thing Arthur will judge this by: whether the
 * thing he taps puts the reference on his clipboard and nothing else. That
 * needs a browser with a clipboard, so it lives here. */
describe('a reference can be carried into a conversation in one gesture', () => {
  /** A page whose clipboard the test is allowed to read back. */
  async function withClipboard(): Promise<Page> {
    const context = await browser!.newContext({ viewport: { width: 390, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await context.newPage();
    await page.goto(`${origin}${AT_EVERY_WIDTH}`, { waitUntil: 'load' });
    return page;
  }

  it('puts the exact reference on the clipboard, and nothing beside it', async () => {
    const page = await withClipboard();
    try {
      const row = page.locator('details.trow').first();
      const id = (await row.getAttribute('id'))!;
      expect(id).toMatch(/^H-\d+$/);
      await row.locator('.copy').first().click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
      // The control sits inside the row's <summary>. One gesture, one effect:
      // if copying also toggled the disclosure, every tap would dump a ticket
      // body onto the screen. Chromium spares a real <button> from a summary's
      // activation behaviour, so what this measures is that the control stays
      // a real button — `e.preventDefault()` in the handler is the belt for
      // the engines that do not, and only the source test can see it.
      expect(await row.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
      expect(await page.locator('#copy-status').textContent()).toBe(`${id} copied`);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('copies from the keyboard as well as the pointer', async () => {
    const page = await withClipboard();
    try {
      const button = page.locator('details.trow').first().locator('.copy').first();
      await button.focus();
      await page.keyboard.press('Enter');
      const id = (await page.locator('details.trow').first().getAttribute('id'))!;
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('gives the control a finger-sized target without a finger-sized icon', async () => {
    const page = await withClipboard();
    try {
      const box = await page.locator('.copy').first().evaluate((el) => {
        const after = getComputedStyle(el, '::after');
        const own = el.getBoundingClientRect();
        const grow = (v: string) => Math.abs(parseFloat(v) || 0);
        return {
          icon: Math.round(own.width),
          target: Math.round(own.width + grow(after.left) + grow(after.right)),
          tall: Math.round(own.height + grow(after.top) + grow(after.bottom)),
        };
      });
      expect(box.target, 'the copy target is narrower than a fingertip').toBeGreaterThanOrEqual(44);
      expect(box.tall, 'the copy target is shorter than a fingertip').toBeGreaterThanOrEqual(44);
      // And the icon itself stays beside 12px monospace rather than dwarfing it.
      expect(box.icon).toBeLessThanOrEqual(20);
    } finally {
      await page.context().close();
    }
  }, 120_000);

  it('still copies where the page has no Clipboard API', async () => {
    // These pages are served over plain http, so a phone reading the estate
    // over the LAN has no navigator.clipboard at all. The fallback is that
    // reader's ONLY path; a copy button that silently does nothing there is
    // the defect, and it is invisible from a localhost browser.
    const context = await browser!.newContext({ viewport: { width: 390, height: 900 } });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      const handed: string[] = [];
      (window as unknown as { __handed: string[] }).__handed = handed;
      document.execCommand = (command: string) => {
        // The effect the fallback is responsible for is the SELECTION it hands
        // the copy command; whether headless Chromium's execCommand then
        // reaches a real clipboard is the browser's business, not ours.
        if (command === 'copy') handed.push(String(getSelection() ?? ''));
        return true;
      };
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}${AT_EVERY_WIDTH}`, { waitUntil: 'load' });
      const row = page.locator('details.trow').first();
      const id = (await row.getAttribute('id'))!;
      await row.locator('.copy').first().click();
      expect(await page.evaluate(() => (window as unknown as { __handed: string[] }).__handed)).toEqual([id]);
      expect(await page.locator('#copy-status').textContent()).toBe(`${id} copied`);
      // Focus was borrowed for a hidden textarea; the reader gets it back.
      expect(await page.evaluate(() => document.activeElement?.className)).toContain('copy');
    } finally {
      await context.close();
    }
  }, 120_000);

  it('offers a copy control beside every reference it draws', async () => {
    const page = await withClipboard();
    try {
      const bare = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.tid'))
          .map((el) => ({ text: (el.textContent ?? '').replace('⧉', '').trim(), copy: el.querySelector('.copy')?.getAttribute('data-copy') }))
          .filter((r) => /^[A-Z]+-\d+$/.test(r.text) && r.copy !== r.text)
          .slice(0, 8),
      );
      expect(bare, 'a reference is drawn with no copy control, or one that copies something else').toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 120_000);
});
