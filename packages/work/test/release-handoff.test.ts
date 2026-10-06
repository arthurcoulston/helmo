import { afterAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor } from '../src/types.js';

const mason: Actor = { name: 'mason', kind: 'agent', model: 'test', version: '1', session: 'rev:mason' };
const proof: Actor = { name: 'proof', kind: 'agent', model: 'test', version: '1', session: 'rev:proof' };
const ward: Actor = { name: 'ward', kind: 'agent', model: 'test', version: '1', session: 'rev:ward' };
const ref = (n: string) => `helmo@${n.repeat(40)}`;
const digest = (n: string) => n.repeat(64);

function accepted(s: Store, title: string, reviewer: Actor) {
  const ticket = s.createTicket(mason, {
    title, body: 'Release evidence.', workstream: 'publishing', type: 'review', assignee: 'mason',
  });
  const pending = s.recordProductCompletion(mason, {
    ticket_id: ticket.id, artifacts: [{ ref: ref('a'), author: 'mason' }], note: 'Candidate ready.',
  });
  const acceptance = s.recordAcceptanceVerdict(reviewer, {
    ticket_id: ticket.id, refs: [ref('a')], verdict: 'pass', note: 'Exact refs pass.',
  });
  return { ticket, completion: pending.completion!, verdict: acceptance.verdict! };
}

function handoff(s: Store) {
  const technical = accepted(s, 'Release Helmo', proof);
  const clearance = accepted(s, 'Clear Helmo release', ward);
  const release = s.recordReleaseHandoff(mason, {
    ticket_id: technical.ticket.id,
    manifest_sha256: digest('a'),
    manifest: { refs: [ref('a')], branch: 'main', tag: 'v0.7.0' },
    technical_ticket: technical.ticket.id,
    technical_completion_seq: technical.completion.seq,
    technical_verdict_seq: technical.verdict.seq,
    technical_reviewer: 'proof',
    clearance_ticket: clearance.ticket.id,
    clearance_completion_seq: clearance.completion.seq,
    clearance_verdict_seq: clearance.verdict.seq,
    clearance_reviewer: 'ward',
    gate_receipt: { path: '/tmp/gate.json', sha256: digest('b') },
    publisher_receipt: { path: '/tmp/publisher.json', sha256: digest('c') },
    decision: 'Ten minutes deciding whether to make this repository public.',
    why_human: 'first_publication: First public exposure is outside standing publication authority.',
    sitting_with: 'mason',
  });
  return { technical, clearance, release };
}

describe('immutable release handoffs', () => {
  it('projects a current handoff, invalidates it on acceptance movement, and rebuilds exactly', () => {
    const s = new Store(':memory:');
    const { technical, release } = handoff(s);
    expect(release).toMatchObject({ current: true, stale_reason: null, decision: expect.stringContaining('repository public') });
    const event = s.getEvents(technical.ticket.id).at(-1)!;
    expect(event.event_type).toBe('release_handoff_recorded');
    expect(event.payload).not.toHaveProperty('current');
    expect(s.withHumanPending('mason')).toContain(technical.ticket.id);
    expect(s.listTickets({ ready: true, caller: 'mason', workstream: 'estate-ui', limit: 20 })).not.toContainEqual(
      expect.objectContaining({ id: technical.ticket.id }),
    );

    s.recordProductCompletion(mason, {
      ticket_id: technical.ticket.id, artifacts: [{ ref: ref('b'), author: 'mason' }], note: 'Candidate moved.',
    });
    expect(s.getTicket(technical.ticket.id).release_handoff).toMatchObject({
      current: false, stale_reason: expect.stringContaining('product completion moved'),
    });
    expect(s.withHumanPending('mason')).not.toContain(technical.ticket.id);
    expect(s.listTickets({ ready: true, caller: 'mason', workstream: 'estate-ui', limit: 20 })).toContainEqual(
      expect.objectContaining({ id: technical.ticket.id }),
    );
    const before = s.dumpState();
    s.rebuild();
    expect(s.dumpState()).toEqual(before);
  });

  it('an answered question leaves a current release handoff sitting in place (H-392)', () => {
    const s = new Store(':memory:');
    const { technical } = handoff(s);
    s.returnToHuman(mason, technical.ticket.id, {
      situation: 'The release notes name two possible dates.', question: 'Which date goes in the notes?', recommendation: 'Use the later date.',
    });
    s.answerTicket({ name: 'operator', kind: 'human' }, technical.ticket.id, { answer: 'Use the later date.', resolution: 'resume' });
    const expected = { needs_human: true, sitting: expect.stringContaining('repository public'), sitting_with: 'mason', release_handoff: expect.objectContaining({ current: true }) };
    expect(s.getTicket(technical.ticket.id)).toMatchObject(expected);
    const before = s.dumpState();
    s.rebuild();
    expect(s.dumpState()).toEqual(before);
  });

  it('refuses an acceptance snapshot that moved before the atomic record', () => {
    const s = new Store(':memory:');
    const technical = accepted(s, 'Release Helmo', proof);
    const clearance = accepted(s, 'Clear Helmo release', ward);
    s.recordAcceptanceVerdict(proof, {
      ticket_id: technical.ticket.id, refs: [ref('a')], verdict: 'pass', note: 'A newer review event.',
    });
    expect(() => s.recordReleaseHandoff(mason, {
      ticket_id: technical.ticket.id, manifest_sha256: digest('a'), manifest: { refs: [ref('a')] },
      technical_ticket: technical.ticket.id, technical_completion_seq: technical.completion.seq,
      technical_verdict_seq: technical.verdict.seq, technical_reviewer: 'proof',
      clearance_ticket: clearance.ticket.id, clearance_completion_seq: clearance.completion.seq,
      clearance_verdict_seq: clearance.verdict.seq, clearance_reviewer: 'ward',
      gate_receipt: { path: '/tmp/gate.json', sha256: digest('b') },
      publisher_receipt: { path: '/tmp/publisher.json', sha256: digest('c') },
      decision: 'Ten minutes deciding whether to make this repository public.',
      why_human: 'first_publication: First public exposure is outside standing publication authority.', sitting_with: 'mason',
    })).toThrow(/acceptance moved/);
    expect(s.getEvents(technical.ticket.id).filter((e) => e.event_type === 'release_handoff_recorded')).toHaveLength(0);
  });

  it('refuses generic authority prose and a manifest whose refs differ from technical acceptance', () => {
    const s = new Store(':memory:');
    const technical = accepted(s, 'Release Helmo', proof);
    const clearance = accepted(s, 'Clear Helmo release', ward);
    const input = {
      ticket_id: technical.ticket.id,
      manifest_sha256: digest('a'), manifest: { refs: [ref('a')] },
      technical_ticket: technical.ticket.id, technical_completion_seq: technical.completion.seq,
      technical_verdict_seq: technical.verdict.seq, technical_reviewer: 'proof',
      clearance_ticket: clearance.ticket.id, clearance_completion_seq: clearance.completion.seq,
      clearance_verdict_seq: clearance.verdict.seq, clearance_reviewer: 'ward',
      gate_receipt: { path: '/tmp/gate.json', sha256: digest('b') },
      publisher_receipt: { path: '/tmp/publisher.json', sha256: digest('c') },
      decision: 'Ten minutes deciding whether to make this repository public.',
      why_human: 'approval', sitting_with: 'mason',
    };
    expect(() => s.recordReleaseHandoff(mason, input)).toThrow(/concrete authority exception/);
    expect(() => s.recordReleaseHandoff(mason, {
      ...input,
      manifest: { refs: [ref('b')] },
      why_human: 'first_publication: First public exposure is reserved to Arthur.',
    })).toThrow(/Manifest refs do not match the technical completion exactly/);
  });

  it('withdraws a current handoff on a generic clear and permits a later ordinary sitting', () => {
    const s = new Store(':memory:');
    const { technical } = handoff(s);
    s.updateTicket(mason, { ticket_id: technical.ticket.id, note: 'Withdrawing the sitting.', needs_human: false });
    expect(s.getTicket(technical.ticket.id)).toMatchObject({
      needs_human: false,
      release_handoff: { current: false, stale_reason: expect.stringMatching(/sitting cleared at event \d+/) },
    });
    expect(s.listTickets({ ready: true, caller: 'mason', workstream: 'estate-ui', limit: 20 })).toContainEqual(
      expect.objectContaining({ id: technical.ticket.id }),
    );

    s.updateTicket(mason, {
      ticket_id: technical.ticket.id,
      note: 'A design sitting is now needed.',
      needs_human: 'Twenty minutes comparing the two navigation treatments.',
      sitting_with: 'gauge',
    });
    expect(s.withHumanPending('mason')).toContain(technical.ticket.id);
    expect(s.listTickets({ ready: true, caller: 'mason', workstream: 'estate-ui', limit: 20 })).not.toContainEqual(
      expect.objectContaining({ id: technical.ticket.id }),
    );
    const before = s.dumpState();
    s.rebuild();
    expect(s.dumpState()).toEqual(before);
  });
});

describe('served current release handoff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-current-release-handoff-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;

  afterAll(() => { view?.kill(); rmSync(dir, { recursive: true, force: true }); });

  it('renders the immutable decision and seat after a generic update tries to reword them', async () => {
    const seed = new Store(db);
    const { technical } = handoff(seed);
    seed.updateTicket(mason, {
      ticket_id: technical.ticket.id,
      note: 'A generic update tries to replace the live card.',
      needs_human: 'Twenty minutes choosing a colour with Arthur.',
      sitting_with: 'herald',
    });
    seed.close();
    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: '0', HELMO_VIEW_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('view did not start')), 15_000);
      view!.once('error', reject);
      view!.once('exit', (code) => reject(new Error(`view exited (${code})`)));
      view!.on('message', (message) => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'helmo-view-ready') {
          clearTimeout(timer); resolve((message as { port: number }).port);
        }
      });
    });
    const html = await (await fetch(`http://127.0.0.1:${port}/?section=awaiting`)).text();
    expect(html).toContain('Ten minutes deciding whether to make this repository public.');
    expect(html).toMatch(/Release decision — with <span class="actor">.*?mason<\/span>/s);
    expect(html).not.toContain('choosing a colour');
    expect(html).not.toMatch(/Release decision — with <span class="actor">.*?herald<\/span>/s);
  });
});

describe('served stale release handoff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-release-handoff-'));
  const db = join(dir, 'helmo.db');
  let view: ChildProcess | null = null;

  afterAll(() => { view?.kill(); rmSync(dir, { recursive: true, force: true }); });

  it('leaves Arthur\'s queue and renders the concrete stale blocker', async () => {
    const seed = new Store(db);
    const { technical } = handoff(seed);
    seed.recordProductCompletion(mason, {
      ticket_id: technical.ticket.id, artifacts: [{ ref: ref('b'), author: 'mason' }], note: 'Candidate moved.',
    });
    seed.close();
    view = spawn(process.execPath, ['--import', 'tsx', 'src/view.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, HELMO_DB: db, HELMO_VIEW_PORT: '0', HELMO_VIEW_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('view did not start')), 15_000);
      view!.once('error', reject);
      view!.once('exit', (code) => reject(new Error(`view exited (${code})`)));
      view!.on('message', (message) => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'helmo-view-ready') {
          clearTimeout(timer); resolve((message as { port: number }).port);
        }
      });
    });
    const awaiting = await (await fetch(`http://127.0.0.1:${port}/?section=awaiting`)).text();
    expect(awaiting).toContain('data-count="0"');
    const full = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(full).toContain('release handoff stale');
    expect(full).toContain('product completion moved');
    expect(full).not.toContain('Release decision');
  });
});
