#!/usr/bin/env node
import { backup, backupObserved, identity, validate } from './recovery-lib.js';

function args(argv: string[]): Record<string, string> { const out: Record<string, string> = {}; for (let i = 0; i < argv.length; i += 2) { const key = argv[i]; const value = argv[i + 1]; if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`invalid argument near ${key ?? '<end>'}`); out[key.slice(2)] = value; } return out; }
try {
  const [command, ...rest] = process.argv.slice(2); const a = args(rest);
  const installation = a['installation']; const root = a['output-root']; const dir = a['output-dir'];
  const result = command === 'identity' ? (() => {
    if (!a['source-home'] || Object.keys(a).some(key => key !== 'source-home')) throw new Error('identity requires only --source-home');
    return { installation: identity(a['source-home']) };
  })() : (() => {
    if (!root || !dir) throw new Error('required: --output-root, --output-dir');
    if (command === 'backup-observed') {
      if (!a['source-home'] || installation) throw new Error('backup-observed requires --source-home and no --installation');
      return backupObserved(a['source-home'], root, dir);
    }
    if (!installation) throw new Error('backup and validate require --installation');
    return command === 'backup' ? backup(a['source-home'] ?? '', installation, root, dir) : command === 'validate' ? validate(a['backup'] ?? '', installation, root, dir) : (() => { throw new Error('command must be identity, backup-observed, backup or validate'); })();
  })();
  console.log(JSON.stringify(await result));
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
