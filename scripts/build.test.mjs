import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertBuildRoot, MARKER } from './build.mjs';

test('allows the marked C1 candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'helmo-build-'));
  try {
    writeFileSync(join(root, MARKER), 'C1 unification candidate (H-2630).\n');
    assert.doesNotThrow(() => assertBuildRoot(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses an unmarked checkout before any package build runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'helmo-build-'));
  try {
    assert.throws(() => assertBuildRoot(root), /does not carry \.helmo-candidate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a marker with unrelated contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'helmo-build-'));
  try {
    writeFileSync(join(root, MARKER), 'not this candidate\n');
    assert.throws(() => assertBuildRoot(root), /is not the C1 candidate marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every workspace package carries the product version', () => {
  const root = new URL('../', import.meta.url);
  const product = JSON.parse(readFileSync(new URL('package.json', root))).version;
  for (const name of ['core', 'work', 'roadmap', 'runtime']) {
    const pkg = JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, root)));
    assert.equal(pkg.version, product, `${name} version`);
    if (name !== 'core') assert.equal(pkg.dependencies['@helmo/core'], product, `${name} core dependency`);
  }
});
