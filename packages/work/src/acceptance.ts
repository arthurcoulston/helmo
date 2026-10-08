import { AcceptanceVerdict, HelmoEvent, ProductAcceptance, ProductCompletion } from './types.js';

/** The acceptance projection, as one pure function over the event log.
 *
 *  It lives outside Store because it is also a deploy gate: the replay that
 *  measures what adopting this rule does to a live store (crew
 *  projects/r39/tools/replay-verdicts.mjs, VERDICT-SET-CONTRACT.md §3.4) must
 *  run the decision the store actually makes, not a copy of it. A gate that
 *  reimplements the thing it gates can pass while the real code fails.
 *
 *  The rule itself is VERDICT-SET-CONTRACT.md §2 (R-39 A1, H-2426/H-2427): a
 *  completion carries a verdict SET, a reviewer's latest verdict is theirs
 *  alone, the strictest verdict governs, and a FAIL is cleared only by a new
 *  completion. What it replaced selected the governing verdict with .at(-1),
 *  so on H-94 a PASS 557 ms after a FAIL erased the FAIL from the release
 *  path — safety was a property of who typed second.
 */

const sortedRefs = (refs: string[] | undefined): string => JSON.stringify((refs ?? []).slice().sort());

/** The two gates a verdict must pass to count at all: it reviewed exactly the
 *  refs this completion declared, and its actor neither recorded the
 *  completion nor is named as an author of what it reviews. `recordAcceptanceVerdict`
 *  refuses both at the door; they are re-checked here because the projection
 *  also reads logs written before those refusals, and rebuilt ones. */
function qualifies(completion: ProductCompletion, verdict: AcceptanceVerdict): boolean {
  if (sortedRefs(verdict.refs) !== sortedRefs(completion.artifacts.map((a) => a.ref))) return false;
  if (completion.actor.name === verdict.actor.name) return false;
  if (completion.artifacts.some((a) => a.author === verdict.actor.name)) return false;
  return true;
}

/** §2.2: a reviewer's latest verdict is their verdict. A Map keyed on actor
 *  name and filled in seq order leaves exactly that, so aggregation runs across
 *  reviewers rather than across writes. This is the only place last-write-wins
 *  survives, and it is scoped to one actor's own opinion.
 *
 *  Exported because `acceptanceCoverage` reports who has cleared a commit, and
 *  a second derivation of "whose verdict stands" could disagree with the state
 *  beside it — the reason `projectAcceptance` itself lives outside Store. */
export function standingVerdicts(qualifying: AcceptanceVerdict[]): AcceptanceVerdict[] {
  const perReviewer = new Map<string, AcceptanceVerdict>();
  for (const v of qualifying) perReviewer.set(v.actor.name, v);
  return [...perReviewer.values()];
}

function toCompletion(event: HelmoEvent): ProductCompletion {
  return {
    seq: event.seq,
    ts: event.ts,
    actor: event.actor,
    artifacts: event.payload['artifacts'] as ProductCompletion['artifacts'],
    note: event.payload['note'] as string,
  };
}

function toVerdict(event: HelmoEvent): AcceptanceVerdict {
  return {
    seq: event.seq,
    ts: event.ts,
    actor: event.actor,
    refs: event.payload['refs'] as string[],
    verdict: event.payload['verdict'] as 'pass' | 'fail',
    note: event.payload['note'] as string,
  };
}

/** Project one ticket's acceptance state.
 *
 *  `events` is that ticket's `product_completed` and `acceptance_verdict`
 *  events in `seq` order; anything else is ignored. `expectedRefs` is the
 *  caller asking "accepted against THESE refs?" — a mismatch is stale, never
 *  accepted, and it is checked only on the accept path because a FAIL on the
 *  recorded refs is a fact about the completion, not about the asker.
 */
export function projectAcceptance(events: HelmoEvent[], expectedRefs?: string[]): ProductAcceptance {
  const completionEvent = events.filter((e) => e.event_type === 'product_completed').at(-1);
  if (!completionEvent) {
    return { state: 'not_requested', reason: 'no_completion', completion: null, verdict: null, verdicts: [] };
  }
  const completion = toCompletion(completionEvent);

  // A later completion supersedes every earlier verdict and returns acceptance
  // to pending — the remediation handback (§2.1), unchanged.
  const inRound = events
    .filter((e) => e.event_type === 'acceptance_verdict' && e.seq > completion.seq)
    .map(toVerdict);
  const qualifying = inRound.filter((v) => qualifies(completion, v));

  if (!qualifying.length) {
    // Nothing counts, so the state is a refusal. Report it against the newest
    // verdict written, which is the one whose refs or author the reader has to
    // look at to understand why it does not count.
    const last = inRound.at(-1);
    if (!last) {
      const anyEarlierVerdict = events.some((e) => e.event_type === 'acceptance_verdict');
      return {
        state: 'pending',
        reason: anyEarlierVerdict ? 'stale_verdict' : 'missing_verdict',
        completion,
        verdict: null,
        verdicts: [],
      };
    }
    const refsMatch = sortedRefs(last.refs) === sortedRefs(completion.artifacts.map((a) => a.ref));
    return {
      state: 'pending',
      reason: refsMatch ? 'self_authored_verdict' : 'stale_verdict',
      completion,
      verdict: last,
      verdicts: [],
    };
  }

  const standing = standingVerdicts(qualifying);
  const fails = standing.filter((v) => v.verdict === 'fail');

  // §2.3: strictest governs, and a FAIL is sticky. The governing verdict is the
  // earliest standing FAIL — the one the release path was entitled to see — so
  // `verdict` keeps meaning "the verdict that governs" for every reader that
  // never learns about the set.
  if (fails.length) {
    const governing = fails.reduce((a, b) => (a.seq <= b.seq ? a : b));
    return {
      state: 'failed',
      reason: fails.length === standing.length ? 'review_failed' : 'contested',
      completion,
      verdict: governing,
      verdicts: qualifying,
    };
  }

  // Every reviewer passed. §2.5 keeps one PASS sufficient: what a sufficient
  // review looks like is an open question, and answering it here would be
  // policy smuggled in as a bug fix.
  const governing = standing.reduce((a, b) => (a.seq >= b.seq ? a : b));
  if (expectedRefs && sortedRefs(expectedRefs) !== sortedRefs(completion.artifacts.map((a) => a.ref))) {
    return { state: 'pending', reason: 'stale_verdict', completion, verdict: governing, verdicts: qualifying };
  }
  return { state: 'accepted', reason: 'independently_accepted', completion, verdict: governing, verdicts: qualifying };
}
