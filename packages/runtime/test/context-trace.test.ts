// The acceptance for R-55's per-invocation context trace (H-3724).
//
// Every record here is a disposable fixture written into a temp directory. The
// operator's own transcripts are never read: the reader's whole job is to
// report what a host retained, so a test that read a live session would be
// asserting against a file nothing in this repo controls, and would go red on
// the next host upgrade for the right reason at the wrong time.
//
// The fixtures are small, but their SHAPES are taken from real records on the
// machine this was built against — claude-code 2.1.300's base/keep/tail delta
// chain and its compact_boundary metadata, codex 0.164's session_meta,
// world_state, turn_context and compacted entries. Where a fixture departs
// from the real shape, the test says so.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextTrace, findCodexRecord, harnessOf, TRACE_CATEGORIES, type ContextTrace } from '../src/context-trace.js';

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved['CODEX_HOME'] = process.env['CODEX_HOME'];
  dir = mkdtempSync(join(tmpdir(), 'rev-trace-'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, entries: unknown[]): string => {
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
};

const trace = (path: string): ContextTrace => {
  const t = contextTrace(path);
  if ('error' in t) throw new Error(`expected a trace, got a refusal: ${t.error}`);
  return t;
};

const stateOf = (t: ContextTrace, category: string): string =>
  t.coverage.find((c) => c.category === category)?.state ?? 'absent';
const reasonOf = (t: ContextTrace, category: string): string =>
  t.coverage.find((c) => c.category === category)?.reason ?? '';

/** A claude record: one shape, then a delta chain of requests whose message
 *  lists are 2, 5 and 8 long — the growth a real session shows. */
function claudeRecord(over: { blobs?: boolean; compaction?: boolean } = {}): unknown[] {
  const shape = {
    type: 'api-request-shape', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    shapeHash: 'shape0', timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
    shape: {
      system: [{ type: 'text', text: 'host block one' }, { type: 'text', text: 'the appended composition' }],
      tools: [{ name: 'Bash' }, { name: 'Read' }],
    },
  };
  const blobs = over.blobs === false ? [] : ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((h) => ({
    type: 'api-request-blob', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    hash: h, message: { role: h === 'm0' ? 'user' : 'system', content: [{ type: 'text', text: h }] },
  }));
  const req = (id: string, base: string | null, keep: number, tail: string[], at: string) => ({
    type: 'api-request', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', id, timestamp: at,
    version: '2.1.300', shapeHash: 'shape0', cwd: '/tmp/seat',
    params: { model: 'claude-opus-5', context_management: { edits: [{ type: 'clear_thinking_20251015' }] } },
    ...(base === null ? {} : { base }), keep, tail,
    requestDigest: `digest-${id}`,
  });
  const entries: unknown[] = [
    shape, ...blobs,
    req('r0', null, 0, ['m0', 'm1'], '2026-10-29T08:00:01.000Z'),
    req('r1', 'r0', 2, ['m2', 'm3', 'm4'], '2026-10-29T08:00:02.000Z'),
    req('r2', 'r1', 5, ['m5', 'm6', 'm7'], '2026-10-29T08:00:03.000Z'),
  ];
  if (over.compaction) {
    entries.push({
      type: 'system', subtype: 'compact_boundary', isMeta: false,
      sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', timestamp: '2026-10-29T08:00:04.000Z',
      compactMetadata: {
        trigger: 'auto', preTokens: 1_000_000, postTokens: 50_000, cumulativeDroppedTokens: 950_000,
        preservedSegment: { headUuid: 'u1', anchorUuid: 'anchor-1', tailUuid: 'u3' },
        preservedMessages: { anchorUuid: 'anchor-1', uuids: ['u1', 'u2', 'u3'] },
      },
    });
    entries.push({
      type: 'user', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', isCompactSummary: true,
      timestamp: '2026-10-29T08:00:05.000Z',
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
    });
    // After a compaction the next call keeps only part of its base.
    entries.push(req('r3', 'r2', 2, ['m0'], '2026-10-29T08:00:06.000Z'));
  }
  return entries;
}

/** A codex rollout: session_meta, a full world_state, a partial one, two turns
 *  and a compaction. */
function codexRecord(over: { full?: boolean } = {}): unknown[] {
  const entries: unknown[] = [
    {
      type: 'session_meta', timestamp: '2026-10-29T04:00:00.000Z', ordinal: 0,
      payload: {
        session_id: '01a185da-8c88-7463-8b6f-cf9d0d6945cd', cwd: '/tmp/seat',
        cli_version: '0.164.0', model_provider: 'openai',
        base_instructions: { text: 'You are Codex.', provenance: { type: 'model', model: 'gpt-6-astra' } },
        git: { commit_hash: 'abc123', branch: 'main', repository_url: 'https://example.invalid/r.git' },
      },
    },
    {
      type: 'world_state', timestamp: '2026-10-29T04:00:01.000Z', ordinal: 1,
      payload: {
        full: true,
        state: {
          agents_md: { directory: '/tmp/seat', text: 'the repository rules' },
          host_skills: { body: 'the skills body', includeInstructions: true },
          tools: { mcp__helmo: '', mcp__node_repl: 'a repl' },
          top_level_tools: { 'functions.exec': 'sha-of-exec', clock: 'sha-of-clock' },
        },
      },
    },
  ];
  if (over.full !== false) {
    // The delta the real rollout writes when only the environment moved.
    entries.push({
      type: 'world_state', timestamp: '2026-10-29T04:30:00.000Z', ordinal: 2,
      payload: { full: false, state: { environments: { current_date: '2026-10-29' } } },
    });
  }
  entries.push(
    {
      type: 'turn_context', timestamp: '2026-10-29T04:00:02.000Z', ordinal: 3,
      payload: {
        turn_id: 'turn-1', model: 'gpt-6-astra', effort: 'xhigh', cwd: '/tmp/seat',
        collaboration_mode: { mode: 'default', settings: { developer_instructions: 'mode instructions' } },
      },
    },
    { type: 'response_item', timestamp: '2026-10-29T04:00:03.000Z', ordinal: 4, payload: { type: 'message' } },
    { type: 'response_item', timestamp: '2026-10-29T04:00:04.000Z', ordinal: 5, payload: { type: 'custom_tool_call' } },
    {
      type: 'token_usage_record', timestamp: '2026-10-29T04:00:05.000Z', ordinal: 6,
      payload: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } },
    },
    {
      type: 'compacted', timestamp: '2026-10-29T05:00:00.000Z', ordinal: 7,
      payload: {
        message: '', window_number: 1,
        first_window_id: 'w0', previous_window_id: 'w0', window_id: 'w1',
        compaction_response_id: 'resp_abc',
        replacement_history: [{}, {}],
        retained_context: {
          user_messages: [{}, {}], assistant_messages: [{}],
          user_messages_incomplete: false, assistant_messages_incomplete: true, incomplete: false,
        },
        latest_token_usage_record: {
          usage: { input_tokens: 240_000 },
          turn_token_usage: { input_tokens: 1_900_000 },
        },
      },
    },
    { type: 'turn_context', timestamp: '2026-10-29T05:00:01.000Z', ordinal: 8, payload: { turn_id: 'turn-2', model: 'gpt-6-astra' } },
  );
  return entries;
}

describe('which harness wrote a record', () => {
  it('is decided by what the record contains, not where it sits', () => {
    expect(harnessOf([{ type: 'api-request' }])).toBe('claude');
    expect(harnessOf([{ type: 'session_meta' }])).toBe('codex');
  });

  it('refuses a record it recognises as neither rather than reading it as one', () => {
    const path = write('mystery.jsonl', [{ type: 'something-else', hello: 1 }]);
    const t = contextTrace(path);
    expect('error' in t && t.error).toMatch(/harness that wrote it is unknown/);
  });

  it('refuses an empty record by naming it empty, which is a different repair', () => {
    const path = join(dir, 'empty.jsonl');
    writeFileSync(path, '');
    const t = contextTrace(path);
    expect('error' in t && t.error).toMatch(/no parseable entries/);
  });

  it('refuses a directory and a fifo by name rather than reading them', () => {
    const t = contextTrace(dir);
    expect('error' in t && t.error).toMatch(/directory/);
  });

  it('does not follow a symlink to a record', () => {
    const real = write('real.jsonl', claudeRecord());
    const link = join(dir, 'link.jsonl');
    symlinkSync(real, link);
    const t = contextTrace(link);
    expect('error' in t).toBe(true);
  });
});

describe('a claude record, per invocation', () => {
  it('reconstructs each call message list from base, keep and tail', () => {
    const t = trace(write('claude.jsonl', claudeRecord()));
    expect(t.invocations.map((i) => i.messages)).toEqual([2, 5, 8]);
    expect(t.invocations.map((i) => i.added)).toEqual([2, 3, 3]);
    expect(t.invocations.map((i) => i.removed)).toEqual([0, 0, 0]);
    expect(stateOf(t, 'invocations')).toBe('observed');
  });

  it('counts recoverable messages rather than assuming the content is there', () => {
    const withBlobs = trace(write('with.jsonl', claudeRecord()));
    expect(withBlobs.retained).toEqual({ referenced: 8, recoverable: 8, by_role: { user: 1, system: 7 } });
    expect(stateOf(withBlobs, 'additions')).toBe('observed');

    // The real case: a host that retains a blob only for the messages it
    // synthesizes. The trace must report the fraction, not round it up.
    const partial = claudeRecord({ blobs: false });
    partial.splice(1, 0, {
      type: 'api-request-blob', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      hash: 'm1', message: { role: 'system', content: [{ type: 'text', text: 'a system reminder' }] },
    });
    const t = trace(write('partial.jsonl', partial));
    expect(t.retained.recoverable).toBe(1);
    expect(t.retained.referenced).toBe(8);
    expect(stateOf(t, 'additions')).toBe('partial');
    expect(reasonOf(t, 'additions')).toMatch(/1 of 8/);
    expect(t.invocations.map((i) => i.recoverable)).toEqual([1, 1, 1]);
  });

  it('stops a chain at a base the record does not hold instead of guessing it', () => {
    const entries = claudeRecord().filter((e) => (e as { id?: string }).id !== 'r0');
    const t = trace(write('gap.jsonl', entries));
    expect(t.invocations.map((i) => i.messages)).toEqual([null, null]);
    expect(stateOf(t, 'invocations')).toBe('partial');
    expect(reasonOf(t, 'invocations')).toMatch(/name a base this record does not hold/);
  });

  it('hashes each system block and names every tool, with the shape that changed', () => {
    const entries = claudeRecord();
    entries.push({
      type: 'api-request-shape', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      shapeHash: 'shape1', timestamp: '2026-10-29T08:00:07.000Z',
      shape: { system: [{ type: 'text', text: 'host block one' }], tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'WebFetch' }] },
    });
    entries.push({
      type: 'api-request', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', id: 'r3',
      timestamp: '2026-10-29T08:00:08.000Z', shapeHash: 'shape1', base: 'r2', keep: 8, tail: ['m0'],
      params: { model: 'claude-opus-5' },
    });
    const t = trace(write('shapes.jsonl', entries));
    expect(t.shapes.map((s) => s.tools.length)).toEqual([2, 3]);
    expect(t.shapes.map((s) => s.first_invocation)).toEqual([0, 3]);
    expect(t.shapes[0]!.system_blocks).toHaveLength(2);
    expect(t.shapes[0]!.system_bytes).toBe('host block one'.length + 'the appended composition'.length);
    expect(t.shapes[0]!.system_blocks[0]!.sha256).toHaveLength(64);
    expect(stateOf(t, 'instructions')).toBe('observed');
    expect(stateOf(t, 'tools')).toBe('observed');
  });

  it('reads a compaction as before, after, preserved and replacement', () => {
    const t = trace(write('compacted.jsonl', claudeRecord({ compaction: true })));
    expect(t.compactions).toHaveLength(1);
    expect(t.compactions[0]).toMatchObject({
      trigger: 'auto', pre_tokens: 1_000_000, post_tokens: 50_000,
      dropped_tokens: 950_000, preserved_messages: 3, replacement: 'anchor-1',
    });
    expect(stateOf(t, 'evolution')).toBe('observed');
    expect(reasonOf(t, 'evolution')).toMatch(/1 compaction/);
    // And the call after it reports the removal, not just the addition.
    expect(t.invocations.at(-1)!.removed).toBe(6);
    expect(t.invocations.at(-1)!.added).toBe(1);
  });

  it('calls a session with no compaction a reading, not a gap', () => {
    const t = trace(write('plain.jsonl', claudeRecord()));
    expect(t.compactions).toEqual([]);
    expect(stateOf(t, 'evolution')).toBe('observed');
    expect(reasonOf(t, 'evolution')).toMatch(/additions only/);
  });

  it('will not call a drop with no boundary a compaction', () => {
    const entries = claudeRecord();
    entries.push({
      type: 'api-request', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', id: 'r3',
      timestamp: '2026-10-29T08:00:09.000Z', shapeHash: 'shape0', base: 'r2', keep: 3, tail: ['m0'],
      params: { model: 'claude-opus-5' },
    });
    const t = trace(write('silent-drop.jsonl', entries));
    expect(t.compactions).toEqual([]);
    expect(t.invocations.at(-1)!.removed).toBe(5);
    expect(stateOf(t, 'evolution')).toBe('partial');
    expect(reasonOf(t, 'evolution')).toMatch(/no compaction boundary recorded/);
  });

  it('reports a record with no request ledger as unavailable, not as a clean session', () => {
    const t = trace(write('old.jsonl', [
      { type: 'user', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', message: { role: 'user', content: 'hello' } },
    ]));
    expect(stateOf(t, 'invocations')).toBe('unavailable');
    expect(stateOf(t, 'instructions')).toBe('unavailable');
    expect(stateOf(t, 'tools')).toBe('unavailable');
  });
});

describe('a codex rollout, per turn', () => {
  it('takes identity and the source revision from the session metadata', () => {
    const t = trace(write('codex.jsonl', codexRecord()));
    expect(t.identity).toMatchObject({
      session_id: '01a185da-8c88-7463-8b6f-cf9d0d6945cd', cli_version: '0.164.0',
      provider: 'openai', source_revision: 'abc123', models: ['gpt-6-astra'],
    });
    expect(stateOf(t, 'identity')).toBe('observed');
  });

  it('reads a partial world_state as a change point, never as an empty inventory', () => {
    const withDelta = trace(write('delta.jsonl', codexRecord()));
    const withoutDelta = trace(write('nodelta.jsonl', codexRecord({ full: false })));
    // One configuration either way: the delta does not add a second, and above
    // all does not report a tool list of four as a tool list of none.
    expect(withDelta.shapes).toHaveLength(1);
    expect(withoutDelta.shapes).toHaveLength(1);
    expect(withDelta.shapes[0]!.tools).toHaveLength(4);
    expect(reasonOf(withDelta, 'instructions')).toMatch(/partial world_state update\(s\) moved only environments/);
    expect(reasonOf(withoutDelta, 'instructions')).not.toMatch(/partial world_state/);
  });

  it('declines to invent a per-call message count the rollout never wrote', () => {
    const t = trace(write('codex.jsonl', codexRecord()));
    expect(t.invocations.map((i) => i.messages)).toEqual([null, null]);
    expect(t.invocations.map((i) => i.model)).toEqual(['gpt-6-astra', 'gpt-6-astra']);
    expect(stateOf(t, 'invocations')).toBe('partial');
    expect(reasonOf(t, 'invocations')).toMatch(/does not record the message array/);
  });

  it('reports a compaction whose retained set the host itself marks incomplete as a floor', () => {
    const t = trace(write('codex.jsonl', codexRecord()));
    expect(t.compactions).toHaveLength(1);
    expect(t.compactions[0]).toMatchObject({
      pre_tokens: 1_900_000, post_tokens: 240_000, dropped_tokens: null,
      preserved_messages: 3, replacement: 'resp_abc',
    });
    expect(t.compactions[0]!.basis).toMatch(/INCOMPLETE/);
    expect(stateOf(t, 'evolution')).toBe('partial');
  });

  it('counts items by the kind the rollout distinguishes', () => {
    const t = trace(write('codex.jsonl', codexRecord()));
    expect(t.retained.by_role).toEqual({ message: 1, custom_tool_call: 1 });
    expect(stateOf(t, 'additions')).toBe('observed');
  });

  it('sums the token counts the host wrote and says they are its units', () => {
    const t = trace(write('codex.jsonl', codexRecord()));
    expect(stateOf(t, 'sizes')).toBe('observed');
    expect(reasonOf(t, 'sizes')).toMatch(/input_tokens 100/);
    expect(reasonOf(t, 'sizes')).toMatch(/in its units/);
  });
});

describe('what every trace carries', () => {
  it('accounts for every required category on both harnesses', () => {
    for (const path of [write('c.jsonl', claudeRecord()), write('x.jsonl', codexRecord())]) {
      const t = trace(path);
      expect(t.coverage.map((c) => c.category).sort()).toEqual([...TRACE_CATEGORIES].sort());
      for (const c of t.coverage) expect(c.reason.length).toBeGreaterThan(20);
    }
  });

  it('names the provider ceiling and the attention limit on both harnesses', () => {
    for (const path of [write('c.jsonl', claudeRecord()), write('x.jsonl', codexRecord())]) {
      const t = trace(path);
      expect(t.unobservable.join(' ')).toMatch(/inside its own service/);
      expect(t.unobservable.join(' ')).toMatch(/attended/);
    }
  });

  it('reports the real file size beside the amount read', () => {
    const t = trace(write('c.jsonl', claudeRecord()));
    expect(t.source.truncated).toBe(false);
    expect(t.source.read_bytes).toBe(t.source.bytes);
    expect(t.source.unparseable).toBe(0);
  });

  it('counts an unparseable line rather than failing on it', () => {
    const path = write('torn.jsonl', claudeRecord());
    writeFileSync(path, require('node:fs').readFileSync(path, 'utf8') + '{"type":"api-req\n');
    const t = trace(path);
    expect(t.source.unparseable).toBe(1);
    expect(t.invocations).toHaveLength(3);
  });
});

describe('finding a codex rollout by session id', () => {
  it('matches the id as a filename component under the day directories', () => {
    const home = join(dir, 'codex');
    mkdirSync(join(home, 'sessions', '2026', '10', '28'), { recursive: true });
    const id = '01a185da-8c88-7463-8b6f-cf9d0d6945cd';
    const file = join(home, 'sessions', '2026', '10', '28', `rollout-2026-10-28T21-10-55-${id}.jsonl`);
    writeFileSync(file, '');
    process.env['CODEX_HOME'] = home;
    expect(findCodexRecord(id)).toBe(file);
  });

  it('refuses an id that is not a uuid, so no id can become a path', () => {
    process.env['CODEX_HOME'] = join(dir, 'codex');
    expect(findCodexRecord('../../../outside')).toBeNull();
  });
});
