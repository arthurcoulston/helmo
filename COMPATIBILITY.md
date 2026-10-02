# Compatibility — the old names, and when they stop working

Helmo is one product with one command: `helmo`. It was three products with
eight, and every one of those names still works. This page says which are
leaving, what replaces them, and the date each stops — so a setup that names
an old one can be moved on a schedule rather than discovered broken.

What a version number promises is in [VERSIONING.md](VERSIONING.md); the paths
your own setup names are in [ENTRY-POINTS.md](ENTRY-POINTS.md).

Installation identity is now written as `HELMO_INSTALLATION`. Existing
`HELMO_LABEL`, `ROADMAP_LABEL`, and `REV_LABEL` settings remain accepted for
the two-release window in [VERSIONING.md](VERSIONING.md); if more than one is
set, every value must agree. Newly installed services write only the canonical
key.

## The one command

```
helmo <group> [...]      helmo --help lists every group
```

| Group | What it fronts |
|---|---|
| `helmo work <sub>` | the work record: tickets, evidence, queues, releases |
| `helmo roadmap <sub>` | the roadmap store's identity, backup and validate tools |
| `helmo run <sub>` | the runtime: loops, seats, status, redeploy, usage |
| `helmo team <sub>` | hold and release seats |
| `helmo release <sub>` | release selection: status, upgrade, rollback, activate |
| `helmo service <sub>` | the supervisor's service definition |
| `helmo serve <work\|roadmap\|run>` | serve one dashboard in the foreground |
| `helmo mcp` | run the unified Work and Roadmap MCP server over stdio |
| `helmo mcp <work\|roadmap>` | run one compatibility MCP surface over stdio |

`helmo` does no work of its own. It hands the rest of your command line to the
entry point that has always done that work, so output, exit codes and refusals
are that entry point's own — the new spelling is not a reimplementation of the
old one.

## What every deprecation here promises

1. **Supported.** The old spelling does exactly what it always did. Not
   degraded, not slower, not a partial implementation.
2. **It warns from the first release that replaces it** — one line naming the
   replacement and the date, on **stderr**. Never on stdout: `helmo-cli`'s
   contract is that everything it prints is one parseable JSON object, and the
   MCP servers' stdout is the protocol channel.
3. **It refuses at the end of its window** — a non-zero exit naming the
   replacement. Never a silent no-op, and never a fallback to a guess.
4. **The date is here before the old name warns**, so the window can be
   planned rather than discovered.

## The names that are leaving

| Old name | New spelling | Stops working after |
|---|---|---|
| `helmo-cli <sub>` | `helmo work <sub>` | 2027-04-01 |
| `helmo-mcp` | `helmo mcp work` | 2027-04-01 |
| `roadmap-mcp` | `helmo mcp roadmap` | 2027-04-01 |
| `helmo-view` | `helmo serve work` | 2027-01-01 |

`helmo-view` has the shorter window because the only thing that names a view
binary is a service definition you installed yourself, and
[ENTRY-POINTS.md](ENTRY-POINTS.md) is the checklist for those.

## The names that are not leaving

- **`rev <sub>`** is a permanent alias for `helmo run <sub>`. It prints no
  notice and is not scheduled to stop: it is named in generated agent prompts,
  which would otherwise regenerate a dead command.
- **`gp-rev`** is unchanged. It is a separate entry point on purpose — it fixes
  the installation it operates, so a caller cannot aim it elsewhere.
- **`roadmap-view`, `roadmap-recovery`** are unchanged, and reachable as
  `helmo serve roadmap` and `helmo roadmap`.
- **Every path inside `packages/*/dist/`** is unchanged and carries no notice.
  Those are the implementation, not an old name: a roster, a plist or an MCP
  client that names `packages/work/dist/server.js` keeps naming it.
- **`localhost:4400` and its `#H-n` routes** are the app's own port and route.
  A bookmark, a note or a ticket's evidence that names one resolves the same
  record it always did.
- **Record ids, MCP tool names and argument keys** have not moved. Nothing a
  loaded tool schema or a stored reference names changes in this release.

## The URLs that move, and the listener that keeps them working

The three dashboards that had their own ports are now routes on the one app.
A route alias is not the mechanism those URLs need: **a redirect requires
something still listening on the port being redirected from**, and a hash
fragment is never sent to a server at all — so once nothing binds 4410,
`http://localhost:4410/#R-39` does not redirect, it fails to connect.

So the app can bind them and answer 301. Which ports it binds is each
installation's own configuration, and it defaults to none; the shape is in
[INSTALLATIONS.md](INSTALLATIONS.md).

| Old URL | New URL | Mechanism | Stops working after |
|---|---|---|---|
| `localhost:4400/#H-n` | identical | unchanged | — |
| `localhost:4410/...` | `localhost:4400/roadmap/...` | 301 from a configured listener | 2027-04-01 |
| `localhost:4500/...` | `localhost:4400/run/...` | 301, same mechanism | 2027-04-01 |
| `localhost:4300/...` | `localhost:4400/...` | 301, same mechanism | 2027-04-01 |
| `:4401` remote write surface | unchanged | separately authenticated, not in the app process | — |

A fragment survives because the `Location` carries none: the browser reattaches
the `#R-39` you typed to whatever route it lands on. A redirect that needed to
*translate* a fragment would need a line of script on the landing page, and
none of these do — the routes resolve the same ids.

`:4300` was a landing page of links and a health reading, so it lands on the
app's front page; the health reading it proxied is `/health.json`. A surface of
its own, with the links and the roster in it, is the next chapter's work and
not a promise this release makes.

**Going back is unsetting one variable.** A port change needs a stated recovery
path ([VERSIONING.md](VERSIONING.md)), and this one is cheap on purpose: clear
`HELMO_LEGACY_LISTENERS`, restart the app, and start the per-dashboard
compatibility surfaces again — `helmo serve roadmap` on `ROADMAP_VIEW_PORT`,
`helmo serve run`, `helmo serve work`. They are unchanged and they still bind
their own ports, which is what makes retiring one reversible rather than a
one-way migration. No record, store or identity is touched either way: the
retired set is process configuration and nothing reads it but the app at
startup.

## Linking the commands after a first install

`npm` links a package's command only if the file it points at already exists,
and four of Helmo's commands point at built output. So after the documented
cold install — `npm ci`, then `npm run build` — `helmo` and the adapters are on
hand, and `rev`, `roadmap-view` and `roadmap-recovery` are not. One more
`npm install` after the build links them:

```bash
npm ci && npm run prepare:cold && npm run build
npm install          # links rev, roadmap-view and roadmap-recovery
```

Nothing is broken without it: every command is also reachable through `helmo`,
and each one's own path under `packages/*/dist` works as it always did.

## Upgrading a checkout in place

`npm install` does not repoint a `node_modules/.bin` link that already exists,
so an existing checkout can keep an old binary pointing at its old target after
an upgrade — it keeps working, and it will not print the notice that tells you
it is leaving. Clearing the links is enough:

```bash
rm -f node_modules/.bin/helmo-cli node_modules/.bin/helmo-mcp \
      node_modules/.bin/helmo-view node_modules/.bin/roadmap-mcp
npm install
```

A clean clone, which is the documented install path, is unaffected.
