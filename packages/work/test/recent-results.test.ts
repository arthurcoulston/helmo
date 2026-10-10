// The past-24-hours results reading, case by case against
// `crew:projects/r39/RECENT-RESULTS-CONTRACT.md` §4.
//
// Two halves, deliberately. The window and the row projection are proved
// against hand-built tickets, because the boundary cases need `closed_at` at
// an exact offset from a fixed `as_of` and the store writes that field from
// its own clock. The account itself is then proved through the REAL write
// paths — store, MCP tool, CLI — and read back out of the served document,
// because a field that only survives a fixture is a field the widget cannot
// rely on.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, describe, expect, it } from 'vitest';
import { recentResults, RECENT_RESULTS_LIMIT } from '../src/presentation.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/tools.js';
import { Actor, CompletionAccount, Evidence, Ticket } from '../src/types.js';

/** The contract's immutable reading instant (§4). Every offset below is from
 *  this, so a failure names a boundary rather than a date. */
const AS_OF = '2026-10-09T21:31:48.371Z';
const hoursBefore = (hours: number) => new Date(new Date(AS_OF).getTime() - hours * 3_600_000).toISOString();

const builder: Actor = { name: 'mason', kind: 'agent', model: 'claude-opus-5', version: '0.6', session: 'rev:mason' };
const NOT_REQUESTED = { state: 'not_requested', reason: 'no_completion' };
const noAcceptance = () => NOT_REQUESTED;

function fixture(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    title: 'The work', body: '', workstream: 'estate-ui', project: null, type: 'build', labels: [],
    status: 'done', priority: 2, assignee: null, evidence: [], confidence: null, uncertainty_note: null,
    blast_radius: 'none', question: null, action: null, tokens_total: 0, cost_usd_total: 0, schedule: null,
    not_before: null, needs_human: false, sitting: null, sitting_with: null, release_handoff: null, lane: null,
    capacity_hold: null, workflow_attempt_id: null, completion_account: null,
    created_at: hoursBefore(48), updated_at: hoursBefore(1), closed_at: hoursBefore(1),
    ...partial,
  };
}

function account(category: CompletionAccount['category'], summary: string): CompletionAccount {
  return { category, summary, author: 'mason', recorded_at: hoursBefore(1) };
}

const commit: Evidence = { kind: 'commit', ref: 'helmo@abc1234', note: 'The change', role: 'result' };
const reviewUrl: Evidence = { kind: 'url', ref: 'https://x.example/REVIEW.md', role: 'review' };
const resultFile: Evidence = { kind: 'file', ref: 'crew:projects/r39/RECENT-RESULTS-CONTRACT.md', role: 'result' };

/* The contract's six records, in its own order. */
const SIX: Ticket[] = [
  fixture({
    id: 'H-1', closed_at: hoursBefore(1), evidence: [commit], blast_radius: 'published',
    completion_account: account('improvement', 'The operator can read what got done in the past day without opening a ticket.'),
  }),
  fixture({
    id: 'H-2', closed_at: hoursBefore(2),
    completion_account: account('maintenance', 'The obsolete importer is gone, so nothing depends on it any more.'),
  }),
  fixture({
    id: 'H-3', closed_at: hoursBefore(3), type: 'review', evidence: [reviewUrl],
    completion_account: account('review', 'The release candidate was checked against its manifest; one gap found, recorded on its own ticket.'),
  }),
  fixture({
    id: 'H-4', closed_at: hoursBefore(4), type: 'writing', evidence: [resultFile],
    completion_account: account('documentation_content', 'The results contract is written down for the implementer, in the r39 project directory.'),
  }),
  fixture({ id: 'H-5', closed_at: hoursBefore(5), type: 'build' }),
  fixture({
    id: 'H-6', closed_at: hoursBefore(24), evidence: [{ kind: 'url', ref: 'https://example.test/out', role: 'result' }],
    completion_account: account('feature', 'Out of the window by exactly one day.'),
  }),
];

const read = (tickets: Ticket[], asOf = AS_OF) => recentResults(tickets, asOf, noAcceptance);
const ids = (tickets: Ticket[], asOf = AS_OF) => read(tickets, asOf).rows.map((r) => r.id);

describe('the past-24-hours window (§1)', () => {
  it('states the window it read rather than leaving it to the browser', () => {
    const results = read(SIX);
    expect(results.as_of).toBe(AS_OF);
    expect(results.window_started_at).toBe(hoursBefore(24));
    expect(results.limit).toBe(RECENT_RESULTS_LIMIT);
  });

  it('includes the five records inside it, newest first, and excludes the one on the lower bound', () => {
    expect(ids(SIX)).toEqual(['H-1', 'H-2', 'H-3', 'H-4', 'H-5']);
  });

  it('includes a record closed at exactly as_of, and excludes one a millisecond later', () => {
    const atInstant = fixture({ id: 'H-7', closed_at: AS_OF });
    expect(ids([atInstant])).toEqual(['H-7']);
    const after = fixture({ id: 'H-8', closed_at: new Date(new Date(AS_OF).getTime() + 1).toISOString() });
    expect(ids([after])).toEqual([]);
  });

  it('excludes cancelled work, which is not a result', () => {
    expect(ids([fixture({ id: 'H-9', status: 'cancelled', closed_at: hoursBefore(1) })])).toEqual([]);
  });

  it('drops a reopened record while it is open, and returns it at its later close', () => {
    const reopened = fixture({ id: 'H-1', status: 'open', closed_at: null, completion_account: SIX[0]!.completion_account });
    expect(ids([reopened, ...SIX.slice(1)])).toEqual(['H-2', 'H-3', 'H-4', 'H-5']);
    const reclosed = fixture({ ...reopened, status: 'done', closed_at: hoursBefore(0.5) });
    const rows = read([reclosed, ...SIX.slice(1)]).rows;
    expect(rows.filter((r) => r.id === 'H-1')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'H-1', closed_at: hoursBefore(0.5) });
  });

  it('counts every eligible record, draws six, and leaves the rest to be linked', () => {
    const seven = Array.from({ length: 7 }, (_, i) => fixture({ id: `H-${10 + i}`, closed_at: hoursBefore(i + 1) }));
    const results = read(seven);
    expect(results.total).toBe(7);
    expect(results.rows).toHaveLength(6);
    expect(results.total - results.rows.length).toBe(1);
  });

  it('breaks a tie on closed_at by numeric id, descending', () => {
    const tied = ['H-2', 'H-11', 'H-3'].map((id) => fixture({ id, closed_at: hoursBefore(2) }));
    expect(ids(tied)).toEqual(['H-11', 'H-3', 'H-2']);
  });
});

describe('what each row says (§3)', () => {
  const row = (id: string) => read(SIX).rows.find((r) => r.id === id)!;

  it('H-1 carries the author’s own words, its category, its result and both states', () => {
    expect(row('H-1')).toMatchObject({
      summary: 'The operator can read what got done in the past day without opening a ticket.',
      category: 'improvement', category_source: 'recorded', author: 'mason',
      acceptance: NOT_REQUESTED, blast_radius: 'published',
    });
    expect(row('H-1').results).toEqual([{ kind: 'commit', ref: 'helmo@abc1234', note: 'The change' }]);
  });

  it('H-2 shows its account and records no result rather than inventing one', () => {
    expect(row('H-2')).toMatchObject({ category: 'maintenance', category_source: 'recorded' });
    expect(row('H-2').results).toEqual([]);
  });

  it('H-3 keeps a review-only URL out of the result position', () => {
    expect(row('H-3').category).toBe('review');
    expect(row('H-3').results).toEqual([], 'a review-role item stays review evidence and is never promoted');
  });

  it('H-4 makes a file the result, undemoted for being a file', () => {
    expect(row('H-4').results).toEqual([{ kind: 'file', ref: resultFile.ref }]);
  });

  it('H-5 stays honestly incomplete: no account, no category, no result', () => {
    expect(row('H-5')).toMatchObject({ summary: null, category: null, category_source: null, author: null, recorded_at: null });
    expect(row('H-5').results).toEqual([]);
  });

  it('carries every recorded result, the action first, and hides none', () => {
    const second: Evidence = { kind: 'url', ref: 'https://example.test/also', role: 'result' };
    const t = fixture({ id: 'H-30', closed_at: hoursBefore(1), evidence: [commit, second] });
    // `resultDisplay` gives the action to the latest append; both stay on screen.
    expect(read([t]).rows[0]!.results.map((r) => r.ref)).toEqual([second.ref, commit.ref]);
  });

  it('labels a legacy result the frozen fallback placed, rather than presenting a guess as a record', () => {
    const t = fixture({ id: 'H-31', closed_at: hoursBefore(1), evidence: [{ kind: 'url', ref: 'https://example.test/legacy' }] });
    expect(read([t]).rows[0]!.results).toEqual([{ kind: 'url', ref: 'https://example.test/legacy', inferred: true }]);
  });

  it('a later verdict changes only the review label, never the window or the account', () =>{

    const accepted = recentResults(SIX, AS_OF, (id) => (id === 'H-1' ? { state: 'accepted', reason: 'independently_accepted' } : NOT_REQUESTED));
    expect(accepted.rows.map((r) => r.id)).toEqual(ids(SIX));
    expect(accepted.rows[0]).toMatchObject({ acceptance: { state: 'accepted' }, summary: read(SIX).rows[0]!.summary });
  });
});

describe('a legacy record’s category (§2)', () => {
  it('maps only the five types the contract names, and leaves every other uncategorised', () => {
    const typed = (type: string) => read([fixture({ id: 'H-20', type, closed_at: hoursBefore(1) })]).rows[0]!;
    expect(typed('research')).toMatchObject({ category: 'research', category_source: 'type' });
    expect(typed('planning')).toMatchObject({ category: 'planning_design', category_source: 'type' });
    expect(typed('writing')).toMatchObject({ category: 'documentation_content', category_source: 'type' });
    expect(typed('ops')).toMatchObject({ category: 'operations', category_source: 'type' });
    expect(typed('review')).toMatchObject({ category: 'review', category_source: 'type' });
    for (const type of ['build', 'bug', 'incident', 'feature', 'improvement']) {
      expect(typed(type)).toMatchObject({ category: null, category_source: null });
    }
  });

  it('never promotes a title, note or evidence note into a summary', () => {
    const legacy = fixture({ id: 'H-21', title: 'Shipped the thing', closed_at: hoursBefore(1), evidence: [commit] });
    expect(read([legacy]).rows[0]!.summary).toBeNull();
  });

  it('prefers the recorded account over the compatibility map for a mapped type', () => {
    const t = fixture({ id: 'H-22', type: 'ops', closed_at: hoursBefore(1), completion_account: account('bug_fix', 'The gate now fires on the case it was written for.') });
    expect(read([t]).rows[0]!).toMatchObject({ category: 'bug_fix', category_source: 'recorded' });
  });
});

describe('the account through the real write and read paths', () => {
  const open = (s: Store) => s.createTicket(builder, { title: 'Build it', body: 'Goal.', workstream: 'estate-ui', type: 'build', status: 'in_progress' });
  const SUMMARY = 'Agents now state the outcome of their work when they close it, so the record says what got done.';

  it('refuses an ordinary close with no account, and accepts a cancel without one', () => {
    const s = new Store(':memory:');
    const t = open(s);
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'finished', status: 'done' })).toThrow(/needs a completion_account/);
    expect(s.getTicket(t.id).status).toBe('in_progress');
    expect(s.updateTicket(builder, { ticket_id: t.id, note: 'not worth it', status: 'cancelled' }).ticket.completion_account).toBeNull();
  });

  it('stamps the author and the event time itself, and refuses a caller that states either', () => {
    const s = new Store(':memory:');
    const t = open(s);
    const { ticket } = s.updateTicket(builder, { ticket_id: t.id, note: 'shipped', status: 'done', completion_account: { category: 'feature', summary: SUMMARY }, evidence: [commit] });
    expect(ticket.completion_account).toMatchObject({ category: 'feature', summary: SUMMARY, author: 'mason' });
    expect(ticket.completion_account!.recorded_at).toBe(ticket.updated_at);
    const other = open(s);
    for (const field of ['author', 'recorded_at']) {
      expect(() => s.updateTicket(builder, {
        ticket_id: other.id, note: 'shipped', status: 'done',
        completion_account: { category: 'feature', summary: SUMMARY, [field]: 'someone else' } as never,
      })).toThrow(new RegExp(`completion_account.${field} is Helmo's`));
    }
  });

  it('refuses a category outside the ten, an empty summary and one over the ceiling', () => {
    const s = new Store(':memory:');
    const close = (completion_account: unknown) => s.updateTicket(builder, { ticket_id: open(s).id, note: 'shipped', status: 'done', completion_account: completion_account as never });
    expect(() => close({ category: 'build', summary: SUMMARY })).toThrow(/not a work category/);
    expect(() => close({ category: 'feature', summary: '   ' })).toThrow(/summary is required/);
    expect(() => close({ category: 'feature', summary: 'x'.repeat(281) })).toThrow(/is 281 characters/);
    // Measured in code points, so an account written in astral characters is
    // the length its author sees rather than twice it.
    expect(() => close({ category: 'feature', summary: '𝚡'.repeat(281) })).toThrow(/is 281 characters/);
    expect(close({ category: 'feature', summary: '𝚡'.repeat(280) }).ticket.completion_account!.summary).toHaveLength(560);
  });

  it('trims the summary and refuses swallowed tool-call markup in it', () => {
    const s = new Store(':memory:');
    expect(s.updateTicket(builder, { ticket_id: open(s).id, note: 'shipped', status: 'done', completion_account: { category: 'feature', summary: `  ${SUMMARY}  ` } }).ticket.completion_account!.summary).toBe(SUMMARY);
    expect(() => s.updateTicket(builder, {
      ticket_id: open(s).id, note: 'shipped', status: 'done',
      completion_account: { category: 'feature', summary: `${SUMMARY}</summary` + '><parameter name="note">' },
    })).toThrow(/mis-serialized/);
  });

  it('accepts a correction on a terminal ticket, keeps both readings in history, and replays to the latest', () => {
    const s = new Store(':memory:');
    const t = open(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'shipped', status: 'done', completion_account: { category: 'feature', summary: SUMMARY }, evidence: [commit] });
    const truer = 'Closing work now records the outcome, which is what the operator reads in his results list.';
    s.updateTicket(builder, { ticket_id: t.id, note: 'a truer sentence for it', completion_account: { category: 'improvement', summary: truer } });
    expect(s.getTicket(t.id).completion_account).toMatchObject({ category: 'improvement', summary: truer });
    const accounts = s.getEvents(t.id)
      .map((e) => (e.payload['diffs'] as Record<string, { to: CompletionAccount }> | undefined)?.['completion_account']?.to)
      .filter(Boolean);
    expect(accounts.map((a) => a!.summary)).toEqual([SUMMARY, truer]);
    s.rebuild();
    expect(s.getTicket(t.id).completion_account).toMatchObject({ category: 'improvement', summary: truer });
    // Still terminal for everything else, account or not.
    expect(() => s.updateTicket(builder, { ticket_id: t.id, note: 'retitle', title: 'Something else' })).toThrow(/terminal/);
  });

  it('lets an account recorded on live work stand as the close account', () => {
    // Two calls, not one: an author who has the sentence before the evidence
    // is in records it, and closing does not ask again (contract §2).
    const s = new Store(':memory:');
    const t = open(s);
    s.updateTicket(builder, { ticket_id: t.id, note: 'the outcome, while I finish the proof', completion_account: { category: 'feature', summary: SUMMARY } });
    expect(s.getTicket(t.id).status).toBe('in_progress');
    expect(s.updateTicket(builder, { ticket_id: t.id, note: 'proved and closed', status: 'done', evidence: [commit] }).ticket.completion_account!.summary).toBe(SUMMARY);
  });

  it("keeps a human's own answer valid without an account, and shows it as missing", () => {
    // The one close that is still legitimate without an account (contract §2).
    // Requiring one here would mean an agent writing a sentence in Arthur's
    // name about work he resolved himself.
    const s = new Store(':memory:');
    const t = open(s);
    s.returnToHuman(builder, t.id, { situation: 'Blocked on a decision.', question: 'Is this covered already?', recommendation: 'Close it as covered.' });
    const answered = s.answerTicket({ name: 'Arthur Coulston', kind: 'human' }, t.id, { answer: 'Already covered; nothing more to do.', resolution: 'done' });
    expect(answered).toMatchObject({ status: 'done', completion_account: null });
    const row = recentResults(s.listTickets({ limit: -1 }), new Date().toISOString(), noAcceptance).rows.find((r) => r.id === t.id)!;
    expect(row).toMatchObject({ summary: null, category: null, category_source: null, author: null });
  });

  it('survives the MCP tool and appears in the served results document', async () => {
    const s = new Store(':memory:');
    const t = open(s);
    const server = new McpServer({ name: 'helmo', version: 'test' });
    buildServer(s, builder, server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const refused = await client.callTool({ name: 'helmo_update_ticket', arguments: { ticket_id: t.id, note: 'shipped', status: 'done' } });
    expect(JSON.stringify(refused.content)).toMatch(/needs a completion_account/);
    const done = await client.callTool({
      name: 'helmo_update_ticket',
      arguments: { ticket_id: t.id, note: 'shipped', status: 'done', completion_account: { category: 'feature', summary: SUMMARY }, evidence: [commit] },
    });
    expect(done.isError).toBeFalsy();
    await client.close();
    const row = recentResults(s.listTickets({ limit: -1 }), new Date().toISOString(), noAcceptance).rows.find((r) => r.id === t.id)!;
    expect(row).toMatchObject({ summary: SUMMARY, category: 'feature', category_source: 'recorded', author: 'mason' });
  });
});

describe('the account through the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmo-results-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
    env: { ...process.env, HELMO_DB: join(dir, 'helmo.db'), HELMO_ACTOR: JSON.stringify(builder) },
  }));

  it('refuses half an account, refuses a close without one, and records a whole one', () => {
    const { id } = cli('create', '--title', 'Build it', '--body', 'Goal.', '--workstream', 'estate-ui', '--type', 'build', '--status', 'in_progress');
    expect(() => cli('update', '--ticket', id, '--note', 'shipped', '--status', 'done', '--completion-category', 'feature')).toThrow(/must be passed together/);
    expect(() => cli('update', '--ticket', id, '--note', 'shipped', '--status', 'done')).toThrow(/needs a completion_account/);
    const summary = 'The CLI can record what the work produced, so a terminal session is not a second-class writer.';
    expect(cli('update', '--ticket', id, '--note', 'shipped', '--status', 'done', '--completion-category', 'improvement', '--completion-summary', summary, '--evidence-kind', 'commit', '--evidence-ref', 'helmo@abc1234', '--evidence-role', 'result').status).toBe('done');
    expect(cli('get', '--ticket', id).completion_account).toMatchObject({ category: 'improvement', summary, author: 'mason' });
  });
});
