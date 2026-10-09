import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnWindow, markBurnFloor, meteredProviders, recentCosts } from '../src/burn.js';
import { anomalyDecide } from '../src/capacity.js';
import type { Runtime } from '../src/types.js';

const NOW = Date.parse('2026-08-25T16:00:00.000Z');
const at = (iso: string, loop: string, cost: string, runtime: Runtime = 'claude') =>
  `${iso} loop=${loop} runtime=${runtime} model=test-model tokens=1000 cost_usd=${cost}`;

let home: string;
let log: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rev-burn-'));
  process.env['REV_HOME'] = home;
  log = join(home, 'token-log');
});

describe('burnWindow', () => {
  it('sums only the named loop, and only inside each window', () => {
    writeFileSync(
      log,
      [
        at('2026-08-25T15:30:00.000Z', 'ward', '1.00'), // in hour, in day
        at('2026-08-25T15:45:00.000Z', 'ward', '2.50'), // in hour, in day
        at('2026-08-25T09:00:00.000Z', 'ward', '4.00'), // day only
        at('2026-08-24T09:00:00.000Z', 'ward', '99.00'), // outside both
        at('2026-08-25T15:50:00.000Z', 'bosun', '50.00'), // another loop
      ].join('\n') + '\n',
    );
    expect(burnWindow('ward', NOW, log)).toEqual({ hourUsd: 3.5, dayUsd: 7.5 });
    expect(burnWindow('bosun', NOW, log)).toEqual({ hourUsd: 50, dayUsd: 50 });
  });

  it('never reaches back past the floor — a resumed loop starts clean', () => {
    writeFileSync(
      log,
      [at('2026-08-25T09:00:00.000Z', 'ward', '60.00'), at('2026-08-25T15:59:00.000Z', 'ward', '1.00')].join('\n') + '\n',
    );
    expect(burnWindow('ward', NOW, log).dayUsd).toBe(61);
    markBurnFloor('ward', Date.parse('2026-08-25T15:00:00.000Z'));
    expect(burnWindow('ward', NOW, log).dayUsd).toBe(1);
  });

  it('does not stamp a burn floor for a subscription provider', () => {
    writeFileSync(log, at('2026-08-25T15:59:00.000Z', 'ward', '1.00') + '\n');
    markBurnFloor('ward', 'subscription', NOW);
    expect(burnWindow('ward', NOW, log).dayUsd).toBe(1);
  });

  it('selects only metered providers from runnable choices', () => {
    const choices = [
      { provider: 'claude', runtime: 'claude' as const, model: 'large' },
      { provider: 'codex', runtime: 'codex' as const, model: 'large' },
    ];
    const providers = {
      claude: { name: 'claude', runtime: 'claude' as const, billing: 'subscription' as const, models: {} },
      codex: { name: 'codex', runtime: 'codex' as const, billing: 'metered' as const, models: {} },
    };
    expect([...meteredProviders(choices, providers)]).toEqual(['codex']);
  });

  it('skips malformed lines rather than halting a loop over a bad log line', () => {
    writeFileSync(log, ['garbage', at('2026-08-25T15:30:00.000Z', 'ward', 'NaN'), at('2026-08-25T15:31:00.000Z', 'ward', '2.00'), ''].join('\n'));
    expect(burnWindow('ward', NOW, log)).toEqual({ hourUsd: 2, dayUsd: 2 });
  });

  it('keeps the last five known costs without turning unknowns into zero', () => {
    writeFileSync(log, [
      at('2026-08-25T10:00:00.000Z', 'ward', '1'),
      at('2026-08-25T11:00:00.000Z', 'ward', '?'),
      ...[2, 3, 4, 5, 6].map((cost, i) => at(`2026-08-25T1${i + 1}:30:00.000Z`, 'ward', String(cost))),
      at('2026-08-25T15:59:00.000Z', 'bosun', '99'),
      ...['0', '?', 'NaN', 'Infinity'].map((cost) => at('2026-08-25T15:59:00.000Z', 'ward', cost)),
    ].join('\n') + '\n');
    expect(recentCosts('ward', 5, log)).toEqual([3, 4, 5, 6, 0]);
  });

  it('is zero when there is no log at all', () => {
    expect(burnWindow('ward', NOW, join(home, 'absent'))).toEqual({ hourUsd: 0, dayUsd: 0 });
  });
});

describe('recentCosts anomaly baseline', () => {
  const decide = (observedUsd: number | undefined, planPointsUsed?: number, runtime: Runtime = 'claude') => {
    const costs = recentCosts('researcher', 5, log, runtime);
    return anomalyDecide({
      observedUsd,
      meanUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : 0,
      windowSize: costs.length,
      planPointsUsed,
      thresholds: { rateMultiple: 6, minUsd: 5, absPercent: 10 },
    });
  };
  const entry = (cost: number | string, runtime: Runtime = 'claude', loop = 'researcher') =>
    at('2026-08-25T15:30:00.000Z', loop, String(cost), runtime);
  const history = (lines: string[]) => writeFileSync(log, lines.join('\n') + '\n');

  it('compares alternating cheap Codex probes and $5–13 Claude sessions on their own runtimes', () => {
    const lines: string[] = [];
    for (const cost of [5, 6, 7, 8, 9, 10, 13]) {
      history(lines);
      expect(decide(0.002, undefined, 'codex')).toEqual({ act: 'ok' });
      lines.push(entry(0.002, 'codex'));
      history(lines);
      expect(decide(cost)).toEqual({ act: 'ok' });
      lines.push(entry(cost));
    }
    // Filter before limiting: even five later probes cannot evict Claude work.
    history([...lines, ...Array.from({ length: 5 }, () => entry(0.002, 'codex')), entry(999, 'claude', 'other')]);
    expect(recentCosts('researcher', 5, log, 'claude')).toEqual([7, 8, 9, 10, 13]);
    expect(recentCosts('researcher', 5, log, 'codex')).toEqual(Array(5).fill(0.002));
    expect(recentCosts('researcher', 2, log, 'claude')).toEqual([10, 13]);
    expect(recentCosts('researcher', 0, log, 'claude')).toEqual([]);
    expect(decide(13)).toEqual({ act: 'ok' });
  });

  it('still trips above the 6x same-runtime mean despite expensive foreign history', () => {
    history([6, 7, 8, 9, 10].flatMap(cost => [entry(cost), entry(100, 'codex')])); // Claude mean $8
    expect(decide(48)).toEqual({ act: 'ok' });
    expect(decide(48.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
    expect(decide(4.99, 10.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
  });

  it.each(['empty', 'other runtime', 'unknown cost', 'missing runtime'])('keeps %s history without a same-runtime baseline', (kind) => {
    const histories: Record<string, string[]> = {
      empty: [],
      'other runtime': [entry(0.002, 'codex')],
      'unknown cost': ['?', 'NaN', 'Infinity'].map(cost => entry(cost)),
      'missing runtime': [entry(1).replace(' runtime=claude', '')],
    };
    history(histories[kind]!);
    expect(recentCosts('researcher', 5, log, 'claude')).toEqual([]);
    expect(decide(100)).toEqual({ act: 'ok' });
    expect(decide(100, 10.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
  });

  it('handles legacy lines safely while preserving the unfiltered API and burn totals', () => {
    history([entry(2).replace(' runtime=claude', ''), entry(3), entry(4, 'codex')]);
    expect(recentCosts('researcher', 5, log)).toEqual([2, 3, 4]);
    expect(recentCosts('researcher', 5, log, 'claude')).toEqual([3]);
    expect(burnWindow('researcher', NOW, log)).toEqual({ hourUsd: 9, dayUsd: 9 });
  });

  it('retains known zeros so skipping them cannot hide a same-runtime spike', () => {
    history([1, 0, 0, 0, 0].map(cost => entry(cost)));
    expect(recentCosts('researcher', 5, log, 'claude')).toEqual([1, 0, 0, 0, 0]);
    expect(decide(5)).toMatchObject({ act: 'trip', kind: 'anomaly' });
    expect(decide(4.99)).toEqual({ act: 'ok' });
    history(Array.from({ length: 6 }, () => entry(0)));
    expect(recentCosts('researcher', 5, log, 'claude')).toEqual([0, 0, 0, 0, 0]);
    expect(decide(100)).toEqual({ act: 'ok' });
    expect(decide(100, 10.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
  });

  it('never rounds small known costs or invents costs for a missing log or unknown readings', () => {
    expect(recentCosts('researcher', 5, log, 'claude')).toEqual([]);
    expect(decide(100)).toEqual({ act: 'ok' });
    expect(decide(100, 10.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
    history([entry(0.002197), ...['?', 'NaN', 'Infinity'].map(cost => entry(cost))]);
    expect(recentCosts('researcher', 5, log, 'claude')).toEqual([0.002197]);
    expect(decide(5.14767)).toMatchObject({ act: 'trip', kind: 'anomaly' });
    expect(decide(4.99)).toEqual({ act: 'ok' });
    expect(decide(undefined)).toEqual({ act: 'ok' });
  });
});
