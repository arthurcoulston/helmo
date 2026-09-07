import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('demo seeder', () => {
  it('builds its disposable board through a stamped loop session', { timeout: 15_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'helmo-demo-test-'));
    const dbPath = join(dir, 'helmo.db');

    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/demo-seed.mjs'],
        {
          cwd: new URL('..', import.meta.url).pathname,
          env: { ...process.env, DEMO_DB: dbPath, HELMO_ACTOR: '' },
          encoding: 'utf8',
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Seeded 9 tickets');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
