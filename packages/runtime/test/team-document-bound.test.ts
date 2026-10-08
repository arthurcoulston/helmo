// What one document build measures, and how often.
//
// Its own file for the same reason as team-tokenizer.test.ts: the encoding is
// memoised on first use, so a mock applied after any other case here has
// measured something is never reached. This one counts `encode` calls, which is
// the only way to tell "measured once and reused" from "measured twice and
// agreed".
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoopConfig } from '../src/types.js';

const encoded: string[] = [];

// The real pattern and the real ranks — only instrumented. A mock that returned
// a made-up token count would make every figure below meaningless.
vi.mock('js-tiktoken', async () => {
  const actual = await vi.importActual<typeof import('js-tiktoken')>('js-tiktoken');
  const real = actual.getEncoding('o200k_base');
  return {
    getEncoding: () => ({
      patStr: (real as unknown as { patStr: string }).patStr,
      encode: (text: string, allowed?: unknown, disallowed?: unknown) => {
        encoded.push(text);
        return (real.encode as (t: string, a?: unknown, d?: unknown) => number[])(text, allowed, disallowed);
      },
    }),
  };
});

let shared: string;
let seats: string;

beforeEach(() => {
  encoded.length = 0;
  process.env['REV_HOME'] = mkdtempSync(join(tmpdir(), 'rev-team-doc-'));
  // The real crew layout: one repository, a shared instruction file at its
  // root, and each seat's working directory below it.
  shared = mkdtempSync(join(tmpdir(), 'rev-team-doc-tree-'));
  writeFileSync(join(shared, '.git'), 'a repository boundary the walk stops at');
  writeFileSync(join(shared, 'AGENTS.md'), 'the instruction file every seat walks up to');
  seats = join(shared, 'agents');
  mkdirSync(seats, { recursive: true });
});

function loop(name: string, over: Partial<LoopConfig> = {}): LoopConfig {
  const cwd = join(seats, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'PROFILE.md'), `the ${name} seat itself`);
  return {
    name, seat: name, peer_sessions: [], workstream: 'estate-ui',
    cwd, runtime: 'claude', model: 'claude-opus-5',
    constitution: join(cwd, 'PROFILE.md'), version: '1', pace: 1, idle_floor_s: 0,
    choices: [], fallbacks: [], ...over,
  } as LoopConfig;
}

describe('one measurement pass per document', () => {
  it('measures a path several seats share once, and reports it to all of them', async () => {
    const { seatContext, measurePass } = await import('../src/team.js');
    const pass = measurePass();

    const contexts = await Promise.all(
      ['mason', 'ward', 'proof', 'gauge'].map((n) => seatContext(loop(n), pass)),
    );

    // Four seats, four profiles, one shared ancestor: five measurements, not
    // eight. This is the live installation's own shape — `crew:AGENTS.md` was
    // being tokenized ten times per request (H-3011).
    const ancestor = join(shared, 'AGENTS.md');
    expect(encoded).toHaveLength(5);
    expect(pass.files.size).toBe(5);
    for (const c of contexts) {
      expect(c.discovered.files.map((f) => f.path)).toEqual([ancestor]);
      expect(c.discovered.files[0]!.tokens).toBeGreaterThan(0);
    }
    // Every seat got the same reading, because it is the same reading.
    const tokens = new Set(contexts.map((c) => c.discovered.files[0]!.tokens));
    expect(tokens.size).toBe(1);
  });

  it('measures it once per seat when each seat gets its own pass — the control', async () => {
    // Without this the case above would pass on a page that never shared
    // anything, and the defect it fixes would be invisible.
    const { seatContext } = await import('../src/team.js');

    await Promise.all(['mason', 'ward', 'proof', 'gauge'].map((n) => seatContext(loop(n))));

    expect(encoded).toHaveLength(8);
  });

  it('is not fooled by a second spelling of the same path', async () => {
    const { seatContext, measurePass } = await import('../src/team.js');
    const pass = measurePass();
    const mason = loop('mason');
    // The same file, reached by walking down and back up, and built by
    // concatenation on purpose: `path.join` would normalize `..` away here and
    // the two spellings would already be one string, which is a test of
    // nothing. `resolve` inside `measure` is what has to do the work.
    const detour = `${seats}/mason/../mason//PROFILE.md`;

    const direct = await seatContext(mason, pass);
    const same = await seatContext({ ...mason, constitution: detour } as LoopConfig, pass);

    expect(encoded.filter((t) => t === 'the mason seat itself')).toHaveLength(1);
    expect(same.composed.profile?.path).toBe(direct.composed.profile?.path);
    expect(same.composed.profile?.tokens).toBe(direct.composed.profile?.tokens);
  });

  it('does not let a link share its target’s reading', async () => {
    // The reason the key is `resolve` and not `realpath`. Under `realpath` both
    // of these collapse to one entry, and whichever was asked for first answers
    // for both — so a planted link gets served the real file's token count,
    // which is exactly what `readBounded`'s O_NOFOLLOW refuses it. Measured
    // twice is the right answer here.
    const { seatContext, measurePass } = await import('../src/team.js');
    const pass = measurePass();
    const target = join(shared, 'real-skill.md');
    writeFileSync(target, 'a skill that is a real file');
    const link = join(shared, 'link-skill.md');
    symlinkSync(target, link);

    const c = await seatContext(loop('mason', { skills: [target, link] }), pass);

    expect(c.composed.skills[0]!.state).toBe('uncapped');
    expect(c.composed.skills[0]!.tokens).toBeGreaterThan(0);
    expect(c.composed.skills[1]!.state).toBe('unreadable');
    expect(c.composed.skills[1]!.tokens).toBe(0);
    expect(c.composed.skills[1]!.error).toMatch(/symbolic link/);
  });
});

describe('the document work budget', () => {
  it('names the budget on the files past it, and keeps the ones inside it', async () => {
    const { seatContext, measurePass, tokenizeWork, chunkPattern, TOKENIZE_WORK_CEILING } = await import('../src/team.js');
    const chunks = await chunkPattern();
    const body = 'instruction prose that costs something to tokenize. '.repeat(40);
    const work = tokenizeWork(body, chunks);
    expect(work).toBeLessThan(TOKENIZE_WORK_CEILING); // each file is admissible alone
    for (const n of ['a', 'b', 'c']) writeFileSync(join(shared, `skill-${n}.md`), body);
    // Room for the profile, which is measured first, and two of the three
    // skills. Counted rather than guessed: a budget that happened to cut one
    // file early would still look like this test passing.
    const pass = measurePass(tokenizeWork('the mason seat itself', chunks) + work * 2);

    const c = await seatContext(
      loop('mason', { skills: ['a', 'b', 'c'].map((n) => join(shared, `skill-${n}.md`)) }),
      pass,
    );

    // The profile and the shared ancestor are measured first and are tiny, so
    // the cut lands inside the skills: two counted, the third named.
    const states = c.composed.skills.map((f) => f.state);
    expect(states).toEqual(['uncapped', 'uncapped', 'unreadable']);
    expect(c.composed.skills[2]!.tokens).toBe(0);
    expect(c.composed.skills[2]!.bytes).toBeGreaterThan(0);
    expect(c.composed.skills[2]!.error).toMatch(/already spent its [\d,]+-unit tokenizer budget/);
    // The budget cuts a count, never invents one: the total is the two files
    // that were measured plus the headers written before all three, and the
    // third file is reported, not folded in as a zero. The headers are composed
    // rather than read, so a spent budget does not withhold them.
    expect(c.composed.framing.tokens).toBeGreaterThan(0);
    expect(c.composed.tokens).toBe(
      c.composed.profile!.tokens + c.composed.skills[0]!.tokens + c.composed.skills[1]!.tokens + c.composed.framing.tokens,
    );
    expect(pass.work).toBeLessThanOrEqual(pass.budget);
  });

  it('does not spend the budget on a file the per-file ceiling refuses', async () => {
    const { seatContext, measurePass, TOKENIZE_WORK_CEILING } = await import('../src/team.js');
    // One chunk past the per-file ceiling: refused before any tokenizing, so
    // the document still has its whole budget for the files after it.
    writeFileSync(join(shared, 'skill-huge.md'), 'x'.repeat(Math.ceil(Math.sqrt(TOKENIZE_WORK_CEILING)) + 1));
    writeFileSync(join(shared, 'skill-small.md'), 'a skill that comes after it');
    const pass = measurePass();

    const c = await seatContext(
      loop('mason', { skills: [join(shared, 'skill-huge.md'), join(shared, 'skill-small.md')] }),
      pass,
    );

    expect(c.composed.skills[0]!.state).toBe('unreadable');
    expect(c.composed.skills[0]!.error).toMatch(/chunked too coarsely/);
    expect(c.composed.skills[1]!.state).toBe('uncapped');
    expect(c.composed.skills[1]!.tokens).toBeGreaterThan(0);
    // Nothing the ceiling refused is in the figure.
    expect(pass.work).toBeLessThan(TOKENIZE_WORK_CEILING);
  });

  it('leaves this installation’s whole document two orders of magnitude inside the budget', async () => {
    const { TOKENIZE_DOCUMENT_BUDGET, TOKENIZE_WORK_CEILING } = await import('../src/team.js');
    // The two facts the figure rests on, asserted so a later change to either
    // constant has to re-read the reasoning rather than drift past it: the
    // budget is six worst-admitted files (ward measured six at 1.4s), and the
    // live document measures 361,534 — a sixty-sixth of it.
    expect(TOKENIZE_DOCUMENT_BUDGET).toBe(TOKENIZE_WORK_CEILING * 6);
    expect(361_534 * 60).toBeLessThan(TOKENIZE_DOCUMENT_BUDGET);
  });
});
