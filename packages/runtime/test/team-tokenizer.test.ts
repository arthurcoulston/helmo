// What the Team projection does when the tokenizer itself fails.
//
// Its own file, because the encoding is memoised on first use: a mock applied
// after any other case in team.test.ts has measured something would never be
// reached. Vitest gives each file its own module graph, so this one is the only
// place the encoder can be made hostile.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoopConfig } from '../src/types.js';

// Only `encode` is hostile: the real chunk pattern, so the work bound passes
// and the failure lands where it is being tested. A corrupt rank table and a
// text the encoder refuses both arrive here.
vi.mock('js-tiktoken', async () => {
  const actual = await vi.importActual<typeof import('js-tiktoken')>('js-tiktoken');
  const real = actual.getEncoding('o200k_base') as unknown as { patStr: string };
  return {
    getEncoding: () => ({
      patStr: real.patStr,
      encode: () => { throw new Error('the ranks are corrupt'); },
    }),
  };
});

let tree: string;

beforeEach(() => {
  process.env['REV_HOME'] = mkdtempSync(join(tmpdir(), 'rev-team-tok-'));
  tree = mkdtempSync(join(tmpdir(), 'rev-team-tok-tree-'));
  writeFileSync(join(tree, '.git'), 'a repository boundary the walk stops at');
});

function loop(over: Partial<LoopConfig> = {}): LoopConfig {
  return {
    name: 'mason', seat: 'mason', peer_sessions: [], workstream: 'estate-ui',
    cwd: tree, runtime: 'claude', model: 'claude-opus-5',
    constitution: join(tree, 'PROFILE.md'), version: '1', pace: 1, idle_floor_s: 0,
    choices: [], fallbacks: [], ...over,
  } as LoopConfig;
}

describe('a tokenizer that throws', () => {
  it('makes one file unreadable rather than taking the page down with it', async () => {
    // A throw out of `measure` leaves the document builder and answers every
    // Team route a 500 — and the throw is reachable by anyone who can write a
    // file the inventory finds, which is the whole H-3004 threat. So the
    // tokenizer's failure has to be this file's state, with its reason.
    const { seatContext } = await import('../src/team.js');
    writeFileSync(join(tree, 'PROFILE.md'), 'ordinary instruction prose');

    const context = await seatContext(loop());

    expect(context.composed.profile?.state).toBe('unreadable');
    expect(context.composed.profile?.tokens).toBe(0);
    expect(context.composed.profile?.bytes).toBe(26);
    expect(context.composed.profile?.error).toMatch(/could not measure this file: the ranks are corrupt/);
    // The rest of the document is still a document.
    expect(context.startup_tokens).toBe(0);
    expect(context.tokenizer).toBeTruthy();
  });
});
