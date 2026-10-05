import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';
import type { LaunchJournalEntry } from './launch-journal.js';

type State = 'observed' | 'measured_zero' | 'not_observed' | 'unsupported' | 'malformed/refused';
const field = (state: State, value: unknown, source: string) => ({ state, value, source });

export function readTicketLaunches(loops: string[], ticketId: string): { launches: LaunchJournalEntry[]; malformed: number } {
  const launches: LaunchJournalEntry[] = [];
  let malformed = 0;
  for (const loop of loops) {
    const dir = join(stateDir(loop), 'launches');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(value => value.endsWith('.json'))) {
      try {
        const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as LaunchJournalEntry;
        if (value.format !== 1 || !value.launch_id || !['intent', 'admitted', 'dispatching', 'complete', 'quarantined'].includes(value.phase)) throw new Error('malformed');
        if (value.ticket_id === ticketId) launches.push(value);
      } catch { malformed += 1; }
    }
  }
  return { launches: launches.sort((a, b) => a.intent_at.localeCompare(b.intent_at)), malformed };
}

export function sessionTrace(ticket: Record<string, unknown>, launches: LaunchJournalEntry[], malformed: number): object {
  const installation = String((ticket['installation'] as { label?: string } | undefined)?.label ?? '');
  const id = String(ticket['id'] ?? '');
  const events = Array.isArray(ticket['events']) ? ticket['events'] as Record<string, unknown>[] : [];
  const deps = ticket['deps'] as { outgoing?: { to_id?: string; type?: string }[] } | undefined;
  const blockers = Array.isArray(ticket['blockers']) ? ticket['blockers'] as { id?: string; assignee?: string | null; needs_human?: boolean }[] : [];
  const blockerIds = blockers.map(value => value.id).filter(Boolean);
  const status = String(ticket['status'] ?? '');
  const nextOwner = status === 'awaiting_human' ? 'human'
    : blockers.length ? blockers.map(value => ({ ticket: value.id, owner: value.needs_human ? 'human' : value.assignee ?? null }))
      : ticket['assignee'] ? String(ticket['assignee']) : null;
  const wait = status === 'awaiting_human' ? ((ticket['action'] ? 'action_requested' : 'decision_requested'))
    : blockerIds.length ? 'dependency_blocked' : null;
  return {
    schema: 'helmo.session-trace.v1', content: 'excluded',
    ticket: field('observed', `${id}@${installation}`, `work:${id}`),
    next_owner: field(nextOwner === null ? 'not_observed' : 'observed', nextOwner, `work:${id}:state`),
    wait_reason: field(wait === null ? 'not_observed' : 'observed', wait, `work:${id}:state`),
    blockers: field(blockerIds.length ? 'observed' : 'not_observed', blockerIds, `work:${id}:deps`),
    malformed_launch_records: field(malformed ? 'malformed/refused' : 'measured_zero', malformed, 'runtime:launch-journals'),
    launches: launches.map(launch => {
      const event = events.find(value => (value['actor'] as Record<string, unknown> | undefined)?.['generation'] === launch.launch_id);
      const session = launch.session;
      return {
        launch_id: field('observed', launch.launch_id, 'runtime:launch-journal'),
        loop_session: field('observed', launch.launch_id.split(':').slice(0, 2).join(':'), 'runtime:launch-id'),
        provider: field(session ? 'observed' : 'not_observed', session?.provider ?? null, 'runtime:launch-journal'),
        model: field(session ? 'observed' : 'not_observed', session?.model ?? null, 'runtime:launch-journal'),
        provider_session_id: field(session?.provider_session_id_state === 'observed' ? 'observed' : session ? 'unsupported' : 'not_observed', session?.provider_session_id ?? null, 'runtime:launch-journal'),
        timing: field(session ? 'observed' : 'not_observed', session ? { started_at: session.started_at, ended_at: session.ended_at } : null, 'runtime:launch-journal'),
        outcome: field(session ? 'observed' : 'not_observed', session?.outcome ?? null, 'runtime:launch-journal'),
        usage: field(session?.tokens === 0 && session?.cost_usd === 0 ? 'measured_zero' : session && (session.tokens !== undefined || session.cost_usd !== undefined) ? 'observed' : 'not_observed', session ? { tokens: session.tokens ?? null, cost_usd: session.cost_usd ?? null } : null, 'runtime:launch-journal'),
        work_event: field(event ? 'observed' : 'not_observed', event ? { seq: event['seq'], type: event['event_type'], at: event['ts'] } : null, event ? `work:event:${event['seq']}` : 'work:event'),
        source_revision: field('unsupported', null, 'runtime:launch-journal'),
        served_context: field('unsupported', null, 'runtime:launch-journal'),
      };
    }),
  };
}
