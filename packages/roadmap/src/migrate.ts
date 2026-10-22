#!/usr/bin/env node
// One-shot store migrations. `r46` is the vocabulary rename (the seven
// statuses, readiness and the hide flag): it prints a per-row report with
// each row's reason, and writes nothing unless --apply is passed.
//
//   roadmap-migrate r46                    # the plan, nothing written
//   roadmap-migrate r46 --apply            # write it, then print what was written
//   roadmap-migrate r46 --judgments <path> # what became of each archived row
//
// Every stored word maps by rule except `archived`, which says a row was put
// away and not whether it was finished or dropped. Only this installation's
// own record can say which, so those judgments come from a file the operator
// writes — `{"R-4": {"status": "Canceled", "reason": "..."}}` — and a row
// with none supplied is reported and left alone. Nothing is judged by id.
//
// The actor comes from ROADMAP_ACTOR (or HELMO_ACTOR), as it does for the
// MCP server: a write this broad still records who made it.
import { readFileSync } from 'node:fs';
import { installationLine, requireInstallation, requestedInstallation } from './install.js';
import { formatR46Plan, parseR46Judgments, R46Judgments } from './migrate-lib.js';
import { Store } from './store.js';
import { Actor, RoadmapError } from './types.js';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = argv.slice(1);

try {
  if (command !== 'r46') throw new RoadmapError('usage: roadmap-migrate r46 [--apply] [--judgments <path>]');
  const apply = flags.includes('--apply');
  const known = (flag: string) =>
    flag === '--apply' || flag === '--installation' || flag.startsWith('--installation=') ||
    flag === '--judgments' || flag.startsWith('--judgments=');
  const unknown = flags.filter((flag) => flag.startsWith('--') && !known(flag));
  if (unknown.length) throw new RoadmapError(`unknown flag ${unknown[0]} — r46 takes --apply, --judgments and --installation`);

  // A bare --judgments is a missing path, not an empty one: silently planning
  // with no judgments would report every archived row as awaiting a call the
  // operator believes they just supplied.
  const shelved: R46Judgments = ((): R46Judgments => {
    const inline = flags.find((f) => f.startsWith('--judgments='));
    const path = inline ? inline.slice('--judgments='.length) : flags[flags.indexOf('--judgments') + 1];
    if (!flags.some((f) => f === '--judgments' || f.startsWith('--judgments='))) return {};
    if (!path || path.startsWith('--')) throw new RoadmapError('--judgments needs the path to a JSON file of per-row judgments');
    try {
      return parseR46Judgments(JSON.parse(readFileSync(path, 'utf8')));
    } catch (e) {
      throw new RoadmapError(`--judgments ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  const install = requireInstallation(process.env, undefined, requestedInstallation(flags));
  const store = new Store(install.db, install);
  const envJson = process.env['ROADMAP_ACTOR'] ?? process.env['HELMO_ACTOR'];
  const actor = (envJson ? (JSON.parse(envJson) as Actor) : null) ?? ({} as Actor);
  console.error(installationLine(install, store.installationIdentity()));
  console.log(formatR46Plan(store.migrateR46(actor, { apply, shelved })));
  store.close();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
