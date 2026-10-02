import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertBuildRoot, MARKER, MARKER_TEXT } from './build.mjs';

test('allows a marked writable checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'helmo-build-'));
  try {
    writeFileSync(join(root, MARKER), `${MARKER_TEXT}\n`);
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
    assert.throws(() => assertBuildRoot(root), /is not the Helmo build marker/);
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

// One product, one of each document. Three products that each carried their own
// LICENSE, SECURITY.md and changelog are how a consolidation drifts back apart:
// nothing fails, the copies just stop agreeing, and the reader cannot tell which
// one is the product's. The root set is the promise; a package-level copy of any
// of these names is the regression.
const PRODUCT_DOCS = [
  'README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md',
  'VERSIONING.md', 'AGENTS.md', 'CLAUDE.md', 'DEV.md',
  'INSTALLATIONS.md', 'ENTRY-POINTS.md', 'ISOLATION-CHECKS.md',
];

// The two each area keeps as its own: its front page and its coding context.
const AREA_DOCS = ['README.md', 'DEV.md'];

const PACKAGES = ['core', 'work', 'roadmap', 'runtime'];
const ROOT = new URL('../', import.meta.url);

test('every product-wide document exists once, at the root', () => {
  for (const doc of PRODUCT_DOCS) {
    assert.ok(existsSync(new URL(doc, ROOT)), `root ${doc}`);
    if (AREA_DOCS.includes(doc)) continue;
    for (const pkg of PACKAGES) {
      assert.ok(
        !existsSync(new URL(`packages/${pkg}/${doc}`, ROOT)),
        `packages/${pkg}/${doc} duplicates the product document`,
      );
    }
  }
});

test('every area names the one issue tracker', () => {
  const trackers = new Set();
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(new URL(`packages/${pkg}/package.json`, ROOT)));
    if (manifest.private) continue;
    assert.ok(manifest.bugs?.url, `${pkg} names an issue tracker`);
    trackers.add(manifest.bugs.url);
    assert.equal(manifest.repository?.url, 'git+https://github.com/arthurcoulston/helmo.git', `${pkg} repository`);
  }
  assert.equal(trackers.size, 1, `one tracker, got ${[...trackers].join(', ')}`);
});
