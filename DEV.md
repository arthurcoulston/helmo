# DEV — coding context for the Helmo repository

One repository, three products and the module they share. This file is what
holds across all of them; each area's own `DEV.md` is the context for its
internals, and a dev session reads this one first and then that one.

| Area | Package | Name on npm/bin | Its context |
| --- | --- | --- | --- |
| App shell | `packages/app` | served by `helmo serve` | this file |
| Work | `packages/work` | `helmo` | [DEV.md](packages/work/DEV.md) |
| Roadmap | `packages/roadmap` | `helmo-roadmap` | [DEV.md](packages/roadmap/DEV.md) |
| Runtime | `packages/runtime` | `rev` | [DEV.md](packages/runtime/DEV.md) |
| Core | `packages/core` | `@helmo/core` | this file |
| Front command | `packages/cli` | `helmo` | this file |

## What `packages/cli` owns

`packages/cli` is the whole of `helmo`: one table of groups, and a dispatch that
sets `process.argv` and imports the target area's own entry module — runtime
re-execs itself through `argv[1]`, so the target must see the path it would have
seen had the caller named it. It has no dependencies and no build step, and it
should keep neither: it resolves its siblings by path, so a group whose package
is not built refuses by name instead of failing to load a module. Adding a group
is a row in that table, a line in `--help`, a row in
[COMPATIBILITY.md](COMPATIBILITY.md) if it replaces a name, and a test that
proves the target actually ran rather than that a path resolved.

`helmo mcp` dispatches to Work's `unified-server`, which registers the existing
Work and Roadmap tool builders on one SDK server. The per-area server entries
remain unchanged compatibility surfaces; their schemas are compared byte for
byte with the unified listing in the fixture test.

`helmo serve` owns the one application listener. It imports each product's
request handler into that process. The shared shell owns `/`, `/work`,
`/roadmap`, `/team`, and `/run`; its migrated Work, Roadmap, and Runtime pages
read `/api/v1/work`, `/api/v1/roadmap`, and `/api/v1/runtime`. The product
handlers retain the answer routes and supply those JSON documents. The
aggregate machine reading remains at
`/health.json`. The product view entries remain executable compatibility
surfaces; importing them never binds their old ports.

`app-server.mjs` is the listener kernel under it: one app listener plus the
installation's configured retired set, started as one lifecycle and closed as
one. Its configuration is read at both ends — `appConfig` normalizes, and
`startAppServer` validates what it is handed — so every normalizing step there
has to be idempotent. The one that was not refused to start an installation
that retired a port onto the app root, which is why `route('')` now means the
root rather than a refusal.

`test/app-acceptance.test.mjs` is the compatibility acceptance for all of it,
and it drives the real `helmo serve` process: 301 and its `Location`, the
destination answering 200 and rendering the named record, the bound port set
read from the operating system rather than from the app's own account of
itself, two installations whose colliding ids stay apart, and `SIGTERM`. The
estate's numbers (`:4410`, `:4500`, `:4300`) are the *rows* of its fixture,
rebased onto ephemeral ports: a test that bound 4410 would be fighting the
installation it is proving. `test/installation.mjs` holds the disposable
installation helpers and the one environment scrubber they all go through — a
second, slightly different scrubber is how one test file quietly stops being
isolated (H-2644).

The deprecating adapters for the old binary names live beside the area they
front, in `packages/<area>/bin/`, and are what that area's `bin` entries point
at. Before its documented UTC sunset each writes one line to stderr and imports
the unchanged `dist` entry; after it, the adapter refuses before that import.
Nothing about the implementation moves.

## What `core` owns

`@helmo/core` holds the mechanics all three products were implementing
separately: installation identity and its precedence, install home resolution,
qualified record references, config reading, the build stamp, release
selection, and the versioned application JSON envelope. Area packages supply
the data; Runtime's additive `/api/v1/runtime` route is the first consumer and
leaves the `/health.json` compatibility surface unchanged. One documented
precedence replaced three lists that differed by one entry, which is the
measured cause of an identity incident (H-2424).

Every Helmo-family surface accepts canonical `HELMO_INSTALLATION`, followed by
the legacy `ROADMAP_LABEL`, `HELMO_LABEL`, and `REV_LABEL`. Precedence picks the key when one is set; two accepted keys
carrying distinct values refuse at startup rather than guessing. Adding a
product does not add a fourth copy of any of this — it consumes `core`.

`namesResolvedInstallation` is the one function behind both `--installation` and
the `<id>@<installation>` reference qualifier, so the two cannot drift. It
accepts a declared set of names for one installation rather than a single
string: the resolved label, the `dev.helmo…` / `dev.roadmap…` an area's
conventional home derives standing alone, and the home or store path.
`VERSIONING.md` declares that set and its window. The legacy row matters
because a supervised installation is named `dev.rev…` while the same home alone
derives `dev.helmo…` — 45 references recorded in this estate are in the older
spelling, and the alias is why they still resolve. `qualifiedRecordRef` only
ever hands out the resolved label, so the set does not grow from use, and a
qualifier outside it still refuses before any store is opened.

Release selection reads both shapes: a historical three-component
`rev`/`helmo`/`helmo-roadmap` set, so an installation can still inspect and
roll back across the consolidation boundary, and a one-component `helmo` set,
where the three products live at `packages/work`, `packages/roadmap` and
`packages/runtime`. New selections are written one-component only, and a
partial, extended or mixed manifest refuses rather than falling through to the
legacy reader.

## Boundaries the build enforces

- **The runtime never reads the work record's store.** Runtime talks to Work
  through its CLI and MCP surfaces, never its SQLite. The monorepo makes that
  import available for the first time, so `packages/runtime` asserts it in
  `prebuild` (`scripts/check-import-boundary.mjs`) and the build fails on a
  violation. A rule a reviewer has to remember holds until the first busy week.
- **A build writes only where it is marked to.** The root `npm run build`
  refuses unless the root carries the build marker, so it can never write into
  a release directory or a checkout an installation resolves through.
  The root `npm test` likewise refuses before workspace tests unless the four
  built packages carry their expected build artifacts. `scripts/build.mjs`,
  `scripts/assert-built.mjs` and `scripts/build.test.mjs` are the whole of it.
  The one script that *does* write into a release directory is
  `scripts/stage-legacy-launch-paths.mjs`, and it is never part of a build: it
  is run by hand against a staged release, and it refuses the layout whose
  real builds live at the paths it writes.
- **One version.** Every package carries the root version and depends on
  `@helmo/core` at exactly that version; `scripts/build.test.mjs` asserts it.
  What the number promises is [VERSIONING.md](VERSIONING.md), and a change to
  the surfaces it names is a version decision, not an implementation detail.

## Shared idiom

All three products are built the same way, and a change that breaks the idiom
in one of them is a defect in all three:

- **Append-only event log, materialized state.** `rebuild()` is the invariant
  and the tests enforce it: every side effect of a write lives in an `apply*`
  function, or replay silently diverges.
- **`.immediate()` write transactions**, never deferred.
- **Actor provenance on every write**, recorded and checked as an assertion —
  never authenticated. The stores record who claimed to write; they do not
  verify real-world identity.
- **The markup gate** at the door, rejecting mangled tool-call writes (H-71).
- **One vendored estate design-token source** in `core`, rather than a runtime
  dependency on the private estate repository. Every view imports that public
  copy; the drift tests skip visibly when the estate source is absent, because
  a check that quietly passes when its input is missing can never go red.

## Documents

Product-wide documents live at the root and exist once: `README.md`,
`LICENSE`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md`,
`VERSIONING.md`, `AGENTS.md` (with `CLAUDE.md` as its shim), `AGENT-INSTALL.md`,
`INSTALLATIONS.md`, `ENTRY-POINTS.md`, `ISOLATION-CHECKS.md`,
`COMPATIBILITY.md` and this file.
`scripts/build.test.mjs` asserts that set is present and unduplicated — a
second `LICENSE` or `SECURITY.md` inside a package is how three products drift
back apart.

Each area keeps its own `README.md`, `DEV.md`, its product description, and its
summoned-role file. The install guide is NOT among them: one product installs
once, and three guides each naming their own clone URL is the same drift as
three licences. `INSTALLATIONS.md` is a published
promise: a change to install, release or removal behaviour is a change to that
document in the same pass.
