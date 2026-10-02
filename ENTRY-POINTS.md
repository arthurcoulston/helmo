# Entry points — what to review and repoint when you change a release

A manifest alone is not a complete install.

Selecting a release tells the *next* start of each entry point which code to
load. It does not go and find the entry points for you. Anything that still
names a checkout, a shared build directory or an old release keeps naming it —
and the parts of your setup that never restarted keep running what they already
loaded. Pinning one entry point and believing the installation isolated is how
an upstream rebuild reaches an installation nobody upgraded.

So this is a checklist, meant to be worked down with a shell open. For every
entry point it asks the same three questions:

1. **What does it name now?** — the command that shows you, rather than memory.
2. **What should it name?** — under the release you selected.
3. **How do I know it took?** — the surface that answers, after a restart.

It is the companion to [INSTALLATIONS.md](INSTALLATIONS.md), which covers what
an installation is, and how to install, upgrade, roll back and remove one. Do
that first; come here afterwards.

## One command in front of all of it

Everything below is also reachable through `helmo`, the one command: `helmo
work`, `helmo roadmap`, `helmo run`, `helmo serve <work|roadmap|run>`, `helmo
mcp <work|roadmap>`, and `helmo release`, `helmo service` and `helmo team` for
the runtime verbs this page uses most. `helmo --help` lists them.

It does not shorten this checklist, and it adds nothing to repoint. The paths
below are what a roster, a plist or an MCP client names, and none of them has
moved. What is changing is four old binary *names* — `helmo-cli`, `helmo-mcp`,
`roadmap-mcp` and `helmo-view` — each of which still works and now says on
stderr what replaces it and when it stops. The dates are in
[COMPATIBILITY.md](COMPATIBILITY.md).

## One installation needs nothing here

If you run one installation of each product, from one checkout, with no release
pinned and no `REV_HOME`, `HELMO_HOME` or `ROADMAP_HOME` set, there is nothing
on this page for you. Every path already names the only install there is. The
single-installation path is unchanged and still the primary one.

This page starts to matter the moment there are two — or the moment one
installation is pinned to a release and another is not.

## The checklist

Work it from the products outward, then from your own files inward. The last
section is the one that catches people: the paths nothing in the release knows
about are the paths you wrote yourself.

### Rev

Rev has the most entry points because it starts other things.

**The roster** — `$REV_HOME/roster.toml`. Two of its `[global]` keys are
required paths into Helmo's build, and several per-loop keys are paths too:

```bash
grep -nE 'helmo_cli|helmo_mcp_server|cwd|constitution|mcp_extra|skills' \
  "$REV_HOME/roster.toml"
```

- `helmo_cli` and `helmo_mcp_server` must name the Helmo build inside the
  release you selected — `<release>/helmo/dist/cli.js` and
  `<release>/helmo/dist/server.js`. These are the two most commonly missed,
  because Rev starts fine with them pointing anywhere readable.
- Per loop: `cwd`, `constitution`, `mcp_extra` and `skills` are all paths. A
  `cwd` or `constitution` inside a release directory will be *gone* after two
  upgrades — point those at your own working trees, not at release contents.
- `mcp_extra` names a file that itself contains server commands. Open it; the
  grep above will not see inside it.

**`REV_CLI`** — whatever your own scripts and agents invoke Rev through:

```bash
echo "${REV_CLI:-(unset)}"
grep -rn 'REV_CLI\|HELMO_DB\|HELMO_HOME\|ROADMAP_DB\|ROADMAP_HOME' \
  ~/.zshrc ~/.zprofile ~/.bashrc ~/.profile 2>/dev/null
```

**The service definition.** `rev service status` prints the file it reads:

```
installation: dev.rev.alpha.01640b9d (/tmp/installs/alpha/.rev)
build:        9055f6e built 2026-09-30T17:13:03.417Z — ace8b4f8125b
running:      — (the supervisor is not running)
service file: not installed (~/Library/LaunchAgents/dev.rev.alpha.01640b9d.plist)
supervisor:   down
```

For a pinned installation that definition must name
`<REV_HOME>/service/launch.mjs` — the launcher inside your *installation*, which
resolves the selection at start. A definition naming a `cli.js` frozen inside a
release directory is pinned to *that* release for ever: change the selection and
its next start refuses, because the path it names has been superseded. If yours
predates the launcher, `rev service install` rewrites it — and retires a legacy
definition only when that definition names this same home.

**The dashboard.** Rev's view is a long-lived process, so it is both an entry
point to repoint *and* the process most likely to be running old code. If you
start it from a service manager, its definition is a path to review like any
other; if you start it by hand, the path in your shell history is the
definition.

### Helmo

Three entry points, one per binary — `helmo-cli` (`dist/cli.js`), the stdio MCP
server `helmo-mcp` (`dist/server.js`), and the view `helmo-view`
(`dist/view.js`) — plus the remote surface if you run one.

Under a selected release each is `<release>/helmo/dist/<file>`. Those paths are
the implementation and carry no deprecation notice; it is the binary *names*
`helmo-cli`, `helmo-mcp` and `helmo-view` that are leaving, on the dates in
[COMPATIBILITY.md](COMPATIBILITY.md). Review every place that names one: Rev's roster (above), your agent and editor MCP
configuration, wrapper scripts, and any service definitions you wrote yourself.

`HELMO_HOME` and `HELMO_DB` are a pair, and **either one alone determines the
other**: `HELMO_HOME` alone puts the store at `<home>/helmo.db`, and `HELMO_DB`
alone treats the store's parent directory as the installation home. That is
deliberate, so a configuration that only ever named a store path keeps working.
Setting both to disagree is refused before the store is opened:

```json
{"error":"HELMO_HOME and HELMO_DB name different installations — HELMO_HOME=/tmp/installs/alpha/.helmo but HELMO_DB=/tmp/installs/beta/.helmo/helmo.db, which is not inside it. Unset one: HELMO_HOME alone uses /tmp/installs/alpha/.helmo/helmo.db, HELMO_DB alone treats /tmp/installs/beta/.helmo as the installation home."}
```

### The roadmap

Two entry points — `roadmap-mcp` (`dist/server.js`) and the read-only
`roadmap-view` (`dist/view.js`). **Both are entry points for this purpose even
though only one is written to**, because both migrate the store by opening it:
a view started from the wrong release can migrate a store the rest of the
installation is not ready for.

`ROADMAP_HOME` and `ROADMAP_DB` are the same pair with the same rule, and the
same refusal when both are set and disagree.

### Anything you wrote yourself

Nothing in the release knows about these, so nothing in the release can fix
them. They are also where a shared path survives longest, because they tend to
be written once and never read again:

- wrapper scripts and shell aliases that name a product path;
- guards, hooks and pre-commit scripts that shell out to a product;
- agent, editor and MCP client configuration files;
- service units and scheduled jobs you installed yourself, rather than through
  `rev service install`;
- shell profiles exporting `REV_HOME`, `REV_CLI`, `HELMO_HOME`, `HELMO_DB`,
  `ROADMAP_HOME` or `ROADMAP_DB` — an export in a profile reaches every shell
  you open, including the one you run the *other* installation from.

A grep across the files you control, for the release directory's parent and for
any checkout path you used to run from, finds these faster than remembering
them.

## Verifying instead of trusting

Repointing a path is not evidence that anything took. Every product answers the
question itself, so ask it rather than assuming.

### Which installation is this?

Rev prints an `installation:` line on read surfaces and on mutation
confirmations:

```
installation: dev.rev.alpha.01640b9d (/tmp/installs/alpha/.rev)
```

A pinned installation adds `— release: <name>`. When the environment cannot be
trusted to name one installation the line reads
`installation: UNCLEAR — <what disagrees>` instead, and a command that writes
refuses rather than guessing.

Helmo's CLI puts the same answer *inside* its result object, so a caller
parsing the JSON gets it without a second call — and inside its `{"error"}`
envelope too, so a failure still says which installation failed:

```json
{
 "installation": {
  "label": "dev.helmo.alpha.f8c31d6c",
  "home": "/tmp/installs/alpha/.helmo",
  "db": "/tmp/installs/alpha/.helmo/helmo.db",
  "source": "derived",
  "running": {
   "state": "verified",
   "dir": "/private/tmp/installs/releases/2026.09.1/helmo/dist",
   "digest": "5ec8795ea284",
   "commit": "71ae82d0d25a15c7edaa33cd92c485aaa1c9f5f4",
   "dirty": false,
   "detail": "running the build on disk"
  }
 },
 "tickets": []
}
```

`running.dir` is the reading that proves a repointed path took: it is the
directory the code *actually loaded from*, not the one you configured.

The four MCP-and-view surfaces each print an installation line at startup. The
stdio MCP servers print theirs on **stderr**, because stdout is the protocol
channel — if you are looking for it in a client's logs, that is which stream to
look in, and stdout carries nothing but protocol:

```
Helmo MCP (stdio) — install: dev.helmo.alpha.f8c31d6c (/tmp/installs/alpha/.helmo) — db: /tmp/installs/alpha/.helmo/helmo.db — running: 71ae82d
```

The views print theirs on startup and carry it in the page footer:

```
Helmo view: http://localhost:4487 — install: dev.helmo.alpha.f8c31d6c (/tmp/installs/alpha/.helmo) — db: /tmp/installs/alpha/.helmo/helmo.db — running: 71ae82d (read-only; set HELMO_OPERATOR to answer)
```

A label you did not choose is derived from the installation home, and carries
eight hex characters of that path whenever the home is not a plain
`.helmo`-style directory in your account's home — because two installations can
have homes with the same basename. Set `HELMO_LABEL`, `ROADMAP_LABEL` or
`REV_LABEL` if you want to read your own names back instead.

### Which build is actually running?

This is the check that catches the upgrade you thought you finished. A process
that stayed up across a release change is still executing the code it loaded;
the artifact on disk has moved on without it. So each product reports the
configured build and the running one separately, and the running reading is
taken from a digest of the JavaScript the process actually loaded rather than
from a version string it could have inherited.

Rev's `status` and `service status` report both:

```
build:        9055f6e built 2026-09-30T17:13:03.417Z — ace8b4f8125b
running:      — (the supervisor is not running)
```

and `/health.json` on the Rev view carries the same values as fields —
`installation`, `build`, and `running` per process.

**Three answers are real, and two of them are not failures of the check:**

- `running: <commit> — … is running the build on disk` — agreement. What you
  configured is what is executing.
- `running: <commit> STALE — …` — the code directory has changed since this
  process loaded from it. **This is the answer you are looking for after an
  upgrade**, and it means exactly one thing: restart that process. Here is a
  live view's footer after the build under it was replaced:

  ```
  read-only · … · dev.helmo.alpha.f8c31d6c · /tmp/installs/alpha/.helmo/helmo.db · ⚠ build 71ae82d STALE · refreshed just now
  ```

  with the detail on hover: `/private/tmp/installs/releases/2026.09.1/helmo/dist
  has changed since (now 71ae82d/78266927c149) — this process is not running
  what is there`.
- `running: UNVERIFIABLE — …` — the reading could not be taken. Treat it as
  "unknown", never as "fine": an unverifiable answer and a good answer are not
  the same claim, and the products keep them apart rather than defaulting one
  into the other.

A build reported `(dirty)` was built from a modified tree, so its commit does
not certify the bytes — useful while developing, not something to leave in a
pinned installation.

### Asserting the target in your own scripts

`--installation <name|home|db>` takes any spelling you have in front of you: the
label a status line printed, the installation home, or the store path. It
**asserts** the target and cannot redirect a command to another installation —
so a disagreement is a refusal naming both candidates, not a silent switch:

```json
{"error":"--installation named 'alpha', but this process resolves installation 'dev.helmo.alpha.f8c31d6c' (home /tmp/installs/alpha/.helmo, store /tmp/installs/alpha/.helmo/helmo.db) from the environment. Nothing was opened or written. --installation asserts the target and cannot move it: point HELMO_HOME or HELMO_DB at the installation you meant."}
```

All three products assert on **every** entry point, reads included, and exit
non-zero when the name disagrees. That is what makes the flag usable as a guard:
a read is where you want the assertion, before the script does anything else.
Rev's refusal names the command it stopped:

```
refusing to run 'rev status': --installation named 'alpha', but this command resolves installation 'dev.rev.beta.9c2f10a4' (/tmp/installs/beta/.rev) from the environment. Nothing was written. Point REV_HOME at the installation you meant.
```

Both spellings work everywhere — `--installation <value>` and
`--installation=<value>`. Two details are worth knowing:

- **Rev takes a name or a home; Helmo and the roadmap also take a store path.**
  Rev has no store of its own to name.
- **`release status` and `install remove` still run while the release selection
  is broken**, and still assert the name. Identity and selection coherence are
  separate checks, so the two ways out of a broken selection are not put behind
  the fault.

### Referring to one installation's records from another

A bare record id is fine within one installation and stays fine — nothing about
your existing references changes. Across installations it is ambiguous, because
ids are minted per installation and every installation has its own `H-42`. The
qualified spelling carries the target with the id:

```
H-267@dev.helmo.alpha.f8c31d6c
```

It is accepted everywhere a bare id is, and it **asserts** rather than forwards:
a qualified reference handed to the wrong installation is refused, not answered
with that installation's own unrelated record. Quote the qualified form in
anything that travels — notes, evidence, messages between installations.

## What this guide does not cover

- **Choosing a release, and going back.** Clean install, upgrade, rollback, a
  broken selection and removing an installation are all in
  [INSTALLATIONS.md](INSTALLATIONS.md).
- **Which versions form a valid set.** The compatibility rules, `MIGRATION.json`
  and the limits of a rollback are in INSTALLATIONS.md too. Repointing an entry
  point at a release that is not a coherent set gets you
  `incoherent release set` at the next start, not a subtle failure.
- **Each product's own identity and targeting reference.** This page is the
  cross-product walk-through; the authoritative per-product detail is in each
  repo's own install document, and a Helmo-family installation standing without
  Rev is supported and documented there.
