import { describe, expect, it } from 'vitest';
import { loadRoster, validateRefinementPreparationConfig as validate } from '../src/config.js';
import type { GlobalConfig } from '../src/types.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const config = () => ({ refinement_preparation_enabled: true, intake_preparation_origin: 'https://example.test', intake_preparation_checkout: '/test/intake',
  refinement_preparation_source: '/test/source', refinement_preparation_base_ref: 'a'.repeat(40), refinement_preparation_work_root: '/test/private',
  refinement_preparation_sync_script: '/test/tools/sync.mjs', refinement_preparation_scan_script: '/test/tools/scan.mjs' } as GlobalConfig);
describe('explicit preparation configuration', () => {
  it('absent or disabled stays off; the accepted pin and tool paths are required to enable', () => {
    expect(() => validate({} as GlobalConfig)).not.toThrow();
    expect(() => validate({ refinement_preparation_enabled: false } as GlobalConfig)).not.toThrow();
    expect(() => validate(config())).not.toThrow();
  });
  it.each(Object.keys(config()).filter(k => k !== 'refinement_preparation_enabled'))('refuses enabled incomplete key %s', key => {
    const g = config(); delete (g as unknown as Record<string, unknown>)[key]; expect(() => validate(g)).toThrow('Invalid refinement');
  });
  it.each([{ refinement_preparation_enabled: 'true' }, { refinement_preparation_base_ref: 'main' },
    { refinement_preparation_source: 'relative' }, { refinement_preparation_work_root: '/test/source/nested' },
    { refinement_preparation_work_root: '/test/source' }, { refinement_preparation_sync_script: '/path\nPRIVATE' },
    { intake_preparation_origin: 'https://user:PRIVATE@example.test' }, { intake_preparation_origin: 'http://remote.test' }])('refuses malformed opt-in without echoing fields: %j', diff => {
    expect(() => validate({ ...config(), ...diff } as GlobalConfig)).toThrow('Invalid refinement preparation configuration; Builder must inspect the opt-in.');
  });
  it('the actual roster loader applies validation before any supervisor startup', () => {
    const home = mkdtempSync(join(tmpdir(), 'rev-refinement-config-')), previous = process.env.REV_HOME;
    try {
      process.env.REV_HOME = home;
      writeFileSync(join(home, 'roster.toml'), '[global]\nhelmo_cli="unused"\nhelmo_mcp_server="unused"\nrefinement_preparation_enabled=true\n');
      expect(() => loadRoster()).toThrow('Invalid refinement');
    } finally { if (previous === undefined) delete process.env.REV_HOME; else process.env.REV_HOME = previous; }
  });
});
