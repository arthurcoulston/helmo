/** Where an ACQUIRED input in a context came from (R-56, H-3818).
 *
 *  A run's context is three different kinds of thing wearing the same shape.
 *  Some of it was configured — the instructions, the tool schemas — and
 *  `context-coverage` accounts for that. Some of it the run WROTE: its own
 *  turns, its reasoning. The rest it FETCHED: a file it read, a ticket it
 *  pulled, the output of a command it ran. On both harnesses that third kind
 *  is by far the largest, and until this module it reached every reading as an
 *  anonymous bucket — 2.1MB of "tool-output" on the measured cohort, with
 *  nothing saying which file, which ticket, which command.
 *
 *  The record does hold the answer, but one indirection away: a result names
 *  its REQUEST by the host's call id and carries nothing else, so the source
 *  is in the request, which is a different part of the same context. This
 *  module is the join, and nothing else: it parses no record and reads no
 *  file. Both harness readers hand it blocks they already have.
 *
 *  Its one rule, and the reason it can be trusted: a source is named from the
 *  ARGUMENT FIELD the request actually carries, never from the tool's name.
 *  A tool this reader has never seen that takes `file_path` is reading a file
 *  and is reported as one; a tool named `Read` that takes something else is
 *  not. The alternative — a table of tool names — would put this reader's
 *  guess about today's tool set into an audit of a run made under another
 *  one, and would go quietly wrong rather than reporting `unknown` (the
 *  ticket's "do not claim source-level frequencies where only a generic
 *  tool-result bucket is known"). */

/** What the request named, by the field it named it in. `tool` is a request
 *  whose arguments this reader recognises no source field in — the tool was
 *  called and the call is accounted for, but what it reached for is its own
 *  business. `unknown` is a result whose request is not in the readable part
 *  of this context at all. */
export type AcquiredKind = 'file' | 'command' | 'ticket' | 'skill' | 'web' | 'search' | 'tool' | 'unknown';

/** How `source` was arrived at. `argument` is the only basis that names a
 *  thing; the other two say, in two different ways, that nothing did. */
export type AcquiredBasis = 'argument' | 'no_source_field' | 'request_absent';

export interface AcquiredInput {
  /** The host's own id for the call. The join key, and the identity a reader
   *  uses to go back to the record. */
  call_id: string | null;
  /** The tool as the host named it, including any namespace it recorded. */
  tool: string | null;
  kind: AcquiredKind;
  /** The thing the request named: an absolute path, a ticket id, the command
   *  as it was run, a URL, a search pattern. Whole, never clipped — a
   *  rendering clips it, this does not. `null` wherever the basis is not
   *  `argument`. */
  source: string | null;
  basis: AcquiredBasis;
  /** The argument field `source` was read out of, so a reader can check it
   *  against the request rather than taking this reader's word. */
  source_field: string | null;
  /** The slot of the part holding the REQUEST, where it is in this context.
   *  A result whose request has left the context (a compaction, a dropped
   *  prefix) keeps its call id and gets `null` here. */
  request_slot: number | null;
  /** The request arguments the host recorded, whole. Carried only under the
   *  payload view, like every other verbatim field: the result's own payload
   *  is already on the part, and this is a second object per input. */
  request: unknown;
  /** Bytes of the RESULT as the record holds it, where a size can be read.
   *  This is the figure an audit adds up: it is how much of the context this
   *  one acquisition occupies. */
  bytes: number | null;
  /** Whether the host marked the result an error. An error result is still
   *  context — it occupied slots and bytes — and is not a source. */
  is_error: boolean | null;
}

/** An account of the acquired inputs of one call, by what the request named.
 *  `sources` counts DISTINCT sources, which is the figure that separates one
 *  file read forty times from forty files. */
export interface AcquiredAccount {
  kind: AcquiredKind;
  inputs: number;
  bytes: number;
  sources: number;
}

/** A tool request, as this module needs it: the call id the result will name,
 *  the tool, and the arguments. Both harness readers can produce this from
 *  blocks they already hold. */
export interface AcquiredRequest {
  call_id: string | null;
  tool: string | null;
  args: unknown;
  slot: number;
}

const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The argument fields that name a source, in the order they are tested.
 *  Order matters where a request carries two: a delegated agent's `prompt`
 *  names nothing a reader can follow, so its `subagent_type` is tested first;
 *  a grep carries `pattern` and `path`, and the pattern is what was asked
 *  for. Each entry is a field the hosts' own tools use today — adding one is
 *  how a new tool becomes legible, and leaving one out costs `tool`, not a
 *  wrong answer. */
const SOURCE_FIELDS: { field: string; kind: AcquiredKind }[] = [
  { field: 'file_path', kind: 'file' },
  { field: 'notebook_path', kind: 'file' },
  { field: 'ticket_id', kind: 'ticket' },
  { field: 'skill', kind: 'skill' },
  { field: 'url', kind: 'web' },
  { field: 'command', kind: 'command' },
  { field: 'subagent_type', kind: 'tool' },
  { field: 'pattern', kind: 'search' },
  { field: 'query', kind: 'search' },
  { field: 'path', kind: 'file' },
];

/** A request whose arguments the host wrote as a JSON string rather than an
 *  object — codex writes `function_call.arguments` that way — parsed, so the
 *  field test below sees the same shape on both harnesses. A string that is
 *  not JSON is left as the string it is: it is the argument, and the shell
 *  tools' whole input is exactly that. */
export function acquiredArgs(raw: unknown): unknown {
  const text = str(raw);
  if (text === null) return raw;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return rec(parsed) ? parsed : raw;
  } catch {
    return raw;
  }
}

/** What a request names, from its arguments. A bare string of arguments is a
 *  command: it is how both harnesses' shell tools are called, and the string
 *  IS the thing that was run. */
function named(args: unknown): { kind: AcquiredKind; source: string | null; field: string | null } {
  const text = str(args);
  if (text !== null) return { kind: 'command', source: text, field: null };
  if (!rec(args)) return { kind: 'tool', source: null, field: null };
  for (const { field, kind } of SOURCE_FIELDS) {
    const value = args[field];
    const as = str(value);
    if (as !== null && as !== '') return { kind, source: as, field };
    // An array of strings is how a shell command reaches some hosts, and
    // joining it is the command as it was run rather than a JSON line.
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
      return { kind, source: (value as string[]).join(' '), field };
    }
  }
  return { kind: 'tool', source: null, field: null };
}

/** One acquired input, from the request that produced it. */
export function acquiredInput(
  callId: string | null,
  request: AcquiredRequest | undefined,
  bytes: number | null,
  isError: boolean | null,
  verbatim: boolean,
): AcquiredInput {
  if (request === undefined) {
    return {
      call_id: callId,
      tool: null,
      kind: 'unknown',
      source: null,
      basis: 'request_absent',
      source_field: null,
      request_slot: null,
      request: null,
      bytes,
      is_error: isError,
    };
  }
  const { kind, source, field } = named(request.args);
  return {
    call_id: callId,
    tool: request.tool,
    kind,
    source,
    basis: source === null ? 'no_source_field' : 'argument',
    source_field: field,
    request_slot: request.slot,
    request: verbatim ? request.args : null,
    bytes,
    is_error: isError,
  };
}

/** The per-call account, from every part's inputs. Kinds with nothing in them
 *  are left out: a row of zeroes reads as a measurement. */
export function acquiredAccount(inputs: AcquiredInput[]): AcquiredAccount[] {
  const by = new Map<AcquiredKind, { inputs: number; bytes: number; sources: Set<string> }>();
  for (const i of inputs) {
    const row = by.get(i.kind) ?? { inputs: 0, bytes: 0, sources: new Set<string>() };
    row.inputs += 1;
    row.bytes += i.bytes ?? 0;
    // Keyed on tool AND source: `cat x` run by two different tools is two
    // sources, and a null source contributes none rather than one shared one.
    if (i.source !== null) row.sources.add(`${i.tool ?? ''}\u0000${i.source}`);
    by.set(i.kind, row);
  }
  return [...by.entries()]
    .map(([kind, r]) => ({ kind, inputs: r.inputs, bytes: r.bytes, sources: r.sources.size }))
    .sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind));
}

/** One line of a rendered part, naming where it came from. Clipped, because
 *  this is the terminal reading: `source` on the structure is whole. */
export function renderAcquired(inputs: AcquiredInput[], to = 110): string[] {
  return inputs.map((i) => {
    const what = i.basis === 'argument'
      ? `${i.kind} ${oneLine(i.source ?? '', to)}`
      : i.basis === 'no_source_field'
        ? `${i.tool ?? 'a tool'} call, no argument naming a source`
        : `request not in this context (call ${i.call_id ?? 'unidentified'})`;
    const tool = i.basis === 'argument' && i.tool !== null ? ` — via ${i.tool}` : '';
    const slot = i.request_slot === null ? '' : `, asked at #${i.request_slot}`;
    return `      <- ${what}${tool}${slot}${i.is_error === true ? ' [the host marked this result an error]' : ''}`;
  });
}

const oneLine = (text: string, to: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= to ? flat : `${flat.slice(0, to)}…`;
};
