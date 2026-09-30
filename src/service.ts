// Machine-restart resilience: the supervisor as a user-level service.
// macOS: LaunchAgent with KeepAlive on unsuccessful exit only — launchd
// restarts a crashed supervisor, but a graceful drain (exit 0) stays down
// until the operator starts the machine again. Linux: systemd user unit,
// Restart=on-failure, same semantics. The unit embeds the install-time PATH
// and REV_HOME because service managers give daemons a bare environment and
// the agent CLIs the shim spawns must still resolve.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_DRAIN_GRACE_SECONDS, revHome, stateDir } from './config.js';
import { processObservation } from './sentinels.js';

export const LAUNCHD_EXIT_TIMEOUT_SECONDS = 60;

// The service identity follows the Rev home (H-2210). It used to be the
// constant 'dev.rev', and the label is also the plist filename and the
// bootout/kickstart address — so two fleets under one login fought over one
// job and one file, and the second install silently replaced the first.
//
// H-2452: deriving it from the home's BASENAME was still one identity for many
// installs. /tmp/customer-a/.rev and /tmp/customer-b/.rev are both '.rev', so
// both were 'dev.rev', and redirecting HOME does not separate them: a plist
// FILENAME lives under $HOME, but launchd's namespace is the uid's
// (`gui/<uid>/<label>`), so two installs under one account share one bootout
// and kickstart address whatever HOME says. The identity therefore has to be a
// function of the resolved home PATH.
//
// The conventional homes keep the label they are already bootstrapped under,
// by rule rather than by name: a direct child of the ACCOUNT's home directory
// called `.rev` or `.rev-<suffix>` cannot collide with another such home, so
// ~/.rev stays 'dev.rev' and ~/.rev-gp stays 'dev.rev.gp'. Anywhere else the
// label carries a digest of the resolved path, which is stable across restarts
// and distinct per install. A descriptive part comes first so the label is
// still readable: /tmp/customer-a/.rev -> 'dev.rev.customer-a.<digest>'.
//
// The account's home comes from the password database, not from $HOME, for the
// same reason the plist itself is a hazard here: a service manager hands a
// daemon an environment the software under test can have written, so an
// identity keyed on $HOME is keyed on something a second install can set
// (H-2210's own trap, one level up). $HOME still decides WHERE the definition
// file is written — that is `serviceFile()`, and it must stay that way.
//
// REV_LABEL overrides the derivation outright, and `serviceInstall` writes it
// into the service environment so the running job resolves the same identity
// its operator installed.
export function serviceLabel(): string {
  const explicit = process.env['REV_LABEL']?.trim();
  if (explicit) return explicit;
  const home = resolve(revHome());
  const suffix = labelSuffix(basename(home));
  if (isConventionalHome(home)) return suffix ? `dev.rev.${suffix}` : 'dev.rev';
  // A bare `.rev` says nothing; the directory holding it usually names the
  // install, so borrow that for the readable part before the digest.
  const descriptive = suffix || labelSuffix(basename(dirname(home)));
  return `dev.rev.${descriptive ? `${descriptive}.` : ''}${homeDigest(home)}`;
}

/** The label the pre-H-2452 rule produced for this home — basename only. Used
 *  to find and retire a definition installed under the old identity, which is
 *  the migration path for a non-conventional home. */
export function legacyServiceLabel(): string {
  const suffix = labelSuffix(basename(resolve(revHome())));
  return suffix ? `dev.rev.${suffix}` : 'dev.rev';
}

function labelSuffix(name: string): string {
  return name
    .replace(/^\.?rev(?=[-_.]|$)/, '')
    .replace(/^[-_.]+/, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** ~/.rev and ~/.rev-<suffix>, where ~ is the account's own home: the homes the
 *  suffixed-home convention covers, whose basenames are unique by construction
 *  because they are siblings in one directory. */
function isConventionalHome(home: string): boolean {
  return dirname(home) === accountHome() && /^\.rev([-_.]|$)/.test(basename(home));
}

function accountHome(): string {
  try {
    return resolve(userInfo().homedir);
  } catch {
    // No password entry (some containers). $HOME is then all there is, and a
    // wrong answer here only means a home gets a digest it did not need.
    return resolve(homedir());
  }
}

// Eight hex characters of the resolved path. Long enough that two installs on
// one machine will not collide, short enough to read back off a label. The
// input is `resolve()`d and not `realpath`ed, so a home reached through a
// symlink is a second identity — REV_LABEL is the override when that is not
// what you meant.
function homeDigest(home: string): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 8);
}

// systemd unit names are not reverse-DNS, so the launchd label is the single
// source and this is its unit spelling: dev.rev -> rev, dev.rev.gp -> rev-gp.
export function systemdUnitName(): string {
  return unitNameFor(serviceLabel());
}

function unitNameFor(label: string): string {
  return label.replace(/^dev\./, '').replace(/\./g, '-');
}

const xml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

export function launchdPlist(
  node: string,
  cli: string,
  opts: { label: string; home: string; path: string; logPath: string },
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(cli)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(opts.path)}</string>
    <key>REV_HOME</key><string>${xml(opts.home)}</string>
    <!-- The label the operator installed under, not just the one launchd
         boots. Without it a service manager's bare environment re-derives the
         identity from the home, and an install whose label was explicit — or
         whose home moved — would run under one name and address another
         (H-2452). Every command run from inside the service now resolves the
         same label the job holds. -->
    <key>REV_LABEL</key><string>${xml(opts.label)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(opts.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(opts.logPath)}</string>
  <!-- launchd clamps ExitTimeOut at 60 seconds (H-877). This buys the largest
       available window for loop drivers to finish; detached agent sessions
       remain the protection when a bootout becomes a hard stop. Use rev stop
       for a graceful drain that may outlast this service-manager ceiling. -->
  <key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>
</dict>
</plist>
`;
}

export function systemdUnit(node: string, cli: string, opts: { home: string; path: string; label: string }): string {
  return `[Unit]
Description=Rev — keeps agent loops turning

[Service]
ExecStart=${node} ${cli} run
Restart=on-failure
RestartSec=10
# Stop the supervisor, not the whole cgroup (H-467). Under the default
# KillMode=control-group systemd SIGTERMs every process in the unit, including
# the agent session mid-turn; the supervisor's own drain is what should end a
# loop, and it needs longer than the 90s default to do it.
KillMode=mixed
TimeoutStopSec=${DEFAULT_DRAIN_GRACE_SECONDS + 60}
Environment=PATH=${opts.path}
Environment=REV_HOME=${opts.home}
# The installed identity, for the reason the plist carries it (H-2452).
Environment=REV_LABEL=${opts.label}

[Install]
WantedBy=default.target
`;
}

export function serviceFile(): { kind: 'launchd' | 'systemd'; file: string } {
  const kind = process.platform === 'darwin' ? 'launchd' : 'systemd';
  return { kind, file: serviceFilePath(kind, serviceLabel()) };
}

// Where a definition for a GIVEN label lives. Taking the label as an argument
// is what lets the migration look for the one this install used to have
// (H-2452); `homedir()` rather than the account home on purpose — $HOME decides
// where files go, the account decides who the service identity belongs to.
function serviceFilePath(kind: 'launchd' | 'systemd', label: string): string {
  return kind === 'launchd'
    ? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
    : join(homedir(), '.config', 'systemd', 'user', `${unitNameFor(label)}.service`);
}

function launchctl(...args: string[]): void {
  execFileSync('launchctl', args, { stdio: 'inherit' });
}

function systemctl(...args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
}

export function installLaunchd(file: string, plist: string, domain: string, label: string, run = launchctl): void {
  writeFileSync(file, plist);
  try {
    run('bootout', `${domain}/${label}`);
  } catch {
    /* not loaded is fine */
  }
  run('bootstrap', domain, file);
}

/**
 * The Rev home a service definition already on disk says it is for, read out of
 * the definition itself (H-2452). This is what makes "is this service mine"
 * answerable before a write, a bootout or a kickstart: the label alone cannot
 * say, because an explicit REV_LABEL can be set to any string by any install.
 * `null` means the file holds no REV_HOME — an old definition, or not ours.
 */
export function definedHome(kind: 'launchd' | 'systemd', text: string): string | null {
  const m = kind === 'launchd'
    ? /<key>REV_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
    : /^Environment=REV_HOME=(.*)$/m.exec(text);
  const found = m?.[1]?.trim();
  return found ? found.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

/**
 * Refuse to touch a definition that belongs to a different installation.
 *
 * With the identity bound to the resolved home this should not happen by
 * derivation any more, but an explicit REV_LABEL still lets two installs name
 * themselves the same thing — and the failure mode is silent: install, and the
 * other fleet's supervisor is booted out and replaced by yours. So the
 * destructive paths check the file's own REV_HOME first and stop, naming both
 * homes and the way out. A definition with no REV_HOME predates this and is
 * treated as ours, which is what keeps an existing install upgradeable.
 */
function assertOwnService(kind: 'launchd' | 'systemd', file: string, action: string): void {
  if (!existsSync(file)) return;
  const owner = definedHome(kind, readFileSync(file, 'utf8'));
  if (owner === null) return;
  const mine = resolve(revHome());
  if (resolve(owner) === mine) return;
  throw new Error(
    `refusing to ${action} ${file}: it is installation ${owner}'s service, not ${mine}'s.\n`
    + `Both installations resolve the service identity '${serviceLabel()}', so one of them must be given its own: `
    + `set REV_LABEL to a distinct name for this installation and run the command again.`,
  );
}

export function serviceInstall(): void {
  const { kind, file } = serviceFile();
  const node = process.execPath;
  const cli = process.argv[1]!;
  const home = revHome();
  const path = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  assertOwnService(kind, file, 'install over');
  mkdirSync(join(file, '..'), { recursive: true });
  const label = serviceLabel();
  if (kind === 'launchd') {
    const logPath = join(stateDir('supervisor'), 'launchd.log');
    const domain = `gui/${process.getuid!()}`;
    installLaunchd(file, launchdPlist(node, cli, { label, home, path, logPath }), domain, label);
    console.log(`Installed and started: ${file}\nAny running supervisor was stopped and restarted; launchd allows its loop drivers 60 seconds to exit, while detached agent sessions continue to completion.\nThe supervisor now survives reboots. Logs: ${logPath}`);
  } else {
    const unit = systemdUnitName();
    writeFileSync(file, systemdUnit(node, cli, { home, path, label }));
    systemctl('daemon-reload');
    systemctl('enable', '--now', unit);
    console.log(`Installed and started: ${file} (systemd user unit '${unit}').`);
  }
  retireLegacyService(kind, file);
  console.log('Stop the machine gracefully with: rev stop  (a drained supervisor stays down until started again)');
}

export function serviceUninstall(): void {
  const { kind, file } = serviceFile();
  if (!existsSync(file)) {
    console.log(`No service installed (${file} not found).`);
    return;
  }
  assertOwnService(kind, file, 'uninstall');
  if (kind === 'launchd') {
    try {
      launchctl('bootout', `gui/${process.getuid!()}/${serviceLabel()}`);
    } catch {
      /* not loaded is fine — still remove the file */
    }
  } else {
    try {
      systemctl('disable', '--now', systemdUnitName());
    } catch {
      /* not enabled is fine */
    }
  }
  rmSync(file);
  console.log(`Uninstalled: ${file}`);
}

export function serviceStart(): void {
  const { kind, file } = serviceFile();
  assertOwnService(kind, file, 'start');
  if (kind === 'launchd') launchctl('kickstart', `gui/${process.getuid!()}/${serviceLabel()}`);
  else systemctl('start', systemdUnitName());
  console.log('Supervisor start requested — check: rev status');
}

/**
 * The migration path for a non-conventional home (H-2452). Such a home's label
 * used to be its basename alone and now carries a path digest, so a service
 * installed before this change sits at the old path under the old name, still
 * loaded, still running that install's supervisor. Reinstalling would otherwise
 * leave two definitions for one installation and two jobs racing one queue.
 *
 * Only a definition that names THIS home is touched — it is unambiguously this
 * installation's own, which is what makes removing it safe rather than a guess.
 */
function retireLegacyService(kind: 'launchd' | 'systemd', current: string): void {
  const legacy = serviceFilePath(kind, legacyServiceLabel());
  if (legacy === current || !existsSync(legacy)) return;
  if (definedHome(kind, readFileSync(legacy, 'utf8')) !== revHome()) return;
  if (kind === 'launchd') {
    try {
      launchctl('bootout', `gui/${process.getuid!()}/${legacyServiceLabel()}`);
    } catch {
      /* not loaded is fine — the file still has to go */
    }
  } else {
    try {
      systemctl('disable', '--now', unitNameFor(legacyServiceLabel()));
    } catch {
      /* not enabled is fine */
    }
  }
  rmSync(legacy);
  console.log(`Retired this installation's previous service definition ${legacy}: its identity is now ${serviceLabel()}.`);
}

export function serviceStatusLine(): string {
  const { file } = serviceFile();
  const supervisor = processObservation('supervisor');
  return `service file: ${existsSync(file) ? file : `not installed (${file})`}\nsupervisor:   ${supervisor.state === 'unknown' ? `unobservable (recorded pid ${supervisor.pid})` : supervisor.pid ? `running (pid ${supervisor.pid})` : 'down'}`;
}
