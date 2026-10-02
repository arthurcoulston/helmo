import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER, MARKER_TEXT } from './build.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(root, '.git'))) {
  throw new Error(`refusing to prepare build outside a git checkout: ${root}`);
}
const marker = join(root, MARKER);
if (existsSync(marker)) {
  const current = readFileSync(marker, 'utf8');
  if (current.startsWith('C1 unification candidate (H-2630).')) {
    writeFileSync(marker, `${MARKER_TEXT}\n`);
  } else if (!current.startsWith(MARKER_TEXT)) {
    throw new Error(`refusing to replace unrelated build marker: ${marker}`);
  }
} else {
  writeFileSync(marker, `${MARKER_TEXT}\n`, { flag: 'wx' });
}
