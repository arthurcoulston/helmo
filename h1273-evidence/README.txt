H-1273 drain verification

Checkout: /Users/arthurcoulston/projects/gp-contrib/helmo-h1273
Branch: h1273-drain-waits
Base: helmo@cdf67474dfd82e9f214f3ad6f9ffa1886247c5ce
Tested implementation: helmo@4421214d4b0ab422ffb1da47ea0908083398f9c8
Builder: gpt-6-astra, codex-cli 0.160.0 (this session's rollout metadata).

Diagnosis confirmed with real fixture processes and mock_cmd only:
The old loop SIGTERM handler exits 143 during an async detached session.
The supervisor then considers the runner drained and never reaches its
existing grace escalation, leaving the session running. Synchronous mock_cmd
sessions masked this because Node could not deliver the signal mid-session.

The fix records the first stop signal while a session and its close-out are
in flight. The runner exits at the boundary, logging loop-stop reason=drain
for SIGTERM and returning 143, after settlement, run-end, metering and ladder
state writes. Between iterations it still exits promptly. Count exits,
blocked exits and transient waits honor the pending signal as well.

mock_cmd now uses the same spawnSession async/process-group path as the real
adapters. No real Claude or Codex session is used in these tests. Existing
supervisor drain_grace_seconds configuration and escalation code are unchanged:
H-1089 already discovers session groups before killing the runner and uses
TERM then KILL to end them. The strengthened grace test uses a session and
its descendant that ignore TERM, asserts the configured 3s grace is honored,
requires bounded drain completion, and checks both PIDs and the group are gone.

Evidence files and commands:
- install.log: npm ci --offline --logs-dir /tmp/h1273-npm-logs (PASS).
- build-baseline.log: npm run prepare:cold && npm run build (PASS; all build
  prerequisites in this writable contribution checkout).
- sandbox-attempt.log: initial sandboxed process test could not run because
  ps is denied; fixture ancestry checks exited before launching any session.
  Subsequent process tests ran with ps/signals allowed in disposable homes.
- regression-before.log: old HEAD loop.ts with the async mock and strengthened
  regression tests. Command:
  node scripts/test-env.mjs -- npm test --workspace rev --
    test/loop.e2e.test.ts test/supervisor.e2e.test.ts
    -t 'a drain|drain grace kills'
  Expected RED: 2 failed, 2 passed. The runner exited 143 while the session was
  gated; the wedged session group survived the completed drain. Test cleanup
  killed the fixture groups. Old loop.ts was restored to the fix afterward.
- regression-after.log: same command with the fix, PASS: 4 tests.
- runtime-build-uncommitted.log: node scripts/test-env.mjs -- npm run build
  --workspace rev (PASS; initial dirty-tree stamp).
- full-suite-uncommitted.log: initial complete repository run. All non-runtime
  workspaces passed. Runtime: 598 passed, 3 skipped, 2 failed. The only failures
  were release.test.ts activation fixtures refusing the dirty build stamp;
  all drain, H-1109/H-467/H-281, STOP/HOLD/BLOCKED and new close-out tests passed.
- build-clean.log: after committing the implementation, node scripts/test-env.mjs
  -- npm run build (PASS, all workspaces including Runtime). Output was captured
  outside the checkout so evidence writes did not dirty the build. No build
  stamp was manually edited or bypassed.
- runtime-build-stamp.json: the actual clean build stamp, naming implementation
  commit 4421214d4b0ab422ffb1da47ea0908083398f9c8 with dirty=false.
- full-suite.log: clean-build rerun of node scripts/test-env.mjs -- npm test.
  Includes every workspace and the full runtime suite, including three
  additional close-out regressions. Final result is recorded below.

The test environment scrubber removes inherited HELMO_, ROADMAP_, REV_ and
INSTALLATION_ variables and supplies a disposable empty Rev home. Tests create
only disposable installation stores, fixture sessions and supervisors. No
live Rev loop, live supervisor, attended session, or gp-runtime was changed.
No push, PR, adoption, redeploy or restart was performed against the live fleet.

Final validation: PASS (full-suite command exit 0).
- Runtime: 33 files passed; 600 tests passed, 3 skipped; no failures.
- Repository total: 1,356 tests passed, 7 skipped; no failures. This is the
  repository's standard npm test command, including its configured exclusions.
- Root scripts 20; App 6; Core 22; CLI 40; Roadmap 114 (+2 skipped);
  Work 533 (+2 skipped) plus 21 release-floor tests; Runtime 600 (+3 skipped).
- Runtime and all other workspace builds passed with a clean implementation
  commit stamp. The two earlier activation failures pass with that clean build.
- All seven drain regression cases pass (async close-out, parked, idle,
  count exit, transient wait, blocked exit, and grace-killed session group).
- Existing H-1109/H-467/H-281 and STOP/HOLD/BLOCKED tests pass.
- No source changes followed the clean build. The final evidence commit adds
  only this directory; implementation remains exactly commit 4421214d4b0ab422ffb1da47ea0908083398f9c8.
