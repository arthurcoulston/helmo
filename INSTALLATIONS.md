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

- Helmo: [AGENT-INSTALL.md](https://github.com/arthurcoulston/helmo/blob/main/AGENT-INSTALL.md)
  — `HELMO_HOME` / `HELMO_DB`, `HELMO_LABEL`, `--installation <name|home|db>`,
  and qualified record references (`H-267@<label>`).
- Roadmap: [AGENT-INSTALL.md](https://github.com/arthurcoulston/helmo-roadmap/blob/main/AGENT-INSTALL.md)
  — `ROADMAP_HOME` / `ROADMAP_DB`, `ROADMAP_LABEL`, the same
  `--installation` assertion.
- Rev: [AGENT-INSTALL.md](AGENT-INSTALL.md) — `REV_HOME`, the roster, the
  service.

## One installation needs nothing here

The single-installation path is unchanged, and it is still the primary one. A
bare `~/.rev`, `~/.helmo` and `~/.helmo-roadmap`, with no release selected and
no new variable set, keeps working exactly as it did: the agent-led installs in
the three `AGENT-INSTALL.md` documents above remain the way to stand a first
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

- `REV_LABEL`, when it is set. Rev's own service install writes it into the
  service environment, so a job a service manager brings back with a bare
  environment resolves the identity it was installed under instead of
  re-deriving a different one.
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

Two homes with the **same basename** therefore get distinct service labels —
`/srv/customer-a/.rev` and `/srv/customer-b/.rev` are two installations, not
one. This matters more than it looks: a service manager's namespace belongs to
the uid, not to `$HOME`, so two installations under one account share one
bootout and kickstart address no matter where their definition files live.

A Helmo-family installation standing without Rev names itself the same way
through `HELMO_LABEL` (and `ROADMAP_LABEL` for the roadmap), which is why those
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
a store path, for the same reason.)

## Installing a selected release

An installation can either run whatever code its entry points were started from
— the unpinned arrangement above — or be **pinned** to an immutable release set.
Pinning is what makes "which version is this installation on?" a question with
an enforceable answer.

A **release directory** holds the three products built side by side, plus two
files that describe the set:

```
releases/2026.09-1/
  RELEASE.json        commits: { rev, helmo, helmo-roadmap } — which build this set is
  MIGRATION.json      data_compatibility + rollback — what this release does to your data
  rev/dist/           built, with its BUILD.json stamp
  helmo/dist/
  helmo-roadmap/dist/
```

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

- A release change is picked up by a **restart**, with no reinstall. That is
  exactly what the upgrade's own output promises.
- The service manager's signals, its exit timeout and the pid it supervises all
  reach the supervisor itself, so drain, `rev stop` and the sentinels behave as
  if the manager had named the supervisor directly.

If the launcher cannot resolve the selection, it refuses in one line naming the
installation and the repair, and exits non-zero on purpose: the manager retries,
so repairing the selection brings the supervisor back with no command run.

## Which versions go together, and what a migration cannot undo

**The rule the product enforces.** A release set is valid when, for each of
`rev`, `helmo` and `helmo-roadmap`: the set's `RELEASE.json` names a commit for
it; its `dist` holds JavaScript; and its `BUILD.json` stamp names *exactly* that
commit, built from a clean tree. A dirty component is refused — a build stamp
records a dirty tree rather than refusing it, which is right for a build and not
enough for a release, because the manifest's commit would not identify the bytes.
Every fault in a set is reported at once, so a bad set is fixed in one pass
instead of three rebuilds.

Three products at three arbitrary versions is therefore not a supported
combination and cannot be made into one by editing a file: the set is what is
verified, and a mismatch is visible rather than masquerading as a completed
upgrade.

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
rollback is supported is refused as self-contradictory: an operator would
otherwise find out which half was wrong by losing data.

The compatibility matrix and migration statement for a particular version ship
with that version's release notes; this section is the rule they are written
against.

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

Recovering from a one-way release means restoring the pre-upgrade backup and
then selecting the older release. That is why a release states its limit before
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

A manifest alone is not a complete install. Pinning one entry point and
believing the installation isolated is how an upstream rebuild reaches an
installation that never restarted anything — so after selecting a release, walk
every path any part of your setup names:

- **Rev**: the roster's `helmo_cli` and `helmo_mcp_server`, each loop's `cwd`,
  MCP server commands and `skills` paths; `REV_CLI`; the dashboard; the service
  definition (for a pinned installation, `<REV_HOME>/service/launch.mjs`, not a
  `cli.js` inside a release).
- **Helmo**: the CLI, the stdio MCP server, the remote surface, the view.
- **Roadmap**: the MCP server and the read-only view. Both migrate a store by
  opening it, so both are entry points for this purpose.
- **Anything you wrote yourself** that names a product path: wrapper scripts,
  guards, agent or editor configs, service units not installed by
  `rev service install`, and shell profiles exporting `REV_HOME`, `HELMO_DB` or
  `ROADMAP_DB`.

Verify rather than trust. The products answer this question themselves:
`installation: <label> (<home>)` on Rev's read surfaces and mutation
confirmations; the `installation` field in Helmo CLI results; the startup
installation line on the MCP servers and views; and the *running* build — not
the configured one — in `rev status`, `rev service status` and `/health.json`.
A process that stayed up across an upgrade is the one whose answer changes.

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
- **The boundary is the installation home**: the directory Rev's own home sits
  in. Inside it, the removal takes Rev's home (controls, roster, state, service
  launcher), the Helmo store the roster names, the roadmap store
  `ROADMAP_DB`/`ROADMAP_HOME` names, and the selection file — each with its
  SQLite `-wal`/`-shm` sidecars beside it, since a database without its
  write-ahead log is not the records.
- **A path outside that boundary is reported as left in place, with the reason,
  and never followed.** A shell carrying this installation's `REV_HOME` and a
  neighbour's `HELMO_DB` is precisely the case this exists for, and the
  neighbour's store survives it. Whether a path belongs to this installation is
  decided before the file is looked for: a store nothing has opened yet reads
  the same as one this installation owns.
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
