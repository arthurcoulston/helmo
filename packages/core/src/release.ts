import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LEGACY_COMPONENTS = ['rev', 'helmo', 'helmo-roadmap'] as const;
const PACKAGE_PATHS = { rev: 'packages/runtime', helmo: 'packages/work', 'helmo-roadmap': 'packages/roadmap' } as const;

export function selectedRelease(product: keyof typeof PACKAGE_PATHS, runningRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env['INSTALLATION_RELEASE']?.trim();
  if (!named) return null;
  const selectionFile = resolve(named);
  const selection = JSON.parse(readFileSync(selectionFile, 'utf8')) as { release?: string; directory?: string; components?: Record<string, { release?: string; commit?: string }> };
  if (!selection.release || !selection.directory) throw new Error('selection lacks release or directory');
  const releaseDir = resolve(dirname(selectionFile), selection.directory);
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'RELEASE.json'), 'utf8')) as { commits?: Record<string, string> };
  const commits = manifest.commits ?? {};
  const names = Object.keys(commits).sort();
  const unified = names.length === 1 && names[0] === 'helmo' && typeof commits.helmo === 'string';
  const legacy = names.length === LEGACY_COMPONENTS.length && LEGACY_COMPONENTS.every((name) => names.includes(name));
  if (!unified && !legacy) {
    throw new Error(`release manifest must name either helmo or exactly ${LEGACY_COMPONENTS.join(', ')}`);
  }
  const components = unified ? ['helmo'] : LEGACY_COMPONENTS;
  for (const componentName of components) {
    const component = selection.components?.[componentName];
    if (!component || component.release !== selection.release || component.commit !== commits[componentName]) {
      throw new Error(`${componentName} does not match selected release ${selection.release}`);
    }
  }
  const expected = unified ? resolve(releaseDir, 'helmo', PACKAGE_PATHS[product]) : resolve(releaseDir, product);
  if (realpathSync(runningRoot) !== realpathSync(expected)) throw new Error(`${product} is running from ${runningRoot}, not ${expected}`);
  return selection.release;
}
