import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestOf, snapshot } from '../src/build.js';

describe('running build identity (H-2491)', () => {
  it('identifies executable bytes rather than declarations or the stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-build-'));
    writeFileSync(join(dir, 'main.js'), 'export const value = 1;\n');
    writeFileSync(join(dir, 'main.d.ts'), 'export declare const value: number;\n');
    writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({ commit: 'a'.repeat(40), dirty: false, built_at: new Date().toISOString() }));
    const before = digestOf(dir);
    expect(snapshot(dir)).toMatchObject({ digest: before, stamp: { commit: 'a'.repeat(40), dirty: false } });
    writeFileSync(join(dir, 'main.d.ts'), 'changed but not executable\n');
    writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({ commit: 'b'.repeat(40), dirty: false, built_at: new Date().toISOString() }));
    expect(digestOf(dir)).toBe(before);
    writeFileSync(join(dir, 'main.js'), 'export const value = 2;\n');
    expect(digestOf(dir)).not.toBe(before);
  });

  it('calls source execution unverifiable instead of inventing a ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roadmap-source-'));
    writeFileSync(join(dir, 'main.ts'), 'export const value = 1;\n');
    expect(snapshot(dir)).toEqual({ dir, digest: null, stamp: null });
  });
});
