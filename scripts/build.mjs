import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER = '.helmo-candidate';
const MARKER_TEXT = 'C1 unification candidate (H-2630).';

export function assertBuildRoot(root) {
  const marker = join(root, MARKER);
  let contents;
  try {
    contents = readFileSync(marker, 'utf8');
  } catch {
    throw new Error(`refusing to build: ${root} does not carry ${MARKER}`);
  }
  if (!contents.startsWith(MARKER_TEXT)) {
    throw new Error(`refusing to build: ${marker} is not the C1 candidate marker`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  assertBuildRoot(root);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build', '--workspaces', '--if-present'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
