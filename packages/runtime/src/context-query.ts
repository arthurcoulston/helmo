// The read surface over a context trace: what an operator asks, answered from
// the host's own record (H-3724 requirement 6).
//
// context-trace.ts says what a session's record HOLDS, per required category,
// with a state and a reason. That is the inventory question, and it was the
// first thing to settle, because a view built over an unknown boundary shows
// gaps it cannot explain. It is not the operator's question. The operator's
// question is one of three:
//
//   - WHAT WAS IN THE CONTEXT of this call, and where did each part come from?
//     (`contextAt`)
//   - WHAT CHANGED through the run — what entered, what the host dropped, when
//     the instructions or the tool inventory moved, what a compaction replaced?
//     (`contextEvolution`)
//   - WHERE DID THIS COME FROM — this string I can see in a reply or a report:
//     which part of which call's context held it, and when did it enter?
//     (`contextFind`)
//
// Three properties this module is built to keep, because the answer is worth
// nothing if an operator has to discount it:
//
//   - IT SHOWS CONTENT, AND STORES NONE. A part is read out of the host record
//     at read time and printed; nothing is written anywhere. So there is no new
//     store to redact, and the exposure is exactly the operator's own existing
//     read access to their own record.
//   - A RECONSTRUCTED PART IS LABELLED, WITH THIS SESSION'S OWN MEASURED
//     ACCURACY beside it. The host retains a blob for about two parts in five;
//     the rest are joined from the record's transcript by each assistant
//     entry's `requestRef`. That join is an inference, and context-trace.ts
//     measures it against the slots where both exist. A query repeats the
//     measurement rather than the assurance.
//   - A PART NOTHING CAN READ IS SAID TO BE UNREADABLE. Never shown empty: a
//     blank part reads as a part that was blank.
//
// One index, shared with the trace (`indexClaude`), so a query can never
// answer over a different join than the one that was measured.
import { createHash } from 'node:crypto';
import {
  acquiredAccount,
  acquiredArgs,
  acquiredInput,
  renderAcquired,
  type AcquiredAccount,
  type AcquiredInput,
  type AcquiredRequest,
} from './context-acquired.js';
import {
  TRACE_BYTE_CEILING,
  harnessOf,
  indexClaude,
  parseTraceRecord,
  readCodexBaseSegment,
  visibleControls,
  type ClaudeIndex,
  type ClaudeReconstruction,
  type TraceCompaction,
  type TraceSource,
} from './context-trace.js';

/** How much of a part's text an answer carries unless asked for all of it.
 *  A context part can be a 200KB tool result; an operator reading a call's
 *  context wants to recognise each part, and asks for the one they want in
 *  full. Every truncation says so on the part itself. */
export const PREVIEW_CHARS = 400;

export type PartOrigin = 'retained' | 'reconstructed' | 'unreadable';

/** One message in one call's context. */
export interface QueryPart {
  /** Position in that call's message list, as the host built it. */
  slot: number;
  role: string;
  origin: PartOrigin;
  /** Where the content came from: the host's own blob hash, or the transcript
   *  entries it was assembled from. Identity, so an operator can go and look. */
  via: string[];
  types: string[];
  /** Of the retained message, or of the reconstruction where that is what was
   *  read. `null` when no size can be read at all. On an `unreadable` codex
   *  item this is the item's own recorded size, which is a real figure and
   *  often the interesting one — the compaction item a resumed rollout opens
   *  with is 64KB of the call's context that cannot be read here. `part_bytes`
   *  counts only the parts that could be. */
  bytes: number | null;
  /** The first call whose context held this exact slot — so a part that has
   *  been carried for forty calls is distinguishable from one that just
   *  arrived. */
  entered: number | null;
  text: string | null;
  truncated: boolean;
  /** `text` taken apart again, one entry per content block, where the part
   *  carries more than one. A claude message part is often a BUNDLE — the
   *  host's own reminders, the repository instruction file and this
   *  installation's launcher prompt as three separate blocks in one part — and
   *  a reader handed only the joined text has to classify the bundle as one
   *  thing. It is not one thing, and reading it as one put our highest-control
   *  startup input under the host's reminder label (R-56, H-3818).
   *
   *  `null` where there is nothing to take apart: a single-block part, where
   *  `text` IS the block; a part whose text was clipped, where the later
   *  blocks are partial or absent and a per-block reading would be a guess;
   *  and an unreadable part, which holds no blocks at all. Codex writes one
   *  block per item, so this is `null` throughout on that harness. */
  segments: PartSegment[] | null;
  /** The content blocks the host retained, exactly as it wrote them — the
   *  tool_use `input` object, the structured `tool_result` content, the image
   *  part with its own metadata. `text` above is a RENDERING of these: it
   *  prints an image as `[image]` and a tool call as its name and a JSON line,
   *  which is what an operator wants to read and is not what the model was
   *  given. An audit needs the payload, so it is carried verbatim when asked
   *  for and `null` otherwise, because a terminal reading has no use for it
   *  and every part would carry its own copy (R-56, H-3818). `null` is also
   *  what an `unreadable` part has: nothing on this machine holds it. */
  payload: unknown[] | null;
  /** Where this part's content was ACQUIRED from, for the parts that are a
   *  tool's output rather than an instruction, a turn or the model's own
   *  reasoning. A result names its request by the host's call id and carries
   *  nothing else, so this is the join back to it: the tool, and the file,
   *  ticket, command or URL the request named. One part can hold several — a
   *  claude user message carries every result of a parallel batch — so this
   *  is a list. `null`, not an empty list, on a part that is not a result at
   *  all: nothing was acquired there, and `[]` would read as a result whose
   *  sources came to nothing (R-56, H-3818).
   *
   *  Carried whatever the view, unlike `payload`: a source is a name and a
   *  path, and it is the first thing an audit of a context asks for. The
   *  request's own arguments ride along only under the payload view. */
  acquired: AcquiredInput[] | null;
  /** What to discount this part by, where anything. */
  caveat: string | null;
}

/** The host instructions, repository and role rules, and tool schemas in force
 *  for a call — the part of the context that is not a message. */
export interface QueryInstructions {
  ref: string | null;
  /** The invocation this configuration first appeared at. */
  since: number | null;
  blocks: { bytes: number; sha256: string; text: string | null; truncated: boolean }[];
  /** `definition` is the whole tool entry the host recorded — its input schema
   *  included — and is carried only when the caller asked for the payload.
   *  Null otherwise, and null wherever the record holds no entry to carry. */
  tools: { name: string; bytes: number; description: string | null; definition: unknown }[];
  bytes: number;
  tools_bytes: number;
  /** The host's own configuration entry this reading was derived from, whole,
   *  where it holds more than the blocks and tools above decompose it into.
   *
   *  On codex that is the full `world_state`: `blocks` carries the three keys
   *  that are prose a reader can follow, and the entry holds sixteen more —
   *  `environments`, `permissions`, `collaboration_mode`, `skills`, the model
   *  catalogue — which are configuration in force for the call and were
   *  retained all along (2,658 bytes of a 23,430-byte state on the run this
   *  was measured against). On claude it is null: the `api-request-shape`
   *  holds `system` and `tools` and nothing else, so the decomposition above
   *  is the whole of it. Carried only when the payload was asked for. */
  state: unknown | null;
}

export interface ContextAt {
  harness: 'claude' | 'codex';
  session_id: string | null;
  /** What one unit of `ordinal` IS on this harness, because the two records
   *  bound a call differently and a number without its unit is unreadable. */
  call_unit: string;
  /** The host's own size for this call, where it writes one. Not ours: no
   *  tokenizer runs here, and an unknown overhead is not zero. */
  host_tokens: { input: number | null; cached: number | null; basis: string } | null;
  /** Which call, and how many the session made. */
  ordinal: number;
  of: number;
  at: string | null;
  model: string | null;
  instructions: QueryInstructions | null;
  /** The parameters the host sent this call under, as it recorded them —
   *  the betas in force, its context-management edits, the sampling settings.
   *  `model` above is one field of this; the rest change what the call was
   *  and are in the record. Claude writes them per request; a codex rollout
   *  writes no per-call parameters at all, and this is null there rather than
   *  an empty object that would read as "none were sent". Carried only when
   *  the payload was asked for. */
  call_params: unknown | null;
  parts: QueryPart[];
  totals: {
    parts: number;
    retained: number;
    reconstructed: number;
    unreadable: number;
    /** Of the parts that could be read; the unreadable ones are not counted as
     *  zero. */
    part_bytes: number;
  };
  /** This call's context by where it was ACQUIRED from — how many inputs of
   *  each kind, how many bytes of the context they are, and how many distinct
   *  sources they came from. The question "what is this 200KB of context" is
   *  answered here before a reader opens a single part, and `sources` is what
   *  separates one file read forty times from forty files. Empty on a call
   *  whose context holds no tool output. */
  acquired: AcquiredAccount[];
  /** What this answer cannot say. Never empty: the provider ceiling is on
   *  every one. */
  gaps: string[];
}

export interface ContextChange {
  ordinal: number;
  at: string | null;
  /** The parts this call added to its predecessor's context. */
  added: QueryPart[];
  /** How many of the predecessor's parts it dropped, by the host's own keep
   *  count. */
  removed: number | null;
  /** How many parts this call's context held, and the previous call's. A
   *  compaction does not show up in `removed` at all: the host REBASES rather
   *  than truncating, so its keep count is of a new chain and reads 0 while
   *  sixty parts leave. These two are what a drop is actually read against. */
  held: number | null;
  previously: number | null;
  instructions: null | {
    from: string | null;
    to: string;
    tools_added: string[];
    tools_removed: string[];
    blocks_changed: number;
  };
  compaction: null | (TraceCompaction & { replacement_text: string | null; replacement_truncated: boolean });
  /** The host's own input token count for this call, where it writes one.
   *  Never our own arithmetic. */
  host_input_tokens: number | null;
  /** Why this call is worth an operator's attention, in their terms. Empty on
   *  an ordinary turn. */
  notable: string[];
}

export interface ContextEvolution {
  harness: 'claude' | 'codex';
  session_id: string | null;
  changes: ContextChange[];
  gaps: string[];
}

export interface QueryHit {
  where: 'instructions' | 'tool' | 'message';
  /** The shape block, tool name, or message slot it was found in. */
  ref: string;
  origin: PartOrigin | 'configured';
  role: string | null;
  /** The first and last calls whose context held it, and how many did. */
  first_invocation: number | null;
  last_invocation: number | null;
  invocations: number;
  excerpt: string;
}

export interface ContextFind {
  harness: 'claude' | 'codex';
  session_id: string | null;
  needle: string;
  hits: QueryHit[];
  searched: { instructions: number; tools: number; parts: number; unreadable: number };
  gaps: string[];
}

export interface QueryOptions {
  /** Characters of each part's text to carry. `Infinity` for all of it. */
  chars?: number;
  /** Carry each part's retained content blocks and each tool's whole
   *  definition alongside the rendered text, for an audit that has to account
   *  for what was in a call rather than read it. Implies no truncation: a
   *  payload clipped at 400 characters is not the payload. */
  verbatim?: boolean;
}

/** How much of each part an answer carries. One object, because `chars` and
 *  `verbatim` are always decided together and every reader below has to be
 *  handed both or silently answer at the default. */
interface View { chars: number; verbatim: boolean }

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The ceilings every answer carries. The first is the same on both harnesses
 *  and is the hard one: a provider's own handling of a request is in no file on
 *  this machine. The second is the one most easily forgotten when reading a
 *  context: it is what was SUPPLIED. */
const UNIVERSAL_GAPS = [
  'anything the provider adds, rewrites, caches or drops inside its own service: no record on this machine observes it',
  'whether the model attended to any of this: every part here is what was supplied to the call, not what was used',
];

/** One content block of a part, rendered, with the block's OWN size. The size
 *  is measured the way `bytes` on the part is — the serialized block, not its
 *  text — so the two are in the same unit and a block's share of a part can be
 *  read against the part's total. This is the apportioning rule
 *  `claudeAcquired` already uses for a batch of results in one message, said
 *  once for every block kind. */
export interface PartSegment {
  /** The block's own type, which is not the part's: a part carrying a result
   *  and a reminder has two, and a reader that applied the part's type list to
   *  each block would read the reminder as tool traffic. */
  type: string;
  text: string;
  bytes: number;
}

/** A part's content blocks, each rendered as what it IS — a tool call with its
 *  input, a result with its output — rather than skipped, because an operator
 *  reading a context needs the tool traffic most of all. */
function partSegments(parts: unknown[]): PartSegment[] {
  const out: PartSegment[] = [];
  const add = (type: string, text: string, block: unknown): void =>
    void out.push({ type, text, bytes: Buffer.byteLength(JSON.stringify(block) ?? '', 'utf8') });
  for (const b of parts) {
    if (typeof b === 'string') { add('text', b, b); continue; }
    if (!rec(b)) continue;
    const type = str(b['type']);
    if (type === 'text') add('text', str(b['text']) ?? '', b);
    else if (type === 'thinking') add('thinking', `[thinking] ${str(b['thinking']) ?? ''}`, b);
    else if (type === 'tool_use') add('tool_use', `[tool_use ${str(b['name']) ?? '(unnamed)'}] ${JSON.stringify(b['input'])}`, b);
    else if (type === 'tool_result') {
      const content = b['content'];
      add('tool_result', `[tool_result ${str(b['tool_use_id']) ?? ''}] ${typeof content === 'string' ? content : partText(Array.isArray(content) ? content : [content])}`, b);
    } else if (type === 'image') add('image', '[image]', b);
    else add(type ?? 'untyped', `[${type ?? 'untyped'}] ${JSON.stringify(b)}`, b);
  }
  return out;
}

/** A part's text, from the content blocks the record holds. */
function partText(parts: unknown[]): string {
  return partSegments(parts).map((s) => s.text).join('\n');
}

/** A part's blocks for the reader that needs them apart, or `null` where there
 *  is nothing a per-block reading could honestly add. Clipped text is the
 *  reason for the truncation test: the blocks after the cut are partial or
 *  missing, and classifying them would be reading a guess. */
const segmentsFor = (parts: unknown[], truncated: boolean): PartSegment[] | null => {
  if (truncated) return null;
  const segs = partSegments(parts);
  return segs.length > 1 ? segs : null;
};

function clip(text: string, chars: number): { text: string; truncated: boolean } {
  if (text.length <= chars) return { text, truncated: false };
  return { text: text.slice(0, chars), truncated: true };
}

/** The accuracy of a reconstruction of this role, measured on this session's
 *  own validation set — the slots where the host retained a blob AND the
 *  transcript reconstructs one, so the two can be compared. Said per part,
 *  because it is the figure that decides how far to trust the part in front of
 *  you, and a session's overall rate hides that a user message is the inexact
 *  one. */
function reconstructionCaveat(ix: ClaudeIndex, role: string): string {
  const measured = ix.recovery.by_role[role];
  const where = 'assembled from this record\'s transcript by the request id its reply carries, not retained by the host';
  if (!measured || measured.checked === 0) {
    return `${where}; no slot of this role in this session had both a retained blob and a reconstruction, so there is nothing to measure it against here`;
  }
  if (measured.exact === measured.checked) {
    return `${where}; ${measured.exact} of ${measured.checked} ${role} slots in this session that could be checked reconstruct byte for byte`;
  }
  const modes = Object.entries(ix.recovery.modes).map(([why, n]) => `${n}× ${why}`).join('; ');
  return `${where}; ${measured.exact} of ${measured.checked} ${role} slots in this session that could be checked reconstruct byte for byte — the rest differ because of what the host did on the way out (${modes}), so this is the payload it wrote down, not the last form of it`;
}

/** The content blocks this record holds for a slot, retained or reconstructed.
 *  `claudePart` withholds them from a reading that did not ask for the
 *  payload; the join below needs them on every reading, because a tool
 *  request's arguments are what name the source. */
function claudeBlocks(ix: ClaudeIndex, hash: string): unknown[] | null {
  const blob = ix.blobs.get(hash);
  if (blob !== undefined) return blob.parts;
  return ix.reconstructedFor.get(hash)?.parts ?? null;
}

/** Every tool request the readable part of a message list holds, by the host's
 *  own call id. A `tool_result` block names its request by that id and carries
 *  none of it, and the API contract puts the `tool_use` earlier in the SAME
 *  message list — so the list is the whole search space, and a result whose
 *  request is missing from it is a request that left the context, not one this
 *  reader failed to look for. */
function claudeRequests(ix: ClaudeIndex, list: string[]): Map<string, AcquiredRequest> {
  const out = new Map<string, AcquiredRequest>();
  for (const [slot, hash] of list.entries()) {
    for (const b of claudeBlocks(ix, hash) ?? []) {
      if (!rec(b) || b['type'] !== 'tool_use') continue;
      const id = str(b['id']);
      // First wins: a host that reused an id would otherwise have the later
      // call's arguments attributed to the earlier call's result.
      if (id === null || out.has(id)) continue;
      out.set(id, { call_id: id, tool: str(b['name']), args: acquiredArgs(b['input']), slot });
    }
  }
  return out;
}

/** The acquired inputs of one part, from the results its blocks hold. */
function claudeAcquired(
  blocks: unknown[] | null,
  requests: Map<string, AcquiredRequest>,
  view: View,
): AcquiredInput[] | null {
  if (blocks === null) return null;
  const out: AcquiredInput[] = [];
  for (const b of blocks) {
    if (!rec(b) || b['type'] !== 'tool_result') continue;
    const id = str(b['tool_use_id']);
    out.push(acquiredInput(
      id,
      id === null ? undefined : requests.get(id),
      // The result block's own size, not the part's: a batch of four results
      // in one message has to apportion, or every source is credited with the
      // whole message.
      Buffer.byteLength(JSON.stringify(b), 'utf8'),
      typeof b['is_error'] === 'boolean' ? (b['is_error'] as boolean) : null,
      view.verbatim,
    ));
  }
  return out.length === 0 ? null : out;
}

function claudePart(
  ix: ClaudeIndex,
  hash: string,
  slot: number,
  entered: number | null,
  view: View,
  requests: Map<string, AcquiredRequest> = new Map(),
): QueryPart {
  const blob = ix.blobs.get(hash);
  if (blob !== undefined) {
    const { text, truncated } = clip(partText(blob.parts), view.chars);
    return {
      slot,
      role: blob.role,
      origin: 'retained',
      via: [hash],
      types: blob.types,
      bytes: blob.bytes,
      entered,
      text,
      truncated,
      segments: segmentsFor(blob.parts, truncated),
      payload: view.verbatim ? blob.parts : null,
      acquired: claudeAcquired(blob.parts, requests, view),
      caveat: null,
    };
  }
  const made: ClaudeReconstruction | undefined = ix.reconstructedFor.get(hash);
  if (made !== undefined) {
    const { text, truncated } = clip(partText(made.parts), view.chars);
    return {
      slot,
      role: made.role,
      origin: 'reconstructed',
      via: made.via,
      types: made.types,
      bytes: Buffer.byteLength(JSON.stringify({ role: made.role, content: made.parts }), 'utf8'),
      entered,
      text,
      truncated,
      segments: segmentsFor(made.parts, truncated),
      // The blocks the transcript was assembled into, not a retained message.
      // `origin` and `caveat` already say so, and the payload is as much an
      // inference as the text rendered from it.
      payload: view.verbatim ? made.parts : null,
      acquired: claudeAcquired(made.parts, requests, view),
      caveat: reconstructionCaveat(ix, made.role),
    };
  }
  // Named, with its hash, rather than omitted or shown blank. The host
  // referenced this message in the call; nothing on this machine holds it.
  return {
    slot,
    role: '(unknown)',
    origin: 'unreadable',
    via: [hash],
    types: [],
    bytes: null,
    entered,
    text: null,
    truncated: false,
    segments: null,
    payload: null,
    // Nothing on this machine holds this part's blocks, so whether it held a
    // result at all is unknown — which is not the same as it holding none.
    acquired: null,
    caveat: 'the call referenced this message by hash; the host retained no blob for it and the transcript does not reconstruct it, so its content is not on this machine',
  };
}

/** Which call first held each slot, across the whole session. */
function enteredAt(ix: ClaudeIndex): Map<string, number> {
  const first = new Map<string, number>();
  for (const [i, r] of ix.requests.entries()) {
    for (const h of ix.listFor(r) ?? []) if (!first.has(h)) first.set(h, i);
  }
  return first;
}

function claudeInstructions(ix: ClaudeIndex, ref: string | null, view: View): QueryInstructions | null {
  if (ref === null) return null;
  const shape = ix.shapes.get(ref);
  const texts = ix.shapeTexts.get(ref);
  if (!shape || !texts) return null;
  return {
    ref,
    since: shape.first_invocation === -1 ? null : shape.first_invocation,
    blocks: shape.system_blocks.map((b, i) => {
      const { text, truncated } = clip(texts.system[i] ?? '', view.chars);
      return { bytes: b.bytes, sha256: b.sha256, text, truncated };
    }),
    tools: texts.tools.map((t) => ({ ...t, definition: view.verbatim ? t.definition : null })),
    bytes: shape.system_bytes,
    tools_bytes: shape.tools_bytes,
    state: null,
  };
}

const CLAUDE_GAPS = [
  'what the host appended to or wrapped a reconstructed part with on the way out: `caveat` carries this session\'s own measured rate for the role',
];

function claudeAt(ix: ClaudeIndex, ordinal: number, view: View): ContextAt | { error: string } {
  const r = ix.requests[ordinal];
  if (r === undefined) {
    return { error: `this session made ${ix.requests.length} model calls, numbered 0 to ${Math.max(0, ix.requests.length - 1)}` };
  }
  const list = ix.listFor(r);
  const first = enteredAt(ix);
  const params = rec(r['params']) ? (r['params'] as Record<string, unknown>) : null;
  const shapeRef = str(r['shapeHash']);
  // Built over the WHOLE list before any part is, because a result's request
  // is an earlier slot of the same list and the parts are produced in order.
  const requests = claudeRequests(ix, list ?? []);
  const parts = (list ?? []).map((h, i) => claudePart(ix, h, i, first.get(h) ?? null, view, requests));
  const count = (o: PartOrigin) => parts.filter((p) => p.origin === o).length;
  return {
    harness: 'claude',
    session_id: ix.sessionId,
    call_unit: "one api-request — the host's own entry for a model call, naming that call's exact message list",
    // The request entry carries no usage: the host writes the response's
    // counts elsewhere, and `sizes` in the trace says the same thing. Reported
    // as absent rather than as our own byte total dressed up as tokens.
    host_tokens: null,
    ordinal,
    of: ix.requests.length,
    at: str(r['timestamp']),
    model: params ? str(params['model']) : null,
    call_params: view.verbatim ? params : null,
    instructions: claudeInstructions(ix, shapeRef, view),
    parts,
    totals: {
      parts: parts.length,
      retained: count('retained'),
      reconstructed: count('reconstructed'),
      unreadable: count('unreadable'),
      part_bytes: parts.reduce((t, p) => t + (p.bytes ?? 0), 0),
    },
    acquired: acquiredAccount(parts.flatMap((p) => p.acquired ?? [])),
    gaps: [
      ...(list === null
        ? ['this call names a base message list this record does not hold, so the parts below start at the gap rather than at the beginning of the call']
        : []),
      ...CLAUDE_GAPS,
      ...UNIVERSAL_GAPS,
    ],
  };
}

function claudeEvolution(ix: ClaudeIndex, view: View): ContextEvolution {
  const first = enteredAt(ix);
  const changes: ContextChange[] = [];
  // A compaction is placed at the first call after the boundary's timestamp:
  // the host writes the boundary into the transcript, not into a request, so
  // the call it affected is the next one.
  const pending = [...ix.compactions];
  let previousShape: string | null = null;
  for (const [i, r] of ix.requests.entries()) {
    const at = str(r['timestamp']);
    const tail = Array.isArray(r['tail']) ? r['tail'].filter((h): h is string => typeof h === 'string') : [];
    const list = ix.listFor(r);
    const baseId = str(r['base']);
    const base = baseId !== null ? ix.byId.get(baseId) : undefined;
    const baseLength = base ? ix.listFor(base)?.length ?? null : baseId === null ? 0 : null;
    const keep = num(r['keep']);
    const removed = baseLength !== null && keep !== null ? Math.max(0, baseLength - keep) : null;
    const shapeRef = str(r['shapeHash']);
    // Over the full list, not the tail: a call adds the RESULT of a request
    // its predecessor made, so the request is never in the tail with it.
    const requests = claudeRequests(ix, list ?? tail);
    const added = tail.map((h, k) => claudePart(ix, h, (list?.length ?? tail.length) - tail.length + k, first.get(h) ?? null, view, requests));

    let instructions: ContextChange['instructions'] = null;
    if (shapeRef !== null && shapeRef !== previousShape) {
      const now = ix.shapeTexts.get(shapeRef);
      const was = previousShape === null ? undefined : ix.shapeTexts.get(previousShape);
      // The first shape of a session is not a change; it is the configuration.
      if (previousShape !== null || i === 0) {
        const nowTools = (now?.tools ?? []).map((t) => t.name);
        const wasTools = (was?.tools ?? []).map((t) => t.name);
        const nowBlocks = (now?.system ?? []).map((t) => sha256(t));
        const wasBlocks = (was?.system ?? []).map((t) => sha256(t));
        instructions = {
          from: previousShape,
          to: shapeRef,
          tools_added: nowTools.filter((t) => !wasTools.includes(t)),
          tools_removed: wasTools.filter((t) => !nowTools.includes(t)),
          blocks_changed: nowBlocks.filter((h, k) => wasBlocks[k] !== h).length + Math.max(0, wasBlocks.length - nowBlocks.length),
        };
      }
      previousShape = shapeRef;
    }

    let compaction: ContextChange['compaction'] = null;
    if (pending.length > 0 && at !== null && (pending[0]!.at === null || pending[0]!.at <= at)) {
      const c = pending.shift()!;
      const { text, truncated } = clip(ix.summaryText ?? '', view.chars);
      compaction = {
        ...c,
        replacement_text: ix.summaryText === null ? null : text,
        replacement_truncated: ix.summaryText === null ? false : truncated,
      };
    }

    const notable: string[] = [];
    if (compaction !== null) {
      notable.push(`compaction (${compaction.trigger ?? 'trigger unrecorded'}): ${compaction.pre_tokens ?? '?'} → ${compaction.post_tokens ?? '?'} tokens by the host's own count${compaction.replacement_text === null ? ', and this record holds no replacement summary' : ''}`);
      // Not "messages carried across": the host's list is of TRANSCRIPT
      // entries before the boundary, and on the real record 0 of the 5
      // messages its next request actually carried is byte-equal to one of
      // the 50 it lists. Two figures on one screen, and the parts count is
      // the one that came off the request (ward on H-3750, finding 4).
      if (compaction.preserved_messages !== null) {
        notable.push(`the host lists ${compaction.preserved_messages} transcript entries as preserved at that boundary — its own list, not the message array of the next call, which is the parts figure above`);
      }
    }
    if ((removed ?? 0) > 0 && compaction === null) {
      notable.push(`${removed} parts the previous call held were dropped, with no compaction boundary in this record: what replaced them is unknown`);
    }
    if (instructions !== null && instructions.from === null) {
      // The first shape of a session is the configuration, not a change to
      // one. Called a change, it reads as twelve tools having been ADDED at
      // call 0, which is the opposite of what the entry says.
      const shape = ix.shapeTexts.get(instructions.to);
      notable.push(`initial configuration: ${shape?.system.length ?? 0} instruction block(s), ${shape?.tools.length ?? 0} tools`);
    } else if (instructions !== null) {
      if (instructions.tools_added.length > 0 || instructions.tools_removed.length > 0) {
        notable.push(`tool inventory changed${instructions.tools_added.length > 0 ? `, +${instructions.tools_added.join(', +')}` : ''}${instructions.tools_removed.length > 0 ? `, -${instructions.tools_removed.join(', -')}` : ''}`);
      }
      if (instructions.blocks_changed > 0) notable.push(`${instructions.blocks_changed} instruction block(s) changed`);
    }
    if (list === null) notable.push('this call names a base this record does not hold, so its own context cannot be listed in full');
    const previousList = i === 0 ? null : ix.listFor(ix.requests[i - 1]!)?.length ?? null;
    if (list !== null && previousList !== null && list.length < previousList) {
      notable.push(`this call's context holds ${list.length} parts where the previous call's held ${previousList}: ${previousList - list.length} left it${(removed ?? 0) === 0 ? ', and the host rebased rather than truncating, so its own keep count reads 0' : ''}`);
    }
    changes.push({ ordinal: i, at, added, removed, held: list?.length ?? null, previously: previousList, instructions, compaction, host_input_tokens: null, notable });
  }
  // A boundary after the last call still happened, and dropping it would lose
  // the one compaction a session that ended on it ever had.
  for (const c of pending) {
    const { text, truncated } = clip(ix.summaryText ?? '', view.chars);
    changes.push({
      ordinal: ix.requests.length,
      at: c.at,
      added: [],
      removed: null,
      held: null,
      previously: null,
      instructions: null,
      host_input_tokens: null,
      compaction: { ...c, replacement_text: ix.summaryText === null ? null : text, replacement_truncated: ix.summaryText === null ? false : truncated },
      notable: [`compaction (${c.trigger ?? 'trigger unrecorded'}) after the last model call in this record`],
    });
  }
  return {
    harness: 'claude',
    session_id: ix.sessionId,
    changes,
    gaps: [...CLAUDE_GAPS, ...UNIVERSAL_GAPS],
  };
}

function claudeFind(ix: ClaudeIndex, needle: string, chars: number): ContextFind {
  const lower = needle.toLowerCase();
  const held = new Map<string, number[]>();
  for (const [i, r] of ix.requests.entries()) {
    for (const h of ix.listFor(r) ?? []) {
      const seen = held.get(h);
      if (seen) seen.push(i);
      else held.set(h, [i]);
    }
  }
  const hits: QueryHit[] = [];
  const searched = { instructions: 0, tools: 0, parts: 0, unreadable: 0 };
  const excerpt = (text: string): string => {
    const at = text.toLowerCase().indexOf(lower);
    const from = Math.max(0, at - Math.floor(chars / 2));
    return `${from > 0 ? '…' : ''}${text.slice(from, from + chars)}${from + chars < text.length ? '…' : ''}`;
  };
  for (const [ref, texts] of ix.shapeTexts) {
    const shape = ix.shapes.get(ref);
    const since = shape && shape.first_invocation !== -1 ? shape.first_invocation : null;
    // Which calls actually ran under this configuration. Reported as 0 it read
    // as "held by no call", of a block that was in every call of the session.
    const under = ix.requests
      .map((r, i) => (str(r['shapeHash']) === ref ? i : -1))
      .filter((i) => i !== -1);
    const span = { first_invocation: since, last_invocation: under.at(-1) ?? null, invocations: under.length };
    for (const [k, text] of texts.system.entries()) {
      searched.instructions++;
      if (!text.toLowerCase().includes(lower)) continue;
      hits.push({ where: 'instructions', ref: `${ref.slice(0, 12)} block ${k}`, origin: 'configured', role: 'system', ...span, excerpt: excerpt(text) });
    }
    for (const t of texts.tools) {
      searched.tools++;
      const text = `${t.name} ${t.description ?? ''}`;
      if (!text.toLowerCase().includes(lower)) continue;
      hits.push({ where: 'tool', ref: t.name, origin: 'configured', role: 'tool', ...span, excerpt: excerpt(text) });
    }
  }
  for (const [hash, invocations] of held) {
    const part = claudePart(ix, hash, -1, invocations[0] ?? null, { chars: Infinity, verbatim: false });
    if (part.text === null) { searched.unreadable++; continue; }
    searched.parts++;
    if (!part.text.toLowerCase().includes(lower)) continue;
    hits.push({
      where: 'message',
      ref: hash.slice(0, 12),
      origin: part.origin,
      role: part.role,
      first_invocation: invocations[0] ?? null,
      last_invocation: invocations.at(-1) ?? null,
      invocations: invocations.length,
      excerpt: excerpt(part.text),
    });
  }
  hits.sort((a, b) => (a.first_invocation ?? -1) - (b.first_invocation ?? -1));
  return {
    harness: 'claude',
    session_id: ix.sessionId,
    needle,
    hits,
    searched,
    gaps: [
      ...(searched.unreadable > 0
        ? [`${searched.unreadable} referenced parts could not be read at all, so a match inside one of them would not appear here: a nil result is "not found in what is readable", never "was not in the context"`]
        : []),
      ...CLAUDE_GAPS,
      ...UNIVERSAL_GAPS,
    ],
  };
}

// --- codex ------------------------------------------------------------------
//
// The rollout holds every item's content inline, so nothing is reconstructed
// and nothing needs measuring. What it does NOT hold is the message array sent
// on each API call: it records turns and items. So a turn's context here is
// every item recorded before it, in order — which is this reader's arithmetic
// and is labelled as such on every answer, rather than presented as the host's
// own list.

/** Whether an item is something the MODEL produced rather than something
 *  supplied to it. The distinction is what separates a call's input context
 *  from its own output inside one usage window: a `custom_tool_call_output` is
 *  an input to the NEXT call, while the `custom_tool_call` above it was this
 *  call's own doing. An unrecognised kind counts as input, which overstates
 *  rather than drops — and the overstatement is named on the answer. */
const MODEL_PRODUCED = (kind: string, role: string | null): boolean =>
  kind === 'reasoning' || /_call$/.test(kind) || (kind === 'message' && role === 'assistant');

/** One item of a codex rollout's context, as this reader holds it. */
interface CodexItem {
  at: string | null;
  kind: string;
  role: string | null;
  text: string;
  bytes: number;
  /** Why this item's content is not readable here, where it is not. */
  opaque: string | null;
  /** The response item the host wrote, whole. `text` above is what this
   *  reader could make of it; an audit asking what a call carried needs the
   *  entry, including the fields no rendering has a place for — a tool call's
   *  arguments, an image part's own metadata, the `encrypted_content` of a
   *  reasoning item whose plaintext is nowhere on this machine (R-56,
   *  H-3818). */
  payload: Record<string, unknown>;
}

interface CodexIndex {
  sessionId: string | null;
  cwd: string | null;
  /** Each turn_context, in order. A turn is a user turn, not a model call: one
   *  loop iteration is a single turn with a dozen calls inside it. */
  turns: { at: string | null; model: string | null; turn_id: string | null; before: number }[];
  /** Each token_usage_record, in order — one per API call, carrying the
   *  provider's own `response_id` for that call and the host's own input token
   *  count for it. This is the finest call boundary the rollout holds, and the
   *  only one with the host's identity on it; `turns` are far too coarse to
   *  read a context by. The message ARRAY of the call is still not recorded,
   *  which is the standing codex ceiling. */
  calls: {
    at: string | null; response_id: string | null; turn_id: string | null;
    input: number | null; cached: number | null;
    /** Every item recorded before this call's usage entry — its window, which
     *  also holds what the call itself produced. */
    before: number;
    /** The items that were its INPUT: the window up to its own first output
     *  item. The host writes the usage record AFTER the call, so the window
     *  ends with that call's reasoning, its assistant message and its tool
     *  call — none of which was in the context it was given. */
    inputs: number;
  }[];
  /** Each response_item, in order, with the text it carries — or the reason
   *  this record holds no plaintext for it. */
  items: CodexItem[];
  /** The last `full: true` world_state at or before each item index. */
  instructions: { at: string | null; index: number; blocks: { bytes: number; sha256: string; text: string }[]; tools: { name: string; bytes: number; description: string | null; definition: unknown }[]; state: Record<string, unknown> }[];
  /** `full: false` entries: a delta, naming only the keys that moved. Read as
   *  a configuration one reports every absent key as empty — the trap the
   *  first reading of this record fell into. */
  deltas: { at: string | null; index: number; keys: string[] }[];
  /** Each compaction, with the item index it landed on, how many calls and
   *  turns the rollout had recorded by then, and the items the host wrote as
   *  the context that REPLACED everything before it. The rollout carries that
   *  list (`replacement_history`), so a call after a compaction has a knowable
   *  context, and the items it dropped can be named as dropped instead of
   *  listed as still present. */
  compactions: (TraceCompaction & { index: number; calls_before: number; turns_before: number; replacement_items: CodexItem[] })[];
  /** Where this file picks up in its thread, when the host wrote it as a
   *  CONTINUATION of one. `session_meta.history_base` names the thread and the
   *  ordinal this rollout begins at — the file's own first entry carries that
   *  same ordinal — so the entries before it are in a different rollout of the
   *  same thread id and no part of this one holds them. `null` is the ordinary
   *  case: every codex record carries `history_mode: paginated`, and 864 of
   *  the 867 on the machine this was built against open their own thread at
   *  ordinal 0. */
  historyBase: { thread_id: string | null; entries_before: number; byte_offset: number | null } | null;
  /** The thread's earlier segment, read. Set only where `historyBase` is, and
   *  only by `indexCodexRecord`: `indexCodex` is pure over the entries it is
   *  given, and resolving a base is a read of another file. */
  base: CodexBase | null;
  /** Why there is no `base` to read, where there is a `historyBase`. */
  baseWhy: string | null;
  baseInstructions: { bytes: number; sha256: string; text: string } | null;
}

/** The thread's earlier segment, reduced to the context it held at the cut.
 *  Those items were in every call of this segment until a compaction replaced
 *  them, so they are the first slots of each such call's context rather than a
 *  gap in it. */
export interface CodexBase {
  /** The earlier record itself, so an operator can go and read it. */
  record: string;
  thread_id: string | null;
  /** Entries of it before the cut — the base's own ordinal. */
  entries: number;
  /** Its live items at the cut: the last replacement list it holds plus what it
   *  recorded after that boundary. Read by the same two rules a call's context
   *  is read by here, because a parent that compacted carries items its own
   *  boundary had already dropped — one of the three real ones holds 476 items
   *  in its prefix, of which 101 were live. */
  items: CodexItem[];
  /** Every earlier segment this followed, nearest first. */
  chain: string[];
  /** What is STILL outside the reading: the earlier segment is itself a
   *  continuation whose own base did not resolve. */
  short: string | null;
}

/** One part of a message's content. Text is its text; a part that is NOT text
 *  is named with its size, never printed as its own data. One carried-in
 *  message on this machine holds two `input_image` parts of 537,630 and
 *  223,746 characters of base64 data URL: printed as the message's text, they
 *  are half a megabyte of base64 presented as what the model was told, which
 *  is the same defect as dumping a compaction item's ciphertext (ward on
 *  H-3750, finding 2). The image WAS in the context, and its own size is the
 *  readable fact about it — the model was given it as image tokens, which no
 *  byte count here converts to. */
function contentPart(c: unknown): string {
  if (!rec(c)) return String(c);
  const text = str(c['text']) ?? str(c['output']);
  if (text !== null) return text;
  const kind = str(c['type']) ?? 'part';
  const url = str(c['image_url']) ?? (rec(c['image_url']) ? str((c['image_url'] as Record<string, unknown>)['url']) : null);
  if (url !== null) {
    const inline = /^data:/.test(url);
    return `[${kind}: ${inline ? `${Buffer.byteLength(url, 'utf8')} bytes of inline image data (${url.slice(0, url.indexOf(',') + 1 || 32)}…)` : url}, not text]`;
  }
  return JSON.stringify(c);
}

/** The text one response item carries, or `null` where this record holds none
 *  in any field this reader knows. A payload's own JSON is never its text: a
 *  `[compaction] {"encrypted_content":…}` dump is 64KB of ciphertext presented
 *  as what the model was shown, which is the one thing it is not (ward on
 *  H-3750, finding 2). */
function itemText(payload: Record<string, unknown>): string | null {
  const content = payload['content'];
  if (Array.isArray(content)) {
    return content.map(contentPart).join('\n');
  }
  if (typeof content === 'string') return content;
  for (const key of ['text', 'output', 'arguments', 'summary', 'message']) {
    const v = payload[key];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(contentPart).join('\n');
  }
  return null;
}

/** One response item as this reader holds it: the text it carries, or the
 *  reason this record holds no plaintext for it. One function, because the
 *  items a compaction's `replacement_history` carries are read by the same
 *  rules as the items it replaced. */
function codexItem(at: string | null, payload: Record<string, unknown>): CodexItem {
  const kind = str(payload['type']) ?? '(untyped)';
  const text = itemText(payload);
  // An item whose plaintext this record does not hold. The reasoning items
  // are the standing case and they are not an edge: the host writes
  // `summary: []` and an `encrypted_content` blob, so the item WAS in the
  // call's context and what it said is not on this machine. Shown as the
  // empty string it parses to, it would read as a part that was blank; shown
  // as its own JSON, as a part that said something else entirely.
  const encrypted = typeof payload['encrypted_content'] === 'string';
  const opaque = text !== null && text.trim() !== ''
    ? null
    : encrypted
      ? `the host records this ${kind} item's content only as provider-encrypted text (encrypted_content), so what it said is not on this machine — it was in the call's context all the same`
      : `this ${kind} item carries no text in any field this reader knows (keys: ${Object.keys(payload).join(', ')})`;
  return {
    at,
    kind,
    role: str(payload['role']),
    text: text ?? '',
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    opaque,
    payload,
  };
}

/** Whether a codex item is the OUTPUT of a tool call. Keyed on carrying both
 *  a `call_id` and an `output`, not on the item type: the rollouts hold
 *  `function_call_output` and `custom_tool_call_output` today and the host
 *  adds types without asking, and an item with those two fields is a result
 *  whatever it is called. */
const codexOutput = (p: Record<string, unknown>): boolean => typeof p['call_id'] === 'string' && 'output' in p;

/** Every tool request a codex item list holds, by the host's own call id. The
 *  request is its own item in the same list — `custom_tool_call` carries its
 *  whole input as a string, `function_call` carries JSON in `arguments` — so
 *  this is the same join as claude's over a different shape. */
function codexRequests(items: { item: CodexItem }[]): Map<string, AcquiredRequest> {
  const out = new Map<string, AcquiredRequest>();
  for (const [slot, { item }] of items.entries()) {
    const p = item.payload;
    const id = str(p['call_id']);
    if (id === null || codexOutput(p) || out.has(id)) continue;
    const raw = 'input' in p ? p['input'] : 'arguments' in p ? p['arguments'] : undefined;
    if (raw === undefined) continue;
    // The namespace is part of the tool's identity where the host records one:
    // `js` says nothing, `mcp__cua_repl/js` says which server answered.
    const ns = str(p['namespace']);
    const name = str(p['name']);
    out.set(id, { call_id: id, tool: ns === null ? name : `${ns}/${name ?? '(unnamed)'}`, args: acquiredArgs(raw), slot });
  }
  return out;
}

/** The acquired input of one codex item, where it is a tool output. A codex
 *  result is its own item, so there is at most one — the list keeps the shape
 *  the same as claude's, where a batch arrives in a single message. */
function codexAcquired(item: CodexItem, requests: Map<string, AcquiredRequest>, view: View): AcquiredInput[] | null {
  const p = item.payload;
  if (!codexOutput(p)) return null;
  const id = str(p['call_id']);
  return [acquiredInput(
    id,
    id === null ? undefined : requests.get(id),
    item.bytes,
    // The host writes no error flag on an output item; the tool's own text
    // carries whatever it said. Reported as unknown rather than as `false`,
    // which would claim every codex result succeeded.
    null,
    view.verbatim,
  )];
}

function indexCodex(entries: Record<string, unknown>[]): CodexIndex {
  const ix: CodexIndex = { sessionId: null, cwd: null, turns: [], calls: [], items: [], instructions: [], deltas: [], compactions: [], historyBase: null, base: null, baseWhy: null, baseInstructions: null };
  for (const e of entries) {
    const type = str(e['type']);
    const at = str(e['timestamp']);
    const payload = rec(e['payload']) ? (e['payload'] as Record<string, unknown>) : null;
    if (type === 'session_meta' && payload) {
      ix.sessionId = str(payload['session_id']) ?? str(payload['id']);
      ix.cwd = str(payload['cwd']);
      const history = rec(payload['history_base']) ? (payload['history_base'] as Record<string, unknown>) : null;
      const before = history ? num(history['end_ordinal_exclusive']) : null;
      // Zero is not a base. Every rollout is written in `paginated` history
      // mode, and a session that opened its own thread names no ordinal to
      // pick up from; only a positive one means entries exist that this file
      // does not have.
      if (history !== null && before !== null && before > 0) {
        ix.historyBase = { thread_id: str(history['thread_id']), entries_before: before, byte_offset: num(history['end_byte_offset']) };
      }
      const base = rec(payload['base_instructions']) ? (payload['base_instructions'] as Record<string, unknown>) : null;
      const text = base ? str(base['text']) : str(payload['base_instructions']);
      if (text !== null) ix.baseInstructions = { bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), text };
    } else if (type === 'world_state' && payload) {
      const state = rec(payload['state']) ? (payload['state'] as Record<string, unknown>) : null;
      if (!state) continue;
      if (payload['full'] !== true) {
        ix.deltas.push({ at, index: ix.items.length, keys: Object.keys(state) });
        continue;
      }
      const blocks: { bytes: number; sha256: string; text: string }[] = [];
      if (ix.baseInstructions) blocks.push(ix.baseInstructions);
      for (const key of ['agents_md', 'host_skills']) {
        const block = rec(state[key]) ? (state[key] as Record<string, unknown>) : null;
        const text = block ? str(block['text']) ?? str(block['body']) : null;
        if (text !== null) blocks.push({ bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), text });
      }
      const tools: { name: string; bytes: number; description: string | null; definition: unknown }[] = [];
      for (const key of ['tools', 'top_level_tools']) {
        const map = rec(state[key]) ? (state[key] as Record<string, unknown>) : null;
        if (!map) continue;
        for (const [name, value] of Object.entries(map)) {
          tools.push({
            name,
            bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
            description: typeof value === 'string' ? value : rec(value) ? str(value['description']) : null,
            definition: value,
          });
        }
      }
      ix.instructions.push({ at, index: ix.items.length, blocks, tools, state });
    } else if (type === 'turn_context' && payload) {
      ix.turns.push({ at, model: str(payload['model']), turn_id: str(payload['turn_id']), before: ix.items.length });
    } else if (type === 'response_item' && payload) {
      ix.items.push(codexItem(at, payload));
    } else if (type === 'token_usage_record' && payload) {
      const usage = rec(payload['usage']) ? (payload['usage'] as Record<string, unknown>) : null;
      const from = ix.calls.at(-1)?.before ?? 0;
      const produced = ix.items.slice(from).findIndex((i) => MODEL_PRODUCED(i.kind, i.role));
      ix.calls.push({
        at,
        response_id: str(payload['response_id']),
        turn_id: str(payload['turn_id']),
        input: usage ? num(usage['input_tokens']) : null,
        cached: usage ? num(usage['cached_input_tokens']) : null,
        before: ix.items.length,
        inputs: produced === -1 ? ix.items.length : from + produced,
      });
    } else if (type === 'compacted' && payload) {
      const retained = rec(payload['retained_context']) ? (payload['retained_context'] as Record<string, unknown>) : null;
      const latest = rec(payload['latest_token_usage_record']) ? (payload['latest_token_usage_record'] as Record<string, unknown>) : null;
      const turnUsage = latest && rec(latest['turn_token_usage']) ? (latest['turn_token_usage'] as Record<string, unknown>) : null;
      const callUsage = latest && rec(latest['usage']) ? (latest['usage'] as Record<string, unknown>) : null;
      const user = retained && Array.isArray(retained['user_messages']) ? retained['user_messages'].length : null;
      const assistant = retained && Array.isArray(retained['assistant_messages']) ? retained['assistant_messages'].length : null;
      const incomplete = retained
        ? retained['incomplete'] === true || retained['user_messages_incomplete'] === true || retained['assistant_messages_incomplete'] === true
        : false;
      const history = Array.isArray(payload['replacement_history']) ? payload['replacement_history'] : [];
      ix.compactions.push({
        index: ix.items.length,
        // The rollout's own order, not arithmetic over it: the first call
        // recorded after this boundary is the first one whose context was the
        // replacement list.
        calls_before: ix.calls.length,
        turns_before: ix.turns.length,
        replacement_items: history.filter(rec).map((item) => codexItem(at, item)),
        at,
        trigger: str(payload['message']) || 'unrecorded',
        pre_tokens: turnUsage ? num(turnUsage['input_tokens']) : null,
        post_tokens: callUsage ? num(callUsage['input_tokens']) : null,
        dropped_tokens: null,
        preserved_messages: user === null && assistant === null ? null : (user ?? 0) + (assistant ?? 0),
        replacement: str(payload['compaction_response_id']),
        basis: `the host's own usage record at the boundary${incomplete ? '; the host marks its retained set INCOMPLETE, so the preserved count is a floor' : ''}`,
      });
    }
  }
  return ix;
}

const CODEX_GAPS = [
  'the message array sent on each API call: the rollout records turns and items, so a call\'s context here is the items recorded before it, in order — this reader\'s arithmetic, not a list the host wrote',
];

/** The items a rollout's context held at the END of it: the last replacement
 *  list it recorded, plus the items recorded after that boundary. The same two
 *  rules `codexAt` reads a call's context by, and they matter most here — a
 *  thread's earlier segment that compacted holds items its own boundary had
 *  already dropped, 476 in the prefix of one of the three real ones against
 *  101 that were live. */
const codexLiveItems = (ix: CodexIndex): CodexItem[] => {
  const last = ix.compactions.at(-1) ?? null;
  return [...(last?.replacement_items ?? []), ...ix.items.slice(last?.index ?? 0)];
};

/** How many earlier segments of one thread this will follow. A chain longer
 *  than this is a store shape nothing here has seen, and a reading that walked
 *  it unbounded would be reading a loop. */
const BASE_HOPS = 8;

/** Read the thread's earlier segment, and its own earlier segment behind that,
 *  into the context it handed on.
 *
 *  Resolution is `readCodexBaseSegment`'s, which identifies the parent by the
 *  CUT rather than by its name: the base's byte offset is the parent's own byte
 *  length through exactly the entries this file picks up after. What is added
 *  here is the reading — the parent's live items, which is what the calls of
 *  this segment were actually given, and not every item its file holds. */
function resolveCodexBase(
  path: string,
  base: NonNullable<CodexIndex['historyBase']>,
  seen: string[],
): CodexBase | { why: string } {
  const read = readCodexBaseSegment(path, base);
  if ('why' in read) return read;
  if (seen.includes(read.path)) {
    return { why: `the thread's segments lead back to ${read.path}, which this reading has already followed, so the chain is not followed round again` };
  }
  const ix = indexCodex(read.entries);
  const items = codexLiveItems(ix);
  const segment: CodexBase = { record: read.path, thread_id: base.thread_id, entries: base.entries_before, items, chain: [read.path], short: null };
  // The earlier segment may be a continuation too. Its own base is in force at
  // its end only if it recorded no compaction — a boundary there replaced the
  // context with a list the file itself holds, which is why `codexLiveItems`
  // starts from it.
  if (ix.historyBase === null || ix.compactions.length > 0) return segment;
  if (seen.length + 1 >= BASE_HOPS) {
    return { ...segment, short: `${read.path} continues thread ${ix.historyBase.thread_id ?? '(unnamed)'} from ordinal ${ix.historyBase.entries_before} in its turn, and this reading stops at ${BASE_HOPS} segments, so what that segment carried in is not read` };
  }
  const up = resolveCodexBase(read.path, ix.historyBase, [...seen, read.path]);
  if ('why' in up) {
    return { ...segment, short: `${read.path} continues thread ${ix.historyBase.thread_id ?? '(unnamed)'} from ordinal ${ix.historyBase.entries_before} in its turn, and that segment did not resolve: ${up.why}` };
  }
  return { ...segment, items: [...up.items, ...items], chain: [...segment.chain, ...up.chain], short: up.short };
}

/** One codex record, indexed, with the thread's earlier segment read where it
 *  names one. The two steps are separate functions because the first is pure
 *  over the entries handed to it and the second reads another file: a caller
 *  holding entries from somewhere other than a path keeps the index it can
 *  have. */
function indexCodexRecord(path: string, entries: Record<string, unknown>[]): CodexIndex {
  const ix = indexCodex(entries);
  if (ix.historyBase === null) return ix;
  const resolved = resolveCodexBase(path, ix.historyBase, [path]);
  if ('why' in resolved) ix.baseWhy = resolved.why;
  else ix.base = resolved;
  return ix;
}

/** The ordinal of the first call recorded AFTER a compaction — the first one
 *  whose context was the host's replacement list. Read off the counts the
 *  rollout had reached at the boundary, so a rollout with no usage records is
 *  measured in its turns and not silently in calls it does not have. */
const afterCompaction = (c: CodexIndex['compactions'][number], byUsage: boolean): number =>
  (byUsage ? c.calls_before : c.turns_before);

/** Whether a call was given context this record does not hold: the rollout
 *  continues a thread from a history base, and no compaction has replaced the
 *  context since. A compaction ENDS the shortfall rather than deepening it —
 *  the host writes its replacement list into THIS file, so from the first
 *  boundary on the context is wholly here. */
const codexBaseInForce = (ix: CodexIndex, ordinal: number, byUsage: boolean): boolean =>
  ix.historyBase !== null && ordinal >= 0 && !ix.compactions.some((c) => afterCompaction(c, byUsage) <= ordinal);

/** Whether that context is also UNREADABLE — the base is in force and no
 *  earlier segment was resolved for it. The two were one predicate until the
 *  earlier record could be read: a call whose context ran back into the
 *  thread's earlier segment is no longer short of anything once that segment
 *  is spliced in, and every "cannot be counted here" was keyed on the
 *  structural fact rather than on the reading. */
const codexBaseShort = (ix: CodexIndex, ordinal: number, byUsage: boolean): boolean =>
  ix.base === null && codexBaseInForce(ix, ordinal, byUsage);

/** The earlier segment's items, where they were part of this call's context:
 *  the base in force, and a segment read for it. The first slots of the call,
 *  in the order the thread recorded them. */
const codexBaseItems = (ix: CodexIndex, ordinal: number, byUsage: boolean): CodexItem[] =>
  ix.base !== null && codexBaseInForce(ix, ordinal, byUsage) ? ix.base.items : [];

/** What a rollout that CONTINUES a thread does not hold, and until when.
 *  Every reading here listed what the file has as if it were the whole
 *  context. On the three such records on this machine that was `--at 0`
 *  showing 5 parts for a call the host's own usage record puts at 91,273 input
 *  tokens (88,192 of them cached), 2 parts against 77,407, and 0 parts against
 *  243,044 — the last of which ward found, with nothing on the answer or the
 *  boundary row reconciling the two (H-3763). */
const codexHistoryBaseSays = (ix: CodexIndex): string | null => {
  const base = ix.historyBase;
  if (base === null) return null;
  const byUsage = ix.calls.length > 0;
  const of = byUsage ? ix.calls.length : ix.turns.length;
  const first = ix.compactions[0];
  const until = first === undefined ? null : afterCompaction(first, byUsage);
  const span = until === null || until >= of
    ? `No compaction replaced the context at a call this record holds, so EVERY one of its ${of} calls was given the thread's earlier entries`
    : `Every call before the compaction on call ${until} was given the thread's earlier entries; from that boundary on the host wrote its replacement list into this file`;
  // Where the earlier segment resolves, the reading is no longer short: its
  // live items are the first slots of each of those calls. Where it does not,
  // the reason is the operator's only lead, so it is quoted rather than
  // summarised.
  const read = ix.base !== null
    ? `Those entries are in ${ix.base.record}, read here: the ${ix.base.items.length} items the thread held at the cut are listed as the first parts of each of those calls${ix.base.chain.length > 1 ? `, through ${ix.base.chain.length} segments of the thread` : ''}${ix.base.short === null ? '' : `. ${ix.base.short}`}`
    : `No earlier record was read for them, so what this file holds is all this answer has: ${ix.baseWhy ?? 'no reason was recorded, which is itself a defect'}`;
  return `this rollout CONTINUES thread ${base.thread_id ?? '(unnamed)'} rather than opening it: its session_meta carries a history_base at ordinal ${base.entries_before}${base.byte_offset === null ? '' : `, byte ${base.byte_offset}`}, and this file's own entries begin there, so the ${base.entries_before} entries the thread recorded before it are in a different rollout of the same thread id and in no part of this one. ${span}. ${read}`;
};

/** How many parts one call's context actually held: the replacement list in
 *  force plus the items recorded since that boundary. This is the figure for
 *  what a LATER boundary dropped — never the file's item count, which counts
 *  items earlier boundaries had already taken out. At the second boundary of
 *  01a1651a-98d5 the file had recorded 400 items and the call before it held
 *  211 parts; 216 of those 400 left at the first boundary (ward on H-3757,
 *  finding 3c). Built by the same two rules as `codexAt`'s `held`, so the two
 *  readings cannot drift. */
const codexPartsAt = (ix: CodexIndex, ordinal: number, byUsage: boolean): number | null => {
  if (ordinal < 0) return null;
  const window = byUsage ? ix.calls[ordinal] : ix.turns[ordinal];
  if (window === undefined) return null;
  // A call whose context ran back into the thread's earlier segment held parts
  // this record cannot count, and counting only the ones the file holds is not
  // a floor — it is a wrong figure. It reported `the 0 parts the call before it
  // held left the context` on a boundary whose own token pair, on the same
  // row, says 243,044 → 24,819 (ward on H-3763).
  if (codexBaseShort(ix, ordinal, byUsage)) return null;
  const before = byUsage ? (window as CodexIndex['calls'][number]).inputs : window.before;
  const inForce = ix.compactions.filter((c) => afterCompaction(c, byUsage) <= ordinal).at(-1) ?? null;
  // The earlier segment's live items where the base is in force and was read:
  // the same items `codexAt` puts in the first slots, so the count and the
  // listing cannot drift.
  return codexBaseItems(ix, ordinal, byUsage).length + (inForce?.replacement_items.length ?? 0) + Math.max(0, before - (inForce?.index ?? 0));
};

function codexInstructionsAt(ix: CodexIndex, index: number, view: View): QueryInstructions | null {
  const applicable = ix.instructions.filter((s) => s.index <= index).at(-1) ?? ix.instructions[0];
  if (!applicable) return null;
  return {
    ref: sha256(JSON.stringify(applicable.blocks.map((b) => b.sha256))).slice(0, 16),
    since: null,
    blocks: applicable.blocks.map((b) => {
      const { text, truncated } = clip(b.text, view.chars);
      return { bytes: b.bytes, sha256: b.sha256, text, truncated };
    }),
    tools: applicable.tools.map((t) => ({ ...t, definition: view.verbatim ? t.definition : null })),
    bytes: applicable.blocks.reduce((t, b) => t + b.bytes, 0),
    tools_bytes: applicable.tools.reduce((t, b) => t + b.bytes, 0),
    state: view.verbatim ? applicable.state : null,
  };
}

function codexAt(ix: CodexIndex, ordinal: number, view: View): ContextAt | { error: string } {
  // A call is a usage record where the rollout has them; a host old enough to
  // write none leaves only the turn, which is coarser by an order of magnitude
  // and is named as what it is rather than passed off as a call.
  const byUsage = ix.calls.length > 0;
  const unit = byUsage
    ? "one token_usage_record — the host writes one per API call, carrying that call's own response id and input token count"
    : 'one turn_context: this rollout has no per-call usage record, so the only boundary it holds is the user turn, and a turn is many calls';
  const window = byUsage ? ix.calls[ordinal] : ix.turns[ordinal];
  // The usage record is written AFTER the call, so its window ends with what
  // the call itself produced. A call's own reasoning and tool request were
  // never in the context it was given, and counting them would make every
  // codex call's context three items too long.
  const call = window === undefined
    ? undefined
    : { ...window, before: byUsage ? (window as CodexIndex['calls'][number]).inputs : window.before };
  const of = byUsage ? ix.calls.length : ix.turns.length;
  if (call === undefined) {
    return { error: `this rollout records ${of} ${byUsage ? 'model calls' : 'turns'}, numbered 0 to ${Math.max(0, of - 1)}` };
  }
  // The turn in force supplies the model: a usage record names its turn, not
  // its model.
  const turn = ix.turns.filter((t) => t.before <= call.before).at(-1) ?? ix.turns[0] ?? { at: null, model: null, turn_id: null, before: 0 };
  // A compaction REPLACES the context rather than trimming it: the host writes
  // the new item list as `replacement_history` and everything recorded before
  // the boundary is gone. Listing the file's items from 0 reported 216 parts
  // for a call the host sent 27 of, with nothing saying 189 had left (ward on
  // H-3750, finding 3).
  // By the rollout's own ORDER, not by the item index: the boundary is written
  // after the call whose window ended at the same item count, and `index <=
  // call.before` handed call 66 the context of call 67 — the 27 replacement
  // parts for a call the host's own figures put at 204,655 input tokens.
  const compaction = ix.compactions.filter((c) => afterCompaction(c, byUsage) <= ordinal).at(-1) ?? null;
  const entered = compaction === null ? null : afterCompaction(compaction, byUsage);
  // The thread's earlier segment, where this rollout continues one and the
  // segment was read. Before the replacement list and before this file's own
  // items, because that is the order the thread recorded them in; and never
  // together with a replacement list, since a compaction at or before this call
  // is exactly what takes the base out of force.
  const carried = codexBaseItems(ix, ordinal, byUsage);
  const carriedFrom = ix.base?.record ?? null;
  const held: { item: CodexItem; via: string; index: number | null }[] = [
    ...carried.map((item, k) => ({ item, via: `earlier item ${k}`, index: null })),
    ...(compaction?.replacement_items ?? []).map((item, k) => ({ item, via: `replacement ${k}`, index: null })),
    ...ix.items.slice(compaction?.index ?? 0, call.before).map((item, k) => {
      const index = (compaction?.index ?? 0) + k;
      return { item, via: `item ${index}`, index };
    }),
  ];
  const requests = codexRequests(held);
  const parts: QueryPart[] = held.map(({ item, via, index }, slot) => {
    const { text, truncated } = clip(item.text, view.chars);
    // A part the thread carried in entered before this file: no call here is
    // its first, and `entered call 0` would say it arrived at the call it was
    // already in the context of.
    const fromEarlier = via.startsWith('earlier item ');
    const carriedCaveat = fromEarlier && carriedFrom !== null
      ? `carried in from the thread's earlier segment at ${carriedFrom}, where it was recorded; it entered before this record, so no call here is the one it arrived at`
      : null;
    return {
      slot,
      role: item.role ?? item.kind,
      origin: item.opaque === null ? 'retained' : 'unreadable',
      via: [via],
      types: [item.kind],
      bytes: item.bytes,
      // A replacement item entered at the boundary; a recorded item at the
      // call whose window first reached it.
      entered: fromEarlier
        ? null
        : index === null
        ? entered
        : byUsage
          ? ix.calls.findIndex((c) => c.inputs > index) === -1 ? null : ix.calls.findIndex((c) => c.inputs > index)
          : ix.turns.filter((t) => t.before <= index).length,
      text: item.opaque === null ? text : null,
      truncated: item.opaque === null ? truncated : false,
      // Codex records one item per part, so there is never a bundle to take
      // apart here. The field is the same field on both harnesses and says so.
      segments: null,
      // Carried even where the text is not: an item whose plaintext this
      // record does not hold still has an entry, and that entry is what an
      // audit has to account for.
      payload: view.verbatim ? [item.payload] : null,
      acquired: codexAcquired(item, requests, view),
      caveat: carriedCaveat === null ? item.opaque : item.opaque === null ? carriedCaveat : `${carriedCaveat}. ${item.opaque}`,
    };
  });
  // What the boundary DROPPED is what the call before it held, not the file's
  // item count: on a second boundary that count includes items an earlier
  // boundary had already taken out (ward on H-3757, finding 3c).
  const dropped = compaction === null || entered === null ? null : codexPartsAt(ix, entered - 1, byUsage);
  // Three different things, and the reason has to say which: a boundary with no
  // call before it at all, a boundary whose preceding call this record cannot
  // count because the thread's earlier segment is elsewhere, and a countable
  // one.
  const droppedUnreadable = compaction !== null && entered !== null && entered > 0 && codexBaseShort(ix, entered - 1, byUsage);
  const droppedSays = dropped !== null
    ? `the ${dropped} part${dropped === 1 ? '' : 's'} the call before the compaction at ${compaction?.at ?? 'an unrecorded time'} held ${dropped === 1 ? 'is' : 'are'}`
    : droppedUnreadable
      ? `what the call before the compaction at ${compaction?.at ?? 'an unrecorded time'} held — which this record cannot count, because it continues thread ${ix.historyBase?.thread_id ?? '(unnamed)'} from ordinal ${ix.historyBase?.entries_before ?? '?'} and that call's context ran back into entries this file does not hold — is`
      : `every part the context held before the compaction at ${compaction?.at ?? 'an unrecorded time'} is`;
  const deltasBefore = ix.deltas.filter((d) => d.index <= call.before);
  // The world_state keys `instructions` above does NOT decompose. They are
  // configuration in force for this call and the host retained them; a
  // reading that lists three keys as "the instructions" and says nothing
  // about sixteen more reads as complete. Named here whatever the view, and
  // carried whole by `instructions.state` when the payload was asked for.
  const stateInForce = ix.instructions.filter((s) => s.index <= call.before).at(-1) ?? ix.instructions[0];
  const undecomposed = Object.keys(stateInForce?.state ?? {})
    .filter((k) => !['agents_md', 'host_skills', 'tools', 'top_level_tools'].includes(k));
  const readable = parts.filter((p) => p.origin === 'retained');
  const usage = byUsage ? (window as CodexIndex['calls'][number]) : null;
  return {
    harness: 'codex',
    session_id: ix.sessionId,
    call_unit: unit,
    host_tokens: usage === null ? null : {
      input: usage.input,
      cached: usage.cached,
      basis: `the host's own usage record for response ${usage.response_id ?? '(unrecorded)'}, in its units; the cached figure is of that input, not additional to it`,
    },
    ordinal,
    of,
    at: call.at,
    model: turn.model,
    call_params: null,
    instructions: codexInstructionsAt(ix, call.before, view),
    parts,
    totals: {
      parts: parts.length,
      retained: readable.length,
      reconstructed: 0,
      unreadable: parts.length - readable.length,
      part_bytes: readable.reduce((t, p) => t + (p.bytes ?? 0), 0),
    },
    acquired: acquiredAccount(parts.flatMap((p) => p.acquired ?? [])),
    gaps: [
      ...CODEX_GAPS,
      ...(compaction === null ? [] : [
        compaction.replacement_items.length > 0
          ? `${droppedSays} NOT in this call's context, and not listed above: the host replaced them with the ${compaction.replacement_items.length} items it wrote as its replacement_history, which are the first ${compaction.replacement_items.length} slots here${entered === null || entered < 1
            ? ''
            : droppedUnreadable
              ? `. --at ${entered - 1} is that call, and it lists none of them: its own context ran back into the thread's earlier segment, which this record does not hold`
              : `. Ask --at ${entered - 1} for that call, which is the last one that held them`}`
          // Every one of the 33 compacted entries on the machine this was
          // built against carries a replacement list. A host that writes none
          // leaves the post-boundary context unreadable rather than short,
          // and the difference has to be said.
          : `${droppedSays} NOT in this call's context, and this record holds no replacement_history for that boundary: the ${parts.length} part${parts.length === 1 ? '' : 's'} above ${parts.length === 1 ? 'is' : 'are'} only what was recorded SINCE it, and what the host put in place of the dropped items cannot be read here`,
      ]),
      // The parts above are a TAIL on a continuation segment, and the host's
      // own input figure for the call is the measure of how much of a tail:
      // 0 parts against 243,044 input tokens, 242,432 of them cached, was read
      // as an empty context (ward on H-3763).
      ...(codexBaseShort(ix, ordinal, byUsage)
        ? [`${codexHistoryBaseSays(ix)}. The ${parts.length} part${parts.length === 1 ? '' : 's'} above ${parts.length === 1 ? 'is' : 'are'} only what this file records before this call${parts.length === 0 ? ', which is none of its context at all: the whole of it is outside this record' : ''}${usage === null || usage.input === null ? '' : `, against the host's own ${usage.input} input tokens for it${usage.cached === null ? '' : `, ${usage.cached} of them cached`} — a figure that counts the context this record does not hold`}`]
        : []),
      // Read, not merely named: the first slots above are the earlier
      // segment's own items. What is still not the host's is their SIZE — the
      // bytes are what it wrote to the record, and on the three real
      // continuation segments here the live items sum to 1.0, 1.4 and 1.5MB
      // against its own per-call figures of 243,044, 91,273 and 77,407 input
      // tokens. An image is one proven reason: one carried-in message holds
      // two base64 data URLs of 537,630 and 223,746 characters, which reach
      // the model as image tokens and not as their bytes.
      ...(carried.length > 0 && carriedFrom !== null
        ? [`the first ${carried.length} part${carried.length === 1 ? '' : 's'} above ${carried.length === 1 ? 'was' : 'were'} read from ${carriedFrom}, the thread's earlier segment, at the byte the host's own history_base names; ${codexHistoryBaseSays(ix)}. The host's own input figure for this call${usage === null || usage.input === null ? ' is not recorded' : ` is ${usage.input} tokens${usage.cached === null ? '' : `, ${usage.cached} of them cached`}`}, and it stays the only size of this context: a part's bytes here are what the host WROTE for it, which on an attachment carried as a base64 data URL and on a tool output recorded in full is more than what it sent`]
        : []),
      ...(byUsage && (window as CodexIndex['calls'][number]).before > (window as CodexIndex['calls'][number]).inputs
        ? [`the ${(window as CodexIndex['calls'][number]).before - (window as CodexIndex['calls'][number]).inputs} items this call itself produced — its reasoning, its reply, its tool request — are NOT listed above: the host writes the usage record after the call, so they sit inside its window without ever having been in its input. An item kind this reader does not recognise counts as input, so the list errs long rather than short`]
        : []),
      ...(undecomposed.length > 0
        ? [`the instructions above are the world_state keys that are prose with a size — the host's full state for this call holds ${undecomposed.length} more (${undecomposed.join(', ')}) which are configuration it was run under and are not rendered here; --verbatim carries the whole state as \`instructions.state\``]
        : []),
      ...(deltasBefore.length > 0
        ? [`${deltasBefore.length} world_state deltas were recorded before this turn (keys: ${[...new Set(deltasBefore.flatMap((d) => d.keys))].join(', ')}); the instructions above are the last FULL state, so a key a delta moved since then is stale here`]
        : []),
      ...UNIVERSAL_GAPS,
    ],
  };
}

function codexEvolution(ix: CodexIndex, view: View): ContextEvolution {
  const changes: ContextChange[] = [];
  const byUsage = ix.calls.length > 0;
  const boundaries: { at: string | null; before: number; input: number | null }[] = byUsage
    ? ix.calls.map((c) => ({ at: c.at, before: c.inputs, input: c.input }))
    : ix.turns.map((t) => ({ at: t.at, before: t.before, input: null }));
  for (const [i, turn] of boundaries.entries()) {
    const from = i === 0 ? 0 : boundaries[i - 1]!.before;
    // WHICH ROW a boundary belongs to is the rollout's own order, not an item
    // index. The row IS the first call whose context was the replacement
    // list, which is where claude's timeline puts its boundary and where
    // `codexAt` reads it from. Chosen by item index it sat on the call
    // BEFORE — the one `--at` still shows holding every item the boundary
    // dropped — and a boundary written at item 0, which is how a resumed
    // rollout opens (2 of the 20 compacted rollouts on this machine), landed
    // on no row at all because `index > from` is false at 0 (ward on H-3757,
    // finding 3a). `.at(-1)` for the same reason `codexAt` uses it: two
    // boundaries with no call between them leave the later one in force.
    const landed = ix.compactions.filter((c) => afterCompaction(c, byUsage) === i).at(-1) ?? null;
    const inForce = ix.compactions.filter((c) => afterCompaction(c, byUsage) <= i).at(-1) ?? null;
    // Slots are positions in THIS call's context, by the same two rules as
    // `codexAt`: the replacement list in force, then the items recorded since
    // its boundary. An added item's own index stays on it, in `via`.
    const base = inForce?.index ?? 0;
    const firstNew = Math.max(from, base);
    const entering: { item: CodexItem; via: string; slot: number }[] = [
      // The replacement list entered on the row the boundary landed on, and
      // nowhere else: it is the context the host put in place of what it
      // dropped, and listing only the items recorded since read "+0 added"
      // on the one row where the whole context changed.
      ...(landed?.replacement_items ?? []).map((item, k) => ({ item, via: `replacement ${k}`, slot: k })),
      ...ix.items.slice(firstNew, turn.before).map((item, k) => ({
        item,
        via: `item ${firstNew + k}`,
        slot: (inForce?.replacement_items.length ?? 0) + (firstNew - base) + k,
      })),
    ];
    // The request that produced an entering output is almost never entering
    // with it: the call before this one made it. So the map is built over the
    // whole context in force, by the same two rules `entering` numbers its
    // slots with — the replacement list, then the items recorded since its
    // boundary. A request back in the thread's earlier segment is outside
    // this window and reads as `request_absent`, which is what it is.
    const inContext = [
      ...(inForce?.replacement_items ?? []).map((item) => ({ item })),
      ...ix.items.slice(base, turn.before).map((item) => ({ item })),
    ];
    const requests = codexRequests(inContext);
    const added: QueryPart[] = entering.map(({ item, via, slot }) => {
      const { text, truncated } = clip(item.text, view.chars);
      return {
        slot,
        role: item.role ?? item.kind,
        origin: item.opaque === null ? 'retained' : 'unreadable',
        via: [via],
        types: [item.kind],
        bytes: item.bytes,
        entered: i,
        text: item.opaque === null ? text : null,
        truncated: item.opaque === null ? truncated : false,
        segments: null,
        payload: view.verbatim ? [item.payload] : null,
        acquired: codexAcquired(item, requests, view),
        caveat: item.opaque,
      };
    });
    const compacted = landed;
    const state = ix.instructions.find((s) => s.index > from && s.index <= turn.before);
    const previous = state ? ix.instructions.filter((s) => s.index <= from).at(-1) : undefined;
    const delta = ix.deltas.filter((d) => d.index > from && d.index <= turn.before);
    const notable: string[] = [];
    if (compacted) {
      // What LEFT is what the call before this one held. The file's item
      // count says 400 at the second boundary of 01a1651a-98d5, where the
      // call before it held 211 parts: 216 of those 400 had already left at
      // the first boundary, and telling the operator to ask --at for "the
      // dropped items" was wrong for every one of them.
      const dropped = codexPartsAt(ix, i - 1, byUsage);
      const before = i === 0 ? null : boundaries[i - 1]!.input;
      const left = dropped !== null
        ? `the ${dropped} part${dropped === 1 ? '' : 's'} the call before it held left the context`
        : i === 0
          ? 'this rollout records no call before the boundary — it opens compacted, which is how a resumed session starts — so what left cannot be counted here'
          // Counting only the parts this file holds said `the 0 parts the call
          // before it held left the context` on a row whose own token pair
          // says 243,044 → 24,819 (ward on H-3763).
          : `what left cannot be counted here: this rollout continues thread ${ix.historyBase?.thread_id ?? '(unnamed)'} from ordinal ${ix.historyBase?.entries_before ?? '?'}, the call before the boundary held context this file does not hold, and no earlier segment was read for it (${ix.baseWhy ?? 'no reason recorded'}), so the host's own per-call figures below are the only measure of the drop`;
      notable.push(`compaction (${compacted.trigger}): this is the first call whose context was the host's replacement list. ${left}; ${compacted.replacement_items.length > 0 ? `the host wrote ${compacted.replacement_items.length} items as its replacement_history, and they are the first ${compacted.replacement_items.length} slots of this call` : 'this record holds no replacement_history for the boundary, so what the host put in their place cannot be read here'}`);
      // The boundary's own two figures are BOTH pre-compaction on codex:
      // `pre_tokens` is the turn's cumulative input and `post_tokens` the
      // last call before the boundary. Printed as "404925 → 204655" they read
      // as the shrink, while 24,837 — the host's figure for this very call —
      // sat on the next row down. Two contradicting figures on one screen is
      // the pattern of ward's finding 4 (H-3757, finding 3b).
      const boundaryFigures = `the boundary's own record holds ${compacted.pre_tokens ?? '?'} input tokens for the TURN so far and ${compacted.post_tokens ?? '?'} for the call its usage record was written after`;
      notable.push(before === null || turn.input === null
        ? `no size is stated for the drop: the host records no per-call input token figure on both sides of this boundary. ${boundaryFigures}, and neither is the size of the new context`
        : `${n(before)} → ${n(turn.input)} input tokens, the host's own per-call figures for the calls either side of the boundary; ${boundaryFigures}, both pre-compaction, which is why neither is quoted here as the new size`);
      notable.push(`the host's retained set at that boundary lists ${compacted.preserved_messages ?? '?'} messages${/INCOMPLETE/.test(compacted.basis) ? ', and marks it INCOMPLETE, so that count is a floor' : ''} — the host's own list, not the item array of this call, which is the parts figure on this row`);
    }
    let instructions: ContextChange['instructions'] = null;
    if (state) {
      const nowTools = state.tools.map((t) => t.name);
      const wasTools = (previous?.tools ?? []).map((t) => t.name);
      const initial = previous === undefined;
      instructions = {
        from: previous ? sha256(JSON.stringify(previous.blocks.map((b) => b.sha256))).slice(0, 16) : null,
        to: sha256(JSON.stringify(state.blocks.map((b) => b.sha256))).slice(0, 16),
        tools_added: nowTools.filter((t) => !wasTools.includes(t)),
        tools_removed: wasTools.filter((t) => !nowTools.includes(t)),
        blocks_changed: state.blocks.filter((b, k) => previous?.blocks[k]?.sha256 !== b.sha256).length,
      };
      if (initial) notable.push(`initial configuration: ${state.blocks.length} instruction block(s), ${state.tools.length} tools`);
      else {
        if (instructions.tools_added.length > 0 || instructions.tools_removed.length > 0) {
          notable.push(`tool inventory changed${instructions.tools_added.length > 0 ? `, +${instructions.tools_added.join(', +')}` : ''}${instructions.tools_removed.length > 0 ? `, -${instructions.tools_removed.join(', -')}` : ''}`);
        }
        if (instructions.blocks_changed > 0) notable.push(`${instructions.blocks_changed} instruction block(s) changed`);
      }
    }
    if (delta.length > 0) notable.push(`${delta.length} world_state delta(s): ${[...new Set(delta.flatMap((d) => d.keys))].join(', ')} moved, and a delta names only what changed`);
    changes.push({
      ordinal: i,
      at: turn.at,
      added,
      // The rollout states no per-call list, so it states no removal either.
      // Nothing is inferred from an item count that only grows.
      removed: null,
      held: null,
      previously: null,
      instructions,
      compaction: compacted ? { ...compacted, replacement_text: null, replacement_truncated: false } : null,
      host_input_tokens: turn.input,
      notable,
    });
  }
  // A boundary the rollout recorded with no call after it: no row's context
  // was its replacement list, so pinning rows by order would report it
  // nowhere. Named on the last row instead, as the boundary it is rather than
  // as that call's own.
  const trailing = ix.compactions.filter((c) => afterCompaction(c, byUsage) >= boundaries.length);
  const last = changes.at(-1);
  if (last !== undefined) {
    for (const c of trailing) {
      last.notable.push(`a compaction (${c.trigger}) was recorded at ${c.at ?? 'an unrecorded time'}, AFTER this last call: the ${codexPartsAt(ix, changes.length - 1, byUsage) ?? '?'} parts above are what this call held, and the ${c.replacement_items.length} items the host wrote as its replacement_history were never given to a call this rollout records`);
    }
  }
  // On the row where the shortfall begins, not only in the gaps: a reader
  // scrolling 189 rows of a continuation segment lands in the middle of one.
  const firstShort = changes.find((c) => codexBaseInForce(ix, c.ordinal, byUsage));
  if (firstShort !== undefined) {
    firstShort.notable.unshift(ix.base === null
      ? `${codexHistoryBaseSays(ix)}. The additions on this row and on every row until then are what this file records, not the whole of what those calls were given`
      // The carried-in items are not ADDITIONS on this row: they were in the
      // context before the first call here, which is why they are listed by
      // `--at` and counted in its parts, and not here.
      : `${codexHistoryBaseSays(ix)}. They are not listed as additions on this row or on any row until then: they were in the context before the first call here, so ask --at for a call to see them in their slots`);
  }
  return {
    harness: 'codex',
    session_id: ix.sessionId,
    changes,
    gaps: [
      ...(codexHistoryBaseSays(ix) === null ? [] : [codexHistoryBaseSays(ix)!]),
      ...(byUsage
        ? ["a call below is one token_usage_record — the host's own per-call entry, carrying its response id and input token count — and the items between two of them are that call's additions by this reader's arithmetic, counted up to the first item the call itself produced"]
        : ['this rollout has no per-call usage record, so a line below is a user TURN, which is many model calls']),
      ...CODEX_GAPS,
      'what a compaction dropped in TOKENS: the host writes its replacement list and its retained set, never a dropped figure, so the item counts above are this reader\'s arithmetic over the record\'s own order and only the token figures are the host\'s own',
      ...UNIVERSAL_GAPS,
    ],
  };
}

function codexFind(ix: CodexIndex, needle: string, chars: number): ContextFind {
  const lower = needle.toLowerCase();
  const hits: QueryHit[] = [];
  const searched = { instructions: 0, tools: 0, parts: 0, unreadable: 0 };
  const excerpt = (text: string): string => {
    const at = text.toLowerCase().indexOf(lower);
    const from = Math.max(0, at - Math.floor(chars / 2));
    return `${from > 0 ? '…' : ''}${text.slice(from, from + chars)}${from + chars < text.length ? '…' : ''}`;
  };
  // By the same per-call boundary the readings above use.
  const turnOf = (index: number): number | null => {
    const where = ix.calls.length > 0
      ? ix.calls.findIndex((c) => c.inputs > index)
      : ix.turns.findIndex((t) => t.before > index);
    const of = ix.calls.length > 0 ? ix.calls.length : ix.turns.length;
    return where === -1 ? (of === 0 ? null : of - 1) : where;
  };
  const lastCall = (ix.calls.length > 0 ? ix.calls.length : ix.turns.length) - 1;
  for (const [n, state] of ix.instructions.entries()) {
    // In force until the next FULL world_state, or to the end of the rollout.
    const next = ix.instructions[n + 1];
    const from = turnOf(state.index);
    const until = next === undefined ? lastCall : Math.max(from ?? 0, (turnOf(next.index) ?? 0) - 1);
    const span = {
      first_invocation: from,
      last_invocation: until < 0 ? null : until,
      invocations: from === null || until < from ? 0 : until - from + 1,
    };
    for (const [k, b] of state.blocks.entries()) {
      searched.instructions++;
      if (!b.text.toLowerCase().includes(lower)) continue;
      hits.push({ where: 'instructions', ref: `${b.sha256.slice(0, 12)} block ${k}`, origin: 'configured', role: 'system', ...span, excerpt: excerpt(b.text) });
    }
    for (const t of state.tools) {
      searched.tools++;
      const text = `${t.name} ${t.description ?? ''}`;
      if (!text.toLowerCase().includes(lower)) continue;
      hits.push({ where: 'tool', ref: t.name, origin: 'configured', role: 'tool', ...span, excerpt: excerpt(text) });
    }
  }
  // Every part some call's context held, with the span of calls that held it.
  // A compaction ENDS a span: a recorded item is in no context after the
  // boundary that dropped it, and the host's own replacement list begins its
  // own span there. Carried to the last call, each of this rollout's 216
  // pre-compaction items read as held through call 66 when 189 of them left
  // at call 67 (ward on H-3750, finding 3).
  const byUsage = ix.calls.length > 0;
  const spans: { item: CodexItem; ref: string; from: number | null; to: number | null }[] = [];
  // The thread's earlier segment, where it was read. Those items were in the
  // context from the first call here until the first compaction replaced them,
  // which is the same span rule the file's own items are read by — and the
  // reason a nil result used to be "not in this segment" when the needle was
  // in the thread's earlier one.
  if (ix.base !== null) {
    const until = ix.compactions.map((c) => afterCompaction(c, byUsage)).filter((o) => o >= 0).sort((a, b) => a - b)[0];
    for (const [k, item] of ix.base.items.entries()) {
      spans.push({ item, ref: `earlier item ${k}`, from: 0, to: until === undefined ? lastCall : until - 1 });
    }
  }
  for (const [i, item] of ix.items.entries()) {
    const dropped = ix.compactions.find((c) => c.index > i) ?? null;
    spans.push({
      item,
      ref: `item ${i}`,
      from: turnOf(i),
      to: dropped === null ? lastCall : afterCompaction(dropped, byUsage) - 1,
    });
  }
  for (const c of ix.compactions) {
    const next = ix.compactions.find((o) => o.index > c.index) ?? null;
    const from = afterCompaction(c, byUsage);
    for (const [k, item] of c.replacement_items.entries()) {
      spans.push({
        item,
        ref: `replacement ${k} of the compaction at item ${c.index}`,
        // A boundary the rollout records no call after replaced the context of
        // nothing it went on to send.
        from: from > lastCall ? null : from,
        to: next === null ? lastCall : afterCompaction(next, byUsage) - 1,
      });
    }
  }
  for (const { item, ref, from, to } of spans) {
    if (item.opaque !== null) { searched.unreadable++; continue; }
    searched.parts++;
    if (!item.text.toLowerCase().includes(lower)) continue;
    // An empty span is reported as one in the STRUCTURE, not only in the
    // rendering: a part a compaction dropped before any call had been given it
    // was in no call's input, and `first 1, invocations 0` reads as call 1.
    const empty = from === null || to === null || to < from;
    hits.push({
      where: 'message',
      ref,
      origin: 'retained',
      role: item.role ?? item.kind,
      first_invocation: empty ? null : from,
      last_invocation: empty ? null : to,
      invocations: empty ? 0 : to! - from! + 1,
      excerpt: excerpt(item.text),
    });
  }
  return {
    harness: 'codex',
    session_id: ix.sessionId,
    needle,
    hits,
    searched,
    gaps: [
      // The false negative this structure creates: a needle that was in the
      // thread's earlier segment is not in this file, and `no hits` would
      // otherwise read as "was not in the context".
      ...(codexHistoryBaseSays(ix) === null
        ? []
        : ix.base === null
          ? [`${codexHistoryBaseSays(ix)}. Only what this file records was searched, so a nil result here is "not in this segment", never "not in the context"`]
          // Searched, and still not the whole thread: the earlier segment's own
          // dropped items were in ITS calls' contexts and in none here, so they
          // are not searched — reading that record directly is what finds them.
          : [`${codexHistoryBaseSays(ix)}. Its ${ix.base.items.length} carried-in items were searched too, so a nil result here is "in no context of this segment's calls". Items that segment's OWN compaction had already dropped were in no call here and are not searched: --record ${ix.base.record} searches them`]),
      ...(searched.unreadable > 0
        ? [`${searched.unreadable} items hold no plaintext in this record — a reasoning item is carried as provider-encrypted text, and so is the compaction item a resumed rollout opens with — so a match inside one would not appear here: a nil result is "not found in what is readable", never "was not in the context"`]
        : []),
      ...(ix.compactions.length > 0
        ? [`what a part's span means across a compaction, beyond the host's own order: this rollout has ${ix.compactions.length}, and a span above ends at the first boundary after the part entered, because the host replaced the whole item list there rather than trimming it. A part recorded before a boundary that no call had yet been given is "in no call" — it was one call's own output, and the next call was given the replacement instead`]
        : []),
      ...CODEX_GAPS,
      ...UNIVERSAL_GAPS,
    ],
  };
}

// --- the three questions ----------------------------------------------------

function read(path: string): { entries: Record<string, unknown>[]; source: TraceSource; harness: 'claude' | 'codex' } | { error: string; source: TraceSource } {
  const parsed = parseTraceRecord(path);
  if (parsed.error !== undefined) return { error: parsed.error, source: parsed.source };
  const harness = harnessOf(parsed.entries);
  if (harness === null) {
    return {
      error: `no entry in ${path} identifies the host that wrote it, so there is no reader for it${parsed.source.truncated ? ` (read stopped at the ${TRACE_BYTE_CEILING}-byte ceiling)` : ''}`,
      source: parsed.source,
    };
  }
  return { entries: parsed.entries, source: parsed.source, harness };
}

/** The reading one set of options asks for. Asking for the payload asks for
 *  all of it: a content block clipped at the preview length is a rendering
 *  again, under a field name that promises it is not. */
const viewOf = (options: QueryOptions): View => ({
  chars: options.verbatim === true ? Infinity : options.chars ?? PREVIEW_CHARS,
  verbatim: options.verbatim === true,
});

/** What was in the context of one model call, and where each part came from. */
export function contextAt(path: string, ordinal: number, options: QueryOptions = {}): (ContextAt & { source: TraceSource }) | { error: string; source: TraceSource } {
  const r = read(path);
  if ('error' in r) return r;
  const view = viewOf(options);
  const answer = r.harness === 'claude' ? claudeAt(indexClaude(r.entries), ordinal, view) : codexAt(indexCodexRecord(path, r.entries), ordinal, view);
  return 'error' in answer ? { error: answer.error, source: r.source } : { ...answer, source: r.source };
}

/** What changed through the run: what each call added, what the host dropped,
 *  when the instructions or tools moved, and what a compaction replaced. */
export function contextEvolution(path: string, options: QueryOptions = {}): (ContextEvolution & { source: TraceSource }) | { error: string; source: TraceSource } {
  const r = read(path);
  if ('error' in r) return r;
  const view = viewOf(options);
  const answer = r.harness === 'claude' ? claudeEvolution(indexClaude(r.entries), view) : codexEvolution(indexCodexRecord(path, r.entries), view);
  return { ...answer, source: r.source };
}

/** Where a string came from: which part of which call's context held it, and
 *  when it entered. A nil result means "not found in what is readable", which
 *  is why `searched` and `gaps` are part of the answer. */
export function contextFind(path: string, needle: string, options: QueryOptions = {}): (ContextFind & { source: TraceSource }) | { error: string; source: TraceSource } {
  const r = read(path);
  if ('error' in r) return r;
  if (needle === '') return { error: 'nothing to look for: pass the text to find', source: r.source };
  const chars = options.chars ?? PREVIEW_CHARS;
  const answer = r.harness === 'claude' ? claudeFind(indexClaude(r.entries), needle, chars) : codexFind(indexCodexRecord(path, r.entries), needle, chars);
  return { ...answer, source: r.source };
}

// --- rendering --------------------------------------------------------------
//
// The read surface is TEXT, because the operator question behind this work was
// asked of a JSON dump and could not be answered from one: a 132-call session
// with 362 parts is a 30MB object, and `--json` stays available for a consumer
// that wants it. These renderers are pure, so what an operator sees is what a
// test asserts.

/** The last thing each renderer does to everything it prints. A record holds
 *  whatever a session's tool results held — a page an agent fetched included —
 *  so a part's text can carry ESC sequences that retitle the operator's window,
 *  clear the screen above a line, or write their clipboard. Visible, never
 *  stripped: the bytes WERE in the context, and this surface exists to show
 *  what was supplied. Applied to the whole rendering rather than per field,
 *  because a field added later cannot forget it (ward on H-3750, finding 1).
 *  `--json` needs none of this: JSON escapes them itself. */
const printable = (lines: string[]): string => visibleControls(lines.join('\n'));

const n = (v: number | null): string => (v === null ? '?' : v.toLocaleString('en-US'));
const clock = (at: string | null): string => (at === null ? '--:--:--' : (at.split('T')[1] ?? at).replace(/\.\d+Z?$/, '').replace('Z', ''));
const short = (id: string | null, to = 8): string => (id === null ? '(none)' : id.length <= to ? id : `${id.slice(0, to)}…`);
/** One line of a part's text, for a timeline. Newlines in a part would break
 *  the alignment the timeline is read by. */
const oneLine = (text: string | null, to = 90): string => {
  if (text === null) return '(unreadable)';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= to ? flat : `${flat.slice(0, to)}…`;
};
const indent = (text: string, by = '      '): string => text.split('\n').map((l) => `${by}${l}`).join('\n');

function renderPart(p: QueryPart, chars: number): string[] {
  const out: string[] = [];
  const only = p.via[0] ?? null;
  // A claude slot is named by a 64-hex hash and a codex one by its item
  // index; `blob <index>` would read as a store that does not exist.
  const named = only !== null && /^[0-9a-f]{16,}$/.test(only);
  const where = p.origin === 'reconstructed'
    ? `via ${p.via.map((v) => short(v, 8)).join(',')}`
    // Eight characters is a hash prefix, not a name: it printed `replacem…`
    // for `replacement 12`, and `earlier item 3` names which record a part was
    // read from.
    : `${named ? (p.origin === 'retained' ? 'blob ' : 'hash ') : ''}${short(only, named ? 8 : 20)}`;
  out.push(`  #${String(p.slot).padEnd(4)} ${p.role.padEnd(10)} ${p.origin.padEnd(14)} ${p.entered === null ? 'entered ?' : `entered call ${p.entered}`.padEnd(16)} ${p.bytes === null ? '-' : `${n(p.bytes)}B`.padStart(10)}  ${where}`);
  // Before the content, not after it: a 200KB tool result scrolls its own
  // provenance off the screen, and where a part came from is what an operator
  // reading a context is looking for.
  if (p.acquired !== null) out.push(...renderAcquired(p.acquired));
  if (chars > 0 && p.text !== null) out.push(indent(p.text + (p.truncated ? ' […]' : '')));
  if (p.text === null) out.push('      (no content on this machine)');
  return out;
}

/** The caveats of a set of parts, each said ONCE with how many parts carry it.
 *  Every part keeps its own `caveat` in the structure, because a consumer
 *  reading one part needs it there — but a call with 72 reconstructed parts
 *  printed the same two sentences 72 times, which is how a real qualification
 *  comes to be skipped. */
function renderCaveats(parts: QueryPart[]): string[] {
  const counts = new Map<string, number>();
  for (const p of parts) if (p.caveat !== null) counts.set(p.caveat, (counts.get(p.caveat) ?? 0) + 1);
  if (counts.size === 0) return [];
  const out = ['', 'discount these parts by:'];
  for (const [caveat, count] of counts) out.push(`  ! ${count} part${count === 1 ? '' : 's'}: ${caveat}`);
  return out;
}

export function renderContextAt(a: ContextAt & { source: TraceSource }, chars = PREVIEW_CHARS): string {
  const out: string[] = [];
  out.push(`context of call ${a.ordinal} of ${a.of} — ${a.harness} session ${short(a.session_id, 8)} at ${a.at ?? 'an unrecorded time'}, model ${a.model ?? 'unrecorded'}`);
  out.push(`a call here is ${a.call_unit}`);
  if (a.host_tokens !== null) out.push(`the host's own size for it: ${n(a.host_tokens.input)} input tokens${a.host_tokens.cached === null ? '' : ` (${n(a.host_tokens.cached)} of them cached)`} — ${a.host_tokens.basis}`);
  out.push(`record: ${a.source.path} (${n(a.source.read_bytes)}B read of ${n(a.source.bytes)}B, ${n(a.source.lines)} entries${a.source.truncated ? ', TRUNCATED at the read ceiling' : ''}${a.source.unparseable > 0 ? `, ${a.source.unparseable} unparseable` : ''})`);
  out.push('');
  if (a.instructions === null) {
    out.push('instructions: none in this record for this call');
  } else {
    const i = a.instructions;
    out.push(`instructions (${short(i.ref, 12)}${i.since === null ? '' : `, in force since call ${i.since}`}) — ${i.blocks.length} blocks, ${n(i.bytes)}B; ${i.tools.length} tools, ${n(i.tools_bytes)}B`);
    for (const [k, b] of i.blocks.entries()) {
      out.push(`  [${k}] ${n(b.bytes)}B sha256 ${short(b.sha256, 12)}`);
      if (chars > 0 && b.text !== null) out.push(indent(b.text + (b.truncated ? ' […]' : '')));
    }
    if (i.tools.length > 0) out.push(`  tools: ${i.tools.map((t) => t.name).join(', ')}`);
  }
  out.push('');
  const t = a.totals;
  out.push(`parts: ${t.parts} — ${t.retained} retained, ${t.reconstructed} reconstructed, ${t.unreadable} unreadable, ${n(t.part_bytes)}B readable`);
  // The composition of the context before any of it is read: how much of it
  // the run FETCHED, of what kind, from how many distinct places. On a long
  // call this is most of the bytes, and it used to be unsayable.
  if (a.acquired.length > 0) {
    out.push(`acquired — ${a.acquired.map((k) => `${k.inputs} ${k.kind} (${n(k.bytes)}B, ${k.sources} source${k.sources === 1 ? '' : 's'})`).join(', ')}`);
  }
  for (const p of a.parts) out.push(...renderPart(p, chars));
  out.push(...renderCaveats(a.parts));
  out.push('');
  out.push('this answer cannot say:');
  for (const g of a.gaps) out.push(`  - ${g}`);
  return printable(out);
}

export function renderContextEvolution(e: ContextEvolution & { source: TraceSource }, chars = PREVIEW_CHARS, notableOnly = false): string {
  const out: string[] = [];
  const shown = notableOnly ? e.changes.filter((c) => c.notable.length > 0) : e.changes;
  out.push(`context evolution — ${e.harness} session ${short(e.session_id, 8)}, ${e.changes.length} calls${notableOnly ? `, ${shown.length} with something to report` : ''}`);
  out.push(`record: ${e.source.path} (${n(e.source.read_bytes)}B read of ${n(e.source.bytes)}B${e.source.truncated ? ', TRUNCATED at the read ceiling' : ''})`);
  out.push('');
  for (const c of shown) {
    const moved = `${c.added.length > 0 ? `+${c.added.length}` : '  '}${(c.removed ?? 0) > 0 ? ` -${c.removed}` : ''}`;
    const held = c.held === null ? '' : c.previously !== null && c.previously !== c.held ? `${c.previously}→${c.held} parts` : `${c.held} parts`;
    const tokens = c.host_input_tokens === null ? '' : `  ${n(c.host_input_tokens)} input tokens (host's own count)`;
    out.push(`call ${String(c.ordinal).padStart(4)}  ${clock(c.at)}  ${moved.padEnd(8)} ${held}${tokens}`);
    for (const note of c.notable) out.push(`    ! ${note}`);
    if (c.compaction?.replacement_text) {
      out.push(`    replacement summary (${n(c.compaction.replacement_text.length)} chars shown${c.compaction.replacement_truncated ? ', truncated' : ''}):`);
      out.push(indent(c.compaction.replacement_text, '      '));
    }
    if (chars > 0) {
      for (const p of c.added) {
        out.push(`    ${p.role.padEnd(10)} ${p.origin.padEnd(14)} ${oneLine(p.text)}`);
        // What arrived, in the timeline that says when it arrived: a result's
        // own text opens with the tool's framing, and the file or ticket it
        // carries is the thing a reader is scanning the timeline for.
        if (p.acquired !== null) out.push(...renderAcquired(p.acquired, 70));
      }
    }
  }
  out.push(...renderCaveats(shown.flatMap((c) => c.added)));
  out.push('');
  out.push('this answer cannot say:');
  for (const g of e.gaps) out.push(`  - ${g}`);
  return printable(out);
}

export function renderContextFind(f: ContextFind & { source: TraceSource }): string {
  const out: string[] = [];
  const span = (h: QueryHit): string => (h.first_invocation === null || h.invocations === 0
    ? 'in no call'
    : h.invocations <= 1 ? `call ${h.first_invocation}` : `calls ${h.first_invocation}–${h.last_invocation} (${h.invocations})`);
  const where = (h: QueryHit): string => (h.where === 'message'
    ? `message ${h.ref}  ${h.role ?? '?'} ${h.origin}  ${span(h)}`
    : `${h.where} ${h.ref}  ${h.origin}  ${span(h)}`);
  out.push(`"${f.needle}" in ${f.harness} session ${short(f.session_id, 8)} — ${f.hits.length} hit${f.hits.length === 1 ? '' : 's'}`);
  out.push(`searched ${f.searched.instructions} instruction blocks, ${f.searched.tools} tool schemas, ${f.searched.parts} readable parts${f.searched.unreadable > 0 ? `, and ${f.searched.unreadable} parts that could not be read` : ''}`);
  out.push('');
  for (const h of f.hits) {
    out.push(`  ${where(h)}`);
    out.push(indent(h.excerpt));
  }
  if (f.hits.length === 0) out.push('  no match in what is readable — which is not the same as absent from the context; see below');
  out.push('');
  out.push('this answer cannot say:');
  for (const g of f.gaps) out.push(`  - ${g}`);
  return printable(out);
}
