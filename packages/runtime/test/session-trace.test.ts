import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTicketIdentity, readTicketLaunches, sessionTrace } from '../src/session-trace.js';
import { Store } from '../../work/src/store.js';
import { ticketHistory } from '../src/helm.js';

const ticket = {
  installation: { label: 'fixture.personal' }, id: 'H-7', status: 'in_progress', assignee: 'mason', action: null,
  deps: { outgoing: [] }, blockers: [],
  events: [{ seq: 9, ts: '2026-10-05T00:00:03.000Z', event_type: 'updated', actor: { generation: 'rev:mason:1' } }],
};

describe('session trace diagnostic', () => {
  it('joins only by the durable launch identity and keeps content out', () => {
    const result = sessionTrace(ticket, [{
      format: 1, phase: 'complete', launch_id: 'rev:mason:1', ticket_id: 'H-7', intent_at: '2026-10-05T00:00:00.000Z',
      completed_at: '2026-10-05T00:00:04.000Z', session: { provider: 'codex', model: 'fixture', provider_session_id: 'thread-1', provider_session_id_state: 'observed', started_at: '2026-10-05T00:00:01.000Z', ended_at: '2026-10-05T00:00:02.000Z', outcome: 'ok', tokens: 0, cost_usd: 0 },
    }], 0) as any;
    expect(result.content).toBe('excluded');
    expect(result.ticket.value).toBe('H-7@fixture.personal');
    expect(result.launches[0].work_event.value).toEqual({ seq: 9, type: 'updated', at: '2026-10-05T00:00:03.000Z' });
    expect(result.launches[0].usage.state).toBe('measured_zero');
    expect(JSON.stringify(result)).not.toContain('thread transcript');
  });

  it('names the owner of an open dependency as the next actor', () => {
    const result = sessionTrace({
      ...ticket,
      deps: { outgoing: [{ type: 'blocks', to_id: 'H-8' }] },
      blockers: [{ id: 'H-8', assignee: 'proof', needs_human: false }],
    }, [], 0) as any;
    expect(result.next_owner.value).toEqual([{ ticket: 'H-8', owner: 'proof' }]);
    expect(result.wait_reason.value).toBe('dependency_blocked');
  });

  it('separates unsupported, not observed and malformed states', () => {
    const result = sessionTrace({ ...ticket, events: [] }, [{ format: 1, phase: 'dispatching', launch_id: 'rev:mason:2', ticket_id: 'H-7', intent_at: '2026-10-05T00:00:00.000Z' }], 2) as any;
    expect(result.launches[0].provider.state).toBe('not_observed');
    expect(result.launches[0].source_revision.state).toBe('unsupported');
    expect(result.malformed_launch_records).toMatchObject({ state: 'malformed/refused', value: 2 });
  });

  it('refuses malformed nested values and incomplete complete records', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-'));
    process.env.REV_HOME = home;
    const launches = join(home, 'state', 'alpha', 'launches');
    mkdirSync(launches, { recursive: true });
    const base = { format: 1, phase: 'complete', launch_id: 'rev:alpha:1', ticket_id: 'H-7', intent_at: '2026-10-05T00:00:00.000Z', completed_at: '2026-10-05T00:00:01.000Z' };
    writeFileSync(join(launches, 'bad-values.json'), JSON.stringify({ ...base, session: {
      provider: { prompt: 'private' }, model: 'fixture', provider_session_id_state: 'unsupported',
      started_at: '2026-10-05T00:00:00.000Z', ended_at: '2026-10-05T00:00:01.000Z', outcome: 'ok', tokens: { credential: 'private' }, cost_usd: 0,
    }}));
    writeFileSync(join(launches, 'incomplete.json'), JSON.stringify({ format: 1, phase: 'complete', launch_id: 'rev:alpha:2' }));
    const result = readTicketLaunches(['alpha'], 'H-7');
    expect(result.launches).toEqual([]);
    expect(result.malformed).toBe(2);
  });

  it('enforces closed session values and retains a pre-dispatch quarantine', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-'));
    process.env.REV_HOME = home;
    const launches = join(home, 'state', 'alpha', 'launches');
    mkdirSync(launches, { recursive: true });
    const base = { format: 1, phase: 'complete', ticket_id: 'H-7', intent_at: '2026-10-05T00:00:00.000Z', completed_at: '2026-10-05T00:00:01.000Z' };
    const session = { provider: 'codex', model: 'gpt-test', provider_session_id_state: 'unsupported', started_at: base.intent_at, ended_at: base.completed_at, outcome: 'ok', tokens: 0, cost_usd: 0 };
    writeFileSync(join(launches, 'provider.json'), JSON.stringify({ ...base, launch_id: 'rev:alpha:1', session: { ...session, provider: 'SYNTHETIC PRIVATE PROMPT' } }));
    writeFileSync(join(launches, 'outcome.json'), JSON.stringify({ ...base, launch_id: 'rev:alpha:2', session: { ...session, outcome: ['ok'] } }));
    writeFileSync(join(launches, 'quarantine.json'), JSON.stringify({ format: 1, phase: 'quarantined', launch_id: 'rev:alpha:3', ticket_id: 'H-7', claim: true, intent_at: base.intent_at, quarantined_at: base.completed_at }));
    const result = readTicketLaunches(['alpha'], 'H-7');
    expect(result.malformed).toBe(2);
    expect(result.launches).toEqual([expect.objectContaining({ phase: 'quarantined', launch_id: 'rev:alpha:3' })]);
    expect(result.launches[0]).not.toHaveProperty('session');
  });

  it('refuses a completed dispatched launch with no session result', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-dispatched-'));
    process.env.REV_HOME = home;
    const launches = join(home, 'state', 'alpha', 'launches');
    mkdirSync(launches, { recursive: true });
    writeFileSync(join(launches, 'lost.json'), JSON.stringify({
      format: 1, phase: 'complete', launch_id: 'rev:alpha:lost', intent_at: '2026-10-05T00:00:00.000Z',
      dispatching_at: '2026-10-05T00:00:00.100Z', completed_at: '2026-10-05T00:00:01.000Z',
      touched_tickets: [{ id: 'H-7', events: 1 }], event_seq_floor: 4,
    }));
    expect(readTicketLaunches(['alpha'], 'H-7')).toEqual({ launches: [], malformed: 1 });
  });

  it('joins a scoped seat\'s real launch by its measured window and labels the basis', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-scoped-'));
    process.env.REV_HOME = home;
    const launches = join(home, 'state', 'mason', 'launches');
    mkdirSync(launches, { recursive: true });
    // The live shape: a scoped seat journals no ticket_id and its Work events
    // carry no generation, so only the measured window names the ticket.
    const live = {
      format: 1, phase: 'complete', launch_id: 'rev:mason:64302:1:1791258882828',
      intent_at: '2026-10-06T03:54:45.229Z', dispatching_at: '2026-10-06T03:54:45.242Z',
      completed_at: '2026-10-06T03:55:13.637Z',
      touched_tickets: [{ id: 'H-7', events: 3 }],
      session: {
        provider: 'codex', model: 'gpt-5.6-luna', provider_session_id: '01a10f59-7dcc-7732-8273-40bedc6fbc10',
        provider_session_id_state: 'observed', started_at: '2026-10-06T03:54:45.258Z',
        ended_at: '2026-10-06T03:55:13.625Z', outcome: 'ok', tokens: 183351, cost_usd: 0.011784,
      },
    };
    writeFileSync(join(launches, 'scoped.json'), JSON.stringify(live));
    const read = readTicketLaunches(['mason'], 'H-7');
    expect(read.malformed).toBe(0);
    expect(read.launches).toHaveLength(1);
    const result = sessionTrace({ ...ticket, events: [] }, read.launches, read.malformed) as any;
    expect(result.malformed_launch_records).toMatchObject({ state: 'measured_zero', value: 0 });
    expect(result.launches[0].join).toMatchObject({
      state: 'observed', value: { basis: 'seat_session_event_window', ticket_events: 3 },
      source: 'runtime:launch-journal:touched_tickets',
    });
    // A measured window is not the launch's own key, so the Work event it
    // would have named stays not observed rather than being guessed.
    expect(result.launches[0].work_event.state).toBe('not_observed');
    expect(result.launches[0].provider.value).toBe('codex');
    expect(readTicketLaunches(['mason'], 'H-8').launches).toEqual([]);
  });

  it('calls a pool launch\'s own ticket identity an exact claim join', () => {
    const result = sessionTrace(ticket, [{
      format: 1, phase: 'complete', launch_id: 'rev:mason:1', ticket_id: 'H-7', intent_at: '2026-10-05T00:00:00.000Z',
      completed_at: '2026-10-05T00:00:04.000Z', session: { provider: 'codex', model: 'fixture', provider_session_id_state: 'unsupported', started_at: '2026-10-05T00:00:01.000Z', ended_at: '2026-10-05T00:00:02.000Z', outcome: 'ok' },
    }], 0) as any;
    expect(result.launches[0].join).toMatchObject({
      state: 'observed', value: { basis: 'launch_claim_identity', ticket_events: null },
      source: 'runtime:launch-journal:ticket_id',
    });
  });

  it('accepts a settled launch that claimed nothing, and still holds an admitted one to its ticket', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-settled-'));
    process.env.REV_HOME = home;
    const launches = join(home, 'state', 'alpha', 'launches');
    mkdirSync(launches, { recursive: true });
    // Nothing was claimed, so this completes with neither ticket nor session.
    writeFileSync(join(launches, 'nothing-claimed.json'), JSON.stringify({
      format: 1, phase: 'complete', launch_id: 'rev:alpha:1', claim: true,
      intent_at: '2026-10-05T00:00:00.000Z', completed_at: '2026-10-05T00:00:01.000Z',
    }));
    // A workflow admission is granted for one ticket; losing it IS corruption.
    writeFileSync(join(launches, 'admitted-no-ticket.json'), JSON.stringify({
      format: 1, phase: 'complete', launch_id: 'rev:alpha:2', admission_id: 'adm-1',
      intent_at: '2026-10-05T00:00:00.000Z', completed_at: '2026-10-05T00:00:01.000Z',
    }));
    const read = readTicketLaunches(['alpha'], 'H-7');
    expect(read.malformed).toBe(1);
    expect(read.launches).toEqual([]);
  });

  it('refuses a measured window carrying anything but ticket ids and counts', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-touched-'));
    process.env.REV_HOME = home;
    const launches = join(home, 'state', 'alpha', 'launches');
    mkdirSync(launches, { recursive: true });
    const base = {
      format: 1, phase: 'complete', launch_id: 'rev:alpha:1',
      intent_at: '2026-10-05T00:00:00.000Z', completed_at: '2026-10-05T00:00:01.000Z',
    };
    for (const [name, touched] of [
      ['content.json', [{ id: 'H-7', events: 1, note: 'SYNTHETIC_PRIVATE_PROMPT' }]],
      ['value.json', [{ id: 'H-7', events: { credential: 'SYNTHETIC_PRIVATE_VALUE' } }]],
      ['id.json', [{ id: 'SYNTHETIC_PRIVATE_PATH', events: 1 }]],
      ['shape.json', { 'H-7': 1 }],
    ] as [string, unknown][]) {
      writeFileSync(join(launches, name), JSON.stringify({ ...base, launch_id: `rev:alpha:${name}:1:1`, touched_tickets: touched }));
    }
    const read = readTicketLaunches(['alpha'], 'H-7');
    expect(read.malformed).toBe(4);
    expect(read.launches).toEqual([]);
    const trace = JSON.stringify(sessionTrace({ ...ticket, events: [] }, read.launches, read.malformed));
    expect(trace).not.toContain('SYNTHETIC_PRIVATE_');
    expect(trace).toContain('"malformed/refused"');
  });

  it('refuses malformed Work metadata instead of rendering nested content', () => {
    expect(() => sessionTrace({
      ...ticket,
      events: [{ seq: 9, ts: { credential: 'private' }, event_type: { prompt: 'private' }, actor: { generation: 'rev:mason:1' } }],
    }, [], 0)).toThrow('malformed ticket event');
    expect(() => sessionTrace({
      ...ticket,
      blockers: [{ id: { prompt: 'private' }, assignee: { credential: 'private' }, needs_human: false }],
    }, [], 0)).toThrow('malformed blocker');
  });

  it('refuses a returned ticket outside the requested identity', () => {
    expect(() => assertTicketIdentity(ticket, 'H-8@fixture.personal')).toThrow('mismatched ticket history');
    expect(() => assertTicketIdentity({ ...ticket, installation: { label: 'other.personal' } }, 'H-7@fixture.personal')).toThrow('mismatched ticket history');
    expect(() => assertTicketIdentity(ticket, 'H-7@fixture.personal')).not.toThrow();
  });

  it('keeps startup and response-identity refusals content-free on both streams', () => {
    const repo = join(import.meta.dirname, '..', '..', '..');
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-cli-'));
    const fake = join(home, 'fake-work.cjs');
    mkdirSync(join(home, 'state', 'alpha', 'launches'), { recursive: true });
    writeFileSync(join(home, 'roster.toml'), `[global]\nhelmo_cli = "${fake}"\nhelmo_mcp_server = "${fake}"\n[loops.alpha]\nworkstream = "test"\ncwd = "${home}"\nruntime = "mock"\n`);
    writeFileSync(fake, `console.log(${JSON.stringify(JSON.stringify({ ...ticket, id: 'H-8' }))})`);
    const env = { ...process.env, REV_HOME: home };
    for (const key of Object.keys(env)) if (/^(HELMO|ROADMAP|REV|INSTALLATION)_/.test(key) && key !== 'REV_HOME') delete env[key];
    const invoke = (args = ['trace', 'H-7@fixture.personal'], extraEnv = {}) => spawnSync(process.execPath, [
      '--import', join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      join(repo, 'packages', 'runtime', 'src', 'cli.ts'), ...args,
    ], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    const mismatch = invoke();
    expect(mismatch).toMatchObject({ status: 1, stdout: '', stderr: 'trace refused: diagnostic unavailable\n' });
    writeFileSync(join(home, 'roster.toml'), 'SYNTHETIC_PRIVATE_ROSTER = [invalid');
    const malformed = invoke();
    expect(malformed).toMatchObject({ status: 1, stdout: '', stderr: 'trace refused: diagnostic unavailable\n' });
    expect(malformed.stderr).not.toContain('SYNTHETIC_PRIVATE_ROSTER');
    expect(malformed.stderr).not.toContain(home);
    const asserted = invoke(['trace', 'H-7@fixture.personal', '--installation', 'SYNTHETIC_PRIVATE_INSTALLATION']);
    expect(asserted).toMatchObject({ status: 1, stdout: '', stderr: 'trace refused: diagnostic unavailable\n' });
    expect(asserted.stderr).not.toContain(home);
    const release = join(home, 'release.json');
    writeFileSync(release, 'SYNTHETIC_PRIVATE_RELEASE');
    const malformedRelease = invoke(undefined, { INSTALLATION_RELEASE: release });
    expect(malformedRelease).toMatchObject({ status: 1, stdout: '', stderr: 'trace refused: diagnostic unavailable\n' });
    expect(malformedRelease.stderr).not.toContain(home);
  });

  it('traces a real Work history larger than the failed 6.2 MB case through Runtime\'s Work CLI path', () => {
    const repo = join(import.meta.dirname, '..', '..', '..');
    const home = mkdtempSync(join(tmpdir(), 'rev-trace-large-'));
    const db = join(home, 'helmo.db');
    const work = new Store(db);
    const actor = { name: 'fixture', kind: 'orchestrator' as const, model: 'fixture', version: '1' };
    const id = work.createTicket(actor, { title: 'Synthetic large history', body: 'synthetic', workstream: 'test', type: 'build', assignee: 'mason' }).id;
    const content = 'SYNTHETIC_PRIVATE_' + 'x'.repeat(10_000);
    for (let i = 0; i < 640; i += 1) work.updateTicket(actor, { ticket_id: id, note: `${i}:${content}` });
    expect(Buffer.byteLength(JSON.stringify(work.getEvents(id)))).toBeGreaterThan(6_189_013);
    work.close();
    const workCli = join(repo, 'packages', 'work', 'dist', 'cli.js');
    const env = { ...process.env, REV_HOME: home };
    for (const key of Object.keys(env)) if (/^(HELMO|ROADMAP|REV|INSTALLATION)_/.test(key) && key !== 'REV_HOME') delete env[key];
    const projected = spawnSync(process.execPath, [workCli, 'get', '--ticket', id, '--trace'], {
      cwd: repo, env: { ...env, HELMO_DB: db }, encoding: 'utf8',
    });
    expect(projected).toMatchObject({ status: 0, stderr: '' });
    const installation = JSON.parse(projected.stdout).installation.label as string;
    const requested = `${id}@${installation}`;
    const throughRuntime = ticketHistory({ helmo_cli: workCli, helmo_db: db } as Parameters<typeof ticketHistory>[0], requested);
    assertTicketIdentity(throughRuntime, requested);
    const trace = JSON.stringify(sessionTrace(throughRuntime, [], 0));
    expect(trace).not.toContain('SYNTHETIC_PRIVATE_');
    expect(JSON.parse(trace)).toMatchObject({ schema: 'helmo.session-trace.v1', content: 'excluded' });
  });
});
