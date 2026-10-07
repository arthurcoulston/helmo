import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isEntrypoint } from '../src/server.js';

const was = process.argv[1];
afterEach(() => { process.argv[1] = was; });

/** A built view beside a second name for the directory holding it — the shape
 *  a release takes when it exposes one component under a historical name. */
function twoSpellings() {
  const root = mkdtempSync(join(tmpdir(), 'helmo-entry-'));
  const real = join(root, 'packages', 'runtime', 'dist');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'view.js'), '');
  symlinkSync(join('packages', 'runtime'), join(root, 'rev'), 'dir');
  return { real: join(real, 'view.js'), alias: join(root, 'rev', 'dist', 'view.js') };
}

describe('isEntrypoint', () => {
  it('is true for the file node was asked to run, by either name for it', () => {
    const { real, alias } = twoSpellings();
    // `import.meta.url` always arrives resolved, so the module's own spelling
    // is the real one; what varies is how the command line reached it.
    const moduleUrl = pathToFileURL(real).href;
    process.argv[1] = real;
    expect(isEntrypoint(moduleUrl)).toBe(true);
    process.argv[1] = alias;
    expect(isEntrypoint(moduleUrl)).toBe(true);
  });

  it('is false when some other entry point imported this module', () => {
    const { real, alias } = twoSpellings();
    process.argv[1] = join(alias, '..', 'cli.js');
    expect(isEntrypoint(pathToFileURL(real).href)).toBe(false);
  });

  it('is false with no entry at all, which is how `node -e` and a REPL arrive', () => {
    const { real } = twoSpellings();
    delete process.argv[1];
    expect(isEntrypoint(pathToFileURL(real).href)).toBe(false);
  });

  it('survives a name a URL would read as punctuation', () => {
    // '#' is the one that bites: concatenating it into a file:// URL makes
    // everything after it a fragment, so the path silently loses its tail,
    // while pathToFileURL escapes it. A space, by contrast, is normalised to
    // %20 either way and would not have shown this.
    const root = mkdtempSync(join(tmpdir(), 'helmo#entry-'));
    const file = join(root, 'view.js');
    writeFileSync(file, '');
    process.argv[1] = file;
    expect(isEntrypoint(pathToFileURL(file).href)).toBe(true);
  });
});
