#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRODUCT_ENV = /^(HELMO|ROADMAP|REV|INSTALLATION)_/;

export function testEnv(sourceEnv, { home } = {}) {
  if (!home) throw new Error('testEnv needs a scratch home: an unset REV_HOME resolves to the live ~/.rev installation');
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (PRODUCT_ENV.test(key)) delete env[key];
  }
  env.REV_HOME = home;
  return env;
}

/**
 * The same scrub, applied to a live environment rather than to a copy handed
 * to a child. A suite is launched by more doors than the root `npm test` —
 * one workspace's `npm test`, one file under `npx vitest run` — and the rule
 * belongs to the suite rather than to the door it came in by, so
 * `scripts/vitest-setup.mjs` runs this before any test file (H-2975).
 * Returns the scratch home, for the caller to remove when the suite is done.
 */
export function scrubInPlace(env = process.env, home = mkdtempSync(join(tmpdir(), 'helmo-test-home-'))) {
  const scrubbed = testEnv(env, { home });
  for (const key of Object.keys(env)) if (!(key in scrubbed)) delete env[key];
  Object.assign(env, scrubbed);
  return home;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const separator = process.argv.indexOf('--');
  const [command, ...args] = separator === -1 ? [] : process.argv.slice(separator + 1);
  if (!command) {
    console.error('usage: node scripts/test-env.mjs -- <command> [args...]');
    process.exit(2);
  }

  const home = mkdtempSync(join(tmpdir(), 'helmo-test-home-'));
  try {
    execFileSync(command, args, { env: testEnv(process.env, { home }), stdio: 'inherit' });
  } catch (error) {
    process.exitCode = typeof error.status === 'number' ? error.status : 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
