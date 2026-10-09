import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnWindow, markBurnFloor, meteredProviders, recentCosts } from '../src/burn.js';
import { anomalyDecide } from '../src/capacity.js';

const NOW = Date.parse('2026-08-25T16:00:00.000Z');
const at = (iso: string, loop: string, cost: string) =>
  `${iso} loop=${loop} runtime=claude model=claude-fable-5 tokens=1000 cost_usd=${cost}`;

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

  it('keeps the last five non-zero costs without turning unknowns into zero', () => {
    writeFileSync(log, [
      at('2026-08-25T10:00:00.000Z', 'ward', '1'),
      at('2026-08-25T11:00:00.000Z', 'ward', '?'),
      ...[2, 3, 4, 5, 6].map((cost, i) => at(`2026-08-25T1${i + 1}:30:00.000Z`, 'ward', String(cost))),
      at('2026-08-25T15:59:00.000Z', 'bosun', '99'),
      ...['0', '?', 'NaN', 'Infinity'].map((cost) => at('2026-08-25T15:59:00.000Z', 'ward', cost)),
    ].join('\n') + '\n');
    expect(recentCosts('ward', 5, log)).toEqual([2, 3, 4, 5, 6]);
  });

  it('is zero when there is no log at all', () => {
    expect(burnWindow('ward', NOW, join(home, 'absent'))).toEqual({ hourUsd: 0, dayUsd: 0 });
  });
});

describe('recentCosts anomaly baseline', () => {
  const decide = (observedUsd: number, planPointsUsed?: number) => {
    const costs = recentCosts('researcher', 5, log);
    return anomalyDecide({
      observedUsd,
      meanUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : 0,
      windowSize: costs.length,
      planPointsUsed,
      thresholds: { rateMultiple: 6, minUsd: 5, absPercent: 10 },
    });
  };
  const history = (costs: number[]) => writeFileSync(log,
    costs.map((cost) => at('2026-08-25T15:30:00.000Z', 'researcher', String(cost))).join('\n') + '\n');

  it('compares normal research sessions with the last five work costs despite zero-cost probes', () => {
    const alternating = [6, 0, 7, 0, 8, 0, 9, 0, 10, 0, 6, 0];
    history(alternating);
    expect(recentCosts('researcher', 5, log)).toEqual([7, 8, 9, 10, 6]);
    expect(decide(13)).toEqual({ act: 'ok' });

    // More idle probes must not evict work: the old last-five-line mean was
    // $1.20 here, falsely tripping a normal $13 session at over 6x.
    history([...alternating, 0, 0, 0]);
    expect(recentCosts('researcher', 5, log)).toEqual([7, 8, 9, 10, 6]);
    expect(decide(13)).toEqual({ act: 'ok' });
  });

  it('still trips above the 6x non-zero mean and preserves the strict boundary', () => {
    history([6, 0, 7, 0, 8, 0, 9, 0, 10, 0]); // mean $8
    expect(decide(48)).toEqual({ act: 'ok' });
    expect(decide(48.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
    expect(decide(4.99, 10.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
  });

  it.each([{ costs: [] }, { costs: [0, 0, 0, 0, 0, 0] }])('keeps empty/all-zero history without a rate baseline: $costs', ({ costs }) => {
    history(costs);
    expect(recentCosts('researcher', 5, log)).toEqual([]);
    expect(decide(100)).toEqual({ act: 'ok' });
    expect(decide(100, 10.01)).toMatchObject({ act: 'trip', kind: 'anomaly' });
  });

  it('does not round small known costs down to zero or invent a baseline for a missing log', () => {
    expect(recentCosts('researcher', 5, log)).toEqual([]);
    expect(decide(100)).toEqual({ act: 'ok' });
    history([0, 0.002197, 0]);
    expect(recentCosts('researcher', 5, log)).toEqual([0.002197]);
    expect(decide(5.14767)).toMatchObject({ act: 'trip', kind: 'anomaly' });
    expect(decide(4.99)).toEqual({ act: 'ok' });
  });
});
