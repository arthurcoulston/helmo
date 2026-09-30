#!/usr/bin/env node
// rev — run and control loops. Control verbs are sentinel writes; anything
// that reads state is safe from any context (the watch officer uses these).
import { existsSync, statSync } from 'node:fs';
import { loadRoster, resolveRef, stateDir } from './config.js';
import { sessionSpec } from './shim.js';
import { LoopConfig } from './types.js';
import { pollUsage, readCodexUsage, readUsage, refreshCodexUsage, usageLine, usagePath } from './usage.js';
import { selectRun } from './routing.js';
import { runLoop } from './loop.js';
import { serviceFile, serviceInstall, serviceStart, serviceStatusLine, serviceUninstall } from './service.js';
import { requireTarget, targetLine } from './install.js';
import { readRedeploy, requestRedeploy, watchRedeploy } from './redeploy.js';
import { logEvent, pidAlive, processObservation, sClear, sGet, sHas, sPendingPid, sSetOwned, sValue, streakReset } from './sentinels.js';
import { runFleet } from './supervisor.js';
import { teamResume, teamStop } from './team-control.js';

const [cmd, ...rest] = process.argv.slice(2);
// `--installation <name|home>` may follow any command: it asserts which
// installation the command is about, and a disagreement is a refusal rather
// than a redirect (H-2473, src/install.ts). Taken out of `rest` here so that
// no command's own positional arguments have to know it might be there.
const requestedInstall = takeInstallFlag(rest);

function takeInstallFlag(args: string[]): string | undefined {
  const i = args.indexOf('--installation');
  // A flag given last has no value; the refusal says so rather than guessing.
  return i === -1 ? undefined : args.splice(i, 2)[1] ?? '';
}

const commandName = process.env['REV_COMMAND_NAME']?.trim() || 'rev';
const rosterSource = commandName === 'rev' ? '~/.rev/roster.toml (REV_HOME to override)' : '~/.rev-gp/roster.toml (fixed by gp-rev)';

function cliActor(): { label: string; human: boolean } {
  for (const key of ['REV_ACTOR', 'HELMO_ACTOR']) {
    const raw = process.env[key];
    if (!raw) continue;
    try {
      const actor = JSON.parse(raw) as { name?: string; kind?: string };
      if (actor.kind === 'human') return { label: 'human', human: true };
      if (actor.name) return { label: actor.name, human: false };
    } catch { return { label: raw, human: false }; }
  }
  return { label: `cli:${process.pid}:${cmd ?? 'unknown'}`, human: false };
}

const COMMAND_HELP: Record<string, string> = {
  run: `usage: ${commandName} run [<loop> [--count N]]`,
  stop: `usage: ${commandName} stop [<loop>]`,
  resume: `usage: ${commandName} resume <loop>`,
  service: `usage: ${commandName} service <install|uninstall|start|status>`,
  redeploy: `usage: ${commandName} redeploy [--ticket <id>] [--reason "<why>"]`,
  pace: `usage: ${commandName} pace <loop> <fraction (0,1] | park | clear>`,
  usage: `usage: ${commandName} usage [--poll]`,
  routing: `usage: ${commandName} routing`,
  status: `usage: ${commandName} status`,
  tail: `usage: ${commandName} tail <loop>`,
  'session-spec': `usage: ${commandName} session-spec <seat> --session <actor stamp> [--provider claude] [--tier high] [--model M] [--cwd P] [--constitution P] [--version V]`,
  team: `usage: ${commandName} team <stop|resume> <loop|all>`,
};

if (cmd === '--help' || cmd === '-h') {
  console.log(`usage: ${commandName} <command>  (run ${commandName} <command> --help for command syntax)`);
  process.exit(0);
}
if (rest[0] === '--help' || rest[0] === '-h') {
  const usage = cmd ? COMMAND_HELP[cmd] : undefined;
  if (usage) {
    console.log(usage);
    process.exit(0);
  }
}

function loopArg(): string {
  const name = rest[0];
  if (!name) {
    console.error(`usage: ${commandName} ${cmd} <loop>`);
    process.exit(1);
  }
  return knownLoop(name);
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

const { global: g, loops, providers } = loadRoster();

function knownLoop(name: string): string {
  if (!loops[name]) {
    console.error(`Unknown loop '${name}'. Roster has: ${Object.keys(loops).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return name;
}

function state(name: string): string {
  const observation = processObservation(name);
  const pid = observation.pid;
  if (sHas(name, 'STOP')) return 'STOP';
  if (sHas(name, 'HOLD')) return 'HOLD';
  if (sHas(name, 'BLOCKED')) return 'BLOCKED';
  // Above LIMIT/IDLE/RUNNING: a wedged loop looks busy from the outside
  // (its process is alive, polling) while drawing no work at all (H-448).
  if (sHas(name, 'WEDGED')) return 'WEDGED';
  if (observation.state === 'unknown') return 'UNKNOWN';
  if (!pid && sHas(name, 'BACKOFF')) return 'BACKOFF';
  if (pid && sHas(name, 'LIMIT')) return 'LIMIT';
  if (pid && sHas(name, 'PARKED')) return 'PARKED';
  if (pid && sHas(name, 'SEAT_HELD')) return 'SEAT_HELD';
  if (pid && sHas(name, 'IDLE')) return 'IDLE';
  if (pid) return 'RUNNING';
  if (sHas(name, 'RUNNING')) return 'CRASHED';
  return 'halted';
}

switch (cmd) {
  case 'team': {
    if (commandName !== 'gp-rev' || process.env['REV_LOOP'] !== 'prime') {
      console.error('team control is available only to Prime through gp-rev.');
      process.exit(1);
    }
    const verb = rest[0];
    const target = rest[1];
    if (!['stop', 'resume'].includes(verb ?? '') || !target) {
      console.error(COMMAND_HELP.team);
      process.exit(1);
    }
    const names = target === 'all' ? Object.keys(loops) : [knownLoop(target)];
    console.log(targetLine(requireTarget(`${commandName} team ${verb}`, requestedInstall)));
    if (verb === 'stop') {
      const result = teamStop(names);
      for (const name of result.stopped) logEvent(name, 'prime-stop', 'provenance=prime');
      if (result.refused.length) {
        console.error(`Refused (foreign STOP remains): ${result.refused.join(', ')}`);
        process.exitCode = 1;
      }
      if (result.stopped.length) console.log(`Prime STOP set for: ${result.stopped.join(', ')}`);
    } else {
      const result = teamResume(names);
      for (const name of result.resumed) logEvent(name, 'prime-resume', 'own STOP cleared');
      if (result.refused.length) {
        console.error(`Refused (not Prime-owned STOP, or HOLD/BLOCKED remains): ${result.refused.join(', ')}`);
        process.exitCode = 1;
      }
      if (result.resumed.length) console.log(`Prime STOP cleared for: ${result.resumed.join(', ')}`);
    }
    break;
  }
  case 'run': {
    const name = rest[0];
    if (!name) {
      // The general start (the operator starts the machine, not a named
      // worker): supervise every roster loop.
      console.log(targetLine(requireTarget('start the machine', requestedInstall)));
      const code = await runFleet(g, loops);
      if (code) process.exit(code);
      break;
    }
    const l = loops[knownLoop(name)]!;
    console.log(targetLine(requireTarget(`run '${name}'`, requestedInstall)));
    const count = flag('count') ? Number(flag('count')) : undefined;
    await runLoop(g, l, { count });
    break;
  }
  // Activating a fix the crew has already committed and tested is the crew's
  // call, not the operator's (Arthur, H-1046). The ask is deferred on purpose:
  // the supervisor drains at its next poll, so the session that shipped the fix
  // finishes its close-out instead of being restarted out from under itself.
  case 'redeploy': {
    console.log(targetLine(requireTarget('request a redeploy', requestedInstall)));
    const sup = pidAlive('supervisor');
    if (!sup) {
      console.error(`No supervisor running — nothing to redeploy. The next \`${commandName} run\` starts on the current build anyway.`);
      process.exit(1);
    }
    const pending = readRedeploy();
    if (pending) {
      console.log(`A redeploy is already pending (asked by ${pending.by} at ${pending.requested_at}) — the supervisor drains within ${g.poll_seconds}s. Yours would be the same restart.`);
      break;
    }
    requestRedeploy({
      by: flag('by') ?? process.env['REV_LOOP'] ?? cliActor().label,
      reason: flag('reason') ?? 'activate committed changes',
      ticket: flag('ticket'),
      requested_at: new Date().toISOString(),
    });
    console.log(
      `Redeploy requested. The supervisor (pid ${sup}) drains within ${g.poll_seconds}s — in-flight iterations finish their close-out — then exits for the service manager to start the new code.`,
    );
    if (!existsSync(serviceFile().file)) {
      console.log(
        `WARNING: no service is installed (${serviceFile().file}), so nothing will start the supervisor again: the fleet will drain and STAY DOWN until someone runs \`${commandName} run\`. Rev will file that as an outage if it happens.`,
      );
    }
    break;
  }
  // Armed by a redeploying supervisor just before it exits, so that something
  // outlives the fleet to say if it never comes back (H-1046).
  case 'redeploy-watch': {
    const deadline = flag('deadline') ? Number(flag('deadline')) : g.redeploy_deadline_seconds;
    const ok = await watchRedeploy(g, deadline);
    if (!ok) process.exit(1);
    break;
  }
  case 'status': {
    console.log(targetLine());
    const supervisor = processObservation('supervisor');
    const sup = supervisor.pid;
    console.log(`supervisor: ${supervisor.state === 'unknown' ? `unobservable (recorded pid ${sup}; process inspection unavailable)` : sup ? `running (pid ${sup})` : `down — start the machine with: ${commandName} run`}`);
    console.log(usageLine(readUsage(), 'Claude'));
    console.log(`${usageLine(readCodexUsage(), 'Codex')}\n`);
    console.log('LOOP                     STATE      PID     PACE   WORKSTREAM');
    for (const name of Object.keys(loops)) {
      const pid = pidAlive(name) ?? '-';
      const pending = sPendingPid(name);
      const pace = pending ? `pending:${pending}` : (sValue(name, 'PACE') ?? '1');
      console.log(`${name.padEnd(24)} ${state(name).padEnd(10)} ${String(pid).padEnd(7)} ${pace.padEnd(6)} ${loops[name].workstream}`);
    }
    console.log('\nSTATE: RUNNING=iteration in flight  IDLE=waiting on wake cursor  PARKED=held via PACE');
    console.log('       SEAT_HELD=standing down for another live session in this seat');
    console.log('       WEDGED=alive but cannot reach Helm — drawing no work; see the loop trace');
    console.log('       LIMIT=waiting out a transient condition  BLOCKED=needs a human (see Helm queue)');
    console.log('       BACKOFF=crashed, supervisor retrying  STOP/HOLD=deliberate halts');
    console.log('       UNKNOWN=process inspection unavailable; marker remains occupied, so no duplicate starts');
    console.log('       CRASHED=process gone, marker stale  halted=not started');
    break;
  }
  case 'stop': {
    const name = rest[0];
    if (!name) {
      // Graceful stop-all: drain the supervisor. In-flight iterations finish
      // their close-out; no STOP sentinels are written, so the next `rev run`
      // starts the whole machine again.
      const sup = pidAlive('supervisor');
      if (!sup) {
        console.error(`No supervisor running. Stop a single loop with: ${commandName} stop <loop>`);
        process.exit(1);
      }
      console.log(targetLine(requireTarget('drain the machine', requestedInstall)));
      process.kill(sup, 'SIGTERM');
      console.log(`Drain requested (SIGTERM to supervisor pid ${sup}) — in-flight iterations finish, then the machine stops. Watch: ${commandName} status`);
      break;
    }
    knownLoop(name);
    console.log(targetLine(requireTarget(`stop '${name}'`, requestedInstall)));
    const actor = cliActor();
    sSetOwned(name, 'STOP', { value: '', by: actor.human ? 'human' : actor.label, at: new Date().toISOString(), pid: process.pid, reason: `${commandName} stop`, expires_at: 'never' });
    logEvent(name, actor.label, 'STOP set');
    const sup = pidAlive('supervisor');
    console.log(
      `STOP set for '${name}' — halts cleanly after any in-flight iteration.` +
        (sup ? ` The supervisor leaves it down until: ${commandName} resume ${name}` : ` Resume: ${commandName} resume ${name} (then ${commandName} run ${name}).`),
    );
    break;
  }
  case 'resume': {
    const name = loopArg();
    console.log(targetLine(requireTarget(`resume '${name}'`, requestedInstall)));
    sClear(name, 'STOP', 'HOLD', 'BLOCKED');
    // A resume is a statement the cause was looked at: the loop gets its full
    // retry budget back. Carrying the streak over made resume a single retry
    // that re-blocked in seconds and filed a duplicate escalation (H-401).
    streakReset(name, 'fail', 'limit');
    logEvent(name, cliActor().label, 'STOP/HOLD/BLOCKED cleared; fail/limit streaks reset');
    const sup = pidAlive('supervisor');
    console.log(
      `Halt sentinels cleared for '${name}'.` +
        (sup ? ` The supervisor picks it back up within ${g.poll_seconds}s.` : ` Start it with: ${commandName} run ${name}`),
    );
    break;
  }
  case 'service': {
    const verb = rest[0];
    // A refusal here is the ordinary answer, not a crash: it is how one
    // installation declines to operate another's service (H-2452). Print what
    // it said and the way out, without a stack trace over the top of it.
    const refusable = (act: () => void) => {
      try {
        act();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    };
    if (verb === 'status') {
      console.log(targetLine());
      console.log(serviceStatusLine());
      break;
    }
    const act = { install: serviceInstall, uninstall: serviceUninstall, start: serviceStart }[verb ?? ''];
    if (!act) {
      console.error(`usage: ${commandName} service <install|uninstall|start|status>  (stop the machine with: ${commandName} stop)`);
      process.exit(1);
    }
    console.log(targetLine(requireTarget(`${commandName} service ${verb}`, requestedInstall)));
    refusable(act);
    break;
  }
  case 'pace': {
    const name = loopArg();
    const v = rest[1];
    if (!v) {
      console.error(`usage: ${commandName} pace <loop> <fraction (0,1] | park | clear>`);
      process.exit(1);
    }
    console.log(targetLine(requireTarget(`set the pace of '${name}'`, requestedInstall)));
    const actor = cliActor();
    if (v === 'clear') sClear(name, 'PACE');
    else sSetOwned(name, 'PACE', { value: v, by: actor.human ? 'human' : actor.label, at: new Date().toISOString(), pid: process.pid, reason: `${commandName} pace`, expires_at: actor.human ? 'never' : new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    logEvent(name, actor.label, `PACE=${v}`);
    console.log(`PACE ${v === 'clear' ? 'cleared' : `set to ${v}`} for '${name}' (picked up within one poll).`);
    break;
  }
  case 'usage': {
    // Claude bars are polled (H-278; --poll forces a fresh read); codex bars
    // are written by each codex run from its own rollout, so they are as fresh
    // as the last iteration and need no credential.
    console.log(targetLine());
    const snap = rest.includes('--poll') ? await pollUsage() : readUsage();
    if (rest.includes('--poll')) refreshCodexUsage();
    for (const [label, s] of [['Claude', snap], ['Codex', readCodexUsage()]] as const) {
      console.log(usageLine(s, label));
      if (s?.limits.length) {
        for (const l of s.limits) {
          console.log(`  ${l.label.padEnd(26)} ${String(l.percent).padStart(3)}%  ${l.severity.padEnd(8)} ${l.active ? 'active' : ''}  resets ${l.resets_at ?? '-'}`);
        }
      }
      if (s?.stale) console.log(`  STALE — last read failed (${s.error ?? 'no reason recorded'}); these are the last good numbers.`);
    }
    if (!snap) console.log(`  Nothing at ${usagePath()} yet. The supervisor polls every 10 min; '${commandName} usage --poll' reads now.`);
    break;
  }
  case 'routing': {
    const usage = { claude: readUsage(), codex: readCodexUsage() };
    console.log(targetLine());
    console.log('Working-model preview from current usage; does not start or resume a loop.');
    for (const loop of Object.values(loops)) {
      const selected = selectRun(loop, usage, 1, g.limit_exhausted_percent);
      console.log(`${loop.name}: ${selected.choice.provider}/${selected.choice.model} (${loop.routing ?? 'rotation'})`);
      if (selected.switched) console.log(`  ${selected.switched}`);
    }
    break;
  }
  case 'tail': {
    const name = loopArg();
    console.log(`${stateDir(name)}/events.log`);
    break;
  }
  // The composed session as JSON, for a consumer that runs a seat's session
  // without being a loop — the Meetings room, where Arthur types instead of
  // the queue (H-1152). Read-only: it prints what a run WOULD carry and
  // touches no state. A seat with no roster loop is composable by supplying
  // the two facts only the caller knows, so Rev never learns crew paths.
  case 'session-spec': {
    const name = rest[0];
    if (!name || name.startsWith('--')) {
      console.error(COMMAND_HELP['session-spec']);
      process.exit(1);
    }
    // The seat stamp is required, never defaulted. Everyone asking for a spec
    // is by definition NOT the loop — the loop calls runSession directly — and
    // a consumer that silently signed as `rev:<seat>` would make its Helm
    // writes read as the loop's own seat hold (H-558). Ward's H-1151 condition:
    // a meeting signs `meeting:<thread id>`.
    const session = flag('session');
    if (!session) {
      console.error(
        'session-spec needs --session: the Helm actor stamp this consumer writes under, e.g. --session meeting:<thread id>. ' +
        "Pass --session rev:<seat> only if you ARE that seat's loop.",
      );
      process.exit(1);
    }
    const base = loops[name];
    const cwd = flag('cwd') ?? base?.cwd;
    const constitution = flag('constitution') ?? base?.constitution;
    if (!cwd || !constitution) {
      console.error(
        `'${name}' is not a roster loop (roster has: ${Object.keys(loops).join(', ') || 'none'}) — a seat with no loop needs --cwd and --constitution.`,
      );
      process.exit(1);
    }
    // Same fail-closed rule runSession applies: never describe a session that
    // would start half-instructed.
    if (!existsSync(constitution) || statSync(constitution).size === 0) {
      console.error(`constitution missing or empty: ${constitution}`);
      process.exit(1);
    }
    // A meeting asks for a tier, not the loop's own choice: mason's loop runs
    // codex/frontier, and the room wants claude/high (H-1152).
    const tier = flag('tier');
    const provider = flag('provider') ?? 'claude';
    let runtime = base?.runtime ?? 'claude';
    let model = flag('model') ?? base?.model;
    if (tier) {
      const choice = resolveRef(`${provider}:${tier}`, providers, {}, 'rev session-spec');
      runtime = choice.runtime;
      if (!flag('model')) model = choice.model;
    }
    if (!model) {
      console.error(`'${name}' has no roster model — name one with --model, or a --tier to resolve from [providers.${provider}.models].`);
      process.exit(1);
    }
    const l: LoopConfig = {
      ...(base ?? { name, workstream: '', pace: 1, idle_floor_s: 0, choices: [], fallbacks: [] }),
      name,
      cwd,
      constitution,
      runtime,
      model,
      version: flag('version') ?? base?.version ?? '0.1',
    } as LoopConfig;
    console.log(JSON.stringify(sessionSpec(g, l, { model, session, in_roster: Boolean(base) }), null, 2));
    break;
  }
  default:
    console.error(`usage: ${commandName} <command>
  run                      start the machine: supervise every roster loop (respawn, backoff, drain)
  run <loop> [--count N]   drive one loop in the foreground (debugging; --count 1 = assess early)
  stop                     graceful stop-all: drain the supervisor, iterations finish first
  stop <loop>              set STOP — clean halt after the in-flight iteration
  resume <loop>            clear STOP/HOLD/BLOCKED; a running supervisor picks the loop back up
  pace <loop> <v>          velocity: fraction (0,1], 'park', or 'clear'
  usage [--poll]           Max plan usage bars (session, weekly, per-model)
  routing                  preview working-model choices from current usage (no runs)
  status                   supervisor + every loop's state at a glance
  session-spec <seat>      the composed session as JSON (model, cwd, skills, MCP, env) — reads nothing else
  service <verb>           install|uninstall|start|status — survive reboots (launchd/systemd)
  redeploy [--ticket <id>] [--reason "<why>"]
                           activate a committed fix: drain after in-flight iterations, come back on the new code
  tail <loop>              print the path of the loop's event trace
Any command also takes --installation <name|home>: it asserts which installation the command is
about, and a mutation refuses rather than redirects if that disagrees with the environment.
${targetLine()}
Roster: ${Object.keys(loops).join(', ') || '(none)'} — from ${rosterSource}.`);
    process.exit(cmd ? 1 : 0);
}
