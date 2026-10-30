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
import { contextTrace, findCodexRecord, findCodexRecords, harnessOf, TRACE_CATEGORIES, type ContextTrace } from '../src/context-trace.js';
import { claudeRecord, claudeTranscriptRecord, codexCompactionsRecord, codexRecord, codexThreadParentRecord } from './fixtures/host-records.js';

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved['CODEX_HOME'] = process.env['CODEX_HOME'];
  dir = mkdtempSync(join(tmpdir(), 'rev-trace-'));
  // A history base is RESOLVED against the host store now, and a fixture
  // carrying a real thread id and byte offset reached the operator's own
  // ~/.codex and resolved to a real record. Each case reads its own directory.
  process.env['CODEX_HOME'] = join(dir, 'no-store');
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

  // Mutation: name what each figure is and stop. `pre → post` invites exactly
  // one reading — the shrink — and both figures are pre-compaction, so the
  // reading is wrong by the whole of the drop. The timeline says so in prose;
  // a --json consumer has this string and nothing else (ward on H-3763).
  it('says on the compaction itself that both host figures are pre-compaction', () => {
    const t = trace(write('codex.jsonl', codexRecord()));
    const basis = t.compactions[0]!.basis;

    expect(basis).toContain('BOTH figures are pre-compaction');
    expect(basis).toContain("pre is the TURN's cumulative input tokens and post is the last call before the boundary");
    expect(basis).toContain('their difference is not a drop and neither is the size of the new context');
    expect(basis).toContain('read from its per-call input figures either side of the boundary');
  });

  // A rollout the host wrote as a CONTINUATION of a thread holds only its
  // tail. Three of the 867 codex records on this machine are one, and this
  // trace called their additions `observed` and, where no compaction was
  // recorded, their evolution `observed` too — over a record whose context
  // began in a different file (ward on H-3763).
  it('carries the history base, and stops calling a tail of a thread observed', () => {
    const own = trace(write('own-thread.jsonl', codexCompactionsRecord()));
    const tail = trace(write('continues.jsonl', codexCompactionsRecord({ continuesThread: true })));

    expect(own.identity.history_base).toBeNull();
    expect(stateOf(own, 'additions')).toBe('observed');
    expect(tail.identity.history_base).toMatchObject({
      thread_id: '01a18468-eb66-7892-841e-3bc876b47680', entries_before: 1_065, byte_offset: 4_150_695, record: null,
    });
    // No record beside it or in the store holds that cut, and the reason is
    // the operator's only lead to the earlier segment.
    expect(tail.identity.history_base?.resolution).toContain('not resolved: no other rollout under');
    expect(stateOf(tail, 'additions')).toBe('partial');
    expect(reasonOf(tail, 'additions')).toContain('CONTINUES thread 01a18468-eb66-7892-841e-3bc876b47680 from ordinal 1065');
    expect(reasonOf(tail, 'additions')).toContain('in a different record of the same thread');
  });

  // The starkest reading: an evolution stated whole for a session whose
  // context began elsewhere, with no boundary anywhere in this file to rebase
  // it (2026-10-25T15-37-49 here, 14 calls, no compaction).
  it('refuses to call an evolution complete on a continuation segment with no boundary', () => {
    const own = trace(write('own-no-comp.jsonl', codexCompactionsRecord({ withoutBoundary: true })));
    const tail = trace(write('tail-no-comp.jsonl', codexCompactionsRecord({ continuesThread: true, withoutBoundary: true })));

    expect(own.compactions).toHaveLength(0);
    expect(stateOf(own, 'evolution')).toBe('observed');
    expect(tail.compactions).toHaveLength(0);
    expect(stateOf(tail, 'evolution')).toBe('partial');
    expect(reasonOf(tail, 'evolution')).toContain('with no boundary to replace the context, EVERY call here was given the thread\'s earlier entries');
    expect(reasonOf(tail, 'evolution')).toContain("not the session's");
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

  // Mutation: return the first match in directory order. An id names MORE than
  // one file whenever the host resumed the thread: every segment carries the
  // thread id as its own session_meta.session_id, and both segments of one
  // thread here sit in the same day directory, so directory order named no
  // winner between a run's record and the record it continued.
  it('names the latest segment where a resumed thread has more than one', () => {
    const home = join(dir, 'codex');
    mkdirSync(join(home, 'sessions', '2026', '10', '28'), { recursive: true });
    const id = '01a18468-eb66-7892-841e-3bc876b47680';
    const earlier = join(home, 'sessions', '2026', '10', '28', `rollout-2026-10-28T14-27-10-${id}.jsonl`);
    const later = join(home, 'sessions', '2026', '10', '28', `rollout-2026-10-28T21-04-49-${id}_01a185d4-f73f-7db2-a4db-63438f35543e.jsonl`);
    writeFileSync(earlier, '');
    writeFileSync(later, '');
    process.env['CODEX_HOME'] = home;

    expect(findCodexRecords(id)).toEqual([later, earlier]);
    expect(findCodexRecord(id)).toBe(later);
  });

  // Mutation: name the thread id and stop. Requirement 6 wants a part
  // followable to its origin, and a thread id is not a path: the earlier
  // segment is identified by the CUT the base states, which is the one thing
  // that distinguishes it from the child and from a second segment.
  it('resolves the earlier segment of a thread by the byte the base names', () => {
    const thread = '01a18468-eb66-7892-841e-3bc876b47680';
    const { entries, cut } = codexThreadParentRecord({ thread });
    const parent = write(`rollout-2026-10-28T14-27-10-${thread}.jsonl`, entries);
    const offset = Buffer.byteLength(entries.slice(0, cut).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const child = trace(write(
      `rollout-2026-10-28T21-04-49-${thread}_01a185d4-f73f-7db2-a4db-63438f35543e.jsonl`,
      codexCompactionsRecord({ continuesThread: { thread_id: thread, entries_before: cut, byte_offset: offset } }),
    ));

    expect(child.identity.history_base?.record).toBe(parent);
    expect(child.identity.history_base?.resolution).toContain(`its first ${offset} bytes are exactly the ${cut} entries this record picks up after`);
    // Still partial: the additions counted here are this segment's own.
    expect(stateOf(child, 'additions')).toBe('partial');
    expect(reasonOf(child, 'additions')).toContain(`That record is ${parent}`);
  });
});

describe('the remainder claude leaves to its own transcript', () => {
  it('joins it through each assistant entry requestRef, not by position', () => {
    const t = trace(write('join.jsonl', claudeTranscriptRecord()));
    // 8 messages are referenced across the three calls; the host retained a
    // blob for 5 of them, and the transcript accounts for the other 3.
    expect(t.retained).toMatchObject({ referenced: 8, recoverable: 5 });
    expect(t.recovery).toMatchObject({ resolved: 3, unresolved: 0, group_mismatches: 0 });
  });

  it('measures itself against the slots the host retained a blob for too', () => {
    const t = trace(write('join.jsonl', claudeTranscriptRecord()));
    expect(t.recovery).toMatchObject({ checked: 1, exact: 1, by_role: { assistant: { checked: 1, exact: 1 } } });
    expect(t.recovery?.modes).toEqual({});
  });

  it('reconstructs a turn as it went on the wire, in sent order', () => {
    // Two things the retained blob proves, because it is the message that
    // actually went out. The host rewrote `printf two > out` to
    // `cd /tmp/seat && printf two > out` and recorded both forms, so reading
    // the model's form reports a command the next call's context never held.
    // And a2 (the tool call) is written in the file BEFORE a3 (the text),
    // while apiBlockIndex says the text went first; assembling in file order
    // inverts the turn.
    const t = trace(write('join.jsonl', claudeTranscriptRecord()));
    expect(t.recovery?.exact).toBe(1);
    expect(t.recovery?.modes).toEqual({});
  });

  it('names an appended block the transcript does not carry rather than calling it exact', () => {
    const t = trace(write('join.jsonl', claudeTranscriptRecord({
      retained: [
        { type: 'text', text: 'now the write' },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cd /tmp/seat && printf two > out' } },
        { type: 'text', text: '<system-reminder>and one more thing</system-reminder>' },
      ],
    })));
    expect(t.recovery).toMatchObject({ checked: 1, exact: 0 });
    expect(Object.keys(t.recovery?.modes ?? {})).toEqual(['the host appended text the transcript does not carry']);
  });

  it('names a block the host wrapped before sending it', () => {
    const t = trace(write('join.jsonl', claudeTranscriptRecord({
      retained: [
        { type: 'text', text: '<system-reminder>now the write</system-reminder>' },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cd /tmp/seat && printf two > out' } },
      ],
    })));
    expect(t.recovery).toMatchObject({ checked: 1, exact: 0 });
    expect(Object.keys(t.recovery?.modes ?? {})).toEqual(['the host wrapped or rewrote a block before sending it']);
  });

  it('leaves a reply group whose count disagrees unresolved instead of falling back to position', () => {
    // r1's reply group loses its tool result, so it reconstructs one message
    // where the request added two. Guessing would put the assistant turn in
    // the user slot, confidently and wrongly.
    const t = trace(write('join.jsonl', claudeTranscriptRecord({ brokenGroup: true })));
    expect(t.recovery).toMatchObject({ group_mismatches: 1, resolved: 2, unresolved: 1, checked: 0 });
  });

  it('does not take a subagent turn for part of this request stream', () => {
    // The sidechain entry names r1 as well. Counting it would add a third
    // message to r1's reply group and break the join that otherwise holds.
    const t = trace(write('join.jsonl', claudeTranscriptRecord({ sidechain: true })));
    expect(t.recovery).toMatchObject({ resolved: 3, group_mismatches: 0, exact: 1 });
  });

  it('names the transcript entries that reconstruct each call, by uuid', () => {
    const t = trace(write('join.jsonl', claudeTranscriptRecord()));
    // r1 added r0's reply: the two assistant blocks, then the tool result.
    expect(t.invocations[1]?.resolved_via).toEqual(['a0', 'a1', 'u1']);
    expect(t.invocations[1]).toMatchObject({ recoverable: 3, resolved: 2 });
    // r0's own tail is retained, so it needs nothing from the transcript.
    expect(t.invocations[0]?.resolved_via).toEqual([]);
  });

  it('keeps additions partial even when the transcript resolves every message', () => {
    // A reconstruction is what the host wrote down, not what it sent, and the
    // measured exactness is what says how far those agree. Promoting the
    // category on an inference would report the two as one thing.
    const t = trace(write('join.jsonl', claudeTranscriptRecord()));
    expect(t.recovery?.unresolved).toBe(0);
    expect(stateOf(t, 'additions')).toBe('partial');
    expect(reasonOf(t, 'additions')).toContain('5 of 8');
    expect(reasonOf(t, 'additions')).toContain('resolves 3 more');
  });

  it('carries no recovery on a harness whose items hold their own content', () => {
    const t = trace(write('rollout.jsonl', codexRecord()));
    expect(t.recovery).toBeNull();
    expect(t.invocations[0]?.resolved).toBeNull();
  });
});
