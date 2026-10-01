# Helmo Roadmap

The layer above the ticket. [Helmo](https://github.com/arthurcoulston/helmo)
records work **being done**; this records work **worth doing** — where an idea
gets parked, fleshed out, costed, ranked, and eventually declared go. Separate
products, separate stores: together they read as one system, apart each stands
alone.

The full design is [PRODUCT.md](PRODUCT.md). The charter template that ships
with the product is [CHARTER-TEMPLATE.md](CHARTER-TEMPLATE.md).

## Run

**Agent-led install is the primary path.** Tell your agent: *"I want to use
Helmo Roadmap — install it and set it up."* and point it at
[AGENT-INSTALL.md](AGENT-INSTALL.md). It runs the install end to end and
returns your view link and getting-started instructions.

For an immutable multi-product installation, set `INSTALLATION_RELEASE` to
its `ADOPTED.json`. Both Roadmap entry points verify the selected
Rev/Helmo/Roadmap commit set and refuse code from another checkout.

Running more than one installation, or changing which release one runs? Both
entry points — `roadmap-mcp` and `roadmap-view` — are paths something in your
setup names, and both migrate a store by opening it, so a view started from the
wrong release matters as much as the server. The checklist of every path to
review, and the surfaces that tell you what is actually running, is
[ENTRY-POINTS.md](https://github.com/arthurcoulston/rev/blob/main/ENTRY-POINTS.md)
in the Rev repo.

To run it yourself: requires Node.js and npm. No Helmo server, Crew
checkout, or Estate checkout is needed to run this product. The SQLite
dependency may need a native build toolchain when a prebuilt binary is
unavailable for your Node/platform pair.

- From a clean checkout: `npm ci && npm run build && npm test`.
- MCP server (stdio): `node dist/server.js` — store at
  `~/.helmo-roadmap/roadmap.db` (`ROADMAP_DB` overrides); writer identity from
  `ROADMAP_ACTOR` or `HELMO_ACTOR` (JSON), or a per-call `actor` param.
- Read-only view: `node dist/view.js` — `http://localhost:4410`
- Operator recovery: `node dist/recovery.js backup|validate ...` creates only fresh owner-only artifacts; it never restores into a live installation. See `DEV.md` for flags and the safety boundary.
  (`ROADMAP_VIEW_PORT`).

Tests use temporary stores. Two optional source-drift comparisons report
**skipped** when the upstream Estate source is absent; the vendored tokens
and avatars still build and render without it. Never point tests at a live DB.

## The shape

- **Getting an idea in costs nothing** — a title, ideally a sentence. Bad
  ideas belong here, ranked low; that is the process succeeding.
- **Rank is derived, never hand-set.** Facts (ship-next, in motion, ready,
  shaping, blocked, parked) set the tier; attributed judgments (value, effort)
  order within it. Every rank explains itself in one line.
- **Effort is predicted in dollars** and checked against the metered actual
  rolled up from the project's Helmo tickets — falling costs re-sort the list
  without anyone changing their mind about value.
- **Ship-next is the human's recorded decision.** Several projects may be
  active together; the returned count makes that commitment visible.
- **The charter is the one thing the human writes and agents only read** —
  the store holds a projection (objectives and bets) with provenance back to
  the human's own document.

Current product stage: **MVP**. The version number is not a stage promotion.
Build, store/replay tests, smoke of the read-only view, and the estate's
mobile/desktop accessibility and layout checks form the current acceptance
floor. Publication also requires the separate privacy/history and clean-setup
review; 1.0 visual baselines and Scale operations are not claimed.

The view is local and read-only. Back up the SQLite store before upgrades;
keep backups private. See [SECURITY.md](SECURITY.md) for disclosure and
[LICENSE](LICENSE) for the MIT terms.
