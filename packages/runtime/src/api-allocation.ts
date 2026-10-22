// Durable, opt-in native API admission. Local accounting, not an invoice cap.
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, isAbsolute, parse } from 'node:path';
import type { ClaudeApiConfig } from './claude-api.js';

export interface ApiAllocation {
  version: 1;
  id: string;
  consumer: string;
  provider: string;
  helper_sha256: string;
  stop_at: string;
  reserve_usd: number;
  stop_estimate_usd: number;
  estimate_multiplier: number;
  max_budget_usd: number;
  max_turns: number;
  timeout_seconds: number;
}
interface Reservation { kind: 'reserve'; run: string; consumer: string; reserve_usd: number; at: string }
interface Settlement { kind: 'settle'; run: string; cost_usd: number; source: 'cli' | 'reconciled'; evidence: string; at: string }
interface Header { kind: 'allocation'; sha256: string }
type Entry = Reservation | Settlement | Header;
export interface Admission { file: string; sha256: string; run: string }
const hash = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
export const helperDigest = hash;
const fail = (message: string): never => { throw new Error(`API allocation: ${message}`); };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const instant = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s));
const keys = (value: unknown, expected: string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(',') === expected.sort().join(',');
};

// Never follow a symlink in allocation state. As with existing Runtime state,
// this is an owner-operated same-user boundary, not hostile-user authentication.
function checkPath(file: string, directory = false): void {
  if (!isAbsolute(file) || resolve(file) !== file) fail('state path must be absolute and normalized');
  const root = parse(file).root;
  let current = root;
  for (const part of file.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const st = lstatSync(current);
    if (st.isSymbolicLink()) fail('symlinked state refused');
    if (current !== file && !st.isDirectory()) fail('state parent is not a directory');
    if (current === file && !(directory ? st.isDirectory() : st.isFile())) fail('invalid state file type');
  }
}
function read(file: string): string {
  checkPath(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
function plan(file: string): { allocation: ApiAllocation; sha256: string } {
  const bytes = read(file);
  const p: unknown = JSON.parse(bytes);
  if (!keys(p, ['version', 'id', 'consumer', 'provider', 'helper_sha256', 'stop_at', 'reserve_usd', 'stop_estimate_usd', 'estimate_multiplier', 'max_budget_usd', 'max_turns', 'timeout_seconds'])) fail('malformed plan');
  const a = p as unknown as ApiAllocation;
  if (a.version !== 1 || ![a.id, a.consumer, a.provider].every(s => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(s)) || !/^[a-f0-9]{64}$/.test(a.helper_sha256) || !instant(a.stop_at)) fail('invalid identity or expiry');
  for (const n of [a.reserve_usd, a.stop_estimate_usd, a.estimate_multiplier, a.max_budget_usd, a.max_turns, a.timeout_seconds]) if (!finite(n) || n <= 0) fail('invalid limits');
  if (a.estimate_multiplier < 1 || !Number.isSafeInteger(a.max_turns) || a.timeout_seconds > 2_147_483 || a.reserve_usd < a.max_budget_usd * a.estimate_multiplier) fail('invalid reservation limits');
  return { allocation: a, sha256: hash(bytes) };
}
function ledger(file: string, sha256: string): { entries: Entry[]; spent: number; held: number } {
  const raw = read(join(dirname(file), 'runs.jsonl'));
  if (!raw.endsWith('\n')) fail('missing or interrupted receipt');
  const rows: unknown[] = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  if (!keys(rows[0], ['kind', 'sha256']) || rows[0].kind !== 'allocation' || rows[0].sha256 !== sha256) fail('allocation header changed or missing');
  const runs = new Map<string, Reservation>();
  const settled = new Set<string>();
  let spent = 0;
  for (const row of rows.slice(1)) {
    if (!row || typeof row !== 'object') fail('malformed receipt');
    const e = row as Entry;
    if (e.kind === 'reserve' && keys(e, ['kind', 'run', 'consumer', 'reserve_usd', 'at']) && typeof e.run === 'string' && /^[a-f0-9-]{36}$/.test(e.run) && typeof e.consumer === 'string' && finite(e.reserve_usd) && e.reserve_usd > 0 && instant(e.at) && !runs.has(e.run)) {
      // Only one unresolved session is ever legal.
      if ([...runs.keys()].some(run => !settled.has(run))) fail('overlapping reservation receipts');
      runs.set(e.run, e);
    } else if (e.kind === 'settle' && keys(e, ['kind', 'run', 'cost_usd', 'source', 'evidence', 'at']) && runs.has(e.run) && !settled.has(e.run) && finite(e.cost_usd) && ['cli', 'reconciled'].includes(e.source) && typeof e.evidence === 'string' && e.evidence.trim() && instant(e.at)) {
      settled.add(e.run);
      spent += e.cost_usd;
      if (!Number.isFinite(spent)) fail('receipt total overflow');
    } else fail('malformed, duplicate or orphan receipt');
  }
  const held = [...runs.values()].filter(e => !settled.has(e.run)).reduce((n, e) => n + e.reserve_usd, 0);
  return { entries: rows as Entry[], spent, held };
}
function lock<T>(file: string, fn: () => T): T {
  checkPath(dirname(file), true);
  const path = join(dirname(file), 'admission.lock');
  // Exclusive, no stale-lock auto-removal. A killed writer needs reconciliation.
  mkdirSync(path, { mode: 0o700 });
  try { return fn(); } finally { rmdirSync(path); }
}
function append(file: string, entry: Entry): void {
  const target = join(dirname(file), 'runs.jsonl');
  checkPath(target);
  const fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try { writeFileSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

export function reserveApiRun(file: string, consumer: string, provider: string, config: ClaudeApiConfig, now = Date.now()): Admission {
  return lock(file, () => {
    const { allocation: a, sha256 } = plan(file);
    if (a.consumer !== consumer || a.provider !== provider || a.helper_sha256 !== hash(config.api_key_helper) || a.max_budget_usd !== config.max_budget_usd || a.max_turns !== config.max_turns || a.timeout_seconds !== config.timeout_seconds || a.stop_at !== config.stop_at) fail('consumer or provider configuration does not match allocation');
    const checkedAt = Math.max(now, Date.now());
    if (checkedAt >= Date.parse(a.stop_at)) fail('expired');
    const { entries, spent, held } = ledger(file, sha256);
    const reservation = a.max_budget_usd * a.estimate_multiplier;
    for (const e of entries) if (e.kind === 'reserve' && (e.consumer !== consumer || e.reserve_usd !== reservation)) fail('reservation differs from allocation');
    if (held > 0) fail('unsettled usage; reconcile before admission');
    if (spent >= a.stop_estimate_usd || spent * a.estimate_multiplier + reservation > a.reserve_usd) fail('exhausted');
    const run = randomUUID();
    append(file, { kind: 'reserve', run, consumer, reserve_usd: reservation, at: new Date(checkedAt).toISOString() });
    return { file, sha256, run };
  });
}

export function settleApiRun(admission: Admission, cost: number): void {
  if (!finite(cost)) fail('unknown cost');
  lock(admission.file, () => {
    const { sha256 } = plan(admission.file);
    if (sha256 !== admission.sha256) fail('plan changed during session');
    const { entries } = ledger(admission.file, sha256);
    if (!entries.some(e => e.kind === 'reserve' && e.run === admission.run) || entries.some(e => e.kind === 'settle' && e.run === admission.run)) fail('reservation missing or already settled');
    append(admission.file, { kind: 'settle', run: admission.run, cost_usd: cost, source: 'cli', evidence: 'native CLI total_cost_usd', at: new Date().toISOString() });
  });
}
