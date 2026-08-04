import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store.js';
import { Actor, HelmError } from '../src/types.js';

const builder: Actor = { name: 'builder-loop', kind: 'agent', model: 'claude-sonnet-5', version: '1.0' };
const reviewer: Actor = { name: 'reviewer-loop', kind: 'agent', model: 'gpt-6-codex', version: '2.1' };
const orch: Actor = { name: 'helm-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };

function freshStore(): Store {
  return new Store(':memory:');
}

function create(s: Store, over: Record<string, unknown> = {}) {
  return s.createTicket(builder, {
    title: 'Build the importer',
    body: 'Goal: import CSVs from ./data. Constraint: keep memory under 1GB. Current state: not started.',
    workstream: 'helm-dev',
    type: 'build',
    ...over,
  });
}

describe('ids', () => {
  it('mints sequential H-n ids and never reuses them', () => {
    const s = freshStore();
    expect(create(s).id).toBe('H-1');
    const t2 = create(s);
    expect(t2.id).toBe('H-2');
    s.updateTicket(builder, { ticket_id: 'H-2', note: 'moot', status: 'cancelled' });
    expect(create(s).id).toBe('H-3');
  });
});

describe('actor validation', () => {
  it('rejects writes without an actor', () => {
    const s = freshStore();
    expect(() => create(s) && s.createTicket({} as Actor, { title: 'x', body: 'y', workstream: 'w', type: 'ops' })).toThrow(/actor identity/i);
  });
  it('requires model+version for agents', () => {
    const s = freshStore();
    expect(() => s.createTicket({ name: 'a', kind: 'agent' }, { title: 'x', body: 'y', workstream: 'w', type: 'ops' })).toThrow(/model/);
  });
});

describe('required context', () => {
  it('rejects empty body with a teaching error', () => {
    const s = freshStore();
    expect(() => create(s, { body: ' ' })).toThrow(/resume/);
  });
  it('rejects update without note', () => {
    const s = freshStore();
    const t = create(s);
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: '' })).toThrow(/note is required/);
  });
});

describe('claiming', () => {
  it('claims open work and records assignee', () => {
    const s = freshStore();
    const t = create(s);
    const { ticket } = s.updateTicket(builder, { ticket_id: t.id, note: 'starting', status: 'in_progress' });
    expect(ticket.status).toBe('in_progress');
    expect(ticket.assignee).toBe('builder-loop');
  });
  it('blocks claiming a ticket held by another agent, naming the holder', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'starting', status: 'in_progress' });
    expect(() => s.updateTicket(reviewer, { ticket_id: t.id, note: 'mine now', status: 'in_progress' })).toThrow(/builder-loop/);
  });
  it('blocks claiming a ticket reserved for someone else', () => {
    const s = freshStore();
    const t = create(s, { assignee: 'reviewer-loop' });
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'grab', status: 'in_progress' })).toThrow(/reserved/);
  });
  it('only open tickets can be claimed', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'start', status: 'in_progress' });
    s.returnToHuman(builder, t.id, {
      situation: 'Working the importer; hit a licensing question on the CSV parser.',
      question: 'Use the GPL parser?',
      options: [
        { label: 'yes', consequence: 'faster, but GPL obligations' },
        { label: 'no', consequence: 'write our own, ~2 days' },
      ],
      recommendation: 'no — keep the license clean',
    });
    expect(() => s.updateTicket(reviewer, { ticket_id: t.id, note: 'claim', status: 'in_progress' })).toThrow(/awaiting_human/);
  });
});

describe('handoff', () => {
  it('baton pass releases claim and reserves for receiver', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'building', status: 'in_progress' });
    const { ticket } = s.updateTicket(builder, { ticket_id: t.id, note: 'done building, needs review', handoff_to: 'reviewer-loop' });
    expect(ticket.status).toBe('open');
    expect(ticket.assignee).toBe('reviewer-loop');
    // receiver sees it in ready; others don't
    expect(s.listTickets({ ready: true, caller: 'reviewer-loop' }).map((x) => x.id)).toContain(t.id);
    expect(s.listTickets({ ready: true, caller: 'builder-loop' }).map((x) => x.id)).not.toContain(t.id);
    // and the receiver can claim it
    const claimed = s.updateTicket(reviewer, { ticket_id: t.id, note: 'reviewing', status: 'in_progress' });
    expect(claimed.ticket.assignee).toBe('reviewer-loop');
  });
  it('only the holder can hand off', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'building', status: 'in_progress' });
    expect(() => s.updateTicket(reviewer, { ticket_id: t.id, note: 'take it', handoff_to: 'reviewer-loop' })).toThrow(/holder/);
  });
  it('agent chain shows the round trip with versions', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'built', handoff_to: 'reviewer-loop' });
    s.updateTicket(reviewer, { ticket_id: t.id, note: 'reviewing', status: 'in_progress' });
    const chain = s.agentChain(t.id);
    expect(chain[0]).toContain('builder-loop');
    expect(chain[0]).toContain('claude-sonnet-5');
    expect(chain[chain.length - 1]).toContain('reviewer-loop');
  });
});

describe('return to human / answer', () => {
  const q = {
    situation: 'Booking the gala venue; Aldrich Hall wants a $2k non-refundable deposit by Friday.',
    question: 'Pay the deposit?',
    options: [
      { label: 'pay', consequence: 'date locked, $2k sunk if we cancel' },
      { label: 'wait', consequence: 'risk losing the date' },
    ],
    recommendation: 'pay',
    if_unanswered: 'Aldrich releases the date Friday 5pm',
  };

  it('enforces the structured question', () => {
    const s = freshStore();
    const t = create(s);
    expect(() => s.returnToHuman(builder, t.id, { ...q, options: [] })).toThrow(/2-4/);
    expect(() => s.returnToHuman(builder, t.id, { ...q, recommendation: '' })).toThrow(/recommendation/);
  });

  it('answer with resume reopens unassigned and preserves the answer', () => {
    const s = freshStore();
    const t = create(s);
    s.returnToHuman(builder, t.id, q);
    expect(s.getTicket(t.id).status).toBe('awaiting_human');
    expect(s.getTicket(t.id).question?.question).toBe('Pay the deposit?');
    s.answerTicket(orch, t.id, { answer: 'Pay it — the date matters more than the money.', chosen_option: 'pay', resolution: 'resume' });
    const after = s.getTicket(t.id);
    expect(after.status).toBe('open');
    expect(after.assignee).toBeNull();
    expect(after.question).toBeNull();
    expect(s.lastAnswer(t.id)?.chosen_option).toBe('pay');
  });

  it('answer can close or cancel', () => {
    const s = freshStore();
    const t = create(s);
    s.returnToHuman(builder, t.id, q);
    s.answerTicket(orch, t.id, { answer: 'Actually the whole event is off.', resolution: 'cancelled' });
    expect(s.getTicket(t.id).status).toBe('cancelled');
    expect(s.getTicket(t.id).closed_at).toBeTruthy();
  });

  it('cannot answer a ticket that is not awaiting_human', () => {
    const s = freshStore();
    const t = create(s);
    expect(() => s.answerTicket(orch, t.id, { answer: 'x', resolution: 'resume' })).toThrow(/not awaiting_human/);
  });
});

describe('ready queue and blocking', () => {
  it('blocked tickets are not ready; unblock on done or cancelled', () => {
    const s = freshStore();
    const a = create(s, { title: 'Parent' });
    const b = create(s, { title: 'Prereq' });
    s.linkTickets(builder, a.id, b.id, 'blocks', 'add');
    expect(s.listTickets({ ready: true }).map((x) => x.id)).not.toContain(a.id);
    s.updateTicket(builder, { ticket_id: b.id, note: 'done', status: 'done', evidence: [{ kind: 'file', ref: '/tmp/x' }] });
    expect(s.listTickets({ ready: true }).map((x) => x.id)).toContain(a.id);
  });
  it('rejects blocks cycles with a teaching error', () => {
    const s = freshStore();
    const a = create(s);
    const b = create(s);
    s.linkTickets(builder, a.id, b.id, 'blocks', 'add');
    expect(() => s.linkTickets(builder, b.id, a.id, 'blocks', 'add')).toThrow(/cycle/);
  });
  it('non-blocking dep types do not affect readiness', () => {
    const s = freshStore();
    const a = create(s);
    const b = create(s);
    s.linkTickets(builder, a.id, b.id, 'discovered_from', 'add');
    expect(s.listTickets({ ready: true }).map((x) => x.id)).toContain(a.id);
  });
});

describe('guardrails', () => {
  it('blast radius never ratchets down', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'sent invites', blast_radius: 'sent' });
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'oops', blast_radius: 'draft' })).toThrow(/never goes back down/);
  });
  it('done without evidence warns but records', () => {
    const s = freshStore();
    const t = create(s);
    const { warnings } = s.updateTicket(builder, { ticket_id: t.id, note: 'decided after research', status: 'done' });
    expect(warnings.join(' ')).toMatch(/done_without_evidence/);
    expect(s.getTicket(t.id).status).toBe('done');
  });
  it('terminal tickets reject rework and point to follow-up pattern', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'done', status: 'done' });
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'more', status: 'in_progress' })).toThrow(/relates/);
  });
  it('tokens and cost aggregate across the chain', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'work', tokens: 1000, cost_usd: 0.5 });
    s.updateTicket(reviewer, { ticket_id: t.id, note: 'review', tokens: 400, cost_usd: 0.2, takeover: false });
    const after = s.getTicket(t.id);
    expect(after.tokens_total).toBe(1400);
    expect(after.cost_usd_total).toBeCloseTo(0.7);
  });
});

describe('recordSpend (harness metering)', () => {
  it('accumulates onto a terminal ticket without touching status or updated_at', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'done', status: 'done', evidence: [{ kind: 'file', ref: '/tmp/x' }] });
    const closed = s.getTicket(t.id);
    const after = s.recordSpend(builder, t.id, { tokens: 90000, cost_usd: 3.1, note: 'metered session, whole session charged here' });
    expect(after.tokens_total).toBe(90000);
    expect(after.cost_usd_total).toBeCloseTo(3.1);
    expect(after.status).toBe('done');
    expect(after.updated_at).toBe(closed.updated_at);
  });
  it('rejects an empty spend and a missing note', () => {
    const s = freshStore();
    const t = create(s);
    expect(() => s.recordSpend(builder, t.id, { note: 'nothing' })).toThrow(/tokens and\/or cost_usd/);
    expect(() => s.recordSpend(builder, t.id, { tokens: 5, note: ' ' })).toThrow(/note is required/);
  });
  it('actorTicketsSince orders by touch count within the window', () => {
    const s = freshStore();
    const a = create(s);
    const b = create(s);
    const seq = s.maxSeq();
    s.updateTicket(builder, { ticket_id: b.id, note: 'claimed', status: 'in_progress' });
    s.updateTicket(builder, { ticket_id: b.id, note: 'progress' });
    s.updateTicket(builder, { ticket_id: a.id, note: 'side note' });
    expect(s.actorTicketsSince('builder-loop', seq)).toEqual([
      { id: b.id, events: 2 },
      { id: a.id, events: 1 },
    ]);
    expect(s.actorTicketsSince('reviewer-loop', seq)).toEqual([]);
  });
});

describe('harness queries (wake cursor)', () => {
  it('maxSeq advances and scopeChangedSince respects workstream and assignee scope', () => {
    const s = freshStore();
    const t = create(s, { workstream: 'alpha' });
    const seq = s.maxSeq();
    expect(seq).toBeGreaterThan(0);
    expect(s.scopeChangedSince(seq, 'alpha')).toBe(false);
    create(s, { workstream: 'beta' });
    expect(s.scopeChangedSince(seq, 'alpha')).toBe(false); // beta noise does not wake alpha
    s.updateTicket(builder, { ticket_id: t.id, note: 'progress', status: 'in_progress' });
    expect(s.scopeChangedSince(seq, 'alpha')).toBe(true);
  });
  it('readyCount and actorActivitySince answer the harness questions', () => {
    const s = freshStore();
    const t = create(s, { workstream: 'alpha' });
    expect(s.readyCount('alpha')).toBe(1);
    const seq = s.maxSeq();
    s.updateTicket(builder, { ticket_id: t.id, note: 'claimed', status: 'in_progress' });
    expect(s.readyCount('alpha')).toBe(0);
    expect(s.actorActivitySince('builder-loop', seq)).toBe(1);
    expect(s.actorActivitySince('reviewer-loop', seq)).toBe(0);
  });
});

describe('recurring templates (lazy materialization)', () => {
  function template(s: Store, schedule = 'every 30m') {
    return s.createTicket(builder, {
      title: 'Nightly audit', body: 'Standing work: audit the thing.', workstream: 'helm-dev', type: 'ops', schedule,
    });
  }
  it('rejects a bad schedule at creation', () => {
    const s = freshStore();
    expect(() => template(s, 'whenever')).toThrow(/neither/);
  });
  it('templates never appear in the ready queue; due instances do', () => {
    const s = freshStore();
    const t = template(s);
    expect(s.listTickets({ ready: true }).map((x) => x.id)).toEqual([]);
    // nothing due yet (created just now, first slot is +30m) — a read spawns nothing
    expect(s.materializeDue(new Date(Date.now() + 1000)).length).toBe(0);
    // 31 minutes later a queue read spawns the instance, linked to its template
    const spawned = s.materializeDue(new Date(Date.now() + 31 * 60_000));
    expect(spawned.length).toBe(1);
    const inst = s.getTicket(spawned[0]!);
    expect(inst.title).toContain('Nightly audit —');
    expect(inst.schedule).toBeNull();
    expect(s.getDeps(inst.id).outgoing).toEqual([{ from_id: inst.id, to_id: t.id, type: 'parent' }]);
    const ready = s.listTickets({ ready: true }).map((x) => x.id);
    expect(ready).toContain(inst.id);
    expect(ready).not.toContain(t.id);
  });
  it('skip-if-open: no second instance while one is open; closing unblocks the next slot', () => {
    const s = freshStore();
    template(s);
    const later = (min: number) => new Date(Date.now() + min * 60_000);
    const [first] = s.materializeDue(later(31));
    expect(s.materializeDue(later(65)).length).toBe(0); // slot due, but first is still open
    s.updateTicket(builder, { ticket_id: first!, note: 'done', status: 'done' });
    expect(s.materializeDue(later(65)).length).toBe(1);
  });
  it('after downtime only the latest missed slot spawns, and cancelling the template retires it', () => {
    const s = freshStore();
    const t = template(s);
    const spawned = s.materializeDue(new Date(Date.now() + 6 * 60 * 60_000)); // ~12 slots missed
    expect(spawned.length).toBe(1);
    s.updateTicket(builder, { ticket_id: spawned[0]!, note: 'done', status: 'done' });
    s.updateTicket(builder, { ticket_id: t.id, note: 'retiring the standing work', status: 'cancelled' });
    expect(s.materializeDue(new Date(Date.now() + 24 * 60 * 60_000)).length).toBe(0);
  });
});

describe('THE INVARIANT: tickets are a materialized view of events', () => {
  it('rebuild() from events reproduces identical state after a full lifecycle', () => {
    const s = freshStore();
    const a = create(s, { title: 'Gala venue' });
    const b = create(s, { title: 'Deposit decision', deps: [{ to: a.id, type: 'discovered_from' as const }] });
    s.linkTickets(builder, a.id, b.id, 'blocks', 'add');
    s.updateTicket(builder, { ticket_id: b.id, note: 'investigating', status: 'in_progress', tokens: 500 });
    s.returnToHuman(builder, b.id, {
      situation: 'Deposit needed by Friday.',
      question: 'Pay?',
      options: [
        { label: 'pay', consequence: '$2k sunk if cancelled' },
        { label: 'wait', consequence: 'lose the date' },
      ],
      recommendation: 'pay',
    });
    s.answerTicket(orch, b.id, { answer: 'Pay.', chosen_option: 'pay', resolution: 'resume' });
    s.updateTicket(reviewer, { ticket_id: b.id, note: 'paid, receipt attached', status: 'in_progress' });
    s.updateTicket(reviewer, {
      ticket_id: b.id, note: 'confirmed', status: 'done',
      evidence: [{ kind: 'url', ref: 'https://example.com/receipt' }],
      confidence: 'spot_check', uncertainty_note: 'unclear if the deposit covers AV', blast_radius: 'records', cost_usd: 2000,
    });
    s.updateTicket(builder, { ticket_id: a.id, note: 'venue booked, wrapping up', status: 'in_progress' });
    s.recordSpend(builder, b.id, { tokens: 12345, cost_usd: 1.25, note: 'metered post-close by the harness' });
    s.createTicket(builder, { title: 'Standing sweep', body: 'recurring', workstream: 'helm-dev', type: 'ops', schedule: 'every 1h' });
    expect(s.materializeDue(new Date(Date.now() + 61 * 60_000)).length).toBe(1);

    const before = s.dumpState();
    s.rebuild();
    const after = s.dumpState();
    expect(after).toEqual(before);
  });
});
