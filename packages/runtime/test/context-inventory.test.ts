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
  inventory, cohortRuns, renderInventory, contextInventory,
  type InventoryRun, type NamedSource, type SeatInventory,
} from '../src/context-inventory.js';

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
const claudeWith = (over: { system: string[]; calls: string[][]; session?: string; tools?: string[] }): unknown[] => {
  const sessionId = over.session ?? 'aaaaaaaa-1111-2222-3333-444444444444';
  const texts = over.calls.flat();
  const shape = {
    type: 'api-request-shape', sessionId, shapeHash: 'shape0', timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
    shape: {
      system: over.system.map((text) => ({ type: 'text', text })),
      tools: (over.tools ?? ['Bash']).map((name) => ({ name, description: `the ${name} tool` })),
    },
  };
  const blobs = texts.map((text, i) => ({
    type: 'api-request-blob', sessionId, hash: `m${i}`,
    message: { role: 'user', content: [{ type: 'text', text }] },
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
  return [shape, ...blobs, ...requests];
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
});
