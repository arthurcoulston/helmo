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

// The cut is the one place the version number has to agree with prose. A
// release's GitHub Release body is the CHANGELOG section for its tag, read out
// of the frozen commit (crew:tools/publishing/release-notes.mjs), so a version
// bumped without its section refuses the whole publication at send time — far
// too late. Two headings are legitimate: the cut one the tag reads, and the
// in-development one. Both must name the version the packages carry.
test('the changelog opens on this version, cut or in development', () => {
  const root = new URL('../', import.meta.url);
  const product = JSON.parse(readFileSync(new URL('package.json', root))).version;
  const lines = readFileSync(new URL('CHANGELOG.md', root), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^##\s/.test(l));
  assert.notEqual(start, -1, 'CHANGELOG.md has no section headings');
  const heading = lines[start].replace(/^##\s+/, '').trim();
  const cut = new RegExp(`^v${product.replace(/\./g, '\\.')}(?![\\w.-])`);
  assert.ok(cut.test(heading) || heading.startsWith(`Unreleased — ${product}`),
    `CHANGELOG.md opens on "${heading}" — expected "v${product} — <date>" once cut, or "Unreleased — ${product}" before`);
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  assert.ok(lines.slice(start + 1, end).join('\n').trim(), `the "${heading}" section is empty`);
});

// One product, one of each document. Three products that each carried their own
// LICENSE, SECURITY.md and changelog are how a consolidation drifts back apart:
// nothing fails, the copies just stop agreeing, and the reader cannot tell which
// one is the product's. The root set is the promise; a package-level copy of any
// of these names is the regression.
const PRODUCT_DOCS = [
  'README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md',
  'VERSIONING.md', 'AGENTS.md', 'CLAUDE.md', 'DEV.md',
  'AGENT-INSTALL.md', 'INSTALLATIONS.md', 'ENTRY-POINTS.md', 'ISOLATION-CHECKS.md',
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
