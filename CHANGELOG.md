# Changelog

This is Helmo Roadmap's first published set of release notes. It is scoped to
the independent-installations release and does not reconstruct what came before
it; earlier history is in the git log.

## Unreleased

The roadmap can be installed more than once under one account. Each installation
has a name that both entry points resolve and print, a store it alone writes, a
build identity read off the code actually loaded, and record references that say
which installation minted them and refuse one carried from another.

### An installation has a name, and both entry points say which

- One resolver for both entry points (H-2472). `server.ts` and `view.ts` each
  read `ROADMAP_DB` on their own, so the only thing that said which roadmap you
  were talking to was a database path, and nothing printed it back.
  `ROADMAP_HOME` names the installation and `ROADMAP_DB` names its store; either
  alone determines the other, so every existing caller keeps working untouched,
  and no variables at all still means `~/.helmo-roadmap/roadmap.db`. Both set and
  disagreeing is refused before the store is opened, naming both candidates. The
  name is shared rather than invented here: `ROADMAP_LABEL`, then `HELMO_LABEL`,
  then the supervisor's `REV_LABEL`, then derived from the roadmap's own home —
  so one installation has one name, whichever of the three products you ask.

- Both entry points assert the installation they serve (H-2474). Each prints one
  installation line at startup — the MCP server on stderr, because stdout is the
  protocol channel — and `--installation <name|home|db>` on argv ASSERTS that
  target rather than choosing it. Neither surface has a flag parser of its own,
  so the assertion is read off argv directly and the check sits inside the
  resolver, where neither can resolve a target and forget to verify it. A value
  disagreeing with the environment refuses before the store is opened;
  `ROADMAP_HOME`/`ROADMAP_DB` remain the only things that move the target. The
  proof that the refusal comes first is a store file that does not appear.

- An installation can be pinned to an immutable multi-product release set
  (H-2454). Set `INSTALLATION_RELEASE` to the selection's `ADOPTED.json`;
  resolution then verifies the selected Rev/Helmo/Roadmap commit set and refuses
  code from another checkout.

- A store belongs to the installation that first wrote it under a name (H-2488).
  An explicitly named installation claims `installation_name` in the store's
  `meta` table, atomically with its first event; a later write from a process
  resolving a different name is refused, with nothing written. Reads stay
  available and report the disagreement as UNCLEAR beside both names. This is
  what catches a name INHERITED from elsewhere, which no flag can catch, because
  nothing was typed wrong. A derived-only installation claims no name, leaving
  existing single-store use exactly as it was.

### References that say whose they are

- A cross-installation reference has one spelling, and the product accepts it
  back (H-2506). The roadmap advertised a qualified form of its own —
  `<label>:R-1`, a second idiom for the thing Helmo spells `R-1@<label>` — and
  advertised it only: handed back to the very installation that minted it, it
  answered "Project not found". So an agent that quoted the reference the
  product gave it was told the record did not exist, and fell back to the bare
  `R-1`, which resolves in whichever installation it happens to be talking to.
  The spelling is now Helmo's, and the inbound half is the load-bearing one:
  every `project_id`, `objective_id`, dep endpoint and charter item id is
  resolved through the reference rules before it reaches the store, so a
  reference carried from another installation refuses having read and written
  nothing, rather than landing on an unrelated record of the same name. A bare
  id keeps working: within one installation it is unambiguous. Every MCP result
  collects the ids it returned into `references`, pairing each with its
  qualified form.

### What is running

- Every process answers for the code it loaded (H-2492). One reading is taken at
  startup and compared afresh on every report: a rebuild beneath a live process
  is `stale`, a source run or unreadable code is `unverifiable`, and the commit
  named is always the loaded one. `postbuild` writes the stamp beside the
  artifact. Every MCP result carries the installation and the build state.

- The dashboard footer says which installation it is and which build is drawing
  it. It said only the store path, which answers neither question; the startup
  line already said both, and nobody reading a dashboard has the startup line.
  It is read per render, so a view that stays up across a rebuild reports
  `stale` rather than the artifact's newer commit.

### Documentation

- The README says how to pin an installation to a release set (H-2454), and
  points a multi-installation reader at `ENTRY-POINTS.md` in the Rev repo — the
  checklist of every path to review when you add an installation or change which
  release one runs (H-2517). `ISOLATION-CHECKS.md` in the same repo is the
  reviewer's version, with the commands to re-derive each isolation property
  against your own two installations.

### Not covered by this release

- A derived-only installation — no `ROADMAP_LABEL`, no `HELMO_LABEL`, no
  `REV_LABEL` — claims no durable name, so nothing at the store level
  distinguishes it from another derived installation pointed at the same store.
  That is deliberate, so single-install use is untouched, but it means the
  store-level guard protects named installations only. If you run two, name them.

- The store claims its name from the first explicitly named writer, so a store
  with history from before this release carries no name until some named process
  writes to it — and whichever named process writes first claims it, whatever it
  is called. On an existing pair, write once from each installation under its
  intended name and check the claim landed before relying on the guard.

- What a process reports as running is a reading of the code it loaded, not a
  guarantee about which commit produced it: a dirty-tree build is reported as
  what it is.

- A release change is taken at the next start. Restarting the MCP server or the
  view is still a deliberate act.

- The roadmap has no browser in its toolchain. Its shared presentation controls
  assert their shape here and lean on Helmo's repo for the rendered behaviour.

### Commit coverage

Every commit in this release is represented above. This manifest makes that
claim auditable without relying on ticket-title conventions:

- `b20a070`, `487a7f4`, `931e474`, `739dd29`, `c201e42`, `92e62cd`,
  `91ba2d4`, `9af13c4`, `f04d504`, `f68d3cf`, `a5a508d`
