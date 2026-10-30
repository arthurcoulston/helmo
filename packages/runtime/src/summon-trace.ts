/** Which host records are NAMED SUMMONS, and on what basis (R-55 H-3724
 *  requirement 6: "Verify capture/association for a new named summon").
 *
 *  Every other trace in this runtime joins a host record to a launch THIS
 *  installation made: the launch journal's `provider_session_id` is the key,
 *  and without it there is no reading. A summon has no launch — the operator
 *  opens the session himself and the estate is never told — so the join had to
 *  come from somewhere else or the capability would exclude every sitting he
 *  has with a crew member.
 *
 *  It comes from the record. A summon's opening words are the operator's own
 *  ("summon mason"), and the summoned role reproduces its profile's canary in
 *  what it says back. Those are two different claims about two different
 *  moments and this module keeps them apart: one is what the operator
 *  SUPPLIED, the other is what the session CONFIRMED. So a summon needs to
 *  record nothing new, and costs the operator nothing at the moment he starts
 *  one — which is the point, because `skills/summon.md` deliberately keeps
 *  that moment free of tool calls.
 *
 *  Three things this refuses to do, each measured on the 14,135 records of the
 *  machine it was built against rather than supposed:
 *
 *  - A canary is not a summon. 86 LOOP records reproduce one, because a seat
 *    may quote its own profile while working. The launch journal is checked
 *    first and authoritatively: a session the estate launched is a launched
 *    run whatever its text says.
 *  - A role named in the opener with no canary is still a summon. 6 of 165 had
 *    no canary in anything the session said — a protocol that was not
 *    performed, reported as `protocol: absent` rather than demoted to "not a
 *    summon".
 *  - One sitting is not one record. 165 opener matches came from 142 distinct
 *    sittings: resuming a session copies its transcript, so counting records
 *    overstates summons by 23. Records sharing an opener are one association.
 *
 *  And the ceiling, stated on every scan: a summon through the crew-summon MCP
 *  (phone, web) runs on the provider's side and writes nothing on this
 *  machine. No local record holds a crew-summon tool call. Away from the desk,
 *  the estate cannot say a summon happened at all — not a partial trace, an
 *  absent one. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopConfig } from './types.js';
import { claudeHome, claudeProjectSlug } from './context-coverage.js';
import { visibleControls } from './context-trace.js';
import { journalEntries } from './launch-journal.js';
import { readBounded } from './team.js';

/** The first words of every iteration prompt this supervisor composes.
 *  `loop.ts` builds its prompt from THIS constant, so the discriminator below
 *  and the prompt itself cannot drift apart.
 *
 *  It is needed because the launch journal only knows launches it recorded:
 *  journalling came later than the fleet, and the records of every earlier
 *  iteration carry no entry to join to. Without this guard those read as
 *  sessions the estate never launched, and the 86 of them that quote their own
 *  profile would be reported as summons. */
export const ITERATION_PROMPT_OPENING = 'This is a Rev loop iteration, not a summon;';

/** What an iteration prompt opened with BEFORE the clause above was added. A
 *  record is not rewritten when a prompt is, so a reader of the host store has
 *  to know the older spelling or re-misread six weeks of it. */
export const ITERATION_PROMPT_OPENING_LEGACY = /^Loop iteration \d+ for agent '/;

/** A record's opening words are read from its head, not from the whole file: a
 *  loop transcript runs to tens of megabytes and the first user entry is in
 *  its first few lines. Large enough for the loop prompt and its reminders. */
export const OPENER_BYTE_CEILING = 262_144;

/** The whole of a candidate record is read to find a reproduced canary, and a
 *  candidate is rare — but a record can be 30MB, so the ceiling the trace
 *  reader uses applies here too. A record over it reports `protocol: unknown`
 *  rather than `absent`: not finding a canary in part of a file is not
 *  evidence it is not in the rest. */
export const CANARY_BYTE_CEILING = 33_554_432;

/** The roles this installation can recognise by name, and the canary sentence
 *  each one's profile ends with. The roster is the source: a name is a role
 *  because a seat is configured with a constitution, never because it looks
 *  like one. A role with no seat here — one retired, or one that only ever
 *  ran elsewhere — cannot be recognised, and the scan says so. */
export interface SummonRole {
  role: string;
  /** The canary sentence, or null with the reason it could not be read. */
  canary: string | null;
  why: string;
}

/** `summon` is reserved for what the operator asked for in his own words.
 *
 *  `spoke_as_role` is the weaker reading and it earned its own name by being
 *  run: of 37 such sittings here, some are summons he phrased without a role
 *  name ("Arthur summons you into a meeting") and others are probe sessions
 *  something else launched under a seat's own cwd, which arrive with that
 *  seat's profile and reproduce its canary while being nobody's summon. One
 *  observable cannot tell those apart, so it does not claim to. */
export type SummonState = 'summon' | 'spoke_as_role' | 'launched_run';
export type RoleBasis = 'named_by_operator' | 'canary_reproduced';

export interface SummonAssociation {
  /** Every record of this one sitting, newest last. A resume copies the
   *  transcript, so a sitting is not a record. */
  records: string[];
  session_ids: string[];
  cwd: string | null;
  opened_at: string | null;
  state: SummonState;
  role: string | null;
  role_basis: RoleBasis;
  /** Whether the summoned role reproduced its own canary in something it SAID.
   *  `unknown` only where the record was too large to read whole. */
  protocol: 'performed' | 'absent' | 'unknown';
  /** The operator's own opening words, bounded. */
  opener: string | null;
  why: string;
}

export interface SummonScan {
  roster: SummonRole[];
  /** Summonable roles this installation cannot recognise by name: a profile
   *  sits beside the roster's own constitutions and no seat here is
   *  configured with it. A summon of one of these is invisible to the name
   *  check, and a blind spot that is named is not the same as one that is not.
   */
  roles_without_seat: { role: string; profile: string }[];
  roots: string[];
  since: string | null;
  scanned: number;
  /** Sittings the window excluded, and undated ones a window cannot place. */
  excluded_by_window: number;
  launched_runs: number;
  /** Of the launched runs, those identified by the iteration prompt in the
   *  record rather than by a journal entry — the ones that ran before the
   *  journal did. */
  launched_by_prompt: number;
  other_sessions: number;
  unreadable: { path: string; why: string }[];
  associations: SummonAssociation[];
  ceilings: string[];
}

/** The canary is the last non-empty line of a profile, and it names its own
 *  role. A seat whose canary names a DIFFERENT role is reported rather than
 *  trusted: the name in the sentence is what a record will carry, so a
 *  mismatch would attribute one role's sitting to another. */
export function summonRoster(loops: Record<string, LoopConfig>): SummonRole[] {
  const roster: SummonRole[] = [];
  for (const [role, loop] of Object.entries(loops).sort(([a], [b]) => a.localeCompare(b))) {
    const path = loop.constitution;
    if (!existsSync(path)) {
      roster.push({ role, canary: null, why: `The roster names ${path} as ${role}'s constitution and it is not there, so this role can only be recognised by the operator's own words.` });
      continue;
    }
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch (e) {
      roster.push({ role, canary: null, why: `${path} could not be read (${String(e)}), so ${role} can only be recognised by the operator's own words.` });
      continue;
    }
    const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    const m = /PROFILE\.md \(([a-z0-9-]+)\)/.exec(last);
    if (!m) {
      roster.push({ role, canary: null, why: `${path} does not end in a canary line naming its role, so a session that reproduced it could not be matched to ${role}.` });
      continue;
    }
    if (m[1] !== role) {
      roster.push({ role, canary: null, why: `${path}'s canary names "${m[1]}" and the roster calls this seat "${role}"; the canary is not used while the two disagree, because a record carries the name in the sentence.` });
      continue;
    }
    roster.push({ role, canary: last, why: `the last line of ${path}` });
  }
  return roster;
}

/** Session ids this installation launched, with the launch that did it. Read
 *  from the journal rather than inferred from a prompt: a loop prompt is text
 *  in a record and could be anything, while the journal is this
 *  installation's own act. */
export function launchedSessions(loops: string[]): Map<string, { loop: string; launch_id: string }> {
  const out = new Map<string, { loop: string; launch_id: string }>();
  for (const loop of loops) {
    let entries;
    try { entries = journalEntries(loop); } catch { continue; }
    for (const entry of entries) {
      const id = entry.session?.provider_session_id;
      if (id && entry.session?.provider_session_id_state === 'observed') out.set(id, { loop, launch_id: entry.launch_id });
    }
  }
  return out;
}

/** Bounded, and through the reader that refuses anything but a regular file:
 *  the host store is the host's, and a path in it is not this process's to
 *  trust (H-3004). A truncated read is reported as truncated — never as a
 *  complete reading of a shorter file. */
function readUpTo(path: string, bytes: number): { text: string; truncated: boolean } | { why: string } {
  const read = readBounded(path, bytes);
  if (!read.ok) return { why: `${path} could not be read: ${read.error}` };
  return { text: read.text, truncated: read.truncated };
}

interface Opener { text: string; at: string | null; cwd: string | null }

/** The first thing the operator said, from the head of a record. */
export function firstUserText(head: string): Opener | null {
  for (const line of head.split('\n')) {
    // The prefilter is on the VALUE alone, not on `"type":"user"`: the host
    // writes compact JSON today, and keying on that spelling made a record
    // written with a space after the colon report no opener at all — a silent
    // miss, not a refusal. The parsed entry's own type is what decides.
    if (!line.includes('"user"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry['type'] !== 'user') continue;
    const message = entry['message'];
    const content = message && typeof message === 'object' ? (message as Record<string, unknown>)['content'] : undefined;
    const text = Array.isArray(content)
      ? content.map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' ? String((b as Record<string, unknown>)['text'] ?? '') : '')).join(' ')
      : typeof content === 'string' ? content : '';
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    return {
      text: flat,
      at: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : null,
      cwd: typeof entry['cwd'] === 'string' ? entry['cwd'] : null,
    };
  }
  return null;
}

/** The role the operator named, or null. Deliberately narrow: the verb, then a
 *  rostered name. "Arthur summons you into a meeting" names no role and is not
 *  read as one — the canary is what answers for those (9 of them here), and
 *  that is a weaker claim carrying its own label. */
export function roleNamedByOperator(opener: string, roster: SummonRole[]): string | null {
  const m = /^\s*(?:summon|summoning|be)\s+([a-z0-9-]+)/i.exec(opener);
  if (!m) return null;
  const named = m[1]!.toLowerCase();
  return roster.some((r) => r.role === named) ? named : null;
}

/** A canary the session itself SAID. Only an assistant text block counts: the
 *  same sentence sits in every record that holds the profile at all — a
 *  request shape, a file read, a tool result — and that proves the profile was
 *  in the context, not that the session was that role. */
export function canaryReproduced(text: string, roster: SummonRole[]): string | null {
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry['type'] !== 'assistant') continue;
    const message = entry['message'];
    const blocks = message && typeof message === 'object' ? (message as Record<string, unknown>)['content'] : undefined;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'text' || typeof b['text'] !== 'string') continue;
      for (const r of roster) if (r.canary && (b['text'] as string).includes(r.canary)) return r.role;
    }
  }
  return null;
}

/** The host record directories a summon could be in: those of sessions that
 *  ran inside a directory the roster points at, or under one. Summons happen
 *  where the profiles are — the operator opens a session in the repository and
 *  names a role — and scanning the whole host store instead would read every
 *  unrelated project's transcripts to answer a question about this one. */
export function summonRoots(loops: Record<string, LoopConfig>): string[] {
  const cwds = [...new Set(Object.values(loops).map((l) => l.cwd))];
  const roots = new Set<string>();
  for (const cwd of cwds) {
    roots.add(cwd);
    // The repository root as well as the seat's own directory: the operator's
    // sittings are opened at the top of the repo, not in an agent's workspace.
    const parts = cwd.split('/');
    for (let i = parts.length - 1; i > 1; i--) {
      const candidate = parts.slice(0, i).join('/');
      if (existsSync(join(candidate, '.git'))) { roots.add(candidate); break; }
    }
  }
  return [...roots].sort();
}

/** The profiles that sit beside the roster's own and have no seat here. Found
 *  from the roster rather than from a path this module knows: every
 *  constitution is `<dir>/<role>/PROFILE.md`, so the siblings of those
 *  directories are the rest of the crew. Without this the blind spot is
 *  silent — "summon herald" reads as a session that merely spoke as nobody,
 *  and the scan says nothing about why. */
export function rolesWithoutSeat(loops: Record<string, LoopConfig>): { role: string; profile: string }[] {
  const seats = new Set(Object.keys(loops));
  const parents = new Set<string>();
  for (const loop of Object.values(loops)) {
    const parts = loop.constitution.split('/');
    if (parts.length >= 3) parents.add(parts.slice(0, -2).join('/'));
  }
  const out: { role: string; profile: string }[] = [];
  for (const parent of parents) {
    let names: string[];
    try { names = readdirSync(parent); } catch { continue; }
    for (const name of names) {
      if (seats.has(name)) continue;
      const profile = join(parent, name, 'PROFILE.md');
      if (existsSync(profile)) out.push({ role: name, profile });
    }
  }
  return out.sort((a, b) => a.role.localeCompare(b.role));
}

/** Named summons this installation can see, with the basis for each claim.
 *
 *  Ordered cheap first, and the order is load-bearing rather than an
 *  optimisation: the launch journal settles a record in one map lookup, the
 *  opening words come from the head of the file, and only a record that is
 *  neither a launched run nor an opener match is read whole to look for a
 *  canary. On this machine that is ~90 records of 14,135. */
export function summonAssociations(opts: {
  loops: Record<string, LoopConfig>;
  roots?: string[];
  since?: string | null;
}): SummonScan {
  const roster = summonRoster(opts.loops);
  const roots = opts.roots ?? summonRoots(opts.loops);
  const since = opts.since ?? null;
  const sinceMs = since ? Date.parse(since) : null;
  const launched = launchedSessions(Object.keys(opts.loops));
  const projects = join(claudeHome(), 'projects');
  const slugs = new Set(roots.map((r) => claudeProjectSlug(r)));

  const scan: SummonScan = {
    roster, roles_without_seat: rolesWithoutSeat(opts.loops), roots, since,
    scanned: 0, excluded_by_window: 0, launched_runs: 0, launched_by_prompt: 0, other_sessions: 0,
    unreadable: [], associations: [],
    ceilings: [
      'A summon through the crew-summon MCP (phone, web) runs on the provider\'s side and writes nothing on this machine, so an away-from-desk summon is not partially traced — it is absent. No local record holds a crew-summon tool call.',
      'These are sessions whose records this machine holds. A summon on another machine, or one whose transcript the host has pruned, cannot be seen from here.',
      'The roster bounds what can be recognised: a role with no seat configured here is not a name this scan knows.',
    ],
  };

  let dirs: string[];
  try { dirs = readdirSync(projects); } catch (e) {
    scan.unreadable.push({ path: projects, why: `The host record store could not be listed: ${String(e)}` });
    return scan;
  }

  // One sitting, many records: a resume copies the transcript, so records
  // sharing an opener are grouped rather than counted separately.
  const sittings = new Map<string, SummonAssociation>();

  for (const dir of dirs) {
    // A project directory's slug is its cwd with the separators replaced, so a
    // seat's own directory and anything under a root both start with the
    // root's slug.
    if (![...slugs].some((s) => dir === s || dir.startsWith(s + '-'))) continue;
    let names: string[];
    try { names = readdirSync(join(projects, dir)); } catch (e) {
      scan.unreadable.push({ path: join(projects, dir), why: `This project directory could not be listed: ${String(e)}` });
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(projects, dir, name);
      if (sinceMs !== null) {
        // A PREFILTER, not the window. A record is written at or after the
        // moment its session opened, so an mtime before the window proves the
        // sitting is outside it — the implication only runs that way. The
        // other way is false and reading mtime AS the window said 117 summons
        // since October 1st when most of those sittings were in September:
        // the host touches a transcript long after, and one here opened on the
        // 15th carries an mtime of the 21st. The window itself is applied to
        // each sitting's own opening below.
        try { if (statSync(path).mtimeMs < sinceMs) continue; } catch { /* reported below by the read */ }
      }
      scan.scanned++;
      const sessionId = name.slice(0, -'.jsonl'.length);
      const launch = launched.get(sessionId);
      if (launch) { scan.launched_runs++; continue; }

      const head = readUpTo(path, OPENER_BYTE_CEILING);
      if ('why' in head) { scan.unreadable.push({ path, why: head.why }); continue; }
      const opener = firstUserText(head.text);
      if (!opener) {
        // A record with nothing the operator said is not a sitting: a session
        // that never reached a first message, or a head too small to hold it.
        scan.other_sessions++;
        continue;
      }
      // An iteration prompt in the record is this installation's own hand,
      // whether or not a journal entry survives to say so. Checked BEFORE any
      // canary: a seat quoting its own profile mid-work is not a summon.
      if (opener.text.startsWith(ITERATION_PROMPT_OPENING) || ITERATION_PROMPT_OPENING_LEGACY.test(opener.text)) {
        scan.launched_runs++;
        scan.launched_by_prompt++;
        continue;
      }
      const named = roleNamedByOperator(opener.text, roster);

      let role = named;
      let basis: RoleBasis = 'named_by_operator';
      let protocol: SummonAssociation['protocol'] = 'unknown';
      let why = '';

      const whole = readUpTo(path, CANARY_BYTE_CEILING);
      if ('why' in whole) {
        if (named === null) { scan.other_sessions++; continue; }
        scan.unreadable.push({ path, why: whole.why });
        protocol = 'unknown';
        why = `The operator opened this session with "${opener.text.slice(0, 60)}", and the record could not be read whole to see whether ${named} reproduced its canary.`;
      } else {
        const said = canaryReproduced(whole.text, roster);
        if (named === null) {
          if (said === null) { scan.other_sessions++; continue; }
          role = said;
          basis = 'canary_reproduced';
          protocol = 'performed';
          why = `Nothing in the operator's opening words named a role, and this session reproduced ${said}'s canary in what it said. That is the weaker claim and it is not called a summon: a session launched under ${said}'s own cwd by something other than this installation arrives with that profile and reproduces the canary too, and so does one working ON the profile. What is observable here is that the session SPOKE as ${said}; why it did is not in the record.`;
        } else {
          protocol = whole.truncated ? 'unknown' : said === named ? 'performed' : 'absent';
          why = protocol === 'performed'
            ? `The operator named ${named} in his opening words, and the session reproduced ${named}'s canary in what it said.`
            : protocol === 'absent'
              ? `The operator named ${named} in his opening words. Nothing this session SAID carried ${named}'s canary${said ? ` (it carried ${said}'s)` : ''}, so the summon protocol was not completed — which is a fact about the sitting, not a reason to call it something else.`
              : `The operator named ${named} in his opening words, and the record is larger than the ${CANARY_BYTE_CEILING.toLocaleString('en-US')} bytes read, so whether the canary was reproduced is unknown rather than absent.`;
        }
      }

      const key = `${opener.at ?? 'no-timestamp'}|${opener.text.slice(0, 200)}`;
      const existing = sittings.get(key);
      if (existing) {
        existing.records.push(path);
        existing.session_ids.push(sessionId);
        // A resumed record may complete a protocol the first one did not.
        if (existing.protocol !== 'performed' && protocol === 'performed') {
          existing.protocol = 'performed';
          existing.why = `${why} One of this sitting's ${existing.records.length} records carries it; a resume copies the transcript, so the sitting is the unit, not the file.`;
        }
        continue;
      }
      sittings.set(key, {
        records: [path], session_ids: [sessionId], cwd: opener.cwd, opened_at: opener.at,
        state: basis === 'named_by_operator' ? 'summon' : 'spoke_as_role', role, role_basis: basis, protocol,
        opener: opener.text.slice(0, 200), why,
      });
    }
  }

  const dated = [...sittings.values()];
  scan.associations = (sinceMs === null
    ? dated
    : dated.filter((a) => {
      // An undated sitting cannot be placed in a window, so a windowed answer
      // excludes it and counts it rather than quietly keeping or dropping it.
      const at = a.opened_at === null ? NaN : Date.parse(a.opened_at);
      if (Number.isNaN(at) || at < sinceMs) { scan.excluded_by_window++; return false; }
      return true;
    })
  ).sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)));
  return scan;
}

export function renderSummonScan(scan: SummonScan, limit = 20): string {
  const out: string[] = [];
  const named = scan.associations.filter((a) => a.state === 'summon');
  const inferred = scan.associations.filter((a) => a.state === 'spoke_as_role');
  out.push(`NAMED SUMMONS — ${named.length} sittings in ${named.reduce((n, a) => n + a.records.length, 0)} records`);
  out.push(`  scanned ${scan.scanned} records under ${scan.roots.length} root${scan.roots.length === 1 ? '' : 's'}${scan.since ? ` whose file could be newer than ${scan.since}` : ''}: ${scan.launched_runs} this installation launched (${scan.launched_by_prompt} of them identified by the iteration prompt, with no journal entry left), ${scan.other_sessions} neither, ${scan.unreadable.length} unreadable`);
  const absent = named.filter((a) => a.protocol === 'absent').length;
  out.push(`  ${named.length} the operator named${absent ? `, ${absent} of them without the canary the protocol asks for` : ''}; ${inferred.length} more sittings spoke as a role with nothing recording why`);
  if (scan.since) out.push(`  the window is each sitting's OWN opening, not its file's date: ${scan.excluded_by_window} sitting${scan.excluded_by_window === 1 ? '' : 's'} opened before ${scan.since} and are not counted above`);
  out.push('');
  for (const a of named.slice(0, limit)) {
    out.push(`${a.opened_at ?? '(no timestamp)'}  ${a.role ?? '(no role)'}  [${a.role_basis}, protocol ${a.protocol}]`);
    out.push(`  "${visibleControls(a.opener ?? '')}"`);
    out.push(`  ${a.records.length} record${a.records.length === 1 ? '' : 's'}: ${a.records[0]}${a.records.length > 1 ? ` (+${a.records.length - 1} resumed)` : ''}`);
    out.push(`  ${visibleControls(a.why)}`);
    out.push('');
  }
  if (named.length > limit) out.push(`… ${named.length - limit} older summons not shown; --limit takes a number.`);
  if (inferred.length) {
    out.push('');
    out.push(`SPOKE AS A ROLE, CAUSE UNRECORDED — ${inferred.length} sittings. A summon the operator phrased without naming a role, or a session something other than this installation launched under a seat's own directory. One observable cannot tell those apart:`);
    for (const a of inferred.slice(0, Math.min(limit, 8))) {
      out.push(`  ${a.opened_at ?? '(no timestamp)'}  ${a.role}  "${visibleControls(a.opener?.slice(0, 60) ?? '')}"  ${visibleControls(a.cwd ?? '')}`);
    }
    if (inferred.length > 8) out.push(`  … ${inferred.length - 8} more`);
    out.push('');
  }
  if (scan.roles_without_seat.length) {
    out.push(`ROLES NO SEAT IS CONFIGURED FOR — ${scan.roles_without_seat.map((r) => r.role).join(', ')}. A summon of one of these cannot be recognised by name here, so it falls into the class above or into neither.`);
    out.push('');
  }
  const noCanary = scan.roster.filter((r) => r.canary === null);
  if (noCanary.length) {
    out.push('ROLES WITH NO CANARY — recognisable only by the operator\'s own words:');
    for (const r of noCanary) out.push(`  ${r.role}: ${r.why}`);
    out.push('');
  }
  out.push('CEILINGS:');
  for (const c of scan.ceilings) out.push(`  - ${c}`);
  if (scan.unreadable.length) {
    out.push('UNREADABLE:');
    for (const u of scan.unreadable.slice(0, 10)) out.push(`  - ${u.why}`);
  }
  return out.join('\n');
}
