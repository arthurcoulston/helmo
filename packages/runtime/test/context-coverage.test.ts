// The acceptance for R-45's coverage check (H-3581).
//
// Every source, launch journal and host record here is a disposable private
// fixture under a temp REV_HOME and a temp CLAUDE_CONFIG_DIR. Nothing reads or
// edits a live profile, a live roster or the operator's own transcripts: the
// check's whole job is to notice when those change, so a test that edited one
// would be proving the check against the thing it is meant to watch.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkClaudePath, checkOnSettle, claudeProjectSlug, coverageReading, currentSources,
  latestSettledLaunch, pathProviders, pathRuntimes, readClaudeHostRecord, summonPath,
} from '../src/context-coverage.js';
import { seatContext } from '../src/team.js';
import { systemPrompt } from '../src/shim.js';
import type { LaunchJournalEntry } from '../src/launch-journal.js';
import type { LoopConfig } from '../src/types.js';

let home: string;
let tree: string;
let claude: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['REV_HOME', 'CLAUDE_CONFIG_DIR', 'HELMO_INSTALLATION']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'rev-coverage-'));
  tree = mkdtempSync(join(tmpdir(), 'rev-coverage-tree-'));
  claude = mkdtempSync(join(tmpdir(), 'rev-coverage-claude-'));
  process.env['REV_HOME'] = home;
  process.env['CLAUDE_CONFIG_DIR'] = claude;
  delete process.env['HELMO_INSTALLATION'];
  writeFileSync(join(tree, 'PROFILE.md'), '---\ncap_tokens: 500\n---\nThe seat itself, as the roster composes it.\n');
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function loop(over: Partial<LoopConfig> = {}): LoopConfig {
  return {
    name: 'mason', seat: 'mason', peer_sessions: [], workstream: 'estate-ui',
    cwd: tree, runtime: 'claude', model: 'claude-opus-5',
    constitution: join(tree, 'PROFILE.md'), version: '1', pace: 1, idle_floor_s: 0,
    choices: [{ provider: 'claude', runtime: 'claude', model: 'claude-opus-5' }], fallbacks: [], ...over,
  } as LoopConfig;
}

/** A settled launch in this installation's own journal, written where
 *  `launch-journal` puts it. */
function settled(seat: string, launchId: string, over: Partial<NonNullable<LaunchJournalEntry['session']>> = {}): void {
  const dir = join(home, 'state', seat, 'launches');
  mkdirSync(dir, { recursive: true });
  const entry: LaunchJournalEntry = {
    format: 1, phase: 'complete', launch_id: launchId,
    intent_at: '2026-10-29T09:00:00.000Z', completed_at: '2026-10-29T09:05:00.000Z',
    session: {
      provider: 'claude', model: 'claude-opus-5', provider_session_id: 'aaaaaaaa-1111-2222-3333-444444444444',
      provider_session_id_state: 'observed',
      started_at: '2026-10-29T09:00:01.000Z', ended_at: '2026-10-29T09:04:59.000Z', outcome: 'ok', ...over,
    },
  };
  writeFileSync(join(dir, `${createHash('sha256').update(launchId).digest('hex')}.json`), JSON.stringify(entry, null, 1));
}

/** A host transcript in the shape claude-code actually retains: the appended
 *  prompt arrives as a suffix of the last system block, with the host's own
 *  text ahead of it in the same block. */
function hostRecord(sessionId: string, opts: { cwd?: string; prompt?: string; system?: unknown; version?: string; dir?: string } = {}): string {
  const dir = join(claude, 'projects', opts.dir ?? claudeProjectSlug(tree));
  mkdirSync(dir, { recursive: true });
  const system = 'system' in opts ? opts.system : [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: 'text', text: `Harness notes the host writes.\n\n${opts.prompt ?? ''}` },
  ];
  const lines = [
    { type: 'queue-operation', operation: 'enqueue', sessionId, content: 'the iteration prompt' },
    { type: 'user', sessionId, cwd: opts.cwd ?? tree, version: opts.version ?? '2.1.300', message: { role: 'user' } },
    { type: 'api-request-shape', sessionId, shape: { system, tools: [] } },
  ];
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

describe('the composition this check hashes', () => {
  // The check compares today's composed bytes against the retained prompt. It
  // cannot call `systemPrompt` — that throws on a source the roster names and
  // nothing put there, which is one of the states the check has to report — so
  // it composes the same bytes a second way. Two compositions that drift are
  // how this check would start reporting a change nobody made, so the
  // agreement is asserted rather than assumed.
  it('is byte-identical to the prompt the launcher writes', () => {
    writeFileSync(join(tree, 'skill-a.md'), 'the first appended skill\n');
    writeFileSync(join(tree, 'skill-b.md'), 'the second appended skill\n');
    const l = loop({ skills: [join(tree, 'skill-a.md'), join(tree, 'skill-b.md')] });
    const launcher = systemPrompt(l);
    const current = currentSources(l);

    expect(current.composed_sha256).toBe(createHash('sha256').update(launcher, 'utf8').digest('hex'));
    expect(current.composed_bytes).toBe(Buffer.byteLength(launcher, 'utf8'));
    expect(current.composed.map((s) => s.role)).toEqual(['constitution', 'skill', 'skill']);
  });
});

describe('a normal path', () => {
  it('verifies when today\'s composition is retained verbatim in the launch\'s own prompt', () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });
    const coverage = checkClaudePath(l, { installation: 'fixture.rev' });

    expect(coverage.state).toBe('verified');
    expect(coverage.supported).toBe(true);
    expect(coverage.assertions.every((a) => a.held === true)).toBe(true);
    expect(coverage.assertions.map((a) => a.id)).toEqual(['provider_session_id', 'host_record', 'adapter_shape', 'session_cwd', 'composition']);
    expect(coverage.historical?.host.cli_version).toBe('2.1.300');
    expect(coverage.historical?.launch_id).toBe('rev:mason:1:1:1793000000000');
    expect(coverage.id).toBe('fixture.rev:mason:claude');
    // Current and historical stay apart: the hash is today's, the prompt
    // length is that launch's.
    expect(coverage.current?.composed_sha256).toHaveLength(64);
    expect(coverage.historical?.host.retained_prompt_bytes).toBeGreaterThan(coverage.current!.composed_bytes!);
  });

  it('records the successful check, and a later failing one does not erase it', () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });
    const verified = checkClaudePath(l);
    expect(verified.state).toBe('verified');
    const verifiedAt = verified.last_verified_at;
    expect(verifiedAt).toBe(verified.checked_at);

    // The host prunes its transcript: the check can no longer be made.
    rmSync(join(claude, 'projects'), { recursive: true, force: true });
    const after = checkClaudePath(l);
    expect(after.state).toBe('stale');
    expect(after.last_verified_at).toBe(verifiedAt);
  });
});

describe('a changed source', () => {
  it('reports the difference as changed, not as a broken check, and admits which source moved is unknown', () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });
    const before = checkClaudePath(l).current!.composed_sha256;

    writeFileSync(join(tree, 'PROFILE.md'), '---\ncap_tokens: 500\n---\nThe seat itself, with a line Arthur added since.\n');
    const coverage = checkClaudePath(l);

    expect(coverage.state).toBe('changed');
    expect(coverage.current?.composed_sha256).not.toBe(before);
    // Everything else still held: a changed source is not a failed join.
    expect(coverage.assertions.filter((a) => a.held === false).map((a) => a.id)).toEqual(['composition']);
    const composition = coverage.assertions.find((a) => a.id === 'composition')!;
    expect(composition.detail).toContain('not determinable from this record');
    expect(composition.repair).toBeTruthy();
  });

  // The failure this forbids: identifying a historical source by matching a
  // first line, which would call an edited file the same file (H-3581).
  it('does not call an edited source the same source because its opening survives', () => {
    const l = loop();
    const original = systemPrompt(l);
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: original });
    writeFileSync(join(tree, 'PROFILE.md'), `${original}And one more paragraph, after an identical opening.\n`);

    expect(checkClaudePath(l).state).toBe('changed');
  });
});

describe('sources the installation cannot read', () => {
  it('claims no hash for a missing composed source, and says a launch now would fail at it', () => {
    const l = loop({ skills: [join(tree, 'absent.md')] });
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: 'whatever that launch got' });
    const coverage = checkClaudePath(l);

    expect(coverage.state).toBe('error');
    expect(coverage.current?.composed_sha256).toBeNull();
    expect(coverage.current?.composed.find((s) => s.state === 'missing')?.path).toBe(join(tree, 'absent.md'));
    expect(coverage.current?.limit).toContain('absent.md');
    const composition = coverage.assertions.find((a) => a.id === 'composition')!;
    expect(composition.held).toBeNull();
    expect(composition.repair).toContain('A session launched now would fail at the same file');
    // The historical evidence is untouched by today's broken configuration.
    expect(coverage.historical?.host.record).toBeTruthy();
  });

  it('reports an unreadable source as unreadable rather than as an empty one', () => {
    const fifo = join(tree, 'fifo-skill.md');
    // The same way `cli/test/team-read-surface.test.mjs` makes one: node
    // has no mkfifo.
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const coverage = checkClaudePath(loop({ skills: [fifo] }));

    const source = coverage.current!.composed.find((s) => s.path === fifo)!;
    expect(source.state).toBe('unreadable');
    expect(source.sha256).toBeNull();
    expect(source.error).toContain('fifo');
    expect(coverage.state).toBe('stale'); // no launch to check, which is the other finding here
  });

  it('refuses to follow a symbolic link planted where a source belongs', () => {
    const real = join(tree, 'elsewhere.md');
    writeFileSync(real, 'content from outside the roster');
    const link = join(tree, 'linked-skill.md');
    symlinkSync(real, link);
    const source = currentSources(loop({ skills: [link] })).composed.find((s) => s.path === link)!;

    expect(source.state).toBe('unreadable');
    expect(source.sha256).toBeNull();
  });
});

describe('the measured inventory', () => {
  it('carries team.ts\'s own over-cap state rather than a second copy of the cap rules', async () => {
    writeFileSync(join(tree, 'PROFILE.md'), `---\ncap_tokens: 5\n---\n${'a profile far past the cap it declares. '.repeat(40)}`);
    const l = loop();
    const coverage = checkClaudePath(l, { inventory: await seatContext(l) });

    expect(coverage.current?.inventory?.composed.profile?.state).toBe('over');
    expect(coverage.current?.inventory?.startup_tokens).toBeGreaterThan(0);
    // The over-cap file is still a readable source, so the check itself runs.
    expect(coverage.current?.composed_sha256).toHaveLength(64);
  });
});

describe('the host record', () => {
  it('finds a record filed under a slug the working directory does not reproduce', () => {
    // The host maps both `/` and `.` to `-`, so a cwd cannot be recovered from
    // a slug and a slug cannot always be recovered from a cwd. Looked up by
    // session id, the record is found anyway.
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l), dir: 'a-slug-no-cwd-here-produces' });

    expect(checkClaudePath(l).state).toBe('verified');
  });

  it('reports a changed adapter as stale with the reader as the repair', () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    // The host CLI now retains its system prompt as a single string.
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { system: 'one string where an array of blocks used to be' });
    const coverage = checkClaudePath(l);

    expect(coverage.state).toBe('stale');
    const adapter = coverage.assertions.find((a) => a.id === 'adapter_shape')!;
    expect(adapter.held).toBe(false);
    expect(adapter.detail).toContain('host CLI changed');
    expect(adapter.repair).toContain('2.1.300');
    expect(adapter.repair).toContain('re-read against it');
    // No composition verdict is invented from a record it could not read.
    expect(coverage.assertions.find((a) => a.id === 'composition')).toBeUndefined();
  });

  it('reports a working directory that no longer matches the roster, and why it matters', () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l), cwd: '/somewhere/else' });
    const coverage = checkClaudePath(l);

    expect(coverage.state).toBe('stale');
    const cwd = coverage.assertions.find((a) => a.id === 'session_cwd')!;
    expect(cwd.held).toBe(false);
    expect(cwd.repair).toContain('discovered instruction files follow the working directory');
  });

  it('does not call a path verified when the host record carries no working directory', () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    // No entry in this record carries `cwd`, so the roster could not be
    // checked against it. An assertion nobody could make is not a pass.
    const dir = join(claude, 'projects', claudeProjectSlug(tree));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), `${JSON.stringify({
      type: 'api-request-shape', shape: { system: [{ type: 'text', text: systemPrompt(l) }], tools: [] },
    })}\n`);
    const coverage = checkClaudePath(l);

    expect(coverage.state).toBe('stale');
    expect(coverage.assertions.find((a) => a.id === 'session_cwd')!.held).toBeNull();
    expect(coverage.assertions.find((a) => a.id === 'composition')!.held).toBe(true);
    expect(coverage.last_verified_at).toBeNull();
  });

  it('reads nothing from a record that is not a regular file', () => {
    const dir = join(claude, 'projects', claudeProjectSlug(tree));
    mkdirSync(join(dir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'), { recursive: true });
    const record = readClaudeHostRecord('bbbbbbbb-1111-2222-3333-444444444444', tree);

    expect(record?.prompt).toBeNull();
    expect(record?.adapter).toContain('cannot be read');
  });
});

describe('a launch with nothing to join on', () => {
  it('is stale with the adapter named, not a quiet pass', () => {
    settled('mason', 'rev:mason:1:1:1793000000000', { provider_session_id_state: 'unsupported', provider_session_id: undefined });
    const coverage = checkClaudePath(loop());

    expect(coverage.state).toBe('stale');
    expect(coverage.assertions[0]).toMatchObject({ id: 'provider_session_id', held: false });
    expect(coverage.assertions[0]!.repair).toContain('--output-format json');
  });

  it('is stale, with no launch rather than no account, before a path has ever run', () => {
    const coverage = checkClaudePath(loop());

    expect(coverage.state).toBe('stale');
    expect(coverage.historical).toBeNull();
    expect(coverage.current?.composed_sha256).toHaveLength(64);
    expect(coverage.assertions[0]!.held).toBeNull();
    expect(coverage.assertions[0]!.repair).toContain('has not been exercised');
  });

  it('takes the most recent settled launch on the path, not the first one found', () => {
    settled('mason', 'rev:mason:1:1:1793000000000', { ended_at: '2026-10-20T00:00:00.000Z' });
    settled('mason', 'rev:mason:1:9:1793999999999', { ended_at: '2026-10-28T00:00:00.000Z' });
    settled('mason', 'rev:mason:1:5:1793500000000', { ended_at: '2026-10-24T00:00:00.000Z' });

    expect(latestSettledLaunch('mason', ['claude'])?.launch_id).toBe('rev:mason:1:9:1793999999999');
    // A launch on another provider is not this path's evidence.
    expect(latestSettledLaunch('mason', ['codex'])).toBeNull();
  });
});

describe('the settle-time trigger', () => {
  it('checks the launch that just settled rather than rediscovering it', () => {
    const l = loop();
    // A newer launch exists whose host record is missing. Naming the launch is
    // what keeps the settle check on the run it is about.
    settled('mason', 'rev:mason:1:1:1793000000000');
    settled('mason', 'rev:mason:1:2:1793900000000', {
      provider_session_id: 'cccccccc-1111-2222-3333-444444444444', ended_at: '2026-10-29T23:00:00.000Z',
    });
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });

    expect(checkOnSettle(l, 'claude', 'rev:mason:1:1:1793000000000')).toEqual({
      state: 'verified', line: 'verified rev:mason:1:1:1793000000000',
    });
    expect(checkOnSettle(l, 'claude', 'rev:mason:1:2:1793900000000')?.state).toBe('stale');
    // And it does nothing at all on a path it does not implement.
    expect(checkOnSettle(l, 'codex', 'rev:mason:1:1:1793000000000')).toBeNull();
  });

  it('reports rather than throws when the launch it is handed does not exist', () => {
    expect(checkOnSettle(loop(), 'claude', 'rev:mason:1:404:0')).toMatchObject({ state: 'stale' });
  });
});

describe('installations that share a seat name', () => {
  it('each read their own launch, and their path ids stay apart', () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });
    const first = checkClaudePath(l);

    const second = mkdtempSync(join(tmpdir(), 'rev-coverage-other-'));
    process.env['REV_HOME'] = second;
    // Same seat name, same working tree, a different installation: its own
    // journal is empty, so it has no launch to check and must not borrow one.
    const other = checkClaudePath(l);

    expect(first.state).toBe('verified');
    expect(other.state).toBe('stale');
    expect(other.historical).toBeNull();
    expect(other.id).not.toBe(first.id);
    expect(other.last_verified_at).toBeNull();
    expect(first.last_verified_at).not.toBeNull();
  });
});

describe('the whole reading', () => {
  it('keeps every unsupported path visible, with the reason and no invented verdict', async () => {
    const l = loop();
    settled('mason', 'rev:mason:1:1:1793000000000');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });
    const codexSeat = loop({
      name: 'rolo', seat: 'rolo', runtime: 'codex',
      choices: [{ provider: 'codex', runtime: 'codex', model: 'gpt-6' }],
    });
    const reading = await coverageReading({ global: {} as never, loops: { mason: l, rolo: codexSeat }, providers: {} });

    const ids = reading.paths.map((p) => `${p.seat}:${p.runtime}`);
    expect(ids).toContain('mason:claude');
    expect(ids).toContain('rolo:codex');
    expect(ids).toContain('*:summon');
    const codex = reading.paths.find((p) => p.runtime === 'codex')!;
    expect(codex.state).toBe('unsupported');
    expect(codex.assertions).toEqual([]);
    expect(codex.note).toContain('real and unchecked');
    expect(reading.summary.verified).toBe(1);
    expect(reading.summary.unsupported).toBe(2);
    expect(reading.scope).toContain('~/.claude/CLAUDE.md');
    expect(reading.schema).toBe('helmo.context-coverage.v1');
  });

  it('checks both routes of a seat whose rotation spans two adapters', () => {
    // The inventory's correction 1: a seat configured `runtime: codex` with a
    // claude choice in its rotation runs on both, and reporting only the
    // primary hid a file every Claude run receives.
    const spanning = loop({
      runtime: 'codex',
      choices: [{ provider: 'codex', runtime: 'codex', model: 'gpt-6' }],
      fallbacks: [{ provider: 'claude', runtime: 'claude', model: 'claude-opus-5' }],
    });

    expect(pathRuntimes(spanning)).toEqual(['claude', 'codex']);
  });

  // The journal records the roster's PROVIDER name, not the adapter. They are
  // the same word for the two providers Rev ships and are not for a provider
  // entry that names its own runtime, so a launch under one must not read as a
  // path that has never run.
  it('finds a launch recorded under a differently named provider on the same adapter', () => {
    const l = loop({
      choices: [{ provider: 'claude-metered', runtime: 'claude', model: 'claude-opus-5' }],
      fallbacks: [],
    });
    expect(pathProviders(l, 'claude')).toEqual(['claude', 'claude-metered']);
    settled('mason', 'rev:mason:1:1:1793000000000', { provider: 'claude-metered' });
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });

    expect(checkClaudePath(l).state).toBe('verified');
  });

  it('says what the account is scoped to rather than leaving it implied', () => {
    expect(summonPath('fixture.rev').supported).toBe(false);
    expect(summonPath('fixture.rev').state).toBe('unsupported');
    expect(summonPath('fixture.rev').note).toContain('no join key');
  });
});
