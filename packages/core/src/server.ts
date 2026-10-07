import { mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Installation } from './install.js';
export function prepareServer<T>(i: Installation, open: () => T): T { mkdirSync(i.home, { recursive: true }); return open(); }

/**
 * Whether this module is the file node was asked to run, so an entry point can
 * serve when started directly and stay importable by the shell.
 *
 * The two spellings are not interchangeable. `argv[1]` is the path as it was
 * typed; `import.meta.url` is the one the ESM loader resolved, with every
 * symlink already followed. Anything that reaches a build through a second
 * name spells one file two ways — a release exposed under its historical
 * component names, or any staging directory under macOS's /tmp, which is a
 * symlink to /private/tmp — and a guard that compares the spellings then reads
 * "something else imported me" and serves nothing, exiting 0 in silence
 * (H-2996). Compare the real paths, and come down to a path with
 * fileURLToPath rather than up to a URL by concatenation, so a directory with
 * a space or a '#' in its name is not a second way to fail.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
  return real(fileURLToPath(moduleUrl)) === real(entry);
}
