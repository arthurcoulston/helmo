# Workflow gate verification

Verified for H-474 on 2026-10-01 against independently accepted
`helmo@44efbdc0245b2a2d2474059000c3236035e16bff` and
`rev@44b454b7491849f08ba70fdce0c2acb8c50a38a1`.

The Rev production path under test is `rev run` → the configured
`helmo_cli` subprocess → durable launch receipt/journal → model subprocess →
post-session revalidation or quarantine. The tests use disposable stores and
mock only the model process. Helmo-only rules are exercised through Helmo's
public store/CLI implementation; they are not restated as Rev policy.

## Commands and result

```text
cd /Users/arthurcoulston/projects/helmo
npx vitest run test/store.test.ts -t 'durable workflow model|trusted scoped workflow decisions|atomic workflow admission|workflow invalidation and quarantine|workflow outcomes and retry recovery'
expected: all workflow definition, authority, admission, invalidation and retry cases pass
observed: 1 file passed; 31 passed, 188 skipped

cd /Users/arthurcoulston/projects/rev
npx vitest run test/loop.e2e.test.ts -t 'workflow-bound|exactly admitted|ready candidate changes|direct restart|replayed after restart|SIGKILL|ordinary work against|fails closed only'
expected: all launch, denial, restart, replay, kill and compatibility cases pass
observed: 1 file passed; 10 passed, 37 skipped
```

## A01–A14 matrix

| ID | Rev applicability and exercised production path | Expected and observed result |
|---|---|---|
| A01 | Ordinary candidate through `rev run`; legacy Helmo without `launch-admit`; existing acceptance remains a Helmo concern. | Ordinary work launched on both current and old stores; workflow state was not invented. |
| A02 | Workflow candidate through `rev run`; repeat direct `run` models a fresh start/resume. Direct claim/create/handoff are Helmo mutations, exercised in `atomic workflow admission`. | Missing, stale and failed gates launched no model; a restart asked again and remained denied. |
| A03 | `done`, cancellation, prose PASS and waiver semantics are Helmo requirement evaluation, covered by the admission/invalidation group. Rev consumes only the structured result. | Admission stayed denied; Rev launched nothing. |
| A04 | Scope combination is Helmo-only decision evaluation, covered by `trusted scoped workflow decisions`; Rev receives the structured missing/failed set. | Missing scope denied and launched nothing. |
| A05 | Stale manifest/input denial enters through `launch-admit`; exact receipt is revalidated before and after dispatch. | Stale input denied; superseded manifests and post-admission drift invalidated/quarantined the affected branch. |
| A06 | Authority, independence, aliases and client-supplied actor kind are Helmo-only trust checks in `trusted scoped workflow decisions`. | Self-review, alias and unauthorized authority were rejected before Rev could receive admission. |
| A07 | Selection/rejection/retry rules are Helmo-only outcome transitions in `workflow outcomes and retry recovery`. | No automatic winner; rejected output could not advance; missing retry evidence denied a new attempt. |
| A08 | Candidate substitution between Rev's compatibility read and atomic admission; duplicate admission/replay. | Substitution denied; one launch identity produced at most one model dispatch. |
| A09 | Repeated `rev run`, durable replay, and SIGKILL between dispatch and settlement. | Replay was suppressed; interrupted dispatch was quarantined; exactly one model ran and no `run-end ok` was fabricated. |
| A10 | Relabel/reparent/ordinary conversion is Helmo-only mutation enforcement in `workflow invalidation and quarantine`; Rev revalidates the immutable receipt. | Laundering mutations were refused and invalid output did not become launchable. |
| A11 | Unsupported/old Helmo through the configured CLI subprocess. Corrupt/unavailable receipts share the same fail-closed path. | Ordinary work continued; workflow-bound work refused clearly and no model launched. Definition cycles were rejected by Helmo. |
| A12 | Valid admission through `rev run`; rejected/aborted/retry transitions through Helmo's public workflow store. | Valid work launched once; terminal bad output could not advance; evidence-bound retry created a distinct attempt. |
| A13 | Runtime rollback is represented by an older Helmo CLI lacking workflow commands. Backup restoration/migration are Helmo release concerns, not Rev launch behavior. | Old runtime preserved ordinary compatibility and held workflow-bound work rather than bypassing it. |
| A14 | Disposable stores and generic names (`technical`, `candidate`, `attempt-*`) exercise no Good Plumb vocabulary; Helmo's separate-store recovery test supplies the instance boundary. | Separate stores/runs did not cross-read or cross-write; Rev contains no company-specific gate logic. |

There are no unexercised Rev-applicable cells. The non-Rev portions named
above are owned by Helmo and were exercised at its accepted commit in the same
verification run; backup byte restoration and release migration remain that
product's release proof rather than a claim made by Rev.
