import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER = '.helmo-candidate';
export const MARKER_TEXT = 'Helmo writable build checkout.';
export const BUILD_ARTIFACTS = [
  'packages/core/dist/index.js',
  'packages/work/dist/BUILD.json',
  'packages/roadmap/dist/BUILD.json',
  'packages/runtime/dist/BUILD.json',
  'packages/shell/dist/index.html',
];

export function assertBuildRoot(root) {
  const marker = join(root, MARKER);
  let contents;
  try {
    contents = readFileSync(marker, 'utf8');
  } catch {
    throw new Error(`refusing to build: ${root} does not carry ${MARKER}`);
  }
  if (!contents.startsWith(MARKER_TEXT)) {
    throw new Error(`refusing to build: ${marker} is not the Helmo build marker`);
  }
}

export function assertBuilt(root) {
  const missing = BUILD_ARTIFACTS.filter((artifact) => !existsSync(join(root, artifact)));
  if (missing.length) {
    throw new Error(
      `refusing to test an unbuilt checkout: missing ${missing.join(', ')}; run npm run prepare:cold && npm run build`,
    );
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
