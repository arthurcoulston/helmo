// What one launch actually received, written at the moment it was handed over.
//
// R-45's coverage check (context-coverage.ts) answers "is the installation's
// account of what a seat loads still true TODAY?" by comparing today's files
// against the host CLI's own transcript. It names its own two limits in the
// code, and both are this file's contract:
//
//   - "The bytes that launch received are gone and cannot be recovered from
//     here — this is the standing limit of relying on the host's own record."
//     The host's transcript is prunable and not versioned with our releases, so
//     a host path is not retention. This installation retains its own copy.
//   - "Which source moved is not determinable from this record: it retains the
//     supplied prompt whole and no per-source hash." So this record is
//     per-source, and a comparison of two runs can name the file that moved.
//
// Five distinctions it is built around, because collapsing any of them is a way
// to claim more than was recorded:
//   - SUPPLIED vs DISCOVERED. Rev composes the constitution and the roster
//     skills and hands them over; the host CLI finds CLAUDE.md files itself.
//     Both are recorded, and only the first is something this installation
//     supplied. Neither is a claim the session READ them.
//   - RECORDED vs CONFIRMED. The receipt is written moments before the model
//     process starts, from the same files the launcher is about to compose. At
//     settlement the host's own retained prompt is checked for those exact
//     bytes, which is what turns "we recorded this" into "the model got this".
//     An unconfirmed receipt says so rather than assuming it.
//   - RETAINED vs EXPIRED vs LOST. Content lives in a content-addressed blob
//     store beside the receipts. The reader resolves each reference when it is
//     read: present, dropped by the retention policy, or gone while still
//     inside the policy's horizon — three different findings. Receipts are
//     never rewritten to hide the difference.
//   - COMPLETE vs PARTIAL vs FAILED recording. A recording failure must never
//     take down a launch, and absence must never read as a complete record, so
//     a failure writes a receipt that says it failed.
//   - NOW vs LATER. Nothing here covers what a session read after it started
//     or what survived a compaction. Those stay named in `unknowns`.
//
// Storage is O(distinct content), not O(launches): a seat's constitution is one
// blob however many times it launches, and the composed prompt is not stored at
// all — it is reconstructed from the per-source blobs and checked against the
// sha256 recorded at launch.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { revHome, stateDir, type Roster } from './config.js';
import { claudeHome, readClaudeHostRecord, readSource, sourceRepos, type SourceReading } from './context-coverage.js';
import { readLaunch, type LaunchJournalEntry } from './launch-journal.js';
import { loaded } from './build.js';
import { serviceLabel } from './service.js';
import { mcpServers, skillHeader } from './shim.js';
import { MEASURE_BYTE_CEILING, readBounded } from './team.js';
import type { GlobalConfig, LoopConfig } from './types.js';

/** How long a receipt's retained content is kept. The receipt itself — every
 *  identity, hash, byte count and state in it — is not pruned: it is small and
 *  it is the record. What expires is the retained bytes behind it, and a reader
 *  past this horizon is told the policy dropped them rather than finding a
 *  silently emptier receipt. */
export const RETENTION_DAYS = 90;

/** The most of a receipt this reader will take off disk. Receipts carry
 *  hashes and paths, never content, so this is generous by a wide margin and
 *  exists so a corrupt or planted file cannot be read without bound. */
export const RECEIPT_BYTE_CEILING = 4_194_304;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export type Retention = 'retained' | 'not_retained';

/** A reference to exact bytes: the hash, the size, and whether this
 *  installation holds them. `retention` is what was true when the receipt was
 *  written; what is true NOW is `resolveContent`, which is a read-time
 *  question and deliberately not stored. */
export interface ContentRef {
  sha256: string | null;
  bytes: number;
  retention: Retention;
  /** Why bytes were not retained — over the read ceiling, unreadable, or a
   *  blob store that refused the write. */
  reason?: string;
}

export type SourceClaim = 'supplied' | 'discovered';

export interface ReceiptSource {
  /** Position in the composition the launcher writes. Discovered files are
   *  numbered in the order the CLI walks them and compose nothing. */
  order: number;
  path: string;
  role: SourceReading['role'];
  claim: SourceClaim;
  /** How these bytes reach the session. Not decoration: the discovered files
   *  arrive by a route this installation does not control. */
  channel: string;
  inclusion_reason: string;
  state: SourceReading['state'];
  error?: string;
  content: ContentRef;
}

export interface StartupReceipt {
  schema: 'helmo.startup-context.v1';
  format: 1;
  /** Installation-qualified: a seat name and a launch id are only unique
   *  inside one installation, and two fleets on one machine both have a
   *  `mason` (H-3581). */
  id: string;
  installation: string;
  seat: string;
  launch_id: string;
  recorded_at: string;
  runtime: string;
  provider: string;
  model: string;
  cwd: string;
  /** Which work this launch is for, and on what evidence. A scoped seat
   *  claims inside its own session, so at launch there is nothing to name and
   *  the honest basis is the measured event window the journal records after
   *  the fact (H-2901) — not a ticket id guessed here. */
  association: {
    ticket_id: string | null;
    basis: 'admitted' | 'claimed' | 'scoped_seat_window' | 'none';
    detail: string;
    workflow_attempt_id?: string;
    admission_id?: string;
  };
  versions: {
    /** The release this installation is running, when it is running one. */
    rev_release: string | null;
    rev_commit: string | null;
    rev_dirty: boolean | null;
    adapter: string;
    adapter_route: string;
    /** The host CLI's own version. Unknown until the host writes its record,
     *  so it is null here and filled by `attachSettlement`. */
    host_cli_version: string | null;
  };
  sources: ReceiptSource[];
  composed: {
    sha256: string | null;
    bytes: number | null;
    channel: string;
    /** Whether the per-source blobs are enough to rebuild these exact bytes.
     *  False when any composed source went unretained, and then the hash is
     *  still the record of what was supplied — just not reproducible from
     *  here. */
    reconstructable: boolean;
    limit?: string;
  };
  iteration_prompt: ContentRef & { channel: string };
  repos: { dir: string; commit: string | null; dirty: string[] }[];
  /** The tool surface by reference only. Server names and the program each
   *  runs; never its environment or arguments, which is where credentials and
   *  actor stamps live. */
  tools: { channel: string; servers: { name: string; command: string | null }[]; excluded: string };
  unknowns: string[];
  recording: { state: 'complete' | 'partial' | 'failed'; errors: string[] };
  /** The second half, written once the session ends and the host's record
   *  exists. Absent on a receipt whose launch never settled — an interrupted
   *  or refused launch keeps its first half and says nothing it cannot. */
  settled?: {
    at: string;
    outcome: string;
    started_at: string;
    ended_at: string;
    provider_session_id: string | null;
    provider_session_id_state: 'observed' | 'unsupported';
    host: { record: string | null; cli_version: string | null; cwd: string | null; retained_prompt_bytes: number | null };
    /** Did the host's own retained prompt contain the exact bytes this receipt
     *  recorded at launch? null when there is no host record or it retains no
     *  prompt — an absence of evidence, not a contradiction. */
    supplied_confirmed: boolean | null;
    confirmation: string;
  };
}

const UNKNOWNS = [
  "the host CLI's own system prompt and harness instructions — supplied by the host, not by this installation, and retained only in the host's own record",
  'the tool and MCP schemas the session is given: named here by server, never captured as text',
  'whether the session READ any of this. Supplied and discovered are claims about what was handed over; being read is a different claim and nothing here makes it',
  'anything the session read, was handed, or kept after the host compacted it — a later-read record is not part of this release',
  'provider-internal context: whatever the model is given beyond the request this installation composed',
];

const ROUTE_CLAUDE = 'The constitution and each roster skill are composed into one file passed as `--append-system-prompt-file`; the iteration prompt goes as `-p`; the MCP table is a temp file under `--strict-mcp-config`. The temp directory is deleted when the run ends, which is why the bytes are retained here.';
const ROUTE_CODEX = 'The same composition and the iteration prompt are joined by `--- Iteration prompt ---` and written to the CLI\'s stdin.';

export const adapterRoute = (runtime: string): string =>
  runtime === 'claude' ? ROUTE_CLAUDE : runtime === 'codex' ? ROUTE_CODEX : 'Not an adapter this record knows.';

// ---------------------------------------------------------------- blob store

/** One content-addressed store per installation, beside the seats rather than
 *  inside one: two seats carrying the same skill file hold one copy of it, and
 *  a seat removed from the roster does not take shared content with it. */
export function blobDir(): string {
  return join(revHome(), 'state', 'context-blobs');
}

export function blobPath(hash: string): string {
  return join(blobDir(), hash.slice(0, 2), hash);
}

/** Put exact bytes in the store under their own hash.
 *
 *  Content-addressed, so a write that finds the blob already there is a
 *  no-op: the bytes under a hash can only be the bytes that hash. Durable by
 *  atomic rename, and the receipt is written only after this returns, so a
 *  receipt never names a blob that was not on disk first. */
export function retain(text: string): { sha256: string; written: boolean } {
  const hash = sha256(text);
  const file = blobPath(hash);
  if (existsSync(file)) return { sha256: hash, written: false };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* no partial blob remains */ }
    throw e;
  }
  return { sha256: hash, written: true };
}

/** What a reference resolves to now, which is not what the receipt says was
 *  true when it was written.
 *
 *  Three absences, told apart because they are three different findings: the
 *  bytes were never retained (the receipt says so and why), the retention
 *  policy dropped them (expected, and the horizon says when), or they are gone
 *  while the receipt is still inside the horizon (a defect — the store lost
 *  content it was holding). */
export function resolveContent(
  ref: ContentRef, recordedAt: string, now = new Date(),
): { state: 'retained' | 'not_retained' | 'expired' | 'lost'; path?: string; detail: string } {
  if (ref.retention !== 'retained' || !ref.sha256) {
    return { state: 'not_retained', detail: ref.reason ?? 'These bytes were not retained, and the receipt records no reason.' };
  }
  const file = blobPath(ref.sha256);
  if (existsSync(file)) return { state: 'retained', path: file, detail: `${ref.bytes.toLocaleString('en-US')} bytes under sha256 ${ref.sha256}.` };
  const ageDays = (now.getTime() - Date.parse(recordedAt)) / 86_400_000;
  if (ageDays > RETENTION_DAYS) {
    return { state: 'expired', detail: `The retention policy keeps content for ${RETENTION_DAYS} days and this launch was ${Math.floor(ageDays)} days ago, so the bytes were dropped. The hash, size and every identity in the receipt are unchanged: what is gone is the content, and the receipt was not rewritten to pretend otherwise.` };
  }
  return { state: 'lost', detail: `The receipt retained sha256 ${ref.sha256} and it is not in the store, with ${Math.floor(RETENTION_DAYS - ageDays)} days still inside the retention horizon. The store lost content it was holding — check ${blobDir()} and whether anything outside Helmo removed from it.` };
}

/** Read retained bytes back. Bounded and O_NOFOLLOW like every other read
 *  here, and the hash is verified: a blob whose content does not hash to its
 *  own name is reported rather than returned, because the whole point of the
 *  store is that a name proves its content. */
export function readRetained(ref: ContentRef, recordedAt: string, now = new Date()): { ok: true; text: string } | { ok: false; detail: string } {
  const resolved = resolveContent(ref, recordedAt, now);
  if (resolved.state !== 'retained' || !resolved.path) return { ok: false, detail: resolved.detail };
  const read = readBounded(resolved.path, MEASURE_BYTE_CEILING);
  if (!read.ok) return { ok: false, detail: `The blob exists and cannot be read: ${read.error}` };
  if (read.truncated) return { ok: false, detail: `The blob is past the ${MEASURE_BYTE_CEILING.toLocaleString('en-US')}-byte read ceiling, so it cannot be returned whole.` };
  if (sha256(read.text) !== ref.sha256) return { ok: false, detail: `The blob under ${ref.sha256} does not hash to its own name, so the store is corrupt at that entry. Treat its content as lost.` };
  return { ok: true, text: read.text };
}

// ------------------------------------------------------------------ receipts

function receiptDir(seat: string): string {
  const dir = join(stateDir(seat), 'startup');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function receiptPath(seat: string, launchId: string): string {
  return join(receiptDir(seat), `${sha256(launchId)}.json`);
}

function writeDurable(file: string, receipt: StartupReceipt): void {
  const dir = dirname(file);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, `${JSON.stringify(receipt, null, 1)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* no partial receipt remains */ }
    throw e;
  }
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readReceipt(seat: string, launchId: string): StartupReceipt | null {
  const file = receiptPath(seat, launchId);
  if (!existsSync(file)) return null;
  const read = readBounded(file, RECEIPT_BYTE_CEILING);
  if (!read.ok || read.truncated) return null;
  let parsed: StartupReceipt;
  try { parsed = JSON.parse(read.text) as StartupReceipt; } catch { return null; }
  if (parsed.format !== 1 || parsed.schema !== 'helmo.startup-context.v1') return null;
  // A receipt found under the hash of one launch id and naming another is a
  // store that cannot be trusted to answer by key at all.
  if (parsed.launch_id !== launchId) throw new Error(`Startup receipt at ${file} names launch ${parsed.launch_id}, not ${launchId}.`);
  return parsed;
}

/** Every receipt this seat has, newest first. */
export function seatReceipts(seat: string): StartupReceipt[] {
  let names: string[];
  try { names = readdirSync(receiptDir(seat)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: StartupReceipt[] = [];
  for (const name of names) {
    const read = readBounded(join(receiptDir(seat), name), RECEIPT_BYTE_CEILING);
    if (!read.ok || read.truncated) continue;
    try {
      const parsed = JSON.parse(read.text) as StartupReceipt;
      if (parsed.format === 1 && parsed.schema === 'helmo.startup-context.v1') out.push(parsed);
    } catch { /* a corrupt file is skipped, not fatal to the reading */ }
  }
  return out.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
}

// ------------------------------------------------------------------- capture

/** Which work a launch is for, and on what evidence — never a guess.
 *
 *  Four bases, because the four ways a launch acquires a ticket are four
 *  different strengths of claim and flattening them would make the weakest
 *  read like the strongest. A scoped seat is the one that matters: it claims
 *  INSIDE its own session, so at launch there is genuinely nothing to name,
 *  and the honest answer is to point at the measured Work event window the
 *  journal records afterwards rather than to write down whatever ticket the
 *  seat happened to hold (H-2901). */
export function launchAssociation(facts: {
  admissionId?: string; ticketId?: string; workflowAttemptId?: string;
  claimedTicket?: string | null; scoped: boolean;
}): StartupReceipt['association'] {
  if (facts.admissionId && facts.ticketId) {
    return {
      ticket_id: facts.ticketId, basis: 'admitted',
      detail: 'Helmo admitted this launch to this exact ticket and workflow attempt before dispatch.',
      ...(facts.workflowAttemptId ? { workflow_attempt_id: facts.workflowAttemptId } : {}),
      admission_id: facts.admissionId,
    };
  }
  if (facts.claimedTicket) {
    return {
      ticket_id: facts.claimedTicket, basis: 'claimed',
      detail: 'A pool worker claimed this ticket before dispatch, so the launch carries it.',
    };
  }
  if (!facts.scoped) {
    return { ticket_id: null, basis: 'none', detail: 'An unscoped worker: no ticket is named at launch and none is inferred.' };
  }
  return {
    ticket_id: null, basis: 'scoped_seat_window',
    detail: 'A scoped seat claims inside its own session, so no ticket existed to name at launch. The association is the measured Work event window the launch journal records afterwards (H-2901) — read it from `touched_tickets`, and never as an admitted identity.',
  };
}

function toolSurface(g: GlobalConfig, l: LoopConfig, model: string): StartupReceipt['tools'] {
  let servers: { name: string; command: string | null }[] = [];
  try {
    servers = Object.entries(mcpServers(g, l, model)).map(([name, config]) => ({
      name,
      command: typeof config['command'] === 'string' ? (config['command'] as string) : null,
    }));
  } catch {
    // A seat whose mcp_extra is unreadable launches without those servers;
    // reporting none is then the truth about what this record could see.
  }
  return {
    channel: '--strict-mcp-config --mcp-config <temp file>',
    servers,
    excluded: 'Each server\'s arguments and environment are deliberately not recorded: that is where credentials and the per-session actor stamp live. The schemas the session is handed are named in `unknowns` rather than captured.',
  };
}

/** Everything one launch is about to be handed, read once and retained.
 *
 *  Called at dispatch, immediately before the model process starts, from the
 *  same files the launcher is about to compose — not reconstructed afterwards
 *  from whatever the files say later. The composition is deliberately NOT
 *  stored as its own blob: `reconstructComposed` rebuilds it from the
 *  per-source blobs and checks it against the sha256 taken here, which is both
 *  cheaper and a stronger statement than a second copy would be. */
export function buildReceipt(
  g: GlobalConfig,
  l: LoopConfig,
  opts: {
    launchId: string;
    runtime: string;
    provider: string;
    model: string;
    iterationPrompt: string;
    association: StartupReceipt['association'];
    installation?: string;
    now?: Date;
    discovered?: string[];
  },
): StartupReceipt {
  const installation = opts.installation ?? serviceLabel();
  const recorded_at = (opts.now ?? new Date()).toISOString();
  const errors: string[] = [];

  const keep = (text: string | null, state: SourceReading['state'], error?: string): ContentRef => {
    if (text === null) {
      return {
        sha256: null, bytes: 0, retention: 'not_retained',
        reason: error ?? `The source was ${state}, so there are no bytes to retain.`,
      };
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    try {
      const { sha256: hash } = retain(text);
      return { sha256: hash, bytes, retention: 'retained' };
    } catch (e) {
      const reason = `The blob store refused the write: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(reason);
      return { sha256: sha256(text), bytes, retention: 'not_retained', reason };
    }
  };

  const sources: ReceiptSource[] = [];
  const parts: string[] = [];
  let composable = true;
  let order = 0;

  const constitution = readSource(l.constitution, 'constitution');
  sources.push({
    order: order++, path: l.constitution, role: 'constitution', claim: 'supplied',
    channel: '--append-system-prompt-file', inclusion_reason: 'The roster names it as this seat\'s constitution.',
    state: constitution.source.state, ...(constitution.source.error ? { error: constitution.source.error } : {}),
    content: keep(constitution.text, constitution.source.state, constitution.source.error),
  });
  if (constitution.text === null) composable = false;
  else parts.push(constitution.text);

  for (const skill of l.skills ?? []) {
    const read = readSource(skill, 'skill');
    sources.push({
      order: order++, path: skill, role: 'skill', claim: 'supplied',
      channel: '--append-system-prompt-file', inclusion_reason: 'The roster lists it among this seat\'s skills, appended whole under its own `--- Skill: … ---` header.',
      state: read.source.state, ...(read.source.error ? { error: read.source.error } : {}),
      content: keep(read.text, read.source.state, read.source.error),
    });
    if (read.text === null) composable = false;
    else parts.push(`${skillHeader(skill)}${read.text}`);
  }

  // The files the CLI finds walking up from the working directory. Recorded
  // because a change in one of them changes what a session receives (H-3575),
  // and marked `discovered` because this installation neither orders them, nor
  // composes them, nor can say the host read them.
  for (const path of opts.discovered ?? []) {
    const read = readSource(path, 'discovered');
    sources.push({
      order: order++, path, role: 'discovered', claim: 'discovered',
      channel: 'discovered by the CLI walking up from the working directory',
      inclusion_reason: 'Present in the working tree at launch; the host CLI decides whether and how to load it.',
      state: read.source.state, ...(read.source.error ? { error: read.source.error } : {}),
      content: keep(read.text, read.source.state, read.source.error),
    });
  }

  const composedText = composable ? parts.join('') : null;
  const unretained = sources.filter((s) => s.claim === 'supplied' && s.content.retention !== 'retained');
  const prompt = keep(opts.iterationPrompt, 'read');
  const build = loaded();

  const receipt: StartupReceipt = {
    schema: 'helmo.startup-context.v1', format: 1,
    id: `${installation}:${l.name}:${opts.launchId}`,
    installation, seat: l.name, launch_id: opts.launchId, recorded_at,
    runtime: opts.runtime, provider: opts.provider, model: opts.model, cwd: l.cwd,
    association: opts.association,
    versions: {
      rev_release: process.env['INSTALLATION_RELEASE'] ?? null,
      rev_commit: build.stamp?.commit ?? null,
      rev_dirty: build.stamp ? build.stamp.dirty : null,
      adapter: opts.runtime, adapter_route: adapterRoute(opts.runtime),
      host_cli_version: null,
    },
    sources,
    composed: {
      sha256: composedText === null ? null : sha256(composedText),
      bytes: composedText === null ? null : Buffer.byteLength(composedText, 'utf8'),
      channel: '--append-system-prompt-file',
      reconstructable: composedText !== null && unretained.length === 0,
      ...(composedText === null
        ? { limit: `${sources.filter((s) => s.claim === 'supplied' && s.state !== 'read').length} composed source(s) could not be read, so no composition was formed and no hash is claimed. A session launched now fails at the same file.` }
        : unretained.length
          ? { limit: `${unretained.length} composed source(s) were not retained, so these bytes are recorded by hash and cannot be rebuilt from this store.` }
          : {}),
    },
    iteration_prompt: { ...prompt, channel: opts.runtime === 'codex' ? 'stdin, after `--- Iteration prompt ---`' : '-p' },
    repos: sourceRepos(sources.filter((s) => s.claim === 'supplied' && s.state === 'read').map((s) => ({
      path: s.path, role: s.role, bytes: s.content.bytes, sha256: s.content.sha256, state: s.state,
    }))),
    tools: toolSurface(g, l, opts.model),
    unknowns: UNKNOWNS,
    recording: {
      state: errors.length ? 'partial' : 'complete',
      errors,
    },
  };
  return receipt;
}

/** Record this launch's starting context. Never throws.
 *
 *  A recording failure must not be able to stop a launch, and it must not be
 *  able to pass as an absence either: when the full receipt cannot be written,
 *  a minimal one saying exactly that is written in its place, so a launch with
 *  no receipt means only one thing — nothing could be written at all — and the
 *  returned line puts that in the event log. */
export function recordStartupContext(
  g: GlobalConfig,
  l: LoopConfig,
  opts: Parameters<typeof buildReceipt>[2],
): { state: StartupReceipt['recording']['state']; line: string } {
  let receipt: StartupReceipt | null = null;
  try {
    receipt = buildReceipt(g, l, opts);
    writeDurable(receiptPath(l.name, opts.launchId), receipt);
    const supplied = receipt.sources.filter((s) => s.claim === 'supplied').length;
    const discovered = receipt.sources.length - supplied;
    return {
      state: receipt.recording.state,
      line: `${receipt.recording.state} ${opts.launchId} ${supplied} supplied, ${discovered} discovered, ${(receipt.composed.bytes ?? 0).toLocaleString('en-US')} composed bytes`,
    };
  } catch (e) {
    const why = `${e instanceof Error ? e.message : String(e)}`.split('\n')[0]!.slice(0, 200);
    const failed: StartupReceipt = receipt
      ? { ...receipt, recording: { state: 'failed', errors: [...receipt.recording.errors, why] } }
      : {
        schema: 'helmo.startup-context.v1', format: 1,
        id: `${opts.installation ?? 'unknown'}:${l.name}:${opts.launchId}`,
        installation: opts.installation ?? 'unknown', seat: l.name, launch_id: opts.launchId,
        recorded_at: (opts.now ?? new Date()).toISOString(),
        runtime: opts.runtime, provider: opts.provider, model: opts.model, cwd: l.cwd,
        association: opts.association,
        versions: { rev_release: null, rev_commit: null, rev_dirty: null, adapter: opts.runtime, adapter_route: adapterRoute(opts.runtime), host_cli_version: null },
        sources: [], composed: { sha256: null, bytes: null, channel: '--append-system-prompt-file', reconstructable: false, limit: 'Nothing was read: this receipt records only that the recording failed.' },
        iteration_prompt: { sha256: null, bytes: 0, retention: 'not_retained', reason: 'The recording failed before the iteration prompt was retained.', channel: opts.runtime === 'codex' ? 'stdin' : '-p' },
        repos: [], tools: { channel: 'unrecorded', servers: [], excluded: 'Nothing was recorded.' },
        unknowns: UNKNOWNS,
        recording: { state: 'failed', errors: [why] },
      };
    try { writeDurable(receiptPath(l.name, opts.launchId), failed); }
    catch { return { state: 'failed', line: `failed ${opts.launchId} no receipt could be written: ${why}` }; }
    return { state: 'failed', line: `failed ${opts.launchId} ${why}` };
  }
}

/** The second half: what the host's own record says about the launch this
 *  receipt was written for, and whether it confirms the recorded bytes.
 *
 *  Never throws, for the same reason the capture does not. Written once: a
 *  replay with a different session result is refused rather than overwriting
 *  a record somebody may already have read. */
export function attachSettlement(
  l: LoopConfig, launchId: string, session: NonNullable<LaunchJournalEntry['session']>, now = new Date(),
): StartupReceipt | null {
  let receipt: StartupReceipt | null;
  try { receipt = readReceipt(l.name, launchId); } catch { return null; }
  if (!receipt) return null;
  if (receipt.settled) return receipt;

  const sessionId = session.provider_session_id ?? null;
  // Capture is adapter-agnostic — every launch gets a receipt. CONFIRMATION is
  // not: it reads one host's own store, and only the Claude reader exists this
  // release. Asking it about a codex or mock launch would report that store's
  // record as missing, which is a true sentence about the wrong store.
  const claudePath = receipt.runtime === 'claude';
  const host = claudePath && sessionId ? readClaudeHostRecord(sessionId, l.cwd) : null;
  let supplied_confirmed: boolean | null = null;
  let confirmation: string;
  if (!claudePath) {
    confirmation = `This launch ran on the ${receipt.runtime} adapter, whose own retained record this release does not read, so the recorded bytes stand unconfirmed. They are still the bytes this installation read at launch; what is missing is a second witness. The Codex rollout retains a launch's prompt too, so that reader is a later increment rather than an impossibility.`;
  } else if (!sessionId) {
    confirmation = `The launch settled with no observed provider session id (${session.provider_session_id_state}), so the host's own record cannot be located and the recorded bytes stand unconfirmed. They are still the bytes this installation read at launch; what is missing is the host's agreement.`;
  } else if (!host) {
    confirmation = `No host record named that session id is under ${join(claudeHome(), 'projects')}, so the recorded bytes stand unconfirmed. This is the case the retained copy exists for: the content is here even though the host's record is not.`;
  } else if (host.prompt === null) {
    confirmation = host.adapter ?? 'The host record retains no readable prompt, so the recorded bytes stand unconfirmed.';
  } else if (receipt.composed.sha256 === null) {
    confirmation = 'No composition was formed at launch, so there is nothing to confirm against the host\'s record. The source states on this receipt are the finding.';
  } else {
    const rebuilt = reconstructComposed(receipt, now);
    if (!rebuilt.ok) {
      confirmation = `The host retained a prompt and this receipt's composition could not be rebuilt to compare with it (${rebuilt.detail}). Hashes stand; the comparison does not.`;
    } else {
      supplied_confirmed = host.prompt.includes(rebuilt.text);
      confirmation = supplied_confirmed
        ? `The host's retained prompt contains the exact ${receipt.composed.bytes!.toLocaleString('en-US')} bytes this receipt recorded at launch (sha256 ${receipt.composed.sha256}), so the record and the launch agree.`
        : `The host's retained prompt does NOT contain the bytes recorded at launch (sha256 ${receipt.composed.sha256}). The two readings are moments apart, so the likeliest cause is a source edited between the capture and the exec; it is reported rather than reconciled. Compare this receipt's per-source hashes against the next launch's to see which file moved.`;
    }
  }

  const settled: NonNullable<StartupReceipt['settled']> = {
    at: now.toISOString(), outcome: session.outcome,
    started_at: session.started_at, ended_at: session.ended_at,
    provider_session_id: sessionId,
    provider_session_id_state: session.provider_session_id_state,
    host: {
      record: host?.path ?? null, cli_version: host?.cli_version ?? null, cwd: host?.cwd ?? null,
      retained_prompt_bytes: host?.prompt === undefined || host?.prompt === null ? null : Buffer.byteLength(host.prompt, 'utf8'),
    },
    supplied_confirmed, confirmation,
  };
  const next: StartupReceipt = {
    ...receipt,
    versions: { ...receipt.versions, host_cli_version: host?.cli_version ?? null },
    settled,
  };
  try { writeDurable(receiptPath(l.name, launchId), next); } catch { return receipt; }
  return next;
}

/** Rebuild the exact bytes the launcher composed, from the retained
 *  per-source blobs and `skillHeader`'s framing — then check the result
 *  against the sha256 taken at launch.
 *
 *  That check is what makes reconstruction evidence rather than a plausible
 *  rebuild: if the framing here and the launcher's ever drift, this reports a
 *  mismatch instead of returning bytes nobody ever received. */
export function reconstructComposed(receipt: StartupReceipt, now = new Date()): { ok: true; text: string } | { ok: false; detail: string } {
  if (receipt.composed.sha256 === null) return { ok: false, detail: receipt.composed.limit ?? 'No composition was formed at launch.' };
  const parts: string[] = [];
  for (const source of receipt.sources.filter((s) => s.claim === 'supplied')) {
    const read = readRetained(source.content, receipt.recorded_at, now);
    if (!read.ok) return { ok: false, detail: `${source.path}: ${read.detail}` };
    parts.push(source.role === 'constitution' ? read.text : `${skillHeader(source.path)}${read.text}`);
  }
  const text = parts.join('');
  if (sha256(text) !== receipt.composed.sha256) {
    return { ok: false, detail: `The retained sources rebuild to sha256 ${sha256(text)}, not the ${receipt.composed.sha256} recorded at launch. Either the store is corrupt at one of these blobs or the composition this reader builds has drifted from the launcher's — a defect in this module either way, not a change in the sources.` };
  }
  return { ok: true, text };
}

// ----------------------------------------------------------------- comparing

export interface SourceDifference {
  path: string;
  role: SourceReading['role'];
  claim: SourceClaim;
  change: 'added' | 'removed' | 'changed' | 'unchanged' | 'reordered';
  a: { sha256: string | null; bytes: number; order: number; state: SourceReading['state'] } | null;
  b: { sha256: string | null; bytes: number; order: number; state: SourceReading['state'] } | null;
  /** Whether both sides' bytes are still here to show, said per source so a
   *  comparison never implies it inspected content it could not read. */
  content: string;
}

export interface ReceiptComparison {
  schema: 'helmo.startup-context.comparison.v1';
  a: { id: string; seat: string; launch_id: string; recorded_at: string };
  b: { id: string; seat: string; launch_id: string; recorded_at: string };
  /** Refused rather than answered when the two sides are different
   *  installations: a comparison across them would read as drift in one. */
  comparable: boolean;
  note: string;
  composed: { a: string | null; b: string | null; same: boolean };
  iteration_prompt: { a: string | null; b: string | null; same: boolean };
  sources: SourceDifference[];
  summary: { added: number; removed: number; changed: number; reordered: number; unchanged: number };
}

/** What changed between two launches, per source.
 *
 *  This is R-45's named evidence limit answered: the host's record retains the
 *  prompt whole, so it can only say the bytes differ. These receipts hold a
 *  hash per file, so the answer is a file name. */
export function compareReceipts(a: StartupReceipt, b: StartupReceipt, now = new Date()): ReceiptComparison {
  const side = (s: ReceiptSource) => ({ sha256: s.content.sha256, bytes: s.content.bytes, order: s.order, state: s.state });
  const byPath = new Map<string, { a?: ReceiptSource; b?: ReceiptSource }>();
  for (const s of a.sources) byPath.set(s.path, { ...byPath.get(s.path), a: s });
  for (const s of b.sources) byPath.set(s.path, { ...byPath.get(s.path), b: s });

  const sources: SourceDifference[] = [];
  const summary = { added: 0, removed: 0, changed: 0, reordered: 0, unchanged: 0 };
  for (const [path, pair] of [...byPath].sort(([x], [y]) => x.localeCompare(y))) {
    const source = pair.a ?? pair.b!;
    const change: SourceDifference['change'] = !pair.a ? 'added'
      : !pair.b ? 'removed'
        : pair.a.content.sha256 !== pair.b.content.sha256 ? 'changed'
          : pair.a.order !== pair.b.order ? 'reordered'
            : 'unchanged';
    summary[change] += 1;
    const sides = [pair.a ? { s: pair.a, at: a.recorded_at } : null, pair.b ? { s: pair.b, at: b.recorded_at } : null].filter(Boolean) as { s: ReceiptSource; at: string }[];
    const resolutions = sides.map(({ s, at }) => resolveContent(s.content, at, now).state);
    sources.push({
      path, role: source.role, claim: source.claim, change,
      a: pair.a ? side(pair.a) : null,
      b: pair.b ? side(pair.b) : null,
      content: resolutions.every((r) => r === 'retained')
        ? 'Both sides\' bytes are in the store, so the exact content of this change can be read.'
        : `Content is not available on every side (${resolutions.join(', ')}), so this difference is stated by hash only.`,
    });
  }

  const comparable = a.installation === b.installation;
  return {
    schema: 'helmo.startup-context.comparison.v1',
    a: { id: a.id, seat: a.seat, launch_id: a.launch_id, recorded_at: a.recorded_at },
    b: { id: b.id, seat: b.seat, launch_id: b.launch_id, recorded_at: b.recorded_at },
    comparable,
    note: comparable
      ? a.seat === b.seat
        ? 'Two launches of the same seat in the same installation.'
        : `Two different seats (${a.seat}, ${b.seat}) in one installation: every source they do not share reads as added or removed, which is a difference between seats and not drift in either.`
      : `These receipts are from different installations (${a.installation}, ${b.installation}). Their seat names and launch ids are only unique within one, so this comparison names what differs but must not be read as one installation changing.`,
    composed: { a: a.composed.sha256, b: b.composed.sha256, same: a.composed.sha256 !== null && a.composed.sha256 === b.composed.sha256 },
    iteration_prompt: { a: a.iteration_prompt.sha256, b: b.iteration_prompt.sha256, same: a.iteration_prompt.sha256 !== null && a.iteration_prompt.sha256 === b.iteration_prompt.sha256 },
    sources, summary,
  };
}

// ------------------------------------------------------------------- reading

export interface StartupReading {
  schema: 'helmo.startup-context.reading.v1';
  installation: string;
  read_at: string;
  scope: string;
  retention: { days: number; store: string; policy: string };
  receipts: (StartupReceipt & { content_states: Record<string, number>; reconstruction: string })[];
  summary: { complete: number; partial: number; failed: number; settled: number; confirmed: number; unconfirmed: number; contradicted: number };
}

/** Receipts for one seat, or for the work record a launch was for.
 *
 *  Work-linked lookup goes through the launch journal rather than a second
 *  index: the journal already holds the admitted ticket and the measured
 *  touched-ticket window, and a second copy of that association here would be
 *  one more thing that can disagree with it. */
export function startupReading(
  roster: Roster, opts: { seats?: string[]; ticket?: string; launch?: string; limit?: number; now?: Date } = {},
): StartupReading {
  const now = opts.now ?? new Date();
  const seats = Object.values(roster.loops).filter((l) => !opts.seats || opts.seats.includes(l.name));
  let receipts: StartupReceipt[] = [];
  for (const l of seats) {
    for (const receipt of seatReceipts(l.name)) {
      if (opts.launch && receipt.launch_id !== opts.launch) continue;
      if (opts.ticket) {
        const entry = (() => { try { return readLaunch(l.name, receipt.launch_id); } catch { return null; } })();
        const named = receipt.association.ticket_id === opts.ticket
          || entry?.ticket_id === opts.ticket
          || (entry?.touched_tickets ?? []).some((t) => t.id === opts.ticket);
        if (!named) continue;
      }
      receipts.push(receipt);
    }
  }
  receipts.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
  if (opts.limit !== undefined) receipts = receipts.slice(0, opts.limit);

  const summary = { complete: 0, partial: 0, failed: 0, settled: 0, confirmed: 0, unconfirmed: 0, contradicted: 0 };
  const annotated = receipts.map((receipt) => {
    summary[receipt.recording.state] += 1;
    if (receipt.settled) {
      summary.settled += 1;
      if (receipt.settled.supplied_confirmed === true) summary.confirmed += 1;
      else if (receipt.settled.supplied_confirmed === false) summary.contradicted += 1;
      else summary.unconfirmed += 1;
    }
    const content_states: Record<string, number> = {};
    for (const source of receipt.sources) {
      const state = resolveContent(source.content, receipt.recorded_at, now).state;
      content_states[state] = (content_states[state] ?? 0) + 1;
    }
    const rebuilt = reconstructComposed(receipt, now);
    return {
      ...receipt, content_states,
      reconstruction: rebuilt.ok
        ? `The composed prompt rebuilds from the retained sources to sha256 ${receipt.composed.sha256}, matching what was recorded at launch.`
        : `Not reconstructable: ${rebuilt.detail}`,
    };
  });

  return {
    schema: 'helmo.startup-context.reading.v1',
    installation: serviceLabel(), read_at: now.toISOString(),
    scope: 'One receipt per launch on a supported path, written at dispatch from the files the launcher was about to compose, and completed at settlement with the host CLI\'s own record. It covers what this installation supplied and what was present to be discovered — not what the session read, not what the host supplied of its own, and not what survived a compaction.',
    retention: {
      days: RETENTION_DAYS, store: blobDir(),
      policy: `Content is addressed by sha256 and shared across every receipt naming it, so repeated launches of unchanged sources cost one copy. \`startup-context --prune\` drops blobs no receipt inside the ${RETENTION_DAYS}-day horizon references. Receipts themselves are never rewritten by expiry: a reader past the horizon is told the policy dropped the content.`,
    },
    receipts: annotated, summary,
  };
}

/** Drop retained content no receipt inside the horizon still references.
 *
 *  Deliberately reference-counted over the receipts rather than keyed on each
 *  blob's own age: two launches 100 days apart can share one blob, and
 *  deleting it on its own mtime would empty a receipt written yesterday. */
export function pruneBlobs(roster: Roster, opts: { now?: Date; apply?: boolean } = {}): {
  horizon: string; referenced: number; kept: number; dropped: { sha256: string; bytes: number }[]; applied: boolean;
} {
  const now = opts.now ?? new Date();
  const horizon = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
  const live = new Set<string>();
  for (const l of Object.values(roster.loops)) {
    for (const receipt of seatReceipts(l.name)) {
      if (receipt.recorded_at < horizon) continue;
      for (const source of receipt.sources) if (source.content.sha256) live.add(source.content.sha256);
      if (receipt.iteration_prompt.sha256) live.add(receipt.iteration_prompt.sha256);
    }
  }
  const dropped: { sha256: string; bytes: number }[] = [];
  let kept = 0;
  let shards: string[];
  try { shards = readdirSync(blobDir()); } catch { shards = []; }
  for (const shard of shards) {
    let names: string[];
    try { names = readdirSync(join(blobDir(), shard)); } catch { continue; }
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      if (live.has(name)) { kept += 1; continue; }
      const file = join(blobDir(), shard, name);
      let bytes = 0;
      try { bytes = statSync(file).size; } catch { continue; }
      dropped.push({ sha256: name, bytes });
      if (opts.apply) { try { rmSync(file); } catch { /* a blob that cannot be removed is reported, not fatal */ } }
    }
  }
  return { horizon, referenced: live.size, kept, dropped, applied: opts.apply === true };
}
