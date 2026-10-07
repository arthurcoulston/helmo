// One vitest config for every workspace that runs vitest. A second, slightly
// different one is how a workspace quietly stops being isolated (H-2644), so
// each `vitest.config.mjs` re-exports this module rather than restating it,
// and `scripts/test-env.test.mjs` fails if a vitest workspace carries no
// config or carries another one.
import { fileURLToPath } from 'node:url';

export default {
  test: { setupFiles: [fileURLToPath(new URL('./vitest-setup.mjs', import.meta.url))] },
};
