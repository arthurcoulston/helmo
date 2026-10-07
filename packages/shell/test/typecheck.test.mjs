/* What this can prove: that `npm run typecheck` reports a type error at all.
   The script was `tsc --noEmit` against a solution config whose `files` is
   empty, so it checked no files and exited 0 on anything — the duplicate
   declaration in H-2974 went past it and was caught by esbuild instead. A
   green gate nobody has seen red is not evidence, so the proof injects the
   failure the gate has to catch (H-2977). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const typecheck = () => {
  const run = spawnSync('npm', ['run', '--silent', 'typecheck'], { cwd: root, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
};

/* Inside `include`, so the application project owns it; outside src/lib and
   the generated directories, so upstream.test.mjs's unpinned-file scan cannot
   see it even when the two files run at once. */
const probe = join(root, 'src/typecheck-red-probe.ts');

/* A run killed between writing the probe and removing it would otherwise
   leave every later green assertion failing on last time's debris. */
rmSync(probe, { force: true });

test('the gate passes this tree', () => {
  const { status, output } = typecheck();
  assert.equal(status, 0, `typecheck failed on an unmodified tree:\n${output}`);
});

test('the gate fails on a type error in application source', () => {
  writeFileSync(probe, 'export const red: number = "not a number";\n');
  try {
    const { status, output } = typecheck();
    assert.notEqual(status, 0, `typecheck passed a deliberate type error, so it checks nothing:\n${output}`);
    assert.match(output, /typecheck-red-probe\.ts\(1,\d+\): error TS2322/, `the error reported is not the injected one:\n${output}`);
  } finally {
    rmSync(probe, { force: true });
  }
});
