import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planLines, removalBounds, removalPlan, removeInstallation } from '../src/remove.js';

// Two installations laid out the way the H-2451 fixture lays them out: homes
// with the same basename under one account, each with its own stores and
// selection beside its Rev home. What a removal of A must never reach is B.
function estate() {
  const root = mkdtempSync(join(tmpdir(), 'rev-remove-'));
  const make = (name: string) => {
    const home = join(root, name);
    const install = {
      name,
      home,
      revHome: join(home, '.rev'),
      helmoDb: join(home, '.helmo', 'helmo.db'),
      roadmapDb: join(home, '.helmo-roadmap', 'roadmap.db'),
      selection: join(home, 'ADOPTED.json'),
    };
    mkdirSync(join(install.revHome, 'state', 'supervisor'), { recursive: true });
    writeFileSync(join(install.revHome, 'roster.toml'), `# ${name}\n`);
    for (const db of [install.helmoDb, install.roadmapDb]) {
      mkdirSync(join(db, '..'), { recursive: true });
      writeFileSync(db, `${name} records`);
      writeFileSync(`${db}-wal`, `${name} write-ahead log`);
    }
    writeFileSync(install.selection, JSON.stringify({ install: name, release: 'current' }));
    return install;
  };
  return { root, a: make('customer-a'), b: make('customer-b') };
}

type Install = ReturnType<typeof estate>['a'];

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['REV_HOME', 'REV_LABEL', 'HOME', 'HELMO_DB', 'ROADMAP_DB', 'ROADMAP_HOME', 'INSTALLATION_RELEASE']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Point the process at an installation, the way a shell targeting it would. */
function targeting(i: Install, account: string, extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    HOME: account,
    REV_HOME: i.revHome,
    HELMO_DB: i.helmoDb,
    ROADMAP_DB: i.roadmapDb,
    INSTALLATION_RELEASE: i.selection,
    ...extra,
  });
}

describe('rev install remove — the plan', () => {
  it('names this installation\'s records and controls, and each store\'s write-ahead log with it', () => {
    const { root, a } = estate();
    targeting(a, root);
    const plan = removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb });

    expect(plan.taking.map((i) => i.path)).toEqual([
      a.revHome,
      a.helmoDb, `${a.helmoDb}-wal`,
      a.roadmapDb, `${a.roadmapDb}-wal`,
    ]);
    expect(plan.blocked).toBe(null);
    expect(planLines(plan)[0]).toBe(
      `installation dev.rev.customer-a — removing every record it names inside ${a.revHome}, ${join(a.home, '.helmo')}, ${join(a.home, '.helmo-roadmap')}:`,
    );
  });

  it('takes the selection when it sits inside the installation, and reports one sitting beside it', () => {
    const { root, a } = estate();
    // H-2544 narrowed the boundary to the directories this installation owns, and
    // a selection file in the directory the homes SHARE is not one of them: under
    // the conventional layout that directory is the account home, where a
    // neighbour's `release.json` looks exactly the same. So the documented place
    // for it (INSTALLATIONS.md: `~/.rev-b/release.json`) is inside the Rev home,
    // and one beside it is named in the plan for the operator to take by hand.
    targeting(a, root);
    expect(removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb }).leaving.find((i) => i.path === a.selection)?.why)
      .toContain('none of installation dev.rev.customer-a\'s own directories');

    const inside = join(a.revHome, 'release.json');
    writeFileSync(inside, JSON.stringify({ install: 'customer-a', release: 'current' }));
    targeting(a, root, { INSTALLATION_RELEASE: inside });
    expect(removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb }).taking.map((i) => i.path)).toContain(inside);
  });

  it('leaves a store that points into the other installation, and says why rather than following it', () => {
    const { root, a, b } = estate();
    // The H-2431 shape: the target is A, and the shell still carries B's store.
    targeting(a, root, { HELMO_DB: b.helmoDb });
    const plan = removalPlan('dev.rev.customer-a', { helmo_db: undefined });

    expect(plan.taking.map((i) => i.path)).not.toContain(b.helmoDb);
    const left = plan.leaving.find((i) => i.path === b.helmoDb);
    expect(left?.why).toContain(`none of installation dev.rev.customer-a's own directories (${a.revHome}, `);
    expect(planLines(plan).join('\n')).toContain(b.helmoDb);
  });

  it('reports a neighbour\'s store it was aimed at even when that store has never been opened', () => {
    const { root, a, b } = estate();
    rmSync(b.roadmapDb);
    // A boundary answer that waited for the file would have said nothing here,
    // and "nothing" is indistinguishable from "this installation owns it".
    targeting(a, root, { ROADMAP_DB: b.roadmapDb });
    const plan = removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb });

    expect(plan.leaving.find((i) => i.path === b.roadmapDb)?.why).toContain('none of installation dev.rev.customer-a\'s own directories');
    expect(plan.taking.map((i) => i.path)).not.toContain(b.roadmapDb);
  });

  it('assumes no default store for a product this installation does not name', () => {
    const { root, a } = estate();
    targeting(a, root);
    delete process.env['ROADMAP_DB'];
    const plan = removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb });

    expect(plan.taking.map((i) => i.path)).not.toContain(a.roadmapDb);
    expect(plan.leaving.find((i) => i.path.endsWith('roadmap.db'))?.why).toContain('ROADMAP_DB/ROADMAP_HOME are unset');
  });

  it('takes the roadmap home\'s own store when only the home is named, the way the roadmap resolves it', () => {
    const { root, a } = estate();
    targeting(a, root);
    delete process.env['ROADMAP_DB'];
    process.env['ROADMAP_HOME'] = join(a.home, '.helmo-roadmap');
    expect(removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb }).taking.map((i) => i.path)).toContain(a.roadmapDb);
  });
});

// The layout INSTALLATIONS.md and DEV.md call conventional: homes that are direct
// children of ONE account home, told apart by their suffix — `~/.rev` with
// `~/.helmo`, `~/.rev-b` with `~/.helmo-b`. Here the directory the homes share is
// the account home itself, so "the directory Rev's home sits in" was a boundary
// holding every record on the machine (H-2544).
function conventionalEstate() {
  const account = mkdtempSync(join(tmpdir(), 'rev-account-'));
  const make = (tail: string) => {
    const install = {
      revHome: join(account, `.rev${tail}`),
      helmoDb: join(account, `.helmo${tail}`, 'helmo.db'),
      roadmapDb: join(account, `.helmo-roadmap${tail}`, 'roadmap.db'),
    };
    mkdirSync(join(install.revHome, 'state', 'supervisor'), { recursive: true });
    writeFileSync(join(install.revHome, 'roster.toml'), `# rev${tail}\n`);
    for (const db of [install.helmoDb, install.roadmapDb]) {
      mkdirSync(join(db, '..'), { recursive: true });
      writeFileSync(db, `rev${tail} records`);
      writeFileSync(`${db}-wal`, `rev${tail} write-ahead log`);
    }
    return install;
  };
  return { account, first: make(''), second: make('-b') };
}

describe('rev install remove — the conventional ~/.rev-<suffix> layout', () => {
  it('leaves the first installation\'s store a copied roster still names, and takes its own', () => {
    const { account, first, second } = conventionalEstate();
    // How an operator gets here: `cp -a ~/.rev ~/.rev-b` to bootstrap the second
    // installation, and roster.toml comes along with `helmo_db = ~/.helmo/helmo.db`
    // in it — the FIRST installation's records, named by the second.
    Object.assign(process.env, { HOME: account, REV_HOME: second.revHome, REV_LABEL: 'dev.rev.b' });
    const plan = removalPlan('dev.rev.b', { helmo_db: first.helmoDb });

    expect(plan.taking.map((i) => i.path)).not.toContain(first.helmoDb);
    expect(plan.leaving.find((i) => i.path === first.helmoDb)?.why)
      .toContain(`none of installation dev.rev.b's own directories`);
    // And the boundary never was the account home: nothing under it is ours by
    // being under it.
    expect(plan.bounds).toEqual([second.revHome, join(account, '.helmo-b'), join(account, '.helmo-roadmap-b')]);
    expect(plan.bounds).not.toContain(account);

    // Its own store, named the same way, is taken.
    const mine = removalPlan('dev.rev.b', { helmo_db: second.helmoDb });
    expect(mine.taking.map((i) => i.path)).toEqual([
      second.revHome, second.helmoDb, `${second.helmoDb}-wal`,
    ]);
  });

  it('removes the second installation and leaves the first byte-for-byte', () => {
    const { account, first, second } = conventionalEstate();
    const before = [readFileSync(join(first.revHome, 'roster.toml'), 'utf8'), readFileSync(first.helmoDb, 'utf8'), readFileSync(`${first.helmoDb}-wal`, 'utf8'), readFileSync(first.roadmapDb, 'utf8')];
    Object.assign(process.env, {
      HOME: account, REV_HOME: second.revHome, REV_LABEL: 'dev.rev.b',
      HELMO_DB: first.helmoDb, ROADMAP_DB: first.roadmapDb,
    });

    const plan = removalPlan('dev.rev.b', { helmo_db: undefined });
    expect(removeInstallation(plan)).toEqual([second.revHome]);
    expect(existsSync(second.revHome)).toBe(false);
    expect([readFileSync(join(first.revHome, 'roster.toml'), 'utf8'), readFileSync(first.helmoDb, 'utf8'), readFileSync(`${first.helmoDb}-wal`, 'utf8'), readFileSync(first.roadmapDb, 'utf8')]).toEqual(before);
    // The account home is not a record: a removal never reaches for it.
    expect(existsSync(account)).toBe(true);
  });

  it('falls back to the enclosing directory for a home the convention does not name', () => {
    // There is nothing to pair a `/srv/installs/alpha-rev` with, so the directory
    // it sits in is the only boundary available — and it holds exactly as far as
    // that directory belongs to one installation. The docs say that rather than
    // implying a guard, and `REV_HOME` under the account home is still refused
    // outright by `blockage`.
    expect(removalBounds('/srv/installs/alpha-rev')).toEqual(['/srv/installs']);
    expect(removalBounds('/srv/installs/alpha/.revved')).toEqual(['/srv/installs/alpha']);
    // A separator after `.rev` is the convention, in any of its spellings.
    expect(removalBounds('/srv/.rev_b')).toEqual(['/srv/.rev_b', '/srv/.helmo_b', '/srv/.helmo-roadmap_b']);
  });

  it('holds for the bare ~/.rev as well, whose pair is the unsuffixed ~/.helmo', () => {
    const { account, first, second } = conventionalEstate();
    Object.assign(process.env, { HOME: account, REV_HOME: first.revHome, REV_LABEL: 'dev.rev' });
    const plan = removalPlan('dev.rev', { helmo_db: second.helmoDb });

    expect(plan.bounds).toEqual([first.revHome, join(account, '.helmo'), join(account, '.helmo-roadmap')]);
    expect(plan.taking.map((i) => i.path)).not.toContain(second.helmoDb);
    expect(plan.leaving.find((i) => i.path === second.helmoDb)?.why).toContain('not this installation\'s to remove');
  });
});

describe('rev install remove — what stops it', () => {
  it('refuses while a service definition stands, and names the command that takes it first', () => {
    const { root, a } = estate();
    targeting(a, root);
    const agents = join(root, 'Library', 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    mkdirSync(join(root, '.config', 'systemd', 'user'), { recursive: true });
    process.env['REV_LABEL'] = 'dev.rev.customer-a';
    const file = process.platform === 'darwin'
      ? join(agents, 'dev.rev.customer-a.plist')
      : join(root, '.config', 'systemd', 'user', 'dev.rev.customer-a.service');
    writeFileSync(file, 'a definition');

    const plan = removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb });
    expect(plan.blocked).toContain(file);
    expect(plan.blocked).toContain('rev service uninstall');
    // And it is a refusal, not a warning: nothing goes.
    expect(() => removeInstallation(plan)).toThrow(/rev service uninstall/);
    expect(existsSync(a.revHome)).toBe(true);
  });

  it('refuses while the supervisor is running, and names the drain', () => {
    const { root, a } = estate();
    targeting(a, root);
    // A marker for THIS process: alive, and with no cmd line it is trusted by
    // pid alone, which is what an older marker looks like.
    writeFileSync(join(a.revHome, 'state', 'supervisor', 'RUNNING'), `${process.pid}\n`);

    const plan = removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb });
    expect(plan.blocked).toContain(`pid ${process.pid}`);
    expect(plan.blocked).toContain('rev stop');
  });

  it('refuses outright when the Rev home would take the account\'s home directory with it', () => {
    const { root, a } = estate();
    targeting(a, root);
    process.env['REV_HOME'] = root;
    process.env['HOME'] = a.home;

    const plan = removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb });
    expect(plan.blocked).toContain('contains this account\'s home directory');
    expect(() => removeInstallation(plan)).toThrow(/home directory/);
    expect(existsSync(a.revHome)).toBe(true);
  });
});

describe('rev install remove — the removal', () => {
  it('deletes exactly what it planned, and the other installation is byte-for-byte what it was', () => {
    const { root, a, b } = estate();
    const before = [b.revHome && readFileSync(join(b.revHome, 'roster.toml'), 'utf8'), readFileSync(b.helmoDb, 'utf8'), readFileSync(`${b.helmoDb}-wal`, 'utf8'), readFileSync(b.roadmapDb, 'utf8'), readFileSync(b.selection, 'utf8')];
    targeting(a, root);

    const plan = removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb });
    expect(removeInstallation(plan)).toEqual(plan.taking.map((i) => i.path));

    for (const p of plan.taking) expect(existsSync(p.path), `${p.path} survived its own removal`).toBe(false);
    // A's home itself stays: the boundary is never the thing removed.
    expect(existsSync(a.home)).toBe(true);
    expect([readFileSync(join(b.revHome, 'roster.toml'), 'utf8'), readFileSync(b.helmoDb, 'utf8'), readFileSync(`${b.helmoDb}-wal`, 'utf8'), readFileSync(b.roadmapDb, 'utf8'), readFileSync(b.selection, 'utf8')]).toEqual(before);
  });

  it('is repeatable: a second removal finds nothing of its own left and reaches for nothing else', () => {
    const { root, a, b } = estate();
    targeting(a, root);
    removeInstallation(removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb }));
    expect(removeInstallation(removalPlan('dev.rev.customer-a', { helmo_db: a.helmoDb }))).toEqual([]);
    expect(existsSync(b.helmoDb)).toBe(true);
  });
});
