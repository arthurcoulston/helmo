// The production path from Helmo's deterministic checks to recorded issue
// observations (R-44 H-3216). `hygiene()` answers "what is wrong right now"
// and forgets; the issue log answers "what has been wrong, since when, who
// owns it, and what happened about it". Nothing bridged the two, so every
// issue row the shipped views could show was a fixture.
//
// Two rules from ISSUES-INCIDENTS-CONTRACT.md are load-bearing here and are
// the reason this is a code table rather than anything derived from a finding:
// the next action is a FIXED mapping per check, because a finding's `detail`
// is free text and free text must never become a command; and the stable
// identity is check + subject, because a detail that reads "silent for 31h"
// this hour and "silent for 55h" the next is the same issue, not two.
import type { HygieneFinding, IssueObservationInput } from './store.js';
import type { IssueSubjectKind, RecordedValue } from './issues.js';

/** What to do about each check, written once in code. Each is an action a
 *  reader can carry out without re-deriving the check's intent. */
export const CHECK_NEXT_ACTION: Record<HygieneFinding['check'], string> = {
  stale_claim: 'Inspect the holder, then take the ticket over or release the claim',
  done_without_evidence: 'Add the evidence that proves the work, or correct the closure',
  phantom_block: 'Pick the ticket up now that nothing blocks it, or record what still does',
  aging_question: 'Answer it at the next meeting, or withdraw the ask',
  spend_anomaly: 'Account for the spend on the ticket, or dispose the hygiene finding with a reason',
  priority_inversion: 'Start the higher-priority ticket, or lower its priority to match the plan',
  budget_pressure: 'Front-load the remaining value in this stream, or have the operator reset its budget',
  silent_assignee: 'Record progress in that name, or hand the ticket back to the pool',
  orphan_ticket: 'Repair the row, or remove it with helmo-cli purge-orphan --confirm',
  unseated_pool: 'Give the workstream a seat, or reserve its open work by hand',
  unaccounted_work: 'Add a project tag, an obj: label or one acct: label, and say why in the body',
  awaiting_second_eyes: 'Hand it to a reviewer, or record the verdict that is already in',
};

/** Which checks speak about a workstream rather than a ticket. These two carry
 *  no `ticket_id` at all, so a ticket-shaped subject would record the empty
 *  string as an identity and collapse every stream into one row. */
const WORKSTREAM_CHECKS = new Set<HygieneFinding['check']>(['budget_pressure', 'unseated_pool']);

export interface ObservationSubject {
  kind: IssueSubjectKind;
  ref: string;
}

export function findingSubject(finding: HygieneFinding): ObservationSubject | null {
  if (WORKSTREAM_CHECKS.has(finding.check)) {
    return finding.workstream ? { kind: 'workstream', ref: finding.workstream } : null;
  }
  return finding.ticket_id ? { kind: 'ticket', ref: finding.ticket_id } : null;
}

/** Turn one current finding into an observation input. `owner` is resolved by
 *  the caller, which is the only part that needs the store.
 *
 *  Every known value carries the check's own provenance: the source is the
 *  named check, and the time is when this sweep read it. The contract's first
 *  rule about honesty applies — this is the first *recorded* observation, and
 *  never a claim about when the condition began. */
export function observationFrom(
  finding: HygieneFinding,
  subject: ObservationSubject,
  owner: RecordedValue<string | null>,
  observedAt: string,
): IssueObservationInput {
  const source = `work:hygiene:${finding.check}`;
  return {
    check: finding.check,
    subject_kind: subject.kind,
    subject_ref: subject.ref,
    detail: { state: 'known', value: finding.detail, source_ref: source, recorded_at: observedAt },
    owner,
    next_action: { state: 'known', value: CHECK_NEXT_ACTION[finding.check], source_ref: `check:${finding.check}`, recorded_at: observedAt },
  };
}
