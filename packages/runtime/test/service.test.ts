import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { definedHome, definedProgram, installLaunchd, launchdPlist, launcherPath, legacyServiceLabel, retireLegacyService, serviceLabel, stalePinnedService, systemdUnit, systemdUnitName, waitForLaunchdExit, writeLauncher } from '../src/service.js';

describe('service unit generation', () => {
  it('launchd: restarts on crash only — a graceful drain (exit 0) stays down', () => {
    const p = launchdPlist('/usr/local/bin/node', '/opt/rev/dist/cli.js', {
      label: 'dev.rev',
      home: '/Users/x/.rev',
      path: '/usr/local/bin:/usr/bin',
      logPath: '/Users/x/.rev/state/supervisor/launchd.log',
    });
    expect(p).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(p).toContain('<string>/opt/rev/dist/cli.js</string>');
    expect(p).toContain('<string>run</string>');
    expect(p).toContain('<key>Label</key><string>dev.rev</string>');
    expect(p).toContain('<key>REV_HOME</key><string>/Users/x/.rev</string>');
    expect(p).toContain('launchd.log');
    // H-877: launchd clamps larger values to 60 seconds. Bootout is the hard
    // path; detached sessions survive if their loop drivers are swept.
    expect(p).toContain('<key>ExitTimeOut</key><integer>60</integer>');
  });
  it('launchd and systemd carry a bound installation into the stable launcher', () => {
    const binding = '/srv/fixture/installation.json';
    const p = launchdPlist('/node', '/launch.mjs', { label: 'fixture-a', home: '/srv/fixture/rev', path: '/bin', logPath: '/log', binding });
    const u = systemdUnit('/node', '/launch.mjs', { label: 'fixture-a', home: '/srv/fixture/rev', path: '/bin', binding });
    for (const text of [p, u]) {
      expect(text).toContain(`HELMO_BINDING`);
      expect(text).toContain(binding);
      expect(text).toContain('HELMO_REQUIRE_BINDING');
    }
  });
  it('launchd: XML-escapes paths', () => {
    const p = launchdPlist('/node', '/a&b/cli.js', { label: 'dev.rev.a&b', home: '/h', path: '/p', logPath: '/l' });
    expect(p).toContain('/a&amp;b/cli.js');
    expect(p).toContain('<key>Label</key><string>dev.rev.a&amp;b</string>');
  });
  it('launchd: replaces a loaded service before bootstrapping the new plist', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-service-')), 'dev.rev.plist');
    const calls: string[][] = [];
    installLaunchd(file, '<plist>new</plist>', 'gui/501', 'dev.rev.gp', (...args) => calls.push(args), (target) => calls.push(['wait', target]));
    expect(readFileSync(file, 'utf8')).toBe('<plist>new</plist>');
    expect(calls).toEqual([
      ['bootout', 'gui/501/dev.rev.gp'],
      ['wait', 'gui/501/dev.rev.gp'],
      ['bootstrap', 'gui/501', file],
    ]);
  });
  it('launchd: installs when no service is loaded', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-service-')), 'dev.rev.plist');
    const calls: string[][] = [];
    installLaunchd(file, '<plist/>', 'gui/501', 'dev.rev', (...args) => {
      calls.push(args);
      if (args[0] === 'bootout') throw new Error('not loaded');
    });
    expect(calls.at(-1)).toEqual(['bootstrap', 'gui/501', file]);
  });
  it('launchd: waits until bootout has released the label', () => {
    let reads = 0;
    let clock = 0;
    waitForLaunchdExit('gui/501/dev.rev', (...args) => {
      expect(args).toEqual(['print', 'gui/501/dev.rev']);
      reads += 1;
      if (reads === 3) throw new Error('not loaded');
    }, 1000, () => clock, (ms) => { clock += ms; });
    expect(reads).toBe(3);
  });
  it('launchd: restores the previous definition and job after bootstrap fails', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-service-')), 'dev.rev.plist');
    writeFileSync(file, '<plist>old</plist>');
    const calls: string[][] = [];
    let bootstraps = 0;
    expect(() => installLaunchd(file, '<plist>new</plist>', 'gui/501', 'dev.rev', (...args) => {
      calls.push(args);
      if (args[0] === 'bootstrap' && bootstraps++ === 0) throw new Error('candidate rejected');
    }, (target) => calls.push(['wait', target]))).toThrow('candidate rejected');
    expect(readFileSync(file, 'utf8')).toBe('<plist>old</plist>');
    expect(calls.at(-1)).toEqual(['bootstrap', 'gui/501', file]);
  });
  it('systemd: on-failure restart with the embedded environment', () => {
    const u = systemdUnit('/usr/bin/node', '/opt/rev/dist/cli.js', { home: '/home/x/.rev', path: '/usr/bin', label: 'dev.rev' });
    expect(u).toContain('ExecStart=/usr/bin/node /opt/rev/dist/cli.js run');
    expect(u).toContain('Restart=on-failure');
    expect(u).toContain('Environment=REV_HOME=/home/x/.rev');
    expect(u).toContain('WantedBy=default.target');
    // H-467: stop the supervisor, not every process in the cgroup, and give
    // its drain longer than systemd's 90s default to finish.
    expect(u).toContain('KillMode=mixed');
    expect(u).toContain('TimeoutStopSec=660');
  });
});

// H-2210: the label is also the plist filename and the bootout/kickstart
// address, so a second fleet under the same login needs its own. The default
// home must keep 'dev.rev' — the personal install is already bootstrapped
// under that name, and its own plist exports REV_HOME=~/.rev back to it.
describe('service identity follows the Rev home', () => {
  const saved = { home: process.env['REV_HOME'], installation: process.env['HELMO_INSTALLATION'], label: process.env['REV_LABEL'] };
  const set = (home?: string, label?: string) => {
    if (home === undefined) delete process.env['REV_HOME'];
    else process.env['REV_HOME'] = home;
    if (label === undefined) delete process.env['REV_LABEL'];
    else process.env['REV_LABEL'] = label;
  };
  afterEach(() => {
    set(saved.home, saved.label);
    if (saved.installation === undefined) delete process.env['HELMO_INSTALLATION'];
    else process.env['HELMO_INSTALLATION'] = saved.installation;
  });

  it('unset home and the default home both stay dev.rev', () => {
    set(undefined);
    expect(serviceLabel()).toBe('dev.rev');
    set(join(homedir(), '.rev'));
    expect(serviceLabel()).toBe('dev.rev');
  });
  it('a suffixed home gets a suffixed label', () => {
    set(join(homedir(), '.rev-gp'));
    expect(serviceLabel()).toBe('dev.rev.gp');
    expect(systemdUnitName()).toBe('rev-gp');
  });
  it('a home that is not a rev- name keeps its whole basename, sanitized, before the digest', () => {
    set('/tmp/fleet two');
    expect(serviceLabel()).toMatch(/^dev\.rev\.fleet-two\.[0-9a-f]{8}$/);
    set('/tmp/revhome');
    expect(serviceLabel()).toMatch(/^dev\.rev\.revhome\.[0-9a-f]{8}$/);
  });
  it('REV_LABEL overrides the derivation, and the unit name follows it', () => {
    set(join(homedir(), '.rev-gp'), 'dev.rev.second');
    expect(serviceLabel()).toBe('dev.rev.second');
    expect(systemdUnitName()).toBe('rev-second');
  });
  it('HELMO_INSTALLATION is canonical while matching legacy keys remain accepted', () => {
    process.env['HELMO_INSTALLATION'] = 'dev.rev.canonical';
    process.env['REV_LABEL'] = 'dev.rev.canonical';
    expect(serviceLabel()).toBe('dev.rev.canonical');
    process.env['REV_LABEL'] = 'dev.rev.other';
    expect(() => serviceLabel()).toThrow(/identity keys disagree/);
    delete process.env['HELMO_INSTALLATION'];
  });
  it('the default unit name is plain rev', () => {
    set(undefined);
    expect(systemdUnitName()).toBe('rev');
  });

  // H-2452. The basename was not an identity: launchd's namespace is the uid's
  // (`gui/<uid>/<label>`), so two installs under one account share one bootout
  // and kickstart address no matter where their plist files sit.
  it('two homes with the same basename get different identities', () => {
    set('/tmp/customer-a/.rev');
    const a = serviceLabel();
    set('/tmp/customer-b/.rev');
    const b = serviceLabel();
    expect(a).not.toBe(b);
    expect(systemdUnitName()).not.toBe('rev');
    // Readable first, then the part that makes it unique.
    expect(a).toMatch(/^dev\.rev\.customer-a\.[0-9a-f]{8}$/);
    expect(b).toMatch(/^dev\.rev\.customer-b\.[0-9a-f]{8}$/);
  });

  it('the same home resolves to the same identity every time, however it is spelled', () => {
    set('/tmp/customer-a/.rev');
    const direct = serviceLabel();
    set('/tmp/customer-a/./.rev');
    expect(serviceLabel()).toBe(direct);
    set('/tmp/customer-a/x/../.rev');
    expect(serviceLabel()).toBe(direct);
  });

  // The identity belongs to the OS account, and $HOME is something any install
  // can set — including the service manager, via the plist this code writes.
  it('a redirected HOME cannot hand a second install the first one\'s identity', () => {
    const savedHome = process.env['HOME'];
    try {
      set(join(userInfo().homedir, '.rev'));
      expect(serviceLabel()).toBe('dev.rev');
      // Same home, but $HOME now claims it is the account's own directory.
      process.env['HOME'] = '/tmp/customer-a';
      set('/tmp/customer-a/.rev');
      expect(serviceLabel()).not.toBe('dev.rev');
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
    }
  });

  it('the pre-H-2452 label is still computable, which is what the migration looks for', () => {
    set('/tmp/customer-a/.rev');
    expect(legacyServiceLabel()).toBe('dev.rev');
    expect(serviceLabel()).not.toBe(legacyServiceLabel());
    set(join(userInfo().homedir, '.rev-gp'));
    expect(legacyServiceLabel()).toBe('dev.rev.gp');
    expect(serviceLabel()).toBe(legacyServiceLabel());
  });
});

// H-2452: the identity has to survive the service manager starting the job with
// the bare environment it gives daemons, so the definition carries it.
describe('the installed definition carries the identity it was installed under', () => {
  it('launchd: the label is in the environment, not only in the Label key', () => {
    const p = launchdPlist('/node', '/cli.js', { label: 'dev.rev.customer-a', home: '/tmp/customer-a/.rev', path: '/p', logPath: '/l' });
    expect(p).toContain('<key>HELMO_INSTALLATION</key><string>dev.rev.customer-a</string>');
    expect(p).not.toContain('<key>REV_LABEL</key>');
    expect(p).toContain('<key>Label</key><string>dev.rev.customer-a</string>');
  });
  it('systemd: the same', () => {
    const u = systemdUnit('/node', '/cli.js', { home: '/tmp/customer-a/.rev', path: '/p', label: 'dev.rev.customer-a' });
    expect(u).toContain('Environment=HELMO_INSTALLATION=dev.rev.customer-a');
    expect(u).not.toContain('Environment=REV_LABEL=');
  });
  it('a command run inside that environment resolves the label the job holds', () => {
    const saved = { home: process.env['REV_HOME'], label: process.env['REV_LABEL'] };
    try {
      // Exactly what launchd exports back from the plist above.
      process.env['REV_HOME'] = '/tmp/customer-a/.rev';
      process.env['REV_LABEL'] = 'dev.rev.customer-a';
      expect(serviceLabel()).toBe('dev.rev.customer-a');
      expect(systemdUnitName()).toBe('rev-customer-a');
    } finally {
      if (saved.home === undefined) delete process.env['REV_HOME']; else process.env['REV_HOME'] = saved.home;
      if (saved.label === undefined) delete process.env['REV_LABEL']; else process.env['REV_LABEL'] = saved.label;
    }
  });
});

// H-2452: an explicit REV_LABEL can still name two installs the same thing, and
// then install/uninstall/start would operate the other fleet's job silently.
// The definition's own REV_HOME is what makes ownership answerable.
describe('a service definition says which installation it belongs to', () => {
  it('reads the home out of a plist, un-escaping what the writer escaped', () => {
    const p = launchdPlist('/node', '/cli.js', { label: 'dev.rev', home: '/tmp/a&b/.rev', path: '/p', logPath: '/l' });
    expect(p).toContain('/tmp/a&amp;b/.rev');
    expect(definedHome('launchd', p)).toBe('/tmp/a&b/.rev');
  });
  it('reads the home out of a systemd unit', () => {
    const u = systemdUnit('/node', '/cli.js', { home: '/tmp/customer-b/.rev', path: '/p', label: 'dev.rev.x' });
    expect(definedHome('systemd', u)).toBe('/tmp/customer-b/.rev');
  });
  it('a definition with no REV_HOME reads as unowned, so an old install stays upgradeable', () => {
    expect(definedHome('launchd', '<plist><key>Label</key><string>dev.rev</string></plist>')).toBe(null);
    expect(definedHome('systemd', '[Service]\nExecStart=/node /cli.js run\n')).toBe(null);
  });
});

// H-2452: a non-conventional home's label gained a path digest, so a service
// installed under the old basename-only name is still on disk and still
// loaded. Reinstalling without retiring it leaves two definitions for one
// installation and two supervisors racing one queue. It removes a file, so it
// is driven here rather than trusted.
describe('the migration retires this installation\'s previous definition, and only its own', () => {
  const saved = { home: process.env['REV_HOME'], label: process.env['REV_LABEL'], HOME: process.env['HOME'] };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A HOME of our own, so `serviceFilePath` writes inside the test. */
  const stand = (revHome: string) => {
    const home = mkdtempSync(join(tmpdir(), 'rev-migrate-'));
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    process.env['HOME'] = home;
    process.env['REV_HOME'] = revHome;
    delete process.env['REV_LABEL'];
    const at = (label: string) => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    return { home, at };
  };

  it('boots out and removes a definition left at this home\'s previous label', () => {
    const revHomePath = '/tmp/customer-a/.rev';
    const { at } = stand(revHomePath);
    const legacy = at(legacyServiceLabel());
    writeFileSync(legacy, launchdPlist('/node', '/cli.js', { label: legacyServiceLabel(), home: revHomePath, path: '/p', logPath: '/l' }));
    const calls: string[][] = [];

    const retired = retireLegacyService('launchd', at(serviceLabel()), { launch: (...args) => calls.push(args) });

    expect(retired).toBe(legacy);
    expect(existsSync(legacy)).toBe(false);
    expect(calls).toEqual([['bootout', `gui/${process.getuid!()}/dev.rev`]]);
  });

  it('leaves a definition that names a DIFFERENT installation alone', () => {
    const { at } = stand('/tmp/customer-a/.rev');
    const legacy = at(legacyServiceLabel());
    const other = launchdPlist('/node', '/cli.js', { label: 'dev.rev', home: '/tmp/customer-b/.rev', path: '/p', logPath: '/l' });
    writeFileSync(legacy, other);
    const calls: string[][] = [];

    expect(retireLegacyService('launchd', at(serviceLabel()), { launch: (...args) => calls.push(args) })).toBe(null);
    expect(readFileSync(legacy, 'utf8')).toBe(other);
    expect(calls).toEqual([]);
  });

  it('a definition with no REV_HOME is not ours to remove either', () => {
    const { at } = stand('/tmp/customer-a/.rev');
    const legacy = at(legacyServiceLabel());
    writeFileSync(legacy, '<plist><key>Label</key><string>dev.rev</string></plist>');
    expect(retireLegacyService('launchd', at(serviceLabel()))).toBe(null);
    expect(existsSync(legacy)).toBe(true);
  });

  it('a conventional home has nothing to retire: the label never moved', () => {
    const { at } = stand(join(userInfo().homedir, '.rev'));
    expect(serviceLabel()).toBe(legacyServiceLabel());
    // The current definition IS the legacy one, so there is nothing to remove
    // even when the file exists — which is what protects the live install.
    const file = at(serviceLabel());
    writeFileSync(file, launchdPlist('/node', '/cli.js', { label: 'dev.rev', home: process.env['REV_HOME']!, path: '/p', logPath: '/l' }));
    expect(retireLegacyService('launchd', file)).toBe(null);
    expect(existsSync(file)).toBe(true);
  });

  it('the systemd path disables the old unit before removing it', () => {
    const revHomePath = '/tmp/customer-a/.rev';
    const home = mkdtempSync(join(tmpdir(), 'rev-migrate-'));
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    process.env['HOME'] = home;
    process.env['REV_HOME'] = revHomePath;
    delete process.env['REV_LABEL'];
    const unitFile = (label: string) => join(home, '.config', 'systemd', 'user', `${label.replace(/^dev\./, '').replace(/\./g, '-')}.service`);
    const legacy = unitFile(legacyServiceLabel());
    writeFileSync(legacy, systemdUnit('/node', '/cli.js', { home: revHomePath, path: '/p', label: legacyServiceLabel() }));
    const calls: string[][] = [];

    expect(retireLegacyService('systemd', unitFile(serviceLabel()), { system: (...args) => calls.push(args) })).toBe(legacy);
    expect(existsSync(legacy)).toBe(false);
    expect(calls).toEqual([['disable', '--now', 'rev']]);
  });
});

// H-2511. A definition is frozen at install time, so a definition that names a
// cli.js inside a release directory names whichever release happened to be
// selected that day. `rev release upgrade` promises the installation "takes
// this release when it next starts"; these are the cases that make that true.
describe('a pinned installation starts through its own launcher', () => {
  const saved = { ...process.env };
  let root: string;

  /** A release directory whose rev prints back the argv and cwd it was given,
   *  plus the selection file pointing at it — the smallest thing the launcher
   *  has to resolve and hand over to. */
  const release = (id: string, shape: 'unified' | 'legacy' = 'legacy', cli = 'console.log(JSON.stringify({ argv: process.argv, release: process.env.INSTALLATION_RELEASE }));') => {
    const dir = join(root, 'release', id);
    const runtime = shape === 'unified'
      ? join(dir, 'helmo', 'packages', 'runtime')
      : join(dir, 'rev');
    mkdirSync(join(runtime, 'dist'), { recursive: true });
    writeFileSync(join(runtime, 'dist', 'cli.js'), cli);
    writeFileSync(join(dir, 'RELEASE.json'), JSON.stringify({
      commits: shape === 'unified'
        ? { helmo: 'a'.repeat(40) }
        : { rev: 'a'.repeat(40), helmo: 'b'.repeat(40), 'helmo-roadmap': 'c'.repeat(40) },
    }));
    return dir;
  };
  const select = (contents: unknown) => {
    const file = join(root, 'ADOPTED.json');
    writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return file;
  };
  /** Run the launcher the way a service manager would: its own file, under the
   *  environment a definition carries and nothing else. */
  const start = (args: string[] = ['status'], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [writeLauncher(), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', REV_HOME: process.env['REV_HOME'] ?? '', REV_LABEL: 'dev.rev.pinned', ...env },
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rev-launcher-'));
    process.env['REV_HOME'] = join(root, '.rev');
    delete process.env['REV_LABEL'];
    delete process.env['INSTALLATION_RELEASE'];
  });
  afterEach(() => {
    for (const k of ['HOME', 'REV_HOME', 'REV_LABEL', 'INSTALLATION_RELEASE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lives in the installation home, outside every release', () => {
    expect(launcherPath()).toBe(join(root, '.rev', 'service', 'launch.mjs'));
    expect(launcherPath().startsWith(join(root, 'release'))).toBe(false);
  });

  it('hands over to the release the selection names, and to a different one after a change', () => {
    release('current');
    release('next');
    const file = select({ release: 'current', directory: join(root, 'release', 'current') });

    const first = start(['status'], { INSTALLATION_RELEASE: file });
    expect(first.status).toBe(0);
    const before = JSON.parse(first.stdout);
    expect(before.argv[1]).toBe(join(root, 'release', 'current', 'rev', 'dist', 'cli.js'));
    // The verb the definition carries reaches the product untouched: everything
    // downstream reads argv.slice(2), so the launcher must not sit in it.
    expect(before.argv.slice(2)).toEqual(['status']);

    // The release change is one file, and nothing reinstalls the service.
    select({ release: 'next', directory: join(root, 'release', 'next') });
    const after = JSON.parse(start(['status'], { INSTALLATION_RELEASE: file }).stdout);
    expect(after.argv[1]).toBe(join(root, 'release', 'next', 'rev', 'dist', 'cli.js'));
  });

  it.each([
    ['unified', join('helmo', 'packages', 'runtime', 'dist', 'cli.js')],
    ['legacy', join('rev', 'dist', 'cli.js')],
  ] as const)('resolves the %s manifest shape to its runtime', (shape, expected) => {
    release('current', shape);
    const file = select({ release: 'current', directory: join(root, 'release', 'current') });
    const out = JSON.parse(start(['status'], { INSTALLATION_RELEASE: file }).stdout);
    expect(out.argv[1]).toBe(join(root, 'release', 'current', expected));
  });

  // argv[1] is what the supervisor spawns loop drivers with, what the shim
  // exports as REV_CLI, and what the sentinels record as a command line. It has
  // to be the resolved cli.js, so that a fleet started through the launcher is
  // indistinguishable from one the manager started directly.
  it('presents the resolved cli.js as argv[1], not itself', () => {
    release('current');
    const file = select({ release: 'current', directory: join(root, 'release', 'current') });
    const out = JSON.parse(start(['status'], { INSTALLATION_RELEASE: file }).stdout);
    expect(out.argv[1]).not.toBe(launcherPath());
    expect(out.release).toBe(file);
  });

  it('turns a carried deed into a fail-closed binding before handing over', () => {
    release('current', 'legacy', 'console.log(JSON.stringify({ binding: process.env.HELMO_BINDING, required: process.env.HELMO_REQUIRE_BINDING }));');
    const file = select({ release: 'current', directory: join(root, 'release', 'current') });
    const binding = join(root, 'installation.json');
    writeFileSync(binding, JSON.stringify({ version: 1, id: 'pinned', installation: 'dev.rev.pinned', release: 'current',
      work: { home: join(root, 'work'), store: join(root, 'work', 'helmo.db') },
      roadmap: { home: join(root, 'roadmap'), store: join(root, 'roadmap', 'roadmap.db') },
      control: { home: process.env['REV_HOME'], service: 'dev.rev.pinned' } }));
    const out = JSON.parse(start(['status'], { INSTALLATION_RELEASE: file, HELMO_BINDING: binding }).stdout);
    expect(out).toEqual({ binding, required: '1' });
  });

  // A selection nobody can read is a real fault and still refuses — but as one
  // line naming the installation and the repair, not as the uncaught throw a
  // frozen definition produced.
  it.each([
    ['unreadable', () => { release('current'); return select('{ not json'); }, /release selection .* is unreadable/],
    ['null', () => { release('current'); return select('null'); }, /names no release/],
    ['naming no release', () => { release('current'); return select({}); }, /names no release/],
    ['with a non-string directory', () => { release('current'); return select({ release: 'current', directory: 42 }); }, /names no release/],
    ['naming a release that holds no rev', () => {
      const dir = join(root, 'release', 'gone');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'RELEASE.json'), JSON.stringify({ commits: { rev: 'a'.repeat(40), helmo: 'b'.repeat(40), 'helmo-roadmap': 'c'.repeat(40) } }));
      return select({ release: 'gone', directory: dir });
    }, /release gone holds no rev to start/],
  ])('refuses legibly when the selection is %s', (_what, setup, expected) => {
    const file = (setup as () => string)();
    const refused = start(['status'], { INSTALLATION_RELEASE: file });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(expected as RegExp);
    expect(refused.stderr).toContain('dev.rev.pinned');
    expect(refused.stderr).not.toMatch(/^\s+at /m);
    expect(refused.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('refuses when the definition carries no selection at all', () => {
    const refused = spawnSync(process.execPath, [writeLauncher(), 'status'], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', REV_HOME: process.env['REV_HOME']! },
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/INSTALLATION_RELEASE is unset/);
    expect(refused.stderr).toMatch(/rev service install/);
  });

  // The migration: an installation pinned today whose definition was written
  // before this change still names a release directory, and a release command
  // is where that has to be said.
  describe('a definition still naming a release directory is reported', () => {
    const stand = (program: string, home = process.env['REV_HOME']!) => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'rev-stale-'));
      mkdirSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
      process.env['HOME'] = fakeHome;
      writeFileSync(
        join(fakeHome, 'Library', 'LaunchAgents', `${serviceLabel()}.plist`),
        launchdPlist('/node', program, { label: serviceLabel(), home, path: '/p', logPath: '/l' }),
      );
    };

    it('a frozen program is named, with the release directory it points into', () => {
      process.env['INSTALLATION_RELEASE'] = join(root, 'ADOPTED.json');
      const frozen = join(root, 'release', 'current', 'rev', 'dist', 'cli.js');
      stand(frozen);
      expect(stalePinnedService()?.program).toBe(frozen);
    });

    it('a definition already naming the launcher is not stale, and neither is an unpinned one', () => {
      process.env['INSTALLATION_RELEASE'] = join(root, 'ADOPTED.json');
      stand(launcherPath());
      expect(stalePinnedService()).toBe(null);
      delete process.env['INSTALLATION_RELEASE'];
      stand(join(root, 'release', 'current', 'rev', 'dist', 'cli.js'));
      expect(stalePinnedService()).toBe(null);
    });

    it('another installation\'s definition is never this one\'s to report', () => {
      process.env['INSTALLATION_RELEASE'] = join(root, 'ADOPTED.json');
      stand(join(root, 'release', 'current', 'rev', 'dist', 'cli.js'), '/tmp/somebody-else/.rev');
      expect(stalePinnedService()).toBe(null);
    });
  });

  it('reads back the program a definition names, on both managers', () => {
    expect(definedProgram('launchd', launchdPlist('/node', '/a&b/cli.js', { label: 'dev.rev', home: '/h', path: '/p', logPath: '/l' }))).toBe('/a&b/cli.js');
    expect(definedProgram('systemd', systemdUnit('/node', '/opt/launch.mjs', { home: '/h', path: '/p', label: 'dev.rev' }))).toBe('/opt/launch.mjs');
    expect(definedProgram('launchd', '<plist></plist>')).toBe(null);
  });
});
