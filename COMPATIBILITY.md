# Compatibility — the old names, and when they stop working

Helmo is one product with one command: `helmo`. It was three products with
eight, and every one of those names still works. This page says which are
leaving, what replaces them, and the date each stops — so a setup that names
an old one can be moved on a schedule rather than discovered broken.

What a version number promises is in [VERSIONING.md](VERSIONING.md); the paths
your own setup names are in [ENTRY-POINTS.md](ENTRY-POINTS.md).

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
| `helmo mcp <work\|roadmap>` | run one MCP server over stdio |

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
- **Ports, launchd labels, record ids, MCP tool names and argument keys** have
  not moved. Nothing a configuration file, a plist, a bookmark or a loaded tool
  schema names changes in this release.

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
