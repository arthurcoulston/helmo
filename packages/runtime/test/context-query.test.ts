// The acceptance for the operator read surface over a context trace
// (H-3724 requirement 6).
//
// context-trace.test.ts asserts what a record HOLDS, per required category.
// This file asserts what an operator is SHOWN: the parts of one call's
// context with their origins, the timeline of what entered and left, and where
// a given string came from. The fixtures are the same ones the trace reads
// (./fixtures/host-records.ts), deliberately: a query answering over its own
// private fixture could drift from the reading whose accuracy is measured.
//
// Each case below is reddened by at least one mutation of the module, listed
// against it. Three that are easy to write and prove nothing were deliberately
// not written: that an answer has the right number of keys, that a renderer
// returns a string, and that a gap list is non-empty.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextAt,
  contextEvolution,
  contextFind,
  renderContextAt,
  renderContextEvolution,
  renderContextFind,
  type ContextAt,
  type ContextEvolution,
  type ContextFind,
} from '../src/context-query.js';
import { claudeRecord, claudeTranscriptRecord, codexRecord } from './fixtures/host-records.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rev-query-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, entries: unknown[]): string => {
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
};

const at = (path: string, ordinal: number, chars = Infinity): ContextAt & { source: unknown } => {
  const a = contextAt(path, ordinal, { chars });
  if ('error' in a) throw new Error(`expected an answer, got a refusal: ${a.error}`);
  return a;
};
const evolution = (path: string, chars = Infinity): ContextEvolution & { source: unknown } => {
  const e = contextEvolution(path, { chars });
  if ('error' in e) throw new Error(`expected an answer, got a refusal: ${e.error}`);
  return e;
};
/** The join fixture with a second request shape: the last call runs under a
 *  tool inventory the first two did not have — the commonest real change, and
 *  the one a single-shape fixture cannot distinguish. */
function twoShapeRecord(): unknown[] {
  const entries = claudeTranscriptRecord();
  entries.splice(1, 0, {
    type: 'api-request-shape', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', shapeHash: 'shape1',
    timestamp: '2026-10-29T08:00:02.500Z', version: '2.1.300',
    shape: { system: [{ type: 'text', text: 'host block one' }], tools: [{ name: 'Bash' }, { name: 'mcp__helmo__helmo_get_ticket' }] },
  });
  const last = entries.find((entry) => (entry as { id?: string }).id === 'r2') as Record<string, unknown>;
  last['shapeHash'] = 'shape1';
  return entries;
}

const find = (path: string, needle: string): ContextFind & { source: unknown } => {
  const f = contextFind(path, needle, { chars: 200 });
  if ('error' in f) throw new Error(`expected an answer, got a refusal: ${f.error}`);
  return f;
};

describe('what was in one call context', () => {
  // Mutation: list the parts in file order rather than through base/keep/tail.
  it('lists the call own message list, in sent order, with the content the host retained', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2);

    expect(a.totals.parts).toBe(8);
    expect(a.parts.map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(a.parts[0]).toMatchObject({ role: 'user', origin: 'retained' });
    expect(a.parts[0]!.text).toContain('the iteration prompt');
  });

  // Mutation: label a reconstruction `retained`. This is the distinction the
  // whole surface rests on — a reconstruction is what the host wrote down, and
  // an operator who cannot see which parts those are cannot discount them.
  it('labels a part the host kept no blob for as reconstructed, and names the transcript entries it came from', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2);

    const reconstructed = a.parts.filter((p) => p.origin === 'reconstructed');
    expect(reconstructed.map((p) => p.slot)).toEqual([2, 3, 6]);
    expect(a.totals).toMatchObject({ retained: 5, reconstructed: 3, unreadable: 0 });
    // Both blocks of r0's reply, by uuid, in the order they were sent.
    expect(reconstructed[0]!.via).toEqual(['a0', 'a1']);
  });

  // Mutation: reconstruct from the tool input as the model wrote it. The host
  // rewrites some inputs before the wire and records that form beside them, so
  // the model's form is a command the next call's context never held.
  it('shows a tool call as it went on the wire, not as the model wrote it', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2);

    const assistant = a.parts.find((p) => p.slot === 2)!;
    expect(assistant.text).toContain('cd /tmp/seat && ls');
    expect(assistant.text).not.toContain('"command":"ls"');
  });

  // Mutation: report the session's overall exactness on every part. Averaged,
  // this session would tell an operator its user reconstruction had been
  // checked, when the only slot that could be checked was an assistant one.
  it('carries the measured accuracy for that part own role, and admits where there is nothing to measure', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2);

    expect(a.parts.find((p) => p.slot === 2)!.caveat).toContain('1 of 1 assistant slots');
    expect(a.parts.find((p) => p.slot === 6)!.caveat)
      .toContain('no slot of this role in this session had both a retained blob and a reconstruction');
  });

  // Mutation: show an unreadable part as the empty string it parses to. A
  // blank part reads as a part that was blank.
  it('says a part is unreadable rather than showing it blank', () => {
    const a = at(write('bare.jsonl', claudeRecord({ blobs: false })), 2);

    expect(a.totals).toMatchObject({ retained: 0, reconstructed: 0, unreadable: 8 });
    expect(a.parts[0]!.text).toBeNull();
    expect(a.parts[0]!.caveat).toContain('content is not on this machine');
    // ...and it is not counted as zero bytes of content either.
    expect(a.totals.part_bytes).toBe(0);
    expect(a.parts[0]!.bytes).toBeNull();
  });

  // Mutation: set `entered` to the call being read. Then a part carried for
  // forty calls is indistinguishable from one that just arrived, which is the
  // question "where did this come from" in its commonest form.
  it('says which call each part entered the context at, not which call is being read', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2);

    expect(a.parts.map((p) => p.entered)).toEqual([0, 0, 1, 1, 1, 2, 2, 2]);
  });

  // Mutation: always use the record's first (or last) shape. A session whose
  // tool inventory grew would then be reported with the wrong instructions on
  // every call but one.
  it('shows the instructions and tool schemas in force for that call, as text', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2);

    expect(a.instructions).toMatchObject({ since: 0 });
    expect(a.instructions!.blocks[0]!.text).toBe('host block one');
    expect(a.instructions!.tools.map((t) => t.name)).toEqual(['Bash']);
  });

  // Mutation: read the instructions off the record's first (or last) shape.
  // The single-shape fixture above cannot catch that — any shape is the right
  // one when there is only one — so this is the case that holds it up.
  it('takes them from the shape THIS call ran under, where the session has more than one', () => {
    const path = write('shapes.jsonl', twoShapeRecord());

    expect(at(path, 0).instructions).toMatchObject({ ref: 'shape0', since: 0 });
    expect(at(path, 0).instructions!.tools.map((t) => t.name)).toEqual(['Bash']);
    expect(at(path, 2).instructions).toMatchObject({ ref: 'shape1', since: 2 });
    expect(at(path, 2).instructions!.tools.map((t) => t.name)).toEqual(['Bash', 'mcp__helmo__helmo_get_ticket']);
  });

  // Mutation: return an empty answer for an ordinal out of range. An empty
  // context is a reading; a call that does not exist is a typo.
  it('refuses a call this session never made, naming the range it did', () => {
    const answer = contextAt(write('join.jsonl', claudeTranscriptRecord()), 9);

    expect('error' in answer && answer.error).toContain('3 model calls, numbered 0 to 2');
  });

  // Mutation: carry every part in full by default. One 30MB record's call
  // would then be the answer, which is the state this work started from.
  it('bounds each part to the characters asked for, and says so on the part', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2, 4);

    expect(a.parts[0]!.text).toBe('the ');
    expect(a.parts[0]!.truncated).toBe(true);
  });
});

describe('what changed through the run', () => {
  // Mutation: treat the first shape of a session as a change to it. Then call
  // 0 reports every tool as having been ADDED, which is the opposite of what
  // the entry says.
  it('reports the first configuration as the configuration, not as a change', () => {
    const e = evolution(write('join.jsonl', claudeTranscriptRecord()));

    expect(e.changes[0]!.notable).toEqual(['initial configuration: 1 instruction block(s), 1 tools']);
    expect(e.changes[0]!.instructions).toMatchObject({ from: null });
  });

  // Mutation: report a tool change without the names. "The inventory changed"
  // is not an answer to what entered the context.
  it('names the tools a mid-session change added', () => {
    const e = evolution(write('shapes.jsonl', twoShapeRecord()));

    expect(e.changes[2]!.instructions).toMatchObject({ tools_added: ['mcp__helmo__helmo_get_ticket'], tools_removed: [] });
    expect(e.changes[2]!.notable.join(' ')).toContain('tool inventory changed, +mcp__helmo__helmo_get_ticket');
  });

  // Mutation: report the compaction without the replacement summary. The
  // summary IS the context after the boundary; a timeline that drops it shows
  // sixty parts leaving and nothing arriving.
  it('reports a compaction with the host own figures and the text that replaced the dropped turns', () => {
    const e = evolution(write('compacted.jsonl', claudeRecord({ compaction: true })));

    const call = e.changes.find((c) => c.compaction !== null)!;
    expect(call.ordinal).toBe(3);
    expect(call.compaction).toMatchObject({ trigger: 'auto', pre_tokens: 1_000_000, post_tokens: 50_000, preserved_messages: 3 });
    expect(call.compaction!.replacement_text).toContain('This session is being continued');
    expect(call.notable.join(' ')).toContain('compaction (auto): 1000000 → 50000 tokens');
  });

  // Mutation: read a drop off `removed` alone. At a compaction the host
  // REBASES rather than truncating, so its own keep count is of a new chain
  // and reads 0 while the context loses most of its parts — the one call an
  // operator most wants the drop reported on.
  it('reports a context that shrank even where the host own keep count says nothing was dropped', () => {
    const entries = claudeRecord();
    // A fresh chain after a boundary: no base, and a list of one.
    entries.push({
      type: 'api-request', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', id: 'r3',
      timestamp: '2026-10-29T08:00:07.000Z', version: '2.1.300', shapeHash: 'shape0',
      params: { model: 'claude-opus-5' }, keep: 0, tail: ['m0'],
    });

    const e = evolution(write('rebased.jsonl', entries));

    const call = e.changes[3]!;
    expect(call.removed).toBe(0);
    expect(call).toMatchObject({ previously: 8, held: 1 });
    expect(call.notable.join(' ')).toContain('7 left it, and the host rebased rather than truncating');
  });

  // Mutation: call any drop a compaction. That invents a replacement summary
  // for turns whose replacement is genuinely unknown.
  it('reports a drop with no boundary as a drop whose replacement is unknown', () => {
    const entries = claudeRecord();
    entries.push({
      type: 'api-request', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', id: 'r3',
      timestamp: '2026-10-29T08:00:07.000Z', version: '2.1.300', shapeHash: 'shape0',
      params: { model: 'claude-opus-5' }, base: 'r2', keep: 3, tail: ['m0'],
    });

    const call = evolution(write('dropped.jsonl', entries)).changes[3]!;

    expect(call.compaction).toBeNull();
    expect(call.notable.join(' ')).toContain('with no compaction boundary in this record: what replaced them is unknown');
  });

  // Mutation: place a boundary on the call before it. The boundary is written
  // into the transcript, so the call it affected is the next one.
  it('places a boundary at the first call after it, and keeps one that fell after the last call', () => {
    const entries = claudeRecord({ compaction: true });
    const e = evolution(write('compacted.jsonl', entries));
    expect(e.changes.find((c) => c.compaction !== null)!.ordinal).toBe(3);

    // The same record with its last request removed: the boundary still
    // happened, and dropping it would lose the only compaction the session had.
    const truncated = entries.filter((entry) => (entry as { id?: string }).id !== 'r3');
    const after = evolution(write('tail-boundary.jsonl', truncated));
    expect(after.changes).toHaveLength(4);
    expect(after.changes[3]!).toMatchObject({ ordinal: 3, added: [] });
    expect(after.changes[3]!.notable.join(' ')).toContain('after the last model call in this record');
  });
});

describe('where a string came from', () => {
  // Mutation: search only the messages. The instructions are the part of the
  // context an operator is least able to reconstruct for themselves.
  it('finds it in the instructions, and says it is configured rather than sent', () => {
    const f = find(write('join.jsonl', claudeTranscriptRecord()), 'host block one');

    expect(f.hits).toHaveLength(1);
    expect(f.hits[0]).toMatchObject({ where: 'instructions', origin: 'configured', role: 'system', first_invocation: 0 });
    expect(f.hits[0]!.excerpt).toContain('host block one');
  });

  // Mutation: report a configured hit as held by no call. An instruction block
  // in force for every call of a session read `invocations: 0`, which is the
  // answer for a part that was never in the context.
  it('says which calls a configured hit was in force for, not none', () => {
    const one = find(write('join.jsonl', claudeTranscriptRecord()), 'host block one');
    expect(one.hits[0]).toMatchObject({ first_invocation: 0, last_invocation: 2, invocations: 3 });

    // Two shapes: the block is in both, so each hit spans only its own calls.
    const two = find(write('shapes.jsonl', twoShapeRecord()), 'host block one');
    expect(two.hits.map((h) => [h.first_invocation, h.last_invocation, h.invocations]))
      .toEqual([[0, 1, 2], [2, 2, 1]]);
  });

  // Mutation: report a hit without its span. "It is in the context" leaves the
  // operator to find out when it entered and whether it is still there.
  it('says which calls held a message hit, and how many', () => {
    const f = find(write('join.jsonl', claudeTranscriptRecord()), 'the iteration prompt');

    const hit = f.hits.find((h) => h.where === 'message')!;
    expect(hit).toMatchObject({ first_invocation: 0, last_invocation: 2, invocations: 3, origin: 'retained' });
  });

  // Mutation: skip the unreadable parts silently. Then a nil result reads as
  // "it was not in the context", which is a claim this record cannot support.
  it('counts what it could not read, and says a nil result is not an absence', () => {
    const f = find(write('bare.jsonl', claudeRecord({ blobs: false })), 'anything at all');

    expect(f.hits).toHaveLength(0);
    expect(f.searched).toMatchObject({ parts: 0, unreadable: 8 });
    expect(f.gaps.join(' ')).toContain('a nil result is "not found in what is readable", never "was not in the context"');
  });

  it('refuses an empty needle rather than matching everything', () => {
    const answer = contextFind(write('join.jsonl', claudeTranscriptRecord()), '');
    expect('error' in answer && answer.error).toContain('nothing to look for');
  });
});

describe('the codex rollout', () => {
  // Mutation: present the items before a turn as the host's own message list.
  // The rollout records turns and items; the per-call array is this reader's
  // arithmetic and has to say so.
  it('reads a call context as the items recorded before it, and says whose arithmetic that is', () => {
    const a = at(write('rollout.jsonl', codexRecord()), 0);

    expect(a.parts.map((p) => p.types[0])).toEqual(['message']);
    expect(a.gaps.join(' ')).toContain("this reader's arithmetic, not a list the host wrote");
  });

  // Mutation: take the whole usage window as the call's context. The host
  // writes the usage record AFTER the call, so the window ends with the call's
  // own reasoning, reply and tool request — three items per call that were
  // never in the context it was given, on every call of every rollout.
  it('does not count what the call itself produced as part of its own input', () => {
    const a = at(write('rollout.jsonl', codexRecord()), 0);

    expect(a.parts.map((p) => p.types[0])).not.toContain('custom_tool_call');
    expect(a.gaps.join(' ')).toContain('1 items this call itself produced');
    expect(a.gaps.join(' ')).toContain('sit inside its window without ever having been in its input');
    // ...and it belongs to the NEXT call's input, which is where it shows up.
    const next = at(write('two-calls.jsonl', codexRecord({ secondCall: true })), 1);
    expect(next.parts.map((p) => p.types[0])).toEqual(['message', 'custom_tool_call', 'message']);
    expect(next.parts.find((p) => p.types[0] === 'custom_tool_call')!.entered).toBe(1);
  });

  // Mutation: read a call off the turn boundaries. A turn is a USER turn, so
  // one loop iteration is a single turn with a dozen calls inside it: on a real
  // mason rollout that reading offered `--at 0` and nothing else, over a
  // context that grew from 15,908 to 37,468 input tokens across seven calls.
  it('takes a call from the host per-call usage record, with the response id and token count it carries', () => {
    const a = at(write('two-calls.jsonl', codexRecord({ secondCall: true })), 1);

    expect(a.of).toBe(2);
    expect(a.call_unit).toContain('one token_usage_record');
    expect(a.host_tokens).toMatchObject({ input: 240, cached: 90 });
    expect(a.host_tokens!.basis).toContain('resp_two');
    // Its context is every item before that call, the second turn's ask last.
    expect(a.parts.at(-1)!.text).toBe('the next ask');
  });

  // Mutation: present the turn as a call anyway. A host old enough to write no
  // usage record leaves only the user turn, and saying so is the difference
  // between a coarse reading and a wrong one.
  it('falls back to the user turn where the rollout has no usage record, and names it as a turn', () => {
    const entries = codexRecord().filter((e) => (e as { type?: string }).type !== 'token_usage_record');
    const a = at(write('no-usage.jsonl', entries), 1);

    expect(a.of).toBe(2);
    expect(a.call_unit).toContain('a turn is many calls');
    expect(a.host_tokens).toBeNull();
  });

  // The claude request entry carries no usage: the host writes the response's
  // counts elsewhere. Reported absent rather than as our byte total dressed up
  // as tokens.
  it('reports no host token count on a harness whose request entry has none', () => {
    const a = at(write('join.jsonl', claudeTranscriptRecord()), 2);

    expect(a.host_tokens).toBeNull();
    expect(a.call_unit).toContain('one api-request');
  });

  // Mutation: show a reasoning item as the empty string its summary parses to.
  // The item WAS in the context; its content is provider-encrypted.
  it('says a reasoning item carried only as encrypted text is unreadable, not empty', () => {
    const a = at(write('reasoning.jsonl', codexRecord({ encryptedReasoning: true, secondCall: true })), 1);

    const reasoning = a.parts.find((p) => p.types[0] === 'reasoning')!;
    expect(reasoning).toMatchObject({ origin: 'unreadable', text: null });
    expect(reasoning.caveat).toContain('provider-encrypted text');
    expect(reasoning.caveat).toContain("it was in the call's context all the same");
    expect(a.totals).toMatchObject({ retained: 3, unreadable: 1 });
  });

  // Mutation: read a `full: false` world_state as a configuration. One such
  // entry reported a tool list of 35 as 0 in the first run of the reader this
  // one shares an index with: an absent key and an empty map are the same
  // shape, so the reading went low rather than missing.
  it('takes the instructions from the last FULL world state, and names the deltas since', () => {
    const a = at(write('rollout.jsonl', codexRecord()), 0);

    expect(a.instructions!.tools.map((t) => t.name))
      .toEqual(['mcp__helmo', 'mcp__node_repl', 'functions.exec', 'clock']);
    expect(a.instructions!.blocks.map((b) => b.text)).toEqual(['You are Codex.', 'the repository rules', 'the skills body']);
    expect(a.gaps.join(' ')).toContain('1 world_state deltas were recorded before this turn (keys: environments)');
  });

  // Mutation: compute a dropped figure from the item count. The rollout's item
  // count only grows, and the host states no dropped figure at a boundary.
  it('reports a compaction with the host own usage figures and no invented drop', () => {
    const e = evolution(write('rollout.jsonl', codexRecord({ secondCall: true })));

    const call = e.changes.find((c) => c.compaction !== null)!;
    // The host's own per-call input count, never our arithmetic.
    expect(e.changes.map((c) => c.host_input_tokens)).toEqual([100, 240]);
    expect(call.compaction).toMatchObject({ pre_tokens: 1_900_000, post_tokens: 240_000, dropped_tokens: null, preserved_messages: 3 });
    expect(call.compaction!.basis).toContain('INCOMPLETE, so the preserved count is a floor');
    expect(call.removed).toBeNull();
    expect(e.gaps.join(' ')).toContain('never a dropped figure');
  });
});

describe('what the operator is shown', () => {
  // Mutation: print each part's caveat under the part. A call with 72
  // reconstructed parts printed the same two sentences 72 times, which is how
  // a real qualification comes to be skipped.
  it('says each distinct caveat once, with how many parts carry it', () => {
    const text = renderContextAt(at(write('join.jsonl', claudeTranscriptRecord()), 2) as Parameters<typeof renderContextAt>[0], 80);

    expect(text.match(/1 of 1 assistant slots/g)).toHaveLength(1);
    expect(text).toContain('discount these parts by:');
    expect(text).toMatch(/! 2 parts: assembled from this record's transcript/);
    expect(text).toContain('#2    assistant  reconstructed');
  });

  // Mutation: filter nothing. A 132-call session prints 132 near-identical
  // lines, and the three that matter are not findable in them.
  it('shows only the calls with something to report when asked', () => {
    const e = evolution(write('compacted.jsonl', claudeRecord({ compaction: true }))) as Parameters<typeof renderContextEvolution>[0];

    const all = renderContextEvolution(e, 0);
    const notable = renderContextEvolution(e, 0, true);
    expect(all).toContain('call    1');
    expect(notable).not.toContain('call    1');
    expect(notable).toContain('call    3');
    expect(notable).toContain('2 with something to report');
  });

  it('renders a nil find as a nil find rather than as an empty list', () => {
    const text = renderContextFind(find(write('join.jsonl', claudeTranscriptRecord()), 'nothing like this') as Parameters<typeof renderContextFind>[0]);

    expect(text).toContain('0 hits');
    expect(text).toContain('no match in what is readable — which is not the same as absent from the context');
  });
});
