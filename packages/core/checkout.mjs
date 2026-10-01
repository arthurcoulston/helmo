/* Where this checkout ends, and how it finds what is cloned beside it
   (R-47 C1, finding F4, H-2638).

   Before C1 these products were separate repositories, so "the estate
   checkout next to this one" was `<package>/../estate` and every script that
   needed it spelled that path itself. In the unified workspace a package sits
   at `<root>/packages/<name>`, its siblings are the other packages, and the
   estate is beside the ROOT. Not one of those scripts changed and all of them
   broke: moving a directory is a rename to any code keyed on a basename, and
   C1's plan excluding renames did not exclude these.

   So the rule is written once, here, in terms of what the tree itself
   declares rather than of how deep a package happens to sit. The checkout
   root is the outermost enclosing directory whose package.json declares npm
   workspaces, and failing that the nearest enclosing package — a product
   that is its own checkout, which is what every one of these was before. A
   standalone clone of any one product therefore resolves exactly as it did
   before C1, and the same source tree inside the workspace resolves to the
   same place.

   Plain .mjs on purpose. `scripts/*.mjs` run before anything is compiled —
   one of them is `prebuild` — and `dist/` is not checked in, so a helper they
   share must not need a build to exist.
*/
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function packageJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null; // no package.json, or one we cannot read: not a root
  }
}

/** The root of the working tree `from` belongs to: the outermost enclosing
 *  directory whose package.json declares workspaces, and failing that the
 *  nearest enclosing package — a product that is its own checkout. */
export function checkoutRoot(from) {
  const start = resolve(from);
  let nearestPackage = null;
  let outermostWorkspace = null;
  for (let dir = start; ; dir = dirname(dir)) {
    const pkg = packageJson(dir);
    if (pkg) {
      nearestPackage ??= dir;
      if (pkg.workspaces) outermostWorkspace = dir;
    }
    if (dir === dirname(dir)) break;
  }
  return outermostWorkspace ?? nearestPackage ?? start;
}

/** A path beside this checkout — where a repository we read at build time,
 *  never import, is expected to be cloned. */
export function besideCheckout(from, ...segments) {
  return join(dirname(checkoutRoot(from)), ...segments);
}

/** Every directory this checkout declares as a workspace package. Patterns
 *  are literal paths or a single trailing `/*`, which is all npm's own
 *  workspaces field is used for here; anything else is ignored rather than
 *  half-understood. */
function workspaceDirs(root) {
  const declared = packageJson(root)?.workspaces;
  const patterns = Array.isArray(declared) ? declared : (declared?.packages ?? []);
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = join(root, pattern.slice(0, -2));
      try {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.isDirectory()) dirs.push(join(parent, entry.name));
        }
      } catch {
        /* a declared workspace directory that does not exist declares nothing */
      }
    } else if (!pattern.includes('*')) {
      dirs.push(join(root, pattern));
    }
  }
  return dirs;
}

/** The directory of a workspace package by the name its OWN package.json
 *  declares, or null when this checkout has no such package. Keyed on the
 *  declared name because that is the thing a directory move does not change;
 *  a caller that gets null is in a standalone clone, where its pre-C1 sibling
 *  path is still the right answer. */
export function workspacePackage(from, name) {
  for (const dir of workspaceDirs(checkoutRoot(from))) {
    if (packageJson(dir)?.name === name) return dir;
  }
  return null;
}

/** The source checkout of another product in this family — one this product
 *  reads or drives over a process boundary, never imports. It is a package in
 *  this workspace when the family shares one, and a repository cloned beside
 *  this checkout when it does not; both answers are the same tree, and the
 *  caller does no path arithmetic to choose between them. */
export function productCheckout(from, packageName, repositoryName) {
  return workspacePackage(from, packageName) ?? besideCheckout(from, repositoryName);
}
