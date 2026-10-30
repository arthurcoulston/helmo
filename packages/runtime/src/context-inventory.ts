// What every Rev run in a window was actually given, and in what share of
// those runs each item appears (R-56, H-3802).
//
// context-coverage.ts asks whether this installation's CONFIGURED account of a
// seat's context still holds. context-trace.ts and context-query.ts read ONE
// run's host record: what reached the model on the fortieth call and where each
// part came from. Neither can answer the inventory question — "what does mason
// load at its first call, what arrives later, and in how many of its runs" —
// because that question is over a POPULATION of runs, and the population is
// the hard half. A report whose denominator is the runs it managed to parse
// reads as completeness while hiding every run it could not join.
//
// So this is two layers with a seam between them. `cohortRuns` builds the
// population from the launch journal and says, per run, why it is readable or
// not; a seat that ran nothing is a row, not an absence. `inventory` aggregates
// the readable ones and carries the unreadable remainder INTO every figure as
// bounds rather than dropping it: an item in 4 of 9 read runs with 2 runs whose
// channel could not be read is `4..6 of 11`, and a share is withheld entirely
// until the unknown is zero. Unknown is not zero here, and a run nobody could
// read is not a run that held nothing.
//
// What this counts is what the host's own request ledger says was in a call's
// message list. A filename in a prompt, a read that failed, a source this
// installation configured — none of those are loads, and none of them reach an
// item row through this path. R-45's configured inventory is used for one thing
// only: putting a NAME to a chunk the host retained, where the two match by
// content. The chunk is the evidence; the configured source is the label.
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadRoster, type Roster } from './config.js';
import type { LoopConfig } from './types.js';
import { journalEntries, launchSessionRunning, type LaunchJournalEntry } from './launch-journal.js';
import { recordForLaunch } from './context-trace.js';
import { contextAt, contextEvolution, type QueryPart } from './context-query.js';
import type { AcquiredKind } from './context-acquired.js';
import { currentSources, pathProviders, pathRuntimes, readSource } from './context-coverage.js';
import { workingTreeInstructions } from './team.js';

/** The first run of the R-56 cohort: the iteration in which Arthur commissioned
 *  this reading. Runs before it are a different population — they were launched
 *  by releases whose context composition this report cannot vouch for — so the
 *  default window is the last seven days INTERSECTED with this instant rather
 *  than seven days of whatever the journal happens to hold. Explicit bounds
 *  override it, which is how a wider historical read is taken deliberately. */
export const COHORT_START = '2026-10-30T16:05:52Z';

const WINDOW_DAYS = 7;

/** A chunk this reads in full to attribute it. Above it the chunk is still
 *  counted and still has its bytes — it is its NAME that goes unresolved,
 *  which is the honest outcome and not the same as the chunk being absent. */
export const ATTRIBUTION_BYTE_CEILING = 262_144;

/** The smallest variant a CONTAINMENT match may name. Containment asks only
 *  whether a chunk holds a source's bytes, and a handful of bytes is held by
 *  almost anything — so a short instruction file would be named in bundles it
 *  was never part of. The floor leaves no reading different today (the
 *  smallest configured variant on the real roster is about a kilobyte) and
 *  keeps it that way when a short source appears (H-3817). An exact `sha`
 *  match is whole-chunk equality and needs no floor. */
const CONTAINMENT_FLOOR_BYTES = 64;

/** Characters of each later-arriving part carried for matching. The first call
 *  is read whole; a run's additions are its whole conversation and are not, so
 *  this is per part and not per run. It is above the size of an instruction
 *  file on purpose: a part this did not have to truncate is a part whose text
 *  is complete, and containment — the only attribution strong enough to find a
 *  source EMBEDDED in a chunk — needs the whole of it. A part truncated here
 *  falls back to the prefix test and says so. */
const LATER_CHARS = 65_536;

export type RunState =
  /** Joined to a host record, parsed, and it holds at least one model call. */
  | 'read'
  /** Parsed, and the host made no model call in it: a launch that died before
   *  its first request. Its context is not empty, it is unobserved. */
  | 'no_model_call'
  /** Still running, or settled without the host session id that the join needs.
   *  A dispatching launch carries no id by design, so this is the expected
   *  state of the run doing the reading. */
  | 'running'
  /** Settled with an id, and no host record on this machine names it. The host
   *  store is the host's and nothing stops it being pruned. */
  | 'unjoined'
  /** A record was located and could not be read: over the ceiling, corrupt, or
   *  a shape the adapter does not know. */
  | 'unreadable';

export interface InventoryRun {
  seat: string;
  launch_id: string;
  intent_at: string;
  phase: LaunchJournalEntry['phase'];
  provider: string | null;
  model: string | null;
  state: RunState;
  /** Set on every state but `read`, and never empty there: a run excluded from
   *  the item figures says in its own row why. */
  why: string | null;
  record: string | null;
  /** Model calls the record holds. `null` wherever the record was not read. */
  calls: number | null;
}

export type ItemChannel = 'host_instructions' | 'tool' | 'message';

/** How an item got its name. `sha` and `contains` are proofs against the bytes
 *  the host retained. `prefix` is weaker by construction — it matched the
 *  leading characters of a part this read did not carry whole — and is marked
 *  so a reader can discount it. `shape` names no source at all: it is a
 *  structural label for a chunk nothing in the configured inventory accounts
 *  for. `none` is a distinct content with neither. */
export type AttributionBasis = 'sha' | 'contains' | 'prefix' | 'shape' | 'none';

export type Attribution = 'attributed' | 'unattributed' | 'unresolved';

export interface ItemVersion {
  sha256: string;
  bytes: number | null;
  runs: number;
}

export interface ItemEvidence {
  seat: string;
  launch_id: string;
  record: string;
  /** The call whose context held it, as `context-trace --record <record> --at
   *  <ordinal>` takes it. */
  ordinal: number;
  /** The host's own identity for the chunk: its blob hash, or the record
   *  entries it was assembled from. */
  via: string[];
}

export interface InventoryItem {
  key: string;
  channel: ItemChannel;
  label: string;
  attribution: Attribution;
  attribution_basis: AttributionBasis;
  /** The configured source whose content this is, where that is provable. */
  attributed_to: string | null;
  /** Distinct contents seen under this one logical identity, newest count
   *  first. Grouping a source does not merge its versions away: a profile
   *  edited mid-window is one item with two versions, not one averaged item. */
  versions: ItemVersion[];
  /** Runs whose FIRST model call held it. */
  preload_runs: number;
  /** Runs where it first appeared after the first model call. */
  later_runs: number;
  /** Runs that held it at all. Each run counts once, whatever its call count. */
  any_runs: number;
  /** Read runs whose channel for this item could not be read, so they can
   *  neither confirm nor deny it. These are what make a share unsafe. */
  unknown_runs: number;
  /** `any_runs` to `any_runs + unknown_runs`, against every run in the
   *  population — not against the runs that happened to parse. */
  bounds: { low: number; high: number; of: number };
  /** Only ever set when `unknown_runs` is 0 AND every run in the population was
   *  read. Withheld, not estimated, otherwise. */
  share: null | { of: number; pct: number };
  bytes: null | { min: number; max: number };
  /** The harnesses this item was seen under. A source loaded by both is one
   *  item; a host structure is not, and its key is scoped so the two preambles
   *  never average into one row. */
  harnesses: string[];
  /** The forms this source was observed delivered in. `body-after-frontmatter`
   *  means the host handed over the file without its frontmatter: those bytes
   *  were written for the seat and never reached the model. */
  forms: string[];
  evidence: ItemEvidence[];
}

/** Material the host retained that is real and is not a recurring item: a
 *  turn, a tool result, the run's own ticket text. Counting it per item would
 *  be noise — it is unique to its run by nature — but dropping it would make
 *  the accounting below balance by omission, which is the failure this whole
 *  report exists to avoid. */
export interface ResidueAccount {
  parts: number;
  bytes: number;
  runs: number;
}

export interface RunAccount {
  seat: string;
  launch_id: string;
  /** Chunks the first call's context held, by what became of them. */
  chunks: { total: number; itemised: number; residue: number; unresolved: number };
  bytes: { itemised: number; residue: number; unresolved: number };
  /** Channels this run could not read whole, so its item rows are bounds. */
  unknown_channels: ItemChannel[];
}

/** What a seat's runs FETCHED in the window, rolled up — the third kind of
 *  context, and on a real cohort by far the largest. The items above are the
 *  recurring material a run is CONFIGURED with; this is what it went and got,
 *  and until it was here the only route from the population to that figure
 *  was a script composing `context-inventory --json` with one
 *  `context-trace --record` per run (R-56, H-3818). A question an operator
 *  has should not need a file nobody maintains standing between it and the
 *  answer. Off by default: it reads every run's whole evolution rather than
 *  its first call, which is the cost the existing report does not pay. */
export interface AcquiredKindRow {
  kind: AcquiredKind;
  inputs: number;
  bytes: number;
  /** DISTINCT sources, keyed on tool and source together: one file read forty
   *  times and forty files are the same input count and a different finding. */
  sources: number;
  /** Runs that acquired anything of this kind, so a kind one run leans on is
   *  distinguishable from one the whole fleet does. */
  runs: number;
}

export interface AcquiredSourceRow {
  kind: AcquiredKind;
  tool: string | null;
  source: string;
  inputs: number;
  bytes: number;
  runs: number;
}

export interface AcquiredRollup {
  /** Read runs whose evolution this could be taken from. Always against
   *  `runs_total`, never against itself. */
  runs_joined: number;
  /** Read runs whose own export refused, with the reason. A denominator of
   *  the runs that happened to parse reads as completeness. */
  runs_refused: { seat: string; launch_id: string; why: string }[];
  calls: number;
  inputs: number;
  bytes: number;
  by_kind: AcquiredKindRow[];
  /** Every distinct source, heaviest first — not a top-N. This is the data an
   *  audit asks for, and clipping it here would put the script back. */
  sources: AcquiredSourceRow[];
}

export interface SeatInventory {
  seat: string;
  provider_paths: string[];
  /** Sources this installation configures for the seat that matched no chunk in
   *  any read run. Each one is a finding: either it stopped being delivered, or
   *  it has been edited since every run in the window and this read can no
   *  longer recognise what was delivered. Both are worth a look, and neither is
   *  the same as the source being absent from the context. */
  configured_unseen: string[];
  population: Record<RunState, number>;
  runs_total: number;
  /** The population itself, run by run: every launch in the window with its
   *  state, its reason where it has one, and the record it was joined to.
   *  `population` above is this counted, and a count is not a manifest — a
   *  consumer that has to go from "30 read" to the thirty records has nowhere
   *  to go without these, and had to rebuild the join from the launch journal
   *  itself. The record path is what makes `context-trace --record <path>`
   *  reachable for every run the population holds, which is how the per-run
   *  readers apply over a cohort rather than over whatever one run an
   *  operator typed (R-56, H-3818). */
  runs: InventoryRun[];
  items: InventoryItem[];
  residue: ResidueAccount;
  accounts: RunAccount[];
  /** `null`, not an empty roll-up, when it was not asked for: zero inputs is
   *  a measurement and "nobody measured" is not. */
  acquired: AcquiredRollup | null;
  gaps: string[];
}

export interface ContextInventory {
  window: { from: string; to: string; basis: string };
  seats: SeatInventory[];
  /** The same roll-up over every seat at once, because the cohort question —
   *  "where did this fleet's context come from" — is not a per-seat one. */
  acquired: AcquiredRollup | null;
  /** True of every seat's figures, so no reader has to find it per row. */
  gaps: string[];
  measured_at: string;
}

export interface InventoryOptions {
  from?: string;
  to?: string;
  seats?: string[];
  /** Named configured sources used only to put a name to a retained chunk,
   *  per seat. The cohort layer reads these from R-45's inventory; a caller
   *  that passes its own does not touch the operator's installation. */
  named?: Record<string, NamedSource[]>;
  /** Evidence refs carried per item. The drill-down is the ref, not the
   *  content: `context-trace --record <record> --at <ordinal>` reads it. */
  evidence_per_item?: number;
  /** Roll up what each run FETCHED as well as what it was configured with.
   *  Opt-in: it reads every call of every record rather than each record's
   *  first, so it costs what the rest of this report does not. */
  acquired?: boolean;
}

/** One form a configured source can reach a context in. The hosts do not
 *  deliver an instruction file verbatim: both strip a leading YAML frontmatter
 *  block before handing the body over, so a match against the file as it sits
 *  on disk finds nothing and would report a source that IS loaded as unseen.
 *  Which form matched is itself worth reporting — frontmatter a seat's author
 *  wrote never reached the model. */
export interface SourceVariant {
  form: 'whole' | 'body-after-frontmatter';
  text: string;
  sha256: string;
  bytes: number;
}

export interface NamedSource {
  label: string;
  variants: SourceVariant[];
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Structural labels for a chunk no configured source accounts for. These name
 *  a SHAPE, never a source: the host's own preamble, the harness reminders it
 *  wraps a turn in, the skills catalogue it injects. A label here is why a
 *  chunk is countable across runs at all; it is not a claim about where the
 *  bytes came from, and `attributed_to` stays null under it. */
const SHAPES: { id: string; label: string; test: (text: string, role: string, types: string[]) => boolean }[] = [
  { id: 'host-preamble', label: "the host CLI's own preamble", test: (t) => /^You are (Claude Code|Codex)\b/.test(t) },
  { id: 'skills-catalog', label: 'the skills catalogue the host injects', test: (t) => t.includes('<skills_instructions>') || /^\s*## Skills\b/.test(t) },
  { id: 'environment-brief', label: 'the environment brief', test: (t) => t.startsWith('# Environment') },
  { id: 'system-reminder', label: 'harness system reminders', test: (t) => t.trimStart().startsWith('<system-reminder>') },
  { id: 'tool-output', label: 'tool results', test: (_t, _r, types) => types.some((k) => k === 'tool_result' || k === 'function_call_output') },
  { id: 'assistant-turn', label: "the model's own turns", test: (_t, role) => role === 'assistant' },
  { id: 'task-prompt', label: 'the run instruction the launcher supplied', test: (t, role) => (role === 'user' || role === 'developer') && /\bloop iteration\b|\bWorking directory:\b/.test(t) },
];

/** Which shapes are a recurring ITEM and which are a run's own material. A
 *  tool result is as real as a profile and is no more countable across runs
 *  than the command that produced it. */
const RESIDUE_SHAPES = new Set(['tool-output', 'assistant-turn']);

const shapeOf = (text: string, role: string, types: string[]): { id: string; label: string } | null => {
  for (const s of SHAPES) {
    try { if (s.test(text, role, types)) return { id: s.id, label: s.label }; } catch { /* a shape test never decides the read */ }
  }
  return null;
};

/** Put a name to a retained chunk by matching it against the configured
 *  sources, strongest proof first.
 *
 *  Every basis here compares the chunk to the source as it reads TODAY, and
 *  that is the limit a reader has to be told rather than protected from: a
 *  profile edited since the run matches nothing, and this returns no name for
 *  it instead of asserting the current file was what was delivered. The chunk's
 *  own sha is what goes into `versions`, so a name never overwrites the
 *  historical content with the present one. */
const attribute = (text: string | null, bytes: number | null, named: NamedSource[], whole: boolean): Match[] => {
  if (text === null || text === '') return [];
  const own = sha256(text);
  // An exact match is the whole chunk, so nothing else can also be in it.
  for (const s of named) for (const v of s.variants) if (v.sha256 === own) return [{ source: s, variant: v, basis: 'sha' }];
  if (whole && (bytes === null || bytes <= ATTRIBUTION_BYTE_CEILING)) {
    // Every source the chunk carries, not the best one: the harness hands over
    // a bundle, and the second file in it is loaded just as truly as the first.
    // One variant per source — the longest that matched — so a file is not
    // counted twice for being present both whole and as its own body.
    const found: Match[] = [];
    for (const s of named) {
      const hit = s.variants.filter((v) => v.bytes >= CONTAINMENT_FLOOR_BYTES && text.includes(v.text)).sort((a, b) => b.bytes - a.bytes)[0];
      if (hit) found.push({ source: s, variant: hit, basis: 'contains' });
    }
    if (found.length) return found;
  }
  // The chunk was not carried whole, so containment cannot be tested. A source
  // whose own opening is long enough to be distinctive and matches this
  // chunk's is reported with `prefix` against it, and discounted by the
  // reader rather than by this function.
  const head = text.slice(0, 512);
  for (const s of named) for (const v of s.variants) {
    const lead = v.text.slice(0, 512);
    if (lead.length >= 160 && (head.startsWith(lead) || lead.startsWith(head)) && head.length >= 160) return [{ source: s, variant: v, basis: 'prefix' }];
  }
  return [];
};

interface Match { source: NamedSource; variant: SourceVariant; basis: AttributionBasis }

interface Seen {
  key: string;
  channel: ItemChannel;
  label: string;
  attribution: Attribution;
  basis: AttributionBasis;
  attributed_to: string | null;
  sha256: string;
  bytes: number | null;
  form: string | null;
  ordinal: number;
  via: string[];
}

/** What became of one chunk of a call's context: the items it was found to
 *  carry, and the bytes of it that nothing accounts for. Both halves are the
 *  answer. A chunk is rarely one thing — the harness hands over a bundle with
 *  two instruction files and its own wrapper in a single message — so a
 *  classifier that picked the best single match would report the biggest
 *  source and silently lose the rest. The remainder is reported, and the two
 *  plus the unresolved add back up to the chunk. */
interface ChunkReading {
  seen: Seen[];
  residue_bytes: number;
}

const classify = (
  channel: ItemChannel, text: string | null, bytes: number | null, role: string, types: string[],
  named: NamedSource[], whole: boolean, ordinal: number, via: string[], unreadable: boolean, harness: string,
): ChunkReading => {
  if (unreadable) {
    // A chunk whose content the host did not retain. Its size is real and
    // often the interesting figure; its identity is not available, so it is
    // counted as itself and never folded into a named item.
    const key = `unresolved:${harness}:${channel}:${role}:${types.join('+') || 'unknown'}`;
    return {
      seen: [{ key, channel, label: `an unread ${role} chunk on ${harness} (${types.join(', ') || 'no type recorded'})`, attribution: 'unresolved', basis: 'none', attributed_to: null, sha256: '', bytes, form: null, ordinal, via }],
      residue_bytes: 0,
    };
  }
  const body = text ?? '';
  const size = bytes ?? Buffer.byteLength(body, 'utf8');
  const matches = attribute(body, bytes, named, whole);
  const seen: Seen[] = [];
  let matchedBytes = 0;
  for (const m of matches) {
    // The version and the size belong to what MATCHED, not to the chunk that
    // carried it. A profile delivered inside a bundle the harness also appends
    // to would otherwise read as a new version of the profile on every run,
    // which is a fact about the bundle and a lie about the profile. A prefix
    // match claims no version at all: it never saw the whole thing.
    const version = m.basis === 'prefix' ? '' : m.variant.sha256;
    const occupies = m.basis === 'prefix' ? size : m.variant.bytes;
    matchedBytes += occupies;
    seen.push({ key: `source:${m.source.label}`, channel, label: m.source.label, attribution: 'attributed', basis: m.basis, attributed_to: m.source.label, sha256: version, bytes: occupies, form: m.variant.form, ordinal, via });
  }
  // Whatever the named sources do not account for. A prefix match covers an
  // unknown amount of its chunk, so it claims no remainder either way.
  const remainder = matches.some((m) => m.basis === 'prefix') ? 0 : Math.max(0, size - matchedBytes);
  if (remainder === 0) return { seen, residue_bytes: 0 };
  const shape = shapeOf(body, role, types);
  if (shape && !RESIDUE_SHAPES.has(shape.id)) {
    seen.push({ key: `shape:${harness}:${channel}:${shape.id}`, channel, label: `${shape.label} (${harness})`, attribution: 'unattributed', basis: 'shape', attributed_to: null, sha256: sha256(body), bytes: remainder, form: null, ordinal, via });
    return { seen, residue_bytes: 0 };
  }
  if (channel !== 'message' && body.length > 0) {
    // Instruction and tool bytes nothing accounts for. These are never a run's
    // own material — they are configuration this installation does not have a
    // source for — so they get an item rather than being swept into the
    // conversational residue, where an operator would never look for them.
    //
    // A chunk nothing matched is keyed by its content: it will usually appear
    // in exactly one run, and that is the true reading. A chunk whose
    // REMAINDER this is cannot be hashed — the matched text has been taken out
    // of it — so it is keyed by its channel, and carries no version.
    const whole_chunk = seen.length === 0;
    seen.push({
      key: whole_chunk ? `content:${sha256(body).slice(0, 16)}` : `remainder:${harness}:${channel}`,
      channel,
      label: whole_chunk ? `an unaccounted ${channel} chunk on ${harness}` : `the ${channel} bytes alongside a named source that nothing accounts for (${harness})`,
      attribution: 'unattributed', basis: 'none', attributed_to: null,
      sha256: whole_chunk ? sha256(body) : '', bytes: remainder, form: null, ordinal, via,
    });
    return { seen, residue_bytes: 0 };
  }
  return { seen, residue_bytes: remainder };
};

interface Acc {
  item: Omit<InventoryItem, 'bounds' | 'share'> & { versions: ItemVersion[] };
  preload: Set<string>;
  later: Set<string>;
  versionRuns: Map<string, { runs: Set<string>; bytes: number | null }>;
  harnesses: Set<string>;
  forms: Set<string>;
}

/** The roll-up while it is being built. Sets rather than counts, because a
 *  distinct-source count cannot be added up after the fact. */
interface AcquiredAcc {
  runs_joined: number;
  runs_refused: { seat: string; launch_id: string; why: string }[];
  calls: number;
  byKind: Map<AcquiredKind, { inputs: number; bytes: number; sources: Set<string>; runs: Set<string> }>;
  bySource: Map<string, { kind: AcquiredKind; tool: string | null; source: string; inputs: number; bytes: number; runs: Set<string> }>;
}

const newAcquiredAcc = (): AcquiredAcc => ({ runs_joined: 0, runs_refused: [], calls: 0, byKind: new Map(), bySource: new Map() });

/** One run's acquisitions, from its whole evolution. Reads the run's own
 *  changes rather than its first call: most of what a run fetches arrives
 *  after the context it started with. */
function foldAcquired(acc: AcquiredAcc, seat: string, run: InventoryRun): void {
  const evo = contextEvolution(run.record!, { chars: 0 });
  if ('error' in evo) {
    acc.runs_refused.push({ seat, launch_id: run.launch_id, why: evo.error });
    return;
  }
  acc.runs_joined += 1;
  acc.calls += evo.changes.length;
  for (const change of evo.changes) {
    for (const part of change.added) {
      for (const input of part.acquired ?? []) {
        const kindRow = acc.byKind.get(input.kind) ?? { inputs: 0, bytes: 0, sources: new Set<string>(), runs: new Set<string>() };
        kindRow.inputs += 1;
        kindRow.bytes += input.bytes ?? 0;
        kindRow.runs.add(run.launch_id);
        // Keyed on tool AND source, exactly as the per-call account is: the
        // same command run by two tools is two sources, and an input that
        // named nothing contributes no source rather than one shared one.
        if (input.source !== null) {
          const key = `${input.tool ?? ''}\u0000${input.source}`;
          kindRow.sources.add(key);
          const sourceRow = acc.bySource.get(key) ?? { kind: input.kind, tool: input.tool, source: input.source, inputs: 0, bytes: 0, runs: new Set<string>() };
          sourceRow.inputs += 1;
          sourceRow.bytes += input.bytes ?? 0;
          sourceRow.runs.add(run.launch_id);
          acc.bySource.set(key, sourceRow);
        }
        acc.byKind.set(input.kind, kindRow);
      }
    }
  }
}

const finishAcquired = (acc: AcquiredAcc): AcquiredRollup => ({
  runs_joined: acc.runs_joined,
  runs_refused: acc.runs_refused,
  calls: acc.calls,
  inputs: [...acc.byKind.values()].reduce((n, r) => n + r.inputs, 0),
  bytes: [...acc.byKind.values()].reduce((n, r) => n + r.bytes, 0),
  by_kind: [...acc.byKind.entries()]
    .map(([kind, r]) => ({ kind, inputs: r.inputs, bytes: r.bytes, sources: r.sources.size, runs: r.runs.size }))
    .sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind)),
  sources: [...acc.bySource.values()]
    .map((r) => ({ kind: r.kind, tool: r.tool, source: r.source, inputs: r.inputs, bytes: r.bytes, runs: r.runs.size }))
    .sort((a, b) => b.bytes - a.bytes || a.source.localeCompare(b.source)),
});

/** Seat roll-ups into one for the cohort. Exact rather than a re-read: a run
 *  belongs to one seat, so run counts add, and merging the whole source lists
 *  on the same key recovers the cohort's distinct-source count — which seat
 *  totals alone cannot, since two seats reading one file are one source. */
export function mergeAcquired(parts: AcquiredRollup[]): AcquiredRollup {
  const byKind = new Map<AcquiredKind, AcquiredKindRow>();
  const bySource = new Map<string, AcquiredSourceRow>();
  const out: AcquiredRollup = { runs_joined: 0, runs_refused: [], calls: 0, inputs: 0, bytes: 0, by_kind: [], sources: [] };
  for (const p of parts) {
    out.runs_joined += p.runs_joined;
    out.runs_refused.push(...p.runs_refused);
    out.calls += p.calls;
    out.inputs += p.inputs;
    out.bytes += p.bytes;
    for (const r of p.sources) {
      const key = `${r.tool ?? ''}\u0000${r.source}`;
      const prev = bySource.get(key);
      bySource.set(key, prev === undefined ? { ...r } : { ...prev, inputs: prev.inputs + r.inputs, bytes: prev.bytes + r.bytes, runs: prev.runs + r.runs });
    }
    for (const r of p.by_kind) {
      const prev = byKind.get(r.kind);
      // `sources` is recomputed below from the merged list; adding the seats'
      // own counts would double a source two seats both read.
      byKind.set(r.kind, prev === undefined ? { ...r } : { ...prev, inputs: prev.inputs + r.inputs, bytes: prev.bytes + r.bytes, runs: prev.runs + r.runs });
    }
  }
  const distinct = new Map<AcquiredKind, number>();
  for (const r of bySource.values()) distinct.set(r.kind, (distinct.get(r.kind) ?? 0) + 1);
  out.by_kind = [...byKind.values()]
    .map((r) => ({ ...r, sources: distinct.get(r.kind) ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind));
  out.sources = [...bySource.values()].sort((a, b) => b.bytes - a.bytes || a.source.localeCompare(b.source));
  return out;
}

/** Aggregate the readable runs of one seat into items with their frequencies.
 *  Takes a population rather than reading one: a caller handing it runs it
 *  built itself (a test, a different window) gets the same arithmetic, and the
 *  arithmetic is the part worth pinning down. */
export function inventory(runs: InventoryRun[], opts: InventoryOptions = {}): SeatInventory[] {
  const perItem = opts.evidence_per_item ?? 3;
  const bySeat = new Map<string, InventoryRun[]>();
  for (const r of runs) {
    const list = bySeat.get(r.seat) ?? [];
    list.push(r);
    bySeat.set(r.seat, list);
  }
  const out: SeatInventory[] = [];
  for (const [seat, seatRuns] of [...bySeat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const named = opts.named?.[seat] ?? [];
    const population: Record<RunState, number> = { read: 0, no_model_call: 0, running: 0, unjoined: 0, unreadable: 0 };
    for (const r of seatRuns) population[r.state] += 1;
    const accs = new Map<string, Acc>();
    const accounts: RunAccount[] = [];
    const residue: ResidueAccount = { parts: 0, bytes: 0, runs: 0 };
    // Gaps by the text that states them, with the runs each one came from. The
    // provider's own handling is a limit of every run, and a per-run copy of it
    // buries the one gap that belongs to a single run — which is the one an
    // operator needs to see.
    const gapRuns = new Map<string, Set<string>>();
    const note = (text: string, launchId: string | null): void => {
      const runsFor = gapRuns.get(text) ?? new Set<string>();
      if (launchId !== null) runsFor.add(launchId);
      gapRuns.set(text, runsFor);
    };
    // Channels a run could not read whole. An item's unknown count is the
    // number of read runs whose channel is in here, so a run that hid half its
    // tool schemas widens every tool row rather than none of them.
    const unknownByChannel: Record<ItemChannel, Set<string>> = { host_instructions: new Set(), tool: new Set(), message: new Set() };
    const acq = opts.acquired === true ? newAcquiredAcc() : null;

    for (const run of seatRuns) {
      if (run.state !== 'read' || run.record === null) continue;
      // Before the first-call read, and not inside it: a run whose first call
      // refuses can still have readable later calls, and its acquisitions are
      // not forfeit because the report's other half could not be taken.
      if (acq !== null) foldAcquired(acq, seat, run);
      const first = contextAt(run.record, 0, { chars: Infinity });
      if ('error' in first) {
        note(`a run's first call could not be read after its record parsed (${first.error}), so it contributes to no item row and widens every one.`, run.launch_id);
        for (const c of ['host_instructions', 'tool', 'message'] as ItemChannel[]) unknownByChannel[c].add(run.launch_id);
        accounts.push({ seat, launch_id: run.launch_id, chunks: { total: 0, itemised: 0, residue: 0, unresolved: 0 }, bytes: { itemised: 0, residue: 0, unresolved: 0 }, unknown_channels: ['host_instructions', 'tool', 'message'] });
        continue;
      }
      const seen: Seen[] = [];
      const account: RunAccount = { seat, launch_id: run.launch_id, chunks: { total: 0, itemised: 0, residue: 0, unresolved: 0 }, bytes: { itemised: 0, residue: 0, unresolved: 0 }, unknown_channels: [] };
      let runResidue = false;

      // One chunk in, its items and its remainder accounted for. A chunk
      // counts once however many items it carried; its BYTES are split, which
      // is the figure that has to balance.
      const take = (reading: ChunkReading, bytes: number | null): void => {
        account.chunks.total += 1;
        const unresolved = reading.seen.filter((s) => s.attribution === 'unresolved');
        if (unresolved.length) {
          account.chunks.unresolved += 1;
          account.bytes.unresolved += bytes ?? 0;
        } else if (reading.seen.length) {
          account.chunks.itemised += 1;
          account.bytes.itemised += reading.seen.reduce((n, s) => n + (s.bytes ?? 0), 0);
        } else {
          account.chunks.residue += 1;
        }
        if (reading.residue_bytes > 0) {
          account.bytes.residue += reading.residue_bytes;
          residue.bytes += reading.residue_bytes;
          residue.parts += 1;
          runResidue = true;
        } else if (!reading.seen.length) {
          account.bytes.residue += bytes ?? 0;
          residue.bytes += bytes ?? 0;
          residue.parts += 1;
          runResidue = true;
        }
        seen.push(...reading.seen);
      };
      const one = (s: Seen, bytes: number | null): void => take({ seen: [s], residue_bytes: 0 }, bytes);

      // The first call: its instruction blocks, its tool schemas, its messages.
      // Read whole, which is what makes containment attribution available here
      // and only here.
      if (first.instructions) {
        for (const b of first.instructions.blocks) {
          take(classify('host_instructions', b.text, b.bytes, 'system', ['instructions'], named, !b.truncated, 0, [b.sha256], false, first.harness), b.bytes);
        }
        for (const t of first.instructions.tools) {
          one({ key: `tool:${t.name}`, channel: 'tool', label: `tool ${t.name}`, attribution: 'attributed', basis: 'sha', attributed_to: `tool schema ${t.name}`, sha256: sha256(`${t.name}\n${t.description ?? ''}`), bytes: t.bytes, form: null, ordinal: 0, via: [`tool ${t.name}`] }, t.bytes);
        }
      } else {
        unknownByChannel.host_instructions.add(run.launch_id);
        unknownByChannel.tool.add(run.launch_id);
        account.unknown_channels.push('host_instructions', 'tool');
        note('the host retained no instruction or tool configuration for the first call, so this run can neither confirm nor deny any of either.', run.launch_id);
      }
      for (const p of first.parts) take(classifyPart(p, named, 0, first.harness), p.bytes);

      // What arrived later. Carried as a prefix, not whole: a run's additions
      // are its whole conversation. An item named only from a prefix says so.
      const evo = contextEvolution(run.record, { chars: LATER_CHARS });
      if ('error' in evo) {
        note(`the run timeline could not be read (${evo.error}), so later-arriving items are unknown for this run, not absent.`, run.launch_id);
        unknownByChannel.message.add(run.launch_id);
        if (!account.unknown_channels.includes('message')) account.unknown_channels.push('message');
      } else {
        for (const change of evo.changes) {
          if (change.ordinal === 0) continue;
          for (const p of change.added) take(classifyPart(p, named, change.ordinal, first.harness), p.bytes);
          for (const name of change.instructions?.tools_added ?? []) {
            one({ key: `tool:${name}`, channel: 'tool', label: `tool ${name}`, attribution: 'attributed', basis: 'sha', attributed_to: `tool schema ${name}`, sha256: sha256(name), bytes: null, form: null, ordinal: change.ordinal, via: [`tool ${name}`] }, null);
          }
          if (change.compaction) {
            // A compaction REBASES the context: what the next call carried came
            // from a replacement this reader can show, and the material behind
            // it is in no later request. Items counted after one are the
            // replacement's, which is the truth of that call's context, and the
            // run is marked unknown for messages so no row claims otherwise.
            unknownByChannel.message.add(run.launch_id);
            if (!account.unknown_channels.includes('message')) account.unknown_channels.push('message');
            note('a call in this run was a compaction, so the context after it is a replacement and the material it replaced is in no later request. Message rows for it are bounds.', run.launch_id);
          }
        }
      }

      // The unreadable chunks this run held, by channel, so a row's unknown
      // count is the run's own reading rather than a global discount.
      if (first.totals.unreadable > 0) {
        unknownByChannel.message.add(run.launch_id);
        if (!account.unknown_channels.includes('message')) account.unknown_channels.push('message');
        if (first.parts.some((p) => p.origin === 'unreadable' && p.types.some((t) => /tool/i.test(t)))) {
          unknownByChannel.tool.add(run.launch_id);
          if (!account.unknown_channels.includes('tool')) account.unknown_channels.push('tool');
        }
      }
      for (const g of first.gaps) note(g, run.launch_id);

      if (runResidue) residue.runs += 1;
      accounts.push(account);

      // Fold this run's sightings in, once per run per item: a profile in forty
      // calls is one run, and whichever sighting came first decides whether the
      // run counts it as preload or as later.
      const firstSeen = new Map<string, Seen>();
      for (const s of seen) {
        const prev = firstSeen.get(s.key);
        if (!prev || s.ordinal < prev.ordinal) firstSeen.set(s.key, s);
      }
      for (const s of firstSeen.values()) {
        let acc = accs.get(s.key);
        if (!acc) {
          acc = {
            item: {
              key: s.key, channel: s.channel, label: s.label, attribution: s.attribution, attribution_basis: s.basis,
              attributed_to: s.attributed_to, versions: [], preload_runs: 0, later_runs: 0, any_runs: 0, unknown_runs: 0,
              bytes: null, harnesses: [], forms: [], evidence: [],
            },
            preload: new Set(), later: new Set(), versionRuns: new Map(), harnesses: new Set(), forms: new Set(),
          };
          accs.set(s.key, acc);
        }
        // A weaker basis never upgrades a row's claim, and a stronger one does:
        // one run proving a name by sha earns the name, and a later prefix
        // match does not take it back down.
        const rank: Record<AttributionBasis, number> = { sha: 4, contains: 3, prefix: 2, shape: 1, none: 0 };
        if (rank[s.basis] > rank[acc.item.attribution_basis]) {
          acc.item.attribution_basis = s.basis;
          acc.item.attribution = s.attribution;
          acc.item.attributed_to = s.attributed_to;
          acc.item.label = s.label;
        }
        (s.ordinal === 0 ? acc.preload : acc.later).add(run.launch_id);
        acc.harnesses.add(first.harness);
        if (s.form !== null) acc.forms.add(s.form);
        if (s.sha256) {
          const v = acc.versionRuns.get(s.sha256) ?? { runs: new Set<string>(), bytes: s.bytes };
          v.runs.add(run.launch_id);
          if (v.bytes === null) v.bytes = s.bytes;
          acc.versionRuns.set(s.sha256, v);
        }
        if (s.bytes !== null) {
          acc.item.bytes = acc.item.bytes === null ? { min: s.bytes, max: s.bytes } : { min: Math.min(acc.item.bytes.min, s.bytes), max: Math.max(acc.item.bytes.max, s.bytes) };
        }
        if (acc.item.evidence.length < perItem) acc.item.evidence.push({ seat, launch_id: run.launch_id, record: run.record, ordinal: s.ordinal, via: s.via });
      }
    }

    const readRuns = population.read;
    const items: InventoryItem[] = [...accs.values()].map(({ item, preload, later, versionRuns, harnesses, forms }) => {
      const any = new Set([...preload, ...later]);
      const unknown = [...unknownByChannel[item.channel]].filter((id) => !any.has(id)).length;
      const versions = [...versionRuns.entries()]
        .map(([shaOf, v]) => ({ sha256: shaOf, bytes: v.bytes, runs: v.runs.size }))
        .sort((a, b) => b.runs - a.runs || a.sha256.localeCompare(b.sha256));
      const low = any.size;
      const high = any.size + unknown;
      // A share is a figure about the whole population. It is available only
      // when nothing in that population is unaccounted for — no unreadable
      // channel, and no run that never got read at all. Everywhere else the
      // bounds are the answer and there is no number to put beside them.
      const whole = unknown === 0 && readRuns === seatRuns.length;
      return {
        ...item,
        harnesses: [...harnesses].sort(),
        forms: [...forms].sort(),
        versions,
        preload_runs: preload.size,
        later_runs: later.size,
        any_runs: any.size,
        unknown_runs: unknown,
        bounds: { low, high, of: seatRuns.length },
        share: whole ? { of: seatRuns.length, pct: seatRuns.length === 0 ? 0 : Math.round((any.size / seatRuns.length) * 1000) / 10 } : null,
      };
    }).sort((a, b) => b.any_runs - a.any_runs || a.channel.localeCompare(b.channel) || a.label.localeCompare(b.label));

    if (readRuns < seatRuns.length) {
      note(`${seatRuns.length - readRuns} of ${seatRuns.length} runs in this window were not read (${(['running', 'unjoined', 'unreadable', 'no_model_call'] as RunState[]).filter((s) => population[s] > 0).map((s) => `${population[s]} ${s}`).join(', ')}). Every item row's denominator is the whole population and its bounds carry these; a row reading 0 means "not seen in what was read", never "absent".`, null);
    }
    const gaps = [...gapRuns.entries()].map(([text, ids]) => {
      if (ids.size === 0) return text;
      if (readRuns > 1 && ids.size === readRuns) return `all ${readRuns} read runs: ${text}`;
      const named = [...ids].slice(0, 3).join(', ');
      return `${named}${ids.size > 3 ? ` and ${ids.size - 3} more` : ''}: ${text}`;
    });
    const matched = new Set(items.filter((i) => i.attributed_to !== null).map((i) => i.attributed_to!));
    const configured_unseen = named.map((n) => n.label).filter((label) => !matched.has(label));
    out.push({ seat, provider_paths: [], configured_unseen, population, runs_total: seatRuns.length, runs: seatRuns, items, residue, accounts, acquired: acq === null ? null : finishAcquired(acq), gaps });
  }
  return out;
}

/** Whether a part's text is complete is a property of the part, not of which
 *  pass read it: an untruncated later part can be searched for a source
 *  embedded in it exactly as a first-call part can. */
const classifyPart = (p: QueryPart, named: NamedSource[], ordinal: number, harness: string): ChunkReading =>
  classify('message', p.text, p.bytes, p.role, p.types, named, !p.truncated, ordinal, p.via, p.origin === 'unreadable', harness);

/** The lower bound when the caller gave none: the last seven days, floored at
 *  the cohort start. Computed here rather than before the branch because
 *  computing it unconditionally is what threw on an unparseable `to`. */
const defaultWindowFrom = (to: string): string => {
  const sevenDays = new Date(Date.parse(to) - WINDOW_DAYS * 86_400_000).toISOString();
  return Date.parse(sevenDays) > Date.parse(COHORT_START) ? sevenDays : COHORT_START;
};

/** The population: every launch this installation recorded for each seat in
 *  the window, with the reason any of them cannot be read. This is the half a
 *  report cannot be allowed to skip — the journal is the only record of a run
 *  that produced no host record at all, and a reading that starts from host
 *  records would never know it existed. */
export function cohortRuns(opts: InventoryOptions & { roster?: Roster } = {}): { runs: InventoryRun[]; seats: string[]; window: { from: string; to: string; basis: string } } {
  const roster = opts.roster ?? loadRoster();
  // Both bounds, before either is used for anything. An unparseable bound is
  // NaN and every comparison against NaN is false, so unchecked a mistyped
  // `--from` dropped the lower bound and reported the whole journal at exit 0
  // — a selector silently answering the wrong question — while a mistyped
  // `--to` reached the operator as a RangeError from `toISOString` (H-3817).
  // The message names the flag because these options are the command's flags
  // one for one, and the CLI prints this as its refusal.
  for (const [flag, value] of [['--from', opts.from], ['--to', opts.to]] as const) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new Error(`context-inventory: ${flag} is not an instant this can read: ${JSON.stringify(value)}. Pass an ISO instant, as in ${COHORT_START}.`);
    }
  }
  const to = opts.to ?? new Date().toISOString();
  const from = opts.from ?? defaultWindowFrom(to);
  const basis = opts.from
    ? 'explicit bounds'
    : `the last ${WINDOW_DAYS} days intersected with the R-56 cohort start ${COHORT_START}`;
  const lower = Date.parse(from);
  const upper = Date.parse(to);
  const wanted = opts.seats && opts.seats.length ? opts.seats : Object.keys(roster.loops);
  const seats = wanted.filter((s) => roster.loops[s]).sort();
  const runs: InventoryRun[] = [];
  for (const seat of seats) {
    const l = roster.loops[seat]!;
    let entries: LaunchJournalEntry[];
    try { entries = journalEntries(seat); } catch (e) {
      runs.push({ seat, launch_id: '(journal)', intent_at: from, phase: 'intent', provider: null, model: null, state: 'unreadable', why: `This seat's launch journal could not be read: ${e instanceof Error ? e.message : String(e)}. Its population is unknown, not zero.`, record: null, calls: null });
      continue;
    }
    for (const entry of entries) {
      const at = Date.parse(entry.intent_at);
      if (!Number.isFinite(at) || at < lower || at > upper) continue;
      runs.push(runRow(seat, l, entry));
    }
  }
  return { runs, seats, window: { from, to, basis } };
}

const runRow = (seat: string, l: LoopConfig, entry: LaunchJournalEntry): InventoryRun => {
  const base = { seat, launch_id: entry.launch_id, intent_at: entry.intent_at, phase: entry.phase, provider: entry.session?.provider ?? null, model: entry.session?.model ?? null };
  const found = recordForLaunch(entry, l.cwd);
  if ('why' in found) {
    // A launch with no settled session is running or died before settling; one
    // that settled and still has no id or no record is a different fact, and
    // the join's own reason says which.
    const live = entry.session ? { running: false } : launchSessionRunning(seat, entry);
    const state: RunState = !entry.session ? (live.running || entry.phase === 'dispatching' || entry.phase === 'admitted' || entry.phase === 'intent' ? 'running' : 'unjoined') : 'unjoined';
    return { ...base, state, why: found.why, record: null, calls: null };
  }
  let bytes: number | null = null;
  try { bytes = statSync(found.path).size; } catch { bytes = null; }
  const first = contextAt(found.path, 0, { chars: 1 });
  if ('error' in first) {
    // A record that exists and will not parse, versus one that parsed and holds
    // no call: the second is a launch that died before its first request, and
    // calling it unreadable would hide a failure mode behind a tooling one.
    const noCall = /no (model )?(call|invocation)/i.test(first.error) || /0 (calls|invocations)/i.test(first.error);
    return { ...base, state: noCall ? 'no_model_call' : 'unreadable', why: `${first.error}${bytes === null ? '' : ` (record is ${bytes} bytes)`}`, record: found.path, calls: noCall ? 0 : null };
  }
  return { ...base, state: 'read', why: null, record: found.path, calls: first.of };
};

/** The configured sources this installation believes a seat loads, read for
 *  their text so a retained chunk can be matched to one. R-45's inventory is a
 *  label here and never evidence: a source on this list that matched no chunk
 *  is reported as configured-and-unseen, which is a finding, not a load. */
export function namedSourcesFor(seat: string, roster: Roster): NamedSource[] {
  const l = roster.loops[seat];
  if (!l) return [];
  let paths: { path: string; role: 'constitution' | 'skill' | 'discovered' }[] = [];
  try {
    const sources = currentSources(l);
    paths = [...sources.composed, ...sources.discovered].filter((s) => s.state === 'read').map((s) => ({ path: s.path, role: s.role }));
  } catch { return []; }
  // A seat on a rotation runs under both runtimes, and each host discovers a
  // different instruction file in the same tree. Taking the primary runtime's
  // alone leaves the other route's rules unnamed in every run it made — the
  // same correction the coverage inventory needed for launches.
  for (const runtime of pathRuntimes(l)) {
    try {
      for (const path of workingTreeInstructions(l.cwd, runtime)) {
        if (!paths.some((p) => p.path === path)) paths.push({ path, role: 'discovered' });
      }
    } catch { /* a runtime whose discovery throws names nothing extra */ }
  }
  const out: NamedSource[] = [];
  for (const p of paths) {
    try {
      const text = readSource(p.path, p.role).text;
      if (text === null || text === '') continue;
      out.push({ label: p.path, variants: variantsOf(text) });
    } catch { /* an unreadable source names nothing; coverage reports it */ }
  }
  // Longest first, so a chunk holding two sources is attributed to the bigger
  // one rather than to whichever happened to be read first.
  return out.sort((a, b) => longest(b) - longest(a));
}

/** The whole reading: population, items, frequencies, accounting. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

const variant = (form: SourceVariant['form'], text: string): SourceVariant => ({ form, text, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') });

/** The forms of one source worth matching: the file, and the file without a
 *  leading frontmatter block where it has one. Nothing is invented here — a
 *  file with no frontmatter has exactly one form. */
const variantsOf = (text: string): SourceVariant[] => {
  const forms = [variant('whole', text)];
  const body = text.replace(FRONTMATTER, '');
  if (body !== text && body.trim() !== '') forms.push(variant('body-after-frontmatter', body));
  return forms;
};

const longest = (s: NamedSource): number => Math.max(...s.variants.map((v) => v.bytes));

export function contextInventory(opts: InventoryOptions & { roster?: Roster } = {}): ContextInventory {
  const roster = opts.roster ?? loadRoster();
  const { runs, seats, window } = cohortRuns({ ...opts, roster });
  const named: Record<string, NamedSource[]> = opts.named ?? {};
  for (const seat of seats) if (!named[seat]) named[seat] = namedSourcesFor(seat, roster);
  const built = inventory(runs, { ...opts, named });
  const bySeat = new Map(built.map((s) => [s.seat, s]));
  const out: SeatInventory[] = seats.map((seat) => {
    const l = roster.loops[seat]!;
    const paths = pathRuntimes(l).flatMap((r) => pathProviders(l, r).map((p) => `${r}:${p}`));
    const found = bySeat.get(seat);
    if (found) return { ...found, provider_paths: paths };
    // A seat that ran nothing in the window is a row. Reading it as an absence
    // is how a configured agent drops out of a fleet report unnoticed.
    return {
      seat, provider_paths: paths, configured_unseen: [],
      population: { read: 0, no_model_call: 0, running: 0, unjoined: 0, unreadable: 0 },
      runs_total: 0, runs: [], items: [], residue: { parts: 0, bytes: 0, runs: 0 }, accounts: [],
      acquired: opts.acquired === true ? { runs_joined: 0, runs_refused: [], calls: 0, inputs: 0, bytes: 0, by_kind: [], sources: [] } : null,
      gaps: ['This seat launched nothing in the window, so it has no items. That is a reading about the window, not about what the seat loads when it runs.'],
    };
  });
  const rollups = out.map((s2) => s2.acquired).filter((a): a is AcquiredRollup => a !== null);
  return {
    window, seats: out, acquired: rollups.length === 0 ? null : mergeAcquired(rollups),
    measured_at: new Date().toISOString(),
    gaps: [
      "Every figure is of what the HOST retained in its own request ledger. A provider's handling of a request is in no file on this machine, so an item's presence is presence in what was supplied.",
      'A name comes from matching a retained chunk against a configured source as it reads today. A source edited since a run matches nothing from that run and is reported unnamed rather than as the current file.',
      'A mention of a path, or a read that failed, is not a load and reaches no item row. Only chunks the host put in a call\'s context are counted.',
      'Host sessions this installation did not launch carry no journal entry and are not in this population at all.',
      ...(rollups.length === 0 ? [] : ['Acquisitions are of the runs that were READ and of no others: a running, unjoined or unreadable run fetched what it fetched and none of it is counted here. `runs_joined` against `runs_total` is that coverage, and `runs_refused` names the read runs whose own export refused.']),
    ],
  };
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((n / d) * 1000) / 10}%`);

/** The same reading as prose. Structured output is the one a query consumes;
 *  this is the one an operator reads, and it leads with the population because
 *  that is what makes every number below it readable. */
export function renderInventory(r: ContextInventory, limit = 20): string {
  const out: string[] = [];
  out.push(`context inventory  ${r.window.from} → ${r.window.to}`);
  out.push(`  window: ${r.window.basis}`);
  for (const s of r.seats) {
    const p = s.population;
    out.push('');
    out.push(`${s.seat}  (${s.provider_paths.join(', ') || 'no provider path'})`);
    out.push(`  runs in window: ${s.runs_total}  —  read ${p.read}, running ${p.running}, unjoined ${p.unjoined}, unreadable ${p.unreadable}, no model call ${p.no_model_call}`);
    if (s.runs_total === 0) { out.push('  nothing to itemise: this seat launched nothing in the window.'); continue; }
    if (p.read === 0) { out.push('  nothing readable: every run in the window is accounted for above, and none of them can be itemised.'); }
    // Named, not counted. `1 running` on the line above leaves an operator
    // with nothing to go and look at, and the reason is per run.
    for (const run of s.runs.filter((x) => x.state !== 'read')) {
      out.push(`  no figure from ${run.launch_id} (${run.state}): ${run.why ?? 'no reason recorded'}`);
    }
    const shown = s.items.slice(0, limit);
    for (const i of shown) {
      const freq = i.share
        ? `${i.any_runs}/${i.bounds.of} (${pct(i.any_runs, i.bounds.of)})`
        : i.bounds.low === i.bounds.high
          ? `${i.bounds.low} of ${i.bounds.of}`
          : `${i.bounds.low}..${i.bounds.high} of ${i.bounds.of}`;
      const name = i.attribution === 'attributed' ? i.attributed_to! : i.label;
      out.push(`  ${freq.padEnd(22)} ${i.channel.padEnd(18)} ${name}`);
      const basis = i.attribution === 'attributed' ? `named by ${i.attribution_basis}${i.forms.includes('body-after-frontmatter') ? ', delivered without its frontmatter' : ''}` : i.attribution === 'unresolved' ? 'content not retained — size only' : `no configured source accounts for it (${i.attribution_basis})`;
      const size = i.bytes ? (i.bytes.min === i.bytes.max ? `${i.bytes.min}B` : `${i.bytes.min}–${i.bytes.max}B`) : 'no size recorded';
      const versions = i.versions.length === 0 ? 'no version observed whole' : `${i.versions.length} version${i.versions.length === 1 ? '' : 's'}`;
      out.push(`  ${' '.repeat(22)}   preload ${i.preload_runs}, later ${i.later_runs}, unknown ${i.unknown_runs} · ${size} · ${versions} · ${i.harnesses.join('+') || 'no harness'} · ${basis}`);
      const e = i.evidence[0];
      if (e) out.push(`  ${' '.repeat(22)}   e.g. ${e.launch_id} call ${e.ordinal}: context-trace --record ${e.record} --at ${e.ordinal}`);
    }
    if (s.items.length > shown.length) out.push(`  … ${s.items.length - shown.length} more items`);
    for (const u of s.configured_unseen) out.push(`  configured and unseen: ${u} — either it stopped being delivered, or it has been edited since every run here.`);
    out.push(`  run material not itemised: ${s.residue.parts} chunks, ${s.residue.bytes}B across ${s.residue.runs} runs (turns, tool results, this run's own instruction).`);
    if (s.acquired !== null) out.push(...renderAcquiredRollup(s.acquired, s.runs_total, limit, '  '));
    for (const g of s.gaps) out.push(`  gap: ${g}`);
  }
  if (r.acquired !== null && r.seats.length > 1) {
    out.push('');
    out.push('the whole cohort, by where its fetched context came from');
    out.push(...renderAcquiredRollup(r.acquired, r.seats.reduce((n, s) => n + s.runs_total, 0), limit, '  '));
  }
  out.push('');
  for (const g of r.gaps) out.push(`limit: ${g}`);
  return out.join('\n');
}

/** The fetched half as prose. Leads with coverage for the same reason the
 *  report leads with the population: without it the byte totals below read as
 *  the whole of what the runs fetched, and they are the whole of what was
 *  readable. */
function renderAcquiredRollup(a: AcquiredRollup, runsTotal: number, limit: number, pad: string): string[] {
  const out: string[] = [];
  out.push(`${pad}fetched: ${a.inputs} inputs, ${a.bytes.toLocaleString('en-US')}B over ${a.calls} calls — joined from ${a.runs_joined} of ${runsTotal} runs`);
  for (const k of a.by_kind) {
    out.push(`${pad}  ${k.kind.padEnd(9)} ${String(k.inputs).padStart(6)} inputs  ${`${k.bytes.toLocaleString('en-US')}B`.padStart(14)}  ${String(k.sources).padStart(5)} distinct sources  in ${k.runs} runs`);
  }
  for (const r of a.sources.slice(0, limit)) {
    const where = r.source.replace(/\s+/g, ' ').trim();
    out.push(`${pad}  ${`${r.bytes.toLocaleString('en-US')}B`.padStart(12)}  ${String(r.inputs).padStart(4)}x  ${r.kind.padEnd(8)} ${where.length > 96 ? `${where.slice(0, 96)}…` : where}`);
  }
  if (a.sources.length > limit) out.push(`${pad}  … ${a.sources.length - limit} more distinct sources (all of them are in --json)`);
  for (const f of a.runs_refused) out.push(`${pad}  no acquisition figure from ${f.launch_id}: ${f.why}`);
  return out;
}
