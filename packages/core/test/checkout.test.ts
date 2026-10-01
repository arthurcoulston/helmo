// Finding F4's rule, measured where the answer differs: a package inside a
// workspace and the same package as its own checkout must resolve the SAME
// tree, and the one they must not resolve is the directory beside the package.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { besideCheckout, checkoutRoot, productCheckout, workspacePackage } from '../checkout.mjs';

/** A layout under a fresh temp directory: each key a directory, each value its
 *  package.json or null for a plain directory. Left for the OS to reap. */
function tree(layout: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'checkout-'));
  for (const [path, pkg] of Object.entries(layout)) {
    const dir = join(root, path);
    mkdirSync(dir, { recursive: true });
    if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }
  return root;
}

describe('checkout resolution (F4)', () => {
  const workspace = tree({
    'ws': { name: 'family', private: true, workspaces: ['packages/core', 'packages/work', 'packages/runtime'] },
    'ws/packages/core': { name: '@helmo/core' },
    'ws/packages/work': { name: 'helmo' },
    'ws/packages/runtime': { name: 'rev' },
    'ws/packages/runtime/test': null,
    'estate/tokens': null,
  });
  const standalone = tree({
    'rev': { name: 'rev' },
    'rev/test': null,
    'helmo': { name: 'helmo' },
    'estate/tokens': null,
  });

  it('is the workspace root for a package in a workspace, from the package or any directory under it', () => {
    expect(checkoutRoot(join(workspace, 'ws', 'packages', 'runtime'))).toBe(join(workspace, 'ws'));
    expect(checkoutRoot(join(workspace, 'ws', 'packages', 'runtime', 'test'))).toBe(join(workspace, 'ws'));
  });

  it('is the package itself when nothing above it declares workspaces', () => {
    expect(checkoutRoot(join(standalone, 'rev'))).toBe(join(standalone, 'rev'));
    expect(checkoutRoot(join(standalone, 'rev', 'test'))).toBe(join(standalone, 'rev'));
  });

  it('puts a read-at-build-time sibling beside the ROOT, not beside the package', () => {
    const fromWorkspace = besideCheckout(join(workspace, 'ws', 'packages', 'work'), 'estate', 'tokens');
    expect(fromWorkspace).toBe(join(workspace, 'estate', 'tokens'));
    // The path the pre-C1 spelling produced, and the defect itself.
    expect(fromWorkspace).not.toBe(join(workspace, 'ws', 'packages', 'estate', 'tokens'));
    expect(besideCheckout(join(standalone, 'rev'), 'estate', 'tokens')).toBe(join(standalone, 'estate', 'tokens'));
  });

  it('finds a workspace package by its declared name, whatever its directory is called', () => {
    expect(workspacePackage(join(workspace, 'ws', 'packages', 'runtime', 'test'), 'helmo')).toBe(
      join(workspace, 'ws', 'packages', 'work'),
    );
    expect(workspacePackage(join(workspace, 'ws', 'packages', 'runtime'), 'nothing-here')).toBeNull();
    expect(workspacePackage(join(standalone, 'rev', 'test'), 'helmo')).toBeNull();
  });

  it('resolves another product to one tree from inside a workspace and from a lone clone', () => {
    expect(productCheckout(join(workspace, 'ws', 'packages', 'runtime', 'test'), 'helmo', 'helmo')).toBe(
      join(workspace, 'ws', 'packages', 'work'),
    );
    expect(productCheckout(join(standalone, 'rev', 'test'), 'helmo', 'helmo')).toBe(join(standalone, 'helmo'));
  });

  it('ignores a workspace pattern it does not fully understand rather than guessing', () => {
    const globbed = tree({
      'ws': { name: 'family', workspaces: ['packages/*', 'apps/**/nested'] },
      'ws/packages/one': { name: 'one' },
      'ws/packages/two': { name: 'two' },
      'ws/apps/a/nested': { name: 'nested' },
    });
    expect(workspacePackage(join(globbed, 'ws'), 'two')).toBe(join(globbed, 'ws', 'packages', 'two'));
    expect(workspacePackage(join(globbed, 'ws'), 'nested')).toBeNull();
  });
});
