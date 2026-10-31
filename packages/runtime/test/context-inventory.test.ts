// The acceptance for the population reading over many runs (R-56, H-3802).
//
// context-query.test.ts asserts what an operator is SHOWN for ONE call of ONE
// run. This file asserts the arithmetic over a POPULATION: that the
// denominator is every run in the window rather than the runs that parsed,
// that a run nobody could read widens a figure instead of being dropped from
// it, that a source carried inside a bundle is counted as itself at its own
// version, and that every chunk a call held is accounted for as a named item,
// an unattributed one, run material, or explicitly unresolved.
//
// Most cases read `inventory()` directly, handing it a population they built.
// That is the seam the module was shaped around: the arithmetic is the part
// worth pinning down, and a test that had to stand up a roster and a journal
// to reach it would be testing the enumeration instead. `cohortRuns` has its
// own cases below, against a temp REV_HOME.
//
// Each case is reddened by at least one mutation of the module, named against
// it. Deliberately not written: that a renderer returns a string, that an
// item list is non-empty, and that the gap list has a particular length.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inventory, cohortRuns, renderInventory, contextInventory, mergeAcquired,
  toolOrigin, categoriesOf, originOf,
  type InventoryRun, type NamedSource, type SeatInventory,
} from '../src/context-inventory.js';
import { ITERATION_PROMPT_SEAM } from '../src/shim.js';
import { ITERATION_PROMPT_OPENING } from '../src/summon-trace.js';

let dir: string;
let savedCodex: string | undefined;
let savedRev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rev-inventory-'));
  savedCodex = process.env['CODEX_HOME'];
  savedRev = process.env['REV_HOME'];
  // No case here may reach the operator's own stores: a continuation segment
  // resolves its history base against ~/.codex, and the journal reader builds
  // its paths under REV_HOME.
  process.env['CODEX_HOME'] = join(dir, 'no-codex-store');
  process.env['REV_HOME'] = join(dir, 'rev');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedCodex === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = savedCodex;
  if (savedRev === undefined) delete process.env['REV_HOME']; else process.env['REV_HOME'] = savedRev;
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** One message of a call: its text, or the content blocks it bundled — a
 *  string block for text, an object for a block the host wrote some other way
 *  (a tool result, an image). */
type Blocks = string | (string | Record<string, unknown>)[];
const write = (name: string, entries: unknown[]): string => {
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
};

/** A claude record whose CONTENT this file controls, in the shape
 *  fixtures/host-records.ts takes from claude-code 2.1.300: one
 *  api-request-shape, a blob per message, and a delta chain of api-requests.
 *
 *  The shared fixture's messages are two characters long on purpose — it
 *  asserts about structure. Attribution is about content, so these cases need
 *  to put a known instruction file inside a known bundle, which means writing
 *  the bytes here. The shape is the fixture's; only the text differs. */
const claudeWith = (over: { system: string[]; calls: Blocks[][]; session?: string; tools?: string[]; laterTools?: string[] }): unknown[] => {
  const sessionId = over.session ?? 'aaaaaaaa-1111-2222-3333-444444444444';
  const texts = over.calls.flat();
  const shape = {
    type: 'api-request-shape', sessionId, shapeHash: 'shape0', timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
    shape: {
      system: over.system.map((text) => ({ type: 'text', text })),
      tools: (over.tools ?? ['Bash']).map((name) => ({ name, description: `the ${name} tool` })),
    },
  };
  // A message is one content block where the call named a string, and SEVERAL
  // where it named an array — which is how claude really delivers a first
  // call: the host's reminder, the repository instruction file and the
  // launcher's prompt as three blocks of one part. A block given as an object
  // is passed through as the host wrote it, which is how a part carries
  // something other than text.
  const blobs = texts.map((text, i) => ({
    type: 'api-request-blob', sessionId, hash: `m${i}`,
    message: { role: 'user', content: (Array.isArray(text) ? text : [text]).map((t) => (typeof t === 'string' ? { type: 'text', text: t } : t)) },
  }));
  const requests: unknown[] = [];
  let held = 0;
  over.calls.forEach((call, i) => {
    const tail = call.map((_t, j) => `m${held + j}`);
    requests.push({
      type: 'api-request', sessionId, id: `r${i}`, timestamp: `2026-10-29T08:00:0${i + 1}.000Z`,
      version: '2.1.300', shapeHash: 'shape0', cwd: '/tmp/seat',
      params: { model: 'claude-opus-5' },
      ...(i === 0 ? {} : { base: `r${i - 1}` }), keep: held, tail,
      requestDigest: `digest-r${i}`,
    });
    held += call.length;
  });
  if (over.laterTools === undefined) return [shape, ...blobs, ...requests];
  // A second shape the LAST request points at, which is how the hosts record a
  // tool table that grew mid-run: the schemas a deferred tool set adds arrive
  // as a shape change, not as a message.
  const later = {
    type: 'api-request-shape', sessionId, shapeHash: 'shape1', timestamp: '2026-10-29T08:00:30.000Z', version: '2.1.300',
    shape: { system: shape.shape.system, tools: [...(over.tools ?? ['Bash']), ...over.laterTools].map((name) => ({ name, description: `the ${name} tool` })) },
  };
  (requests[requests.length - 1] as Record<string, unknown>)['shapeHash'] = 'shape1';
  return [shape, later, ...blobs, ...requests];
};

/** A codex rollout in the shape fixtures/host-records.ts takes from codex
 *  0.164: session_meta, a full world_state, a turn_context opening the call,
 *  then its items. `additional_tools` is the real standing case of a chunk the
 *  host retains the SIZE of and not the content: it carries no text in any
 *  field the reader knows, so the item was in the call's context and what it
 *  held is not on this machine. */
const codexWith = (over: { items: Record<string, unknown>[]; instructions?: string }): unknown[] => [
  {
    type: 'session_meta', timestamp: '2026-10-30T04:00:00.000Z', ordinal: 0,
    payload: {
      session_id: '01a185da-8c88-7463-8b6f-cf9d0d6945cd', cwd: '/tmp/seat', cli_version: '0.164.0',
      model_provider: 'openai', base_instructions: { text: over.instructions ?? 'You are Codex.', provenance: { type: 'model', model: 'gpt-6-astra' } },
    },
  },
  {
    type: 'world_state', timestamp: '2026-10-30T04:00:01.000Z', ordinal: 1,
    payload: { full: true, state: { agents_md: { directory: '/tmp/seat', text: 'the repository rules' }, tools: { shell: 'run a command' } } },
  },
  {
    type: 'turn_context', timestamp: '2026-10-30T04:00:02.000Z', ordinal: 2,
    payload: { turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'xhigh', cwd: '/tmp/seat' },
  },
  ...over.items.map((payload, i) => ({ type: 'response_item', timestamp: `2026-10-30T04:00:0${3 + i}.000Z`, ordinal: 3 + i, payload })),
  // A call in a rollout IS its usage record: the host writes one after the
  // request, and the items recorded before it are what that request carried.
  {
    type: 'token_usage_record', timestamp: '2026-10-30T04:01:00.000Z', ordinal: 3 + over.items.length,
    payload: { response_id: 'resp-1', turn_id: 'turn-1', usage: { input_tokens: 4000, cached_input_tokens: 0 } },
  },
];

/** The chunk whose content no record on this machine holds. */
const opaqueItem = { type: 'additional_tools', role: 'developer', tools: { a: 1, b: 2 } };

const run = (over: Partial<InventoryRun> & { launch_id: string }): InventoryRun => ({
  seat: 'mason', intent_at: '2026-10-30T12:00:00.000Z', phase: 'complete', provider: 'claude',
  model: 'claude-opus-5', state: 'read', why: null, record: null, calls: 1, ...over,
});

const source = (label: string, text: string): NamedSource[] => [{
  label, variants: [{ form: 'whole', text, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') }],
}];

const only = (seats: SeatInventory[]): SeatInventory => {
  expect(seats).toHaveLength(1);
  return seats[0]!;
};
const item = (seat: SeatInventory, match: string) => {
  const found = seat.items.filter((i) => i.label.includes(match) || i.key.includes(match));
  expect(found.length, `exactly one item matching ${match}, got ${found.map((f) => f.key).join(', ') || 'none'}`).toBe(1);
  return found[0]!;
};

describe('the population is the denominator', () => {
  // Mutation: computing `bounds.of` or `share.of` from the runs that were read
  // rather than from every run in the window.
  it('counts an item against every run in the window, not against the runs it could read', () => {
    const profile = 'the mason profile, long enough to be a real instruction file and not a token\n'.repeat(4);
    const record = write('read.jsonl', claudeWith({ system: [`preamble\n${profile}`], calls: [['the first ask']] }));
    const seats = inventory([
      run({ launch_id: 'L1', record }),
      run({ launch_id: 'L2', record }),
      run({ launch_id: 'L3', state: 'running', why: 'has not settled', record: null, calls: null }),
    ], { named: { mason: source('PROFILE.md', profile) } });
    const seat = only(seats);
    expect(seat.population).toMatchObject({ read: 2, running: 1 });
    const found = item(seat, 'PROFILE.md');
    expect(found.any_runs).toBe(2);
    expect(found.bounds).toEqual({ low: 2, high: 2, of: 3 });
    // Two of three runs held it and the third was never read, so there is no
    // percentage to state — the bounds are the whole answer.
    expect(found.share).toBeNull();
  });

  // Mutation: offering a share whenever `unknown_runs` is 0, which is true of
  // a population half of which was never opened.
  it('states a share only when every run in the window was read and no channel was unknown', () => {
    const profile = 'the mason profile, long enough to be a real instruction file and not a token\n'.repeat(4);
    const record = write('all.jsonl', claudeWith({ system: [`preamble\n${profile}`], calls: [['the first ask']] }));
    const seat = only(inventory([run({ launch_id: 'L1', record }), run({ launch_id: 'L2', record })], { named: { mason: source('PROFILE.md', profile) } }));
    expect(item(seat, 'PROFILE.md').share).toEqual({ of: 2, pct: 100 });
  });

  // Mutation: treating a run whose channel could not be read as a run that did
  // not hold the item — which turns an unknown into a measured absence.
  it('widens an item to bounds when a read run held a chunk whose content was not retained', () => {
    const profile = 'the mason profile, long enough to be a real instruction file and not a token\n'.repeat(4);
    const readable = write('readable.jsonl', claudeWith({ system: [`preamble\n${profile}`], calls: [['<system-reminder>the harness reminders this run was given</system-reminder>']] }));
    const opaque = write('opaque.jsonl', codexWith({ items: [opaqueItem, { type: 'message', role: 'user', content: [{ type: 'text', text: 'the first ask' }] }] }));
    const seat = only(inventory([
      run({ launch_id: 'L1', record: readable }),
      run({ launch_id: 'L2', provider: 'codex', record: opaque }),
    ], { named: { mason: source('PROFILE.md', profile) } }));
    const reminders = item(seat, 'harness system reminders');
    expect(reminders.any_runs).toBe(1);
    expect(reminders.unknown_runs).toBe(1);
    expect(reminders.bounds).toEqual({ low: 1, high: 2, of: 2 });
    expect(reminders.share).toBeNull();
  });
});

describe('a named source is counted as itself', () => {
  // Mutation: versioning an attributed item by the sha of the chunk that
  // carried it. The bundle differs per run; the file does not.
  it('versions a source by the source, not by the bundle it arrived in', () => {
    const profile = 'the mason profile, long enough to be a real instruction file and not a token\n'.repeat(4);
    const a = write('a.jsonl', claudeWith({ system: [`run one preamble\n${profile}`], calls: [['ask']] }));
    const b = write('b.jsonl', claudeWith({ system: [`a different run two preamble\n${profile}`], calls: [['ask']], session: 'bbbbbbbb-1111-2222-3333-444444444444' }));
    const seat = only(inventory([run({ launch_id: 'L1', record: a }), run({ launch_id: 'L2', record: b })], { named: { mason: source('PROFILE.md', profile) } }));
    const found = item(seat, 'PROFILE.md');
    expect(found.any_runs).toBe(2);
    expect(found.versions).toHaveLength(1);
    expect(found.versions[0]!.sha256).toBe(sha256(profile));
    expect(found.bytes).toEqual({ min: Buffer.byteLength(profile), max: Buffer.byteLength(profile) });
  });

  // Mutation: matching a configured source only as the file reads on disk.
  // Both hosts strip a leading frontmatter block before delivering the body,
  // so the whole-file test alone reports a source that IS loaded as unseen.
  it('recognises a source the host delivered without its frontmatter, and says so', () => {
    const body = 'the routing rules this seat is given, at a realistic length for an instruction file\n'.repeat(3);
    const file = `---\ncap_tokens: 400\nauthority: 4\n---\n${body}`;
    const record = write('fm.jsonl', claudeWith({ system: [`preamble\n${body}`], calls: [['ask']] }));
    const seat = only(inventory([run({ launch_id: 'L1', record })], {
      named: { mason: [{ label: 'AGENTS.md', variants: [
        { form: 'whole', text: file, sha256: sha256(file), bytes: Buffer.byteLength(file) },
        { form: 'body-after-frontmatter', text: body, sha256: sha256(body), bytes: Buffer.byteLength(body) },
      ] }] },
    }));
    const found = item(seat, 'AGENTS.md');
    expect(found.attribution).toBe('attributed');
    expect(found.forms).toEqual(['body-after-frontmatter']);
    expect(seat.configured_unseen).toEqual([]);
  });

  // Mutation: taking the single best match for a chunk. The harness hands over
  // a bundle, and the second file in it is loaded just as truly as the first.
  it('finds every source a single chunk carried, and itemises what is left over', () => {
    const one = 'the first instruction file, long enough to be distinctive on its own\n'.repeat(3);
    const two = 'the second instruction file, which the same bundle also carried\n'.repeat(3);
    const wrapper = 'wrapper text the host added around both of them\n';
    const record = write('two.jsonl', claudeWith({ system: [`${wrapper}${one}${two}`], calls: [['ask']] }));
    const seat = only(inventory([run({ launch_id: 'L1', record })], {
      named: { mason: [...source('one.md', one), ...source('two.md', two)] },
    }));
    expect(item(seat, 'one.md').attribution).toBe('attributed');
    expect(item(seat, 'two.md').attribution).toBe('attributed');
    const left = item(seat, 'remainder:');
    expect(left.bytes!.min).toBe(Buffer.byteLength(wrapper));
    // The chunk is one chunk however many items came out of it, and its bytes
    // are split across those items without loss.
    const split = seat.items.filter((i) => i.channel === 'host_instructions').reduce((n, i) => n + i.bytes!.min, 0);
    expect(split).toBe(Buffer.byteLength(`${wrapper}${one}${two}`));
  });

  // Mutation: reporting a configured source as loaded because it is
  // configured. R-45's inventory is a label here and never evidence.
  it('reports a configured source that matched no chunk as unseen rather than as loaded', () => {
    const record = write('none.jsonl', claudeWith({ system: ['a preamble that carries nothing of ours'], calls: [['ask']] }));
    const seat = only(inventory([run({ launch_id: 'L1', record })], { named: { mason: source('MEMORY.md', 'a memory file nothing delivered\n'.repeat(5)) } }));
    expect(seat.configured_unseen).toEqual(['MEMORY.md']);
    expect(seat.items.some((i) => i.attributed_to === 'MEMORY.md')).toBe(false);
  });

  // Mutation: testing containment with no floor on the variant. A handful of
  // bytes is contained in almost anything, so a short instruction file would
  // be named in bundles it was never part of (H-3817).
  it('does not name a source by a containment match too short to prove anything', () => {
    const record = write('tiny.jsonl', claudeWith({ system: ['a preamble about the run, the seat and the tools it was given\n'.repeat(3)], calls: [['ask']] }));
    const seat = only(inventory([run({ launch_id: 'L1', record })], { named: { mason: source('tiny.md', 'the seat') } }));
    expect(seat.configured_unseen).toEqual(['tiny.md']);
    expect(seat.items.some((i) => i.attributed_to === 'tiny.md')).toBe(false);

    // Mutation: name only the two causes the line named before — that it
    // stopped being delivered, or that it was edited since every run. This
    // source is unseen for neither reason: it is UNDER the containment floor,
    // so it can only ever be named as a whole chunk of its own, and an
    // operator sent looking for a delivery failure would not find one (ward
    // on H-3836).
    const text = renderInventory({ window: { from: 'a', to: 'b', basis: 'the test window' }, seats: [seat], acquired: null, gaps: [], measured_at: 'now' });
    expect(text).toMatch(/configured and unseen: tiny\.md .*under 64B/);
  });
});

describe('preload and later are told apart', () => {
  // Mutation: counting any sighting as preload, which makes everything a seat
  // ever loaded look like something it starts with.
  it('counts an item that first appeared after the first call as later, not preload', () => {
    const arrival = 'the skill body this run loaded on its fourth turn, at a length worth counting\n'.repeat(3);
    const record = write('later.jsonl', claudeWith({
      system: ['just a preamble'],
      calls: [['the first ask'], [`a tool result\n${arrival}`]],
    }));
    const seat = only(inventory([run({ launch_id: 'L1', record, calls: 2 })], { named: { mason: source('SKILL.md', arrival) } }));
    const found = item(seat, 'SKILL.md');
    expect(found.preload_runs).toBe(0);
    expect(found.later_runs).toBe(1);
    expect(found.any_runs).toBe(1);
    expect(found.evidence[0]!.ordinal).toBeGreaterThan(0);
  });

  // Mutation: letting a later sighting overwrite an earlier one, so a source
  // present from the first call reads as later because it was seen again.
  it('counts a run once, by its earliest sighting', () => {
    const profile = 'the profile this run carried from its first call onward, at a real length\n'.repeat(3);
    const record = write('both.jsonl', claudeWith({
      system: [`preamble\n${profile}`], calls: [['the first ask'], [`and again:\n${profile}`]],
    }));
    const seat = only(inventory([run({ launch_id: 'L1', record, calls: 2 })], { named: { mason: source('PROFILE.md', profile) } }));
    const found = item(seat, 'PROFILE.md');
    expect(found.preload_runs).toBe(1);
    expect(found.later_runs).toBe(0);
    expect(found.any_runs).toBe(1);
  });
});

describe('every chunk is accounted for', () => {
  // Mutation: dropping unmatched conversational material instead of counting
  // it. The accounting would then balance by omission, which is the failure
  // this report exists to avoid.
  it('accounts for a run\'s chunks as items, run material or unresolved, with nothing missing', () => {
    const record = write('acct.jsonl', codexWith({ items: [opaqueItem, { type: 'message', role: 'user', content: [{ type: 'text', text: 'the first ask' }] }] }));
    const seat = only(inventory([run({ launch_id: 'L1', provider: 'codex', record })], {}));
    const account = seat.accounts.find((a) => a.launch_id === 'L1')!;
    expect(account.chunks.total).toBe(account.chunks.itemised + account.chunks.residue + account.chunks.unresolved);
    expect(account.chunks.unresolved).toBeGreaterThan(0);
    // An unresolved chunk is counted as itself, with its size, and is never
    // folded into a named item.
    const opaque = seat.items.filter((i) => i.attribution === 'unresolved');
    expect(opaque.length).toBeGreaterThan(0);
    expect(opaque.every((i) => i.versions.length === 0)).toBe(true);
  });

  // Mutation: itemising tool results and model turns. They are as real as a
  // profile and no more countable across runs than the command that produced
  // them; an item row for each would bury every row that means something.
  it('keeps a run\'s own material out of the item rows and in the residue', () => {
    const record = write('residue.jsonl', claudeWith({ system: ['just a preamble'], calls: [['the ask'], ['a reply']] }));
    const seat = only(inventory([run({ launch_id: 'L1', record, calls: 2 })], {}));
    expect(seat.residue.parts).toBeGreaterThan(0);
    expect(seat.residue.runs).toBe(1);
  });
});

describe('the population comes from the journal, not from the host store', () => {
  const roster = (seats: string[]): void => {
    const home = join(dir, 'rev');
    mkdirSync(home, { recursive: true });
    const cwd = join(dir, 'seat');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'PROFILE.md'), 'a profile\n');
    writeFileSync(join(home, 'roster.toml'), [
      '[global]', 'helmo_cli = "/dev/null"', 'helmo_mcp_server = "/dev/null"', '',
      ...seats.flatMap((s) => [`[loops.${s}]`, 'runtime = "claude"', 'model = "claude-opus-5"', `cwd = "${cwd}"`, `constitution = "${join(cwd, 'PROFILE.md')}"`, 'workstream = "estate-ui"', '']),
    ].join('\n'));
  };
  const journal = (seat: string, entries: Record<string, unknown>[]): void => {
    const d = join(dir, 'rev', 'state', seat, 'launches');
    mkdirSync(d, { recursive: true });
    entries.forEach((e, i) => writeFileSync(join(d, `${i}.json`), JSON.stringify({ format: 1, ...e })));
  };

  // Mutation: building the population by scanning host records. A run that
  // produced no host record at all would then not exist, and the journal is
  // the only place it is written down.
  it('keeps a run that settled with no host record, and says why it cannot be read', () => {
    roster(['mason']);
    journal('mason', [{
      phase: 'complete', launch_id: 'L-gone', intent_at: '2026-10-30T12:00:00.000Z',
      session: { provider: 'claude', model: 'claude-opus-5', provider_session_id: 'cccccccc-1111-2222-3333-444444444444', provider_session_id_state: 'observed', started_at: '2026-10-30T12:00:00.000Z', ended_at: '2026-10-30T12:05:00.000Z', outcome: 'ok' },
    }]);
    const { runs } = cohortRuns({ from: '2026-10-30T00:00:00Z', to: '2026-10-30T23:00:00Z', seats: ['mason'] });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe('unjoined');
    expect(runs[0]!.why).toMatch(/names session cccccccc/);
  });

  // Mutation: calling a launch that has not settled `unjoined`. A dispatching
  // launch carries no host session id by design — that is the state of the run
  // taking the reading, and it is not a missing record.
  it('reads a launch that has not settled as running', () => {
    roster(['mason']);
    journal('mason', [{ phase: 'dispatching', launch_id: 'L-live', intent_at: '2026-10-30T12:00:00.000Z' }]);
    const { runs } = cohortRuns({ from: '2026-10-30T00:00:00Z', to: '2026-10-30T23:00:00Z', seats: ['mason'] });
    expect(runs[0]!.state).toBe('running');
  });

  // Mutation: defaulting the window to seven days of whatever the journal
  // holds. Runs before the cohort start were launched by releases whose
  // context composition this report cannot vouch for.
  it('defaults the window to the last seven days intersected with the cohort start', () => {
    roster(['mason']);
    journal('mason', []);
    const { window } = cohortRuns({ to: '2026-10-31T00:00:00Z', seats: ['mason'] });
    expect(window.from).toBe('2026-10-30T16:05:52Z');
    expect(window.basis).toMatch(/cohort start/);
    const wide = cohortRuns({ from: '2026-01-01T00:00:00Z', to: '2026-10-31T00:00:00Z', seats: ['mason'] });
    expect(wide.window.basis).toBe('explicit bounds');
  });

  // Mutation: omitting a seat with no runs. A configured agent that stopped
  // running is exactly the thing a fleet report must not lose.
  it('keeps a seat that launched nothing as a row of its own', () => {
    roster(['mason', 'idle']);
    journal('mason', [{ phase: 'dispatching', launch_id: 'L-live', intent_at: '2026-10-30T12:00:00.000Z' }]);
    journal('idle', []);
    const report = contextInventory({ from: '2026-10-30T00:00:00Z', to: '2026-10-30T23:00:00Z', seats: ['mason', 'idle'] });
    const idle = report.seats.find((s) => s.seat === 'idle')!;
    expect(idle.runs_total).toBe(0);
    expect(idle.items).toEqual([]);
    expect(idle.gaps.join(' ')).toMatch(/launched nothing/);
    expect(renderInventory(report)).toContain('launched nothing in the window');
  });

  // Mutation: filtering with a bare `Date.parse` comparison per entry. An
  // unparseable bound is NaN and every comparison against it is false, so a
  // mistyped `--from` dropped the lower bound and read the whole journal at
  // exit 0 — a selector silently answering the wrong question (H-3817).
  it('refuses an unparseable lower bound instead of widening the window to the whole journal', () => {
    roster(['mason']);
    journal('mason', [
      { phase: 'dispatching', launch_id: 'L-in', intent_at: '2026-10-30T12:00:00.000Z' },
      { phase: 'dispatching', launch_id: 'L-older', intent_at: '2026-10-30T01:00:00.000Z' },
    ]);
    const bounded = cohortRuns({ from: '2026-10-30T06:00:00Z', to: '2026-10-30T23:00:00Z', seats: ['mason'] });
    expect(bounded.runs.map((r) => r.launch_id)).toEqual(['L-in']);
    expect(() => cohortRuns({ from: 'banana', to: '2026-10-30T23:00:00Z', seats: ['mason'] })).toThrow(/--from/);
  });

  // Mutation: computing the default lower bound before knowing `to` parses.
  // `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`, so
  // the refusal reached the operator as a stack trace with nothing on stdout,
  // even when `--from` was good (H-3817, the H-3637 finding-2 shape).
  it('refuses an unparseable upper bound by name rather than through a RangeError', () => {
    roster(['mason']);
    journal('mason', []);
    for (const opts of [{ to: 'banana' }, { from: '2026-10-30T00:00:00Z', to: 'banana' }]) {
      let thrown: unknown;
      try { cohortRuns({ ...opts, seats: ['mason'] }); } catch (e) { thrown = e; }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toMatch(/--to/);
      expect(message).not.toMatch(/Invalid time value/);
    }
  });
});

// The population as a MANIFEST, not a count (R-56, H-3818). `population`
// answers "how many" and a cohort query needs "which": the record path for
// every run that was read, and the launch id and reason for every run no
// figure can come from.
describe('the population is reachable, run by run', () => {
  // Mutation: keep `population` as the whole account of the population. A
  // consumer going from "30 read" to the thirty records has nowhere to go and
  // has to rebuild the join from the launch journal — which is the bespoke
  // reconstruction this capability exists to remove.
  it('carries every run with its state, its reason and the record it was joined to', () => {
    const profile = 'the mason profile, long enough to be a real instruction file and not a token\n'.repeat(4);
    const record = write('manifest.jsonl', claudeWith({ system: [`preamble\n${profile}`], calls: [['the first ask']] }));
    const seat = only(inventory([
      run({ launch_id: 'L1', record }),
      run({ launch_id: 'L2', state: 'unjoined', why: 'no host record on this machine names its session', record: null, calls: null }),
    ]));

    expect(seat.runs.map((r) => [r.launch_id, r.state, r.record])).toEqual([
      ['L1', 'read', record],
      ['L2', 'unjoined', null],
    ]);
    // And the manifest is the population, not a subset of it: the counts above
    // it are these rows counted.
    expect(seat.runs).toHaveLength(seat.runs_total);
    expect(seat.runs.filter((r) => r.state === 'read')).toHaveLength(seat.population.read);
  });

  // Mutation: print the state counts and stop. `1 running` leaves an operator
  // with no launch id to look at and no reason, and the reason is per run.
  it('names each run no figure can come from, in the reading an operator sees', () => {
    const text = renderInventory({
      window: { from: 'a', to: 'b', basis: 'the test window' },
      seats: [only(inventory([
        run({ launch_id: 'L1', record: write('r.jsonl', claudeWith({ system: ['preamble'], calls: [['ask']] })) }),
        run({ launch_id: 'L2', state: 'running', why: 'has not settled, so it carries no host session id', record: null, calls: null }),
      ]))],
      acquired: null,
      gaps: [],
      measured_at: 'now',
    });

    expect(text).toContain('no figure from L2 (running): has not settled, so it carries no host session id');
    expect(text).not.toContain('no figure from L1');
  });
});

describe('what the population FETCHED, not only what it was configured with', () => {
  /** A claude record whose calls fetch things. `claudeWith` above builds text
   *  turns, which is what attribution needs; acquisition needs requests and
   *  their results, so this writes those. Each call adds one request message
   *  and one result message, which is the shape both hosts actually produce. */
  const claudeFetching = (over: { session: string; calls: { tool: string; input: unknown; out: string }[][] }): unknown[] => {
    const sessionId = over.session;
    const entries: unknown[] = [{
      type: 'api-request-shape', sessionId, shapeHash: 'shape0', timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
      shape: { system: [{ type: 'text', text: 'preamble' }], tools: [{ name: 'Bash', description: 'run a command' }] },
    }];
    const tail: string[] = [];
    over.calls.forEach((call, i) => {
      const ask = `q${i}`;
      const got = `a${i}`;
      entries.push({
        type: 'api-request-blob', sessionId, hash: ask,
        message: { role: 'assistant', content: call.map((c, j) => ({ type: 'tool_use', id: `t${i}_${j}`, name: c.tool, input: c.input })) },
      });
      entries.push({
        type: 'api-request-blob', sessionId, hash: got,
        message: { role: 'user', content: call.map((c, j) => ({ type: 'tool_result', tool_use_id: `t${i}_${j}`, content: c.out })) },
      });
      tail.push(ask, got);
      entries.push({
        type: 'api-request', sessionId, id: `r${i}`, timestamp: `2026-10-29T08:00:0${i + 1}.000Z`,
        version: '2.1.300', shapeHash: 'shape0', cwd: '/tmp/seat', params: { model: 'claude-opus-5' },
        ...(i === 0 ? {} : { base: `r${i - 1}` }), keep: i * 2, tail: tail.slice(i * 2),
      });
    });
    return entries;
  };

  const fetchingRun = (launch: string, calls: { tool: string; input: unknown; out: string }[][]): InventoryRun =>
    run({ launch_id: launch, record: write(`${launch}.jsonl`, claudeFetching({ session: `aaaaaaaa-1111-2222-3333-44444444444${launch.slice(-1)}`, calls })) });

  const read = (text: string) => ({ tool: 'Read', input: { file_path: '/tmp/seat/AGENTS.md' }, out: text });
  const query = (project: string, text: string) => ({ tool: 'mcp__helmo__helmo_list_tickets', input: { project }, out: text });

  // Mutation: roll the acquisitions up per run and stop. The question is over
  // a cohort — "where did this fleet's context come from" — and a per-run
  // answer leaves the only route to it a script composing one shipped command
  // with another, which is the bespoke reconstruction this exists to remove.
  it('rolls what every run fetched up by kind, counting a source read twice as one', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[read('the rules'), query('R-45', 'a ticket list')]]),
      fetchingRun('L2', [[read('the rules again')], [query('R-56', 'another list')]]),
    ], { acquired: true }));
    const a = seat.acquired!;

    expect(a.runs_joined).toBe(2);
    expect(a.runs_refused).toEqual([]);
    // One file, read in both runs: two inputs, one source, two runs.
    expect(a.by_kind.find((k) => k.kind === 'file')).toMatchObject({ inputs: 2, sources: 1, runs: 2 });
    // Two queries with different filters: two inputs, two sources.
    expect(a.by_kind.find((k) => k.kind === 'tool')).toMatchObject({ inputs: 2, sources: 2, runs: 2 });
    expect(a.inputs).toBe(4);
    // Every distinct source, not a top-N: an audit that has to ask twice for
    // the tail is back to writing the script.
    expect(a.sources.map((r) => r.source).sort()).toEqual(['/tmp/seat/AGENTS.md', 'project=R-45', 'project=R-56']);
    expect(a.sources.find((r) => r.source === '/tmp/seat/AGENTS.md')).toMatchObject({ inputs: 2, runs: 2 });
  });

  // Mutation: count `runs_joined` as the denominator, or leave a refused run
  // out silently. A denominator of the runs that happened to parse reads as
  // completeness, which is the failure the whole report is shaped against.
  it('counts acquisitions only from runs it read, and says how many that was', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[read('the rules')]]),
      run({ launch_id: 'L2', state: 'running', why: 'has not settled', record: null, calls: null }),
      run({ launch_id: 'L3', state: 'unjoined', why: 'no host record names its session', record: null, calls: null }),
    ], { acquired: true }));

    expect(seat.acquired!.runs_joined).toBe(1);
    expect(seat.runs_total).toBe(3);
    expect(seat.acquired!.inputs).toBe(1);
  });

  // Mutation: return an empty roll-up when it was not asked for. Zero inputs
  // is a measurement; "nobody measured" is not, and a consumer cannot tell
  // the two apart from a row of zeroes.
  it('is absent, not empty, when the roll-up was not asked for', () => {
    const seats = inventory([fetchingRun('L1', [[read('the rules')]])]);

    expect(only(seats).acquired).toBeNull();
  });

  // Mutation: add the seats' own distinct-source counts together for the
  // cohort row. Two seats reading one file are one source and would report
  // as two, and the count that separates forty files from one file read
  // forty times is the only reason the column is there.
  it('merges the seats into one cohort reading without double-counting a shared source', () => {
    const mine = only(inventory([fetchingRun('L1', [[read('the rules')]])], { acquired: true })).acquired!;
    const theirs = only(inventory([fetchingRun('L2', [[read('the rules')]])], { acquired: true })).acquired!;
    const both = mergeAcquired([mine, theirs]);

    expect(both.by_kind.find((k) => k.kind === 'file')).toMatchObject({ inputs: 2, sources: 1, runs: 2 });
    expect(both.runs_joined).toBe(2);
    expect(both.sources).toHaveLength(1);
  });

  // Mutation: print the kind totals and stop. 1MB of `tool` with no source
  // named is exactly the reading this increment exists to end, and the
  // heaviest sources are what an operator opens the report for.
  it('names the heaviest sources in the reading an operator sees', () => {
    const seat = only(inventory([fetchingRun('L1', [[read('x'.repeat(500)), query('R-45', 'small')]])], { acquired: true }));
    const text = renderInventory({
      window: { from: 'a', to: 'b', basis: 'the test window' },
      seats: [seat], acquired: seat.acquired, gaps: [], measured_at: 'now',
    });

    expect(text).toContain('fetched: 2 inputs');
    expect(text).toContain('/tmp/seat/AGENTS.md');
    expect(text).toContain('project=R-45');
  });

  /** A write whose arguments are CONTENT rather than an identity: the whole
   *  argument set is over `ARGUMENT_SET_CHARS`, so nothing names a source and
   *  keying one on the body would report one source per call. */
  const writeTicket = (body: string, out: string) =>
    ({ tool: 'mcp__helmo__helmo_create_ticket', input: { body }, out });

  /** An acquisition's bytes are the WHOLE result block as the record holds it,
   *  not the content inside it — `type` and `tool_use_id` were in the context
   *  too. Derived here rather than written as a number, because a figure read
   *  from the content alone is a few percent light in one direction across
   *  every kind, which looks like a reader defect rather than the measuring
   *  error it is (H-3818, increment 3). `call` and `slot` are the fixture's
   *  own `t${call}_${slot}` ids. */
  const resultBytes = (call: number, slot: number, out: string): number =>
    JSON.stringify({ type: 'tool_result', tool_use_id: `t${call}_${slot}`, content: out }).length;

  // Mutation: leave `unnamed` off the kind row. The figure was previously
  // only reachable by subtracting the source rows from the kind row, and an
  // audit asking "how much of this is still unattributed" should not have to
  // do arithmetic across two lists to find out.
  it('says how much of a kind named no source, without making the reader subtract', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[query('R-45', 'a list'), writeTicket('b'.repeat(400), 'H-1')]]),
    ], { acquired: true }));
    const tool = seat.acquired!.by_kind.find((k) => k.kind === 'tool')!;

    expect(tool.inputs).toBe(2);
    expect(tool.unnamed).toEqual({ inputs: 1, bytes: resultBytes(0, 1, 'H-1') });
    // And it reconciles: the named inputs are exactly the source rows, so
    // `inputs` less `unnamed.inputs` is what the list below accounts for.
    const named = seat.acquired!.sources.filter((r) => r.kind === 'tool');
    expect(named.map((r) => r.source)).toEqual(['project=R-45']);
    expect(tool.inputs - tool.unnamed.inputs).toBe(named.reduce((n, r) => n + r.inputs, 0));
  });

  // Mutation: recompute `unnamed` from the merged source list the way
  // `sources` is. An input that named nothing has no source row to merge, so
  // it would silently read zero across a cohort that is full of them.
  it('adds the unnamed across seats, where a distinct-source count cannot be added', () => {
    const mine = only(inventory([fetchingRun('L1', [[writeTicket('b'.repeat(400), 'H-1')]])], { acquired: true })).acquired!;
    const theirs = only(inventory([fetchingRun('L2', [[writeTicket('c'.repeat(400), 'H-2')]])], { acquired: true })).acquired!;
    const both = mergeAcquired([mine, theirs]);
    const tool = both.by_kind.find((k) => k.kind === 'tool')!;

    expect(tool.unnamed).toEqual({ inputs: 2, bytes: resultBytes(0, 0, 'H-1') + resultBytes(0, 0, 'H-2') });
    expect(tool.sources).toBe(0);
  });

  // Mutation: count every source as a singleton, or count inputs rather than
  // distinct sources. `sources` is a GROUPING only where a key repeats, and
  // this is the figure that says how much of the count is a tail — the
  // question behind both reviewers' doubt about the argument-set key.
  it('says how much of a kind is a tail of sources seen exactly once', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[query('R-45', 'twice'), query('R-56', 'once-only')]]),
      fetchingRun('L2', [[query('R-45', 'twice')]]),
    ], { acquired: true }));
    const tool = seat.acquired!.by_kind.find((k) => k.kind === 'tool')!;

    expect(tool.sources).toBe(2);
    // `project=R-45` was asked in both runs and is a grouping; `project=R-56`
    // was asked once and is not.
    expect(tool.singletons).toEqual({ sources: 1, bytes: resultBytes(0, 1, 'once-only') });
  });

  // Mutation: add the seats' own singleton figures for the cohort row. A
  // source each of two seats fetched once is two inputs in the merge and is
  // no longer a one-off, so an added figure reports a tail that is not there
  // — the same error `sources` is recomputed to avoid.
  it('recomputes the singletons for the cohort rather than adding the seats', () => {
    const mine = only(inventory([fetchingRun('L1', [[read('the rules')]])], { acquired: true })).acquired!;
    const theirs = only(inventory([fetchingRun('L2', [[read('the rules')]])], { acquired: true })).acquired!;

    expect(mine.by_kind.find((k) => k.kind === 'file')!.singletons.sources).toBe(1);
    expect(theirs.by_kind.find((k) => k.kind === 'file')!.singletons.sources).toBe(1);
    expect(mergeAcquired([mine, theirs]).by_kind.find((k) => k.kind === 'file')!.singletons).toEqual({ sources: 0, bytes: 0 });
  });

  // Mutation: drop `singletonsOf`'s own kind filter. Every other singleton
  // case above holds ONE kind, so the filter is free to vanish in them (ward's
  // W2 on H-3858) — and a window with two kinds in it then reports each row's
  // tail as the whole window's. The figure exists to say how far to trust THIS
  // kind's source count, so a file read in every run would carry a tail
  // because some query somewhere was asked once.
  it('counts a kind\'s tail from its own sources, not from every kind in the window', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[read('the rules'), query('R-56', 'once-only')]]),
      fetchingRun('L2', [[read('the rules')]]),
    ], { acquired: true }));
    const file = seat.acquired!.by_kind.find((k) => k.kind === 'file')!;
    const tool = seat.acquired!.by_kind.find((k) => k.kind === 'tool')!;

    // The file was read in both runs, so its one source is a grouping and the
    // file row has no tail at all; the query was asked once and is the whole
    // of the tool row's.
    expect(file).toMatchObject({ inputs: 2, sources: 1 });
    expect(file.singletons).toEqual({ sources: 0, bytes: 0 });
    expect(tool.singletons).toEqual({ sources: 1, bytes: resultBytes(0, 1, 'once-only') });
  });

  // Mutation: keep both figures in --json and out of the reading. The whole
  // point of either is that an operator reads the kind row and knows how far
  // to trust its source count, without opening the export.
  it('puts the tail and the unattributed mass in the operator\'s reading too', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[query('R-45', 'once-only'), writeTicket('b'.repeat(400), 'H-1')]]),
    ], { acquired: true }));
    const text = renderInventory({
      window: { from: 'a', to: 'b', basis: 'the test window' },
      seats: [seat], acquired: seat.acquired, gaps: [], measured_at: 'now',
    });

    expect(text).toContain('1 seen once');
    expect(text).toContain(`1 naming nothing (${resultBytes(0, 1, 'H-1')}B)`);
  });
});

describe('whose content it is, how it got here, and which audit category that makes it', () => {
  // Mutation: return one category per item rather than a set, or decide it
  // from the channel alone. The category R-56 defines is the supplier
  // CROSSED with where the item entered — "our startup inputs" and "our
  // mid-run additions" are two different optimisation areas with the same
  // owner — so a row that picks one has lost the half an audit reads it for.
  it('crosses the supplier with where the item entered to name the category', () => {
    const profile = 'the seat profile, as it reads today\n'.repeat(40);
    const seat = only(inventory([
      run({
        launch_id: 'L1',
        record: write('cats.jsonl', claudeWith({
          system: [`You are Claude Code, the host preamble\n${profile}`],
          calls: [['the first ask'], ['the second']],
          tools: ['Bash'], laterTools: ['mcp__helmo__helmo_get_ticket'],
        })),
        calls: 2,
      }),
    ], { named: { mason: source('/tmp/seat/PROFILE.md', profile) }, servers: { mason: ['helmo'] } }));

    // Ours, at the first request.
    expect(item(seat, '/tmp/seat/PROFILE.md')).toMatchObject({
      categories: ['1'], supplier: 'us', supplier_basis: 'configured_source', entry: 'host_instructions',
    });
    // Theirs, at the first request.
    expect(item(seat, 'tool Bash')).toMatchObject({ categories: ['2'], supplier: 'host', entry: 'host_tool_table' });
    // Ours, added after it — a different category with the same owner, and
    // the trigger is the call it was added at.
    expect(item(seat, 'tool mcp__helmo__helmo_get_ticket')).toMatchObject({
      categories: ['4b'], supplier: 'us', supplier_basis: 'configured_server', entry_trigger: 'added at call 1',
    });
  });

  // Mutation: read the tool's NAME for a server we know — test for `helmo`
  // in the string, or fall back to `us` when the configured list is empty.
  // Either one puts this reader's guess about today's tool set into an audit
  // of a run made under another one, and the failure is silent: a tool
  // somebody else configures reads as ours.
  it('calls a tool ours only when its namespace is a server this installation configures', () => {
    expect(toolOrigin('mcp__helmo__helmo_get_ticket', ['helmo'])).toMatchObject({ supplier: 'us', supplier_basis: 'configured_server', entry_trigger: 'MCP server helmo' });
    // The same tool, on an installation that does not configure that server.
    expect(toolOrigin('mcp__helmo__helmo_get_ticket', [])).toMatchObject({ supplier: 'unknown', supplier_basis: 'unconfigured_server' });
    expect(toolOrigin('mcp__other__thing', ['helmo'])).toMatchObject({ supplier: 'unknown', supplier_basis: 'unconfigured_server', entry_trigger: 'MCP server other' });
    // No namespace at all: both hosts namespace every server tool, so this is
    // one the host CLI itself defines.
    expect(toolOrigin('Bash', ['helmo'])).toMatchObject({ supplier: 'host', supplier_basis: 'host_tool' });
  });

  // Mutation: read the whole cross from the supplier and ignore the measures
  // ('us' always 1, 'host' always 2). An item nothing was seen entering would
  // then carry a category no run put it in.
  it('claims only the categories runs were seen entering, and unknown where the supplier is unestablished', () => {
    const ours = originOf('us', 'configured_source', 'host_instructions');
    const theirs = originOf('host', 'host_shape', 'host_injection');

    expect(categoriesOf(ours, 3, 0)).toEqual(['1']);
    expect(categoriesOf(ours, 0, 3)).toEqual(['4b']);
    // The same logical source entering both ways across a cohort.
    expect(categoriesOf(ours, 2, 1)).toEqual(['1', '4b']);
    expect(categoriesOf(theirs, 2, 1)).toEqual(['2', '4a']);
    // Seen in no run: a supplier and no observed entry point is not a category.
    expect(categoriesOf(ours, 0, 0)).toEqual(['unknown']);
    expect(categoriesOf(originOf('unknown', 'none', 'host_instructions'), 3, 0)).toEqual(['unknown']);
  });

  // Mutation: default an unnamed instruction chunk to the host, since it
  // arrived in the host's own instructions. That is the delivery mechanism
  // standing in for the content's owner — the exact collapse R-56 forbids —
  // and it would file configuration this installation has no source for
  // under somebody else's name instead of reporting it as a finding.
  it('leaves the supplier unestablished for a chunk nothing named', () => {
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('unnamed.jsonl', claudeWith({ system: ['configuration nothing here accounts for'], calls: [['the ask']] })) }),
    ]));

    expect(item(seat, 'an unaccounted host_instructions chunk')).toMatchObject({
      supplier: 'unknown', supplier_basis: 'none', categories: ['unknown'], entry: 'host_instructions', control: null,
    });
  });

  // Mutation: drop OURS_SHAPES and let every shape be the host's. The
  // iteration prompt is the one startup input this installation composes
  // fresh per run — R-56 calls category 1 "our highest-control optimization
  // area" — and reading it as an injection moves it out of that category
  // and out of the control line that says where to change it.
  it('keeps the launcher prompt ours however the host delivered it', () => {
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('prompt.jsonl', claudeWith({ system: ['preamble'], // The wording the shape test actually recognises, as a real prompt
      // carries it: "This is a Rev loop iteration, not a summon".
      calls: [['This is a Rev loop iteration, not a summon; the queue is the work.']] })) }),
    ]));

    const prompt = item(seat, 'the run instruction the launcher supplied');
    expect(prompt).toMatchObject({ supplier: 'us', supplier_basis: 'launcher_shape', entry: 'launcher_prompt', categories: ['1'] });
    expect(prompt.control).toContain('Rev iteration prompt');
  });

  // Mutation: read a part whole — have `partSeams` return null however many
  // content blocks the host wrote. The remainder then takes ONE shape label,
  // and since a claude first call opens with a reminder, that label is the
  // host's: this installation's own iteration prompt is counted as somebody
  // else's injection, which is R-56 category 1 read as category 2.
  it('reads a bundled part block by block, so our prompt in it is ours and not the wrapper it arrived behind', () => {
    const file = 'the repository instruction file, long enough to be attributed on its own\n'.repeat(4);
    const reminder = `<system-reminder>\n${file}</system-reminder>`;
    const prompt = `${'This is a Rev loop iteration, not a summon;'} AGENTS.md's summon clause does not apply; the queue is the work. Loop iteration 7 for agent 'mason'.`;
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('bundle.jsonl', claudeWith({ system: ['preamble'], calls: [[[reminder, prompt]]] })) }),
    ], { named: { mason: source('/tmp/seat/CLAUDE.md', file) } }));

    // All three, from one part: the file by name, the wrapper as the host's,
    // the prompt as ours.
    expect(item(seat, '/tmp/seat/CLAUDE.md')).toMatchObject({ categories: ['1'], supplier: 'us', supplier_basis: 'configured_source' });
    expect(item(seat, 'the run instruction the launcher supplied')).toMatchObject({
      categories: ['1'], supplier: 'us', supplier_basis: 'launcher_shape', entry: 'launcher_prompt',
    });
    // And the host's row carries the wrapper's bytes only. Read whole it
    // carried the prompt's too, which is the defect this case pins.
    const reminders = item(seat, 'harness system reminders');
    expect(reminders.supplier).toBe('host');
    expect(reminders.bytes!.max).toBeLessThan(Buffer.byteLength(prompt, 'utf8'));
  });

  // Mutation: drop the seam split and read a codex item whole. Codex takes one
  // stdin, so the seat's composed instructions and the prompt arrive as ONE
  // item; without the cut the prompt is whatever is left over after the
  // profile matched, which is how it read before — a figure 40% light, under a
  // row that could only exist on that harness.
  it('cuts a codex item at the seam this installation itself wrote between the profile and the prompt', () => {
    const profile = 'the mason profile, long enough to be attributed on its own\n'.repeat(4);
    const prompt = "This is a Rev loop iteration, not a summon; the queue is the work. Loop iteration 7 for agent 'mason'.";
    const seat = only(inventory([
      run({
        launch_id: 'L1', provider: 'codex',
        record: write('seam.jsonl', codexWith({
          items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: `${profile}${ITERATION_PROMPT_SEAM}${prompt}` }] }],
        })),
      }),
    ], { named: { mason: source('/tmp/seat/PROFILE.md', profile) } }));

    expect(item(seat, '/tmp/seat/PROFILE.md')).toMatchObject({ categories: ['1'], supplier_basis: 'configured_source' });
    const launcher = item(seat, 'the run instruction the launcher supplied');
    expect(launcher).toMatchObject({ categories: ['1'], supplier: 'us', supplier_basis: 'launcher_shape' });
    // Its own bytes, not the chunk's leftover: the prompt measured as the
    // piece it is, which is at least the text and a little more for the
    // framing it was serialized in.
    expect(launcher.bytes!.min).toBeGreaterThanOrEqual(Buffer.byteLength(prompt, 'utf8'));
  });

  // Mutation: restore the phrase test (`/\bloop iteration\b/` over the whole
  // chunk). A doctrine chapter ABOUT loop iterations then reads as the
  // launcher's prompt — our own writing, in category 1, with a control line
  // pointing at the roster. The prompt is recognised by the opening this
  // installation composes, which `summon-trace.ts` reads records back against,
  // and nothing else is.
  it('names the launcher prompt by the opening we compose, not by a phrase a document about it also carries', () => {
    const chapter = 'A loop iteration is unattended, and the doctrine chapter about loop iterations says so at length.\n'.repeat(6);
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('chapter.jsonl', claudeWith({ system: ['preamble'], calls: [[chapter]] })) }),
    ]));

    expect(seat.items.filter((i) => i.label.includes('the run instruction the launcher supplied'))).toEqual([]);
    // Still accounted for — as a chunk nothing named, which is what it is.
    expect(seat.accounts[0]!.chunks.total).toBeGreaterThan(0);
  });

  // Mutation: push every piece's row through without folding. `firstSeen`
  // keeps one row per key per run, so three reminder blocks in one part would
  // report the FIRST block's size as the part's reminder bytes — a figure
  // smaller than the thing it names, and smaller the more the host bundles.
  it('folds the pieces of one chunk that are the same thing, so a row carries what the whole part held of it', () => {
    const blocks = ['<system-reminder>the first reminder</system-reminder>', '<system-reminder>the second, which is longer than the first</system-reminder>', '<system-reminder>and a third</system-reminder>'];
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('folded.jsonl', claudeWith({ system: ['preamble'], calls: [[blocks]] })) }),
    ]));

    const reminders = item(seat, 'harness system reminders');
    expect(reminders.bytes!.min).toBeGreaterThan(blocks.reduce((n, b) => n + Buffer.byteLength(b, 'utf8'), 0));
    // Three blocks, three hashes, none of them the item's: a folded row claims
    // no version rather than the first piece's.
    expect(reminders.versions).toEqual([]);
  });

  // Mutation: drop the truncation test from the split — `partSeams`' own
  // `p.truncated` and `segmentsFor`'s together, because each alone is covered
  // by the other and only the pair changes an answer here (the reader's own
  // half is pinned in context-query.test.ts). A later part is read under a
  // finite bound, so a bundle can arrive clipped; split anyway, its pieces are
  // classified and containment-matched as though each had been seen whole, and
  // a file that happens to sit before the cut is reported as delivered on the
  // strength of a read that stopped short of it.
  it('reads a clipped later part as one chunk, naming nothing it cannot see the end of', () => {
    const file = 'the repository instruction file, long enough to be attributed on its own\n'.repeat(4);
    // Past the bound later parts are read under, so the part arrives clipped.
    const reminder = `<system-reminder>\n${'the host reminder, repeated past the bound a later part is read under\n'.repeat(1000)}</system-reminder>`;
    const prompt = `${ITERATION_PROMPT_OPENING} the queue is the work. Loop iteration 7 for agent 'mason'.`;
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('clipped.jsonl', claudeWith({ system: ['preamble'], calls: [['the first ask'], [[reminder, file, prompt]]] })) }),
    ], { named: { mason: source('/tmp/seat/CLAUDE.md', file) } }));

    expect(seat.items.filter((i) => i.key.includes('CLAUDE.md'))).toEqual([]);
    expect(seat.items.filter((i) => i.label.includes('the run instruction the launcher supplied'))).toEqual([]);
    // Accounted for all the same, as the one thing a clipped bundle can
    // honestly be read as: whatever its text opens with.
    expect(item(seat, 'harness system reminders').bytes!.max).toBeGreaterThan(0);
  });

  // Mutation: classify each piece with the PART's type list rather than its
  // own. A claude user part carries a tool result and the host's or the
  // launcher's text together, and `tool-output` is tested on the type list
  // where `task-prompt` is tested on the text — so handing every piece the
  // part's types reads our own iteration prompt as tool traffic, which is
  // residue rather than an item, and loses the highest-control input there is
  // out of the categories entirely.
  it('classifies a piece by its own block type, so a prompt bundled with a tool result is not read as tool traffic', () => {
    const result = { type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: 'total 0' }] };
    const prompt = `${ITERATION_PROMPT_OPENING} the queue is the work. Loop iteration 9 for agent 'mason'.`;
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('mixed.jsonl', claudeWith({ system: ['preamble'], calls: [['the first ask'], [[result, prompt]]] })) }),
    ]));

    const launcher = item(seat, 'the run instruction the launcher supplied');
    expect(launcher).toMatchObject({ supplier: 'us', supplier_basis: 'launcher_shape', entry: 'launcher_prompt', categories: ['4b'] });
    // Its own block's size, which is also what says the result's bytes are not
    // in this row: they are the run's own traffic and belong in the residue.
    expect(launcher.bytes!.max).toBe(Buffer.byteLength(JSON.stringify({ type: 'text', text: prompt }), 'utf8'));
  });

  // Mutation: remove the `tool-output` shape from the table. Nothing pinned
  // that a result lands in a run's residue rather than getting an item (ward's
  // W5 on H-3858), and for a part that can be cut at its seams nothing needs
  // to: each piece is classified by its own block type, and a result with no
  // shape falls to the message-channel residue either way. The reachable case
  // is a part that CANNOT be cut — clipped past the bound a later part is read
  // under — where the type list is the only thing left to read it by. Without
  // it, the first thing the clipped text happens to open with wins, and the
  // one shape below `tool-output` is our own iteration prompt: a run's tool
  // traffic would be reported as the launcher's input, at the whole clipped
  // part's size, which is the highest-control row in the report inflated by a
  // result nobody can see the end of.
  it('reads a clipped part carrying a result as tool traffic, whatever its first block opened with', () => {
    const prompt = `${ITERATION_PROMPT_OPENING} the queue is the work. Loop iteration 31 for agent 'mason'.`;
    // Past the bound, so the part arrives clipped and has no legible seam.
    const result = { type: 'tool_result', tool_use_id: 't1', content: 'the record this run fetched, line after line\n'.repeat(2000) };
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('clipped-result.jsonl', claudeWith({ system: ['preamble'], calls: [['the first ask'], [[prompt, result]]] })) }),
    ]));

    expect(seat.items.filter((i) => i.label.includes('the run instruction the launcher supplied'))).toEqual([]);
    // Two chunks of this run are its own material: the first ask and the
    // clipped part, whose bytes are the result's and then some.
    expect(seat.accounts[0]!.chunks.residue).toBe(2);
    expect(seat.accounts[0]!.bytes.residue).toBeGreaterThan(Buffer.byteLength(JSON.stringify(result), 'utf8'));
  });

  // Mutation: drop the legacy branch of the `task-prompt` shape. A record is
  // not rewritten when the prompt is, so every run recorded before the current
  // opening was composed would read as a chunk nothing named — our own writing
  // in `unknown` instead of category 1, and silently, since the row still
  // exists under another label.
  it('recognises the opening the launcher composed before the current one', () => {
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('legacy.jsonl', claudeWith({ system: ['preamble'], calls: [["Loop iteration 12 for agent 'mason'. Working directory: /tmp/seat"]] })) }),
    ]));

    expect(item(seat, 'the run instruction the launcher supplied')).toMatchObject({
      supplier: 'us', supplier_basis: 'launcher_shape', entry: 'launcher_prompt', categories: ['1'],
    });
  });

  // Mutation: give every basis a control line, or leave the field off. A
  // control invented for the host's own preamble sends an operator to a
  // setting that does not exist; `null` is the honest reading, and the
  // report's gap list says it means none is RECORDED rather than none is
  // possible.
  it('carries a control line only where this installation has one', () => {
    const profile = 'the seat profile\n'.repeat(40);
    const seat = only(inventory([
      run({ launch_id: 'L1', record: write('ctl.jsonl', claudeWith({ system: [`You are Claude Code, the host preamble\n${profile}`], calls: [['the ask']] })) }),
    ], { named: { mason: source('/tmp/seat/PROFILE.md', profile) }, servers: { mason: ['helmo'] } }));

    expect(item(seat, '/tmp/seat/PROFILE.md').control).toContain('`constitution`');
    expect(item(seat, 'tool Bash').control).toBeNull();
    expect(item(seat, "the host CLI's own preamble").control).toBeNull();
  });
});

describe('what the run fetched, as a frequency row of its own', () => {
  const claudeFetching = (over: { session: string; calls: { tool: string; input: unknown; out: string }[][] }): unknown[] => {
    const sessionId = over.session;
    const entries: unknown[] = [{
      type: 'api-request-shape', sessionId, shapeHash: 'shape0', timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
      shape: { system: [{ type: 'text', text: 'preamble' }], tools: [{ name: 'Bash', description: 'run a command' }] },
    }];
    const tail: string[] = [];
    over.calls.forEach((call, i) => {
      const ask = `q${i}`;
      const got = `a${i}`;
      entries.push({
        type: 'api-request-blob', sessionId, hash: ask,
        message: { role: 'assistant', content: call.map((c, j) => ({ type: 'tool_use', id: `t${i}_${j}`, name: c.tool, input: c.input })) },
      });
      entries.push({
        type: 'api-request-blob', sessionId, hash: got,
        message: { role: 'user', content: call.map((c, j) => ({ type: 'tool_result', tool_use_id: `t${i}_${j}`, content: c.out })) },
      });
      tail.push(ask, got);
      entries.push({
        type: 'api-request', sessionId, id: `r${i}`, timestamp: `2026-10-29T08:00:0${i + 1}.000Z`,
        version: '2.1.300', shapeHash: 'shape0', cwd: '/tmp/seat', params: { model: 'claude-opus-5' },
        ...(i === 0 ? {} : { base: `r${i - 1}` }), keep: i * 2, tail: tail.slice(i * 2),
      });
    });
    return entries;
  };
  const fetchingRun = (launch: string, calls: { tool: string; input: unknown; out: string }[][]): InventoryRun =>
    run({ launch_id: launch, calls: calls.length, record: write(`${launch}-freq.jsonl`, claudeFetching({ session: `bbbbbbbb-1111-2222-3333-44444444444${launch.slice(-1)}`, calls })) });

  const read = (text: string) => ({ tool: 'Read', input: { file_path: '/tmp/seat/MEMORY.md' }, out: text });

  // Mutation: fold acquisitions with the first-sighting rule the configured
  // items use, so a run lands in `preload` or in `later` and never both.
  // That rule is right for a profile — composed into every request of the run
  // and loaded once — and wrong for a fetch, which the ticket says in as many
  // words: "an input loaded at startup and read again later can appear in
  // both measures; carrying old content across requests is not a new read."
  it('counts a fetch as an arrival, so one run can be both preload and later', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[read('the memory index')], [read('the memory index, read again')]]),
    ], { acquired: true }));

    const row = item(seat, '/tmp/seat/MEMORY.md');
    expect(row.channel).toBe('acquired');
    expect(row).toMatchObject({ categories: ['3'], entry: 'agent_tool_call', entry_trigger: 'a Read call', preload_runs: 1, later_runs: 1, any_runs: 1, arrivals: 2 });
    // The run is ONE run in the denominator however many times it fetched.
    expect(row.bounds).toEqual({ low: 1, high: 1, of: 1 });
  });

  // Mutation: leave a refused run out of the acquired channel's unknown set.
  // Its bounds would then read as an exact figure over the runs that happened
  // to parse — the failure the whole report is shaped against — and a run
  // that fetched plenty would be indistinguishable from one that fetched
  // nothing.
  it('widens an acquired row for a run whose own evolution refused', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[read('the memory index')]]),
      // A record the population joined and that is not there to read by the
      // time the report runs — the host pruned it between the two. The state
      // is `read` because the join found it; the read is what refuses.
      run({ launch_id: 'L2', calls: 1, record: join(dir, 'pruned-before-the-read.jsonl') }),
    ], { acquired: true }));

    const row = item(seat, '/tmp/seat/MEMORY.md');
    expect(row.unknown_runs).toBe(1);
    expect(row.bounds).toEqual({ low: 1, high: 2, of: 2 });
    expect(row.share).toBeNull();
    expect(seat.acquired!.runs_refused).toHaveLength(1);
  });

  // Mutation: claim a supplier for every acquisition from its kind — a file
  // is ours, a command is ours because our agent ran it. The join names a
  // SOURCE; it does not read that source's author, and the two facts it can
  // state are that a Helmo ticket came out of this installation's own store
  // and that a path on the seat's configured source list is a file we wrote.
  it('claims an acquisition is ours only where the source itself says so', () => {
    const seat = only(inventory([
      fetchingRun('L1', [[
        read('the memory index'),
        { tool: 'mcp__helmo__helmo_get_ticket', input: { ticket_id: 'H-3818' }, out: 'the ticket body' },
        { tool: 'Bash', input: { command: 'uname -a' }, out: 'Darwin' },
      ]]),
      // The path is on the seat's configured source list; its CONTENT is
      // deliberately not what the run fetched, so the acquired row is the only
      // row for it and the test is about the source list and nothing else.
    ], { acquired: true, named: { mason: source('/tmp/seat/MEMORY.md', 'a body nothing in this run carried, long enough not to be a token\n'.repeat(20)) } }));

    // A path on the seat's own configured source list.
    expect(item(seat, 'file /tmp/seat/MEMORY.md').supplier).toBe('us');
    // This installation's own record store.
    expect(item(seat, 'ticket H-3818').supplier).toBe('us');
    // Whatever that command printed. Never claimed.
    expect(item(seat, 'command uname -a').supplier).toBe('unknown');
  });

  // Mutation: claim every `file` kind as ours. A path is ours because it is ON
  // the seat's configured source list, not because it is a path — the fetch
  // above reads a file the list DOES carry, so that case alone stays green
  // under this mutation and the rule reads as "a file is ours". Ward and proof
  // both found this gap on H-3844 by mutating the reader, and both confirmed
  // the code was already right; this is the assertion that was missing.
  it('claims a fetched file only when the seat configures that path, not because it is a file', () => {
    const seat = only(inventory([
      fetchingRun('L2', [[
        read('the memory index'),
        { tool: 'Read', input: { file_path: '/tmp/elsewhere/NOTES.md' }, out: 'somebody else\'s file' },
      ]]),
    ], { acquired: true, named: { mason: source('/tmp/seat/MEMORY.md', 'a body nothing in this run carried, long enough not to be a token\n'.repeat(20)) } }));

    expect(item(seat, 'file /tmp/seat/MEMORY.md').supplier).toBe('us');
    // The same tool, the same kind, a path this installation configures for
    // nobody. The join read a name; it did not read that file's author.
    expect(item(seat, 'file /tmp/elsewhere/NOTES.md').supplier).toBe('unknown');
  });
});
