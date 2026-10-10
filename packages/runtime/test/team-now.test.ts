/* The condensed roster behind Overview's Team now card (H-3091).
 *
 * Two halves, because there are two ways this can be wrong. The projection can
 * map or rank a state badly — that is `displayState`, `rankOf` and `teamNow`,
 * tested as values. Or the reading itself can be wrong: a state word Rev
 * returns that nothing maps, or a reason the sentinel does not actually carry.
 * That half is tested against a real installation directory, because a fixture
 * restating the sentinel formats would pass while the formats moved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { displayState, rankOf, teamNow, type SessionReading } from '../src/team-now.js';

const reading = (partial: Partial<SessionReading> & { source_state: string }): SessionReading => ({
  session: partial.session ?? partial.agent ?? 'worker',
  agent: partial.agent ?? partial.session ?? 'worker',
  workstream: 'fixture',
  detail: null,
  ...partial,
});

describe('the state words this build can read', () => {
  /* Derived from `state()` in view.ts rather than restated here. A new sentinel
     with a new state word is exactly the change this must fail on, and a list
     written out in this file would agree with itself forever. */
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'view.ts'), 'utf8');
  const body = source.slice(source.indexOf('function state(name: string)'));
  const words = [...new Set([...body.slice(0, body.indexOf('\n}')).matchAll(/return '([^']+)'/g)].map((m) => m[1]!))];

  it('finds every state Rev can report', () => {
    // The count is re-derived, not asserted as a number: this is the guard
    // against a regex that quietly stopped matching and left the loop below
    // iterating over nothing.
    expect(words.length).toBeGreaterThanOrEqual(13);
    expect(words).toContain('RUNNING');
    expect(words).toContain('halted');
  });

  it('maps all of them, and reports an unmapped word as unknown rather than stopped', () => {
    for (const word of words) {
      // UNKNOWN is the one state whose display state IS unknown; every other
      // word must map to something, or this build is quietly calling a state
      // it has never heard of a deliberate stop.
      if (word === 'UNKNOWN') expect(displayState(word)).toBe('unknown');
      else expect(displayState(word), `${word} has no display state`).not.toBe('unknown');
    }
    expect(displayState('DRAINING')).toBe('unknown');
    // The prototype chain is not a mapping (H-3004).
    expect(displayState('constructor')).toBe('unknown');
    expect(displayState('__proto__')).toBe('unknown');
  });

  it('keeps the four distinctions the card exists to make', () => {
    expect(displayState('RUNNING')).toBe('working');
    expect(displayState('IDLE')).toBe('awaiting');
    expect(displayState('SEAT_HELD')).toBe('awaiting');
    expect(displayState('BLOCKED')).toBe('blocked');
    expect(displayState('LIMIT')).toBe('blocked');
    expect(displayState('BACKOFF')).toBe('failed');
    expect(displayState('STOP')).toBe('stopped');
    expect(displayState('HOLD')).toBe('stopped');
    expect(displayState('PARKED')).toBe('stopped');
    expect(displayState('halted')).toBe('stopped');
    expect(displayState('WEDGED')).toBe('failed');
    expect(displayState('CRASHED')).toBe('failed');
  });
});

describe('rolling several sessions up to one agent', () => {
  const AS_OF = '2026-10-10T18:00:00.000Z';

  it('keeps one entry per agent, in roster order, with every session under it', () => {
    const data = teamNow([
      reading({ session: 'mason', agent: 'mason', source_state: 'RUNNING' }),
      reading({ session: 'ward', agent: 'ward', source_state: 'IDLE' }),
      reading({ session: 'mason-2', agent: 'mason', source_state: 'IDLE' }),
    ], {}, AS_OF);
    expect(data.agents.map((a) => a.agent)).toEqual(['mason', 'ward']);
    expect(data.agents[0]!.sessions.map((s) => s.session)).toEqual(['mason', 'mason-2']);
    expect(data.as_of).toBe(AS_OF);
  });

  it('reports the most significant state, not the most convenient one', () => {
    const worst = (states: string[]) => teamNow(
      states.map((source_state, i) => reading({ session: `w${i}`, agent: 'seat', source_state })),
      {}, AS_OF,
    ).agents[0]!;
    expect(worst(['RUNNING', 'WEDGED']).state).toBe('failed');
    expect(worst(['RUNNING', 'BLOCKED']).state).toBe('blocked');
    expect(worst(['WEDGED', 'BLOCKED']).state).toBe('failed');
    expect(worst(['IDLE', 'RUNNING']).state).toBe('working');
    expect(worst(['STOP', 'IDLE']).state).toBe('awaiting');
    // An unreadable session is not covered by a healthy sibling.
    expect(worst(['RUNNING', 'UNKNOWN']).state).toBe('unknown');
    expect(worst(['BLOCKED', 'UNKNOWN']).state).toBe('blocked');
  });

  it('takes the chip’s reason from the session the chip is about', () => {
    const agent = teamNow([
      reading({ session: 'a', agent: 'seat', source_state: 'RUNNING', detail: 'running normally' }),
      reading({ session: 'b', agent: 'seat', source_state: 'BLOCKED', detail: 'cannot reach the store' }),
    ], {}, AS_OF).agents[0]!;
    expect(agent.state).toBe('blocked');
    expect(agent.source_state).toBe('BLOCKED');
    expect(agent.detail).toBe('cannot reach the store');
    // And the session that is fine is still listed, so the roll-up is readable.
    expect(agent.sessions.map((s) => s.state)).toEqual(['working', 'blocked']);
  });

  it('ranks the six states in severity order', () => {
    const order = (['failed', 'blocked', 'unknown', 'working', 'awaiting', 'stopped'] as const).map(rankOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((n) => n >= 0)).toBe(true);
  });

  it('attaches the tickets a seat holds, and nothing from the prototype chain', () => {
    const data = teamNow([
      reading({ agent: 'mason', source_state: 'RUNNING' }),
      reading({ agent: 'ward', source_state: 'IDLE' }),
      reading({ agent: 'constructor', source_state: 'IDLE' }),
    ], { mason: [{ id: 'H-1', title: 'A claim' }] }, AS_OF);
    expect(data.agents[0]!.work).toEqual([{ id: 'H-1', title: 'A claim' }]);
    expect(data.agents[1]!.work).toEqual([]);
    expect(data.agents[2]!.work).toEqual([]);
  });
});

/* The reading itself, against a real installation directory. Everything here is
   a sentinel written the way its writer in this repo writes it, so a changed
   format fails this rather than silently losing a reason. */
describe('reading a real installation', () => {
  let home: string;
  let snapshot: (work?: Record<string, { id: string; title: string }[]>) => {
    as_of: string;
    agents: { agent: string; state: string; source_state: string; detail: string | null; sessions: { session: string; source_state: string }[]; work: { id: string }[] }[];
    unavailable?: string;
  };

  const seat = (name: string, extra: string[] = []) => [
    `[loops.${name}]`,
    'workstream = "fixture"',
    // Its own cwd: two sessions of one seat may never share a writable
    // checkout, and the roster refuses to load if they do (config.ts).
    `cwd = ${JSON.stringify(join(home, 'trees', name))}`,
    'runtime = "claude"',
    'model = "fixture-model"',
    'constitution = "constitutions/fixture.md"',
    ...extra,
    '',
  ];

  const state = (name: string, files: Record<string, string>) => {
    mkdirSync(join(home, 'state', name), { recursive: true });
    for (const [file, content] of Object.entries(files)) writeFileSync(join(home, 'state', name, file), content);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'team-now-'));
    mkdirSync(join(home, 'constitutions'));
    mkdirSync(join(home, 'trees'));
    writeFileSync(join(home, 'constitutions/fixture.md'), 'A fixture seat.');
    writeFileSync(join(home, 'roster.toml'), [
      '[global]',
      'helmo_cli = "/path/to/helmo/packages/work/dist/cli.js"',
      'helmo_mcp_server = "/path/to/helmo/packages/work/dist/server.js"',
      '',
      ...seat('runner'),
      ...seat('idler'),
      ...seat('held'),
      ...seat('stuck'),
      ...seat('limited'),
      ...seat('backed-off'),
      ...seat('wedged'),
      ...seat('crashed'),
      ...seat('stopped'),
      ...seat('on-hold'),
      ...seat('parked'),
      ...seat('never-started'),
      // Two sessions, one seat: the pool form the roll-up exists for.
      ...seat('pair'),
      ...seat('pair-2', ['seat = "pair"', 'tickets = ["H-9"]']),
      '',
    ].join('\n'));

    const live = String(process.pid);
    const dead = '2147483646'; // an unused pid: process.kill rejects it as gone
    state('runner', { RUNNING: `${live}\n` });
    state('idler', { RUNNING: `${live}\n`, IDLE: '4201\nno executable work is owned by this seat\n' });
    state('held', { RUNNING: `${live}\n`, SEAT_HELD: 'another session holds this seat\n' });
    state('stuck', {
      BLOCKED: 'reason=the sentinel line nobody reads\n',
      'BLOCKED.json': JSON.stringify({ reason: 'two consecutive failures', investigation_ticket: 'H-77' }),
    });
    state('limited', { RUNNING: `${live}\n`, LIMIT: 'kind=capacity\nretry_s=900\nreason=the provider refused on capacity\n' });
    state('backed-off', { BACKOFF: 'attempt=3\nretry_at=2026-10-10T18:30:00.000Z\n' });
    state('wedged', { RUNNING: `${live}\n`, WEDGED: 'cannot reach Helm\nat=2026-10-10T17:00:00.000Z\n' });
    state('crashed', { RUNNING: `${dead}\n` });
    state('stopped', {});
    state('on-hold', { HOLD: 'the operator is reworking this seat\n' });
    state('parked', { RUNNING: `${live}\n`, PARKED: '2026-10-10T17:00:00.000Z' });
    state('pair', { RUNNING: `${live}\n` });
    state('pair-2', { RUNNING: `${live}\n`, WEDGED: 'the second worker cannot reach Helm\n' });

    process.env['REV_HOME'] = home;
    /* The two owned controls are written by their own writer rather than by a
       string in this file. `rev stop` and `rev pace park` both record who
       asked, when, and why in a format `sOwner` parses, and a fixture restating
       that format would keep passing after the format moved. */
    const { sSetOwned } = await import('../src/sentinels.js');
    const owner = { by: 'human', at: '2026-10-10T17:00:00.000Z', pid: 0, expires_at: 'never' };
    sSetOwned('stopped', 'STOP', { ...owner, value: '', reason: 'rev stop stopped' });
    sSetOwned('parked', 'PACE', { ...owner, value: 'park', reason: 'holding the fleet for a release' });
    const view = await import('../src/view.js');
    snapshot = view.teamNowSnapshot as typeof snapshot;
  });

  afterAll(() => {
    delete process.env['REV_HOME'];
    rmSync(home, { recursive: true, force: true });
  });

  const find = (name: string) => {
    const data = snapshot();
    // A roster the fixture wrote badly would otherwise read as every agent
    // being absent, one confusing failure per assertion below.
    expect(data.unavailable).toBeUndefined();
    const agent = data.agents.find((a) => a.agent === name);
    if (!agent) throw new Error(`no agent '${name}' in the reading`);
    return agent;
  };

  it('reads each state from the sentinel its writer wrote', () => {
    expect([find('runner').source_state, find('runner').state]).toEqual(['RUNNING', 'working']);
    expect([find('idler').source_state, find('idler').state]).toEqual(['IDLE', 'awaiting']);
    expect([find('held').source_state, find('held').state]).toEqual(['SEAT_HELD', 'awaiting']);
    expect([find('stuck').source_state, find('stuck').state]).toEqual(['BLOCKED', 'blocked']);
    expect([find('limited').source_state, find('limited').state]).toEqual(['LIMIT', 'blocked']);
    expect([find('backed-off').source_state, find('backed-off').state]).toEqual(['BACKOFF', 'failed']);
    expect([find('wedged').source_state, find('wedged').state]).toEqual(['WEDGED', 'failed']);
    expect([find('crashed').source_state, find('crashed').state]).toEqual(['CRASHED', 'failed']);
    expect([find('stopped').source_state, find('stopped').state]).toEqual(['STOP', 'stopped']);
    expect([find('on-hold').source_state, find('on-hold').state]).toEqual(['HOLD', 'stopped']);
    expect([find('parked').source_state, find('parked').state]).toEqual(['PARKED', 'stopped']);
    // The one that matters most: nothing running, nothing recorded. It is
    // stopped because Rev says halted, never "idle because no process answered".
    expect([find('never-started').source_state, find('never-started').state]).toEqual(['halted', 'stopped']);
  });

  it('carries the reason each state actually records', () => {
    expect(find('idler').detail).toBe('no executable work is owned by this seat');
    expect(find('held').detail).toBe('another session holds this seat');
    // The JSON detail, which is the one a reader needs, over the sentinel line.
    expect(find('stuck').detail).toBe('two consecutive failures — H-77');
    expect(find('limited').detail).toBe('the provider refused on capacity — retrying in 900s');
    expect(find('backed-off').detail).toBe('restart attempt 3 — next at 2026-10-10T18:30:00.000Z');
    expect(find('wedged').detail).toBe('cannot reach Helm');
    expect(find('stopped').detail).toBe('by human: rev stop stopped');
    expect(find('on-hold').detail).toBe('the operator is reworking this seat');
    // A park's reason is on the PACE command, not on the acknowledgement.
    expect(find('parked').detail).toBe('by human: holding the fleet for a release');
    expect(find('crashed').detail).toMatch(/pid 2147483646\) is gone/);
    // Nothing recorded stays nothing: the card says so rather than inventing it.
    expect(find('runner').detail).toBeNull();
    expect(find('never-started').detail).toBeNull();
  });

  it('rolls two sessions of one seat into one entry at the worse state', () => {
    const pair = find('pair');
    expect(pair.sessions.map((s) => s.session)).toEqual(['pair', 'pair-2']);
    expect(pair.state).toBe('failed');
    expect(pair.detail).toBe('the second worker cannot reach Helm');
    // And the healthy session is still visible under it.
    expect(pair.sessions.map((s) => s.source_state)).toEqual(['RUNNING', 'WEDGED']);
    // One entry, not two: the pool worker is not its own agent.
    expect(snapshot().agents.filter((a) => a.agent.startsWith('pair'))).toHaveLength(1);
  });

  it('attaches what each seat holds, by seat and not by session', () => {
    const data = snapshot({ pair: [{ id: 'H-9', title: 'Held by the pool' }] });
    expect(data.agents.find((a) => a.agent === 'pair')!.work.map((w) => w.id)).toEqual(['H-9']);
  });

  it('says a roster it cannot read is unreadable, never an empty team', () => {
    writeFileSync(join(home, 'roster.toml'), 'this is not toml [[[\n');
    const data = snapshot();
    expect(data.agents).toEqual([]);
    expect(data.unavailable).toBeTruthy();
    expect(data.as_of).toBeTruthy();
  });
});
