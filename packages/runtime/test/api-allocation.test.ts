import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { reserveApiRun, settleApiRun, helperDigest, type ApiAllocation } from '../src/api-allocation.js';
import type { ClaudeApiConfig } from '../src/claude-api.js';
let dir: string, file: string;
const config: ClaudeApiConfig = { api_key_helper: 'printf synthetic-key', max_budget_usd: 5, max_turns: 100, timeout_seconds: 900, stop_at: '2099-01-01T00:00:00Z' };
const allocation: ApiAllocation = { version: 1, id: 'test-allocation', consumer: 'api-worker', provider: 'claude-api', helper_sha256: helperDigest(config.api_key_helper), stop_at: config.stop_at!, reserve_usd: 150, stop_estimate_usd: 25, estimate_multiplier: 5, max_budget_usd: 5, max_turns: 100, timeout_seconds: 900 };
function provision(a = allocation) {
  const bytes = JSON.stringify(a);
  writeFileSync(file, bytes, { mode: 0o600 });
  writeFileSync(join(dir, 'runs.jsonl'), JSON.stringify({ kind: 'allocation', sha256: createHash('sha256').update(bytes).digest('hex') })+'\n', { mode: 0o600 });
}
const reserve = () => reserveApiRun(file, allocation.consumer, allocation.provider, config);
function processRun(cost?: number) {
  const module = resolve('src/api-allocation.ts');
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {reserveApiRun,settleApiRun} from ${JSON.stringify(module)};const a=reserveApiRun(${JSON.stringify(file)},'api-worker','claude-api',${JSON.stringify(config)});${cost === undefined ? 'process.kill(process.pid,"SIGKILL");' : `settleApiRun(a,${cost});`}`], { encoding: 'utf8' });
}
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'rev-allocation-'))); file = join(dir, 'allocation.json'); provision(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
describe('durable native API allocation', () => {
  it('accumulates across fresh processes and stops at the same threshold', () => {
    for (let i = 0; i < 5; i++) expect(processRun(5).status).toBe(0);
    expect(processRun(0).status).not.toBe(0);
    expect(() => reserve()).toThrow(/exhausted/);
    expect(readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(11);
  });
  it('allows one nominal session crossing the estimate threshold', () => {
    settleApiRun(reserve(), 24); settleApiRun(reserve(), 5);
    expect(() => reserve()).toThrow(/exhausted/);
  });
  it('counts the reserve envelope independently of the checkpoint', () => {
    provision({ ...allocation, reserve_usd: 25 }); settleApiRun(reserve(), 1);
    expect(() => reserve()).toThrow(/exhausted/);
  });
  it('crash before receipt retains the reservation and refuses a restarted consumer', () => {
    expect(processRun().signal).toBe('SIGKILL');
    expect(processRun(0).stderr).toMatch(/unsettled/);
    expect(() => reserve()).toThrow(/unsettled/);
  });
  it('refuses overlap and foreign consumers', () => {
    const first = reserve();
    expect(() => reserve()).toThrow(/unsettled/);
    expect(() => reserveApiRun(file, 'other-worker', 'claude-api', config)).toThrow(/does not match/);
    settleApiRun(first, 1); expect(reserve().run).not.toBe(first.run);
  });
  it('never resets missing, partial or malformed receipts', () => {
    rmSync(join(dir, 'runs.jsonl')); expect(() => reserve()).toThrow();
    provision(); appendFileSync(join(dir, 'runs.jsonl'), '{'); expect(() => reserve()).toThrow(/interrupted/);
    provision(); appendFileSync(join(dir, 'runs.jsonl'), '{bad}\n'); expect(() => reserve()).toThrow();
    provision(); appendFileSync(join(dir, 'runs.jsonl'), JSON.stringify({ kind: 'settle', run: 'missing', cost_usd: 0, source: 'cli', evidence: 'test', at: new Date().toISOString() })+'\n'); expect(() => reserve()).toThrow(/orphan/);
  });
  it('rejects invalid costs, duplicate settlement, and altered allocation', () => {
    const first = reserve();
    expect(() => settleApiRun(first, NaN)).toThrow(/unknown/);
    expect(() => settleApiRun(first, -1)).toThrow(/unknown/);
    settleApiRun(first, 1); expect(() => settleApiRun(first, 1)).toThrow(/already settled/);
    writeFileSync(file, JSON.stringify({ ...allocation, reserve_usd: 200 })); expect(() => reserve()).toThrow(/header changed/);
  });
  it('expiry and configuration drift refuse admission', () => {
    expect(() => reserveApiRun(file, allocation.consumer, allocation.provider, config, Date.parse(config.stop_at!))).toThrow(/expired/);
    expect(() => reserveApiRun(file, allocation.consumer, allocation.provider, { ...config, max_budget_usd: 6 })).toThrow(/does not match/);
  });
  it('does not automatically clear a crashed lock or follow symlink state', () => {
    mkdirSync(join(dir, 'admission.lock')); expect(() => reserve()).toThrow();
    rmSync(join(dir, 'admission.lock'), { recursive: true }); rmSync(join(dir, 'runs.jsonl'));
    symlinkSync(file, join(dir, 'runs.jsonl')); expect(() => reserve()).toThrow(/symlink/);
  });
  it('owner reconciliation preserves the same allocation and resumes from known cost', () => {
    const first = reserve();
    appendFileSync(join(dir, 'runs.jsonl'), JSON.stringify({ kind: 'settle', run: first.run, cost_usd: 24, source: 'reconciled', evidence: 'H-test provider usage and session absence verified', at: new Date().toISOString() })+'\n');
    settleApiRun(reserve(), 5); expect(() => reserve()).toThrow(/exhausted/);
  });
});
