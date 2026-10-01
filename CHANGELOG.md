# Changelog

These notes start at v0.1.0, the independent-installations release. They do
not reconstruct what came before it; earlier history is in the git log.

## v0.2.0 — 2026-10-01

A loop no longer spends a session the work record would refuse, and the pinned
service path from v0.1.0 is safe to use: a pinned supervisor is recognised as
running, and installing the service over an in-flight one waits rather than
races.

- Before a loop spends a session, Rev asks Helmo whether the seat may launch
  at all, so a ticket bound to a workflow attempt is started only once its
  requirements have passed and the admission is recorded in the same
  transaction as the check. A refusal costs no session, is reported in the
  loop's log, and is asked again after a restart rather than bypassed by one.
  Only an explicit refusal holds a launch back: a seat with nothing ready to
  gate, and an installation whose Helmo has no `launch-admit` command, both
  run as before (H-2561).
- Pinned services now report their launcher-backed supervisor as live while
  retaining exact command identity for loop drivers; status no longer mistakes
  the real supervisor for a stale marker and risks starting a duplicate
  (H-2560).
- On macOS, service installation waits for the previous launchd job to release
  its label before bootstrapping the replacement. If bootstrap fails, it
  restores the previous definition and running job (H-2560).
- Removal never pairs a Helmo home whose own name is already a conventional
  roadmap home: the bounds for `.rev-roadmap-b` no longer claim
  `.helmo-roadmap-b`, which belongs to the roadmap `-b` installation (H-2553).

## v0.1.0 — 2026-09-30

Two Rev installations can now run under one login without reaching into each
other: each has a name, a service identity bound to its own home, a store it
alone writes, and commands that say which one they are about and refuse to act
on the other. A pinned installation also gains the two verbs it was missing —
changing which release it runs, and going back.

### An installation has an identity

- An installation's service identity is its resolved home, not a basename
  (H-2452). The launchd label is also the plist filename and the
  bootout/kickstart address, so it is the one name two installations under a
  single account cannot share — and it used to be derived from the home's
  basename, which left `/tmp/customer-a/.rev` and `/tmp/customer-b/.rev` both
  answering to the same label. Redirecting `HOME` does not separate them:
  launchd's namespace belongs to the uid. The label is now bound to the resolved
  home path. A direct child of the ACCOUNT's home named `.rev` or
  `.rev-<suffix>` keeps the label it was bootstrapped under, so existing
  installs are untouched; anywhere else the label carries a readable part plus
  eight hex characters of the path's digest. The account's home is read from the
  password database rather than `$HOME`, because `$HOME` is something the plist
  this code writes can set.

- A service restarted with a daemon's bare environment resolves the identity it
  was installed under (H-2452). The plist and the systemd unit now export
  `REV_LABEL`, so a job the service manager brings back does not re-derive a
  different name.

- `install`, `uninstall` and `start` read the definition on disk and refuse when
  its `REV_HOME` belongs to another installation, naming both homes and the way
  out (H-2452). This is the case an explicit or INHERITED `REV_LABEL` can still
  create — a shell carrying one installation's label aimed at another's home —
  which no amount of care at the keyboard prevents, because nothing was typed
  wrong. A definition with no `REV_HOME` reads as unowned, so an older install
  stays upgradeable, and installing retires a definition left at this home's
  previous label.

- Every command says which installation it is about, and `--installation` makes
  that an assertion (H-2473, H-2526). The target used to come from whatever
  `REV_HOME`/`REV_LABEL` happened to be in the ambient environment, and nothing
  printed it back. Reads (`status`, `usage`, `routing`, `service status`, the
  bare-usage footer) now name their target, and so does each mutation's
  confirmation, because that is where an operator looks to see what they just
  did. `--installation <name|home>` ASSERTS that target and cannot redirect it:
  a disagreement with the environment refuses, exit 1, naming both candidates.
  `REV_HOME` moves the target; the flag says you meant it. The check runs once
  before the command switch, so a read surface added later cannot forget it, and
  `--installation=<value>` is recognised as well as the space-separated
  spelling. The flag is therefore usable as a guard at the top of a script,
  including on a read. `tail` and `session-spec` are exempt: their stdout is a
  machine value a caller substitutes.

### What is running, and what built it

- A build records which commit it came from (H-2442). `dist` is gitignored and
  `rev redeploy` restarts without building, so the supervisor has always loaded
  an artifact with no provenance: on one occasion `dist/cli.js` was built the
  evening after the supervisor running it started, meaning the fleet was
  executing code that no longer existed on disk. The stamp travels beside the
  artifact rather than in a central log directory, because a file keyed by repo
  basename cannot describe two installations of one repo. A dirty tree is
  recorded, not refused — refusing would only produce builds with no record at
  all.

- The surfaces say what the fleet is RUNNING, separately from what is on disk
  (H-2489). Every surface that could be asked "what is the fleet running" would
  have read the build stamp, which on one day would have named a commit built at
  06:40 to describe a process that started at 18:01 the evening before:
  precise, healthy-looking, wrong. `build:` is the artifact; `running:` is what
  the live process recorded when it loaded, and it never falls back to the
  artifact's commit — on divergence that commit appears only as the thing nobody
  is executing. `STALE` and `UNVERIFIABLE` are answers. What is compared is a
  digest of the JavaScript in the directory, not the commit, because a dirty
  tree's commit did not produce the artifact and two rebuilds of one commit
  differ. `status`, `service status`, `/health.json` and the dashboard print
  both, and `health.json` gains the installation it was never naming.

### Choosing and changing a release

- An installation can be pinned to an immutable multi-product release set
  (H-2454). `INSTALLATION_RELEASE` points at the selection's `ADOPTED.json`;
  every entry point then verifies the selected Rev/Helmo/Roadmap commit set and
  refuses code from another checkout.

- `rev release status | upgrade <dir> | rollback` (H-2493). A pin was previously
  moved only by a text editor: an upgrade was an unwitnessed edit, a half-written
  selection bricked every command in the installation, and going back meant
  finding and reinstalling old code. Now the whole set is verified before the
  pointer moves — each product's `dist` holds JavaScript and its `BUILD.json`
  names exactly the commit `RELEASE.json` does, built clean — and every fault is
  reported at once rather than one per attempt. `MIGRATION.json` is required in
  the release directory and is copied into the selection, so a one-way migration
  refuses a rollback in its own words even after the release directory is gone.
  The replacement is a same-directory temp file, fsync, rename, directory fsync,
  and it retains the whole previous selection inside it, so a rollback is one
  write rather than a reinstall.

- A pinned service starts through the installation's own launcher (H-2511). A
  service definition is written once and nothing rewrites it, so the path it
  names is frozen at install time — and it used to be the `cli.js` of whatever
  release was selected when the service was installed. After an upgrade, the job
  the service manager brought back exec'd the release the installation had just
  left, was stopped by the coherence check as an uncaught throw, and under
  KeepAlive was brought back to fail again. A pinned installation's definition
  now names `<REV_HOME>/service/launch.mjs`, which lives outside every release.
  It reads the selection at START, sets `argv[1]` to the resolved `cli.js` and
  imports it in this process, so signals, the exit timeout and the supervised
  pid all still reach the service manager, and everything downstream is what it
  would have been had the manager named that file directly. A release change is
  therefore picked up by a restart, with no reinstall.

- `rev release` and `rev install` are exempt from the pin check (H-2493,
  H-2522). They are the two ways out of a broken selection and cannot sit behind
  the fault. The exemption is in the module-level list as well as in each
  command's own argument: it was in the argument alone, so `rev install remove`
  threw inside the gate and never reached the declaration that it was exempt,
  leaving a hand `rm -rf` as the only route out.

### Removing one installation's data

- `rev install remove [--confirm]` (H-2512). Every other removal Rev has keeps
  the records: `rev service uninstall` takes the definition and leaves the
  store, the controls and the selection byte-for-byte, which is right, and which
  left an operator with a hand `rm -rf` as the only way to delete an
  installation — in a shell that may be carrying the other installation's
  `REV_HOME`, with no product refusal in the way. This is a separate verb rather
  than a flag on `service uninstall`, because the difference between keeping and
  deleting every record must not be a word someone can miss. The plan prints
  first and `--confirm` is a second act. The boundary is the directories the
  installation owns, named: its Rev home and, for a home named the conventional
  way, the Helmo family's homes beside it carrying the same suffix (`~/.rev-b`
  with `~/.helmo-b`). A store in none of them is reported as left in place rather
  than followed, whether or not anything has opened it yet. Naming them beats
  trusting the directory they sit in, which under that layout is the whole
  account home — so a roster copied from `~/.rev` to bootstrap `~/.rev-b` no
  longer brings the first installation's store inside the second's boundary
  (H-2544). A home named outside the convention keeps the enclosing directory,
  which holds as far as that directory is one installation's. A standing service
  definition or a live supervisor refuses, each naming the command that clears
  it, and a `REV_HOME` containing the account's own home directory is refused
  outright. Release directories are never touched.

### Documentation

- `INSTALLATIONS.md` — the consumer's guide to running more than one
  installation: what to set, what each refusal means, which versions form a set,
  and the backup a one-way migration makes your only way back (H-2515, H-2516).
- `ENTRY-POINTS.md` — every path to repoint when you add an installation or
  change which release one runs, and the surface that tells you it took. It
  covers the Helmo family standing without Rev as well (H-2517).
- `ISOLATION-CHECKS.md` — the reviewer's checklist: seven isolation properties,
  the commands to re-derive each against your own two installations, what to
  observe, what our own run observed, and what is not proved.

### Reliability and tests

- The prompt tests assert what the loop compiles, not what fits in the console
  (H-2496). Nine tests read prompt text through the loop's bounded stdout tail.
  The iteration prompt is one long line and has grown past that window, so the
  `toContain` assertions were one clause away from red — and the `not.toContain`
  ones were already a false green: a mutation putting a phrase at the head of the
  prompt left the test passing, because the text was truncated away rather than
  absent. The mocks now write the compiled prompt to a file and the assertions
  read it from there.

### Not covered by this release

- The service-definition guard is Rev's answer to an inherited label, and it
  needs a definition to read. The Helmo family installs no service, so its
  answer is a different mechanism — a durable name claimed in the store — and it
  is subject to that mechanism's own limits, which Helmo's notes state.

- What a process reports as RUNNING is a digest of the JavaScript it loaded, not
  a commit. It can tell you the code changed under a live process; it cannot
  tell you which commit a dirty-tree build came from.

- A release change is taken at the next start. Nothing in this release moves a
  running supervisor or a running loop onto new code; restarting is still a
  deliberate act.

- `rev install remove` deletes one installation's data. It is not a general
  uninstaller: it leaves release directories alone, and it will not follow a
  store that sits outside the installation home.

### Commit coverage

Every commit in this release is represented above. This manifest makes that
claim auditable without relying on ticket-title conventions:

- `02ac9d6`, `5cbb31c`, `1d2dfdf`, `2d7bb6c`, `30ba160`, `60c8c8b`,
  `ec33ba9`, `6be02c6`, `a36af04`, `9d00b5e`
- `57e0b0b`, `4e3d6a8`, `a9ed409`, `12fb533`, `9055f6e`, `4a712d3`,
  `a14a59b`, `817dc23`, `bb7b4a9`
