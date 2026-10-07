import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  seatContext, seatSpend, spendBasis, workingTreeInstructions, isPeriod, readBounded,
  tokenizeWork, chunkPattern, MEASURE_BYTE_CEILING, TOKENIZE_WORK_CEILING, WORKING_LEVEL,
} from '../src/team.js';
import type { LoopConfig } from '../src/types.js';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const line = (iso: string, loop: string, model: string, tokens: string, cost: string, runtime = 'codex') =>
  `${iso} loop=${loop} runtime=${runtime} model=${model} tokens=${tokens} cost_usd=${cost}`;

let home: string;
let log: string;
let tree: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rev-team-'));
  process.env['REV_HOME'] = home;
  log = join(home, 'token-log');
  tree = mkdtempSync(join(tmpdir(), 'rev-team-tree-'));
});

function loop(over: Partial<LoopConfig> = {}): LoopConfig {
  return {
    name: 'mason', seat: 'mason', peer_sessions: [], workstream: 'estate-ui',
    cwd: tree, runtime: 'claude', model: 'claude-opus-5',
    constitution: join(tree, 'PROFILE.md'), version: '1', pace: 1, idle_floor_s: 0,
    choices: [], fallbacks: [], ...over,
  } as LoopConfig;
}

describe('seatContext', () => {
  it('counts what Rev composes apart from what the CLI finds, and the startup total is their sum', async () => {
    mkdirSync(join(tree, 'nested'), { recursive: true });
    writeFileSync(join(tree, '.git'), 'a repository boundary the walk stops at');
    writeFileSync(join(tree, 'PROFILE.md'), '---\ncap_tokens: 500\n---\nthe seat itself');
    writeFileSync(join(tree, 'skill.md'), 'a roster skill appended at spawn');
    writeFileSync(join(tree, 'CLAUDE.md'), 'what the CLI finds for itself');
    const c = await seatContext(loop({ cwd: tree, skills: [join(tree, 'skill.md')] }));

    expect(c.composed.profile?.tokens).toBeGreaterThan(0);
    expect(c.composed.skills).toHaveLength(1);
    expect(c.composed.tokens).toBe(c.composed.profile!.tokens + c.composed.skills[0]!.tokens);
    expect(c.discovered.files.map((f) => f.name)).toEqual(['CLAUDE.md']);
    expect(c.discovered.tokens).toBe(c.discovered.files[0]!.tokens);
    expect(c.startup_tokens).toBe(c.composed.tokens + c.discovered.tokens);
    // Both halves are non-zero, so the sum is not accidentally one of them.
    expect(c.composed.tokens).toBeGreaterThan(0);
    expect(c.discovered.tokens).toBeGreaterThan(0);
  });

  it('reads cap_tokens from the file itself, and grades ok / tight / over against it', async () => {
    const body = 'word '.repeat(100);
    writeFileSync(join(tree, 'PROFILE.md'), `---\ncap_tokens: 1000\n---\n${body}`);
    expect((await seatContext(loop())).composed.profile?.state).toBe('ok');

    // A cap this file sits one token under: inside it, past the working level.
    const tokens = (await seatContext(loop())).composed.profile!.tokens;
    writeFileSync(join(tree, 'PROFILE.md'), `---\ncap_tokens: ${tokens + 1}\n---\n${body}`);
    const tight = await seatContext(loop());
    expect(tight.composed.profile!.tokens).toBeLessThan(tight.composed.profile!.cap!);
    expect(tight.composed.profile!.tokens).toBeGreaterThan(Math.round(tight.composed.profile!.cap! * WORKING_LEVEL));
    expect(tight.composed.profile!.state).toBe('tight');

    writeFileSync(join(tree, 'PROFILE.md'), `---\ncap_tokens: 10\n---\n${body}`);
    expect((await seatContext(loop())).composed.profile?.state).toBe('over');
  });

  it('declares a file with no cap uncapped rather than passing it as ok', async () => {
    writeFileSync(join(tree, 'PROFILE.md'), 'no front matter at all');
    const c = await seatContext(loop());
    expect(c.composed.profile?.cap).toBeNull();
    expect(c.composed.profile?.state).toBe('uncapped');
  });

  it('reports an unreadable file as unreadable, never as a zero inside the total', async () => {
    const c = await seatContext(loop({ constitution: join(tree, 'absent.md') }));
    expect(c.composed.profile?.state).toBe('unreadable');
    expect(c.composed.profile?.error).toBeTruthy();
    expect(c.startup_tokens).toBe(0);
  });

  it('names a file past the byte ceiling rather than claiming a token count for it', async () => {
    writeFileSync(join(tree, 'PROFILE.md'), 'word '.repeat(MEASURE_BYTE_CEILING / 4));
    const c = await seatContext(loop());
    expect(c.composed.profile?.state).toBe('unreadable');
    expect(c.composed.profile?.tokens).toBe(0);
    // Its size is the reading that IS available, so it is reported.
    expect(c.composed.profile?.bytes).toBeGreaterThan(MEASURE_BYTE_CEILING);
    expect(c.composed.profile?.error).toMatch(/ceiling/);
    expect(c.startup_tokens).toBe(0);
  });

  it('refuses to tokenize a file whose runs are long enough to hold the event loop', async () => {
    // 16KB of one unbroken character measures 15s on this encoding — the BPE
    // merge loop is quadratic in a single chunk, and this read is synchronous,
    // so the cost lands on every route of the app (H-3004). The elapsed
    // assertion is the real one: it fails by timing out, which is the reported
    // failure, not a proxy for it.
    writeFileSync(join(tree, 'PROFILE.md'), 'x'.repeat(16_384));
    const started = Date.now();
    const c = await seatContext(loop());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(c.composed.profile?.state).toBe('unreadable');
    expect(c.composed.profile?.tokens).toBe(0);
    expect(c.composed.profile?.bytes).toBe(16_384);
    expect(c.startup_tokens).toBe(0);
  });

  it('refuses a file whose one chunk is whitespace the first guard did not count', async () => {
    // 16KB of U+3000 alternating with LF: one chunk to the encoder, because the
    // chunk pattern's whitespace branch is `\s`, which U+3000 is. The first
    // version of this guard split runs on space/tab/CR/LF only, so it saw 8,000
    // runs of one character, passed the file, counted it at 4,000 tokens, and
    // held the member route 39 seconds (H-3007). Well under the byte ceiling,
    // which is the point: size says nothing about cost.
    writeFileSync(join(tree, 'PROFILE.md'), '\u3000\n'.repeat(4_000));
    const started = Date.now();
    const c = await seatContext(loop());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(c.composed.profile?.state).toBe('unreadable');
    expect(c.composed.profile?.tokens).toBe(0);
    expect(c.composed.profile?.bytes).toBe(16_000);
    expect(c.composed.profile?.bytes).toBeLessThan(MEASURE_BYTE_CEILING);
    expect(c.startup_tokens).toBe(0);
  });

  it('measures a file that names a special token instead of refusing the whole page', async () => {
    // `encode` throws by default on text containing `<|endoftext|>`, and that
    // throw left `measure` entirely: any instruction file mentioning one — a
    // sentence about tokenizers is enough — answered every Team route a 500.
    writeFileSync(join(tree, 'PROFILE.md'), 'The literal <|endoftext|> is text here, not a token.');
    const c = await seatContext(loop());
    expect(c.composed.profile?.state).toBe('uncapped');
    expect(c.composed.profile?.tokens).toBeGreaterThan(5);
    expect(c.startup_tokens).toBe(c.composed.profile?.tokens);
  });

  it('measures ordinary prose far larger than that, because size is not what costs', async () => {
    // The ceiling is on the tokenizer's work, not the file's size: a quarter of
    // a megabyte of prose is cheap and must still be measured, or the guard
    // would report this installation's own configuration as unreadable.
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(5_000);
    writeFileSync(join(tree, 'PROFILE.md'), prose);
    expect(tokenizeWork(prose, await chunkPattern())).toBeLessThan(TOKENIZE_WORK_CEILING);
    const c = await seatContext(loop());
    expect(c.composed.profile?.state).toBe('uncapped');
    expect(c.composed.profile?.tokens).toBeGreaterThan(40_000);
  });

  it('inventories the memory corpus as available, and keeps it out of the startup total', async () => {
    writeFileSync(join(tree, 'PROFILE.md'), 'the seat');
    const memory = join(tree, 'memory');
    mkdirSync(memory);
    writeFileSync(join(memory, 'MEMORY.md'), '---\ncap_tokens: 1200\n---\nthe index');
    for (let i = 0; i < 40; i += 1) writeFileSync(join(memory, `m${i}.md`), 'lesson '.repeat(400));
    const c = await seatContext(loop({ memory_dir: memory }));

    expect(c.memory.configured).toBe(true);
    expect(c.memory.files).toBe(41);
    expect(c.memory.index?.name).toBe('MEMORY.md');
    // The corpus dwarfs the startup reading; counting it in would be the defect.
    expect(c.memory.tokens).toBeGreaterThan(c.startup_tokens * 10);
    expect(c.startup_tokens).toBe(c.composed.tokens + c.discovered.tokens);
  });

  it('says so when no memory directory is configured, instead of reporting an empty corpus', async () => {
    writeFileSync(join(tree, 'PROFILE.md'), 'the seat');
    const c = await seatContext(loop());
    expect(c.memory.configured).toBe(false);
    expect(c.memory.note).toMatch(/No memory directory is configured/);
  });

  it('invents no session cap and names the overhead it cannot measure', async () => {
    writeFileSync(join(tree, 'PROFILE.md'), 'the seat');
    const c = await seatContext(loop());
    expect(c.session_cap).toBeNull();
    expect(c.unmeasured.length).toBeGreaterThan(0);
    expect(c.unmeasured.join(' ')).toMatch(/system prompt/);
    expect(c.tokenizer).toBe('js-tiktoken o200k_base');
  });
});

describe('workingTreeInstructions', () => {
  it('walks up to the enclosing repository and stops there', () => {
    const repo = join(tree, 'repo');
    const deep = join(repo, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(repo, '.git'), 'boundary');
    writeFileSync(join(tree, 'CLAUDE.md'), 'above the repository — out of the tree');
    writeFileSync(join(repo, 'CLAUDE.md'), 'the repository root');
    writeFileSync(join(deep, 'CLAUDE.md'), 'the working directory');
    const found = workingTreeInstructions(deep, 'claude');
    expect(found).toEqual([join(deep, 'CLAUDE.md'), join(repo, 'CLAUDE.md')]);
  });

  it('asks for each runtime its own instruction filenames, and nothing for a runtime with none', () => {
    writeFileSync(join(tree, '.git'), 'boundary');
    writeFileSync(join(tree, 'CLAUDE.md'), 'claude');
    writeFileSync(join(tree, 'AGENTS.md'), 'both');
    expect(workingTreeInstructions(tree, 'codex').map((p) => p.split('/').pop())).toEqual(['AGENTS.md']);
    expect(workingTreeInstructions(tree, 'claude').map((p) => p.split('/').pop())).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(workingTreeInstructions(tree, 'mock')).toEqual([]);
  });
});

describe('readBounded', () => {
  it('refuses a symbolic link at the open rather than by a stat a later open could race', () => {
    const outside = join(tree, 'outside.txt');
    writeFileSync(outside, 'OUTSIDE');
    symlinkSync(outside, join(tree, 'link.md'));
    const read = readBounded(join(tree, 'link.md'), 1_000);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/symbolic link/);
  });

  it('refuses what is not a regular file by what fstat says, not by what the read happens to fail with', () => {
    // A directory opens read-only on macOS and fails at the read with EISDIR —
    // whose message also contains the word “directory”, so an assertion
    // looking for that passed with the guard removed. The wording asserted
    // here is the guard's own, which no accidental errno produces.
    mkdirSync(join(tree, 'adir'), { recursive: true });
    const dir = readBounded(join(tree, 'adir'), 1_000);
    expect(dir.ok).toBe(false);
    if (dir.ok) return;
    expect(dir.error).toBe('This path is a directory, so it is named here rather than read.');
  });

  it('cuts at the limit while reporting the file’s whole size', () => {
    writeFileSync(join(tree, 'long.md'), 'abcdefghij'.repeat(100));
    const read = readBounded(join(tree, 'long.md'), 64);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text.length).toBe(64);
    expect(read.truncated).toBe(true);
    expect(read.bytes).toBe(1_000);
  });

  it('reports an absent file rather than throwing into the route', () => {
    const read = readBounded(join(tree, 'absent.md'), 64);
    expect(read.ok).toBe(false);
  });
});

describe('tokenizeWork', () => {
  it('costs one chunk the square of its bytes, so a long one is refused and prose of the same size is not', async () => {
    // 1,000 of one character is one chunk, 1,000,000; 1,000 characters of
    // five-letter words is 200 chunks of six bytes. Same size, four orders
    // apart in what the merge loop does with them.
    const chunks = await chunkPattern();
    expect(tokenizeWork('x'.repeat(1_000), chunks)).toBe(1_000_000);
    expect(tokenizeWork('word '.repeat(200), chunks)).toBeLessThan(10_000);
  });

  it('counts a whitespace chunk too, which is as expensive as any other', async () => {
    // 32KB of spaces measured 94s: the chunk the merge loop sees is whatever
    // the pattern made, and `\s+` makes one of the lot.
    expect(tokenizeWork(' '.repeat(1_000), await chunkPattern())).toBe(1_000_000);
  });

  it('sees every whitespace the pattern does, not a hand-written list of four', async () => {
    // The H-3007 FAIL. Each of these alternating with LF is ONE chunk to the
    // encoder: the pattern's branch is `\s*[\r\n]+`, and `\s` covers all of
    // them. A guard that classified whitespace itself scored each of these
    // 2,000 and passed; the encoder spent 18s on the first.
    const chunks = await chunkPattern();
    for (const space of ['\u3000', '\u00a0', '\u000b', '\u000c', '\u2028', '\u2029', '\u202f', '\u205f', '\ufeff']) {
      const text = `${space}\n`.repeat(1_000);
      expect(tokenizeWork(text, chunks)).toBe(Buffer.byteLength(text, 'utf8') ** 2);
    }
  });

  it('measures a chunk in UTF-8 bytes, because that is what the merge loop walks', async () => {
    // 1,400 CJK letters are 1,400 UTF-16 units and 4,200 bytes; the encoder
    // spent 0.9s on them, nine times what the character count predicts.
    expect(tokenizeWork('\u4e00'.repeat(1_400), await chunkPattern())).toBe(4_200 ** 2);
  });

  it('is the encoder\'s own pattern, so the two cannot drift apart', async () => {
    // Not a copy of the pattern: a bound computed over a different split is not
    // a bound. If a js-tiktoken upgrade stops exposing `patStr`, this goes red
    // here rather than silently in whatever the next hostile shape is.
    const { getEncoding } = await import('js-tiktoken');
    const internal = getEncoding('o200k_base') as unknown as { patStr?: string };
    expect(typeof internal.patStr).toBe('string');
    expect((await chunkPattern()).source).toBe(internal.patStr);
    expect((await chunkPattern()).flags).toContain('u');
  });

  it('scans a megabyte of the worst shape far faster than the encoder would', async () => {
    // The guard has to be cheap on exactly the inputs it refuses, or it is the
    // stall it was meant to prevent.
    const chunks = await chunkPattern();
    const started = Date.now();
    expect(tokenizeWork(' '.repeat(1_048_576), chunks)).toBeGreaterThan(TOKENIZE_WORK_CEILING);
    expect(tokenizeWork('the quick brown fox jumps over a lazy dog. '.repeat(25_000), chunks)).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('seatSpend', () => {
  beforeEach(() => {
    writeFileSync(log, [
      line('2026-10-07T11:00:00.000Z', 'mason', 'gpt-5.6-sol', '1000', '1.00'),
      line('2026-10-06T11:00:00.000Z', 'mason', 'gpt-5.6-sol', '2000', '2.00'),
      line('2026-10-02T11:00:00.000Z', 'mason', 'claude-opus-5', '4000', '4.00', 'claude'),
      line('2026-08-01T11:00:00.000Z', 'mason', 'gpt-5.6-sol', '8000', '8.00'),
      line('2026-10-07T11:30:00.000Z', 'ward', 'gpt-6-astra', '9999', '99.00'),
    ].join('\n') + '\n');
  });

  it('windows one loop only, and the period is what decides the total', () => {
    expect(seatSpend('mason', '24h', NOW, log)).toMatchObject({ tokens: 1000, usd: 1, sessions: 1 });
    expect(seatSpend('mason', '7d', NOW, log)).toMatchObject({ tokens: 7000, usd: 7, sessions: 3 });
    expect(seatSpend('mason', 'all', NOW, log)).toMatchObject({ tokens: 15000, usd: 15, sessions: 4 });
    expect(seatSpend('mason', 'all', NOW, log).since).toBeNull();
    expect(seatSpend('ward', '24h', NOW, log).tokens).toBe(9999);
  });

  it('counts a session the CLI did not meter rather than totalling it as free', () => {
    writeFileSync(log, [
      line('2026-10-07T11:00:00.000Z', 'mason', 'gpt-5.6-sol', '1000', '1.00'),
      line('2026-10-07T11:05:00.000Z', 'mason', 'gpt-5.6-sol', '?', '?'),
    ].join('\n') + '\n');
    const s = seatSpend('mason', '24h', NOW, log);
    expect(s.sessions).toBe(2);
    expect(s.unknown_sessions).toBe(1);
    expect(s.tokens).toBe(1000);
    expect(s.usd).toBe(1);
  });

  it('breaks the window down by model and by day, oldest day first', () => {
    const s = seatSpend('mason', '7d', NOW, log);
    expect(s.by_model.map((m) => [m.model, m.tokens])).toEqual([
      ['claude-opus-5', 4000], ['gpt-5.6-sol', 3000],
    ]);
    expect(s.by_model.find((m) => m.model === 'claude-opus-5')?.runtime).toBe('claude');
    expect(s.by_day.map((d) => d.day)).toEqual(['2026-10-02', '2026-10-06', '2026-10-07']);
    expect(s.by_day.at(-1)).toEqual({ day: '2026-10-07', tokens: 1000, usd: 1 });
  });

  it('reads an absent log as no spend rather than failing the page', () => {
    expect(seatSpend('mason', '7d', NOW, join(home, 'no-such-log'))).toMatchObject({ tokens: 0, sessions: 0, by_day: [] });
  });
});

describe('spendBasis', () => {
  const roster = (billing: string) => ({
    global: {}, loops: {},
    providers: { codex: { name: 'codex', runtime: 'codex', billing, models: {} } },
  }) as never;

  it('says the dollars are notional and not subscription cash', () => {
    const basis = spendBasis(roster('metered'));
    expect(basis.dollars).toMatch(/Notional, not cash/);
    expect(basis.dollars).toMatch(/Neither is invoiced subscription spend/i);
  });

  it('names a provider the roster declares subscription-billed', () => {
    expect(spendBasis(roster('subscription')).dollars).toMatch(/codex is declared subscription-billed/);
    expect(spendBasis(roster('metered')).dollars).not.toMatch(/declared subscription-billed/);
  });

  it('refuses to imply an input/output/cache split the log does not carry', () => {
    const basis = spendBasis(roster('metered'));
    expect(basis.tokens).toMatch(/no input\/output\/cache split|none is shown/);
    expect(basis.coverage).toMatch(/not in these numbers/);
  });
});

describe('isPeriod', () => {
  it('admits only the offered periods, so a query string cannot widen the window', () => {
    expect(isPeriod('7d')).toBe(true);
    expect(isPeriod('all')).toBe(true);
    expect(isPeriod('99d')).toBe(false);
    expect(isPeriod(undefined)).toBe(false);
    // `'__proto__' in PERIODS` is true, and the window it produced dated to
    // NaN rather than falling back (H-3004).
    for (const name of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(isPeriod(name)).toBe(false);
    }
  });
});
