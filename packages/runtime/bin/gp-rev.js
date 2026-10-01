#!/usr/bin/env node
// The Good Plumb operator command is deliberately a separate entrypoint: a
// caller cannot accidentally aim it at another Rev instance via its shell.
import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.REV_HOME = join(homedir(), '.rev-gp');
process.env.REV_COMMAND_NAME = 'gp-rev';
// The home is fixed, so the name must come from it. An inherited REV_LABEL —
// every session Rev spawns carries the supervisor's copy — would otherwise
// name the installation that started the session rather than the one this
// command operates, and H-2473 would refuse every mutation it was asked for.
delete process.env.REV_LABEL;
if (process.env.REV_TEST_SOURCE === '1') {
  await import('tsx/esm');
  await import('../src/cli.ts');
} else {
  await import('../dist/cli.js');
}
