import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Actor, HelmoError } from '../src/types.js';

const builder: Actor = { name: 'builder-loop', kind: 'agent', model: 'claude-sonnet-5', version: '1.0' };
const reviewer: Actor = { name: 'reviewer-loop', kind: 'agent', model: 'gpt-6-codex', version: '2.1' };
const orch: Actor = { name: 'helmo-orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '0.1' };

function freshStore(): Store {
  return new Store(':memory:');
}

function create(s: Store, over: Record<string, unknown> = {}) {
  return s.createTicket(builder, {
    title: 'Build the importer',
    body: 'Goal: import CSVs from ./data. Constraint: keep memory under 1GB. Current state: not started.',
    workstream: 'helmo-dev',
    type: 'build',
    ...over,
  });
}

/** The meeting touch that releases the triage rule (H-56) so the filer may claim. */
function triage(s: Store, id: string) {
  s.updateTicket(orch, { ticket_id: id, note: 'triaged in meeting: yes, worth doing' });
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

describe('mangled tool-call writes rejected at the door (H-71)', () => {
  // The shape of the real incident (H-32 seq 159): the note carries its own
  // closing tag, then the markup and content of every following field.
  const mangled = 'Ranked all 336; no keyword pass.</note>\n<parameter name="uncertainty_note">Tier boundaries are judgment calls.';

  it('rejects an update note carrying swallowed parameter markup, storing nothing', () => {
    const s = freshStore();
    const t = create(s);
    triage(s, t.id);
    const before = s.getEvents(t.id).length;
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: mangled, status: 'done' })).toThrow(/mis-serialized/);
    expect(s.getEvents(t.id).length).toBe(before);
    expect(s.getTicket(t.id).status).toBe('open');
  });

  it('rejects markup in a created body', () => {
    const s = freshStore();
    expect(() => create(s, { body: mangled })).toThrow(/H-71/);
  });

  it("rejects the field's own closing tag even with no other markup", () => {
    const s = freshStore();
    const t = create(s);
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'done.</note>' })).toThrow(/mis-serialized/);
  });

  it('rejects namespace-prefixed markup variants', () => {
    const s = freshStore();
    const t = create(s);
    const prefixed = 'progress <' + 'ns:parameter name="body">rest';
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: prefixed })).toThrow(/mis-serialized/);
  });

  it('guards questions and answers too', () => {
    const s = freshStore();
    const t = create(s);
    triage(s, t.id);
    expect(() =>
      s.returnToHuman(builder, t.id, {
        situation: mangled,
        question: 'Proceed?',
        options: [
          { label: 'yes', consequence: 'goes ahead' },
          { label: 'no', consequence: 'stops' },
        ],
        recommendation: 'yes',
      }),
    ).toThrow(/mis-serialized/);
  });

  it('leaves ordinary angle-bracket prose alone', () => {
    const s = freshStore();
    const t = create(s);
    const { ticket } = s.updateTicket(builder, { ticket_id: t.id, note: 'kept memory < 1GB; a <= b holds; see the <details> block' });
    expect(ticket.id).toBe(t.id);
  });

  it('accepts a deliberately broken quote of the markup', () => {
    const s = freshStore();
    const t = create(s);
    const { ticket } = s.updateTicket(builder, { ticket_id: t.id, note: 'the blob contained "< parameter name=" markup; tag broken here on purpose' });
    expect(ticket.id).toBe(t.id);
  });
});

describe('claiming', () => {
  it('claims open work and records assignee', () => {
    const s = freshStore();
    const t = create(s);
    triage(s, t.id);
    const { ticket } = s.updateTicket(builder, { ticket_id: t.id, note: 'starting', status: 'in_progress' });
    expect(ticket.status).toBe('in_progress');
    expect(ticket.assignee).toBe('builder-loop');
  });
  it('blocks claiming a ticket held by another agent, naming the holder', () => {
    const s = freshStore();
    const t = create(s);
    triage(s, t.id);
    s.updateTicket(builder, { ticket_id: t.id, note: 'starting', status: 'in_progress' });
    expect(() => s.updateTicket(reviewer, { ticket_id: t.id, note: 'mine now', status: 'in_progress' })).toThrow(/builder-loop/);
  });
  it('blocks claiming a ticket reserved for someone else', () => {
    const s = freshStore();
    const t = create(s, { assignee: 'reviewer-loop' });
    triage(s, t.id);
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'grab', status: 'in_progress' })).toThrow(/reserved/);
  });
  it('only open tickets can be claimed', () => {
    const s = freshStore();
    const t = create(s);
    triage(s, t.id);
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
    triage(s, t.id);
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
    triage(s, t.id);
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
    triage(s, b.id);
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
  it('actorSelfSpendSince sums self-reported spend, excluding meter spend events', () => {
    const s = freshStore();
    const t = create(s);
    triage(s, t.id);
    const seq = s.maxSeq();
    s.updateTicket(builder, { ticket_id: t.id, note: 'claimed', status: 'in_progress' });
    s.updateTicket(builder, { ticket_id: t.id, note: 'guessed my own usage', tokens: 120000, cost_usd: 14 });
    s.recordSpend(reviewer, t.id, { tokens: 40000, cost_usd: 3.68, note: 'metered by harness' });
    expect(s.actorSelfSpendSince('builder-loop', seq)).toEqual({ tokens: 120000, cost_usd: 14 });
    expect(s.actorSelfSpendSince('reviewer-loop', seq)).toEqual({ tokens: 0, cost_usd: 0 });
  });
  it('actorSelfSpendByTicketSince splits the self-report by the ticket that carries it (H-187)', () => {
    const s = freshStore();
    const a = create(s);
    const b = create(s);
    triage(s, a.id);
    triage(s, b.id);
    const seq = s.maxSeq();
    s.updateTicket(builder, { ticket_id: a.id, note: 'claimed', status: 'in_progress' });
    s.updateTicket(builder, { ticket_id: b.id, note: 'guessed on the side ticket', tokens: 80000 });
    s.updateTicket(builder, { ticket_id: a.id, note: 'guessed on the main one', cost_usd: 2 });
    expect(s.actorSelfSpendByTicketSince('builder-loop', seq)).toEqual([
      { id: a.id, tokens: 0, cost_usd: 2 },
      { id: b.id, tokens: 80000, cost_usd: 0 },
    ]);
    expect(s.actorSelfSpendByTicketSince('reviewer-loop', seq)).toEqual([]);
  });
  it('floors a total at zero and marks the event when a delta would go below it (H-187)', () => {
    const s = freshStore();
    const t = create(s);
    s.recordSpend(builder, t.id, { tokens: 1000, cost_usd: 1, note: 'metered' });
    const after = s.recordSpend(builder, t.id, { tokens: -62304, cost_usd: -0.5, note: 'reconciliation' });
    expect(after.tokens_total).toBe(0);
    expect(after.cost_usd_total).toBeCloseTo(0.5);
    const ev = s.getEvents(t.id).filter((e) => e.event_type === 'spend').at(-1)!;
    expect(ev.payload['tokens']).toBe(-1000);
    expect(ev.payload['cost_usd']).toBe(-0.5);
    expect(String(ev.payload['note'])).toMatch(/CLAMPED.*tokens -62304 floored to -1000/);
  });
});

describe('renameWorkstream', () => {
  it('moves every ticket including closed ones, keeps steering, and survives rebuild', () => {
    const s = freshStore();
    const a = create(s, { workstream: 'old-name' });
    const b = create(s, { workstream: 'old-name' });
    triage(s, a.id);
    s.updateTicket(builder, { ticket_id: a.id, note: 'claimed', status: 'in_progress' });
    s.updateTicket(builder, { ticket_id: a.id, note: 'done', status: 'done', evidence: [{ kind: 'file', ref: '/tmp/x' }] });
    s.setWorkstream(orch, { name: 'old-name', goal: 'ship it', budget_usd: 10 });
    const res = s.renameWorkstream(orch, { from: 'old-name', to: 'new-name', note: 'product renamed' });
    expect(res.moved).toBe(2);
    expect(s.getTicket(a.id).workstream).toBe('new-name');
    expect(s.getTicket(b.id).workstream).toBe('new-name');
    expect(s.getWorkstreamInfo('new-name').goal).toBe('ship it');
    const before = s.dumpState();
    s.rebuild();
    expect(s.dumpState()).toEqual(before);
  });
  it('refuses a rename that would collide two steering rows, and an empty source', () => {
    const s = freshStore();
    create(s, { workstream: 'x' });
    s.setWorkstream(orch, { name: 'x', goal: 'gx' });
    s.setWorkstream(orch, { name: 'y', goal: 'gy' });
    expect(() => s.renameWorkstream(orch, { from: 'x', to: 'y', note: 'merge' })).toThrow(/steering/);
    expect(() => s.renameWorkstream(orch, { from: 'ghost', to: 'z', note: 'typo' })).toThrow(/nothing to rename/);
  });
});

describe('harness queries (wake cursor)', () => {
  it('maxSeq advances and scopeChangedSince respects workstream and assignee scope', () => {
    const s = freshStore();
    const t = create(s, { workstream: 'alpha' });
    triage(s, t.id); // before the cursor is captured, so the touch is not motion
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
    triage(s, t.id);
    expect(s.readyCount('alpha')).toBe(1);
    const seq = s.maxSeq();
    s.updateTicket(builder, { ticket_id: t.id, note: 'claimed', status: 'in_progress' });
    expect(s.readyCount('alpha')).toBe(0);
    expect(s.actorActivitySince('builder-loop', seq)).toBe(1);
    expect(s.actorActivitySince('reviewer-loop', seq)).toBe(0);
  });
  it('--advancing separates work that moved something from a note (H-412)', () => {
    const s = freshStore();
    const t = create(s, { workstream: 'alpha' });
    triage(s, t.id);
    const seq = s.maxSeq();

    // A note and nothing else: activity, but nothing moved.
    s.updateTicket(builder, { ticket_id: t.id, note: 'still blocked on the poller; nothing to do' });
    expect(s.actorActivitySince('builder-loop', seq)).toBe(1);
    expect(s.actorActivitySince('builder-loop', seq, true)).toBe(0);

    // A status change is advancement, note or not.
    s.updateTicket(builder, { ticket_id: t.id, note: 'claimed', status: 'in_progress' });
    expect(s.actorActivitySince('builder-loop', seq, true)).toBe(1);

    // So is filing a new ticket.
    create(s, { workstream: 'alpha' });
    expect(s.actorActivitySince('builder-loop', seq, true)).toBeGreaterThan(1);
  });
});

describe('recurring templates (lazy materialization)', () => {
  function template(s: Store, schedule = 'every 30m') {
    return s.createTicket(builder, {
      title: 'Nightly audit', body: 'Standing work: audit the thing.', workstream: 'helmo-dev', type: 'ops', schedule,
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
  it('instances spawn unassigned even from a reserved template (H-171)', () => {
    const s = freshStore();
    s.createTicket(builder, {
      title: 'Daily listen', body: 'standing', workstream: 'helmo-dev', type: 'ops', schedule: 'every 1d', assignee: 'reviewer-loop',
    });
    const [inst] = s.materializeDue(new Date(Date.now() + 25 * 60 * 60_000));
    expect(s.getTicket(inst!).assignee).toBeNull();
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

describe('workstream steering (H-55)', () => {
  it('agents cannot set goals or budgets; the human/orchestrator can', () => {
    const s = freshStore();
    expect(() => s.setWorkstream(builder, { name: 'alpha', goal: 'ship it' })).toThrow(/operator steering/);
    const w = s.setWorkstream(orch, { name: 'alpha', goal: 'the operator has a confirmed shortlist', budget_usd: 50 });
    expect(w.goal).toBe('the operator has a confirmed shortlist');
    expect(w.budget_usd).toBe(50);
    expect(w.remaining_usd).toBe(50);
  });
  it('partial updates keep the other field; empty writes are rejected', () => {
    const s = freshStore();
    s.setWorkstream(orch, { name: 'alpha', goal: 'the goal', budget_usd: 50 });
    const w = s.setWorkstream(orch, { name: 'alpha', budget_usd: 80 });
    expect(w.goal).toBe('the goal');
    expect(w.budget_usd).toBe(80);
    expect(() => s.setWorkstream(orch, { name: 'alpha' })).toThrow(/noise/);
  });
  it('spend counts against the budget and surfaces as budget pressure past 80%', () => {
    const s = freshStore();
    const t = create(s, { workstream: 'alpha' });
    s.setWorkstream(orch, { name: 'alpha', budget_usd: 10 });
    s.recordSpend(builder, t.id, { cost_usd: 7.9, note: 'metered' });
    expect(s.hygiene().filter((f) => f.check === 'budget_pressure')).toEqual([]);
    s.recordSpend(builder, t.id, { cost_usd: 0.2, note: 'metered' });
    expect(s.hygiene()).toContainEqual(expect.objectContaining({ check: 'budget_pressure', workstream: 'alpha' }));
    s.recordSpend(builder, t.id, { cost_usd: 5, note: 'metered' });
    const f = s.hygiene().find((x) => x.check === 'budget_pressure');
    expect(f?.detail).toMatch(/exhausted/);
    expect(s.getWorkstreamInfo('alpha').remaining_usd).toBeCloseTo(-3.1);
  });
  it('listWorkstreamInfo covers streams with tickets and streams only steered', () => {
    const s = freshStore();
    create(s, { workstream: 'alpha' });
    s.setWorkstream(orch, { name: 'beta', goal: 'future work' });
    const names = s.listWorkstreamInfo().map((w) => w.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });
});

describe('self-filed tickets need triage (H-55)', () => {
  it('a ticket is withheld from its filer\'s ready queue but visible to others', () => {
    const s = freshStore();
    const t = create(s); // filed by builder
    expect(s.listTickets({ ready: true, caller: 'builder-loop' }).map((x) => x.id)).not.toContain(t.id);
    expect(s.selfFiledPending('builder-loop')).toContain(t.id);
    expect(s.listTickets({ ready: true, caller: 'reviewer-loop' }).map((x) => x.id)).toContain(t.id);
    expect(s.listTickets({ ready: true }).map((x) => x.id)).toContain(t.id); // anonymous read (the view) sees all
  });
  it('any touch by another actor releases it', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(orch, { ticket_id: t.id, note: 'triaged in meeting: yes, worth doing' });
    expect(s.listTickets({ ready: true, caller: 'builder-loop' }).map((x) => x.id)).toContain(t.id);
    expect(s.selfFiledPending('builder-loop')).toEqual([]);
  });
  it('a metered spend event is bookkeeping, not a second pair of eyes (H-242)', () => {
    const s = freshStore();
    const t = create(s); // filed by builder
    const meter: Actor = { name: 'rev', kind: 'agent', model: 'rev-harness', version: '0.1.0' };
    s.recordSpend(meter, t.id, { tokens: 28316, cost_usd: 5.2, note: 'metered: loop builder-loop iteration 26' });
    expect(s.listTickets({ ready: true, caller: 'builder-loop' }).map((x) => x.id)).not.toContain(t.id);
    expect(s.selfFiledPending('builder-loop')).toContain(t.id);
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'claiming', status: 'in_progress' })).toThrow(/second pair of eyes/);
  });
  it('reserving your filing for another agent leaves their queue unaffected', () => {
    const s = freshStore();
    const t = create(s, { assignee: 'reviewer-loop' });
    expect(s.listTickets({ ready: true, caller: 'reviewer-loop' }).map((x) => x.id)).toContain(t.id);
  });
  it('instances of a self-made template are judged by the template', () => {
    const s = freshStore();
    s.createTicket(builder, { title: 'Sweep', body: 'standing', workstream: 'helmo-dev', type: 'ops', schedule: 'every 30m' });
    const [inst] = s.materializeDue(new Date(Date.now() + 31 * 60_000));
    expect(s.listTickets({ ready: true, caller: 'builder-loop' }).map((x) => x.id)).not.toContain(inst);
    expect(s.listTickets({ ready: true, caller: 'reviewer-loop' }).map((x) => x.id)).toContain(inst);
  });
  it('readyCount honors the rule, so a loop does not wake for its own filings', () => {
    const s = freshStore();
    create(s, { workstream: 'alpha' });
    expect(s.readyCount('alpha', 'builder-loop')).toBe(0);
    expect(s.readyCount('alpha', 'reviewer-loop')).toBe(1);
  });
});

describe('triage rule enforced on claims (H-56)', () => {
  it('rejects a direct claim by the filer with a teaching error', () => {
    const s = freshStore();
    const t = create(s); // filed by builder
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'claiming', status: 'in_progress' })).toThrow(/second pair of eyes/);
  });
  it('takeover does not bypass self-triage', () => {
    const s = freshStore();
    const t = create(s, { assignee: 'reviewer-loop' }); // builder files, reserves for reviewer
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'taking it back', status: 'in_progress', takeover: true })).toThrow(/not self-triage/);
  });
  it('any touch by another actor releases the claim path too', () => {
    const s = freshStore();
    const t = create(s);
    s.updateTicket(orch, { ticket_id: t.id, note: 'triaged in meeting: yes, worth doing' });
    expect(s.updateTicket(builder, { ticket_id: t.id, note: 'claiming', status: 'in_progress' }).ticket.status).toBe('in_progress');
  });
  it('creating with in_progress stays legitimate — the rule guards backlog, not work started in the same breath', () => {
    const s = freshStore();
    const t = create(s, { status: 'in_progress' });
    expect(t.status).toBe('in_progress');
    expect(t.assignee).toBe('builder-loop');
  });
  it('an orchestrator may claim its own filing — it is the second pair of eyes', () => {
    const s = freshStore();
    const t = s.createTicket(orch, { title: 'Meeting follow-up', body: 'from the meeting. Current state: not started.', workstream: 'helmo-dev', type: 'ops' });
    expect(s.updateTicket(orch, { ticket_id: t.id, note: 'doing it now', status: 'in_progress' }).ticket.status).toBe('in_progress');
  });
  it('instances of a self-made template are unclaimable by the template author too', () => {
    const s = freshStore();
    s.createTicket(builder, { title: 'Sweep', body: 'standing', workstream: 'helmo-dev', type: 'ops', schedule: 'every 30m' });
    const [inst] = s.materializeDue(new Date(Date.now() + 31 * 60_000));
    expect(() => s.updateTicket(builder, { ticket_id: inst!, note: 'claiming my sweep', status: 'in_progress' })).toThrow(/second pair of eyes/);
    expect(s.updateTicket(reviewer, { ticket_id: inst!, note: 'claiming', status: 'in_progress' }).ticket.status).toBe('in_progress');
  });
});

describe('hygiene checks (deterministic, read-only)', () => {
  const hrs = (h: number) => new Date(Date.now() + h * 3_600_000);
  it('stale claims and aging questions surface after their thresholds', () => {
    const s = freshStore();
    const a = create(s);
    triage(s, a.id);
    s.updateTicket(builder, { ticket_id: a.id, note: 'claimed', status: 'in_progress' });
    const b = create(s);
    s.returnToHuman(builder, b.id, {
      situation: 'x', question: 'y?', options: [{ label: 'l', consequence: 'c' }, { label: 'l2', consequence: 'c2' }], recommendation: 'l',
    });
    expect(s.hygiene()).toEqual([]); // nothing is stale yet
    const later = s.hygiene(hrs(49));
    expect(later).toContainEqual(expect.objectContaining({ check: 'stale_claim', ticket_id: a.id }));
    expect(later).toContainEqual(expect.objectContaining({ check: 'aging_question', ticket_id: b.id }));
  });
  it('done without evidence and phantom blocks', () => {
    const s = freshStore();
    const noEv = create(s);
    s.updateTicket(builder, { ticket_id: noEv.id, note: 'done, trust me', status: 'done' });
    const target = create(s);
    const waiter = create(s, { deps: [{ to: target.id, type: 'blocks' as const }] });
    s.updateTicket(builder, { ticket_id: target.id, note: 'done', status: 'done', evidence: [{ kind: 'file', ref: '/tmp/x' }] });
    const f = s.hygiene();
    expect(f).toContainEqual(expect.objectContaining({ check: 'done_without_evidence', ticket_id: noEv.id }));
    expect(f).toContainEqual(expect.objectContaining({ check: 'phantom_block', ticket_id: waiter.id }));
    // touching the waiter clears the phantom flag
    s.updateTicket(builder, { ticket_id: waiter.id, note: 'seen it, picking this up soon' });
    expect(s.hygiene().filter((x) => x.check === 'phantom_block')).toEqual([]);
  });
  it('spend anomalies need a workstream norm; priority inversions need motion below a ready P1', () => {
    const s = freshStore();
    const t1 = create(s); const t2 = create(s); const t3 = create(s);
    s.recordSpend(builder, t1.id, { cost_usd: 1, note: 'metered' });
    s.recordSpend(builder, t2.id, { cost_usd: 1, note: 'metered' });
    expect(s.hygiene().filter((x) => x.check === 'spend_anomaly')).toEqual([]); // only 2 spent tickets: no norm
    s.recordSpend(builder, t3.id, { cost_usd: 20, note: 'metered' });
    expect(s.hygiene()).toContainEqual(expect.objectContaining({ check: 'spend_anomaly', ticket_id: t3.id }));
    const p1 = create(s, { priority: 1 });
    triage(s, t1.id);
    s.updateTicket(builder, { ticket_id: t1.id, note: 'working the P2 instead', status: 'in_progress' });
    expect(s.hygiene()).toContainEqual(expect.objectContaining({ check: 'priority_inversion', ticket_id: p1.id }));
  });
  it('silent assignees: never-written names flag while the store is live; quiet weeks flag nobody', () => {
    const s = freshStore();
    const typo = create(s, { assignee: 'mastr-at-arms' });
    // The creation event itself is other-actor activity: a name with no events anywhere flags at once.
    expect(s.hygiene()).toContainEqual(expect.objectContaining({ check: 'silent_assignee', ticket_id: typo.id }));
    const held = create(s, { assignee: 'reviewer-loop' });
    s.updateTicket(reviewer, { ticket_id: held.id, note: 'seen, will start after current work' });
    expect(s.hygiene().filter((x) => x.check === 'silent_assignee').map((x) => x.ticket_id)).toEqual([typo.id]);
    // 8 days on with the whole store quiet: the activity guard holds everything back (operator away, nothing is wrong).
    expect(s.hygiene(hrs(8 * 24)).filter((x) => x.check === 'silent_assignee')).toEqual([]);
    // Same 8 days but the store is live: event ts is wall-clock, so nudge one
    // builder event into the window; reviewer's 8d silence now flags too.
    (s as unknown as { db: { prepare(sql: string): { run(v: string): unknown } } }).db
      .prepare("UPDATE events SET ts = ? WHERE seq = (SELECT MAX(seq) FROM events WHERE json_extract(actor, '$.name') = 'builder-loop')")
      .run(hrs(8 * 24 - 1).toISOString());
    const f = s.hygiene(hrs(8 * 24)).filter((x) => x.check === 'silent_assignee');
    expect(f).toContainEqual(expect.objectContaining({ ticket_id: typo.id }));
    expect(f).toContainEqual(expect.objectContaining({ ticket_id: held.id, detail: expect.stringContaining('silent everywhere for 8d') }));
  });
  it('a question ticket the human closed via answer is not done_without_evidence: the answer IS the closure record (H-81)', () => {
    const s = freshStore();
    const q = create(s);
    s.returnToHuman(builder, q.id, {
      situation: 'Choosing the CSV parser license.', question: 'GPL ok?',
      options: [{ label: 'yes', consequence: 'faster' }, { label: 'no', consequence: '2 days' }],
      recommendation: 'no',
    });
    s.answerTicket(orch, q.id, { answer: 'No — keep the license clean. That settles the ticket.', chosen_option: 'no', resolution: 'done' });
    expect(s.hygiene().filter((x) => x.check === 'done_without_evidence')).toEqual([]);
    // an agent-closed done with no evidence still flags
    const bare = create(s);
    s.updateTicket(builder, { ticket_id: bare.id, note: 'done, trust me', status: 'done' });
    expect(s.hygiene().filter((x) => x.check === 'done_without_evidence').map((x) => x.ticket_id)).toEqual([bare.id]);
  });
});

describe('hygiene dispositions (H-81)', () => {
  function doneWithoutEvidence(s: Store) {
    const t = create(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'done, trust me', status: 'done' });
    return t;
  }
  it('a disposed finding stops re-reporting; others on the same ticket are untouched', () => {
    const s = freshStore();
    const t = doneWithoutEvidence(s);
    s.recordSpend(builder, t.id, { cost_usd: 20, note: 'metered' });
    const t2 = create(s); const t3 = create(s);
    s.recordSpend(builder, t2.id, { cost_usd: 1, note: 'metered' });
    s.recordSpend(builder, t3.id, { cost_usd: 1, note: 'metered' });
    expect(s.hygiene().map((f) => f.check).sort()).toEqual(['done_without_evidence', 'spend_anomaly']);
    s.disposeHygieneFinding(reviewer, { check: 'done_without_evidence', ticket_id: t.id, reason: 'deliverable was conversational; accepted by the human in the 08-06 meeting' });
    expect(s.hygiene().map((f) => f.check)).toEqual(['spend_anomaly']);
  });
  it('terminal tickets only — a live ticket clears by acting on it', () => {
    const s = freshStore();
    const t = create(s);
    expect(() => s.disposeHygieneFinding(reviewer, { check: 'stale_claim', ticket_id: t.id, reason: 'x' })).toThrow(/terminal/);
  });
  it('rejects unknown checks, empty reasons, and double disposal', () => {
    const s = freshStore();
    const t = doneWithoutEvidence(s);
    expect(() => s.disposeHygieneFinding(reviewer, { check: 'imaginary_check', ticket_id: t.id, reason: 'x' })).toThrow(/Unknown hygiene check/);
    expect(() => s.disposeHygieneFinding(reviewer, { check: 'done_without_evidence', ticket_id: t.id, reason: '  ' })).toThrow(/reason is required/);
    s.disposeHygieneFinding(reviewer, { check: 'done_without_evidence', ticket_id: t.id, reason: 'accepted' });
    expect(() => s.disposeHygieneFinding(builder, { check: 'done_without_evidence', ticket_id: t.id, reason: 'again' })).toThrow(/already disposed/);
  });
  it('disposal is bookkeeping, not motion: status and updated_at untouched', () => {
    const s = freshStore();
    const t = doneWithoutEvidence(s);
    const before = s.getTicket(t.id);
    s.disposeHygieneFinding(reviewer, { check: 'done_without_evidence', ticket_id: t.id, reason: 'accepted in meeting' });
    const after = s.getTicket(t.id);
    expect(after.status).toBe('done');
    expect(after.updated_at).toBe(before.updated_at);
  });
});

describe('THE INVARIANT: tickets are a materialized view of events', () => {
  it('rebuild() from events reproduces identical state after a full lifecycle', () => {
    const s = freshStore();
    const a = create(s, { title: 'Gala venue' });
    const b = create(s, { title: 'Deposit decision', deps: [{ to: a.id, type: 'discovered_from' as const }] });
    s.linkTickets(builder, a.id, b.id, 'blocks', 'add');
    triage(s, b.id);
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
    triage(s, a.id);
    s.updateTicket(builder, { ticket_id: a.id, note: 'venue booked, wrapping up', status: 'in_progress' });
    s.recordSpend(builder, b.id, { tokens: 12345, cost_usd: 1.25, note: 'metered post-close by the harness' });
    s.createTicket(builder, { title: 'Standing sweep', body: 'recurring', workstream: 'helmo-dev', type: 'ops', schedule: 'every 1h' });
    expect(s.materializeDue(new Date(Date.now() + 61 * 60_000)).length).toBe(1);
    s.setWorkstream(orch, { name: 'helmo-dev', goal: 'the gala happens', budget_usd: 100 });
    s.setWorkstream(orch, { name: 'helmo-dev', budget_usd: 120 }); // partial update must replay identically
    s.disposeHygieneFinding(orch, { check: 'spend_anomaly', ticket_id: b.id, reason: 'whole-session metering; explained in the 08-06 meeting' });

    const before = s.dumpState();
    s.rebuild();
    const after = s.dumpState();
    expect(after).toEqual(before);
  });
});

describe('write contention', () => {
  it('skip-if-open holds against a twin being committed by another process (H-169)', async () => {
    // The H-169 shape: another process has already spawned this slot's instance
    // but not yet committed when we run our check. The check must wait for the
    // lock (one IMMEDIATE transaction with the insert), then see the open twin.
    const dir = mkdtempSync(join(tmpdir(), 'helmo-twins-'));
    const dbPath = join(dir, 'helmo.db');
    const s = new Store(dbPath);
    const t = s.createTicket(builder, { title: 'Sweep', body: 'standing', workstream: 'helmo-dev', type: 'ops', schedule: 'every 1d' });
    const holder = spawn(process.execPath, [
      '-e',
      `const D=require('better-sqlite3');const db=new D(process.argv[1]);db.pragma('journal_mode = WAL');` +
        `db.prepare('BEGIN IMMEDIATE').run();` +
        `db.prepare("INSERT INTO tickets (id,title,workstream,type,created_at,updated_at) VALUES ('H-99','Sweep — twin','helmo-dev','ops','2026-01-01','2026-01-01')").run();` +
        `db.prepare("INSERT INTO deps (from_id,to_id,type) VALUES ('H-99',?,'parent')").run(process.argv[2]);` +
        `setTimeout(()=>{db.prepare('COMMIT').run();db.close();},400);`,
      dbPath, t.id,
    ], { cwd: new URL('..', import.meta.url).pathname });
    await new Promise((r) => setTimeout(r, 150)); // holder has inserted, not committed

    const spawned = s.materializeDue(new Date(Date.now() + 25 * 60 * 60_000));
    expect(spawned).toEqual([]); // waited, then saw the twin
    holder.kill();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('waits out a lock another process holds instead of failing instantly', async () => {
    // The contending writer has to be a real second process: better-sqlite3 is
    // synchronous, so an in-process holder could never commit while we blocked
    // waiting for it. Regression guard for H-134, where a loop died outright
    // because a busy store threw instead of waiting.
    const dir = mkdtempSync(join(tmpdir(), 'helmo-contention-'));
    const dbPath = join(dir, 'helmo.db');
    const s = new Store(dbPath); // migrate first, so we time a write and not the open

    const holdMs = 400;
    const holder = spawn(process.execPath, [
      '-e',
      `const D=require('better-sqlite3');const db=new D(process.argv[1]);` +
        `db.pragma('journal_mode = WAL');db.prepare('BEGIN IMMEDIATE').run();` +
        `setTimeout(()=>{db.prepare('COMMIT').run();db.close();},${holdMs});`,
      dbPath,
    ], { cwd: new URL('..', import.meta.url).pathname });
    await new Promise((r) => setTimeout(r, 150)); // let it take the lock

    const started = Date.now();
    const t = create(s);
    const waited = Date.now() - started;

    expect(t.id).toMatch(/^H-\d+$/);
    expect(waited).toBeGreaterThan(100); // it really did block on the lock
    holder.kill();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the roadmap seam (H-172): project tag and standing notice', () => {
  it('tickets carry an optional project tag, filterable, clearable with empty string', () => {
    const s = freshStore();
    const tagged = create(s, { project: 'R-4' });
    const plain = create(s);
    expect(s.getTicket(tagged.id).project).toBe('R-4');
    expect(s.getTicket(plain.id).project).toBeNull();

    const hits = s.listTickets({ project: 'R-4' });
    expect(hits.map((t) => t.id)).toEqual([tagged.id]);

    s.updateTicket(reviewer, { ticket_id: plain.id, note: 'this is roadmap work', project: 'R-4' });
    expect(s.listTickets({ project: 'R-4' })).toHaveLength(2);

    s.updateTicket(reviewer, { ticket_id: tagged.id, note: 'mistagged', project: '' });
    expect(s.getTicket(tagged.id).project).toBeNull();
  });

  it('the notice is operator steering: agent writes rejected, provenance required, empty clears', () => {
    const s = freshStore();
    expect(() => s.setNotice(builder, { text: 'ship X', provenance: 'p' })).toThrow(HelmoError);
    expect(() => s.setNotice(orch, { text: 'ship X', provenance: ' ' })).toThrow(/provenance/);

    s.setNotice(orch, { text: 'SHIP NEXT: R-4 (roadmap)', provenance: 'decided by arthur 2026-08-24, recorded by mason' });
    expect(s.getNotice()?.text).toContain('R-4');

    s.setNotice(orch, { text: '', provenance: 'cleared after R-4 shipped' });
    expect(s.getNotice()).toBeNull();
  });

  it('project tag and notice survive rebuild', () => {
    const s = freshStore();
    const t = create(s, { project: 'R-1' });
    s.updateTicket(reviewer, { ticket_id: t.id, note: 'retag', project: 'R-2' });
    s.setNotice(orch, { text: 'ship R-2', provenance: 'arthur, meeting' });
    const before = s.dumpState();
    s.rebuild();
    expect(s.dumpState()).toEqual(before);
    expect(s.getTicket(t.id).project).toBe('R-2');
  });
});
