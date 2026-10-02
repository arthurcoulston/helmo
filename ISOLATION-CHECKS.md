# Checking installation isolation

This is a review procedure, not another installer. Stand up two disposable
installations, A and B, by following [INSTALLATIONS.md](INSTALLATIONS.md). Give
their Rev, Helmo and roadmap homes the same basenames under different parents,
use distinct labels and stores, and pin A to the newer release and B to the
previous release. Keep a copy of both homes and both service definitions before
each destructive check.

The checks below concern effects, not reassuring output. A refusal counts only
when it exits non-zero and before/after copies show neither installation changed.
Replace capitalized values with paths and labels from your two installations.

## The seven properties

### 1. Identity

Each installation must bind one stable identity to its code selection, stores,
ports, service name and controls. Run `REV_HOME=A_REV rev status`,
`HELMO_HOME=A_HELMO helmo-cli get H-1`, and the equivalent commands for B.
Restart both services and repeat them. Observe distinct labels, homes, stores,
ports and service definitions before and after restart. A pre-release,
single-install setup must continue to work without new variables.

Our candidate matrix created two same-account installations with reused record
and seat names. Both retained distinct identities across process boundaries and
restart. Candidate refs: `REV_REF`, `HELMO_REF`, `ROADMAP_REF`.

### 2. Target selection

For each product, first make an asserted read of A using
`--installation A_LABEL`, then repeat it while naming `B_LABEL`. Exercise one
disposable write the same way. The first command must affect only A. The second
must exit non-zero before opening or changing either store. Repeat with
conflicting inherited home, database and label variables; the conflict must not
be resolved by precedence. The space and equals flag spellings must behave alike.

Our matrix exercised every mutating Rev and Helmo command family and every
mutating roadmap MCP tool, including a target whose store did not exist. Wrong
targets were refused before dispatch or store creation; correct controls landed
only in A.

### 3. Service collision

Install A and B from homes with the same basename. Compare their launchd labels
or systemd unit names and the executable, home and environment recorded in each
definition. Restart, stop and remove A's service; after each operation inspect
B's definition and process. B must remain loaded from B's selected code. Force
an explicit label collision: the operation must refuse rather than overwrite,
boot out or remove the other definition.

Our matrix observed distinct identities for same-basename homes, refusal on a
forced collision, and an unchanged peer definition and process through restart
and removal.

### 4. Version selection

For A and B, compare `rev release status`, each product's build stamp, the
running service executable and the version shown by its status or view. Exercise
a CLI, an MCP read, a browser view and a supervisor-started subprocess. Every
surface must resolve the same three-component release selected by that
installation. Corrupt a disposable selection: every entry point must report the
mismatch and refuse to masquerade as upgraded.

Our matrix saw A use the candidate set and B the previous set across all entry
points. Mixed and missing component selections were rejected.

### 5. Publication and build containment

Snapshot both installations, then fetch, build and test a newer checkout not
selected by either one. Reinspect their selection files, build stamps, service
definitions and processes. Nothing may change, and neither installation may
fall back to the checkout.

Our matrix fetched, built, tested and publication-checked an upstream candidate;
both installed selections and running refs remained byte-for-byte unchanged.

### 6. Upgrade, recovery and removal

Upgrade A, deliberately fail a later A upgrade, roll A back, restart it, then
remove its service and disposable records as INSTALLATIONS.md describes. After
every step compare all of B's stores, controls, files, definition, process and
loaded code with the snapshot. Interrupt an A selection change and restart it:
it must recover one coherent release, never a mixture. Repeat successful
upgrades in the opposite order. Check the migration declaration for explicit
data compatibility and recovery limits.

Our matrix covered both upgrade orders, invalid and interrupted selections,
rollback, restart and removal. A recovered a coherent set; B never changed.

### 7. Human and agent visibility

Open each installation's status, health page and product views; capture its
diagnostics. Each surface must name the installation and actual running release
or ref. Create the same record id in both installations and copy its reference:
the portable reference must carry the installation label, and presenting it to
the other installation must refuse rather than resolve the other record.

Our matrix reused record ids and seat names. Status, health, UI and diagnostics
distinguished the installations, and cross-install references stayed qualified.

## Public tests you can run

From a clean checkout, install dependencies (`npm ci` at the workspace root)
and run:

```sh
cd packages/runtime && npm test -- test/cli.test.ts test/release.test.ts
cd ../work && npm test -- test/install.test.ts test/reference.test.ts test/build.test.ts
cd ../roadmap && npm test -- test/install.test.ts test/reference.test.ts test/build.test.ts
```

These suites directly cover identity resolution, conflicting environment and
target assertions, qualified references and build identity. Rev additionally
covers service and release-selection behavior. They do not create two live
service-manager installations or prove a reviewer followed the manual checks;
that is why the seven checks remain part of release review.

The release producer's matrix ran the wider cross-product and service-manager
cases against the candidate refs above. It is not published as a portable test:
it is coupled to a three-repository fixture and its containment guards. The
manual procedure lets reviewers derive the same properties against their own
installations without pretending that fixture is consumer software.
