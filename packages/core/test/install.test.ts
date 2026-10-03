import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireResolvedInstallation, type InstallationConfig } from '../src/install.js';

const config: InstallationConfig = {
  homeKey: 'HELMO_HOME', dbKey: 'HELMO_DB', defaultHome: '.helmo', defaultDb: 'helmo.db',
  derivedPrefix: 'dev.helmo', homePattern: /^\.helmo([-_.]|$)/, stripPattern: /^\.?helmo(?=[-_.]|$)/,
  release: (env) => env.INSTALLATION_RELEASE ?? null, bindingProduct: 'work',
};
const throwReport = (message: string): never => { throw new Error(message); };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'helmo-binding-'));
  const home = join(root, 'work'); const store = join(home, 'helmo.db');
  const roadmap = join(root, 'roadmap'); const control = join(root, 'runtime');
  mkdirSync(home); mkdirSync(roadmap); mkdirSync(control);
  const binding = join(root, 'installation.json');
  writeFileSync(binding, JSON.stringify({ version: 1, id: 'fixture-a', installation: 'fixture-a', release: join(root, 'release.json'), work: { home, store }, roadmap: { home: roadmap, store: join(roadmap, 'roadmap.db') }, control: { home: control, service: 'fixture-a' } }));
  return { root, home, store, binding };
}

describe('fail-closed installation binding', () => {
  it('requires a deed rather than accepting a label-only agent target', () => {
    const f = fixture();
    expect(() => requireResolvedInstallation(config, { HELMO_REQUIRE_BINDING: '1', HELMO_INSTALLATION: 'fixture-a', HELMO_HOME: f.home, INSTALLATION_RELEASE: join(f.root, 'release.json') }, throwReport))
      .toThrow(/HELMO_BINDING is missing.*Nothing was opened/);
  });

  it('accepts one coherent binding and refuses foreign targets before a store exists', () => {
    const f = fixture();
    const good = { HELMO_REQUIRE_BINDING: '1', HELMO_BINDING: f.binding, HELMO_INSTALLATION: 'fixture-a', HELMO_HOME: f.home, INSTALLATION_RELEASE: join(f.root, 'release.json') };
    expect(requireResolvedInstallation(config, good).db).toBe(f.store);
    expect(() => requireResolvedInstallation(config, { ...good, HELMO_HOME: join(f.root, 'foreign') }, throwReport)).toThrow(/name different installations|stale or foreign.*home/);
    expect(existsSync(f.store)).toBe(false);
    expect(existsSync(join(f.root, 'foreign', 'helmo.db'))).toBe(false);
  });

  it('uses the deed for omitted identity and endpoint values, without treating it as a redirect', () => {
    const f = fixture();
    const resolved = requireResolvedInstallation(config, { HELMO_REQUIRE_BINDING: '1', HELMO_BINDING: f.binding, INSTALLATION_RELEASE: join(f.root, 'release.json') });
    expect(resolved).toMatchObject({ label: 'fixture-a', home: f.home, db: f.store });
  });

  it('refuses incomplete bindings', () => {
    const f = fixture(); writeFileSync(f.binding, JSON.stringify({ version: 1, id: 'fixture-a', installation: 'fixture-a' }));
    expect(() => requireResolvedInstallation(config, { HELMO_BINDING: f.binding, HELMO_INSTALLATION: 'fixture-a', HELMO_HOME: f.home }, throwReport)).toThrow(/incomplete or unsupported/);
  });
});
