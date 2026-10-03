# Installing Helmo (agent-led)

You are an agent installing Helmo for a human. This is the primary install
path: run it end to end, verify each step, and finish with the report-back
template at the bottom. Don't make the human run commands unless a step
genuinely needs their credentials or a restart.

## What you are installing

Helmo is one product with three areas, one version, and one checkout:

| Area | What it is | Entry points | Store |
| --- | --- | --- | --- |
| **Work** | Tickets agents write and the human reads; questions batched into meetings | `helmo-cli`, `helmo-mcp`, `helmo-view` (`:4400`) | `~/.helmo/helmo.db` |
| **Roadmap** | The layer above the ticket: parked, shaped, costed, ranked, declared go | `roadmap-mcp`, `roadmap-view` (`:4410`) | `~/.helmo-roadmap/roadmap.db` |
| **Runtime** | Process supervision for unattended loops drawing work from Work | `rev`, the loop view (`:4500`) | sentinels under `~/.rev/` |

The stores serve ALL projects and repos on the machine — install once per
machine, not per project. The two databases stay separate: together they read
as one system, apart each stands alone.

**Install the areas the human asked for.** Work and Roadmap each stand alone.
Runtime draws its work from Work, so Work comes first if they want loops.
Steps 1–2 are the whole product and are always run; steps 3–6 turn areas on.

If Helmo is already installed (`~/.helmo/helmo.db` exists and `claude mcp list`
mentions helmo), skip to registering additional agents or just report status.

## 1. Prerequisites

Node.js >= 20 (`node --version`) and git. If either is missing, tell the human
what to install and stop.

`better-sqlite3` uses a prebuilt binary when one matches their Node version and
platform; otherwise npm compiles it from source, which needs a C/C++ toolchain
(Xcode Command Line Tools on macOS, `build-essential` on Linux) and Python >=
3.8 for node-gyp. Only reach for that if step 2 fails in `node-gyp rebuild` —
an old `python3` on PATH is the usual culprit, and
`PYTHON=/usr/bin/python3 npm ci` fixes it on macOS.

## 2. Get and build the product

```bash
git clone https://github.com/arthurcoulston/helmo.git ~/tools/helmo   # or use an existing local checkout anywhere
cd ~/tools/helmo
npm ci
npm run prepare:cold
npm run build
npm test
```

One build, all four packages in dependency order. This is the isolated cold
setup: it needs no sibling checkout and the tests use fresh temporary
databases.

`npm run prepare:cold` writes the ignored build marker that makes this checkout
writable. The root build refuses a checkout without it — a release directory, an
export, or any checkout an installation resolves through — so a build can never
overwrite the code a running view or supervisor loads. It is a deliberate speed
bump, not an authentication boundary.

All tests must pass before you continue; do not register a broken server. A few
design-source drift comparisons report **skipped** — they compare vendored
design tokens and avatar sprites against a private source that is not part of
this repository and that you do not need. Skipped is the expected result on
every install, and the vendored copies are still built and tested. A *failing*
test is a different thing: report it and stop.

## 3. Connect the agents (Work and Roadmap, MCP over stdio)

Each agent's MCP config launches the server with that agent's identity. The
stores reject writes that carry no identity.

Before connecting an agent, create the installation deed described in
[INSTALLATIONS.md](INSTALLATIONS.md), using absolute paths and the canonical
installation name. Pass its absolute path as `HELMO_BINDING` and pass
`HELMO_REQUIRE_BINDING=1` to every MCP registration below. A label by itself is
not a binding; the required gate intentionally refuses rather than falling
back to the account's default store.

| Area | Server | Identity variable |
| --- | --- | --- |
| Work | `<helmo-path>/packages/work/dist/server.js` | `HELMO_ACTOR` |
| Roadmap | `<helmo-path>/packages/roadmap/dist/server.js` | `ROADMAP_ACTOR`, falling back to `HELMO_ACTOR` |

**Claude Code** (user scope, so every session on the machine gets it):

```bash
claude mcp add --scope user helmo \
  -e 'HELMO_ACTOR={"name":"<agent-name>","kind":"agent","model":"<model-id>","version":"<harness-version>"}' \
  -e 'HELMO_BINDING=<absolute-path-to-installation.json>' -e HELMO_REQUIRE_BINDING=1 \
  -- node <helmo-path>/packages/work/dist/server.js
claude mcp add --scope user roadmap \
  -e 'HELMO_ACTOR={"name":"<agent-name>","kind":"agent","model":"<model-id>","version":"<harness-version>"}' \
  -e 'HELMO_BINDING=<absolute-path-to-installation.json>' -e HELMO_REQUIRE_BINDING=1 \
  -- node <helmo-path>/packages/roadmap/dist/server.js
```

Each registration gets its own `-e`: the variable is set for that server
process only, so Roadmap's fallback to `HELMO_ACTOR` finds nothing unless you
pass it here too.

**Codex / other MCP-capable harnesses** — add to their MCP config (the
TOML/JSON equivalent of):

```json
{
  "mcpServers": {
    "helmo": {
      "command": "node",
      "args": ["<helmo-path>/packages/work/dist/server.js"],
      "env": { "HELMO_ACTOR": "{\"name\":\"<agent-name>\",\"kind\":\"agent\",\"model\":\"<model-id>\",\"version\":\"<version>\"}" }
    },
    "roadmap": {
      "command": "node",
      "args": ["<helmo-path>/packages/roadmap/dist/server.js"],
      "env": { "HELMO_ACTOR": "{\"name\":\"<agent-name>\",\"kind\":\"agent\",\"model\":\"<model-id>\",\"version\":\"<version>\"}" }
    }
  }
}
```

**Identity rules:**

- `name`: stable, human-readable, describes the role — `codex-events-loop`,
  `claude-code-interactive`, `reviewer-loop`. The human sees this name in
  meetings and as the provenance on every claim and judgment, so pick one they
  would recognize.
- `kind`: `agent` (workers), `orchestrator` (meeting runner), `human` (never in
  env config).
- `model` + `version`: required for agents. For loop workers these are accurate
  in env config. For interactive sessions the model varies day to day, so the
  env value is a default and the agent should pass the per-call `actor`
  override when its true model differs.
- Registering a loop worker? Give each loop its own name and accurate
  model/version — provenance is the product.
- Set `ROADMAP_ACTOR` only when Roadmap's identity should differ from Work's.
  A machine that already provisions per-agent `HELMO_ACTOR` needs no second
  variable.

## 4. Start the views

Both are read-only and bound to 127.0.0.1.

```bash
cd <helmo-path>
nohup node packages/work/dist/view.js    > /tmp/helmo-view.log   2>&1 &   # :4400
nohup node packages/roadmap/dist/view.js > /tmp/roadmap-view.log 2>&1 &   # :4410
```

Override port and host with `HELMO_VIEW_PORT` / `HELMO_VIEW_HOST` and
`ROADMAP_VIEW_PORT` / `ROADMAP_VIEW_HOST`, and the database with `HELMO_DB` /
`ROADMAP_DB` — the database overrides are for isolated testing, never to give a
project its own store. Verify each responds:

```bash
curl -s localhost:4400 | grep -q Helmo
curl -s localhost:4410 | grep -q Roadmap
```

Tell the human these do not survive reboot yet; a login service is a welcome
contribution.

## 5. Runtime: the instance home and the roster

Only if the human wants unattended loops. Work must be installed and built
first — Runtime draws its work from it.

```bash
mkdir -p ~/.rev/constitutions
cp <helmo-path>/packages/runtime/examples/roster.toml ~/.rev/roster.toml
```

Edit `~/.rev/roster.toml`: point `helmo_cli` at
`<helmo-path>/packages/work/dist/cli.js` and `helmo_mcp_server` at
`<helmo-path>/packages/work/dist/server.js`.

**Do not define worker loops yet**, and before you add any, tell the human what
one is. Every iteration runs a full agent session with the agent CLI's
permission prompts and sandbox turned off, unattended, in the `cwd` that roster
entry names; from there it can read and write files, run commands, and reach
whatever their user account reaches. The `cwd` is only a starting directory,
the constitution is behavioral guidance, and its MCP configuration does not
restrict shell, filesystem or network access. **Their user account's
permissions are the effective security boundary.** Add loops only for folders
and workstreams they would hand an unattended agent; Runtime's
[README](packages/runtime/README.md) section "What a loop session can do" is
the short version to show them. A loop without a deliberate constitution is a
worker without a character.

Start the loop view the same way as the others:

```bash
cd <helmo-path> && nohup node packages/runtime/dist/view.js > /tmp/rev-view.log 2>&1 &   # :4500
```

Leave its host alone unless the human asks: the view has no authentication, so
widening it past 127.0.0.1 serves every loop's home path, spend and event trace
to anyone who can reach the port.

## 6. Verify end to end

**Work** — connect exactly as a registered agent does:

```bash
node <helmo-path>/packages/work/scripts/check-connection.mjs
```

Must print the tool inventory and `CONNECTION OK`. Also confirm the platform
sees it (Claude Code: `claude mcp list` shows `helmo: ✔ Connected`).

**Roadmap** — confirm `claude mcp list` shows `roadmap: ✔ Connected`, then from
an agent session that has the tools, file one throwaway project and read it
back:

```
roadmap_add_project  title: "Install check", one-line description
roadmap_list_projects
```

It must come back with a rank and a one-line explanation of that rank. Tell the
human it is there so they can decide whether to keep or archive it — never
leave a synthetic record in their store without saying so.

**Runtime** — add (or uncomment) the mock smoke loop in the roster, then:

```bash
HELMO_ACTOR='{"name":"<installer-name>","kind":"agent","model":"<model-id>","version":"<harness-version>"}' \
  node <helmo-path>/packages/work/dist/cli.js create --title "Rev install check" \
  --body "synthetic ticket for install verification" --workstream rev-test --type ops
node <helmo-path>/packages/runtime/dist/cli.js run smoke --count 1
node <helmo-path>/packages/runtime/dist/cli.js status
```

Expect the iteration to run and `status` to show the loop `IDLE` or `halted`.
Remove the smoke loop from the roster afterwards unless the human wants it kept.

The build and test suite use a mock runtime, so nothing above spends agent
tokens or needs agent-CLI credentials. When the operator wants a credentialed
end-to-end check, run one isolated iteration:

```bash
cd <helmo-path>/packages/runtime
chmod +x scripts/real-smoke.sh
scripts/real-smoke.sh <helmo-path>/packages/work [model] [runtime]
```

That one invokes the selected agent CLI and may consume plan allowance or incur
provider cost. If the current shell cannot reach that CLI's credentials, report
the limit — it is not a failed install.

## 7. Report back to the human

Deliver this, adapted to what you actually set up:

> Helmo is installed and connected — version 0.6.1, one checkout at
> `<helmo-path>`.
>
> - **Work** (read-only): http://localhost:4400 — the "Awaiting you" section is
>   your queue.
> - **Roadmap** (read-only): http://localhost:4410 — your projects, ranked,
>   each rank explaining itself in one line.
> - **Loops** (read-only): http://localhost:4500 — every loop's state, pace,
>   spend and recent trace.
> - **Start a meeting**: in any agent session with Helmo connected, say
>   **"Summon helmo orchestrator"** and have the agent load
>   `<helmo-path>/packages/work/HELMO-ORCHESTRATOR.md`. It walks you through
>   every ticket awaiting your decision and records your answers. Meetings end
>   when the queue is empty. For the running machine, say **"summon the watch
>   officer"** → `<helmo-path>/packages/runtime/WATCH-OFFICER.md`.
> - **You never edit tickets directly** — agents write the record; you read the
>   views and talk to the orchestrator.
> - **Getting an idea onto the roadmap costs nothing**: tell any connected
>   agent "put X on the roadmap". Bad ideas belong there, ranked low. Rank is
>   derived, never hand-set: facts set the tier, attributed judgments of value
>   and effort order within it. Declaring a project go is your decision that an
>   agent records.
> - **Start the machine**: `node <helmo-path>/packages/runtime/dist/cli.js run`
>   runs every roster loop under the supervisor; `... stop` drains it
>   gracefully; `stop|resume|pace <name>` controls one loop. `rev service
>   install` registers the supervisor as a user service (launchd/systemd) —
>   offer this, but install it only on your say-so, because it changes what
>   runs at login.
> - **What a loop session can do**: each iteration is an agent session with the
>   CLI's permission prompts and sandbox disabled, unattended, in the folder
>   its roster entry names. It can read and write files, run commands, and
>   reach whatever your user account reaches. Your account's permissions are
>   the effective security boundary. Register loops only for work you would
>   hand an unattended agent.
> - **When a loop needs you**, it files a ticket into the awaiting-you queue —
>   your normal meeting surfaces it. No log-watching required.
> - **Connected agents**: <list the identities you registered>.
> - **Next step**: define a worker loop — its constitution (identity,
>   judgment, escalation rules) is deliberate design work. Write it with your
>   agent, then add the roster entry.
> - <If you filed an install-check project or ticket: say so, and that they can
>   archive it whenever they like.>

**Worker snippet** (paste into any agent's constitution/prompt):

> You have Helmo MCP tools (`helmo_*`) — the shared work record. At the start of
> each session or iteration: `helmo_list_tickets {assignee: "<your-name>"}` to
> resume work you own, then `helmo_list_tickets {ready: true, workstream:
> "<yours>"}` for new work. Claim before working, update when reality changes,
> attach evidence when done, and use `helmo_return_to_human` (never a guess)
> when only the human can decide. You also have Roadmap tools (`roadmap_*`) —
> the record of work worth doing, above the ticket: `roadmap_list_projects` for
> what is ranked and why, `roadmap_add_project` whenever an idea arrives that
> isn't tracked, `roadmap_record_claim` / `roadmap_cite` to attach a judgment or
> a source. Never argue a project up the list by editing rank; it is derived.
> The tool descriptions teach the rest.

## Notes for maintainers

- Every MCP registration and roster path points at `dist/` — after changing any
  `src/`, run `npm run build` at the root or agents get the stale server.
- One global store per area is deliberate (`~/.helmo/helmo.db`,
  `~/.helmo-roadmap/roadmap.db`). `HELMO_DB` / `ROADMAP_DB` are for isolated
  testing; tests use temporary stores and must never point at a live database.
- Instance data — the roster, constitutions, loop state — lives in `~/.rev/`.
  Nothing operator-specific ever enters this repository.
- The vendored design sources (`src/estate-tokens.generated.ts`,
  `src/estate-avatars.generated.ts`) are regenerated by each area's
  `npm run vendor:tokens` / `vendor:avatars` and checked in so the product
  builds without that private source; the skipping tests are the drift check
  that runs only where it is present.
- Back up the SQLite stores before upgrades, and keep the backups private.
- More than one installation on a machine, pinned releases, upgrade, rollback
  and removal: [INSTALLATIONS.md](INSTALLATIONS.md), with the paths to verify
  in [ENTRY-POINTS.md](ENTRY-POINTS.md).
