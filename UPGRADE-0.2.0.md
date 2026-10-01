# Upgrade to the Rev 0.2.0 release set

This is an operator's runbook for an existing, independent installation. The
consumer owns its compatibility review, maintenance window and rollback. Run
activation from a desk or operator session outside the fleet being restarted.

## What is available

These published tags form the upstream set. Fetch the tags and verify their
peeled commits; do not substitute `main` or an unrelated latest build.

| Component | Release | Expected commit |
| --- | --- | --- |
| Rev | [v0.2.0](https://github.com/arthurcoulston/rev/releases/tag/v0.2.0) | `4384a0892a5e964bf7cfb9952731ad0b2fe706d5` |
| Helmo | [v0.5.0](https://github.com/arthurcoulston/helmo/releases/tag/v0.5.0) | `c72d8c1d64be01a78682909b52f8c57fe1af9bfb` |
| Roadmap | [v0.1.0](https://github.com/arthurcoulston/helmo-roadmap/releases/tag/v0.1.0) | `32afbe159df302a7f298420bf8a1870ec06af3d9` |

The set adds installation identity and target assertions, immutable release
selection, running-build reporting, safer record updates, independent review
verdicts, and clearer human requests and record links. Read each tagged
changelog for the full scope. Selection does not restart processes. Automated
whole-installation activation is not part of this runbook or these tags.

Use the tagged [installation reference](https://github.com/arthurcoulston/rev/blob/v0.2.0/INSTALLATIONS.md)
and [entry-point checklist](https://github.com/arthurcoulston/rev/blob/v0.2.0/ENTRY-POINTS.md)
for the behavior of this release; newer documentation on `main` can describe
features outside this set.

## 1. Check whether replacing your current code is an upgrade

Record the actual loaded commit of every entry point, your adopted refs, and
your local changes. In review clones containing both histories, check each
component:

```sh
git merge-base --is-ancestor CURRENT_ADOPTED_REF RELEASE_REF
git log --oneline RELEASE_REF..CURRENT_ADOPTED_REF
git diff --stat CURRENT_ADOPTED_REF RELEASE_REF
```

A nonzero ancestry result needs investigation. If your runtime contains local
or newer workflow admission, authority, escalation or supervision changes, the
tags can remove them despite the higher version number. Compare tool names,
required parameters, limits, roster keys, database behavior and local guards.
If released source changes are already present through a merge, record that;
do not replace a working cumulative build merely to obtain the tag's version
label. Release metadata and functional changes can have different ancestry.
Existing workflow-bound work must keep its admission enforcement; Rev's
compatibility fallback for older Helmo is not equivalent to that protection.

When additions would be lost, stop before live adoption. Your builder must
reconcile the released changes with the current runtime in separate candidate
branches, preserve the local protections, and have the exact combined commits
independently accepted. Record those new commits in a consumer release manifest
and review their migration declaration. That is a consumer-maintained set; it
must not be represented as the unmodified upstream tags. The build example
below is for the unmodified set only.

## 2. Prepare without touching an installation

Use fresh checkouts and a new permanent release directory. Do not build in any
directory from which a live service, guard or CLI loads code. Keep the completed
directory at its final absolute path and do not rebuild it after selection.

**Known test hazard in this tag:** Rev v0.2.0's release tests can inherit a real
`INSTALLATION_RELEASE` and overwrite that selection. The fix is public at
[5f86d91](https://github.com/arthurcoulston/rev/commit/5f86d9106e801ba836d92e67ed750855c0107d0d),
but is not included in v0.2.0. Run tests in the clean child environment below,
including when testing from an adoption script. Changing only `REV_HOME` is
insufficient. Do not take all of `main` merely to get this test fix.

Use a supported Node version for all three tagged packages and a shell that
stops on errors. Replace the absolute release path before running:

```sh
set -eu
release_root=/absolute/consumer/runtime/releases/2026.10-1
test_home=$(mktemp -d "${TMPDIR:-/tmp}/release-review.XXXXXX")
test ! -e "$release_root"
mkdir -p "$release_root"

git clone --branch v0.2.0 https://github.com/arthurcoulston/rev.git "$release_root/rev"
git clone --branch v0.5.0 https://github.com/arthurcoulston/helmo.git "$release_root/helmo"
git clone --branch v0.1.0 https://github.com/arthurcoulston/helmo-roadmap.git "$release_root/helmo-roadmap"
test "$(git -C "$release_root/rev" rev-parse HEAD)" = 4384a0892a5e964bf7cfb9952731ad0b2fe706d5
test "$(git -C "$release_root/helmo" rev-parse HEAD)" = c72d8c1d64be01a78682909b52f8c57fe1af9bfb
test "$(git -C "$release_root/helmo-roadmap" rev-parse HEAD)" = 32afbe159df302a7f298420bf8a1870ec06af3d9

# These variables apply only to each child; the operator's shell is unchanged.
# No live selector, store path, label, actor or runtime home is inherited.
review_run() {
  env -i PATH="$PATH" HOME="$test_home" TMPDIR="$test_home" CI=1 "$@"
}
for component in helmo helmo-roadmap rev; do
  (cd "$release_root/$component" && review_run npm ci && review_run npm run build)
done
(cd "$release_root/helmo" && review_run npm test -- test/install.test.ts test/reference.test.ts test/build.test.ts)
(cd "$release_root/helmo-roadmap" && review_run npm test -- test/install.test.ts test/reference.test.ts test/build.test.ts)
(cd "$release_root/rev" && review_run npm test -- test/cli.test.ts test/release.test.ts)

cat > "$release_root/RELEASE.json" <<'JSON'
{
  "commits": {
    "rev": "4384a0892a5e964bf7cfb9952731ad0b2fe706d5",
    "helmo": "c72d8c1d64be01a78682909b52f8c57fe1af9bfb",
    "helmo-roadmap": "32afbe159df302a7f298420bf8a1870ec06af3d9"
  }
}
JSON
cp "$release_root/rev/MIGRATION.json" "$release_root/MIGRATION.json"
cat "$release_root/MIGRATION.json"
```

The three `dist/BUILD.json` files must name the expected commits and say
`dirty: false`. Validate the set against a disposable selection first:

```sh
mkdir -p "$test_home/rev"
# Release commands in this tag still require a roster; this one starts no loops.
cat > "$test_home/rev/roster.toml" <<TOML
[global]
helmo_cli = "$release_root/helmo/dist/cli.js"
helmo_mcp_server = "$release_root/helmo/dist/server.js"
TOML
review_run env REV_HOME="$test_home/rev" REV_LABEL=release-review \
  INSTALLATION_RELEASE="$test_home/selection.json" \
  node "$release_root/rev/dist/cli.js" release upgrade "$release_root" --installation release-review
review_run env REV_HOME="$test_home/rev" REV_LABEL=release-review \
  INSTALLATION_RELEASE="$test_home/selection.json" \
  node "$release_root/rev/dist/cli.js" release status --installation release-review
```

These focused tests verify release and identity behavior, not your complete
installation. Run the applicable full product suites and local wrapper/guard
tests in the same clean environment before acceptance. For Rev's integration
suite, explicitly supply `REV_TEST_HELMO="$release_root/helmo"` to the clean
child environment. Rehearse on consistent backup copies of your actual stores
and disposable controls, with separate ports and no live agents. Opening a
store can migrate it, including from a read-only dashboard.

For this Rev tag, put the command before `--installation`, as shown above.
Putting the assertion first can incorrectly trigger the normal pinned-code
check before the release repair command is recognized.

## 3. Prepare the installation plan and recovery copy

Record the before/after command, environment, port and service identity for
every row below. Keep the previous runtime directories available.

| Entry point | What must select the accepted set |
| --- | --- |
| Rev supervisor and CLI | Selected Rev build; service launcher under this installation's Rev home |
| Rev dashboard | Selected Rev view, own home and existing dashboard port |
| Roster Helmo CLI | Selected Helmo CLI, including subprocesses used for admission and queue reads |
| Helmo MCP and any remote server | Selected Helmo server behind the existing access and handoff guards |
| Helmo dashboard | Selected Helmo view, own store and existing port |
| Roadmap MCP and dashboard | Selected Roadmap build, own store and existing ports |
| Summons, editor clients, hooks and wrappers | Same selector and component refs, including fallback paths |

Keep guards in the call path; do not replace a guarded MCP command with the bare
server just to satisfy a path checklist. Update its internal product target and
verify denied calls still refuse. Restart long-lived MCP clients too.

A custom two-component `ADOPTED.json` is not Rev's three-component selection
format. Do not point `INSTALLATION_RELEASE` at it or maintain contradictory
selectors. Adapt the consumer's resolver and tests so all three products agree,
or explicitly retain its adoption mechanism until that integration is ready.

Before the first new-code access to a live store, take consistent SQLite online
backups, or stop **all** writers and copy each store with its WAL/SHM sidecars.
Do not copy a live `.db` alone. Save Rev controls/roster/state, selection files,
service definitions, wrapper configuration and the exact old runtime refs.
Verify the backup opens and passes `PRAGMA integrity_check` in isolation.

Write down the rollback commands for your current mechanism. A first pin has no
previous Rev selection: `release rollback` cannot recreate the old custom
adopter, roster or service definitions. Recovery must restore those saved files
and start the retained old code. Decide how to retain writes made after the
upgrade before choosing a database restore that would discard them.

## 4. Activate during a controlled maintenance window

Use installation-scoped environments. Preserve the existing identity, homes,
database paths and ports unless a separately reviewed plan changes them. A
qualified reference asserts an identity; it does not redirect to another store.
Do not rename labels to make a refused reference pass.

1. Using the **currently adopted** Rev CLI and its environment, request `stop`
   with no loop argument. Watch the old supervisor drain. Confirm its PID,
   drivers and agent sessions have ended; check actual processes, not just a
   missing marker. Keep new starts inhibited while changing the installation.
2. Stop this installation's dashboards and remaining MCP/remote writers using
   their owning service/client controls. Finish the recovery copy. Do not stop
   other installations or clear their controls.
3. Repoint the reviewed roster, wrappers, guards, client configurations and view
   services to the accepted set. Include `INSTALLATION_RELEASE` explicitly in
   the intended children; use matching home/database variables. Set a label
   only when it matches the reviewed identity plan.
4. With the candidate Rev CLI, assert this installation and run
   `release upgrade <accepted-release-directory>`, then `release status`.
   The selector must be this installation's new-format selector. Inspect its
   retained previous selection and migration declaration before continuing.
5. For an existing pinned-launcher service, run `service start` using the
   selected CLI and environment. On first pin, or when the old definition names
   a fixed `cli.js`, run `service install` instead. This installs **and starts**
   the service; all configuration must be ready first.
6. Start the selected dashboards and reconnect MCP clients. Run the acceptance
   checks below before declaring adoption complete.

Do not use `service install` as the drain step: on macOS the service manager's
exit allowance is shorter than Rev's agent drain. Reinstalling while sessions
remain can leave orphaned work and overlapping fleets. If drain does not finish,
leave the old selection intact and investigate the remaining sessions.

## 5. Prove the result and recover if needed

Record evidence for each check, including the actual loaded refs:

- `release status` reports the intended set; `status` and `service status`
  identify the intended installation and one live supervisor. Selection alone
  is not evidence that a process restarted.
- The Rev dashboard's `/health.json` reports the selected Rev ref for both its
  view and supervisor. Verify the supervisor's actual command independently
  if the old view was loaded from another checkout.
- Helmo CLI output, MCP startup logs and both product-view footers name the
  correct stores and loaded refs. No active entry point uses shared development
  `dist`. A stale or unverifiable reading is unfinished adoption.
- Make an identified, disposable work-record write through the normal guarded
  path and read it back. Exercise one real loop pickup through its proper queue.
  Verify local workflow/authority refusals and ordinary work both still behave
  as required. Do not weaken a gate to make the smoke check green.
- Confirm other installations retain their selectors, configurations and
  loaded code, and remain healthy. Their ordinary ongoing work may change data;
  that is different from the upgrade writing to their stores.

On failure, drain this installation and stop its writers. If the current
migration permits rollback and a valid previous selection is retained, use
`release rollback`, restore the corresponding configuration and restart all
entry points. On first pin, restore the reviewed old adoption/configuration
files instead. If data recovery is necessary, use the verified pre-upgrade
backup with every writer stopped and handle sidecars consistently. Verify old
identity, guards and loaded refs again before resuming work.

The owner closes the upgrade only after these checks pass on the exact accepted
set. A successful clone, build, pointer change or service start is an
intermediate result.
