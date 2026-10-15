import { chromium } from 'playwright-core';

// The managed headless shell has no desktop app bundle or personal profile.
// Never fall back to an installed browser: its extension policies can close
// other windows in the user's desktop session, even with headless: true.
export async function launchBrowser(engine = chromium) {
  const endpoint = process.env.MANAGED_BROWSER_WS_ENDPOINT;
  if (endpoint !== undefined) {
    // The session owner supplies a fresh loopback-only Playwright capability.
    // Failure must never fall back to launching outside the session host.
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('Invalid managed browser session endpoint'); }
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port
      || !/^\/[a-f0-9-]{32,}$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid managed browser session endpoint');
    }
    try { return await engine.connect(endpoint, { timeout: 10000 }); }
    catch { throw new Error('Could not connect to the managed browser session; no local browser was launched.'); }
  }
  try {
    return await engine.launch({ headless: true });
  } catch (cause) {
    throw new Error(
      'Could not launch the managed headless browser. Run `npm run browser` in this checkout, then retry. No installed browser was launched.',
      { cause },
    );
  }
}
