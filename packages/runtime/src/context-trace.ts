// What one session's context actually was, per model invocation, read from the
// host CLI's own record.
//
// context-coverage.ts asks whether this installation's CONFIGURED account is
// still true, and startup-context.ts records what one launch was handed at the
// moment it was handed over. Neither can say what reached the model on the
// fortieth call of a session: what had been added since launch, what the host
// had dropped, and how big any of it was. That is the gap R-55 is for, and the
// audit behind context-coverage (crew:projects/r50/CONTEXT-COVERAGE.md, H-2952)
// recorded it as "No record" on every path. That was too pessimistic. Both host
// CLIs retain a per-invocation ledger, and both record compaction; this module
// reads them, and reports the parts they do NOT hold as its own findings rather
// than as silence (H-3724).
//
// Five distinctions this file is built around, because collapsing any of them
// claims more than the records hold:
//   - INVOCATION vs SESSION. A session is many model calls with different
//     inputs. Every figure here is per invocation, and a session-level total is
//     never presented as the context any one call received.
//   - PRESENT vs RECOVERABLE. A message an invocation references is present in
//     that call's context. It is recoverable only if its content is retained
//     somewhere we can read. Claude's record references far more messages than
//     it retains blobs for, so the fraction is MEASURED per trace and never
//     assumed to be one.
//   - ADDED vs REMOVED vs COMPACTED. A shorter message list is a removal; a
//     removal the host accompanies with a replacement summary is a compaction.
//     Reporting the first as the second would invent a summary, and reporting
//     the second as the first would lose the one record of what replaced the
//     dropped turns.
//   - STRUCTURE vs CONTENT. This module retains no content. It records
//     identity, byte sizes, and the host's own hashes, and leaves the content
//     in the host record and in this installation's own blob store. That keeps
//     a trace free of credentials by construction rather than by redaction, and
//     a hash is the immutable reference the brief asks for.
//   - OBSERVED vs PARTIAL vs UNAVAILABLE. Each required category carries its
//     own state and the reason for it. A category nothing could be said about
//     is named; absent would read as covered.
//
// No collector is added. Everything read here is a file the host CLI already
// wrote, and the trace is derived at read time so a host upgrade that changes
// what it retains shows up as a category going partial rather than as a stored
// figure that quietly stopped being true.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeHome, readClaudeHostRecord } from './context-coverage.js';
import type { LaunchJournalEntry } from './launch-journal.js';
import { readBounded } from './team.js';

/** The most of a host record this reads. The largest rollout on the machine
 *  this was built against was 29.7MB, and unlike context-coverage's bounded
 *  read there is no early stop: a compaction can be the last entry in the
 *  file, so a trace that stopped at the first few entries would report
 *  `evolution` as absent on exactly the sessions that had one. A record over
 *  the ceiling is read as far as the ceiling and says so. */
export const TRACE_BYTE_CEILING = 33_554_432;

export type TraceState = 'observed' | 'partial' | 'unavailable';

/** The categories H-3724 requires a trace to account for. They are a fixed
 *  list because a reading that silently dropped one would read as complete. */
export const TRACE_CATEGORIES = [
  'identity',
  'invocations',
  'instructions',
  'tools',
  'additions',
  'evolution',
  'sizes',
] as const;
export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

export interface TraceSource {
  path: string;
  /** The file's real size, not the amount read. */
  bytes: number;
  read_bytes: number;
  truncated: boolean;
  lines: number;
  /** Lines that did not parse. A host writing a partial last line while the
   *  session runs is the ordinary cause, so this is reported, not fatal. */
  unparseable: number;
}

export interface TraceBlock {
  bytes: number;
  sha256: string;
}

/** One system-prompt-and-tools configuration. Claude re-emits a shape whenever
 *  it changes and names it by hash, so a session's shapes are its instruction
 *  and tool-schema timeline. */
export interface TraceShape {
  ref: string;
  at: string | null;
  system_blocks: TraceBlock[];
  system_bytes: number;
  tools: string[];
  tools_bytes: number;
  /** The first invocation that used it, by ordinal. */
  first_invocation: number;
}

export interface TraceInvocation {
  ordinal: number;
  at: string | null;
  model: string | null;
  shape_ref: string | null;
  /** How many messages this call's context held. `null` where the host records
   *  turns but not the message array it sent (codex). */
  messages: number | null;
  added: number | null;
  removed: number | null;
  /** How many of this call's messages have retained content somewhere
   *  readable. Never assumed equal to `messages`. */
  recoverable: number | null;
  /** The host's own digest of the request, where it writes one. */
  digest: string | null;
  /** Server-side context management the host asked for on this call. */
  managed: string[];
}

export interface TraceCompaction {
  at: string | null;
  trigger: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
  dropped_tokens: number | null;
  /** Messages the host says it carried across, by its own count. */
  preserved_messages: number | null;
  /** An immutable reference to what replaced the dropped turns, where the host
   *  writes one: a response id, or the summary's own hash. */
  replacement: string | null;
  /** How the token figures were arrived at. Unknown overhead is not zero. */
  basis: string;
}

export interface TraceCoverage {
  category: TraceCategory;
  state: TraceState;
  reason: string;
}

export interface ContextTrace {
  harness: 'claude' | 'codex';
  source: TraceSource;
  identity: {
    session_id: string | null;
    cli_version: string | null;
    cwd: string | null;
    models: string[];
    provider: string | null;
    /** The repository revision the session started against, where the host
     *  records it. context-coverage reports this `unsupported` from the launch
     *  journal alone; the codex rollout has it for free. */
    source_revision: string | null;
  };
  shapes: TraceShape[];
  invocations: TraceInvocation[];
  /** Content the host retained for this session's messages, measured. */
  retained: {
    referenced: number | null;
    recoverable: number | null;
    by_role: Record<string, number>;
  };
  compactions: TraceCompaction[];
  coverage: TraceCoverage[];
  /** What this trace cannot reach at all, named so a reader does not take the
   *  categories above for the whole context. */
  unobservable: string[];
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const state = (category: TraceCategory, s: TraceState, reason: string): TraceCoverage => ({ category, state: s, reason });

/** Provider-internal material is the ceiling on every claim here, and it is
 *  the same on both harnesses: what a provider adds, caches or drops inside its
 *  own service is not in any file on this machine. Stated once, carried by
 *  every trace, so no reading of one implies otherwise. */
const PROVIDER_CEILING =
  'anything the provider adds, rewrites, caches or drops inside its own service: no record on this machine observes it';

interface ParsedRecord {
  entries: Record<string, unknown>[];
  source: TraceSource;
  error?: string;
}

function parseRecord(path: string): ParsedRecord {
  const read = readBounded(path, TRACE_BYTE_CEILING);
  if (!read.ok) {
    return { entries: [], source: { path, bytes: read.bytes, read_bytes: 0, truncated: false, lines: 0, unparseable: 0 }, error: read.error };
  }
  const lines = read.text.split('\n');
  // A truncated read's last line is a fragment, not an entry. So is the empty
  // tail of a complete read.
  if (read.truncated) lines.pop();
  const entries: Record<string, unknown>[] = [];
  let unparseable = 0;
  let counted = 0;
  for (const line of lines) {
    if (!line) continue;
    counted++;
    try {
      const parsed: unknown = JSON.parse(line);
      if (record(parsed)) entries.push(parsed);
      else unparseable++;
    } catch {
      unparseable++;
    }
  }
  return {
    entries,
    source: {
      path,
      bytes: read.bytes,
      read_bytes: Buffer.byteLength(read.text, 'utf8'),
      truncated: read.truncated,
      lines: counted,
      unparseable,
    },
  };
}

/** Which host wrote this record, decided by what is in it rather than by where
 *  it sits: the two stores have moved before, and a path is a weaker witness
 *  than an entry. */
export function harnessOf(entries: Record<string, unknown>[]): 'claude' | 'codex' | null {
  for (const e of entries) {
    const type = str(e['type']);
    if (type === 'session_meta' || type === 'turn_context' || type === 'response_item') return 'codex';
    if (type === 'api-request' || type === 'api-request-shape' || type === 'api-request-blob') return 'claude';
    if (type === 'assistant' || type === 'user') {
      // Both stores hold message entries; claude's carry a sessionId and a
      // version, codex nests everything under `payload`.
      if (typeof e['sessionId'] === 'string') return 'claude';
    }
  }
  return null;
}

function claudeTrace(entries: Record<string, unknown>[], source: TraceSource): ContextTrace {
  const shapes = new Map<string, TraceShape>();
  const blobs = new Map<string, { role: string; bytes: number }>();
  const requests: Record<string, unknown>[] = [];
  const compactions: TraceCompaction[] = [];
  let sessionId: string | null = null;
  let cliVersion: string | null = null;
  let cwd: string | null = null;
  const models = new Set<string>();
  let summaryBytes: number | null = null;

  for (const e of entries) {
    const type = str(e['type']);
    if (sessionId === null) sessionId = str(e['sessionId']);
    if (cliVersion === null) cliVersion = str(e['version']);
    if (cwd === null) cwd = str(e['cwd']);
    if (type === 'api-request-shape') {
      const ref = str(e['shapeHash']);
      const shape = e['shape'];
      if (!ref || shapes.has(ref) || !record(shape)) continue;
      const system = Array.isArray(shape['system']) ? shape['system'] : [];
      const tools = Array.isArray(shape['tools']) ? shape['tools'] : [];
      const blocks: TraceBlock[] = [];
      for (const block of system) {
        const text = record(block) ? str(block['text']) : null;
        if (text === null) continue;
        blocks.push({ bytes: bytes(text), sha256: sha256(text) });
      }
      shapes.set(ref, {
        ref,
        at: str(e['timestamp']),
        system_blocks: blocks,
        system_bytes: blocks.reduce((t, b) => t + b.bytes, 0),
        tools: tools.map((t) => (record(t) ? str(t['name']) ?? '(unnamed)' : '(unnamed)')),
        tools_bytes: bytes(JSON.stringify(tools)),
        first_invocation: -1,
      });
    } else if (type === 'api-request-blob') {
      const hash = str(e['hash']);
      const message = e['message'];
      if (!hash || !record(message)) continue;
      blobs.set(hash, { role: str(message['role']) ?? '(unroled)', bytes: bytes(JSON.stringify(message)) });
    } else if (type === 'api-request') {
      requests.push(e);
      const params = e['params'];
      const model = record(params) ? str(params['model']) : null;
      if (model) models.add(model);
    } else if (str(e['subtype']) === 'compact_boundary') {
      const meta = e['compactMetadata'];
      const pre = record(meta) ? num(meta['preTokens']) : null;
      const post = record(meta) ? num(meta['postTokens']) : null;
      const preserved = record(meta) && record(meta['preservedMessages']) && Array.isArray((meta['preservedMessages'] as Record<string, unknown>)['uuids'])
        ? ((meta['preservedMessages'] as Record<string, unknown>)['uuids'] as unknown[]).length
        : null;
      const anchor = record(meta) && record(meta['preservedSegment']) ? str((meta['preservedSegment'] as Record<string, unknown>)['anchorUuid']) : null;
      compactions.push({
        at: str(e['timestamp']),
        trigger: record(meta) ? str(meta['trigger']) : null,
        pre_tokens: pre,
        post_tokens: post,
        dropped_tokens: record(meta) ? num(meta['cumulativeDroppedTokens']) : null,
        preserved_messages: preserved,
        replacement: anchor,
        basis: "the host's own token counts at the boundary, in its units; the summary that replaced the dropped turns is the next entry in this record",
      });
    } else if (e['isCompactSummary'] === true) {
      const message = e['message'];
      const content = record(message) ? message['content'] : null;
      if (typeof content === 'string') summaryBytes = bytes(content);
    }
  }

  // Each request names its base and how many of that base's messages it kept,
  // so the message list of every call is reconstructable without the host ever
  // writing one out. A base this record does not hold leaves the chain open
  // rather than being guessed at.
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of requests) {
    const id = str(r['id']);
    if (id) byId.set(id, r);
  }
  const listOf = new Map<string, string[] | null>();
  const listFor = (r: Record<string, unknown>, depth = 0): string[] | null => {
    const id = str(r['id']) ?? '';
    const cached = listOf.get(id);
    if (cached !== undefined) return cached;
    if (depth > requests.length) return null;
    const baseId = str(r['base']);
    let prefix: string[] | null = [];
    if (baseId !== null) {
      const base = byId.get(baseId);
      prefix = base ? listFor(base, depth + 1) : null;
    }
    const tail = Array.isArray(r['tail']) ? r['tail'].filter((h): h is string => typeof h === 'string') : [];
    const keep = num(r['keep']);
    const list = prefix === null || keep === null ? null : prefix.slice(0, keep).concat(tail);
    listOf.set(id, list);
    return list;
  };

  const invocations: TraceInvocation[] = [];
  const referenced = new Set<string>();
  for (const [i, r] of requests.entries()) {
    const list = listFor(r);
    const baseId = str(r['base']);
    const baseList = baseId !== null ? byId.get(baseId) : undefined;
    const baseLength = baseList ? listFor(baseList)?.length ?? null : 0;
    const keep = num(r['keep']);
    const tail = Array.isArray(r['tail']) ? r['tail'].length : null;
    const params = r['params'];
    const management = record(params) && record(params['context_management']) ? (params['context_management'] as Record<string, unknown>)['edits'] : null;
    const shapeRef = str(r['shapeHash']);
    if (shapeRef && shapes.has(shapeRef)) {
      const shape = shapes.get(shapeRef)!;
      if (shape.first_invocation === -1) shape.first_invocation = i;
    }
    let recoverable: number | null = null;
    if (list) {
      recoverable = 0;
      for (const h of list) {
        referenced.add(h);
        if (blobs.has(h)) recoverable++;
      }
    }
    invocations.push({
      ordinal: i,
      at: str(r['timestamp']),
      model: record(params) ? str(params['model']) : null,
      shape_ref: shapeRef,
      messages: list ? list.length : null,
      added: tail,
      removed: baseLength !== null && keep !== null ? Math.max(0, baseLength - keep) : null,
      recoverable,
      digest: str(r['requestDigest']),
      managed: Array.isArray(management)
        ? management.map((m) => (record(m) ? str(m['type']) ?? '(untyped)' : '(untyped)'))
        : [],
    });
  }

  const byRole: Record<string, number> = {};
  for (const b of blobs.values()) byRole[b.role] = (byRole[b.role] ?? 0) + 1;
  let recoverableTotal = 0;
  for (const h of referenced) if (blobs.has(h)) recoverableTotal++;

  const unroledShape = [...shapes.values()].some((s) => s.tools.includes('(unnamed)'));
  const coverage: TraceCoverage[] = [
    sessionId
      ? state('identity', 'observed', `session ${sessionId}, cli ${cliVersion ?? 'unrecorded'}, cwd from the record's own field`)
      : state('identity', 'partial', 'no entry in this record carries a session id'),
    requests.length === 0
      ? state('invocations', 'unavailable', 'no api-request entries: this host CLI predates the per-request ledger, or the session never reached a model call')
      : invocations.some((i) => i.messages === null)
        ? state('invocations', 'partial', `${invocations.filter((i) => i.messages === null).length} of ${invocations.length} calls name a base this record does not hold, so their message list stops at the gap`)
        : state('invocations', 'observed', `${invocations.length} calls, each with its exact message list, in order, reconstructed from base/keep/tail`),
    shapes.size === 0
      ? state('instructions', 'unavailable', 'no api-request-shape entry: the host instructions and repository rules this session was given are not in this record')
      : state('instructions', 'observed', `${shapes.size} distinct system-prompt configurations, each block hashed; a change mid-session is a new shape with its own first invocation`),
    shapes.size === 0
      ? state('tools', 'unavailable', 'tool definitions travel with the request shape, and no shape is retained')
      : state('tools', unroledShape ? 'partial' : 'observed', unroledShape
        ? 'a retained shape holds a tool entry without a name, so the inventory is incomplete for that configuration'
        : `tool schemas retained in full with every shape; ${[...shapes.values()][0]?.tools.length ?? 0} in the first`),
    referenced.size === 0
      ? state('additions', 'unavailable', 'no message list could be reconstructed, so nothing can be said about what was added')
      : state('additions', recoverableTotal === referenced.size ? 'observed' : 'partial', recoverableTotal === referenced.size
        ? `every one of ${referenced.size} referenced messages has retained content`
        : `${recoverableTotal} of ${referenced.size} referenced messages have retained content (${Math.round((100 * recoverableTotal) / referenced.size)}%). The host retains a blob for the messages it synthesizes — system reminders, recalled memory, injected instruction files — and leaves ordinary turns to this record's own user and assistant entries, which carry no request hash. So the remainder is present in the file but joins only by position, which is an inference and is not asserted here`),
    compactions.length === 0
      ? state('evolution', invocations.some((i) => (i.removed ?? 0) > 0) ? 'partial' : 'observed', invocations.some((i) => (i.removed ?? 0) > 0)
        ? 'a call dropped messages its base held with no compaction boundary recorded, so what replaced them is unknown'
        : 'no messages were dropped in this session and no compaction occurred: the evolution is additions only, and that is a reading, not an absence of coverage')
      : state('evolution', 'observed', `${compactions.length} compaction(s) with the host's own before and after token counts, the preserved messages by id, and the replacement summary in this record${summaryBytes === null ? '' : ` (${summaryBytes} bytes)`}`),
    state('sizes', 'partial', 'byte sizes here are of the retained JSON, measured with Buffer.byteLength; token figures appear only where the host wrote them, in its own units, and the request overhead between the two is not observable from this record'),
  ];

  return {
    harness: 'claude',
    source,
    identity: { session_id: sessionId, cli_version: cliVersion, cwd, models: [...models], provider: null, source_revision: null },
    shapes: [...shapes.values()],
    invocations,
    retained: { referenced: referenced.size, recoverable: recoverableTotal, by_role: byRole },
    compactions,
    coverage,
    unobservable: [
      PROVIDER_CEILING,
      'the content of an ordinary turn that no retained blob names, which is in this record but joins to its invocation only by position',
      'whether the model attended to any of it: every figure here is about what was supplied',
    ],
  };
}

function codexTrace(entries: Record<string, unknown>[], source: TraceSource): ContextTrace {
  const invocations: TraceInvocation[] = [];
  const compactions: TraceCompaction[] = [];
  const models = new Set<string>();
  const shapes = new Map<string, TraceShape>();
  let sessionId: string | null = null;
  let cliVersion: string | null = null;
  let cwd: string | null = null;
  let provider: string | null = null;
  let revision: string | null = null;
  let baseInstructions: TraceBlock | null = null;
  let items = 0;
  let additionalTools = false;
  const usage = new Map<string, number>();
  const deltas: { at: string | null; keys: string[] }[] = [];
  const itemKinds: Record<string, number> = {};

  for (const e of entries) {
    const type = str(e['type']);
    const payload = record(e['payload']) ? (e['payload'] as Record<string, unknown>) : null;
    if (type === 'session_meta' && payload) {
      sessionId = str(payload['session_id']) ?? str(payload['id']);
      cliVersion = str(payload['cli_version']);
      cwd = str(payload['cwd']);
      provider = str(payload['model_provider']);
      const git = record(payload['git']) ? (payload['git'] as Record<string, unknown>) : null;
      revision = git ? str(git['commit_hash']) : null;
      const base = record(payload['base_instructions']) ? (payload['base_instructions'] as Record<string, unknown>) : null;
      const text = base ? str(base['text']) : str(payload['base_instructions']);
      if (text !== null) baseInstructions = { bytes: bytes(text), sha256: sha256(text) };
    } else if (type === 'world_state' && payload) {
      // The origins record: the host writes each source either as its text or
      // as its own hash, and both are the immutable reference a trace needs.
      const stateBlock = record(payload['state']) ? (payload['state'] as Record<string, unknown>) : null;
      if (!stateBlock) continue;
      // `full: false` is a DELTA carrying only the keys that moved. Reading one
      // as a configuration reports every absent key as an empty inventory —
      // the first run of this reader called a tool list of 35 a tool list of 0
      // on the strength of one such entry. A delta is a change point.
      if (payload['full'] !== true) {
        deltas.push({ at: str(e['timestamp']), keys: Object.keys(stateBlock) });
        continue;
      }
      const tools = record(stateBlock['tools']) ? Object.keys(stateBlock['tools'] as Record<string, unknown>) : [];
      const top = record(stateBlock['top_level_tools']) ? Object.keys(stateBlock['top_level_tools'] as Record<string, unknown>) : [];
      const agents = record(stateBlock['agents_md']) ? str((stateBlock['agents_md'] as Record<string, unknown>)['text']) : null;
      const skills = record(stateBlock['host_skills']) ? str((stateBlock['host_skills'] as Record<string, unknown>)['body']) : null;
      const blocks: TraceBlock[] = [];
      if (baseInstructions) blocks.push(baseInstructions);
      if (agents !== null) blocks.push({ bytes: bytes(agents), sha256: sha256(agents) });
      if (skills !== null) blocks.push({ bytes: bytes(skills), sha256: sha256(skills) });
      const ref = sha256(JSON.stringify([blocks.map((b) => b.sha256), tools, top]));
      if (!shapes.has(ref)) {
        shapes.set(ref, {
          ref,
          at: str(e['timestamp']),
          system_blocks: blocks,
          system_bytes: blocks.reduce((t, b) => t + b.bytes, 0),
          tools: [...tools, ...top],
          tools_bytes: bytes(JSON.stringify([stateBlock['tools'], stateBlock['top_level_tools']])),
          first_invocation: invocations.length,
        });
      }
    } else if (type === 'turn_context' && payload) {
      const model = str(payload['model']);
      if (model) models.add(model);
      const collaboration = record(payload['collaboration_mode']) ? (payload['collaboration_mode'] as Record<string, unknown>) : null;
      const settings = collaboration && record(collaboration['settings']) ? (collaboration['settings'] as Record<string, unknown>) : null;
      const developer = settings ? str(settings['developer_instructions']) : null;
      invocations.push({
        ordinal: invocations.length,
        at: str(e['timestamp']),
        model,
        shape_ref: [...shapes.keys()].at(-1) ?? null,
        // The rollout records a turn and every item in order; it does not
        // record the message array sent on each underlying API call, so a
        // per-call count would be our arithmetic rather than the host's.
        messages: null,
        added: null,
        removed: null,
        recoverable: null,
        digest: str(payload['turn_id']),
        managed: developer === null ? [] : [`developer_instructions ${bytes(developer)}B`],
      });
    } else if (type === 'compacted' && payload) {
      const retained = record(payload['retained_context']) ? (payload['retained_context'] as Record<string, unknown>) : null;
      const latest = record(payload['latest_token_usage_record']) ? (payload['latest_token_usage_record'] as Record<string, unknown>) : null;
      const turnUsage = latest && record(latest['turn_token_usage']) ? (latest['turn_token_usage'] as Record<string, unknown>) : null;
      const callUsage = latest && record(latest['usage']) ? (latest['usage'] as Record<string, unknown>) : null;
      const userMessages = retained && Array.isArray(retained['user_messages']) ? retained['user_messages'].length : null;
      const assistantMessages = retained && Array.isArray(retained['assistant_messages']) ? retained['assistant_messages'].length : null;
      const incomplete = retained
        ? retained['incomplete'] === true || retained['user_messages_incomplete'] === true || retained['assistant_messages_incomplete'] === true
        : false;
      compactions.push({
        at: str(e['timestamp']),
        trigger: str(payload['message']) || 'unrecorded',
        pre_tokens: turnUsage ? num(turnUsage['input_tokens']) : null,
        post_tokens: callUsage ? num(callUsage['input_tokens']) : null,
        dropped_tokens: null,
        preserved_messages: userMessages === null && assistantMessages === null ? null : (userMessages ?? 0) + (assistantMessages ?? 0),
        replacement: str(payload['compaction_response_id']),
        basis: `the host's own usage record at the boundary: pre is the turn's input tokens, post is the compacting call's own, and the difference is not a drop figure the host states${incomplete ? '. The host marks its retained set INCOMPLETE, so the preserved count is a floor' : ''}`,
      });
    } else if (type === 'response_item' && payload) {
      items++;
      const kind = str(payload['type']) ?? '(untyped)';
      itemKinds[kind] = (itemKinds[kind] ?? 0) + 1;
      if (kind === 'additional_tools') additionalTools = true;
    } else if (type === 'token_usage_record' && payload) {
      const u = record(payload['usage']) ? (payload['usage'] as Record<string, unknown>) : null;
      if (u) for (const [k, v] of Object.entries(u)) {
        const n = num(v);
        if (n !== null) usage.set(k, (usage.get(k) ?? 0) + n);
      }
    }
  }

  const coverage: TraceCoverage[] = [
    sessionId
      ? state('identity', 'observed', `session ${sessionId}, cli ${cliVersion ?? 'unrecorded'}, provider ${provider ?? 'unrecorded'}, and the cwd repository at ${revision ?? 'an unrecorded revision'}`)
      : state('identity', 'partial', 'no session_meta entry: this record was not opened by a host that writes one'),
    invocations.length === 0
      ? state('invocations', 'unavailable', 'no turn_context entries, so nothing says which model ran with what settings')
      : state('invocations', 'partial', `${invocations.length} turns with their model, settings and sandbox policy in order, and ${items} items in the history. The rollout does not record the message array sent on each underlying API call, so per-call message counts are not available and are not computed here`),
    baseInstructions === null
      ? state('instructions', 'unavailable', 'no base_instructions in session_meta: the host prompt this session was given is not in this record')
      : state('instructions', 'observed', `the host's own prompt verbatim (${baseInstructions.bytes}B), the repository AGENTS.md and the host skills body, each hashed; mode and permission instructions are present as the host's own hashes rather than text${deltas.length === 0 ? '' : `. ${deltas.length} partial world_state update(s) moved only ${[...new Set(deltas.flatMap((d) => d.keys))].join(', ')}, and are recorded as change points rather than read as configurations`}`),
    shapes.size === 0
      ? state('tools', 'unavailable', 'no world_state entry, so the tool inventory this session was given is not in this record')
      : state('tools', 'partial', `${[...shapes.values()][0]?.tools.length ?? 0} tools named. Server descriptions are present as text; top-level tool schemas are present as the host's own hashes, so their sizes are not measurable from this record${additionalTools ? ', and an additional_tools item means the inventory changed mid-session' : ''}`),
    items === 0
      ? state('additions', 'unavailable', 'no response_item entries, so nothing says what was added during the session')
      : state('additions', 'observed', `${items} items in recorded order: messages, reasoning, tool calls and tool outputs, each with its content`),
    compactions.length === 0
      ? state('evolution', 'observed', 'no compaction in this session: the evolution is additions only, and that is a reading, not an absence of coverage')
      : state('evolution', 'partial', `${compactions.length} compaction(s) with the window chain, the replacement response id and the retained user and assistant messages. The host states no dropped-token figure, and marks its retained set's completeness itself, so a count here is a floor`),
    usage.size === 0
      ? state('sizes', 'partial', 'no token_usage_record entries; byte sizes here are of the retained JSON, measured with Buffer.byteLength')
      : state('sizes', 'observed', `the host's own per-response token counts, summed over the session as ${[...usage.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}, in its units`),
  ];

  return {
    harness: 'codex',
    source,
    identity: { session_id: sessionId, cli_version: cliVersion, cwd, models: [...models], provider, source_revision: revision },
    shapes: [...shapes.values()],
    invocations,
    // Every response item carries its own content inline, so an item counted
    // here is an item readable here. `by_role` is the item kind, which is what
    // the rollout distinguishes instead of a message role.
    retained: { referenced: items, recoverable: items, by_role: itemKinds },
    compactions,
    coverage,
    unobservable: [
      PROVIDER_CEILING,
      'the message array of each underlying API call: the rollout records turns and items, not requests',
      'whether the model attended to any of it: every figure here is about what was supplied',
    ],
  };
}

/** Read one host record into a trace. The harness is decided by what the
 *  record contains; a path neither adapter recognises is refused by name
 *  rather than read as the other one. */
export function contextTrace(path: string): ContextTrace | { error: string; source: TraceSource } {
  const parsed = parseRecord(path);
  if (parsed.error) return { error: parsed.error, source: parsed.source };
  const harness = harnessOf(parsed.entries);
  if (harness === null) {
    return {
      error: parsed.entries.length === 0
        ? 'This record holds no parseable entries, so no harness can be identified and no trace can be read.'
        : 'No entry in this record is one either adapter recognises, so the harness that wrote it is unknown and reading it as either would invent the shape.',
      source: parsed.source,
    };
  }
  return harness === 'claude' ? claudeTrace(parsed.entries, parsed.source) : codexTrace(parsed.entries, parsed.source);
}

/** The host record one settled launch's session is written in, or the reason
 *  there is none. The join key is the launch journal's own
 *  `provider_session_id`, and it is only ever there once a launch has SETTLED:
 *  a dispatching entry carries no id, so a live run has no trace and saying so
 *  is the honest answer rather than reading the previous run's file.
 *
 *  The id is validated by `readClaudeHostRecord` and `findCodexRecord` before
 *  either builds a path from it, because the string reaches us through a
 *  journal this process did not write (H-3599). */
export function recordForLaunch(launch: LaunchJournalEntry, cwd: string): { path: string } | { why: string } {
  const session = launch.session;
  if (!session) return { why: `Launch ${launch.launch_id} has not settled, so it carries no host session id to join to.` };
  if (session.provider_session_id_state !== 'observed' || !session.provider_session_id) {
    return { why: `Launch ${launch.launch_id} settled with no observed host session id (${session.provider_session_id_state}), so its host record cannot be located.` };
  }
  const id = session.provider_session_id;
  if (session.provider === 'codex') {
    const path = findCodexRecord(id);
    return path ? { path } : { why: `No rollout under ${codexHome()}/sessions names session ${id}. The host store is the host's: it is not versioned with our releases and nothing stops it being pruned.` };
  }
  const found = readClaudeHostRecord(id, cwd);
  if (!found) return { why: `No transcript under ${claudeHome()}/projects names session ${id}. The host store is the host's: it is not versioned with our releases and nothing stops it being pruned.` };
  return { path: found.path };
}

/** `~/.codex` unless the operator moved it, read from the host's own variable
 *  the way usage.ts reads it. */
export function codexHome(): string {
  const configured = process.env['CODEX_HOME'];
  return configured && configured.trim() ? configured : join(homedir(), '.codex');
}

/** Find a codex rollout by session id. The filename embeds a timestamp as well
 *  as the id and the directory is the session's own date, so the id alone
 *  cannot be turned into a path: the day directories are walked instead, newest
 *  first, and the id is matched as a filename component. */
export function findCodexRecord(sessionId: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const root = join(codexHome(), 'sessions');
  if (!existsSync(root)) return null;
  const walk = (dir: string, depth: number): string | null => {
    let names: string[];
    try { names = readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? `d:${d.name}` : `f:${d.name}`)); } catch { return null; }
    if (depth === 3) {
      for (const name of names) {
        if (!name.startsWith('f:')) continue;
        const file = name.slice(2);
        if (file.endsWith('.jsonl') && file.includes(sessionId)) return join(dir, file);
      }
      return null;
    }
    for (const name of names.filter((n) => n.startsWith('d:')).sort().reverse()) {
      const hit = walk(join(dir, name.slice(2)), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}
