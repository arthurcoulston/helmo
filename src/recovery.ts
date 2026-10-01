#!/usr/bin/env node
import { backup, validate } from './recovery-lib.js';

function args(argv: string[]): Record<string, string> { const out: Record<string, string> = {}; for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; const value = argv[i + 1]; if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid argument near ${key ?? '<end>'}`); out[key.slice(2)] = value; } return out; }
try {
  const [command, ...rest] = process.argv.slice(2); const a = args(rest); const installation = a['installation']; const root = a['output-root']; const dir = a['output-dir'];
  if (!installation || !root || !dir) throw new Error('required: --installation, --output-root, --output-dir');
  const result = command === 'backup' ? await backup(a['source-home'] ?? '', installation, root, dir) : command === 'validate' ? validate(a['backup'] ?? '', installation, root, dir) : (() => { throw new Error('command must be backup or validate'); })();
  console.log(JSON.stringify(result));
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
