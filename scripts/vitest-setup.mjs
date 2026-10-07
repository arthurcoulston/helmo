// Loaded before any test file in every vitest workspace, so that no door into
// the suite inherits the operator's installation (H-2975). DEV.md states the
// rule — "tests do not inherit an installation" — but it was enforced only by
// the root `npm test`, so `npm test --workspace rev` and `npx vitest run
// <file>` ran the same checkout against whatever `~/.rev` the launching shell
// was pointed at: on a pinned installation every CLI-spawning case refused
// with `incoherent release set`, and on an unpinned one they would have read
// the live estate.
//
// Under the root suite this finds nothing left to clear and only moves
// REV_HOME to this file's own scratch directory, which is the point: the
// scrub is idempotent, so adding it costs the root door nothing.
import { rmSync } from 'node:fs';
import { afterAll } from 'vitest';
import { scrubInPlace } from './test-env.mjs';

const home = scrubInPlace();
afterAll(() => rmSync(home, { recursive: true, force: true }));
