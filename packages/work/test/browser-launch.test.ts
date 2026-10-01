import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../scripts/browser.mjs';

describe('managed browser isolation', () => {
  it('fails with the install instruction instead of trying the desktop browser', async () => {
    const missing = new Error('managed browser executable is missing');
    const desktop = { close: vi.fn() };
    // A fallback would succeed here, concealing the missing managed browser.
    const launch = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue(desktop);
    await expect(launchBrowser({ launch })).rejects.toMatchObject({
      message: expect.stringContaining('npm run browser'), cause: missing,
    });
    expect(launch.mock.calls).toEqual([[{ headless: true }]]);
  });

  it('keeps every browser entrypoint on the shared launcher', () => {
    for (const path of ['test/view-viewport-render.test.ts', 'scripts/live-floor.mjs', 'scripts/screenshot.mjs']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source, path).toMatch(/import .*launchBrowser.*from/);
      expect(source, path).not.toMatch(/chromium\.launch|channel\s*:|executablePath\s*:/);
    }
  });
});
