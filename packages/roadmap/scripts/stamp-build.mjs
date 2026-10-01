#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const record = {
  repo: root,
  commit: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']).length > 0,
  built_at: new Date().toISOString(),
  node: process.version,
};
writeFileSync(join(root, 'dist', 'BUILD.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(`helmo-roadmap: stamped dist as ${record.commit.slice(0, 7)}${record.dirty ? ' (dirty)' : ''}`);
