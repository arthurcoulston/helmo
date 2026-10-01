import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { productCheckout } from '@helmo/core/checkout';

// The work record is a package in this workspace when the products share one
// and a repository cloned beside this checkout when they do not; keyed on the
// name its package.json declares, never on a directory basename. A written-out
// `../../helmo` found nothing once rev became packages/runtime and helmo became
// packages/work — a directory move is a rename to anything reading a basename,
// and it made REV_TEST_HELMO mandatory for the whole suite (F4, H-2638).
export const HELMO_ROOT = resolve(
  process.env['REV_TEST_HELMO'] ?? productCheckout(import.meta.dirname, 'helmo', 'helmo'),
);
process.env['REV_TEST_HELMO'] = HELMO_ROOT;
export const HELMO_CLI = join(import.meta.dirname, 'helmo-cli.mjs');
export const HELMO_SERVER = join(import.meta.dirname, 'helmo-server.mjs');
// The supervisor e2e opens the store directly to assert what the loops wrote.
// It must come from the same checkout HELMO_ROOT names: a hard-coded sibling
// path silently ignored REV_TEST_HELMO, so that one suite still demanded a
// ../helmo directory and no scratch clone could ever run it (H-1400).
export const HELMO_STORE = join(HELMO_ROOT, 'src', 'store.ts');

for (const file of [join(HELMO_ROOT, 'src', 'cli.ts'), join(HELMO_ROOT, 'src', 'server.ts'), HELMO_STORE]) {
  if (!existsSync(file)) {
    throw new Error(
      `Rev's integration tests require a Helmo source checkout. Set REV_TEST_HELMO to its root; missing ${file}`,
    );
  }
}
