// The Team projection: what each seat is configured to carry into a session,
// and what its sessions have spent.
//
// Both halves read records that already exist. The context inventory measures
// the files the roster itself names — the constitution the shim writes to
// `--append-system-prompt-file` and each roster skill appended after it
// (`systemPrompt` in shim.ts is the same composition) — so this is an account
// of configuration, never of a live session's observed window. The spend half
// windows the append-only token-log, the same file `burn.ts` reads for the
// breaker.
//
// Three distinctions the surface above this must not collapse, because each
// was a way to mislead:
//   - COMPOSED vs DISCOVERED. Rev writes the constitution and the skills; the
//     CLI finds the working tree's own instruction files for itself. Measured
//     the same way, attributed differently.
//   - AVAILABLE vs LOADED. A seat's memory corpus is read on demand, a file at
//     a time. Counting it as startup context would overstate every seat by an
//     order of magnitude.
//   - MEASURED vs UNMEASURED. The CLI's own system prompt, its tool schemas
//     and the iteration prompt are real tokens nobody here can count. They are
//     named in `unmeasured` rather than left to read as zero.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Tiktoken } from 'js-tiktoken';
import { loadRoster, tokenLogPath, type Roster } from './config.js';
import type { LoopConfig } from './types.js';

/** The tokenizer, named wherever a token figure is shown. Not Anthropic's own
 *  — none is published offline — and the same encoding the estate's context
 *  check uses, so one file never reports two different sizes on two surfaces. */
export const TOKENIZER = 'js-tiktoken o200k_base';

// ~20MB of BPE ranks. Loaded on the first measurement, so `rev status` and
// every other command that never asks for context pays nothing for it.
let encoding: Tiktoken | undefined;
async function tokenizer(): Promise<Tiktoken> {
  if (!encoding) {
    const { getEncoding } = await import('js-tiktoken');
    encoding = getEncoding('o200k_base');
  }
  return encoding;
}

/** A cap is a ceiling that must never be met mid-task rather than a target, so
 *  a file past three quarters of its cap is reported `tight`: under cap, but
 *  close enough that the next edit breaches during a session. The fraction is
 *  the estate context check's own working level — the two surfaces agree or a
 *  file is "ok" on one page and "tight" on the other. */
export const WORKING_LEVEL = 0.75;

export type FileState = 'ok' | 'tight' | 'over' | 'uncapped' | 'unreadable';

/** The most of a file this surface will read. Configured context is instruction
 *  prose — the largest thing in this installation's inventory is 14KB — so a
 *  ceiling here costs nothing real and bounds what one request can pull into
 *  memory. */
export const MEASURE_BYTE_CEILING = 1_048_576;

/** The most tokenizer work one file may be worth, as the sum of the squares of
 *  its chunks' byte lengths (see `tokenizeWork`).
 *
 *  js-tiktoken's BPE merge loop is quadratic in the UTF-8 byte length of a
 *  single chunk, so a file's cost tracks that sum. Measured on this encoding,
 *  the quadratic term is 30-90ms per million, holding across every shape tried:
 *  16KB of one character (268m, 22.4s), 32KB of spaces (1,074m, 94s), 256KB in
 *  1KB runs (263m, 22.6s), 16KB of U+3000/LF (256m, 18.6s), 24KB of NBSP/LF
 *  (576m, 17.2s), 1,400 CJK letters (18m, 0.9s).
 *
 *  A byte ceiling alone does not bound this — 256KB whose every run is 1KB
 *  still costs 22s — so the ceiling is on the work. At four million it refuses
 *  anything whose merge loops would hold the event loop past ~360ms, and
 *  admits around 770KB of ordinary prose; this installation's worst real file
 *  measures far under it (H-3004, H-3007).
 *
 *  The other term is per chunk rather than quadratic, ~1-2us, and is what
 *  MEASURE_BYTE_CEILING bounds: a megabyte of prose is 250,000 chunks. */
export const TOKENIZE_WORK_CEILING = 4_000_000;

/** The most tokenizer work one DOCUMENT may be worth, in the same units.
 *
 *  TOKENIZE_WORK_CEILING bounds a file; nothing bounded the document, and the
 *  document is what a request waits for. The Team document measures every
 *  inventoried file of every seat, so an installation's seat count multiplies
 *  whatever the per-file ceiling admits: ten seats sharing six worst-admitted
 *  files held /api/v1/team 14.6s and blocked /api/v1/overview behind it, on
 *  every poll, which is past this surface's own 10s deadline (H-3011, measured
 *  by ward on H-3007's PASS).
 *
 *  Six worst-admitted files is where ward measured 1.4s, and the quadratic
 *  term's 30-90ms per million puts the same figure at 1.4-2.2s, so the budget
 *  is six of them. This installation's whole document is 361,534 — a
 *  sixty-sixth of it, with every seat's shared ancestor counted once — so no
 *  real document is anywhere near being cut. */
export const TOKENIZE_DOCUMENT_BUDGET = 24_000_000;

/** One document build's measurement state, threaded through every `measure`
 *  call that belongs to it.
 *
 *  It does two things the per-file ceiling cannot. It measures each unique path
 *  ONCE: `crew:AGENTS.md` is in all ten seats' walks, so the live document was
 *  tokenizing it ten times per request (24 measures, 13 unique files). And it
 *  spends `TOKENIZE_DOCUMENT_BUDGET` across the whole document rather than per
 *  file.
 *
 *  Measurements run one at a time, in the order they are asked for. The budget
 *  is the reason: `encode` is synchronous, so concurrency bought nothing here
 *  anyway, and under `Promise.all` every file would read `work` as 0 before any
 *  other had spent any — a budget nothing could ever exceed. Taking a turn is
 *  what makes the figure each file checks the real one. */
export interface MeasurePass {
  /** Keyed on the resolved path, holding the in-flight promise so concurrent
   *  callers share one measurement instead of racing to a second one. */
  files: Map<string, Promise<MeasuredFile>>;
  /** Work already spent on files admitted in this document. */
  work: number;
  budget: number;
  /** The chain measurements queue behind, so each sees `work` as it stands. */
  turn: Promise<unknown>;
}

export function measurePass(budget = TOKENIZE_DOCUMENT_BUDGET): MeasurePass {
  return { files: new Map(), work: 0, budget, turn: Promise.resolve() };
}

let pattern: RegExp | undefined;

/** The chunk pattern this encoding splits on before any merging, taken from the
 *  encoder itself.
 *
 *  Taken, not copied: a bound computed over a different split is not a bound at
 *  all. The first version of this guard measured whitespace-delimited runs,
 *  classifying whitespace as space, tab, CR and LF. But the pattern's
 *  `\s*[\r\n]+` branch uses `\s`, so text alternating U+3000 (or NBSP, or
 *  U+2028) with LF is ONE chunk where that estimate saw runs of one character:
 *  16KB of it passed the ceiling and held the member route 39 seconds, with
 *  /api/v1/overview blocked behind it (H-3007). Any hand-written split has that
 *  failure mode, one Unicode class at a time. This one cannot: it is the same
 *  regex `encode` runs.
 *
 *  `patStr` is js-tiktoken's own internal field and not in its published types,
 *  so a version that stops exposing it must fail loudly here rather than fall
 *  back to a guess. `tokenizeWork`'s callers report the file unreadable. */
export async function chunkPattern(): Promise<RegExp> {
  if (!pattern) {
    const internal = (await tokenizer()) as unknown as { patStr?: unknown };
    if (typeof internal.patStr !== 'string') {
      throw new Error(`${TOKENIZER} did not expose the chunk pattern this surface bounds its work with, so no token count can be claimed.`);
    }
    pattern = new RegExp(internal.patStr, 'ug');
  }
  return pattern;
}

/** The sum of the squares of the UTF-8 byte lengths of the chunks `pattern`
 *  makes: what the tokenizer's cost is proportional to.
 *
 *  One linear pass. Under 50ms on a megabyte of prose, and under 6ms on a
 *  megabyte that is one chunk — the shapes that cost the encoder minutes are
 *  the cheapest to refuse.
 *
 *  Bytes, not characters: the merge loop works on the UTF-8 encoding, so 1,400
 *  CJK letters are 4,200 bytes and cost nine times what their character count
 *  would predict. */
export function tokenizeWork(text: string, chunks: RegExp): number {
  let sum = 0;
  for (const match of text.matchAll(chunks)) {
    const bytes = Buffer.byteLength(match[0], 'utf8');
    sum += bytes * bytes;
  }
  return sum;
}

export type BoundedRead =
  | { ok: true; text: string; bytes: number; truncated: boolean }
  | { ok: false; bytes: number; error: string };

/** Read at most `limit` bytes of a regular file, refusing anything that is not
 *  one.
 *
 *  The inventory this serves includes every CLAUDE.md and AGENTS.md found
 *  walking up from a seat's working directory — files no roster entry names, in
 *  trees any agent on this machine can write. So the open itself has to be the
 *  guard rather than a stat a later open could race:
 *
 *  - `O_NOFOLLOW` makes the kernel refuse a symbolic link, so a planted
 *    `AGENTS.md -> somewhere/else` is reported as a link instead of rendering
 *    the target's body on the operator's dashboard.
 *  - `O_NONBLOCK` keeps a fifo from parking the open. A fifo named `AGENTS.md`
 *    in a seat's cwd froze every route of the app — this read is synchronous,
 *    and `/api/v1/team` does it once per seat.
 *  - `fstat` on the open descriptor is what decides: a regular file, or named
 *    rather than read.
 *
 *  Found by the H-3004 containment review. */
export function readBounded(path: string, limit: number): BoundedRead {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      const kind = stat.isDirectory() ? 'a directory' : stat.isFIFO() ? 'a fifo' : stat.isSocket() ? 'a socket' : 'not a regular file';
      return { ok: false, bytes: 0, error: `This path is ${kind}, so it is named here rather than read.` };
    }
    const want = Math.min(stat.size, limit);
    const buffer = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, read);
      if (n === 0) break;
      read += n;
    }
    return { ok: true, text: buffer.subarray(0, read).toString('utf8'), bytes: stat.size, truncated: stat.size > read };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ELOOP') return { ok: false, bytes: 0, error: 'This path is a symbolic link, which is not followed here; the CLI reading it may still follow it.' };
    return { ok: false, bytes: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface MeasuredFile {
  path: string;
  name: string;
  bytes: number;
  tokens: number;
  /** From the file's own `cap_tokens` front matter; null when it declares none. */
  cap: number | null;
  state: FileState;
  /** Why the file could not be measured. Present only when state is 'unreadable'. */
  error?: string;
}

function frontMatterCap(text: string): number | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const line = text.slice(4, end).split('\n').find((l) => /^cap_tokens:/.test(l));
  if (!line) return null;
  const n = Number(line.slice('cap_tokens:'.length).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Measure one file as part of a document, once.
 *
 *  The key is `resolve`, which normalizes `.`, `..` and repeated separators
 *  without touching the filesystem. Deliberately NOT `realpath`: that would
 *  collapse a symlink onto its target, and then whichever of the two a seat
 *  asked for first would answer for both — so a planted link could be served
 *  the real file's token count, which is the one thing `readBounded`'s
 *  `O_NOFOLLOW` exists to refuse. Two spellings that reach the same file
 *  through a symlinked directory are measured twice; that costs a measurement
 *  and tells no lie. */
async function measure(path: string, pass: MeasurePass): Promise<MeasuredFile> {
  const key = resolve(path);
  const already = pass.files.get(key);
  if (already) return already;
  const result = (async () => {
    await pass.turn;
    return measureOne(key, pass);
  })();
  // The chain must not carry a rejection: one file that somehow threw would
  // otherwise reject every file queued behind it. `measureOne` reports rather
  // than throws, so this is a guard, not a path we expect to take.
  pass.turn = result.then(() => undefined, () => undefined);
  pass.files.set(key, result);
  return result;
}

async function measureOne(path: string, pass: MeasurePass): Promise<MeasuredFile> {
  const name = path.split('/').pop() ?? path;
  // An unmeasurable file is reported as unreadable with the reason, never as a
  // zero that would quietly shrink the total it belongs to.
  const unreadable = (bytes: number, error: string): MeasuredFile =>
    ({ path, name, bytes, tokens: 0, cap: null, state: 'unreadable', error });
  const read = readBounded(path, MEASURE_BYTE_CEILING);
  if (!read.ok) return unreadable(read.bytes, read.error);
  if (read.truncated) {
    return unreadable(read.bytes, `${read.bytes.toLocaleString('en-US')} bytes is past the ${MEASURE_BYTE_CEILING.toLocaleString('en-US')}-byte ceiling this surface measures, so no token count is claimed for it.`);
  }
  // Everything the tokenizer touches is inside this try. A file that cannot be
  // measured is reported unreadable; it must not be able to throw out of here
  // and take the whole page — which is a route an agent that can write a seat's
  // working tree would otherwise have. The special-token case was exactly that:
  // `encode` refuses by default on text containing `<|endoftext|>`, so one
  // sentence in any discovered CLAUDE.md answered the Team routes a 500.
  try {
    const work = tokenizeWork(read.text, await chunkPattern());
    if (work > TOKENIZE_WORK_CEILING) {
      // Not a shape instruction prose takes: chunks long enough that the merge
      // loop over them would hold the event loop for everyone, whatever the
      // file's size. Named, not counted.
      return unreadable(read.bytes, `Its ${read.bytes.toLocaleString('en-US')} bytes are chunked too coarsely to tokenize within this surface's time ceiling, so no token count is claimed for it.`);
    }
    // Refused by the file ceiling above does not spend the document's budget:
    // nothing was tokenized. Admitted does, before the encode rather than
    // after, because the budget is permission to spend it.
    if (pass.work + work > pass.budget) {
      return unreadable(read.bytes, `This document has already spent its ${pass.budget.toLocaleString('en-US')}-unit tokenizer budget on the files measured before it, so no token count is claimed for this one.`);
    }
    pass.work += work;
    const cap = frontMatterCap(read.text);
    // `([], [])` — no special token is allowed, and none is disallowed either,
    // so `<|endoftext|>` in instruction prose is counted as the text it is
    // rather than refused.
    const tokens = (await tokenizer()).encode(read.text, [], []).length;
    return {
      path, name, tokens, cap,
      bytes: read.bytes,
      state: cap === null ? 'uncapped' : tokens > cap ? 'over' : tokens > Math.round(cap * WORKING_LEVEL) ? 'tight' : 'ok',
    };
  } catch (e) {
    return unreadable(read.bytes, `${TOKENIZER} could not measure this file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The instruction files the runtime's CLI discovers for itself by walking up
 *  from the session's working directory. Rev composes none of this — which is
 *  why it is reported apart from what it does compose — but it is the largest
 *  measurable thing a seat carries that its own profile does not mention, and
 *  reporting the profile alone made a seat look an order of magnitude lighter
 *  than it is. The walk stops at the enclosing repository, or at home when the
 *  tree is not a repository: a session's working tree is the boundary we can
 *  state, and anything above it belongs to the operator's machine rather than
 *  to the seat. */
const INSTRUCTION_FILE: Record<string, string[]> = {
  claude: ['CLAUDE.md', 'AGENTS.md'],
  codex: ['AGENTS.md'],
};

export function workingTreeInstructions(cwd: string, runtime: string): string[] {
  const names = INSTRUCTION_FILE[runtime];
  if (!names || !existsSync(cwd)) return [];
  const stop = homedir();
  const found: string[] = [];
  let dir = cwd;
  for (;;) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) found.push(p);
    }
    if (existsSync(join(dir, '.git'))) break;
    const up = dirname(dir);
    if (up === dir || dir === stop) break;
    dir = up;
  }
  return found;
}

export interface SeatContext {
  /** What Rev writes into the session's system prompt, byte for byte. */
  composed: { profile: MeasuredFile | null; skills: MeasuredFile[]; tokens: number };
  /** What the runtime's CLI finds in the working tree. Measured, not composed. */
  discovered: { files: MeasuredFile[]; tokens: number; note: string };
  /** Read a file at a time during a session. Never part of the startup total. */
  memory: { configured: boolean; index: MeasuredFile | null; files: number; tokens: number; note: string };
  /** composed + discovered. The startup reading, and the only total shown. */
  startup_tokens: number;
  /** No whole-session cap is configured anywhere, so none is invented here.
   *  A model's context window is not this number and must not be shown as it. */
  session_cap: null;
  /** Real tokens in every session that nothing here can count. */
  unmeasured: string[];
  tokenizer: string;
  measured_at: string;
}

const UNMEASURED = [
  "the CLI's own system prompt and harness instructions",
  'the tool and MCP schemas the session is given',
  "the iteration prompt Rev sends, and the session's own transcript",
];

async function memoryInventory(l: LoopConfig, pass: MeasurePass): Promise<SeatContext['memory']> {
  if (!l.memory_dir) {
    return { configured: false, index: null, files: 0, tokens: 0, note: 'No memory directory is configured for this seat in the roster.' };
  }
  let names: string[];
  try {
    names = readdirSync(l.memory_dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return { configured: true, index: null, files: 0, tokens: 0, note: `The configured memory directory cannot be read: ${l.memory_dir}` };
  }
  const indexName = names.find((n) => n === 'MEMORY.md');
  const index = indexName ? await measure(join(l.memory_dir, indexName), pass) : null;
  // Sizes come from the filesystem rather than the tokenizer: the corpus is
  // hundreds of files, it is not startup context, and tokenizing all of it per
  // request would cost more than the reading is worth. The estimate is marked
  // as one in the note the surface shows.
  let bytes = 0;
  for (const n of names) {
    // lstat, not stat: a link planted in the corpus must not contribute its
    // target's size to a figure presented as the corpus's own.
    try { const st = lstatSync(join(l.memory_dir, n)); if (st.isFile()) bytes += st.size; } catch { /* a file that vanished mid-read is not a reading */ }
  }
  return {
    configured: true, index, files: names.length,
    tokens: Math.round(bytes / 4),
    note: `${names.length} files available to read during a session, not loaded at startup. Size estimated from bytes, not tokenized.`,
  };
}

export async function seatContext(l: LoopConfig, pass: MeasurePass = measurePass()): Promise<SeatContext> {
  const profile = l.constitution ? await measure(l.constitution, pass) : null;
  const skills = await Promise.all((l.skills ?? []).map((p) => measure(p, pass)));
  const discoveredFiles = await Promise.all(workingTreeInstructions(l.cwd, l.runtime).map((p) => measure(p, pass)));
  const composedTokens = (profile?.tokens ?? 0) + skills.reduce((s, f) => s + f.tokens, 0);
  const discoveredTokens = discoveredFiles.reduce((s, f) => s + f.tokens, 0);
  return {
    composed: { profile, skills, tokens: composedTokens },
    discovered: {
      files: discoveredFiles,
      tokens: discoveredTokens,
      note: `Found by the ${l.runtime} CLI in ${l.cwd} and above it, up to the enclosing repository. Rev does not compose these.`,
    },
    memory: await memoryInventory(l, pass),
    startup_tokens: composedTokens + discoveredTokens,
    session_cap: null,
    unmeasured: UNMEASURED,
    tokenizer: TOKENIZER,
    measured_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/** The token-log line the shim appends after every session. */
const LINE = /^(\S+) loop=(\S+) runtime=(\S+) model=(\S+) tokens=(\S+) cost_usd=(\S+)/;

export const PERIODS = { '24h': 1, '7d': 7, '30d': 30, all: 0 } as const;
export type Period = keyof typeof PERIODS;

export function isPeriod(value: string | undefined): value is Period {
  // hasOwn, not `in`: `'__proto__' in PERIODS` is true, and a period that
  // resolves to a prototype member dates the window to NaN (H-3004).
  return value !== undefined && Object.hasOwn(PERIODS, value);
}

export interface SeatSpend {
  period: Period;
  since: string | null;
  tokens: number;
  usd: number;
  sessions: number;
  /** Sessions in the window whose tokens or cost the shim could not determine.
   *  Counted and shown rather than folded into the totals as zeroes. */
  unknown_sessions: number;
  by_model: { model: string; runtime: string; tokens: number; usd: number; sessions: number }[];
  /** One bucket per day of the window, oldest first — the trend, and nothing
   *  more than the daily sums the log already supports. */
  by_day: { day: string; tokens: number; usd: number }[];
}

export interface SpendBasis {
  dollars: string;
  tokens: string;
  coverage: string;
}

/** Why the dollar figures are not cash, in the terms the roster and the
 *  capacity gate already use. Three quantities this estate refuses to
 *  substitute for one another: plan capacity, notional metered equivalent, and
 *  money. The token-log carries the second (H-178). */
export function spendBasis(roster: Roster): SpendBasis {
  const subscription = Object.values(roster.providers).filter((p) => p.billing === 'subscription').map((p) => p.name);
  return {
    dollars: 'Notional, not cash. Claude figures are the CLI\'s own API-rate equivalent for a session on a flat plan; Codex figures are the roster\'s per-model prices times tokens. Neither is invoiced subscription spend.'
      + (subscription.length ? ` ${subscription.join(', ')} ${subscription.length > 1 ? 'are' : 'is'} declared subscription-billed.` : ''),
    tokens: 'Totals per session as the runtime reported them. Claude reports input plus output only, so its cache reads are not in this figure; the log keeps no input/output/cache split, so none is shown.',
    coverage: 'Metered sessions the shim recorded. Desk sessions, meetings and any run whose usage the CLI did not report are not in these numbers.',
  };
}

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function seatSpend(loop: string, period: Period, now = Date.now(), path = tokenLogPath()): SeatSpend {
  const days = PERIODS[period];
  const from = days ? now - days * 86_400_000 : 0;
  const out: SeatSpend = {
    period, since: days ? new Date(from).toISOString() : null,
    tokens: 0, usd: 0, sessions: 0, unknown_sessions: 0, by_model: [], by_day: [],
  };
  if (!existsSync(path)) return out;
  const models = new Map<string, SeatSpend['by_model'][number]>();
  const buckets = new Map<string, { tokens: number; usd: number }>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = LINE.exec(line);
    if (!m || m[2] !== loop) continue;
    const t = Date.parse(m[1]!);
    if (!Number.isFinite(t) || t < from) continue;
    out.sessions += 1;
    const tokens = Number(m[5]);
    const usd = Number(m[6]);
    // `tokens=?` and `cost_usd=?` are what the shim writes when the CLI said
    // nothing. Reading them as zero is how an unmetered session silently
    // becomes a free one.
    const knownTokens = Number.isFinite(tokens) ? tokens : 0;
    const knownUsd = Number.isFinite(usd) ? usd : 0;
    if (!Number.isFinite(tokens) || !Number.isFinite(usd)) out.unknown_sessions += 1;
    out.tokens += knownTokens;
    out.usd += knownUsd;
    const key = `${m[3]}/${m[4]}`;
    const model = models.get(key) ?? { model: m[4]!, runtime: m[3]!, tokens: 0, usd: 0, sessions: 0 };
    model.tokens += knownTokens; model.usd += knownUsd; model.sessions += 1;
    models.set(key, model);
    const d = day(t);
    const bucket = buckets.get(d) ?? { tokens: 0, usd: 0 };
    bucket.tokens += knownTokens; bucket.usd += knownUsd;
    buckets.set(d, bucket);
  }
  out.usd = Math.round(out.usd * 1e6) / 1e6;
  out.by_model = [...models.values()].sort((a, b) => b.tokens - a.tokens)
    .map((m) => ({ ...m, usd: Math.round(m.usd * 1e6) / 1e6 }));
  out.by_day = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([d, v]) => ({ day: d, tokens: v.tokens, usd: Math.round(v.usd * 1e6) / 1e6 }));
  return out;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface TeamMemberRow {
  id: string;
  name: string;
  state: string;
  workstream: string;
  runtime: string;
  model: string;
  /** Every model the roster configures this seat to select among, in its own
   *  order, and how one is chosen. A rotating seat has no single configured
   *  model, so naming the primary as "the" model beside a live state badge is
   *  how a reader concludes a running session is on a model it never ran — on
   *  this installation most seats rotate across two providers, and `by_model`
   *  in the same response records what they really ran. `model` stays the
   *  primary; this is the whole of what was configured. */
  models: string[];
  routing: 'rotation' | 'headroom';
  profile: string;
  context: SeatContext;
  spend: SeatSpend;
}

export interface TeamDocument {
  period: Period;
  periods: Period[];
  basis: SpendBasis;
  tokenizer: string;
  measured_at: string;
  loops: TeamMemberRow[];
}

/** The Team document. `state` comes from the caller because loop state is the
 *  view's own projection (sentinel precedence and pid identity), and a second
 *  derivation of it here is how two surfaces start disagreeing about whether a
 *  loop is running. */
export async function teamDocument(period: Period, state: (name: string) => string): Promise<TeamDocument> {
  const roster = loadRoster();
  // One pass for the whole document: a path several seats' walks share is
  // measured once, and the tokenizer budget is spent across all of them.
  const pass = measurePass();
  const loops = await Promise.all(Object.values(roster.loops).map(async (l) => ({
    id: l.name,
    name: l.seat ?? l.name,
    state: state(l.name),
    workstream: l.workstream,
    runtime: l.runtime,
    model: l.model,
    // `choices` is length 1 when no rotation is set, and empty only in a
    // fixture that never went through resolveSelection — fall back to the
    // primary rather than reporting a seat configured with no model at all.
    models: [...new Set(l.choices.length ? l.choices.map((c) => c.model) : [l.model])],
    routing: l.routing ?? 'rotation',
    profile: `/api/v1/team/members/${encodeURIComponent(l.name)}`,
    context: await seatContext(l, pass),
    spend: seatSpend(l.name, period),
  })));
  return {
    period,
    periods: Object.keys(PERIODS) as Period[],
    basis: spendBasis(roster),
    tokenizer: TOKENIZER,
    measured_at: new Date().toISOString(),
    loops,
  };
}
