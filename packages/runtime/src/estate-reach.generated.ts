// VENDORED — do not edit. Source: the crew repo, tools/estate/services.json
// Refresh: node scripts/vendor-estate-reach.mjs
// Drift is a test failure: npm test (skipped, loudly, with no crew checkout)
//
// Where each estate surface is reached: composed surfaces carry a desk
// `url` and shell `path`; desk-only surfaces repeat their loopback URL.
// Which address a link should use is decided in the browser — see
// src/reach.ts.

export const ESTATE_REACH: Record<string, { url: string; path: string }> = {
  "helmo-app": { url: "http://localhost:4400/", path: "http://localhost:4400/" },
  "goodplumb-estate-shell": { url: "http://localhost:4320/", path: "/" },
  "meetings": { url: "http://localhost:4700/", path: "http://localhost:4700/" },
};
