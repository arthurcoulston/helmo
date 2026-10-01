import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatInstallationLine, installationFields, InstallationError, namesResolvedInstallation, requestedInstallation, requireResolvedInstallation, resolveInstallation, type Installation, type InstallationConfig } from '@helmo/core';
import { selectedRelease as selectedCoreRelease } from '@helmo/core/release';
import { runningLine, runningRef } from './build.js';
const config: InstallationConfig = { homeKey: 'HELMO_HOME', dbKey: 'HELMO_DB', defaultHome: '.helmo', defaultDb: 'helmo.db', derivedPrefix: 'dev.helmo', homePattern: /^\.helmo([-_.]|$)/, stripPattern: /^\.?helmo(?=[-_.]|$)/, release: (env) => selectedRelease('helmo', env) };
export { InstallationError, requestedInstallation }; export type { Installation };
export const installation = (env: NodeJS.ProcessEnv = process.env) => resolveInstallation(config, env);
export const requireInstallation = (env: NodeJS.ProcessEnv = process.env, report?: (message: string) => never, requested?: string) => requireResolvedInstallation(config, env, report, requested);
export const namesInstallation = (value: Installation, want: string) => namesResolvedInstallation(config, value, want);
export const installationLine = (value: Installation, identity?: { stored: string | null; clear: boolean }) => formatInstallationLine(value, runningLine, identity);
export const installationRef = (value: Installation, identity?: { stored: string | null; clear: boolean }) => installationFields(value, runningRef, identity);
function selectedRelease(product: 'helmo', env: NodeJS.ProcessEnv): string | null { try { return selectedCoreRelease(product, dirname(dirname(fileURLToPath(import.meta.url))), env); } catch (error) { throw new InstallationError(`incoherent release set: ${product}: ${error instanceof Error ? error.message : String(error)}`); } }
