import { chromium } from 'playwright-core';

// The managed headless shell has no desktop app bundle or personal profile.
// Never fall back to an installed browser: its extension policies can close
// other windows in the user's desktop session, even with headless: true.
export async function launchBrowser(engine = chromium) {
  try {
    return await engine.launch({ headless: true });
  } catch (cause) {
    throw new Error(
      'Could not launch the managed headless browser. Run `npm run browser` in this checkout, then retry. No installed browser was launched.',
      { cause },
    );
  }
}
