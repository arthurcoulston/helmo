import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIntakeAssignment } from '../src/helm.js';
import { GlobalConfig } from '../src/types.js';

describe('intake assignment', () => {
  it('uses only fields supported by the installed Helmo CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'rev-helm-intake-'));
    const cli = join(root, 'helmo.mjs');
    const seen = join(root, 'argv.json');
    writeFileSync(cli, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ id: 'H-test' }));\n`);
    const g = { helmo_cli: cli } as GlobalConfig;

    expect(createIntakeAssignment(g, 'bounded body')).toBe('H-test');
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([
      'create', '--title', 'Prepare the claimed meeting intake', '--body', 'bounded body',
      '--workstream', 'goodplumb', '--type', 'build', '--priority', '0', '--assignee', 'builder',
    ]);
  });
});
