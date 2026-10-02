import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Shared precedence for every Helmo-family entry point. Earlier keys win only
 * when all set keys agree; distinct values refuse. */
export const IDENTITY_KEYS = ['HELMO_INSTALLATION', 'ROADMAP_LABEL', 'HELMO_LABEL', 'REV_LABEL'] as const;
export type IdentitySource = typeof IDENTITY_KEYS[number] | 'derived';
export interface Installation { label: string; home: string; db: string; source: IdentitySource; release: string | null }
export interface InstallationConfig { homeKey: string; dbKey: string; defaultHome: string; defaultDb: string; derivedPrefix: 'dev.helmo' | 'dev.roadmap'; homePattern: RegExp; stripPattern: RegExp; release(env: NodeJS.ProcessEnv): string | null }
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
  try { const i = resolveInstallation(c, env); const problem = mismatch(c, i, requested); if (problem) throw new InstallationError(problem); return i; }
  catch (e) { return report(e instanceof Error ? e.message : String(e)); }
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
function plainExit(message: string): never { console.error(message); process.exit(1); }
