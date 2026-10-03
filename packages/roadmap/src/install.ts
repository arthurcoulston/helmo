import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatInstallationLine, InstallationError, namesResolvedInstallation, requestedInstallation, requireResolvedInstallation, resolveInstallation, type Installation, type InstallationConfig } from '@helmo/core';
import { selectedRelease as selectedCoreRelease } from '@helmo/core/release';
import { runningLine } from './build.js';
const config: InstallationConfig = { homeKey: 'ROADMAP_HOME', dbKey: 'ROADMAP_DB', defaultHome: '.helmo-roadmap', defaultDb: 'roadmap.db', derivedPrefix: 'dev.roadmap', homePattern: /^\.helmo-roadmap([-_.]|$)/, stripPattern: /^\.?(helmo-roadmap|roadmap)(?=[-_.]|$)/, release: (env) => selectedRelease('helmo-roadmap', env), bindingProduct: 'roadmap' };
export { InstallationError, requestedInstallation }; export type { Installation };
export const installation = (env: NodeJS.ProcessEnv = process.env) => resolveInstallation(config, env);
export const requireInstallation = (env: NodeJS.ProcessEnv = process.env, report?: (message: string) => never, requested?: string) => requireResolvedInstallation(config, env, report, requested);
export const namesInstallation = (value: Installation, want: string) => namesResolvedInstallation(config, value, want);
export const installationLine = (value: Installation, identity?: { stored: string | null; clear: boolean }) => formatInstallationLine(value, runningLine, identity);
function selectedRelease(product: 'helmo-roadmap', env: NodeJS.ProcessEnv): string | null { try { return selectedCoreRelease(product, dirname(dirname(fileURLToPath(import.meta.url))), env); } catch (error) { throw new InstallationError(`incoherent release set: ${product}: ${error instanceof Error ? error.message : String(error)}`); } }
