// The acceptance for associating a NAMED SUMMON with its host record
// (R-55 H-3724 requirement 6).
//
// Every record here is a disposable fixture in a temp CLAUDE_CONFIG_DIR, and
// the roster is a temp directory too: the reader's job is to say what a host
// retained and on whose say-so, so a test that read the operator's own
// transcripts would assert against files this repo does not control.
//
// The SHAPES are taken from the 14,135 records of the machine this was built
// against, and the counts quoted in the case names are measured there — the
// 86 loop records that reproduce their own canary, the 142 sittings behind 165
// opener matches, the 8 summons with no canary at all. Each case exists
// because one of those would otherwise be read wrong.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordLaunchDispatch, recordLaunchIntent, recordLaunchSession } from '../src/launch-journal.js';
import { visibleControls } from '../src/context-trace.js';
import {
  summonAssociations, renderSummonScan, summonRoster, summonRoots, rolesWithoutSeat, roleNamedByOperator, canaryReproduced,
  ITERATION_PROMPT_OPENING, CANARY_BYTE_CEILING, type SummonScan,
} from '../src/summon-trace.js';
import type { LoopConfig } from '../src/types.js';

let home: string;      // the fixture CLAUDE_CONFIG_DIR
let crew: string;      // the fixture repository the profiles live in
const saved: Record<string, string | undefined> = {};

const CANARY = '🧱 PROFILE.md (mason) — Check it plumb before the mortar sets.';
const WARD_CANARY = '🛡️ PROFILE.md (ward) — Lock the gate while the road is quiet.';

/** Only the fields this module reads; the rest of a LoopConfig is irrelevant
 *  here and inventing it would make the fixture look like a roster. */
const loop = (name: string, opts: { cwd?: string } = {}): LoopConfig =>
  ({ name, cwd: opts.cwd ?? join(crew, 'agents', name), constitution: join(crew, 'agents', name, 'PROFILE.md') } as unknown as LoopConfig);

const profile = (role: string, canary: string): void => {
  mkdirSync(join(crew, 'agents', role), { recursive: true });
  writeFileSync(join(crew, 'agents', role, 'PROFILE.md'), `# ${role}\n\nSome craft.\n\n${canary}\n`);
};

/** A record under the project directory the host would name for this cwd. */
const record = (cwd: string, sessionId: string, entries: unknown[]): string => {
  const dir = join(home, 'projects', cwd.replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
};

const userEntry = (text: string, at = '2026-10-20T10:00:00.000Z', cwd?: string) =>
  ({ type: 'user', timestamp: at, ...(cwd ? { cwd } : {}), message: { role: 'user', content: [{ type: 'text', text }] } });
const assistantSaying = (text: string) =>
  ({ type: 'assistant', timestamp: '2026-10-20T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const scan = (loops: Record<string, LoopConfig>, opts: { since?: string | null; roots?: string[] } = {}): SummonScan =>
  summonAssociations({ loops, ...opts });

beforeEach(() => {
  for (const k of ['CLAUDE_CONFIG_DIR', 'REV_HOME']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'rev-summon-home-'));
  crew = mkdtempSync(join(tmpdir(), 'rev-summon-crew-'));
  mkdirSync(join(crew, '.git'), { recursive: true });
  process.env['CLAUDE_CONFIG_DIR'] = home;
  process.env['REV_HOME'] = mkdtempSync(join(tmpdir(), 'rev-summon-state-'));
  profile('mason', CANARY);
  profile('ward', WARD_CANARY);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [home, crew]) rmSync(d, { recursive: true, force: true });
});

describe('the roster is what makes a name a role', () => {
  it('takes each seat\'s canary from the last line of its own constitution', () => {
    const roster = summonRoster({ mason: loop('mason'), ward: loop('ward') });
    expect(roster.map((r) => r.role)).toEqual(['mason', 'ward']);
    expect(roster[0]!.canary).toBe(CANARY);
    expect(roster[0]!.why).toContain('PROFILE.md');
  });

  it('refuses a canary that names a different role than the seat it is configured for', () => {
    writeFileSync(join(crew, 'agents', 'mason', 'PROFILE.md'), `# mason\n\n${WARD_CANARY}\n`);
    const [mason] = summonRoster({ mason: loop('mason') });
    // A record carries the name in the SENTENCE, so trusting this would file
    // mason's sitting under ward.
    expect(mason!.canary).toBeNull();
    expect(mason!.why).toContain('"ward"');
    expect(mason!.why).toContain('"mason"');
  });

  it('keeps a seat whose constitution is missing, recognisable by name alone', () => {
    rmSync(join(crew, 'agents', 'mason', 'PROFILE.md'));
    const [mason] = summonRoster({ mason: loop('mason') });
    expect(mason!.canary).toBeNull();
    expect(mason!.why).toContain('not there');
    expect(roleNamedByOperator('summon mason', [mason!])).toBe('mason');
  });

  it('reports the summonable roles no seat is configured for, instead of leaving the blind spot silent', () => {
    profile('herald', '📯 PROFILE.md (herald) — The floor is yours; the record will hold.');
    const without = rolesWithoutSeat({ mason: loop('mason') });
    expect(without.map((r) => r.role)).toEqual(['herald', 'ward']);
    expect(without[0]!.profile).toBe(join(crew, 'agents', 'herald', 'PROFILE.md'));
  });
});

describe('what the operator said, and what the session said', () => {
  it('reads a role out of the opening words only when the roster knows the name', () => {
    const roster = summonRoster({ mason: loop('mason') });
    expect(roleNamedByOperator('summon mason', roster)).toBe('mason');
    expect(roleNamedByOperator('Summon Mason please', roster)).toBe('mason');
    // "summon chips" is a real opener here, for a role that no longer exists.
    expect(roleNamedByOperator('summon chips', roster)).toBeNull();
    // Measured: 9 openers are this, naming no role at all.
    expect(roleNamedByOperator('Arthur summons you into a meeting.', roster)).toBeNull();
  });

  it('counts a canary only where the session SAID it, never where the record merely holds it', () => {
    const roster = summonRoster({ mason: loop('mason') });
    expect(canaryReproduced(JSON.stringify(assistantSaying(`done.\n\n${CANARY}`)), roster)).toBe('mason');
    // The same sentence sits in every record that holds the profile at all:
    // the request shape, a file read, a tool result. That proves the profile
    // was in the context, not that the session was the role.
    const asRequest = JSON.stringify({ type: 'api-request-shape', shape: { system: [{ text: CANARY }] } });
    const asToolResult = JSON.stringify(userEntry(`<tool_result>${CANARY}</tool_result>`));
    expect(canaryReproduced(asRequest, roster)).toBeNull();
    expect(canaryReproduced(asToolResult, roster)).toBeNull();
  });
});

describe('a session this installation launched is not a summon', () => {
  it('is settled by the launch journal even when it reproduces its own canary', () => {
    // Measured: 86 loop records reproduce a canary. Reading one as a summon is
    // the single worst error this module could make, so the journal is checked
    // before anything in the text.
    const id = '11111111-2222-3333-4444-555555555555';
    recordLaunchIntent('mason', 'rev:mason:1:1:1');
    recordLaunchDispatch('mason', 'rev:mason:1:1:1');
    recordLaunchSession('mason', 'rev:mason:1:1:1', {
      provider: 'claude', model: 'claude-opus-5', provider_session_id: id,
      provider_session_id_state: 'observed', started_at: 'a', ended_at: 'b', outcome: 'complete',
    });
    record(join(crew, 'agents', 'mason'), id, [userEntry('summon mason'), assistantSaying(CANARY)]);

    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(0);
    expect(s.launched_runs).toBe(1);
    expect(s.launched_by_prompt).toBe(0);
  });

  it('is settled by the iteration prompt when the journal entry is gone', () => {
    // Journalling came later than the fleet: 3,230 records here carry an
    // iteration prompt and no entry to join to.
    record(join(crew, 'agents', 'mason'), '11111111-2222-3333-4444-666666666666',
      [userEntry(`${ITERATION_PROMPT_OPENING} AGENTS.md's summon clause does not apply.`), assistantSaying(CANARY)]);
    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(0);
    expect(s.launched_by_prompt).toBe(1);
  });

  it('is settled by the older spelling of that prompt too', () => {
    record(join(crew, 'agents', 'mason'), '11111111-2222-3333-4444-777777777777',
      [userEntry("Loop iteration 13 for agent 'mason'. Working directory: /x"), assistantSaying(CANARY)]);
    expect(scan({ mason: loop('mason') }).associations).toHaveLength(0);
  });
});

describe('a named summon', () => {
  it('is the operator\'s own words, confirmed by the canary the role reproduced', () => {
    record(crew, '22222222-2222-3333-4444-555555555555',
      [userEntry('summon mason', '2026-10-20T10:00:00.000Z', crew), assistantSaying(`Ready.\n\n${CANARY}`)]);
    const [a] = scan({ mason: loop('mason') }).associations;
    expect(a!.state).toBe('summon');
    expect(a!.role).toBe('mason');
    expect(a!.role_basis).toBe('named_by_operator');
    expect(a!.protocol).toBe('performed');
    expect(a!.cwd).toBe(crew);
    expect(a!.opened_at).toBe('2026-10-20T10:00:00.000Z');
  });

  it('stays a summon when the canary never came — the protocol is what is absent, not the summon', () => {
    // Measured: 8 of 122 sittings here. Demoting them would hide exactly the
    // sittings worth looking at.
    record(crew, '22222222-2222-3333-4444-666666666666',
      [userEntry('summon mason'), assistantSaying('Ready.')]);
    const [a] = scan({ mason: loop('mason') }).associations;
    expect(a!.state).toBe('summon');
    expect(a!.protocol).toBe('absent');
    expect(a!.why).toContain('not completed');
  });

  it('reports the wrong role\'s canary as a protocol that was not completed, not as that role\'s summon', () => {
    record(crew, '22222222-2222-3333-4444-777777777777',
      [userEntry('summon mason'), assistantSaying(WARD_CANARY)]);
    const [a] = scan({ mason: loop('mason'), ward: loop('ward') }).associations;
    expect(a!.role).toBe('mason');
    expect(a!.protocol).toBe('absent');
    expect(a!.why).toContain('ward');
  });

  it('says unknown rather than absent when the record is larger than it could read', () => {
    const filler = { type: 'filler', pad: 'x'.repeat(4096) };
    const entries: unknown[] = [userEntry('summon mason')];
    for (let i = 0; i < Math.ceil(CANARY_BYTE_CEILING / 4096) + 2; i++) entries.push(filler);
    entries.push(assistantSaying(CANARY));
    record(crew, '22222222-2222-3333-4444-888888888888', entries);
    const [a] = scan({ mason: loop('mason') }).associations;
    // Not finding a canary in part of a file is not evidence it is not in the
    // rest of it.
    expect(a!.protocol).toBe('unknown');
    expect(a!.why).toContain('unknown rather than absent');
  });
});

describe('a session that spoke as a role, with nothing recording why', () => {
  it('is its own state, never called a summon', () => {
    // "Arthur summons you into a meeting" is one of these, and so is a probe
    // something else launched under a seat's own cwd: both arrive with the
    // profile and reproduce the canary, and one observable cannot tell them
    // apart.
    record(join(crew, 'agents', 'mason'), '33333333-2222-3333-4444-555555555555',
      [userEntry('Arthur summons you into a meeting.'), assistantSaying(CANARY)]);
    const s = scan({ mason: loop('mason') });
    const [a] = s.associations;
    expect(a!.state).toBe('spoke_as_role');
    expect(a!.role).toBe('mason');
    expect(a!.role_basis).toBe('canary_reproduced');
    expect(a!.why).toContain('not called a summon');
  });

  it('is not claimed for a session whose record merely HOLDS a canary it never said', () => {
    // The whole record this time, not one line: the canary arrives as a file
    // read, which is what every session that loads a profile looks like. The
    // fast path and the decision are different things and only this can tell
    // them apart.
    record(join(crew, 'agents', 'mason'), '33333333-2222-3333-4444-777777777777', [
      userEntry('Arthur summons you into a meeting.'),
      { type: 'api-request-shape', shape: { system: [{ text: CANARY }] } },
      userEntry(`<tool_result>${CANARY}</tool_result>`, '2026-10-20T10:00:05.000Z'),
      assistantSaying('Here is what I found.'),
    ]);
    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(0);
    expect(s.other_sessions).toBe(1);
  });

  it('is not fooled by a session that QUOTED a transcript holding a canary', () => {
    // A seat that reads host records — which is how this module was built —
    // ends up with transcript text in its own record. It is safe for a reason
    // worth writing down: the inner JSON is ESCAPED when the host serialises
    // the entry, so the quoted `\"type\":\"assistant\"` is not the entry's own
    // type and the quoted canary is not in a text block of this session's.
    // Both guards in canaryReproduced agree on this record; neither alone is
    // what makes it safe.
    record(join(crew, 'agents', 'mason'), '33333333-2222-3333-4444-888888888888', [
      userEntry('Arthur summons you into a meeting.'),
      userEntry(`grep output: ${JSON.stringify(assistantSaying(CANARY))}`, '2026-10-20T10:00:05.000Z'),
      assistantSaying('Here is what the record held.'),
    ]);
    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(0);
    expect(s.other_sessions).toBe(1);
  });

  it('is not claimed at all for a session that neither named a role nor spoke as one', () => {
    record(crew, '33333333-2222-3333-4444-666666666666',
      [userEntry('Reply with the single word: ready.'), assistantSaying('ready')]);
    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(0);
    expect(s.other_sessions).toBe(1);
  });
});

describe('one sitting is not one record', () => {
  it('groups the records a resume copied, and lets a later one complete the protocol', () => {
    // Measured: 165 opener matches came from 142 distinct sittings. Counting
    // records would have overstated summons by 23.
    const opener = userEntry('summon mason', '2026-10-20T10:00:00.000Z', crew);
    record(crew, '44444444-2222-3333-4444-555555555555', [opener, assistantSaying('thinking')]);
    record(crew, '44444444-2222-3333-4444-666666666666', [opener, assistantSaying(`Ready.\n\n${CANARY}`)]);
    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(1);
    expect(s.associations[0]!.records).toHaveLength(2);
    expect(s.associations[0]!.session_ids).toHaveLength(2);
    expect(s.associations[0]!.protocol).toBe('performed');
    expect(s.associations[0]!.why).toContain('resume copies the transcript');
  });
});

describe('what the scan looked at, so a nil answer is not read as an absence', () => {
  it('looks in the seats\' own directories and the repository their profiles live in', () => {
    const roots = summonRoots({ mason: loop('mason'), ward: loop('ward') });
    expect(roots).toContain(join(crew, 'agents', 'mason'));
    expect(roots).toContain(join(crew, 'agents', 'ward'));
    expect(roots).toContain(crew);
  });

  it('does not reach a session that ran somewhere else', () => {
    record('/Users/someone/projects/other', '55555555-2222-3333-4444-555555555555',
      [userEntry('summon mason'), assistantSaying(CANARY)]);
    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(0);
    expect(s.scanned).toBe(0);
  });

  it('reports the window it searched when one was given', () => {
    record(crew, '66666666-2222-3333-4444-555555555555', [userEntry('summon mason'), assistantSaying(CANARY)]);
    const s = scan({ mason: loop('mason') }, { since: '2099-01-01' });
    expect(s.associations).toHaveLength(0);
    expect(s.scanned).toBe(0);
    expect(s.since).toBe('2099-01-01');
  });

  it('puts the window on the sitting\'s own opening, not on its file\'s date', () => {
    // The host touches a transcript long after the sitting: one here opened on
    // the 15th and carries an mtime of the 21st. Reading mtime AS the window
    // reported 117 summons since October 1st when most of those sittings were
    // in September.
    const path = record(crew, '66666666-2222-3333-4444-666666666666',
      [userEntry('summon mason', '2026-09-15T10:00:00.000Z', crew), assistantSaying(CANARY)]);
    const touched = new Date('2026-10-21T15:00:00.000Z');
    utimesSync(path, touched, touched);

    const s = scan({ mason: loop('mason') }, { since: '2026-10-01' });
    expect(s.scanned).toBe(1);          // the file passed the cheap prefilter
    expect(s.associations).toHaveLength(0);
    expect(s.excluded_by_window).toBe(1);

    // And the prefilter never excludes a sitting that belongs in the window:
    // a record is written at or after the moment its session opened.
    expect(scan({ mason: loop('mason') }, { since: '2026-09-01' }).associations).toHaveLength(1);
  });

  it('states the ceilings on every scan, including the summons it cannot see at all', () => {
    const s = scan({ mason: loop('mason') });
    expect(s.ceilings.join(' ')).toContain('crew-summon MCP');
    expect(s.ceilings.join(' ')).toContain('absent');
    // And carries the named blind spot with them: ward has a profile here and
    // no seat, so a summon of ward cannot be recognised by name.
    expect(s.roles_without_seat.map((r) => r.role)).toEqual(['ward']);
  });
});

describe('text read out of a host record is attacker-controlled', () => {
  it('renders control bytes visibly rather than letting them reach the terminal', () => {
    // A record holds whatever a session's tool results held, pages included.
    // Measured on this very renderer before it shipped: 3 ESC and 2 BEL bytes
    // in the rendered opener. ward's review of the read surface failed
    // increment 3 for the same class (H-3750 finding 1).
    const hostile = 'summon mason\u001b]0;PWNED\u0007 \u001b[2J\u001b]52;c;cGF5bG9hZA==\u0007';
    record(crew, '77777777-2222-3333-4444-555555555555',
      [userEntry(hostile, '2026-10-20T10:00:00.000Z', crew), assistantSaying(CANARY)]);
    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(1);

    const rendered = renderSummonScan(s);
    expect(rendered).not.toMatch(/[\u001b\u0007]/);
    expect(rendered).toContain('\\u001b');
    // And the bytes are SHOWN, not stripped: they were in the context.
    expect(rendered).toContain('PWNED');
    // The reading itself keeps the record's own text — only the renderer
    // makes it safe to print, so --json stays the record's bytes.
    expect(s.associations[0]!.opener).toContain('\u001b');
  });

  it('leaves ordinary text alone', () => {
    expect(visibleControls('summon mason — plainly')).toBe('summon mason — plainly');
    expect(visibleControls('two\nlines\tand a tab')).toBe('two\nlines\tand a tab');
  });
});

describe('the prefilter is not the decision', () => {
  it('finds the opener in a record whose JSON is spaced differently', () => {
    // Keying the prefilter on `"type":"user"` made a record written with a
    // space after the colon report NO opener — counted as a session that said
    // nothing, which is a silent miss rather than a refusal.
    const dir = join(home, 'projects', crew.replace(/[/.]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const spaced = [
      { type: 'user', timestamp: '2026-10-20T10:00:00.000Z', cwd: crew, message: { role: 'user', content: [{ type: 'text', text: 'summon mason' }] } },
      assistantSaying(CANARY),
    ].map((e) => JSON.stringify(e, null, 1).replace(/\n\s*/g, ' ')).join('\n');
    writeFileSync(join(dir, '88888888-2222-3333-4444-555555555555.jsonl'), spaced + '\n');

    const s = scan({ mason: loop('mason') });
    expect(s.associations).toHaveLength(1);
    expect(s.associations[0]!.role).toBe('mason');
    expect(s.associations[0]!.protocol).toBe('performed');
  });
});
