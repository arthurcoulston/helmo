/* The shell's only source is upstream shadcn/ui. This script is the whole
   relationship with it: it generates the pinned version and preset with the
   official CLI, into a throwaway directory, and then either compares our files
   with what came out (check) or replaces them with it (refresh).
 
   Nothing is hand-copied and no baseline is kept in the repository, so the
   comparison baseline is always the official output rather than a snapshot of
   it that could quietly age. `upstream.json` records the pin, the inventory,
   the commands and a sha256 per generated file; the manifest is what the
   offline test checks, and only a successful refresh rewrites it. */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pinPath = join(root, 'upstream.json');
const pin = JSON.parse(readFileSync(pinPath, 'utf8'));

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => { try { return readFileSync(path); } catch { return null; } };

/** Every file the official tool wrote that we keep. Directories are listed
 *  from what upstream generated, not from what we hold, so a component added
 *  to the inventory appears here without editing this list — and a file we
 *  hold that upstream no longer writes shows up as unpinned in the test. */
function generatedFiles(from) {
  const files = [...pin.files.exact];
  for (const dir of pin.files.directories) {
    let entries;
    try { entries = readdirSync(join(from, dir)); } catch { continue; }
    for (const entry of entries.sort()) {
      if (statSync(join(from, dir, entry)).isFile()) files.push(`${dir}/${entry}`);
    }
  }
  return files;
}

function generate(cli) {
  const work = mkdtempSync(join(tmpdir(), 'helmo-shell-upstream-'));
  const project = join(work, 'app');
  const run = (args, cwd) => {
    const result = spawnSync('npx', ['--yes', `shadcn@${cli}`, ...args], { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`shadcn ${args[0]} exited ${result.status}`);
  };
  run(['init', '--template', pin.template, '--base', pin.base, '--preset', pin.preset, '-y', '--no-monorepo', '-n', 'app'], work);
  run(['add', ...pin.components, '-y', '-o'], project);
  const resolve = spawnSync('npx', ['--yes', `shadcn@${cli}`, 'preset', 'resolve', '--json'], { cwd: project, encoding: 'utf8' });
  if (resolve.status !== 0) throw new Error(`shadcn preset resolve exited ${resolve.status}: ${resolve.stderr}`);
  return { work, project, resolved: JSON.parse(resolve.stdout) };
}

/* The preset is an opaque code, so the generated files alone cannot say which
   one produced them. This asks the CLI, inside the project it just generated,
   and holds it to the code Arthur chose resolving exactly — a fallback means
   the registry answered with something adjacent instead. */
function presetDrift(resolved) {
  const drift = [];
  if (resolved.code !== pin.preset) drift.push(`preset resolves as ${resolved.code}, not the requested ${pin.preset}`);
  if (resolved.fallbacks?.length) drift.push(`preset needed fallbacks: ${resolved.fallbacks.join(', ')}`);
  for (const [key, want] of Object.entries(pin.resolved.values)) {
    if (resolved.values?.[key] !== want) drift.push(`${key} resolves as ${resolved.values?.[key]}, pinned as ${want}`);
  }
  return drift;
}

const mode = process.argv[2];
const cli = process.argv.includes('--cli') ? process.argv[process.argv.indexOf('--cli') + 1] : pin.cli;
if (!['check', 'refresh'].includes(mode)) {
  console.error('usage: node scripts/upstream.mjs check|refresh [--cli <version>]');
  process.exit(2);
}
if (cli !== pin.cli && mode === 'check') console.log(`Comparing against shadcn@${cli}, not the pinned ${pin.cli}.`);

const { work, project, resolved } = generate(cli);
try {
  const files = generatedFiles(project);
  if (mode === 'refresh') {
    const wrong = presetDrift(resolved);
    if (wrong.length) throw new Error(`refusing to refresh: ${wrong.join('; ')}`);
    for (const file of files) cpSync(join(project, file), join(root, file));
    pin.cli = cli;
    pin.files.manifest = Object.fromEntries(files.map((file) => [file, sha(readFileSync(join(root, file)))]));
    pin.refreshed = new Date().toISOString().slice(0, 10);
    writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`Refreshed ${files.length} files from shadcn@${cli} and rewrote upstream.json.`);
    process.exit(0);
  }

  const drift = presetDrift(resolved);
  for (const file of files) {
    const want = readFileSync(join(project, file));
    const have = read(join(root, file));
    if (have === null) drift.push(`${file}: missing here`);
    else if (!have.equals(want)) drift.push(`${file}: differs from upstream`);
    else if (pin.files.manifest[file] !== sha(have)) drift.push(`${file}: manifest sha is stale`);
  }
  for (const file of Object.keys(pin.files.manifest)) {
    if (!files.includes(file)) drift.push(`${file}: pinned but upstream no longer generates it`);
  }
  if (drift.length) {
    console.error(`shadcn@${cli} ${pin.style}: ${drift.length} difference(s) from the official output.`);
    for (const line of drift) console.error(`  ${line}`);
    console.error(`Run npm run upstream:refresh --workspace @helmo/shell to take upstream's version.`);
    process.exit(1);
  }
  console.log(`shadcn@${cli} ${pin.style} (preset ${resolved.code}, no fallbacks): all ${files.length} generated files are byte-identical to the official output.`);
  console.log(`Local application code, untouched by a refresh: ${pin.files.local.join(', ')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
