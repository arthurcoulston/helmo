import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
