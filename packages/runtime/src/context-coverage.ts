// Whether this installation's account of what an agent loads is still true.
//
// The Team projection (team.ts) says what the roster is CONFIGURED to supply.
// It cannot say whether that account still matches what a session was actually
// handed, and the audit behind this feature (crew:projects/r50/CONTEXT-COVERAGE.md,
// H-2952) found that it silently stops being true: a host CLI upgrade that
// renames the retained request shape, or a roster change that adds a skill,
// invalidates part of it with nothing going red. So the account needs a check
// that runs, not prose that was true once.
//
// Four distinctions this file is built around, because collapsing any of them
// is a way to claim more than the records hold:
//   - CURRENT vs HISTORICAL. `current` is composed from today's files;
//     `historical` is what one settled launch's own records say. They are
//     separate blocks and are never averaged into one verdict.
//   - SUPPORTED vs UNSUPPORTED. A path with no check stays in the reading as
//     `unsupported` with the reason. Absent would read as covered.
//   - CHANGED vs STALE. Sources that moved on since a launch are a normal
//     event (`changed`), not a broken check (`stale`). Only an assertion that
//     could not be made is stale.
//   - MATCHED vs RESEMBLING. The composition assertion is an exact byte
//     containment test over the retained prompt. It never identifies a
//     historical source by matching a first line to today's file: if the bytes
//     differ, the honest finding is that they differ, plus the evidence limit
//     on WHICH source moved (H-3581).
//
// No collector is added here. Everything read already exists: the roster, the
// launch journal, and the host CLI's own transcript.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stateDir, type Roster } from './config.js';
import { readLaunch, type LaunchJournalEntry } from './launch-journal.js';
import { serviceLabel } from './service.js';
import { skillHeader } from './shim.js';
import { MEASURE_BYTE_CEILING, measurePass, readBounded, seatContext, workingTreeInstructions, type MeasurePass, type SeatContext } from './team.js';
import type { LoopConfig } from './types.js';

/** The most of a host transcript this check reads. The launch's own request
 *  shape is written in the first few entries, and the check stops as soon as
 *  it has one — so this is the ceiling on a transcript that never contains one
 *  at all, which would otherwise be read to the end of a session's worth of
 *  tool output. */
export const HOST_RECORD_BYTE_CEILING = 4_194_304;

export type CoverageState = 'verified' | 'changed' | 'stale' | 'unsupported' | 'error';

/** What a check looked at, whether it held, and — when it did not — the
 *  instruction. The failing assertion IS the repair guidance: there is no
 *  second list to keep in step with it. */
export interface CoverageAssertion {
  id: 'provider_session_id' | 'host_record' | 'adapter_shape' | 'session_cwd' | 'composition';
  /** true held, false failed, null could not be evaluated from these records. */
  held: boolean | null;
  detail: string;
  repair?: string;
}

export interface SourceReading {
  path: string;
  role: 'constitution' | 'skill' | 'discovered';
  bytes: number;
  sha256: string | null;
  state: 'read' | 'missing' | 'unreadable' | 'too_large';
  error?: string;
}

export interface CurrentSources {
  /** Ordered exactly as `systemPrompt` composes them. */
  composed: SourceReading[];
  /** Found by the CLI itself, so Rev neither orders nor hashes them as a
   *  prompt — they are reported, not composed. */
  discovered: SourceReading[];
  /** sha256 of the exact bytes the shim would write to the prompt file today;
   *  null when a composed source could not be read, because a hash over a
   *  partial composition would compare as a difference that is not one. */
  composed_sha256: string | null;
  composed_bytes: number | null;
  /** Present instead of a hash when the composition could not be formed. */
  limit?: string;
  /** The tracking commit of each repository a composed source sits in, and
   *  whether that source is modified against it. A source version, not a
   *  release version: the installed release is reported beside it. */
  repos: { dir: string; commit: string | null; dirty: string[] }[];
  measured_at: string;
  /** team.ts's own measurement — caps, token figures, over and unreadable
   *  states — embedded rather than recomputed. A second copy of the cap rules
   *  here would be the same omission with a number on it (DEV.md, H-3009). */
  inventory?: SeatContext;
}

export interface HistoricalEvidence {
  launch_id: string;
  provider: string;
  model: string;
  started_at: string;
  ended_at: string;
  provider_session_id: string | null;
  /** The host's own account of itself, read back from its record. */
  host: { record: string | null; cli_version: string | null; cwd: string | null; retained_prompt_bytes: number | null };
}

export interface PathCoverage {
  /** Installation-qualified, because a seat name is only unique inside one.
   *  Two fleets on this machine both have a `mason`. */
  id: string;
  installation: string;
  seat: string;
  runtime: string;
  route: string;
  channels: string[];
  supported: boolean;
  state: CoverageState;
  checked_at: string;
  /** The last time every assertion held, from this path's own state file.
   *  Survives a check that fails today, which is the point of recording it. */
  last_verified_at: string | null;
  assertions: CoverageAssertion[];
  current: CurrentSources | null;
  historical: HistoricalEvidence | null;
  /** Real tokens in every session on this path that nothing here counts. */
  unmeasured: string[];
  note: string;
}

const UNMEASURED = [
  "the host CLI's own system prompt and harness instructions (retained in the host record, not ours)",
  'the tool and MCP schemas the session is given (the Claude record retains them; the Codex rollout does not)',
  'anything the session read, was handed, or kept after the host compacted it',
];

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The shape a host session id has to have before it may become part of a
 *  path. The id comes from the host CLI's own `session_id` and is a uuid, but
 *  it reaches us through this installation's launch journal, and whatever
 *  wrote that journal chose the string we are about to join onto a directory
 *  name. `../../../outside` is a session id as far as `join` is concerned
 *  (H-3599). Validating the shape costs nothing and means the only paths this
 *  module can build are the ones the host itself could have written. */
const HOST_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `~/.claude` unless the operator moved it. The host decides this, so it is
 *  read from the host's own variable rather than assumed. */
function claudeHome(): string {
  const configured = process.env['CLAUDE_CONFIG_DIR'];
  return configured && configured.trim() ? configured : join(homedir(), '.claude');
}

/** The host CLI's directory name for a working directory: every `/` and `.`
 *  becomes `-`. Lossy on purpose — it is the host's rule, not ours — which is
 *  why a session id that is not under this name is still looked for by id
 *  across the other project directories before the record is called missing.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** One read per source, and the text comes back with the reading.
 *
 *  Deliberately not two reads: reporting a source `read` from one open and
 *  composing the prompt from a second would let a file that changed between
 *  them be left out of a composition this reading calls complete. */
function readSource(path: string, role: SourceReading['role']): { source: SourceReading; text: string | null } {
  const at = (source: SourceReading): { source: SourceReading; text: null } => ({ source, text: null });
  if (!existsSync(path)) {
    return at({ path, role, bytes: 0, sha256: null, state: 'missing', error: 'The roster names this file and it is not there.' });
  }
  const read = readBounded(path, MEASURE_BYTE_CEILING);
  if (!read.ok) return at({ path, role, bytes: read.bytes, sha256: null, state: 'unreadable', error: read.error });
  if (read.truncated) {
    return at({
      path, role, bytes: read.bytes, sha256: null, state: 'too_large',
      error: `${read.bytes.toLocaleString('en-US')} bytes is past the ${MEASURE_BYTE_CEILING.toLocaleString('en-US')}-byte ceiling this check reads, so no hash is claimed for it.`,
    });
  }
  return { source: { path, role, bytes: read.bytes, sha256: sha256(read.text), state: 'read' }, text: read.text };
}

/** The bytes `systemPrompt` would write today, composed the same way but
 *  without throwing on a source that is gone.
 *
 *  `shim.systemPrompt` is the authority on the order and the framing, and
 *  `skillHeader` is imported from it rather than restated. The structure here
 *  is checked against it by a test, because two compositions that drift are
 *  how this check would start reporting a change nobody made. */
function composeToday(l: LoopConfig): { sources: SourceReading[]; text: string | null; limit?: string } {
  const constitution = readSource(l.constitution, 'constitution');
  const sources = [constitution.source];
  const parts: string[] = constitution.text === null ? [] : [constitution.text];
  for (const skill of l.skills ?? []) {
    const read = readSource(skill, 'skill');
    sources.push(read.source);
    if (read.text !== null) parts.push(`${skillHeader(skill)}${read.text}`);
  }
  const unusable = sources.filter((s) => s.state !== 'read');
  if (unusable.length) {
    return {
      sources, text: null,
      limit: `${unusable.length} of ${sources.length} composed sources could not be read (${unusable.map((s) => `${s.path}: ${s.state}`).join('; ')}), so no composition and no hash is claimed. A session launched now would fail at the same file.`,
    };
  }
  return { sources, text: parts.join('') };
}

/** The tracking commit of each repository the composed sources sit in.
 *
 *  Separate from the installed release version: a release says which Helmo is
 *  running, and this says which revision of the INSTRUCTIONS it was handed.
 *  The audit's own figures went stale on the second of those, not the first. */
function sourceRepos(sources: SourceReading[]): CurrentSources['repos'] {
  const byDir = new Map<string, string[]>();
  for (const source of sources) {
    const dir = dirname(source.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), source.path]);
  }
  const repos: CurrentSources['repos'] = [];
  for (const [dir, paths] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    let commit: string | null = null;
    let dirty: string[] = [];
    try {
      commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
      const status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no', '--', ...paths], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      dirty = status.split('\n').filter(Boolean).map((line) => line.slice(3).trim());
    } catch {
      // Not a repository, or git is unavailable. A source with no tracking
      // commit is a real state — a file on the operator's machine — and is
      // reported as `commit: null` rather than guessed at.
    }
    repos.push({ dir, commit, dirty });
  }
  return repos;
}

export function currentSources(l: LoopConfig, inventory?: SeatContext, composition?: ReturnType<typeof composeToday>): CurrentSources {
  const composed = composition ?? composeToday(l);
  return {
    composed: composed.sources,
    discovered: workingTreeInstructions(l.cwd, l.runtime).map((p) => readSource(p, 'discovered').source),
    composed_sha256: composed.text === null ? null : sha256(composed.text),
    composed_bytes: composed.text === null ? null : Buffer.byteLength(composed.text, 'utf8'),
    ...(composed.limit ? { limit: composed.limit } : {}),
    repos: sourceRepos(composed.sources.filter((s) => s.state === 'read')),
    measured_at: new Date().toISOString(),
    ...(inventory ? { inventory } : {}),
  };
}

interface HostRecord {
  path: string;
  cli_version: string | null;
  cwd: string | null;
  /** The request's system blocks, joined — the bytes the model was given
   *  before its first turn, as the host retained them. */
  prompt: string | null;
  /** Why no prompt could be taken from a record that does exist. */
  adapter?: string;
}

/** Locate and read back the host CLI's own record of one session.
 *
 *  Looked up by the session id rather than by a reconstructed directory name:
 *  the host's slug maps both `/` and `.` to `-`, so two different working
 *  directories can share one, and a check that only ever looked under the
 *  computed name would report a present record as missing. The expected name
 *  is tried first because it is one stat instead of a scan. */
export function readClaudeHostRecord(sessionId: string, cwd: string): HostRecord | null {
  if (!HOST_SESSION_ID.test(sessionId)) return null;
  const projects = join(claudeHome(), 'projects');
  const expected = join(projects, claudeProjectSlug(cwd), `${sessionId}.jsonl`);
  let file: string | null = existsSync(expected) ? expected : null;
  if (!file) {
    let dirs: string[];
    try { dirs = readdirSync(projects); } catch { return null; }
    for (const dir of dirs) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) { file = candidate; break; }
    }
  }
  if (!file) return null;
  const read = readBounded(file, HOST_RECORD_BYTE_CEILING);
  if (!read.ok) return { path: file, cli_version: null, cwd: null, prompt: null, adapter: `The host record exists and cannot be read: ${read.error}` };
  const lines = read.text.split('\n');
  // A truncated read's last line is a fragment, not an entry.
  if (read.truncated) lines.pop();
  let version: string | null = null;
  let recordedCwd: string | null = null;
  let prompt: string | null = null;
  let sawShape = false;
  for (const line of lines) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof entry['cwd'] === 'string' && recordedCwd === null) recordedCwd = entry['cwd'];
    if (typeof entry['version'] === 'string' && version === null) version = entry['version'];
    if (entry['type'] !== 'api-request-shape') continue;
    sawShape = true;
    const shape = entry['shape'];
    const system = shape && typeof shape === 'object' ? (shape as Record<string, unknown>)['system'] : undefined;
    if (!Array.isArray(system)) break;
    const texts = system.map((block) => (block && typeof block === 'object' ? (block as Record<string, unknown>)['text'] : undefined));
    if (!texts.every((t) => typeof t === 'string')) break;
    prompt = (texts as string[]).join('');
    break;
  }
  return {
    path: file, cli_version: version, cwd: recordedCwd, prompt,
    ...(prompt === null
      ? { adapter: sawShape
        ? 'The host record holds a request shape whose system blocks are not an array of text, so the prompt it was given cannot be read. The host CLI changed the shape it retains.'
        : `No request shape is retained in the first ${HOST_RECORD_BYTE_CEILING.toLocaleString('en-US')} bytes of the host record, so the prompt it was given cannot be read. The host CLI changed what it retains, or this session never reached a request.` }
      : {}),
  };
}

interface CoverageStateFile {
  format: 1;
  paths: Record<string, { last_verified_at: string; launch_id: string; composed_sha256: string | null }>;
}

function stateFile(seat: string): string {
  return join(stateDir(seat), 'context-coverage.json');
}

export function readCoverageState(seat: string): CoverageStateFile {
  const file = stateFile(seat);
  if (!existsSync(file)) return { format: 1, paths: {} };
  const read = readBounded(file, MEASURE_BYTE_CEILING);
  if (!read.ok || read.truncated) return { format: 1, paths: {} };
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (parsed && typeof parsed === 'object' && (parsed as CoverageStateFile).format === 1
      && (parsed as CoverageStateFile).paths && typeof (parsed as CoverageStateFile).paths === 'object') return parsed as CoverageStateFile;
  } catch { /* an unreadable last-check marker means the check has none */ }
  return { format: 1, paths: {} };
}

/** Record that every assertion held. This is the last SUCCESSFUL check, so a
 *  failing check deliberately writes nothing: the previous success is what
 *  tells the operator how long the account has been drifting. Losing the file
 *  costs a `last_verified_at`, not a record anything depends on, which is why
 *  it is an atomic rename and not the launch journal's fsync discipline. */
function recordVerified(seat: string, key: string, launchId: string, composedSha: string | null, at: string): void {
  const file = stateFile(seat);
  const next = readCoverageState(seat);
  next.paths[key] = { last_verified_at: at, launch_id: launchId, composed_sha256: composedSha };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`);
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing partial is left behind */ }
  }
}

/** Every runtime this seat can actually launch under — the rotation and its
 *  fallbacks, not just the primary. A seat configured `runtime: codex` with a
 *  claude choice in its rotation runs sessions on BOTH routes, and reporting
 *  only the primary is how the inventory came to omit a file every Claude run
 *  receives (CONTEXT-COVERAGE.md, correction 1). */
export function pathRuntimes(l: LoopConfig): string[] {
  const seen = new Set<string>([l.runtime]);
  for (const choice of [...(l.choices ?? []), ...(l.fallbacks ?? [])]) seen.add(choice.runtime);
  return [...seen].sort();
}

/** The provider NAMES that reach one adapter for this seat.
 *
 *  The journal records `session.provider`, which is the roster's provider
 *  entry, not the adapter. They are the same word for the two providers Rev
 *  ships, and they are not for a provider entry that names its own runtime —
 *  a Claude-API provider, say. Taking the set from the seat's own choices is
 *  what keeps "this path has never run" from being said about a path that has
 *  run under a differently named provider. */
export function pathProviders(l: LoopConfig, runtime: string): string[] {
  const names = new Set<string>();
  if (l.runtime === runtime) names.add(runtime);
  for (const choice of [...(l.choices ?? []), ...(l.fallbacks ?? [])]) {
    if (choice.runtime === runtime) names.add(choice.provider);
  }
  return [...names].sort();
}

/** The most recent settled launch for a seat under any of these providers,
 *  with a session result to read. A dispatching entry carries no session id:
 *  a live run cannot be checked, and that is a limit of the records rather
 *  than a fault. */
export function latestSettledLaunch(seat: string, providers: string[]): LaunchJournalEntry | null {
  const dir = join(stateDir(seat), 'launches');
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return null; }
  let best: LaunchJournalEntry | null = null;
  for (const name of names) {
    const read = readBounded(join(dir, name), MEASURE_BYTE_CEILING);
    if (!read.ok || read.truncated) continue;
    let entry: LaunchJournalEntry;
    try { entry = JSON.parse(read.text) as LaunchJournalEntry; } catch { continue; }
    if (entry.format !== 1 || !entry.session || !providers.includes(entry.session.provider)) continue;
    if (!best || entry.session.ended_at > best.session!.ended_at) best = entry;
  }
  return best;
}

const ROUTE_CLAUDE = 'The constitution and each roster skill are composed into one file and passed as `--append-system-prompt-file`; the iteration prompt goes as `-p`; the MCP table is a temp file under `--strict-mcp-config`. The temp directory is deleted when the run ends, so the host record is the only copy of the bytes afterwards.';
const ROUTE_CODEX = 'The same composition and the iteration prompt are joined by `--- Iteration prompt ---` and written to the CLI\'s stdin.';

function unsupportedPath(l: LoopConfig, runtime: string, installation: string, why: string): PathCoverage {
  return {
    id: `${installation}:${l.name}:${runtime}`, installation, seat: l.name, runtime,
    route: runtime === 'codex' ? ROUTE_CODEX : 'Not an adapter this check knows.',
    channels: runtime === 'codex' ? ['stdin'] : [],
    supported: false, state: 'unsupported', checked_at: new Date().toISOString(),
    last_verified_at: readCoverageState(l.name).paths[runtime]?.last_verified_at ?? null,
    assertions: [], current: null, historical: null, unmeasured: UNMEASURED, note: why,
  };
}

/** The one unsupported path that belongs to no seat: a named summon, which
 *  starts inside a session somebody else opened. It stays in the reading
 *  because a gap that is absent reads as a gap that is covered. */
export function summonPath(installation: string): PathCoverage {
  return {
    id: `${installation}:*:summon`, installation, seat: '*', runtime: 'summon',
    route: 'A person or another agent opens the session; the seat\'s own constitution arrives as a LATER READ — an instruction someone follows, or a tool result handed back — rather than as anything this installation supplied at launch.',
    channels: ['later read'],
    supported: false, state: 'unsupported', checked_at: new Date().toISOString(), last_verified_at: null,
    assertions: [], current: null, historical: null,
    unmeasured: ['everything: no launch record names the seat, the installation or the session'],
    note: 'No check is possible from existing records. There is no join key to look for — a named summon writes no launch journal entry — so this is an absence of evidence rather than a failing check, and it cannot be repaired by fixing anything on this path.',
  };
}

/** Check one Claude loop path against its own most recent settled launch.
 *
 *  `inventory` is optional because this runs at two very different moments.
 *  At launch settlement it must be cheap, so it skips the tokenizer entirely;
 *  on the operator's surface and the periodic sweep the measured inventory is
 *  the point, and team.ts supplies it. */
export function checkClaudePath(l: LoopConfig, opts: { installation?: string; inventory?: SeatContext; now?: Date; launch?: LaunchJournalEntry | null } = {}): PathCoverage {
  const installation = opts.installation ?? serviceLabel();
  const checked_at = (opts.now ?? new Date()).toISOString();
  // Composed once: the containment test below compares the SAME bytes this
  // reading hashes, and a second read could pick up an edit made between them.
  const composition = composeToday(l);
  const current = currentSources(l, opts.inventory, composition);
  const base = {
    id: `${installation}:${l.name}:claude`, installation, seat: l.name, runtime: 'claude',
    route: ROUTE_CLAUDE,
    channels: ['--append-system-prompt-file', '-p', '--mcp-config', 'discovered by the CLI'],
    supported: true, checked_at,
    last_verified_at: readCoverageState(l.name).paths['claude']?.last_verified_at ?? null,
    unmeasured: UNMEASURED,
  };
  // A named launch is the one the caller is checking — the settle trigger
  // knows exactly which, and scanning the seat's whole journal to rediscover
  // it costs a read per entry it has ever written.
  const launch = opts.launch !== undefined ? opts.launch : latestSettledLaunch(l.name, pathProviders(l, 'claude'));
  if (!launch?.session) {
    return {
      ...base, state: 'stale', current, historical: null,
      assertions: [{
        id: 'provider_session_id', held: null,
        detail: 'No launch on this path has a session result to read yet.',
        repair: 'Nothing is wrong with the account; it has not been exercised. The next settled iteration on this path checks it. A path that has not run for a long time is the finding.',
      }],
      note: 'The current sources are reported; no launch exists to check them against.',
    };
  }
  const session = launch.session;
  const historical: HistoricalEvidence = {
    launch_id: launch.launch_id, provider: session.provider, model: session.model,
    started_at: session.started_at, ended_at: session.ended_at,
    provider_session_id: session.provider_session_id ?? null,
    host: { record: null, cli_version: null, cwd: null, retained_prompt_bytes: null },
  };
  const assertions: CoverageAssertion[] = [];
  const done = (state: CoverageState, note: string): PathCoverage => ({ ...base, state, assertions, current, historical, note });

  if (session.provider_session_id_state !== 'observed' || !session.provider_session_id) {
    assertions.push({
      id: 'provider_session_id', held: false,
      detail: `Launch ${launch.launch_id} settled without an observed provider session id, so there is nothing to join its record to.`,
      repair: 'The adapter did not report a session id. Check whether the host CLI still prints `session_id` in its `--output-format json` result; the shim reads it from there.',
    });
    return done('stale', 'The launch settled but carries no join key, so no historical evidence could be read.');
  }
  if (!HOST_SESSION_ID.test(session.provider_session_id)) {
    // Reported as a malformed join key rather than a missing record, because
    // those are different repairs: the record is not absent, the id never
    // named one. The id is not echoed — a string shaped like a path is the
    // one case where printing it is the thing to avoid (H-3599).
    assertions.push({
      id: 'provider_session_id', held: false,
      detail: `Launch ${launch.launch_id} carries a provider session id that is not a host session id (${session.provider_session_id.length} characters, not a uuid), so it names no host record.`,
      repair: 'The launch journal entry was written by something other than this installation\'s shim, or the host CLI changed what it reports as `session_id`. Check the entry under `$REV_HOME/state/<seat>/launches` and the adapter that wrote it.',
    });
    return done('stale', 'The join key is present and is not a host session id, so no historical evidence could be read.');
  }
  assertions.push({ id: 'provider_session_id', held: true, detail: `Observed: ${session.provider_session_id}.` });

  const host = readClaudeHostRecord(session.provider_session_id, l.cwd);
  if (!host) {
    assertions.push({
      id: 'host_record', held: false,
      detail: `No host record named ${session.provider_session_id} is under ${join(claudeHome(), 'projects')}.`,
      repair: 'The host pruned its transcript, or its store moved. The bytes that launch received are gone and cannot be recovered from here — this is the standing limit of relying on the host\'s own record, and it is what a retained snapshot of our own (R-55) would answer.',
    });
    return done('stale', 'The join key is present and the host record it names is not there.');
  }
  historical.host.record = host.path;
  historical.host.cli_version = host.cli_version;
  historical.host.cwd = host.cwd;
  assertions.push({ id: 'host_record', held: true, detail: `Read ${host.path}${host.cli_version ? ` (host CLI ${host.cli_version})` : ''}.` });

  if (host.prompt === null) {
    // Two readings, and the record's own version is what tells them apart. An
    // older host CLI did not retain a request shape at all, so an old launch
    // has no prompt to compare and never will — nothing to repair, and the
    // next settled launch on the current CLI supplies the evidence. A CURRENT
    // host CLI that stopped retaining it is a reader this check has to catch
    // up with. Both leave the path unverified rather than wrong.
    assertions.push({
      id: 'adapter_shape', held: false, detail: host.adapter ?? 'The host record holds no readable prompt.',
      repair: `The record was written by host CLI ${host.cli_version ?? 'an unrecorded version'}. If that is older than the CLI running now, that launch's prompt was never retained and the next settled iteration on this path is what checks the account. If it is the current one, the host changed what it retains and this check's reader has to be re-read against it.`,
    });
    return done('stale', 'The host record exists but no longer retains the prompt in a shape this check can read.');
  }
  historical.host.retained_prompt_bytes = Buffer.byteLength(host.prompt, 'utf8');
  assertions.push({ id: 'adapter_shape', held: true, detail: `The retained request shape holds ${historical.host.retained_prompt_bytes.toLocaleString('en-US')} bytes of system prompt.` });

  if (host.cwd !== null && host.cwd !== l.cwd) {
    assertions.push({
      id: 'session_cwd', held: false,
      detail: `The host recorded its working directory as ${host.cwd}; the roster configures ${l.cwd} for this seat.`,
      repair: 'The roster moved, or this session id belongs to a different seat. Re-read the roster entry against the launch before trusting any other figure on this path: the discovered instruction files follow the working directory, so a mismatch moves them too.',
    });
  } else if (host.cwd === null) {
    assertions.push({ id: 'session_cwd', held: null, detail: 'The host record carries no working directory, so the roster cwd could not be checked against it.' });
  } else {
    assertions.push({ id: 'session_cwd', held: true, detail: `Both name ${l.cwd}.` });
  }

  if (composition.text === null) {
    assertions.push({
      id: 'composition', held: null,
      detail: current.limit ?? 'Today\'s composition could not be formed, so it could not be compared.',
      repair: 'Restore or re-point the composed sources named above. A session launched now would fail at the same file, so this is the more urgent finding either way.',
    });
    return done('error', 'The historical evidence is intact; this installation cannot compose a prompt today.');
  }
  if (host.prompt.includes(composition.text)) {
    assertions.push({
      id: 'composition', held: true,
      detail: `The bytes this installation composes today (sha256 ${current.composed_sha256}, ${current.composed_bytes!.toLocaleString('en-US')} bytes) are retained verbatim inside that launch's prompt.`,
    });
    const unresolved = assertions.filter((a) => a.held !== true);
    // An assertion nobody could make is not a pass. `verified` has to mean
    // every assertion held, or it reads as a clean bill over a check that was
    // partly skipped.
    if (unresolved.length) return done('stale', `${unresolved.length} assertion(s) did not hold or could not be made; see each one's repair.`);
    recordVerified(l.name, 'claude', launch.launch_id, current.composed_sha256, checked_at);
    // `last_verified_at` is the last SUCCESSFUL check, so on a check that
    // succeeds it is this one. Reporting the previous success here would make
    // a freshly verified path look as though it had not been checked today.
    return { ...done('verified', 'Today\'s composition is byte-identical to what the most recent settled launch on this path received.'), last_verified_at: checked_at };
  }
  assertions.push({
    id: 'composition', held: false,
    detail: `The bytes this installation composes today (sha256 ${current.composed_sha256}) are not in that launch's retained prompt, so the sources moved after it ran. Which source moved is not determinable from this record: it retains the supplied prompt whole and no per-source hash, so the change could be the constitution, any skill, or the roster's skill list. The per-source record (R-55) is what answers that.`,
    repair: 'If the change was intended, nothing is broken — the account is current and the launch is historical, and they are reported apart for this reason. Re-check after the next settled iteration; if it still differs, the composition the launcher writes and the one this check builds have drifted, which is a defect in this check.',
  });
  // A changed source is a normal event. Another assertion failing alongside
  // it is not, and that finding is the one that has to carry the state.
  const others = assertions.filter((a) => a.id !== 'composition' && a.held !== true);
  if (others.length) return done('stale', `The sources changed, and ${others.length} other assertion(s) did not hold; see each one's repair.`);
  return done('changed', 'The sources changed since the launch this was checked against. Both readings are intact and they differ.');
}

export interface CoverageReading {
  schema: 'helmo.context-coverage.v1';
  installation: string;
  checked_at: string;
  /** What this reading is scoped to, said rather than implied — the smallest
   *  correction the audit named for the inventory's three gaps. */
  scope: string;
  paths: PathCoverage[];
  summary: Record<CoverageState, number>;
}

/** Every entry path this installation has, each with its own state.
 *
 *  `inventory` costs the tokenizer and every configured file's measurement, so
 *  it is opt-in: the operator's surface and the periodic sweep want it, a
 *  settle-time check does not. */
export async function coverageReading(roster: Roster, opts: { inventory?: boolean; seats?: string[]; pass?: MeasurePass } = {}): Promise<CoverageReading> {
  const installation = serviceLabel();
  const pass = opts.pass ?? measurePass();
  const paths: PathCoverage[] = [];
  const seats = Object.values(roster.loops).filter((l) => !opts.seats || opts.seats.includes(l.name));
  for (const l of seats) {
    for (const runtime of pathRuntimes(l)) {
      if (runtime !== 'claude') {
        paths.push(unsupportedPath(l, runtime, installation,
          runtime === 'codex'
            ? 'The Codex rollout retains a launch\'s prompt too, so this path is checkable; this release implements the Claude adapter only. The path is real and unchecked.'
            : `No coverage check is implemented for the ${runtime} adapter.`));
        continue;
      }
      paths.push(checkClaudePath(l, { installation, ...(opts.inventory ? { inventory: await seatContext(l, pass) } : {}) }));
    }
  }
  // Keyed on whether a filter was ASKED for, not on whether the filtered set
  // happens to be every seat: a one-seat installation asked for its one seat
  // was being handed the installation-wide summon row as if it were that
  // seat's path. A named summon belongs to no seat, so a seat reading omits it.
  if (!opts.seats) paths.push(summonPath(installation));
  const summary: Record<CoverageState, number> = { verified: 0, changed: 0, stale: 0, unsupported: 0, error: 0 };
  for (const p of paths) summary[p.state] += 1;
  return {
    schema: 'helmo.context-coverage.v1', installation, checked_at: new Date().toISOString(),
    scope: 'The configured runtime and rotation of each roster seat, the files this installation composes, and the instruction files the CLI discovers walking up from the seat\'s working directory to the enclosing repository. Files above that repository — `~/.claude/CLAUDE.md` among them — reach the session and are outside this scope; so is anything a session read after it started.',
    paths, summary,
  };
}

/** The settle-time trigger: check this seat's Claude path after a launch
 *  settles, cheaply, and leave the finding in the log.
 *
 *  Returns the state so a caller can log it. Never throws: a coverage check
 *  that failed must not be able to affect the run whose settlement invoked it. */
export function checkOnSettle(l: LoopConfig, runtime: string, launchId: string): { state: CoverageState; line: string } | null {
  if (runtime !== 'claude') return null;
  try {
    const coverage = checkClaudePath(l, { launch: readLaunch(l.name, launchId) });
    const failed = coverage.assertions.filter((a) => a.held === false).map((a) => a.id);
    return { state: coverage.state, line: `${coverage.state}${failed.length ? ` ${failed.join(',')}` : ''} ${coverage.historical?.launch_id ?? 'no-launch'}` };
  } catch (e) {
    return { state: 'error', line: `check threw: ${String(e).split('\n')[0]!.slice(0, 160)}` };
  }
}
