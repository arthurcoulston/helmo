# Installations — running more than one, and changing which release it runs

Rev, [Helmo](https://github.com/arthurcoulston/helmo) and the
[roadmap](https://github.com/arthurcoulston/helmo-roadmap) can be installed more
than once under one operating-system account, each with its own records,
controls, service and selected version. This is the document for doing that:
what an installation is, how to put a released set on, how to upgrade it, how to
go back, and how to take one off without touching the other.

Rev is the home for it because Rev is the only one of the three with the release
verbs — `rev release status | upgrade | rollback`, `rev install remove` — and
the only one that resolves a whole Rev+Helmo+roadmap set rather than its own
code alone. Each product still documents its own install identity and targeting
in its own docs, and a Helmo-family installation is supported standing without
Rev at all:

For an independent review of those guarantees, including a two-installation
checklist and the public tests, see [ISOLATION-CHECKS.md](ISOLATION-CHECKS.md).

[AGENT-INSTALL.md](AGENT-INSTALL.md) stands a first installation up across all
three areas. Each area's own install identity and targeting:

- Work — `HELMO_HOME` / `HELMO_DB`, `HELMO_INSTALLATION` (with
  `HELMO_LABEL`, `ROADMAP_LABEL`, and `REV_LABEL` accepted during the
  compatibility window),
  `--installation <name|home|db>`, and qualified record references
  (`H-267@<label>`).
- Roadmap — `ROADMAP_HOME` / `ROADMAP_DB`, `HELMO_INSTALLATION`, and the same
  legacy keys and `--installation` assertion.
- Runtime — `REV_HOME`, `HELMO_INSTALLATION`, the roster, and the service.

## One installation needs nothing here

The single-installation path is unchanged, and it is still the primary one. A
bare `~/.rev`, `~/.helmo` and `~/.helmo-roadmap`, with no release selected and
no new variable set, keeps working exactly as it did: the agent-led install in
[AGENT-INSTALL.md](AGENT-INSTALL.md) remains the way to stand a first
installation up, and everything in the rest of this file is opt-in.

Nothing below changes a default. If you run one installation and are happy
running the code your checkouts hold, you are done — read on when you want a
second installation, a pinned version, or a removal you can trust.

## What an installation is

An installation is one identity that binds five things together: the **code**
it runs, its **records**, its **ports**, its **service name**, and its
**controls**. Every read surface names it, and every mutation confirms it, so
the question "which installation did that just happen to?" always has a printed
answer.

Rev prints it as `installation: <label> (<home>)` — on `status`, `usage`,
`routing`, `service status`, the bare-usage footer, and on each mutation's own
confirmation, because the output of the thing you just ran is where you look to
see what you just did. (`tail` and `session-spec` are the two exceptions: their
stdout is a machine value a caller substitutes, and both already carry the home.)

**How the name is resolved.** In order:

- `HELMO_INSTALLATION`, when it is set. Rev's own service install writes it into the
  service environment, so a job a service manager brings back with a bare
  environment resolves the identity it was installed under instead of
  re-deriving a different one.
- Otherwise the legacy `ROADMAP_LABEL`, `HELMO_LABEL`, and `REV_LABEL` keys are
  accepted through the two-release compatibility window. If multiple accepted
  keys are set, they must agree or startup refuses.
- Otherwise it is derived from the resolved Rev home. A **conventional home** —
  a direct child of the account's home directory named `.rev` or `.rev-<suffix>`
  — keeps the label it is already bootstrapped under: `~/.rev` → `dev.rev`,
  `~/.rev-b` → `dev.rev.b` (systemd unit `rev-b`). Such homes cannot collide
  with each other, so the rule is safe by construction rather than by naming
  discipline. **Anywhere else**, the label carries a readable part plus eight
  hex of a SHA-256 of the resolved home path:
  `/srv/customer-a/.rev` → `dev.rev.customer-a.3f9a…`. Stable across restarts,
  distinct per installation, no new state store.
- The account's home for that test comes from the password database, not from
  `$HOME`. A service manager hands a daemon an environment the software under it
  may have written, so an identity keyed on `$HOME` would be keyed on something
  a second installation can set. `$HOME` still decides *where* a service
  definition file is written.
- The path is resolved, not `realpath`ed: a home reached through a symlink is a
  second identity, and `REV_LABEL` is the override for that.

Suffixes beginning with `roadmap` at a name boundary are reserved for the
roadmap side of the family convention. For example, `.helmo-roadmap` and
`.helmo-roadmap-b` are the roadmap homes for the bare and `-b` installations;
they are not paired as Helmo homes for `.rev-roadmap` or `.rev-roadmap-b`.

Two homes with the **same basename** therefore get distinct service labels —
`/srv/customer-a/.rev` and `/srv/customer-b/.rev` are two installations, not
one. This matters more than it looks: a service manager's namespace belongs to
the uid, not to `$HOME`, so two installations under one account share one
bootout and kickstart address no matter where their definition files live.

A Helmo-family installation standing without Rev names itself the same way
through `HELMO_INSTALLATION` (with the legacy product keys still accepted), which is why those
products can be installed independently and still answer the same question.

**`installation: UNCLEAR`.** Rev refuses to claim a name it cannot stand behind.
The inherited case needs no flag to go wrong: a supervisor copies its
environment into every session it spawns, `REV_LABEL` included, so a command run
with a different `REV_HOME` can be *named* by one installation and *aimed* at
another. The label itself cannot detect that — any process can set it — but the
service definition installed under that label can, because it records the
`REV_HOME` it was installed for. When the two disagree, reads still read (they
are safe from any context, and an operator watching a fleet depends on that) but
they print `installation: UNCLEAR` and name both homes. Mutations refuse.

**`--installation <name|home>` asserts; it never redirects.** It takes either
spelling because those are the two you have in front of you: a label a status
line printed, or a home path a roster or service definition names. A
disagreement with the environment is a refusal, not a precedence rule — there is
deliberately no flag that *changes* the target. `REV_HOME` does that, and the
flag is how you say you meant it. (Helmo and the roadmap take a third spelling,
a store path, for the same reason.) Write it with a space or an `=`; all three
products take both, and all three assert on every command, reads included, so
the flag is usable as a guard in a script.

## Installing a selected release

An installation can either run whatever code its entry points were started from
— the unpinned arrangement above — or be **pinned** to an immutable release set.
Pinning is what makes "which version is this installation on?" a question with
an enforceable answer.

A **release directory** holds one Helmo checkout, with all three shipped
packages built, plus two files that describe the set:

```
releases/2026.10-2/
  RELEASE.json        commits: { helmo } — the one commit this product was built from
  MIGRATION.json      data_compatibility + rollback — what this release does to your data,
                      copied in from the Helmo checkout you built (see below)
  helmo/
    packages/work/dist/       built, with its BUILD.json stamp
    packages/roadmap/dist/
    packages/runtime/dist/
```

Selections made before C1 used sibling `rev`, `helmo`, and `helmo-roadmap`
components. That layout remains readable and selectable so an installation can
inspect its current release and roll back across the consolidation boundary;
new releases use the one-component layout above.

The release's **id is its directory's name**. A selection records both the id
and the directory, so a set carrying an id of its own could disagree with where
it is.

A **selection file** is the one file that decides what the next process loads.
Point the installation at it with `INSTALLATION_RELEASE`, then select a release:

```bash
export INSTALLATION_RELEASE=~/.rev-b/release.json
rev release upgrade /srv/releases/2026.09-1
rev release status
```

`rev release status` is what you read to see where an installation stands: the
selected release and directory, when it was selected, each component's commit,
the data-compatibility declaration, and whether there is anything to roll back
to. An unpinned installation says so plainly rather than pretending to a version.

Beside the selection, `activation.json` is the deployment record. Selection
writes it as `selected`; rollback writes `rolled_back`; the activation driver
then owns `activating`, `running`, and `failed`. A running record is evidence,
not intent: it names the effective installation identity and the release and
component refs observed from the processes that loaded them. Every state keeps
an explicit recovery instruction. `rev release status` reads both files and
calls a record stale when it describes a different selection, partial when its
required fields are absent, and unrecorded when activation has supplied no
evidence. A running record also declares the complete required-process set;
each observation carries its exact command, loaded refs, installation identity,
and the time an identity write/readback passed. Status probes each recorded PID
and command afresh, requires unique process names, and compares the record's
complete component set with the selected release. It prints `UNVERIFIED` if
coverage, identity, refs, selection, or liveness disagree. It never promotes
`selected`, saved phase, or a `BUILD.json` stamp to “running,” and a broken
selection cannot hide the independently readable recovery instruction in the
activation record.

Activate an already selected set with `rev release activate`. It records the
attempt, asks the existing supervisor to drain at the next poll, lets every
in-flight iteration finish its close-out, and relies on the stable service
launcher to start the selected release only after the old supervisor exits.
The drain uses Rev's configured grace and escalation; the detached restart
watch records `failed` with the exact recovery command if no replacement
supervisor returns. A replacement supervisor records `running` only after its
installation identity and selected component refs survive durable readback.

From then on **every entry point verifies the set before it does anything** —
every Rev CLI invocation and the supervisor, and the Helmo MCP servers Rev
spawns for its sessions, which are given the selector. Missing code, a mixed set, or
code running from a shared checkout rather than the selected directory refuses
before the roster is even read. That is the property that stops a rebuild of a
development checkout reaching a pinned installation.

**Install the service after pinning**, with `rev service install`. For a pinned
installation it writes `<REV_HOME>/service/launch.mjs` and the service
definition names *that* file rather than a `cli.js` inside a release directory.
The launcher resolves the selection at start and hands over in the same process,
which has two consequences worth knowing:

- It reads the selected directory's `RELEASE.json`: a one-component release
  starts `helmo/packages/runtime/dist/cli.js`, while a historical
  three-component release starts `rev/dist/cli.js`.
- A release change is picked up by a **restart**, with no reinstall. That is
  exactly what the upgrade's own output promises.
- The service manager's signals, its exit timeout and the pid it supervises all
  reach the supervisor itself, so drain, `rev stop` and the sentinels behave as
  if the manager had named the supervisor directly.

On macOS a reinstall waits for the old job to finish its bounded launchd drain
before bootstrapping the replacement. If that bootstrap fails, Rev restores the
previous definition and starts it again rather than leaving the installation
down.

If the launcher cannot resolve the selection, it refuses in one line naming the
installation and the repair, and exits non-zero on purpose: the manager retries,
so repairing the selection brings the supervisor back with no command run.

## Which versions go together, and what a migration cannot undo

**A version here is one commit, not an npm version.** Package manifests carry
the product's declared version, while release identity is the directory name
plus the one Helmo commit in `RELEASE.json`. Two builds of the same version are
different releases if they came from different commits, and the product says so.

**The rule the product enforces.** A new release is valid when `RELEASE.json`
names exactly one `helmo` commit and Work, Roadmap, and Runtime each have a
`dist` holding JavaScript whose `BUILD.json` stamp names *exactly* that commit,
built from a clean tree. A dirty package is refused — a build stamp
records a dirty tree rather than refusing it, which is right for a build and not
enough for a release, because the manifest's commit would not identify the bytes.
Every fault in a set is reported at once, so a bad set is fixed in one pass
instead of three rebuilds.

A manifest with a subset, an extra component, or both unified and legacy names
is refused rather than guessed. The exact historical three-component shape is
the sole compatibility exception, and each of those components is still
verified under its original commit.

**What a refusal looks like.** Every fault, named, with the repair, and nothing
written:

```
$ rev release upgrade /srv/releases/2026.09-1
installation: acme.rev (/srv/acme/rev)
/srv/releases/2026.09-1 is not a release set this installation can run:
  - /srv/releases/2026.09-1/MIGRATION.json is missing or unreadable (ENOENT: no such file or
    directory). A release states its data compatibility and its rollback limit before it can be
    selected, because after the upgrade is too late: {"data_compatibility":"compatible",
    "rollback":{"supported":true}}, or "one_way" with {"supported":false,"limit":"<what cannot
    be recovered, and how to>"}
  - Runtime is built from 999999999999 but the manifest names aaaaaaaaaaaa — this set is mixed
  - /srv/releases/2026.10-2/helmo/packages/work/dist holds no JavaScript — Work is not built in this release
  - Roadmap was built from a dirty tree, so commit aaaaaaaaaaaa does not identify the bytes
    in /srv/releases/2026.10-2/helmo/packages/roadmap/dist — rebuild it from a clean checkout
```

That is one command reporting four separate faults, and it exits non-zero with
the installation still on the release it was running. The same check stands in
front of every entry point: a set that goes incoherent later refuses each
product with `incoherent release set: <product>: ...`, and `rev release status`
answers `INCOHERENT` with the same list, because that is what an operator runs
to find out. This is a property you can test rather than a promise: break one
component's stamp, and the mismatch is named in the output of `rev release
status` and of every command in the installation.

**This release's set.** The Helmo commit is fixed when the version is cut. A
consumer checks `RELEASE.json` against the released tag; all three package
stamps must name that same commit.

**There is no upstream release id to check against**, and that is not an
omission. A release's id is its directory's name, you assemble that directory
from builds you make, so nothing published here can fix it — name it whatever
your installations should report being on (`2026.09-1` is the shape these
examples use). What identifies the set is the three commits above, and the
release directory's own `RELEASE.json` is the authority every entry point
reads: if yours names other commits, you have assembled a different set.

The document cannot embed its own commit: that value does not exist until after
the file is committed. The released tag resolves to exactly one commit, and
`RELEASE.json` records that sha, which is the value every entry point checks.

**`MIGRATION.json` is required**, and it is authored rather than generated,
because it is a claim about consequences no build step can compute:

```json
{ "data_compatibility": "compatible", "rollback": { "supported": true } }
```

or, for a release whose data the older code cannot read:

```json
{ "data_compatibility": "one_way",
  "rollback": { "supported": false,
                "limit": "<what cannot be recovered, and how to recover from a backup>" } }
```

A release that has not declared this **cannot be selected at all** — after the
upgrade is too late to ask. The declaration is copied *into* the selection when
the release is selected, so a rollback can be refused in the limit's own words
with the release directory long gone. A `one_way` release that also claims
rollback is supported is refused as self-contradictory — `MIGRATION.json
declares a one-way data migration and also says rollback is supported — one of
those is wrong, and an operator would find out which by losing data` — because
an operator would otherwise learn which half was wrong by losing data.

You are told the limit **before** the pointer moves, not when you try to go
back. An upgrade into a one-way release prints its declaration as it selects it,
and a later `rev release rollback` refuses in those same words and exits 1:

```
$ rev release rollback
refusing to roll back out of 2026.10-1: it declares a one-way data migration.
  <the limit this release declared>
Rolling the pointer back to 2026.09-1 would leave 2026.10-1's data in front of
code that cannot read it. Recover from a pre-upgrade backup as above, then
select the older release.
```

**This release's declaration ships inside Helmo.** `MIGRATION.json` in the
Runtime package is this release's own until the root product document replaces
it, authored at the cut;
copy it into the release directory beside `RELEASE.json`. It is upstream's claim
about consequences and not yours to write, and it deliberately carries no
`release` field — a declaration that names an id is refused in any directory with
a different name (`MIGRATION.json declares release 'v0.1.0' but sits in
'2026.09-1' — it describes some other release's migration`), and the name is
yours. Read it before you upgrade — `rev release status` reads the
`data compatibility` line back to you afterwards, though not `notes`, which is
for a reader of the file — and treat `one_way` as meaning the backup below is
your only way back.

**Opening a Helmo-family store migrates it.** Helmo and the roadmap migrate
their store on open, so the *first command of the new release aimed at an
installation* is what migrates that installation's records — not the pointer
move, which touches one file. Two consequences:

- Take your backup before you run anything from the new release against the
  installation, not merely before `rev release upgrade`.
- This is why `--installation` is resolved and asserted *before* the store is
  opened: a command aimed at the wrong installation would otherwise have
  already written to it by the time it refused.

**Back up before you upgrade.** A recovery limit is only actionable if you have
something to recover from. Ask the installation what it owns rather than
guessing — reading the plan is safe, and the deletion it describes needs a
separate `--confirm`:

```bash
rev install remove          # no --confirm: prints the plan, removes nothing
```

Everything it lists under "removing" is what a backup must contain. In the
general case that is:

- `REV_HOME` whole — controls, `roster.toml`, `state/`, the service launcher.
- The Helmo store this installation names, and the roadmap store it names —
  **each with its `-wal` and `-shm` sidecars**. A SQLite database copied without
  its write-ahead log is not the records; it is the records as of some earlier
  moment.
- The selection file `INSTALLATION_RELEASE` names.

```bash
rev stop                                      # a live supervisor writes into REV_HOME
cp -a "$REV_HOME" /backups/acme-rev-2026-09-30
cp -a ~/.helmo-acme/helmo.db{,-wal,-shm} /backups/
cp -a "$INSTALLATION_RELEASE" /backups/release.json
```

To put it back: stop the installation again, restore each path over the top of
the current one — store and sidecars together, never the `.db` alone — restore
the selection file, and start. The restored selection names the older release
directory, so the older code comes back with the records it can read. Nothing in
a release directory needs restoring: a release directory is shared between
installations and no operation here writes to one. If one has been rebuilt under
the same name in the meantime, rollback refuses and names the component and both
commits rather than restoring something else under the old label.

## Upgrading

```bash
rev release upgrade /srv/releases/2026.09-2
```

- **The whole set is verified before the pointer moves.** An unverifiable
  component refuses the upgrade while the installation is still running the
  release it was running. The failure being designed out is the one where the
  pointer moves and the *next process to start* is what discovers the set is
  incoherent.
- **The replacement is atomic and durable**: a temp file in the same directory,
  `fsync`, `rename`, then `fsync` on the directory — without that last step the
  bytes are durable and the name pointing at them is not. A reader sees the old
  selection or the new one, never half of either.
- **The selection it replaces is retained whole inside the new one**, so going
  back needs nothing fetched or rebuilt. It is retained inside rather than
  beside, because one rename must move both or neither.
- Running it twice is not an error: an upgrade to the release already selected
  writes nothing and says so.
- **It restarts nothing.** A running process keeps the code it loaded and takes
  the new release when it next starts. Restart the service, or `rev stop` and
  start again, when you want the change to take effect now. Operating a service
  here would mean operating one the command has not established it owns.

**If your service definition predates the launcher.** A service definition is
written once and nothing rewrites it, so the program path it carries is frozen
at install time. A definition installed by an older version of Rev names a
`cli.js` *inside* a release directory — which means a restart after an upgrade
would bring back the release the installation has just left, and refuse to run.
`rev release upgrade` and `rev release rollback` detect that definition and warn
where the promise is made, rather than leaving it to a service manager's log.
The fix is one command: `rev service install` again, which writes the launcher
and repoints the definition at it.

## Rolling back

```bash
rev release rollback
```

Rollback is a pointer move, not a reinstall: it restores the selection retained
inside the current one, which is the same atomic write in the other direction.
What it can reach is therefore exactly **one step back**, from what the last
upgrade retained. It refuses, rather than leaving the installation worse than it
is, when:

- the current release declared a **one-way** migration — the refusal quotes the
  release's own `rollback.limit`, because rolling the pointer back would leave
  the new data in front of code that cannot read it;
- the selection retains **nothing** (it was selected directly rather than
  upgraded into) — point at the release you want with `rev release upgrade`
  instead;
- the selection was made **before its migration declaration was recorded**, so
  nothing can say whether going back is safe — re-select the current release
  with `rev release upgrade <its directory>`, which records the declaration, and
  the rollback becomes answerable;
- the retained release's **directory has been rebuilt**. A directory rebuilt
  under the same name is a different set wearing the old one's label, and the
  refusal names the component and both commits.

Recovering from a one-way release means restoring the pre-upgrade backup (the
procedure is under *Which versions go together*) and then selecting the older
release. That is why a release states its limit before
it can be selected.

## When the selection breaks

A half-written or hand-edited selection is not a transient state; it is an
installation that cannot run. All three products refuse with `incoherent release
set`, naming the product and what is wrong.

Two families are **exempt from that check**, and have to be: they are the only
two ways out, so gating them on the selection being sound would put the escape
behind the fault. Everything else in the installation refuses, in lines naming
both of these.

- `rev release status` reports the incoherence as lines instead of throwing —
  `release: UNREADABLE — …`, or `INCOHERENT` with every fault listed — because
  it is what an operator runs to find out what broke.
- `rev release upgrade <dir>` repairs it, and says plainly that nothing was
  retained to roll back to, rather than leaving you to discover that later.
- `rev install remove` is the other way out, for an installation you want gone
  rather than repaired. It prints its plan and takes nothing without
  `--confirm`, the same as always, and the unreadable selection file is one of
  the things it removes.

So a broken selection is a choice of two, not a dead end: repair it, or remove
the installation. Neither needs a hand `rm -rf`, and reaching for one is how a
shell carrying the wrong `REV_HOME` deletes the neighbour.

## Every entry point to review and repoint

A manifest alone is not a complete install. Selecting a release tells the *next*
start of each entry point which code to load; it does not go and find the entry
points for you. Pinning one and believing the installation isolated is how an
upstream rebuild reaches an installation nobody upgraded — so after selecting a
release, walk every path any part of your setup names.

That walk is its own document, because it is a checklist you work down with a
shell open rather than something you read once:
**[ENTRY-POINTS.md](ENTRY-POINTS.md)**. It covers Rev's roster, `REV_CLI`, the
service definition and the dashboard; Helmo's three binaries and the roadmap's
two; the `HELMO_HOME`/`HELMO_DB` and `ROADMAP_HOME`/`ROADMAP_DB` pairs; and the
paths you wrote yourself, which nothing in the release knows about.

It also covers verifying rather than trusting. The products answer the question
themselves — the `installation:` line on Rev's read surfaces and mutation
confirmations, the `installation` field inside every Helmo CLI result and error,
the startup line on the MCP servers and views, and the *running* build rather
than the configured one in `rev status`, `rev service status` and
`/health.json`. A process that stayed up across an upgrade is the one whose
answer changes, and `STALE` is what it says.

## Removing one installation

Two different removals, deliberately two different verbs:

```bash
rev service uninstall      # takes the service definition; every record stays
rev install remove         # prints what would go, removes nothing
rev install remove --confirm   # the one command that deletes an installation's records
```

`rev install remove` is **not** a flag on `rev service uninstall`, because the
difference between keeping and deleting every record must not be a word someone
can miss.

- **The plan is printed first and `--confirm` is a separate act.** Without it
  the command writes nothing and exits 0 — which is also the way to find out
  what an installation actually owns.
- **The boundary is the directories this installation owns** — for a home named
  the conventional way, `~/.rev-b` and the Helmo family's homes beside it
  carrying the same suffix, `~/.helmo-b` and `~/.helmo-roadmap-b`. Inside them,
  the removal takes Rev's home (controls, roster, state, service launcher), the
  Helmo store the roster names, the roadmap store `ROADMAP_DB`/`ROADMAP_HOME`
  names, and the selection file — each with its SQLite `-wal`/`-shm` sidecars
  beside it, since a database without its write-ahead log is not the records.
  Those names are unique among siblings by construction, the same fact the
  installation's identity rests on, so a neighbour's home is never one of them.
  The reserved `roadmap` suffixes are the exception to pairing a Helmo home:
  removal of `.rev-roadmap*` does not claim the `.helmo-roadmap*` name that is
  already another installation's roadmap home.
  The plan prints the boundary it used, so you can read it before you confirm.
- **A path in none of those directories is reported as left in place, with the
  reason, and never followed.** A shell carrying this installation's `REV_HOME`
  and a neighbour's `HELMO_DB` is precisely the case this exists for, and the
  neighbour's store survives it — including the case that made this a set of
  named directories rather than one enclosing one: `cp -a ~/.rev ~/.rev-b`
  brings `roster.toml` and its `helmo_db = ~/.helmo/helmo.db` along, so the
  second installation names the first one's records. Whether a path belongs to
  this installation is decided before the file is looked for: a store nothing
  has opened yet reads the same as one this installation owns.
- **Put the selection file inside the Rev home** (`~/.rev-b/release.json`, as
  above). One in the directory the homes share is not this installation's to
  delete — under this layout that directory is your account home, where a
  neighbour's `release.json` looks identical — so it is named in the plan as
  left in place and is yours to remove by hand.
- **A home named outside the convention** — anything but `.rev` or
  `.rev-<suffix>` — has nothing to pair with, so its boundary is the directory
  it sits in, and that holds only as far as that directory is one
  installation's. `/srv/installs/alpha/.rev` beside `/srv/installs/alpha/.helmo`
  is the layout that means; two differently named homes in one directory are
  not, and want the convention instead.
- **A product this installation names no store for gets no default assumed** —
  the default store is the shared one, and it is reported as left in place.
- **The refusals are ordered, and each names the command that clears it.** A
  standing service definition blocks the removal (`rev service uninstall`
  first, or a service manager keeps bringing back a supervisor whose home this
  deleted); a live supervisor blocks it (`rev stop` first — it writes state back
  into a home being removed); a `REV_HOME` that resolves to a directory
  containing the account's own home directory is refused outright.
- **Release directories are never touched.** A release is shared between
  installations, and `rev release` is what a version change goes through.

There is no undo, and no other command brings these back.

## What one installation's operations do not do to another

The whole point of the above is a boundary you can rely on rather than
remember. Installing, starting, restarting, upgrading, failing an upgrade,
rolling back, uninstalling a service and removing an installation's records all
address exactly one identity: the other installation's store, controls, files,
service definition, selection and loaded code are byte-for-byte what they were,
and its own records still answer. A shared explicit `REV_LABEL` makes a restart
refuse *before* the service manager is asked anything, naming both homes and the
way out. An interrupted release change recovers one coherent selection.

Those are not aspirations; each is an acceptance case run against two
disposable installations under one account, with the same home basenames, reused
seat names and record ids, and a shell given deliberately conflicting inherited
settings. The evidence a reviewer can check ships with the release notes.
