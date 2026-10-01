import 'tsx/esm';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productCheckout } from '@helmo/core/checkout';

// Same resolution as test/helmo.ts, which is what sets REV_TEST_HELMO for a
// child it spawns; this default is for running this entry point by hand.
const root = resolve(process.env.REV_TEST_HELMO ?? productCheckout(import.meta.dirname, 'helmo', 'helmo'));
await import(pathToFileURL(join(root, 'src', 'cli.ts')).href);
