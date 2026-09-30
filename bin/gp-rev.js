#!/usr/bin/env node
// The Good Plumb operator command is deliberately a separate entrypoint: a
// caller cannot accidentally aim it at another Rev instance via its shell.
import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.REV_HOME = join(homedir(), '.rev-gp');
process.env.REV_COMMAND_NAME = 'gp-rev';
if (process.env.REV_TEST_SOURCE === '1') {
  await import('tsx/esm');
  await import('../src/cli.ts');
} else {
  await import('../dist/cli.js');
}
