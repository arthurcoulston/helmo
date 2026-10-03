import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Shared precedence for every Helmo-family entry point. Earlier keys win only
 * when all set keys agree; distinct values refuse. */
export const IDENTITY_KEYS = ['HELMO_INSTALLATION', 'ROADMAP_LABEL', 'HELMO_LABEL', 'REV_LABEL'] as const;
export type IdentitySource = typeof IDENTITY_KEYS[number] | 'derived';
export interface Installation { label: string; home: string; db: string; source: IdentitySource; release: string | null }
export type InstallationProduct = 'work' | 'roadmap';
export interface InstallationBinding { version: 1; id: string; installation: string; release: string | null; work: { home: string; store: string }; roadmap: { home: string; store: string }; control: { home: string; service: string } }
export interface ControlInstallation { label: string; home: string; release: string | null; service: string }
export interface InstallationConfig { homeKey: string; dbKey: string; defaultHome: string; defaultDb: string; derivedPrefix: 'dev.helmo' | 'dev.roadmap'; homePattern: RegExp; stripPattern: RegExp; release(env: NodeJS.ProcessEnv): string | null; bindingProduct?: InstallationProduct }
export class InstallationError extends Error {}

export function explicitInstallationIdentity(env: NodeJS.ProcessEnv = process.env): { label: string; source: IdentitySource } | null {
  const set = IDENTITY_KEYS.flatMap((key) => env[key]?.trim() ? [{ key, value: env[key]!.trim() }] : []);
  if (new Set(set.map(({ value }) => value)).size > 1) throw new InstallationError(`Installation identity keys disagree — ${set.map(({ key, value }) => `${key}=${value}`).join(', ')}. Set one value across the accepted keys or unset the extras.`);
  return set[0] ? { label: set[0].value, source: set[0].key } : null;
}

export function resolveInstallation(c: InstallationConfig, env: NodeJS.ProcessEnv = process.env): Installation {
  const homeVar = env[c.homeKey]?.trim(); const dbVar = env[c.dbKey]?.trim();
  const home = homeVar ? resolve(homeVar) : dbVar ? dirname(resolve(dbVar)) : join(homedir(), c.defaultHome);
  const db = dbVar ? resolve(dbVar) : join(home, c.defaultDb);
  if (homeVar && dbVar && !within(home, db)) throw new InstallationError(`${c.homeKey} and ${c.dbKey} name different installations — ${c.homeKey}=${home} but ${c.dbKey}=${db}, which is not inside it. Unset one: ${c.homeKey} alone uses ${join(home, c.defaultDb)}, ${c.dbKey} alone treats ${dirname(db)} as the installation home.`);
  const identity = explicitInstallationIdentity(env);
  return { label: identity?.label ?? derivedLabel(c, home), home, db, source: identity?.source ?? 'derived', release: c.release(env) };
}
export function requireResolvedInstallation(c: InstallationConfig, env: NodeJS.ProcessEnv = process.env, report: (message: string) => never = plainExit, requested?: string): Installation {
  try {
    const effective = bindingEnvironment(c, env); const i = resolveInstallation(c, effective);
    const problem = mismatch(c, i, requested); if (problem) throw new InstallationError(problem);
    requireInstallationBinding(c, i, effective); return i;
  }
  catch (e) { return report(e instanceof Error ? e.message : String(e)); }
}

/** A deed supplies values the caller omitted; it never wins a conflict. This
 * is what makes a deed-only MCP registration useful without turning the deed
 * into a redirect for a command that explicitly named somewhere else. */
function bindingEnvironment(c: InstallationConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.HELMO_BINDING?.trim() || !c.bindingProduct) return env;
  const loaded = readInstallationBinding(env); if (!loaded) return env;
  const endpoint = loaded.binding[c.bindingProduct];
  return {
    ...env,
    HELMO_INSTALLATION: explicitInstallationIdentity(env)?.label ?? loaded.binding.installation,
    [c.homeKey]: env[c.homeKey]?.trim() || endpoint.home,
    [c.dbKey]: env[c.dbKey]?.trim() || endpoint.store,
  };
}

/** Validate the caller's installation deed before a caller is allowed to open
 * a store. HELMO_BINDING is deliberately a file, not a label: one document
 * binds the name to both stores, the release selection and control identity. */
export function requireInstallationBinding(c: InstallationConfig, i: Installation, env: NodeJS.ProcessEnv = process.env): InstallationBinding | null {
  const loaded = readInstallationBinding(env); if (!loaded) return null;
  const { file, binding: b } = loaded;
  if (!c.bindingProduct) throw new InstallationError('This entry point does not declare which installation store it owns. Nothing was opened or written.');
  const endpoint = b[c.bindingProduct];
  const conflicts = [
    b.installation === i.label ? null : `name ${JSON.stringify(b.installation)} != ${JSON.stringify(i.label)}`,
    resolve(endpoint.home as string) === i.home ? null : `home ${resolve(endpoint.home as string)} != ${i.home}`,
    resolve(endpoint.store as string) === i.db ? null : `store ${resolve(endpoint.store as string)} != ${i.db}`,
    (b.release ?? null) === i.release ? null : `release ${JSON.stringify(b.release)} != ${JSON.stringify(i.release)}`,
    env.REV_HOME?.trim() && resolve(b.control!.home) !== resolve(env.REV_HOME) ? `control home ${resolve(b.control!.home)} != ${resolve(env.REV_HOME)}` : null,
    b.control.service === b.installation ? null : `service ${JSON.stringify(b.control.service)} != ${JSON.stringify(b.installation)}`,
  ].filter(Boolean);
  if (conflicts.length) throw new InstallationError(`Installation binding ${resolve(file)} is stale or foreign: ${conflicts.join('; ')}. Nothing was opened or written.`);
  return b;
}

/** Runtime's half of the same deed gate. Unlike a product Store entry point,
 * this runs before roster, control, release or service state is read. */
export function requireControlInstallationBinding(i: ControlInstallation, env: NodeJS.ProcessEnv = process.env, checkRelease = true): InstallationBinding | null {
  const loaded = readInstallationBinding(env); if (!loaded) return null;
  const { file, binding: b } = loaded;
  const conflicts = [
    b.installation === i.label ? null : `name ${JSON.stringify(b.installation)} != ${JSON.stringify(i.label)}`,
    resolve(b.control.home) === resolve(i.home) ? null : `control home ${resolve(b.control.home)} != ${resolve(i.home)}`,
    b.control.service === i.service ? null : `service ${JSON.stringify(b.control.service)} != ${JSON.stringify(i.service)}`,
    !checkRelease || (b.release ?? null) === i.release ? null : `release ${JSON.stringify(b.release)} != ${JSON.stringify(i.release)}`,
  ].filter(Boolean);
  if (conflicts.length) throw new InstallationError(`Installation binding ${file} is stale or foreign: ${conflicts.join('; ')}. Nothing was opened, returned, written or controlled.`);
  return b;
}

function readInstallationBinding(env: NodeJS.ProcessEnv): { file: string; binding: InstallationBinding } | null {
  const named = env.HELMO_BINDING?.trim(); const required = env.HELMO_REQUIRE_BINDING?.trim() === '1';
  if (!named) {
    if (required) throw new InstallationError('HELMO_REQUIRE_BINDING=1 but HELMO_BINDING is missing. Nothing was opened or written. Run the installation setup/migration and launch through its bound entry point.');
    return null;
  }
  const file = resolve(named); let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new InstallationError(`Cannot read installation binding ${file}: ${error instanceof Error ? error.message : String(error)}. Nothing was opened or written.`); }
  const b = value as Partial<InstallationBinding>;
  const paths = [b.work?.home, b.work?.store, b.roadmap?.home, b.roadmap?.store, b.control?.home];
  if (b.version !== 1 || !text(b.id) || !text(b.installation) || !b.work || !text(b.work.home) || !text(b.work.store)
    || !b.roadmap || !text(b.roadmap.home) || !text(b.roadmap.store) || !b.control || !text(b.control.home)
    || !text(b.control.service) || !(b.release === null || text(b.release)) || paths.some((path) => !text(path) || !isAbsolute(path))) {
    throw new InstallationError(`Installation binding ${file} is incomplete or unsupported. Nothing was opened or written.`);
  }
  return { file, binding: b as InstallationBinding };
}
export function namesResolvedInstallation(c: InstallationConfig, i: Installation, want: string): boolean {
  if (!i.home || !i.db) return want === i.label;
  const standalone = derivedLabel(c, i.home); const shared = standalone.replace(/^dev\.(helmo|roadmap)(?=\.|$)/, 'dev.rev');
  return (i.label === standalone || i.label === shared ? [standalone, shared] : [i.label]).includes(want) || resolve(want) === i.home || resolve(want) === i.db;
}
export function requestedInstallation(argv: readonly string[]): string | undefined { const n = argv.findIndex((a) => a === '--installation' || a.startsWith('--installation=')); if (n < 0) return undefined; const arg = argv[n]!; if (arg.startsWith('--installation=')) return arg.slice(15); const next = argv[n + 1]; return next === undefined || next.startsWith('--') ? '' : next; }
export function formatInstallationLine(i: Installation, runningLine: () => string, identity?: { stored: string | null; clear: boolean }): string { const target = identity && !identity.clear ? ` — target UNCLEAR: process ${i.label}, store ${identity.stored}` : ''; return `install: ${i.label} (${i.home}) — db: ${i.db}${i.release ? ` — release: ${i.release}` : ''}${target} — ${runningLine()}`; }
export function installationFields<T>(i: Installation, running: () => T, identity?: { stored: string | null; clear: boolean }) { return { label: i.label, home: i.home, db: i.db, source: i.source, ...(i.release ? { release: i.release } : {}), ...(identity && !identity.clear ? { target: 'UNCLEAR', stored_name: identity.stored ?? undefined } : {}), running: running() }; }
function mismatch(c: InstallationConfig, i: Installation, requested?: string): string | null { if (requested === undefined) return null; const want = requested.trim(); if (!want) return '--installation was given no value (name the installation, or drop the flag).'; if (namesResolvedInstallation(c, i, want)) return null; return `--installation named '${want}', but this process resolves installation '${i.label}' (home ${i.home}, store ${i.db}) from the environment. Nothing was opened or written. --installation asserts the target and cannot move it: point ${c.homeKey} or ${c.dbKey} at the installation you meant.`; }
function derivedLabel(c: InstallationConfig, home: string): string { const suffix = labelSuffix(c, basename(home)); if (dirname(home) === accountHome() && c.homePattern.test(basename(home))) return suffix ? `${c.derivedPrefix}.${suffix}` : c.derivedPrefix; const descriptive = suffix || labelSuffix(c, basename(dirname(home))); return `${c.derivedPrefix}.${descriptive ? `${descriptive}.` : ''}${createHash('sha256').update(home).digest('hex').slice(0, 8)}`; }
function labelSuffix(c: InstallationConfig, name: string): string { return name.replace(c.stripPattern, '').replace(/^[-_.]+/, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''); }
function accountHome(): string { try { return resolve(userInfo().homedir); } catch { return resolve(homedir()); } }
function within(home: string, path: string): boolean { return path === home || path.startsWith(home.endsWith(sep) ? home : home + sep); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function plainExit(message: string): never { console.error(message); process.exit(1); }
