#!/usr/bin/env node
// `helmo` — one command in front of the whole product. It does no work of its
// own: it names a group, hands the rest of argv to the entry point that has
// always done that work, and lets that entry point own its output, its exit
// code and its refusals. Dispatch is an import rather than a child process so
// a caller sees the target's own streams and status, exactly as it would have
// seen them calling the old binary directly (the pattern runtime's gp-rev
// adapter already uses).
//
// Old binary names still work and say so on stderr; the windows are in
// COMPATIBILITY.md at the repository root.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `helmo.js` sits in packages/cli/bin, so every sibling package is two levels up.
const PACKAGES = new URL('../../', import.meta.url);
const RUNTIME_CLI = 'runtime/dist/cli.js';

// Each group names the entry point it fronts. `verb` is a runtime command the
// group stands for, so `helmo release status` reaches `rev release status`
// without the caller writing `run` twice. `products` groups are the surfaces
// that exist once per product rather than once per installation.
const GROUPS = {
  work: { entry: 'work/dist/cli.js', args: 'the work record: tickets, evidence, queues, releases' },
  roadmap: { entry: 'roadmap/dist/recovery.js', args: "the roadmap store's identity, backup and validate tools" },
  run: { entry: RUNTIME_CLI, commandName: 'helmo run', args: 'the runtime: loops, seats, status, redeploy, usage' },
  team: { entry: RUNTIME_CLI, verb: 'team', args: 'hold and release seats' },
  release: { entry: RUNTIME_CLI, verb: 'release', args: 'release selection: status, upgrade, rollback, activate' },
  service: { entry: RUNTIME_CLI, verb: 'service', args: "the supervisor's service definition" },
  serve: {
    products: { work: 'work/dist/view.js', roadmap: 'roadmap/dist/view.js', run: 'runtime/dist/view.js' },
    args: 'serve one dashboard in the foreground',
  },
  mcp: {
    products: { work: 'work/dist/server.js', roadmap: 'roadmap/dist/server.js' },
    args: 'run one MCP server over stdio',
  },
};

function version() {
  // One product, one version: the workspace root's, not this package's copy.
  const root = new URL('../../../package.json', import.meta.url);
  return JSON.parse(readFileSync(root, 'utf8')).version;
}

function usage() {
  const lines = [
    'usage: helmo <group> [...]   (run helmo <group> --help for its own syntax)',
    '',
    ...Object.entries(GROUPS).map(([name, group]) => {
      const takes = group.products ? `<${Object.keys(group.products).join('|')}>` : '<...>';
      return `  ${`${name} ${takes}`.padEnd(26)}${group.args}`;
    }),
    '',
    `Helmo ${version()} — one product, one version (VERSIONING.md).`,
    'The old names helmo-cli, helmo-mcp, helmo-view and roadmap-mcp still work and',
    'print their replacement on stderr; rev is a permanent alias for helmo run.',
    'The windows are in COMPATIBILITY.md.',
  ];
  console.log(lines.join('\n'));
}

function refuse(message) {
  // The front command speaks to a person on stderr: helmo-cli's contract is
  // that its stdout is one parseable JSON object, and a group that never ran
  // must not be the thing that breaks it.
  process.stderr.write(`helmo: ${message}\n`);
  process.exit(2);
}

async function dispatch(entry, argv, commandName) {
  const target = fileURLToPath(new URL(entry, PACKAGES));
  if (!existsSync(target)) {
    refuse(
      `${entry} is not built, so there is nothing to run. Build the workspace first: npm run prepare:cold && npm run build`,
    );
  }
  // The targets read process.argv.slice(2) at load, and runtime's re-execs
  // itself through argv[1]; both must see the entry point they would have seen
  // had the caller named it.
  process.argv = [process.argv[0], target, ...argv];
  if (commandName) process.env['REV_COMMAND_NAME'] = commandName;
  await import(pathToFileURL(target).href);
}

const [name, ...rest] = process.argv.slice(2);

if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
  usage();
  process.exit(0);
}
if (name === '--version' || name === '-v' || name === 'version') {
  console.log(version());
  process.exit(0);
}

const group = Object.hasOwn(GROUPS, name) ? GROUPS[name] : undefined;
if (!group) {
  refuse(`unknown group '${name}'. Groups: ${Object.keys(GROUPS).join(' ')}. Run helmo --help.`);
}

if (group.products) {
  const [product, ...productArgs] = rest;
  if (product === undefined) {
    refuse(`helmo ${name} needs a product: ${Object.keys(group.products).join(' or ')}.`);
  }
  const entry = Object.hasOwn(group.products, product) ? group.products[product] : undefined;
  if (!entry) {
    refuse(
      `helmo ${name} has no product '${product}'. It serves: ${Object.keys(group.products).join(', ')}.`,
    );
  }
  await dispatch(entry, productArgs);
} else if (group.verb) {
  await dispatch(group.entry, [group.verb, ...rest], 'helmo');
} else {
  await dispatch(group.entry, rest, group.commandName);
}
