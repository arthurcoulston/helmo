# Native API allocation admission

An API provider may opt into `allocation_file = "/absolute/canonical/path/allocation.json"`.
The file and its existing `runs.jsonl` live in one dedicated, owner-only directory.
No parent or file may be a symlink. There is no automatic initialization, reset,
expiry extension, stale-lock removal or recovery from absent state.
Existing providers without this option retain their launch behavior.

This is durable local admission accounting, not a hard provider billing cap.
The session limit is still an estimate and may overshoot. Provider caps and the
account's funding authorization remain independent backstops. Configuration and
state are trusted operator inputs on the existing same-user Runtime boundary.
Removing the configured guard or replacing its state is a new operating act,
not an automatic recovery path.

An example plan, prepared in a NEW dedicated directory (activate it only after
the operating owner has accepted the envelope):

```json
{
  "version": 1,
  "id": "example-allocation",
  "consumer": "api-worker",
  "provider": "claude-api",
  "helper_sha256": "SHA256 of the exact roster api_key_helper command bytes",
  "stop_at": "2026-10-14T23:47:00Z",
  "reserve_usd": 150,
  "stop_estimate_usd": 25,
  "estimate_multiplier": 5,
  "max_budget_usd": 5,
  "max_turns": 100,
  "timeout_seconds": 900
}
```

`helper_sha256` binds the command, never the secret it returns. The roster's
provider, worker name, helper command, session limits and stop_at must match.
Model selection remains the roster's tier mapping; allocation admission does
not change routing, probes or any fallback. One plan admits exactly one
consumer. This document does not allocate money or grant a second consumer.

Provision both files only after the operating owner records authority and live
accounting. `allocation.json` is exact frozen UTF-8 bytes (0600), and
`runs.jsonl` starts with one line plus its newline:

```json
{"kind":"allocation","sha256":"SHA256 of the exact allocation.json bytes"}
```

Create the files exclusively, fsync each, and fsync their parent before wiring
the roster. A partial setup refuses launch and is diagnosed before activation;
never replace an existing ledger to repair setup. Whitespace changes in the
plan also invalidate its header. Preserve these files and their backups for
the entire allocation, including across expiry, key continuity and redeploy.
A successor key or expiry change needs an explicitly reconciled plan transition;
it must not create a fresh allowance by discarding this ledger.

Before every native dispatch, an exclusive `admission.lock` directory serializes
all processes. The launcher strictly validates the frozen plan and receipt
sequence, rejects any outstanding reservation, then checks total settled
estimates against `stop_estimate_usd` ($25 in the example) and
`estimate_multiplier` × estimates plus the next reservation
(`max_budget_usd` × `estimate_multiplier`, $25) against `reserve_usd` ($150).
It fsyncs a unique reservation before spawning. Thus estimates just below $25
can admit one nominal $5 crossing; overshoot is recorded as observed and
stops further admission when either bound is reached. A restart reads these
same bytes; it does not consult the resettable burn floor for this allowance.

Normal CLI completion with a finite nonnegative `total_cost_usd` appends and
fsyncs its settlement. Invalid/missing JSON, missing/invalid cost, timeout,
signal, overflow, launch error, driver crash or settlement failure retain the
reservation and refuse the next funded session. A 429/529 without a valid cost
also needs reconciliation; automatic supervisor respawn cannot discard it.
Other providers and existing STOP/HOLD/BLOCKED/PACE handling remain unchanged.

## Reconciliation within the same allocation

The operating owner stops only the affected consumer with its supported control
and confirms the driver and detached session are absent before touching state.
Read the allocation, all receipts, the run's launch/session evidence and provider
usage; unknown spend remains reserved. Do not infer zero from a crashed process.
Record the verified cost and evidence on the owning ticket. With no writer
active, append exactly one settlement for the existing unresolved UUID, retaining
all preceding bytes; fsync the ledger. Its schema is:

```json
{"kind":"settle","run":"existing reservation UUID","cost_usd":0.0,"source":"reconciled","evidence":"qualified ticket and exact accounting evidence","at":"ISO instant with timezone"}
```

The number shown is a placeholder, not a reconciliation of any real run.
Malformed/interrupted receipts require a prepared exact repair preserving every
reservation and previously settled cost, independently assessed on that ticket;
never truncate or rebuild from a missing receipt. A leftover lock requires the
same absent-writer verification; remove only that empty lock directory after the
receipt review. Resume through existing controls without clearing unrelated
holds. This adds no new reserve or per-run approval; new money or a wider envelope
requires its own accounting and authority.

## Reproduce the source proof

From a cold candidate checkout, run `npm ci`, `npm run prepare:cold`,
`npm run build`, then:

```
node scripts/test-env.mjs -- npm exec --workspace rev -- vitest run --maxWorkers=2 test/api-allocation.test.ts test/claude-api.test.ts
```

The tests use disposable state and synthetic credentials/CLIs, including fresh
processes, a SIGKILL before receipt, native overlap, missing/malformed receipts,
accumulation/exhaustion, expiry and reconciliation. They do not make provider
requests or certify activation. Source undo is a revert of the candidate;
live undo must first preserve and reconcile its allocation, then restore only
the covered provider/worker fields.
