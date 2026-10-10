/* Team now: which agents are working, awaiting work, blocked or stopped — the
   roll-up behind Overview's condensed roster (R-44, H-3091).

   Rev already owns the truth about a loop: `state()` in view.ts applies the
   sentinel precedence and the pid identity, and Runtime's table prints the word
   it returns. This file does one thing on top of that: it answers the question
   Arthur asked at a glance, which is about an AGENT and not a process.

   Three distinctions the mapping below exists to keep, because collapsing any
   of them is a way to read the fleet wrongly:

   - **Having nothing to do is not being unable to work.** `IDLE` is a session
     that polled and found no ready work; `BLOCKED`, `LIMIT` and `BACKOFF` are
     sessions that cannot draw work at all. Both look like "not running" from
     outside, and only the first is the fleet working as intended.
   - **A decision is not a fault.** `STOP`, `HOLD` and `PARKED` are somebody's
     instruction and `halted` is a loop nothing has started; none of them is a
     problem to be alarmed about. `WEDGED` and `CRASHED` are.
   - **An unread state is not a known one.** A session whose process cannot be
     inspected reports `UNKNOWN`, and a state word this build has never heard of
     is in the same position: both say the reading failed, which is the one
     thing that must never be redrawn as a quiet default.

   Nothing here infers a state from an absence. A session with no process and no
   marker is `halted` because Rev says so — not because this file looked for a
   heartbeat and did not find one. */

/** What a reader of the glance view sees. Six, not four: Arthur asked for
 *  Working / Awaiting work / Blocked / Stopped, and the two extra are the
 *  states that must not be folded into those — an unexpected failure keeps its
 *  own word, and a reading that could not be taken says so. */
export type AgentState = 'working' | 'awaiting' | 'blocked' | 'stopped' | 'failed' | 'unknown';

/** One session's state as Rev reports it, before this file judges anything.
 *  `agent` is the seat — the accountable Helmo role — and `session` the loop
 *  that serves it; they are equal for every single-session seat. */
export type SessionReading = {
  session: string;
  agent: string;
  source_state: string;
  workstream: string;
  detail: string | null;
};

export type SessionNow = SessionReading & { state: AgentState };

/** A ticket an agent is holding in progress. Two fields and no more: this is a
 *  link out of the glance view, and the Work record is where the rest lives. */
export type HeldWork = { id: string; title: string };

export type AgentNow = {
  agent: string;
  state: AgentState;
  /** Rev's own word for the state that decided the roll-up (`RUNNING`,
   *  `PARKED`, …), kept beside the display state so a reader of the disclosure
   *  can tell which session the chip is about and nothing is lost in the
   *  translation. */
  source_state: string;
  detail: string | null;
  sessions: SessionNow[];
  work: HeldWork[];
};

export type TeamNowData = {
  as_of: string;
  agents: AgentNow[];
  /** Set when the roster or the state directory could not be read. The agent
   *  list is then empty and means nothing — an empty roster and an unreadable
   *  one are opposite readings, and only this field tells them apart. */
  unavailable?: string;
};

/* Rev's state word to the display state. Written as a table rather than a
   chain of conditions so the whole mapping can be read at once and so a state
   missing from it is visible.

   `SEAT_HELD` is Awaiting work rather than Stopped: the worker is up and
   available, and what it is waiting for is the seat's current holder to finish
   — the same situation as an idle poll, with a different reason. Its reason
   travels with it either way.

   `LIMIT` and `BACKOFF` are Blocked, which is the one judgment here a reviewer
   should weigh. Both carry a recorded obstacle (a provider's capacity reply, a
   restart streak) and neither is anybody's decision, so neutral would be
   wrong; both also recover on their own, so Blocked slightly overstates them.
   The source state travels with the row, so the overstatement is readable
   rather than hidden — and it is the direction that keeps the significance of
   a fleet that cannot draw work. */
const DISPLAY: Record<string, AgentState> = {
  RUNNING: 'working',
  IDLE: 'awaiting',
  SEAT_HELD: 'awaiting',
  BLOCKED: 'blocked',
  LIMIT: 'blocked',
  BACKOFF: 'blocked',
  WEDGED: 'failed',
  CRASHED: 'failed',
  STOP: 'stopped',
  HOLD: 'stopped',
  PARKED: 'stopped',
  halted: 'stopped',
  UNKNOWN: 'unknown',
};

/** The display state for one of Rev's state words. An unrecognised word is
 *  `unknown` and never `stopped`: a state this build does not know is a
 *  reading it cannot make, and the quiet default would be the version of this
 *  function that reports a future sentinel as a deliberate stop. */
export function displayState(source: string): AgentState {
  return Object.hasOwn(DISPLAY, source) ? DISPLAY[source]! : 'unknown';
}

/* Which state wins when one agent's sessions disagree. Severity order, so a
   seat with a wedged worker and a running one reads as failed: the roll-up
   exists to make a blockage harder to miss, not to summarise it away.

   `unknown` outranks `working` deliberately. A session whose state could not be
   read may be in any state including a failed one, so a healthy sibling must
   not cover for it — the convenient reading is exactly the one that would hide
   a fault. */
const RANK: AgentState[] = ['failed', 'blocked', 'unknown', 'working', 'awaiting', 'stopped'];

export function rankOf(state: AgentState): number {
  return RANK.indexOf(state);
}

/** The condensed roster: one entry per accountable agent, in roster order.
 *
 *  `work` is keyed by agent name and supplied by the caller — the tickets a
 *  seat holds come from the work record, which the runtime does not read
 *  (R-47 C1). An agent with no entry holds nothing; it is never a lookup
 *  failure, because a seat with no claim is the ordinary case.
 *
 *  `as_of` travels with the rows for the same reason the results card's window
 *  does: a document held over from a failed refresh must label the instant it
 *  describes rather than be redrawn against the reader's clock. */
export function teamNow(sessions: SessionReading[], work: Record<string, HeldWork[]>, asOf: string): TeamNowData {
  const order: string[] = [];
  const grouped = new Map<string, SessionNow[]>();
  for (const session of sessions) {
    const rows = grouped.get(session.agent);
    if (rows) rows.push({ ...session, state: displayState(session.source_state) });
    else {
      order.push(session.agent);
      grouped.set(session.agent, [{ ...session, state: displayState(session.source_state) }]);
    }
  }
  return {
    as_of: asOf,
    agents: order.map((agent) => {
      const rows = grouped.get(agent)!;
      // The first session at the worst rank, not a summary of all of them: the
      // chip's words and its reason have to come from one real session, or the
      // reason explains a state some other worker is in.
      const deciding = rows.reduce((worst, row) => (rankOf(row.state) < rankOf(worst.state) ? row : worst), rows[0]!);
      return {
        agent,
        state: deciding.state,
        source_state: deciding.source_state,
        detail: deciding.detail,
        sessions: rows,
        work: Object.hasOwn(work, agent) ? work[agent]! : [],
      };
    }),
  };
}
