import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The keychain read is the only boundary stood in for; the poll, the file it
// writes and the capacity decision on what it wrote are the real ones.
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: 'NOT_A_REAL_SECRET' } }),
}));

const { pollUsage, readUsage, usageForModel, usagePath } = await import('../src/usage.js');
const { capacityDecide } = await import('../src/capacity.js');

const claude = { provider: 'claude', runtime: 'claude' as const, model: 'claude-opus-5-5' };
const thresholds = {
  exhaustedPercent: 95, sharedReservePercent: 5, blockHorizonSeconds: 7200,
  exhaustionCeilingSeconds: 691200, staleGraceIterations: 6, staleWaitSeconds: 900,
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rev-usage-poll-'));
  vi.stubEnv('REV_HOME', home);
  vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 429 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

const decide = () => capacityDecide({
  choices: [{ choice: claude, snapshot: usageForModel(readUsage(), claude.model), refreshed: true }],
  isLoopRun: true, staleIterations: 6, thresholds,
});

describe('pollUsage after a 429 (H-740)', () => {
  it('keeps a recent good read, and the spent streak still continues on it', async () => {
    const goodAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const reset = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    writeFileSync(usagePath(), JSON.stringify({
      fetched_at: goodAt, stale: false,
      limits: [
        { kind: 'session', label: 'session (5h)', percent: 51, severity: 'normal', resets_at: reset(3), active: true },
        { kind: 'weekly_all', label: 'weekly (all models)', percent: 40, severity: 'normal', resets_at: reset(100), active: false },
      ],
    }));
    const snap = await pollUsage();
    expect(snap).toMatchObject({ stale: true, error: 'endpoint returned 429', fetched_at: goodAt });
    expect(decide()).toEqual({ act: 'continue', on: claude });
  });

  it('still waits when there was never a good read, rather than guessing', async () => {
    const snap = await pollUsage();
    expect(snap).toMatchObject({ stale: true, limits: [] });
    expect(decide()).toMatchObject({ act: 'wait', seconds: 900 });
  });

  it('still waits once the last good read is older than the window', async () => {
    writeFileSync(usagePath(), JSON.stringify({
      fetched_at: new Date(Date.now() - 31 * 60_000).toISOString(), stale: false,
      limits: [{ kind: 'session', label: 'session (5h)', percent: 51, severity: 'normal', resets_at: new Date(Date.now() + 3_600_000).toISOString(), active: true }],
    }));
    await pollUsage();
    expect(decide()).toMatchObject({ act: 'wait', seconds: 900 });
  });
});
