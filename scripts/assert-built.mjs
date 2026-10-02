import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuilt } from './build.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  assertBuilt(root);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
