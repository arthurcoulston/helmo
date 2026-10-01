import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectedRelease } from '../src/release.js';

describe('release layout', () => {
  it('resolves every legacy product inside one unified helmo component', () => {
    const root = mkdtempSync(join(tmpdir(), 'helmo-release-'));
    const release = join(root, '2026.10-2');
    const checkout = join(release, 'helmo');
    const commit = 'a'.repeat(40);
    for (const path of ['packages/work', 'packages/roadmap', 'packages/runtime']) mkdirSync(join(checkout, path), { recursive: true });
    writeFileSync(join(release, 'RELEASE.json'), JSON.stringify({ commits: { helmo: commit } }));
    const selection = join(root, 'selected.json');
    writeFileSync(selection, JSON.stringify({ release: '2026.10-2', directory: release, components: { helmo: { release: '2026.10-2', commit } } }));
    expect(selectedRelease('helmo', realpathSync(join(checkout, 'packages/work')), { INSTALLATION_RELEASE: selection })).toBe('2026.10-2');
    expect(selectedRelease('helmo-roadmap', realpathSync(join(checkout, 'packages/roadmap')), { INSTALLATION_RELEASE: selection })).toBe('2026.10-2');
    expect(selectedRelease('rev', realpathSync(join(checkout, 'packages/runtime')), { INSTALLATION_RELEASE: selection })).toBe('2026.10-2');
  });

  it('keeps the three-component release layout readable during upgrade and rollback', () => {
    const root = mkdtempSync(join(tmpdir(), 'helmo-release-'));
    const release = join(root, '2026.10-1');
    const commits = Object.fromEntries(['rev', 'helmo', 'helmo-roadmap'].map((name) => [name, name.repeat(40).slice(0, 40)]));
    for (const name of Object.keys(commits)) mkdirSync(join(release, name), { recursive: true });
    writeFileSync(join(release, 'RELEASE.json'), JSON.stringify({ commits }));
    const selection = join(root, 'selected.json');
    writeFileSync(selection, JSON.stringify({ release: '2026.10-1', directory: release, components: Object.fromEntries(Object.entries(commits).map(([name, commit]) => [name, { release: '2026.10-1', commit }])) }));
    expect(selectedRelease('rev', realpathSync(join(release, 'rev')), { INSTALLATION_RELEASE: selection })).toBe('2026.10-1');
  });
});
