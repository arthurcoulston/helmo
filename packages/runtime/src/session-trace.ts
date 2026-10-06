import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { namesResolvedInstallation, type InstallationConfig } from '@helmo/core';
import { stateDir } from './config.js';
import type { LaunchJournalEntry } from './launch-journal.js';

type State = 'observed' | 'measured_zero' | 'not_observed' | 'unsupported' | 'malformed/refused';
const field = (state: State, value: unknown, source: string) => ({ state, value, source });

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value));
const launchIdentifier = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 512 && /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+){2,}$/.test(value);
const ticketIdentifier = (value: unknown): value is string => typeof value === 'string' && /^H-\d+$/.test(value);
const sessionIdentifier = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const finiteUsage = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const eventCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** The measured seat-window attribution: ticket ids and event counts only. */
const touchedTickets = (value: unknown): value is { id: string; events: number }[] => Array.isArray(value)
  && value.every(entry => record(entry) && ticketIdentifier(entry.id) && eventCount(entry.events)
    && Object.keys(entry).length === 2);

const PROVIDER_SESSION_STATES = ['observed', 'unsupported'] as const;
const SESSION_OUTCOMES = ['ok', 'transient', 'apparatus', 'failure'] as const;
const LAUNCH_PHASES = ['intent', 'admitted', 'dispatching', 'complete', 'quarantined'] as const;
const TICKET_STATUSES = ['open', 'in_progress', 'awaiting_human', 'done', 'cancelled'] as const;
const EVENT_TYPES = ['created', 'updated', 'returned', 'return_withdrawn', 'answered', 'linked', 'unlinked', 'spend', 'workstream_set', 'workstream_renamed', 'hygiene_disposed', 'notice_set', 'product_completed', 'acceptance_verdict', 'release_handoff_recorded', 'acted'] as const;
const WORK_INSTALLATION: InstallationConfig = {
  homeKey: 'HELMO_HOME', dbKey: 'HELMO_DB', defaultHome: '.helmo', defaultDb: 'helmo.db',
  derivedPrefix: 'dev.helmo', homePattern: /^\.helmo([-_.]|$)/, stripPattern: /^\.?helmo(?=[-_.]|$)/,
  release: () => null,
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && allowed.includes(value as T);

function validSession(value: unknown): value is NonNullable<LaunchJournalEntry['session']> {
  if (!record(value) || !name(value.provider) || !name(value.model) || !timestamp(value.started_at)
    || !timestamp(value.ended_at) || !oneOf(value.outcome, SESSION_OUTCOMES)
    || !oneOf(value.provider_session_id_state, PROVIDER_SESSION_STATES)) return false;
  if (value.provider_session_id !== undefined && !sessionIdentifier(value.provider_session_id)) return false;
  if (value.tokens !== undefined && !finiteUsage(value.tokens)) return false;
  if (value.cost_usd !== undefined && !finiteUsage(value.cost_usd)) return false;
  return true;
}

function validatedLaunch(value: unknown): LaunchJournalEntry | null {
  if (!record(value) || value.format !== 1 || !launchIdentifier(value.launch_id)
    || !oneOf(value.phase, LAUNCH_PHASES)
    || !timestamp(value.intent_at)) return null;
  if (value.ticket_id !== undefined && !ticketIdentifier(value.ticket_id)) return null;
  if (value.claim !== undefined && value.claim !== true) return null;
  if (value.event_seq_floor !== undefined && (!Number.isSafeInteger(value.event_seq_floor) || value.event_seq_floor < 0)) return null;
  if (value.touched_tickets !== undefined && !touchedTickets(value.touched_tickets)) return null;
  // A settled launch is not required to name a ticket. A scoped seat claims
  // inside its session and journals no ticket at all, and a claim-intent
  // launch settles complete precisely BECAUSE nothing was claimed; calling
  // either corrupt reported six sound live records as malformed and hid the
  // writer gap behind them (H-2901). An ADMITTED launch is held to its
  // ticket, because workflow admission is granted for one.
  if (value.phase === 'complete' && !timestamp(value.completed_at)) return null;
  if (value.phase === 'quarantined' && !timestamp(value.quarantined_at)) return null;
  if (value.phase === 'complete' && value.dispatching_at !== undefined && value.session === undefined) return null;
  if (value.admission_id !== undefined && !ticketIdentifier(value.ticket_id)) return null;
  if (value.session !== undefined && !validSession(value.session)) return null;
  return {
    format: 1, phase: value.phase, launch_id: value.launch_id, intent_at: value.intent_at,
    ...(value.ticket_id !== undefined ? { ticket_id: value.ticket_id } : {}),
    ...(value.claim === true ? { claim: true as const } : {}),
    ...(value.event_seq_floor !== undefined ? { event_seq_floor: value.event_seq_floor } : {}),
    ...(value.touched_tickets !== undefined ? { touched_tickets: value.touched_tickets } : {}),
    ...(value.phase === 'complete' ? { completed_at: value.completed_at as string } : {}),
    ...(value.phase === 'quarantined' ? { quarantined_at: value.quarantined_at as string } : {}),
    ...(value.session !== undefined ? { session: value.session } : {}),
  };
}

export function readTicketLaunches(loops: string[], ticketId: string): { launches: LaunchJournalEntry[]; malformed: number } {
  const launches: LaunchJournalEntry[] = [];
  let malformed = 0;
  for (const loop of loops) {
    const dir = join(stateDir(loop), 'launches');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter(value => value.endsWith('.json'))) {
      try {
        const value: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        const launch = validatedLaunch(value);
        if (!launch) throw new Error('malformed');
        if (launch.ticket_id === ticketId || launch.touched_tickets?.some(t => t.id === ticketId)) launches.push(launch);
      } catch { malformed += 1; }
    }
  }
  return { launches: launches.sort((a, b) => a.intent_at.localeCompare(b.intent_at)), malformed };
}

export function assertTicketIdentity(ticket: Record<string, unknown>, requested: string): void {
  const at = requested.indexOf('@');
  const requestedId = requested.slice(0, at);
  const requestedInstallation = requested.slice(at + 1);
  const installation = ticket['installation'];
  if (!ticketIdentifier(ticket['id']) || ticket['id'] !== requestedId || !record(installation)
    || !name(installation.label)) throw new Error('mismatched ticket history');
  if (installation.label === requestedInstallation) return;
  if (typeof installation.home !== 'string' || typeof installation.db !== 'string'
    || !namesResolvedInstallation(WORK_INSTALLATION, {
      label: installation.label, home: installation.home, db: installation.db,
      source: 'derived', release: null,
    }, requestedInstallation)) throw new Error('mismatched ticket history');
}

export function sessionTrace(ticket: Record<string, unknown>, launches: LaunchJournalEntry[], malformed: number): object {
  const installationValue = ticket['installation'];
  const installation = record(installationValue) && name(installationValue.label) ? installationValue.label : null;
  const id = ticketIdentifier(ticket['id']) ? ticket['id'] : null;
  const status = oneOf(ticket['status'], TICKET_STATUSES) ? ticket['status'] : null;
  const assignee = ticket['assignee'] === null || name(ticket['assignee']) ? ticket['assignee'] : undefined;
  const action = ticket['action'] === null || record(ticket['action']) ? ticket['action'] : null;
  if (!installation || !id || !status || assignee === undefined
    || (status === 'awaiting_human' && ticket['action'] !== null && !record(ticket['action']))
    || !Array.isArray(ticket['events']) || !Array.isArray(ticket['blockers'])) throw new Error('malformed ticket history');
  const events = ticket['events'].map((value) => {
    if (!record(value) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0
      || !oneOf(value.event_type, EVENT_TYPES) || !timestamp(value.ts) || !record(value.actor)) throw new Error('malformed ticket event');
    const generation = value.actor.generation;
    if (generation !== undefined && !launchIdentifier(generation)) throw new Error('malformed ticket event');
    return { seq: value.seq as number, event_type: value.event_type, ts: value.ts, generation };
  });
  const blockers = ticket['blockers'].map((value) => {
    if (!record(value) || !ticketIdentifier(value.id)
      || !(value.assignee === null || name(value.assignee)) || typeof value.needs_human !== 'boolean') throw new Error('malformed blocker');
    return { id: value.id, assignee: value.assignee, needs_human: value.needs_human };
  });
  const blockerIds = blockers.map(value => value.id);
  const nextOwner = status === 'awaiting_human' ? 'human'
    : blockers.length ? blockers.map(value => ({ ticket: value.id, owner: value.needs_human ? 'human' : value.assignee ?? null }))
      : assignee;
  const wait = status === 'awaiting_human' ? ((action ? 'action_requested' : 'decision_requested'))
    : blockerIds.length ? 'dependency_blocked' : null;
  return {
    schema: 'helmo.session-trace.v1', content: 'excluded',
    ticket: field('observed', `${id}@${installation}`, `work:${id}`),
    next_owner: field(nextOwner === null ? 'not_observed' : 'observed', nextOwner, `work:${id}:state`),
    wait_reason: field(wait === null ? 'not_observed' : 'observed', wait, `work:${id}:state`),
    blockers: field(blockerIds.length ? 'observed' : 'not_observed', blockerIds, `work:${id}:deps`),
    malformed_launch_records: field(malformed ? 'malformed/refused' : 'measured_zero', malformed, 'runtime:launch-journals'),
    launches: launches.map(launch => {
      const event = events.find(value => value.generation === launch.launch_id);
      const session = launch.session;
      // Say which association put this launch on this ticket. A claim
      // identity is the launch's own durable key; a seat-session window is
      // measured over the seat's Work events since this launch opened, and
      // is reported as that and never as an exact key (H-2901).
      const touched = launch.touched_tickets?.find(value => value.id === id);
      const basis = launch.ticket_id === id ? 'launch_claim_identity' : touched ? 'seat_session_event_window' : null;
      return {
        launch_id: field('observed', launch.launch_id, 'runtime:launch-journal'),
        join: field(basis ? 'observed' : 'not_observed', basis ? { basis, ticket_events: touched?.events ?? null } : null,
          basis === 'seat_session_event_window' ? 'runtime:launch-journal:touched_tickets' : 'runtime:launch-journal:ticket_id'),
        loop_session: field('observed', launch.launch_id.split(':').slice(0, 2).join(':'), 'runtime:launch-id'),
        provider: field(session ? 'observed' : 'not_observed', session?.provider ?? null, 'runtime:launch-journal'),
        model: field(session ? 'observed' : 'not_observed', session?.model ?? null, 'runtime:launch-journal'),
        provider_session_id: field(session?.provider_session_id_state === 'observed' ? 'observed' : session ? 'unsupported' : 'not_observed', session?.provider_session_id ?? null, 'runtime:launch-journal'),
        timing: field(session ? 'observed' : 'not_observed', session ? { started_at: session.started_at, ended_at: session.ended_at } : null, 'runtime:launch-journal'),
        outcome: field(session ? 'observed' : 'not_observed', session?.outcome ?? null, 'runtime:launch-journal'),
        usage: field(session?.tokens === 0 && session?.cost_usd === 0 ? 'measured_zero' : session && (session.tokens !== undefined || session.cost_usd !== undefined) ? 'observed' : 'not_observed', session ? { tokens: session.tokens ?? null, cost_usd: session.cost_usd ?? null } : null, 'runtime:launch-journal'),
        work_event: field(event ? 'observed' : 'not_observed', event ? { seq: event.seq, type: event.event_type, at: event.ts } : null, event ? `work:event:${event.seq}` : 'work:event'),
        source_revision: field('unsupported', null, 'runtime:launch-journal'),
        served_context: field('unsupported', null, 'runtime:launch-journal'),
      };
    }),
  };
}
