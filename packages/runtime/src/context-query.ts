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
  TRACE_BYTE_CEILING,
  harnessOf,
  indexClaude,
  parseTraceRecord,
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
  tools: { name: string; bytes: number; description: string | null }[];
  bytes: number;
  tools_bytes: number;
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
}

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

/** A part's text, from the content blocks the record holds. A block whose
 *  payload is not text is rendered as what it IS — a tool call with its input,
 *  a result with its output — rather than skipped, because an operator reading
 *  a context needs the tool traffic most of all. */
function partText(parts: unknown[]): string {
  const out: string[] = [];
  for (const b of parts) {
    if (typeof b === 'string') { out.push(b); continue; }
    if (!rec(b)) continue;
    const type = str(b['type']);
    if (type === 'text') out.push(str(b['text']) ?? '');
    else if (type === 'thinking') out.push(`[thinking] ${str(b['thinking']) ?? ''}`);
    else if (type === 'tool_use') out.push(`[tool_use ${str(b['name']) ?? '(unnamed)'}] ${JSON.stringify(b['input'])}`);
    else if (type === 'tool_result') {
      const content = b['content'];
      out.push(`[tool_result ${str(b['tool_use_id']) ?? ''}] ${typeof content === 'string' ? content : partText(Array.isArray(content) ? content : [content])}`);
    } else if (type === 'image') out.push('[image]');
    else out.push(`[${type ?? 'untyped'}] ${JSON.stringify(b)}`);
  }
  return out.join('\n');
}

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

function claudePart(
  ix: ClaudeIndex,
  hash: string,
  slot: number,
  entered: number | null,
  chars: number,
): QueryPart {
  const blob = ix.blobs.get(hash);
  if (blob !== undefined) {
    const { text, truncated } = clip(partText(blob.parts), chars);
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
      caveat: null,
    };
  }
  const made: ClaudeReconstruction | undefined = ix.reconstructedFor.get(hash);
  if (made !== undefined) {
    const { text, truncated } = clip(partText(made.parts), chars);
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

function claudeInstructions(ix: ClaudeIndex, ref: string | null, chars: number): QueryInstructions | null {
  if (ref === null) return null;
  const shape = ix.shapes.get(ref);
  const texts = ix.shapeTexts.get(ref);
  if (!shape || !texts) return null;
  return {
    ref,
    since: shape.first_invocation === -1 ? null : shape.first_invocation,
    blocks: shape.system_blocks.map((b, i) => {
      const { text, truncated } = clip(texts.system[i] ?? '', chars);
      return { bytes: b.bytes, sha256: b.sha256, text, truncated };
    }),
    tools: texts.tools,
    bytes: shape.system_bytes,
    tools_bytes: shape.tools_bytes,
  };
}

const CLAUDE_GAPS = [
  'what the host appended to or wrapped a reconstructed part with on the way out: `caveat` carries this session\'s own measured rate for the role',
];

function claudeAt(ix: ClaudeIndex, ordinal: number, chars: number): ContextAt | { error: string } {
  const r = ix.requests[ordinal];
  if (r === undefined) {
    return { error: `this session made ${ix.requests.length} model calls, numbered 0 to ${Math.max(0, ix.requests.length - 1)}` };
  }
  const list = ix.listFor(r);
  const first = enteredAt(ix);
  const params = rec(r['params']) ? (r['params'] as Record<string, unknown>) : null;
  const shapeRef = str(r['shapeHash']);
  const parts = (list ?? []).map((h, i) => claudePart(ix, h, i, first.get(h) ?? null, chars));
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
    instructions: claudeInstructions(ix, shapeRef, chars),
    parts,
    totals: {
      parts: parts.length,
      retained: count('retained'),
      reconstructed: count('reconstructed'),
      unreadable: count('unreadable'),
      part_bytes: parts.reduce((t, p) => t + (p.bytes ?? 0), 0),
    },
    gaps: [
      ...(list === null
        ? ['this call names a base message list this record does not hold, so the parts below start at the gap rather than at the beginning of the call']
        : []),
      ...CLAUDE_GAPS,
      ...UNIVERSAL_GAPS,
    ],
  };
}

function claudeEvolution(ix: ClaudeIndex, chars: number): ContextEvolution {
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
    const added = tail.map((h, k) => claudePart(ix, h, (list?.length ?? tail.length) - tail.length + k, first.get(h) ?? null, chars));

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
      const { text, truncated } = clip(ix.summaryText ?? '', chars);
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
    const { text, truncated } = clip(ix.summaryText ?? '', chars);
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
    const part = claudePart(ix, hash, -1, invocations[0] ?? null, Infinity);
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
  instructions: { at: string | null; index: number; blocks: { bytes: number; sha256: string; text: string }[]; tools: { name: string; bytes: number; description: string | null }[] }[];
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
  baseInstructions: { bytes: number; sha256: string; text: string } | null;
}

/** The text one response item carries, or `null` where this record holds none
 *  in any field this reader knows. A payload's own JSON is never its text: a
 *  `[compaction] {"encrypted_content":…}` dump is 64KB of ciphertext presented
 *  as what the model was shown, which is the one thing it is not (ward on
 *  H-3750, finding 2). */
function itemText(payload: Record<string, unknown>): string | null {
  const content = payload['content'];
  if (Array.isArray(content)) {
    return content.map((c) => (rec(c) ? str(c['text']) ?? str(c['output']) ?? JSON.stringify(c) : String(c))).join('\n');
  }
  if (typeof content === 'string') return content;
  for (const key of ['text', 'output', 'arguments', 'summary', 'message']) {
    const v = payload[key];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((c) => (rec(c) ? str(c['text']) ?? JSON.stringify(c) : String(c))).join('\n');
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
  };
}

function indexCodex(entries: Record<string, unknown>[]): CodexIndex {
  const ix: CodexIndex = { sessionId: null, cwd: null, turns: [], calls: [], items: [], instructions: [], deltas: [], compactions: [], baseInstructions: null };
  for (const e of entries) {
    const type = str(e['type']);
    const at = str(e['timestamp']);
    const payload = rec(e['payload']) ? (e['payload'] as Record<string, unknown>) : null;
    if (type === 'session_meta' && payload) {
      ix.sessionId = str(payload['session_id']) ?? str(payload['id']);
      ix.cwd = str(payload['cwd']);
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
      const tools: { name: string; bytes: number; description: string | null }[] = [];
      for (const key of ['tools', 'top_level_tools']) {
        const map = rec(state[key]) ? (state[key] as Record<string, unknown>) : null;
        if (!map) continue;
        for (const [name, value] of Object.entries(map)) {
          tools.push({
            name,
            bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
            description: typeof value === 'string' ? value : rec(value) ? str(value['description']) : null,
          });
        }
      }
      ix.instructions.push({ at, index: ix.items.length, blocks, tools });
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

/** The ordinal of the first call recorded AFTER a compaction — the first one
 *  whose context was the host's replacement list. Read off the counts the
 *  rollout had reached at the boundary, so a rollout with no usage records is
 *  measured in its turns and not silently in calls it does not have. */
const afterCompaction = (c: CodexIndex['compactions'][number], byUsage: boolean): number =>
  (byUsage ? c.calls_before : c.turns_before);

function codexInstructionsAt(ix: CodexIndex, index: number, chars: number): QueryInstructions | null {
  const applicable = ix.instructions.filter((s) => s.index <= index).at(-1) ?? ix.instructions[0];
  if (!applicable) return null;
  return {
    ref: sha256(JSON.stringify(applicable.blocks.map((b) => b.sha256))).slice(0, 16),
    since: null,
    blocks: applicable.blocks.map((b) => {
      const { text, truncated } = clip(b.text, chars);
      return { bytes: b.bytes, sha256: b.sha256, text, truncated };
    }),
    tools: applicable.tools,
    bytes: applicable.blocks.reduce((t, b) => t + b.bytes, 0),
    tools_bytes: applicable.tools.reduce((t, b) => t + b.bytes, 0),
  };
}

function codexAt(ix: CodexIndex, ordinal: number, chars: number): ContextAt | { error: string } {
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
  const held: { item: CodexItem; via: string; index: number | null }[] = [
    ...(compaction?.replacement_items ?? []).map((item, k) => ({ item, via: `replacement ${k}`, index: null })),
    ...ix.items.slice(compaction?.index ?? 0, call.before).map((item, k) => {
      const index = (compaction?.index ?? 0) + k;
      return { item, via: `item ${index}`, index };
    }),
  ];
  const parts: QueryPart[] = held.map(({ item, via, index }, slot) => {
    const { text, truncated } = clip(item.text, chars);
    return {
      slot,
      role: item.role ?? item.kind,
      origin: item.opaque === null ? 'retained' : 'unreadable',
      via: [via],
      types: [item.kind],
      bytes: item.bytes,
      // A replacement item entered at the boundary; a recorded item at the
      // call whose window first reached it.
      entered: index === null
        ? entered
        : byUsage
          ? ix.calls.findIndex((c) => c.inputs > index) === -1 ? null : ix.calls.findIndex((c) => c.inputs > index)
          : ix.turns.filter((t) => t.before <= index).length,
      text: item.opaque === null ? text : null,
      truncated: item.opaque === null ? truncated : false,
      caveat: item.opaque,
    };
  });
  const deltasBefore = ix.deltas.filter((d) => d.index <= call.before);
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
    instructions: codexInstructionsAt(ix, call.before, chars),
    parts,
    totals: {
      parts: parts.length,
      retained: readable.length,
      reconstructed: 0,
      unreadable: parts.length - readable.length,
      part_bytes: readable.reduce((t, p) => t + (p.bytes ?? 0), 0),
    },
    gaps: [
      ...CODEX_GAPS,
      ...(compaction !== null
        ? [`the ${compaction.index} items recorded before the compaction at ${compaction.at ?? 'an unrecorded time'} are NOT in this call's context and are not listed above: the host replaced them with the ${compaction.replacement_items.length} items it wrote as its replacement_history, which are the `
          + `${compaction.replacement_items.length === 0 ? 'parts this reader therefore has none of' : `first ${compaction.replacement_items.length} slots here`}. ${entered === null || entered < 1 ? 'No call before the boundary is recorded' : `Ask --at ${entered - 1} for the last call that held the dropped items`}`]
        : []),
      ...(byUsage && (window as CodexIndex['calls'][number]).before > (window as CodexIndex['calls'][number]).inputs
        ? [`the ${(window as CodexIndex['calls'][number]).before - (window as CodexIndex['calls'][number]).inputs} items this call itself produced — its reasoning, its reply, its tool request — are NOT listed above: the host writes the usage record after the call, so they sit inside its window without ever having been in its input. An item kind this reader does not recognise counts as input, so the list errs long rather than short`]
        : []),
      ...(deltasBefore.length > 0
        ? [`${deltasBefore.length} world_state deltas were recorded before this turn (keys: ${[...new Set(deltasBefore.flatMap((d) => d.keys))].join(', ')}); the instructions above are the last FULL state, so a key a delta moved since then is stale here`]
        : []),
      ...UNIVERSAL_GAPS,
    ],
  };
}

function codexEvolution(ix: CodexIndex, chars: number): ContextEvolution {
  const changes: ContextChange[] = [];
  const byUsage = ix.calls.length > 0;
  const boundaries: { at: string | null; before: number; input: number | null }[] = byUsage
    ? ix.calls.map((c) => ({ at: c.at, before: c.inputs, input: c.input }))
    : ix.turns.map((t) => ({ at: t.at, before: t.before, input: null }));
  for (const [i, turn] of boundaries.entries()) {
    const from = i === 0 ? 0 : boundaries[i - 1]!.before;
    const added: QueryPart[] = ix.items.slice(from, turn.before).map((item, k) => {
      const { text, truncated } = clip(item.text, chars);
      return {
        slot: from + k,
        role: item.role ?? item.kind,
        origin: item.opaque === null ? 'retained' : 'unreadable',
        via: [`item ${from + k}`],
        types: [item.kind],
        bytes: item.bytes,
        entered: i,
        text: item.opaque === null ? text : null,
        truncated: item.opaque === null ? truncated : false,
        caveat: item.opaque,
      };
    });
    const compacted = ix.compactions.find((c) => c.index > from && c.index <= turn.before) ?? null;
    const state = ix.instructions.find((s) => s.index > from && s.index <= turn.before);
    const previous = state ? ix.instructions.filter((s) => s.index <= from).at(-1) : undefined;
    const delta = ix.deltas.filter((d) => d.index > from && d.index <= turn.before);
    const notable: string[] = [];
    if (compacted) {
      notable.push(`compaction (${compacted.trigger}): ${compacted.pre_tokens ?? '?'} → ${compacted.post_tokens ?? '?'} input tokens by the host's own usage record; the ${compacted.index} items recorded before it left the context, replaced by the ${compacted.replacement_items.length} the host wrote as its replacement_history`);
      notable.push(`the host's retained set at that boundary lists ${compacted.preserved_messages ?? '?'} messages${/INCOMPLETE/.test(compacted.basis) ? ', and marks it INCOMPLETE, so that count is a floor' : ''} — the host's own list, not the item array of the next call`);
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
  return {
    harness: 'codex',
    session_id: ix.sessionId,
    changes,
    gaps: [
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

/** What was in the context of one model call, and where each part came from. */
export function contextAt(path: string, ordinal: number, options: QueryOptions = {}): (ContextAt & { source: TraceSource }) | { error: string; source: TraceSource } {
  const r = read(path);
  if ('error' in r) return r;
  const chars = options.chars ?? PREVIEW_CHARS;
  const answer = r.harness === 'claude' ? claudeAt(indexClaude(r.entries), ordinal, chars) : codexAt(indexCodex(r.entries), ordinal, chars);
  return 'error' in answer ? { error: answer.error, source: r.source } : { ...answer, source: r.source };
}

/** What changed through the run: what each call added, what the host dropped,
 *  when the instructions or tools moved, and what a compaction replaced. */
export function contextEvolution(path: string, options: QueryOptions = {}): (ContextEvolution & { source: TraceSource }) | { error: string; source: TraceSource } {
  const r = read(path);
  if ('error' in r) return r;
  const chars = options.chars ?? PREVIEW_CHARS;
  const answer = r.harness === 'claude' ? claudeEvolution(indexClaude(r.entries), chars) : codexEvolution(indexCodex(r.entries), chars);
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
  const answer = r.harness === 'claude' ? claudeFind(indexClaude(r.entries), needle, chars) : codexFind(indexCodex(r.entries), needle, chars);
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
    : `${named ? (p.origin === 'retained' ? 'blob ' : 'hash ') : ''}${short(only)}`;
  out.push(`  #${String(p.slot).padEnd(4)} ${p.role.padEnd(10)} ${p.origin.padEnd(14)} ${p.entered === null ? 'entered ?' : `entered call ${p.entered}`.padEnd(16)} ${p.bytes === null ? '-' : `${n(p.bytes)}B`.padStart(10)}  ${where}`);
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
      for (const p of c.added) out.push(`    ${p.role.padEnd(10)} ${p.origin.padEnd(14)} ${oneLine(p.text)}`);
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
