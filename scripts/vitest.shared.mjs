// One vitest config for every workspace that runs vitest. A second, slightly
// different one is how a workspace quietly stops being isolated (H-2644), so
// each `vitest.config.mjs` re-exports this module rather than restating it,
// and `scripts/test-env.test.mjs` fails if a vitest workspace carries no
// config or carries another one.
import { fileURLToPath } from 'node:url';

// Hundreds of cases here spawn a real CLI under tsx, and paying node's startup
// and a transpile per command puts them at 1.4-2.3s each on a quiet box. That
// leaves vitest's own 5000ms default two or three times' headroom, which the
// estate's nightly box does not have: CI took helmo red at load 80 across 8
// cores, where `test/recent-results.test.ts`'s five-spawn CLI case crossed the
// line from the 2032ms it measures when nothing else is running (H-3354). The
// 5000ms was never a decision — this config set only `setupFiles`, so every
// workspace inherited it — and the repo had been answering it one red at a
// time, hand-declaring a timeout on each case as it got bitten.
//
// 15s is the deliberate floor: seven times the slowest spawning case, and no
// larger than the smallest timeout anyone here declared on purpose, so every
// existing `{ timeout: … }` still means what it says — more room than the
// default, never less. A genuine hang still fails forty times inside the
// runner's 600s step cap.
export default {
  test: {
    setupFiles: [fileURLToPath(new URL('./vitest-setup.mjs', import.meta.url))],
    testTimeout: 15_000,
  },
};
