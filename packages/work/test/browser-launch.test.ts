import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { launchBrowser } from '../scripts/browser.mjs';

describe('managed browser isolation', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fails with the install instruction instead of trying the desktop browser', async () => {
    vi.stubEnv('MANAGED_BROWSER_WS_ENDPOINT', undefined);
    const missing = new Error('managed browser executable is missing');
    const desktop = { close: vi.fn() };
    // A fallback would succeed here, concealing the missing managed browser.
    const launch = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue(desktop);
    await expect(launchBrowser({ launch })).rejects.toMatchObject({
      message: expect.stringContaining('npm run browser'), cause: missing,
    });
    expect(launch.mock.calls).toEqual([[{ headless: true }]]);
  });

  it('uses the session connection without launching another browser', async () => {
    const endpoint = `ws://127.0.0.1:54321/${'a'.repeat(32)}`;
    vi.stubEnv('MANAGED_BROWSER_WS_ENDPOINT', endpoint);
    const browser = { close: vi.fn() };
    const connect = vi.fn().mockResolvedValue(browser);
    const launch = vi.fn();
    expect(await launchBrowser({ connect, launch })).toBe(browser);
    expect(connect.mock.calls).toEqual([[endpoint, { timeout: 10000 }]]);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    '', 'not a URL',
    `wss://127.0.0.1:54321/${'a'.repeat(32)}`,
    `ws://localhost:54321/${'a'.repeat(32)}`,
    `ws://192.0.2.1:54321/${'a'.repeat(32)}`,
    `ws://127.0.0.1/${'a'.repeat(32)}`,
    'ws://127.0.0.1:54321/short',
    `ws://user:secret@127.0.0.1:54321/${'a'.repeat(32)}`,
    `ws://127.0.0.1:54321/${'a'.repeat(32)}?token=secret`,
    `ws://127.0.0.1:54321/${'a'.repeat(32)}#secret`,
  ])('refuses an invalid session endpoint before connection or launch (%#)', async endpoint => {
    vi.stubEnv('MANAGED_BROWSER_WS_ENDPOINT', endpoint);
    const connect = vi.fn();
    const launch = vi.fn();
    await expect(launchBrowser({ connect, launch })).rejects.toThrow('Invalid managed browser session endpoint');
    expect(connect).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('sanitizes connection failures and never falls back to a local launch', async () => {
    const endpoint = `ws://127.0.0.1:54321/${'b'.repeat(32)}`;
    vi.stubEnv('MANAGED_BROWSER_WS_ENDPOINT', endpoint);
    const connect = vi.fn().mockRejectedValue(new Error(`connection failed: ${endpoint}`));
    const launch = vi.fn();
    const failure = await launchBrowser({ connect, launch }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Could not connect to the managed browser session; no local browser was launched.');
    expect(failure.cause).toBeUndefined();
    expect(failure.stack).not.toContain(endpoint);
    expect(launch).not.toHaveBeenCalled();
  });

  it('keeps every browser entrypoint on the shared launcher', () => {
    for (const path of ['../shell/scripts/verify-ui.mjs', 'scripts/live-floor.mjs', 'scripts/screenshot.mjs']) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source, path).toMatch(/import .*launchBrowser.*from/);
      expect(source, path).not.toMatch(/chromium\.launch|channel\s*:|executablePath\s*:/);
    }
  });
});
