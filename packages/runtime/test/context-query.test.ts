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
import { claudeRecord, claudeTranscriptRecord, codexCompactionsRecord, codexRecord, codexThreadParentRecord } from './fixtures/host-records.js';

let dir: string;
let savedCodexHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rev-query-'));
  // A continuation segment's history base is RESOLVED against the host store
  // now, so a fixture carrying a real thread id and byte offset reached the
  // operator's own ~/.codex and spliced a real record into six assertions.
  // Every case here reads its own tmp directory and nothing else.
  savedCodexHome = process.env['CODEX_HOME'];
  process.env['CODEX_HOME'] = join(dir, 'no-store');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedCodexHome === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = savedCodexHome;
});

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
    // No compaction between the two: a boundary REPLACES the item list, so the
    // next call's context would be the host's replacement and this fixture
    // could not show where the produced item went.
    const next = at(write('two-calls.jsonl', codexRecord({ secondCall: true, compaction: false })), 1);
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
    const a = at(write('reasoning.jsonl', codexRecord({ encryptedReasoning: true, secondCall: true, compaction: false })), 1);

    const reasoning = a.parts.find((p) => p.types[0] === 'reasoning')!;
    expect(reasoning).toMatchObject({ origin: 'unreadable', text: null });
    expect(reasoning.caveat).toContain('provider-encrypted text');
    expect(reasoning.caveat).toContain("it was in the call's context all the same");
    expect(a.totals).toMatchObject({ retained: 3, unreadable: 1 });
  });

  // Mutation: fall back to the content part's own JSON. An image is not text,
  // and its data URL is not what the message said: printing it dumps a base64
  // blob as the context, which is the defect ward found on a compaction item
  // one level down (H-3750, finding 2). One real carried-in message holds two
  // of them, 537,630 and 223,746 characters.
  it('names an image in a message with its size rather than printing its data', () => {
    const a = at(write('attachment.jsonl', codexRecord({ attachment: true, secondCall: true, compaction: false })), 1);

    const message = a.parts.find((p) => p.text?.includes('<image name='))!;
    expect(message.text).toContain('[input_image: 278 bytes of inline image data (data:image/png;base64,…), not text]');
    expect(message.text).not.toContain('QUJDQUJD');
    // Readable, and its own recorded size is unchanged: the image WAS in the
    // context, and the part is not reported unreadable for not being text.
    expect(message.origin).toBe('retained');
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

// What ward's security review of this surface found (H-3750, four honesty
// defects on the increment at helmo@9298571): in four places what it showed
// was not what the host supplied. The surface exists for that one property,
// so each is its own case here.
describe('what it shows is what was supplied', () => {
  const ESC = '\u001b';
  const BEL = '\u0007';

  /** A record with ESC and BEL where a hostile page's bytes really land: in a
   *  retained message (a tool result holds whatever a page an agent fetched
   *  held), in a host instruction block, and in the summary that replaced a
   *  compaction's dropped turns. The sequences are the real ones — set the
   *  window title, clear the screen, write the clipboard. */
  function controlByteRecord(): unknown[] {
    const entries = claudeRecord({ compaction: true }) as Record<string, unknown>[];
    const blob = entries.find((e) => e['type'] === 'api-request-blob' && e['hash'] === 'm0')!;
    (blob['message'] as { content: { text: string }[] }).content[0]!.text =
      `the page said ${ESC}]0;owned${BEL}${ESC}[2J${ESC}]52;c;cGF5bG9hZA==${BEL} and nothing else`;
    const shape = entries.find((e) => e['type'] === 'api-request-shape')!;
    (shape['shape'] as { system: { text: string }[] }).system[0]!.text = `host block ${ESC}[31mone`;
    const summary = entries.find((e) => e['isCompactSummary'] === true)!;
    (summary['message'] as { content: string }).content = `This session is being continued${ESC}[2K`;
    return entries;
  }

  // Mutation: print the part text as it stands. A record holds whatever a
  // session's tool results held, so a page an agent fetched can rewrite what
  // the operator's terminal DISPLAYS of a context — hide a line above, clear
  // the screen, retitle the window, write the clipboard where the terminal
  // allows it.
  it('renders the control bytes a record carries visibly, in every text mode', () => {
    const path = write('control.jsonl', controlByteRecord());
    const shown = [
      renderContextAt(at(path, 2) as Parameters<typeof renderContextAt>[0], Infinity),
      renderContextEvolution(evolution(path) as Parameters<typeof renderContextEvolution>[0], Infinity),
      renderContextFind(find(path, 'the page said') as Parameters<typeof renderContextFind>[0]),
    ];

    for (const text of shown) {
      expect(text).not.toContain(ESC);
      expect(text).not.toContain(BEL);
      expect(text).toContain('\\u001b');
    }
    // The part, the instruction block and the replacement summary each.
    expect(shown[0]).toContain('\\u001b]0;owned\\u0007\\u001b[2J');
    expect(shown[0]).toContain('host block \\u001b[31mone');
    expect(shown[1]).toContain('This session is being continued\\u001b[2K');
    expect(shown[2]).toContain('\\u001b]52;c;');
  });

  // Mutation: strip the control bytes instead of showing them. They WERE in
  // the context, and a surface that quietly removes part of what was supplied
  // is the defect it exists to prevent — hiding a prompt injection's own
  // formatting from the operator reading for one.
  it('keeps the record own bytes in the structure, where a consumer reads them', () => {
    const a = at(write('control.jsonl', controlByteRecord()), 2);

    expect(a.parts[0]!.text).toContain(ESC);
    expect(a.parts[0]!.text).toContain(BEL);
    expect(a.instructions!.blocks[0]!.text).toContain(ESC);
  });

  // Mutation: fall back to the payload's own JSON as an item's text. The
  // `compaction` item a resumed rollout OPENS with carries only
  // `encrypted_content`: 64KB of ciphertext, shown as the content of the first
  // part of every such call, labelled retained and counted in the readable
  // bytes. 58 of them on the machine this was built against.
  it('says an item carried only as encrypted text is unreadable whatever its kind', () => {
    const a = at(write('rollout.jsonl', codexRecord({ secondCall: true })), 1);

    const compaction = a.parts.find((p) => p.types[0] === 'compaction')!;
    expect(compaction).toMatchObject({ origin: 'unreadable', text: null });
    expect(compaction.caveat).toContain('provider-encrypted text');
    // And its ciphertext is nowhere in what an operator is shown.
    expect(renderContextAt(a as Parameters<typeof renderContextAt>[0], Infinity)).not.toContain('gAAAAABq4_compaction');
    expect(a.totals).toMatchObject({ retained: 2, unreadable: 1 });
  });

  // Mutation: treat a payload with no text field as readable. An item this
  // reader has no text for is unreadable with the keys it DOES have named —
  // enough for an operator to go and look — never its own JSON passed off as
  // what the model was shown.
  it('names the keys of an item it has no text for, rather than showing its JSON', () => {
    const entries = codexRecord({ compaction: false });
    entries.push({
      type: 'response_item', timestamp: '2026-10-29T05:00:02.500Z',
      payload: { type: 'image_reference', id: 'img_1', image: { url: 'blob:1' } },
    });
    entries.push({
      type: 'token_usage_record', timestamp: '2026-10-29T05:00:03.000Z',
      payload: { response_id: 'resp_two', turn_id: 'turn-2', usage: { input_tokens: 240 } },
    });

    const a = at(write('no-text.jsonl', entries), 1);

    const image = a.parts.find((p) => p.types[0] === 'image_reference')!;
    expect(image).toMatchObject({ origin: 'unreadable', text: null });
    expect(image.caveat).toContain('carries no text in any field this reader knows');
    expect(image.caveat).toContain('keys: type, id, image');
    expect(renderContextAt(a as Parameters<typeof renderContextAt>[0], Infinity)).not.toContain('blob:1');
  });

  // Mutation: list the items from 0 after a compaction. On the real rollout
  // this reported 216 parts for a call the host sent 27 of, with no line
  // saying 189 had left: the host REBASES the item list, and reading the file
  // from the top shows a context two hundred items longer than the one that
  // was sent.
  it('takes the context of a call after a compaction from the host own replacement list', () => {
    const a = at(write('rollout.jsonl', codexRecord({ secondCall: true })), 1);

    // The two the host wrote as its replacement, then the one item recorded
    // since the boundary — not the two items it dropped.
    expect(a.parts.map((p) => p.via[0])).toEqual(['replacement 0', 'replacement 1', 'item 2']);
    expect(a.parts[0]!.text).toContain('the summary of what came before');
    expect(a.parts.map((p) => p.text)).not.toContain('the first ask');
    // Each replacement part entered at the call the boundary handed it to.
    expect(a.parts[0]!.entered).toBe(1);
  });

  // Mutation: drop the items silently. An operator reading a post-compaction
  // call has to be told that most of the session is gone from it, and where
  // the last call that held it is.
  it('says what the compaction dropped, and which call last held it', () => {
    const a = at(write('rollout.jsonl', codexRecord({ secondCall: true })), 1);

    const gaps = a.gaps.join(' ');
    // The figure is what the call before the boundary HELD — not the file's
    // item count, which on a second boundary counts items an earlier one
    // already took out, and here counts the first call's own tool request,
    // which was never in any call's input (ward on H-3757, finding 3c).
    expect(gaps).toContain('the 1 part the call before the compaction');
    expect(gaps).toContain("NOT in this call's context");
    expect(gaps).toContain('2 items it wrote as its replacement_history');
    expect(gaps).toContain('Ask --at 0 for that call, which is the last one that held them');
  });

  // Mutation: report a boundary with no replacement list as one that replaced
  // the context with nothing. Every compacted entry on this machine carries a
  // replacement list, so this branch is reached only by a host that writes
  // none — and then the post-boundary context is UNREADABLE rather than short,
  // which is the one distinction the surface is for.
  it('says a boundary whose replacement list this record lacks leaves the context unreadable', () => {
    const entries = codexRecord({ secondCall: true }) as Record<string, unknown>[];
    const compacted = entries.find((e) => e['type'] === 'compacted')!;
    delete (compacted['payload'] as Record<string, unknown>)['replacement_history'];

    const a = at(write('no-replacement.jsonl', entries), 1);

    expect(a.parts.map((p) => p.via[0])).toEqual(['item 2']);
    const gaps = a.gaps.join(' ');
    expect(gaps).toContain('this record holds no replacement_history for that boundary');
    expect(gaps).toContain('1 part above is only what was recorded SINCE it');
    expect(gaps).not.toContain('Ask --at');
  });

  // Mutation: carry every span to the last call. `--find` reported each of
  // the rollout's 216 pre-compaction items as held through the final call,
  // which is the same error in the answer an operator is most likely to
  // quote: "this instruction was in the context the whole way".
  it('ends a find span at the compaction that dropped the part', () => {
    const path = write('rollout.jsonl', codexRecord({ secondCall: true }));

    const dropped = find(path, 'the first ask').hits[0]!;
    expect(dropped).toMatchObject({ ref: 'item 0', first_invocation: 0, last_invocation: 0, invocations: 1 });

    // The replacement begins its own span at the boundary.
    const replacement = find(path, 'the summary of what came before').hits[0]!;
    expect(replacement.ref).toContain('replacement 0');
    expect(replacement).toMatchObject({ first_invocation: 1, last_invocation: 1, invocations: 1 });
    expect(find(path, 'the first ask').gaps.join(' ')).toContain('a span above ends at the first boundary');
  });

  // Mutation: report an empty span as `first_invocation` with 0 invocations.
  // An item a compaction dropped before any call was given it — one call's own
  // output — was in no call's INPUT, and `first 1, invocations 0` renders as
  // "call 1".
  it('reports a part no call input ever held as in no call', () => {
    const path = write('rollout.jsonl', codexRecord({ secondCall: true }));
    const f = find(path, 'printf one');

    expect(f.hits[0]).toMatchObject({ ref: 'item 1', first_invocation: null, invocations: 0 });
    expect(renderContextFind(f as Parameters<typeof renderContextFind>[0])).toContain('in no call');
  });

  // Mutation: report the compaction without the item counts. `--changes` was
  // the one place a codex compaction showed at all, and it named the host's
  // token figures while saying nothing about the context being replaced.
  it('names the items a codex compaction dropped and the ones that replaced them', () => {
    const e = evolution(write('rollout.jsonl', codexRecord({ secondCall: true })));

    const notable = e.changes.find((c) => c.compaction !== null)!.notable.join(' ');
    // Same re-aiming as the gap above: the count is the parts the previous
    // call held, and the row is the first call on the replacement list.
    expect(notable).toContain('the 1 part the call before it held left the context');
    expect(notable).toContain('the host wrote 2 items as its replacement_history');
  });

  // Mutation: choose the compaction by its item index rather than by the
  // rollout's own order. The host writes the boundary AFTER the call whose
  // window ended on the same item count, so `index <= call.before` handed the
  // call BEFORE the compaction the context of the one after it: on the real
  // rollout, 27 replacement parts for the call the host's own usage record
  // puts at 204,655 input tokens.
  it('leaves the call before a compaction with the context it was given', () => {
    const entries = codexRecord({ secondCall: true }) as Record<string, unknown>[];
    // A call whose window ends exactly at the boundary having produced
    // nothing — the shape the real rollout's call 66 has.
    const boundary = entries.findIndex((e) => e['type'] === 'compacted');
    entries.splice(boundary, 0, {
      type: 'token_usage_record', timestamp: '2026-10-29T04:59:00.000Z',
      payload: { response_id: 'resp_at_boundary', turn_id: 'turn-1', usage: { input_tokens: 1_900_000 } },
    });

    const a = at(write('at-boundary.jsonl', entries), 1);

    expect(a.host_tokens!.basis).toContain('resp_at_boundary');
    expect(a.parts.map((p) => p.via[0])).toEqual(['item 0', 'item 1']);
    expect(a.gaps.join(' ')).not.toContain('replacement_history');
    // ...and the next call, the first the boundary applies to, does hold it.
    expect(at(write('at-boundary.jsonl', entries), 2).parts[0]!.via[0]).toBe('replacement 0');
  });

  // Mutation: report an unreadable part's size as null. 64KB of a call's
  // context that cannot be read here is the figure most worth having, so the
  // size stays and only the readable total excludes it.
  it('keeps the size of a part it cannot read, and out of the readable total', () => {
    const a = at(write('rollout.jsonl', codexRecord({ secondCall: true })), 1);

    const opaque = a.parts.find((p) => p.origin === 'unreadable')!;
    expect(opaque.bytes).toBeGreaterThan(0);
    expect(a.totals.part_bytes).toBe(a.parts.filter((p) => p.origin === 'retained').reduce((sum, p) => sum + p.bytes!, 0));
  });

  // Mutation: call the host's preserved list the messages carried across. On
  // the real boundary the host lists 50 transcript entries as preserved and
  // its next request carries 5 messages, 0 of them byte-equal to one of the
  // 50. Both figures printed on one screen, and only the parts count came off
  // the request the host actually sent.
  it('does not call the host preserved list what the next call carried', () => {
    const e = evolution(write('compacted.jsonl', claudeRecord({ compaction: true })));

    const notable = e.changes.find((c) => c.compaction !== null)!.notable.join(' ');
    expect(notable).not.toContain('messages carried across');
    expect(notable).toContain('the host lists 3 transcript entries as preserved');
    expect(notable).toContain('not the message array of the next call, which is the parts figure above');
  });
});

// What ward's re-judgement of that remediation found (H-3757, acceptance FAIL
// against helmo@370c887): findings 1, 2 and 4 closed, and finding 3 closed in
// `--at` and `--find` — but `--changes`, the mode built for "when did the
// context shrink", still put a codex boundary on the wrong call and stated its
// size from the wrong pair of figures. Three defects, one kind: the timeline
// said something other than what the host's own record says.
describe('what the timeline says about a codex compaction', () => {
  const two = (): string => write('two-boundaries.jsonl', codexCompactionsRecord());

  // Mutation: choose the row by the boundary's item index. The `compacted`
  // entry is written straight after a usage record, so its item index IS the
  // previous call's window and `index <= turn.before` lands on the call
  // BEFORE — the call `--at` still shows holding all 216 dropped items on
  // 01a1651a-98d5, while the first call on the replacement list showed no
  // compaction at all.
  it('puts a boundary on the first call whose context was the replacement list', () => {
    const e = evolution(two());

    expect(e.changes.filter((c) => c.compaction !== null).map((c) => c.ordinal)).toEqual([2, 5]);
    // The call before each boundary still held everything, and says nothing.
    expect(e.changes[1]!.compaction).toBeNull();
    expect(e.changes[4]!.compaction).toBeNull();
    // ...and it is the same call `--at` reads the replacement list at.
    expect(at(two(), 2).parts.map((p) => p.via[0])).toEqual(['replacement 0']);
  });

  // Mutation: list only the items recorded since the boundary as the row's
  // additions. On every real boundary that reads "+0 added" on the one row
  // where the entire context was replaced, because the host writes the
  // replacement list and no new item between the two.
  it('counts the host replacement items as what entered at that row', () => {
    const e = evolution(two());

    const first = e.changes[2]!;
    expect(first.added.map((p) => p.via[0])).toEqual(['replacement 0']);
    expect(first.added.map((p) => p.entered)).toEqual([2]);
    const second = e.changes[5]!;
    expect(second.added.map((p) => p.via[0])).toEqual(['replacement 0', 'replacement 1']);
  });

  // Mutation: keep the item index as an added part's slot. A slot is a
  // position in THAT call's message list, and after a boundary the file's
  // item index is past the end of it: call 68 of 01a1651a-98d5 held 29 parts
  // and its two additions were labelled slots 216 and 217.
  it('numbers an added part by its place in that call context, not by its item index', () => {
    const path = two();
    const e = evolution(path);

    // Call 3 holds the replacement item then item 2: slots 0 and 1.
    expect(e.changes[3]!.added.map((p) => [p.via[0], p.slot])).toEqual([['item 2', 1]]);
    expect(e.changes[4]!.added.map((p) => [p.via[0], p.slot])).toEqual([['item 3', 2]]);
    const held = at(path, 4).parts.map((p) => p.via[0]);
    expect(held).toEqual(['replacement 0', 'item 2', 'item 3']);
    // Every added slot is a slot that call really has.
    expect(e.changes[4]!.added.every((p) => p.slot < held.length)).toBe(true);
  });

  // Mutation: quote the boundary's own pre_tokens → post_tokens as the
  // shrink. On codex both are pre-compaction — the turn's cumulative input
  // and the call the usage record was written after — so the row read
  // "404925 → 204655" while 24,837, the host's figure for that very call, sat
  // on the next row down. Two contradicting figures on one screen.
  it('states the drop from the host per-call figures either side of the boundary', () => {
    const e = evolution(two());

    const notable = e.changes[2]!.notable.join(' ');
    expect(notable).toContain('200 → 20 input tokens, the host\'s own per-call figures');
    expect(notable).not.toMatch(/300 → 200/);
    // The boundary's own two figures are still reported, as what they are.
    expect(notable).toContain('300 input tokens for the TURN so far and 200 for the call its usage record was written after');
    expect(notable).toContain('both pre-compaction');
    // They are the pair the record holds, so a --json reader is not misled.
    expect(e.changes[2]!.compaction).toMatchObject({ pre_tokens: 300, post_tokens: 200 });
  });

  // Mutation: count the file's items as what a boundary dropped. At a SECOND
  // boundary that count includes everything the first one already took out:
  // on 01a1651a-98d5 the row said "the 400 items recorded before it", where
  // the call before it held 211 parts and 216 of those 400 had left at call
  // 67. 8 of the 20 compacted rollouts on this machine have two or more.
  it('counts a later boundary drop as the parts the call before it held', () => {
    const path = two();
    const e = evolution(path);

    expect(at(path, 4).totals.parts).toBe(3);
    // The file has recorded 4 items by the second boundary; 2 of them left at
    // the first, and the replacement item that replaced them also leaves.
    expect(e.changes[5]!.compaction!.index).toBe(4);
    expect(e.changes[5]!.notable.join(' ')).toContain('the 3 parts the call before it held left the context');
    expect(e.changes[5]!.notable.join(' ')).not.toContain('the 4 parts');
    // ...and `--at` says the same thing about the same boundary.
    expect(at(path, 5).gaps.join(' ')).toContain('the 3 parts the call before the compaction');
    expect(at(path, 5).gaps.join(' ')).toContain('Ask --at 4 for that call, which is the last one that held them');
  });

  // Mutation: require a call before the boundary. A resumed rollout opens
  // with its boundary — 2 of the 20 compacted rollouts here — and `index >
  // from` is false at item 0, so the boundary was reported by no row at all.
  it('reports a boundary a rollout opens with, and does not invent a drop for it', () => {
    const path = write('opens-compacted.jsonl', codexCompactionsRecord({ opensCompacted: true }));
    const e = evolution(path);

    const first = e.changes[0]!;
    expect(first.compaction).not.toBeNull();
    expect(first.added.map((p) => p.via[0])).toEqual(['replacement 0', 'replacement 1', 'item 0']);
    expect(first.notable.join(' ')).toContain('it opens compacted, which is how a resumed session starts');
    expect(first.notable.join(' ')).toContain('no size is stated for the drop');
    expect(first.notable.join(' ')).not.toMatch(/\d+ parts the call before it held/);
    expect(at(path, 0).totals.parts).toBe(3);
  });

  // Mutation: report a boundary only where a row carries it. A boundary the
  // rollout records after its last call belongs to no row's context, and
  // pinning rows by order would drop it from the timeline silently.
  it('names a boundary recorded after the last call rather than omitting it', () => {
    const entries = codexCompactionsRecord();
    const last = entries.findIndex((e) => (e as { payload?: { response_id?: string } }).payload?.response_id === 'resp_5');
    entries.splice(last + 1, 0, entries[entries.findIndex((e) => (e as { type?: string }).type === 'compacted')]!);
    const e = evolution(write('trailing.jsonl', entries));

    expect(e.changes).toHaveLength(6);
    expect(e.changes.at(-1)!.notable.join(' ')).toContain('AFTER this last call');
    expect(e.changes.at(-1)!.notable.join(' ')).toContain('were never given to a call this rollout records');
  });
});

// A rollout the host wrote as a CONTINUATION of a thread holds only its tail:
// `session_meta.history_base` names the thread and the ordinal this file picks
// up at, and the entries before it are in a different record. Three of the 867
// codex records on this machine are such a tail, and every reading of them
// showed what the file holds as if it were the whole context: `--at 0` listed
// 5 parts for a call the host's own usage record puts at 91,273 input tokens
// (88,192 cached), 2 against 77,407, and 0 against 243,044 — and the boundary
// row said "the 0 parts the call before it held left the context" on a row
// whose own token pair reads 243,044 → 24,819 (ward on H-3763).
describe('what a rollout that continues a thread does not hold', () => {
  const tail = (name = 'continues.jsonl'): string => write(name, codexCompactionsRecord({ continuesThread: true }));

  // Mutation: read `history_base` without requiring a positive ordinal. Every
  // rollout carries `history_mode: paginated`, so a base of zero or an absent
  // one is the ordinary case and claiming a shortfall there would put the
  // caveat on all 867 records instead of 3.
  it('says nothing about a base on a rollout that opened its own thread', () => {
    for (const path of [
      write('own-thread.jsonl', codexCompactionsRecord()),
      // The same, with the field present and its ordinal 0: a base naming no
      // entries before this file is not a shortfall.
      write('empty-base.jsonl', codexCompactionsRecord({ emptyBase: true })),
    ]) {
      expect(at(path, 1).gaps.join(' ')).not.toContain('CONTINUES thread');
      expect(evolution(path).gaps.join(' ')).not.toContain('CONTINUES thread');
      expect(find(path, 'ask 1').gaps.join(' ')).not.toContain('CONTINUES thread');
    }
  });

  // Mutation: list the parts and say nothing. The parts are each real; the
  // context they are presented as is not, and the host's own input figure for
  // the call is the measure of how much of a tail they are.
  it('names the base and the host own figure on a call before the first boundary', () => {
    const gaps = at(tail(), 1).gaps.join(' ');

    expect(gaps).toContain('CONTINUES thread 01a18468-eb66-7892-841e-3bc876b47680');
    expect(gaps).toContain('history_base at ordinal 1065, byte 4150695');
    expect(gaps).toContain('the 1065 entries the thread recorded before it are in a different rollout');
    expect(gaps).toContain('Every call before the compaction on call 2 was given the thread\'s earlier entries');
    expect(gaps).toContain('are only what this file records before this call, against the host\'s own 200 input tokens for it');
  });

  // Mutation: carry the shortfall to the end of the record. A compaction ENDS
  // it: the host writes its replacement list into THIS file, so from the first
  // boundary on the context is wholly here, and saying otherwise would report
  // a gap that is not there on 2 of this machine's 3 such records.
  it('stops claiming the shortfall at the first boundary', () => {
    const path = tail();

    expect(at(path, 1).gaps.join(' ')).toContain('CONTINUES thread');
    expect(at(path, 2).gaps.join(' ')).not.toContain('CONTINUES thread');
    expect(at(path, 5).gaps.join(' ')).not.toContain('CONTINUES thread');
  });

  // Mutation: count the parts this file holds as what the boundary dropped.
  // That is not a floor, it is a wrong figure: 0 parts on a boundary whose own
  // row says 243,044 → 24,819, and 262 on one that says 244,416 → 29,097.
  it('refuses to count a drop against a call whose own context is elsewhere', () => {
    const path = tail();
    const e = evolution(path);

    const row = e.changes[2]!;
    expect(row.compaction).not.toBeNull();
    expect(row.notable.join(' ')).toContain('what left cannot be counted here: this rollout continues thread 01a18468-eb66-7892-841e-3bc876b47680 from ordinal 1065');
    expect(row.notable.join(' ')).not.toMatch(/\d+ parts? the call before it held left the context/);
    // The host's own per-call pair is still the measure, and still on the row.
    expect(row.notable.join(' ')).toContain('200 → 20 input tokens');
    // The second boundary has a readable call before it, and still counts.
    expect(e.changes[5]!.notable.join(' ')).toContain('the 3 parts the call before it held left the context');
  });

  // Mutation: keep the cross-reference. "Ask --at 1 for that call, which is
  // the last one that held them" sends the operator to a call that lists none
  // of them, which is the same wrong reading one step further away.
  it('does not send the operator to a call that lists none of the dropped items', () => {
    const gaps = at(tail(), 2).gaps.join(' ');

    expect(gaps).toContain('which this record cannot count, because it continues thread');
    expect(gaps).toContain('--at 1 is that call, and it lists none of them');
    expect(gaps).not.toContain('Ask --at 1 for that call');
  });

  // Mutation: put the note on every short row. A reader scrolling 189 rows of
  // a continuation segment lands in the middle of one, so it goes on the row
  // the shortfall begins at and names where it ends — once, not 77 times.
  it('carries the statement on the timeline and on the row it begins at', () => {
    const e = evolution(tail());

    expect(e.gaps.join(' ')).toContain('CONTINUES thread 01a18468-eb66-7892-841e-3bc876b47680');
    expect(e.changes.filter((c) => c.notable.join(' ').includes('CONTINUES thread')).map((c) => c.ordinal)).toEqual([0]);
    expect(e.changes[0]!.notable[0]).toContain('not the whole of what those calls were given');
  });

  // Mutation: require a compaction before saying anything. The starkest case
  // has none: 14 calls, every one of them given the thread's earlier entries,
  // and no boundary anywhere in the file to rebase them.
  it('says every call is short where the record holds no boundary at all', () => {
    const path = write('no-boundary.jsonl', codexCompactionsRecord({ continuesThread: true, withoutBoundary: true }));

    expect(at(path, 0).gaps.join(' ')).toContain('No compaction replaced the context at a call this record holds, so EVERY one of its 2 calls was given the thread\'s earlier entries');
    expect(at(path, 1).gaps.join(' ')).toContain('EVERY one of its 2 calls');
    expect(evolution(path).changes[1]!.compaction).toBeNull();
  });

  // Mutation: let a nil search result stand as "not in the context". On a
  // continuation segment the needle may be in the thread's earlier entries,
  // which is a different answer from absence.
  it('says a search miss is only a miss in this segment', () => {
    const f = find(tail(), 'a string in the earlier segment');

    expect(f.hits).toHaveLength(0);
    expect(f.gaps.join(' ')).toContain('CONTINUES thread 01a18468-eb66-7892-841e-3bc876b47680');
    expect(f.gaps.join(' ')).toContain('a nil result here is "not in this segment", never "not in the context"');
  });

  // Mutation: resolve the earlier record by its NAME. Both segments of a
  // thread carry the thread id in the filename and the thread id as their own
  // session_meta.session_id, so a name match alone accepts the child itself
  // and a second segment equally.
  it('names the reason no earlier record was read, rather than leaving the thread id as the lead', () => {
    const gaps = at(tail(), 1).gaps.join(' ');

    expect(gaps).toContain('No earlier record was read for them');
    expect(gaps).toContain('no other rollout under');
    expect(gaps).toContain('names thread 01a18468-eb66-7892-841e-3bc876b47680');
  });
});

// The earlier segment, READ. `history_base` carries a byte offset as well as
// an ordinal, and the offset is what identifies the parent: on all three real
// threads the parent file runs 9 to 11 entries PAST the cut — an aborted turn
// written seconds before the resume — so ordinals at and after the base exist
// in both files with different content, while the parent's byte length through
// exactly the base's entries equals the offset on 3 of 3 (ward on H-3771).
describe('the thread segment a continuation picks up from', () => {
  /** A thread written as two records: the earlier segment, and the
   *  continuation that picks up after its `cut` entries. The byte offset is
   *  measured off the parent's own bytes, which is how the host writes it and
   *  the only thing that identifies it. */
  const writeThread = (over: {
    thread?: string;
    compacted?: boolean;
    withoutBoundary?: boolean;
    continues?: { thread_id: string; entries_before: number; byte_offset: number };
    /** Move the stated cut off the parent's real entry boundary. */
    offBy?: number;
    /** Write the earlier segment twice, under two names that both carry the
     *  thread id. */
    twice?: boolean;
  } = {}): { child: string; parent: string; offset: number; cut: number } => {
    const thread = over.thread ?? '01a18468-eb66-7892-841e-3bc876b47680';
    const { entries, cut } = codexThreadParentRecord({ thread, compacted: over.compacted, continues: over.continues });
    const parent = write(`rollout-2026-10-28T14-27-10-${thread}.jsonl`, entries);
    if (over.twice === true) write(`rollout-2026-10-28T09-00-00-${thread}.jsonl`, entries);
    const offset = Buffer.byteLength(entries.slice(0, cut).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const child = write(
      `rollout-2026-10-28T21-04-49-${thread}_01a185d4-f73f-7db2-a4db-63438f35543e.jsonl`,
      codexCompactionsRecord({
        continuesThread: { thread_id: thread, entries_before: cut, byte_offset: offset + (over.offBy ?? 0) },
        withoutBoundary: over.withoutBoundary,
      }),
    );
    return { child, parent, offset, cut };
  };

  // Mutation: do not prepend the earlier segment's items. This is the whole
  // of the finding: `--at 0` listed 0 parts for a call the host's own usage
  // record puts at 243,044 input tokens, 242,432 of them cached.
  it('lists the items it carried in as the first parts of a call before the boundary', () => {
    const { child, parent } = writeThread();
    const a = at(child, 0);

    expect(a.parts.map((p) => p.text)).toEqual(['earlier ask 1', 'earlier ask 2', 'earlier ask 3', 'ask 1']);
    expect(a.parts.slice(0, 3).map((p) => p.via[0])).toEqual(['earlier item 0', 'earlier item 1', 'earlier item 2']);
    expect(a.totals.parts).toBe(4);
    expect(a.gaps.join(' ')).toContain(`the first 3 parts above were read from ${parent}`);
    // The parts are the record's; their SIZE is not the host's. On the three
    // real segments the live items sum to 1.0, 1.4 and 1.5MB against its own
    // per-call figures of 243,044, 91,273 and 77,407 input tokens — an image
    // carried as a base64 data URL being one proven reason — so the host's
    // own figure stays the only size of the context.
    expect(a.gaps.join(' ')).toContain("The host's own input figure for this call is 100 tokens, 0 of them cached, and it stays the only size of this context");
    // Carried in, so no call in this record is the one they arrived at.
    expect(a.parts.slice(0, 3).map((p) => p.entered)).toEqual([null, null, null]);
    expect(a.parts[0]!.caveat).toContain("carried in from the thread's earlier segment");
  });

  // Mutation: read the parent by its ordinal — its first `entries_before`
  // entries — instead of its first `byte_offset` bytes. The ordinals collide:
  // the real parents run 9 to 11 entries past the cut, and an aborted turn
  // nobody saw would be spliced into the child's context.
  it('stops at the byte the base names, so the parent own tail is not in the context', () => {
    const { child } = writeThread();

    expect(at(child, 0).parts.map((p) => p.text).join(' ')).not.toContain('an aborted turn');
    expect(find(child, 'an aborted turn').hits).toHaveLength(0);
  });

  // Mutation: prepend every item in the parent's prefix. A parent that
  // compacted holds items its OWN boundary had already dropped — 476 in the
  // prefix of one real one, of which 101 were live — and the context it hands
  // on is its replacement list plus what it recorded after it.
  it('hands on what the earlier segment held at the cut, not every item in it', () => {
    const { child } = writeThread({ compacted: true });
    const a = at(child, 0);

    expect(a.parts.map((p) => p.text)).toEqual(['the summary of the earlier segment', 'earlier ask 3', 'ask 1']);
    expect(a.parts.map((p) => p.text).join(' ')).not.toContain('earlier ask 1');
  });

  // Mutation: accept a candidate whose name matches without confirming the
  // cut. A reading spliced from the wrong file is worse than the stated gap it
  // replaces, so a cut that falls inside an entry is refused by name.
  it('refuses a record that carries the thread id but is not the cut', () => {
    const { child, offset } = writeThread({ offBy: -1 });
    const gaps = at(child, 0).gaps.join(' ');

    expect(at(child, 0).parts.map((p) => p.text)).toEqual(['ask 1']);
    expect(gaps).toContain('No earlier record was read for them');
    expect(gaps).toContain(`none holds exactly 8 entries in its first ${offset - 1} bytes`);
    expect(gaps).toContain('falls inside an entry rather than at the end of one');
  });

  // Mutation: take the first candidate that holds the cut. Which segment a
  // thread continues is then decided by directory order.
  it('refuses to choose between two records that both hold the cut', () => {
    const { child } = writeThread({ twice: true });
    const gaps = at(child, 0).gaps.join(' ');

    expect(at(child, 0).parts.map((p) => p.text)).toEqual(['ask 1']);
    expect(gaps).toContain('2 records name thread 01a18468-eb66-7892-841e-3bc876b47680 and hold exactly 8 entries');
    expect(gaps).toContain('which one this segment continues is not readable from the record, and none is read');
  });

  // Mutation: count only the items this file holds for what a later boundary
  // dropped. The carried-in items were in that call's context, so they left it
  // at the boundary too — and the count has to be the same two rules the
  // listing uses, or the row and `--at` disagree.
  it('counts what it carried in among the parts a later boundary dropped', () => {
    const { child } = writeThread();
    const row = evolution(child).changes[2]!;

    expect(row.compaction).not.toBeNull();
    expect(row.notable.join(' ')).toContain('the 5 parts the call before it held left the context');
    expect(at(child, 1).totals.parts).toBe(5);
  });

  // Mutation: carry the splice past the first boundary. A compaction ENDS the
  // carry: the host wrote its replacement list into THIS file, so nothing from
  // the earlier segment is in that call's context.
  it('stops carrying the earlier segment in at the first boundary', () => {
    const { child } = writeThread();

    expect(at(child, 2).parts.map((p) => p.via[0])).toEqual(['replacement 0']);
    expect(at(child, 2).gaps.join(' ')).not.toContain('read from');
  });

  // Mutation: do not search the carried-in items. A needle that was in the
  // thread's earlier segment was reported "not in this segment" when it is in
  // this segment's every call until the boundary.
  it('finds a needle in the earlier segment, with the calls it was in context for', () => {
    const { child, parent } = writeThread();
    const f = find(child, 'earlier ask 2');

    expect(f.hits).toHaveLength(1);
    expect(f.hits[0]).toMatchObject({ ref: 'earlier item 1', first_invocation: 0, last_invocation: 1, invocations: 2 });
    expect(f.gaps.join(' ')).toContain('Its 3 carried-in items were searched too');
    expect(f.gaps.join(' ')).toContain(`--record ${parent} searches them`);
  });

  // Mutation: follow one hop and stop. A segment's parent can be a
  // continuation in its turn, and the context the child was given runs back
  // through all of them.
  it('follows a thread through more than one earlier segment', () => {
    const grand = codexThreadParentRecord({ thread: '01a16f05-7c9f-7560-9ed7-0ffe9849c581' });
    write(`rollout-2026-10-24T10-46-33-01a16f05-7c9f-7560-9ed7-0ffe9849c581.jsonl`, grand.entries);
    const offset = Buffer.byteLength(grand.entries.slice(0, grand.cut).map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const { child } = writeThread({ continues: { thread_id: '01a16f05-7c9f-7560-9ed7-0ffe9849c581', entries_before: grand.cut, byte_offset: offset } });
    const a = at(child, 0);

    expect(a.parts.map((p) => p.text)).toEqual([
      'earlier ask 1', 'earlier ask 2', 'earlier ask 3',
      'earlier ask 1', 'earlier ask 2', 'earlier ask 3',
      'ask 1',
    ]);
    expect(a.gaps.join(' ')).toContain('through 2 segments of the thread');
  });

  // Mutation: report the chain whole when a hop in it did not resolve. What is
  // read is then presented as the context, and what is still outside it is not
  // said anywhere.
  it('says what is still outside the reading when an earlier hop did not resolve', () => {
    const { child } = writeThread({ continues: { thread_id: '01a1ffff-0000-7000-8000-000000000000', entries_before: 9, byte_offset: 4_096 } });
    const a = at(child, 0);

    expect(a.parts.map((p) => p.text)).toEqual(['earlier ask 1', 'earlier ask 2', 'earlier ask 3', 'ask 1']);
    expect(a.gaps.join(' ')).toContain('continues thread 01a1ffff-0000-7000-8000-000000000000 from ordinal 9 in its turn, and that segment did not resolve');
  });

  // Mutation: list the carried-in items as the first row's additions. They
  // were in the context before the first call here, so counting them as
  // entering at call 0 says the thread began where this file does.
  it('does not report what it carried in as additions on the first row', () => {
    const { child } = writeThread();
    const e = evolution(child);

    expect(e.changes[0]!.added.map((p) => p.text)).toEqual(['ask 1']);
    expect(e.changes[0]!.notable[0]).toContain('the 3 items the thread held at the cut are listed as the first parts of each of those calls');
    expect(e.changes[0]!.notable[0]).toContain('They are not listed as additions on this row or on any row until then');
  });
});

// The full-data export (R-56, H-3818). Every case here is about the
// difference between what an operator READS and what an audit has to account
// for: `text` is a rendering, and a rendering of an image is the word
// "[image]". The payload is the host's own bytes, carried only when asked for.
describe('the export an audit reads', () => {
  /** A call carrying the traffic a rendering cannot hold: an image block, a
   *  tool call with a structured input, a structured tool result, and a tool
   *  whose schema is the thing an audit is actually asking about. */
  function toolTrafficRecord(): unknown[] {
    const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const blob = (hash: string, role: string, content: unknown[]) =>
      ({ type: 'api-request-blob', sessionId, hash, message: { role, content } });
    return [
      {
        type: 'api-request-shape', sessionId, shapeHash: 'shape0',
        timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
        shape: {
          system: [{ type: 'text', text: 'host block one' }],
          tools: [{
            name: 'Bash',
            description: 'Run a command',
            input_schema: {
              type: 'object',
              properties: { command: { type: 'string' }, timeout: { type: 'number' } },
              required: ['command'],
            },
          }],
        },
      },
      blob('m0', 'user', [
        { type: 'text', text: 'run it' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      ]),
      blob('m1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', timeout: 5000 } }]),
      blob('m2', 'user', [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: 'total 0' }] }]),
      {
        type: 'api-request', sessionId, id: 'r0', timestamp: '2026-10-29T08:00:01.000Z',
        version: '2.1.300', shapeHash: 'shape0', cwd: '/tmp/seat',
        params: { model: 'claude-opus-5' }, keep: 0, tail: ['m0', 'm1', 'm2'],
      },
    ];
  }

  // Mutation: render the payload with partText instead of carrying the
  // blocks. The rendering says `[image]`, and an audit asking what the model
  // was given gets a five-letter word in place of the part.
  it('carries each part retained content blocks, which the rendered text cannot hold', () => {
    const path = write('tools.jsonl', toolTrafficRecord());
    const read = contextAt(path, 0, { verbatim: true });
    if ('error' in read) throw new Error(read.error);

    // The rendering is still there, and still a rendering.
    expect(read.parts[0]!.text).toBe('run it\n[image]');
    expect(read.parts[0]!.payload).toEqual([
      { type: 'text', text: 'run it' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
    // A tool call's input reaches the export as the object it was, not as the
    // JSON line the rendering makes of it.
    expect(read.parts[1]!.payload).toEqual([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', timeout: 5000 } }]);
    expect(read.parts[2]!.payload).toEqual([{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: 'total 0' }] }]);
  });

  // Mutation: carry `segments` only under `--verbatim`, or build it from the
  // joined text. A part's blocks are STRUCTURE, not content: the inventory
  // reads them on every run of a cohort to tell the pieces of a bundle apart,
  // and it never asks for a verbatim view — it cannot, because a verbatim read
  // implies no truncation and a cohort pass is bounded per part.
  it('carries a part blocks apart, with each block own size, whatever the view', () => {
    const path = write('tools.jsonl', toolTrafficRecord());
    const read = at(path, 0);
    if ('error' in read) throw new Error(read.error);

    const bundled = read.parts[0]!;
    expect(bundled.segments).toEqual([
      { type: 'text', text: 'run it', bytes: Buffer.byteLength(JSON.stringify({ type: 'text', text: 'run it' }), 'utf8') },
      { type: 'image', text: '[image]', bytes: Buffer.byteLength(JSON.stringify({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }), 'utf8') },
    ]);
    // The pieces sum to the part less its own envelope and the array framing
    // around them — a real difference, left uncounted rather than smeared.
    const pieces = bundled.segments!.reduce((n, g) => n + g.bytes, 0);
    expect(pieces).toBeLessThan(bundled.bytes!);
    expect(bundled.bytes! - pieces).toBeLessThan(40);
    // Nothing to take apart: one block, and `text` is it.
    expect(read.parts[1]!.segments).toBeNull();
  });

  // Mutation: drop `segmentsFor`'s truncation test and take the blocks apart
  // anyway. The blocks come from the record, not from the clipped text, so a
  // bounded read would hand back every block whole — content past the cut the
  // caller asked not to be given — and the inventory, which reads later parts
  // under a finite bound, would classify and containment-match pieces of a
  // part it cannot see the end of.
  it('takes no part apart once its text has been clipped', () => {
    const path = write('tools.jsonl', toolTrafficRecord());
    const read = at(path, 0, 5);

    const bundled = read.parts[0]!;
    expect(bundled.truncated).toBe(true);
    expect(bundled.text).toBe('run i');
    expect(bundled.segments).toBeNull();
  });

  // Mutation: carry the payload always. Every terminal reading of a long
  // session would then hold a second copy of every part it already printed.
  it('carries no payload unless it was asked for', () => {
    const a = at(write('tools.jsonl', toolTrafficRecord()), 0);

    expect(a.parts.map((p) => p.payload)).toEqual([null, null, null]);
    expect(a.instructions!.tools.map((t) => t.definition)).toEqual([null]);
  });

  // Mutation: keep the three-field summary. A tool's name, size and
  // description do not say what it TAKES, and the schema is in the record.
  it('carries each tool whole definition, schema included', () => {
    const path = write('tools.jsonl', toolTrafficRecord());
    const read = contextAt(path, 0, { verbatim: true });
    if ('error' in read) throw new Error(read.error);

    expect(read.instructions!.tools[0]).toEqual({
      name: 'Bash',
      bytes: expect.any(Number),
      description: 'Run a command',
      definition: {
        name: 'Bash',
        description: 'Run a command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' }, timeout: { type: 'number' } },
          required: ['command'],
        },
      },
    });
  });

  // Mutation: honour --chars under --verbatim. A content block clipped at the
  // preview length is a rendering again, under a field name that promises it
  // is not.
  it('is never truncated, whatever preview length came with it', () => {
    const path = write('tools.jsonl', toolTrafficRecord());
    const read = contextAt(path, 0, { chars: 4, verbatim: true });
    if ('error' in read) throw new Error(read.error);

    expect(read.parts.every((p) => p.truncated === false)).toBe(true);
    expect(read.parts[0]!.text).toBe('run it\n[image]');
  });

  // Mutation: keep `blocks` as the whole account of the codex instructions.
  // The fixture's world_state holds four keys; two of them are prose the
  // blocks carry, and `tools`/`top_level_tools` are the tool list. A real one
  // holds twenty, sixteen of which no block or tool row accounts for —
  // environments, permissions, collaboration_mode, the model catalogue — and
  // a reading that names three keys as "the instructions" reads as complete.
  it('carries the whole codex world_state, not the keys it renders as prose', () => {
    const entries = codexRecord({ compaction: false });
    const full = entries.find((e) => (e as { type?: string }).type === 'world_state') as Record<string, unknown>;
    (((full['payload'] as Record<string, unknown>)['state']) as Record<string, unknown>)['permissions'] = { approval: 'never' };
    const path = write('state.jsonl', entries);

    const read = contextAt(path, 0, { verbatim: true });
    if ('error' in read) throw new Error(read.error);
    expect((read.instructions!.state as Record<string, unknown>)['permissions']).toEqual({ approval: 'never' });

    // And a reader who did not ask for the payload is told the key is there.
    const plain = at(path, 0);
    expect(plain.instructions!.state).toBeNull();
    expect(plain.gaps.join(' ')).toContain('the host\'s full state for this call holds 1 more (permissions)');
  });

  // Mutation: report `model` and call the call's parameters accounted for.
  // The betas in force and the host's context-management edits are what the
  // call WAS, and claude writes them on every request entry.
  it('carries the parameters a claude call was sent under, and says codex records none', () => {
    const path = write('tools.jsonl', toolTrafficRecord());
    const read = contextAt(path, 0, { verbatim: true });
    if ('error' in read) throw new Error(read.error);
    expect(read.call_params).toEqual({ model: 'claude-opus-5' });
    expect(at(path, 0).call_params).toBeNull();

    const codex = contextAt(write('rollout.jsonl', codexRecord({ compaction: false })), 0, { verbatim: true });
    if ('error' in codex) throw new Error(codex.error);
    expect(codex.call_params).toBeNull();
  });

  // Mutation: carry the codex item's rendered text as its payload. The
  // reasoning item's plaintext is nowhere on this machine, and its entry —
  // the encrypted_content the host DID write — is what an audit accounts for.
  it('carries a codex response item as the host wrote it, including what has no plaintext', () => {
    const path = write('rollout.jsonl', codexRecord({ attachment: true, secondCall: true }));
    const first = contextAt(path, 0, { verbatim: true });
    if ('error' in first) throw new Error(first.error);

    const image = first.parts.find((p) => JSON.stringify(p.payload).includes('input_image'));
    expect(image).toBeDefined();
    const blocks = (image!.payload![0] as { content: Record<string, unknown>[] }).content;
    // The rendering reports the data URL's size and refuses to print it; the
    // payload holds the URL itself and the `detail` the rendering has no
    // place for.
    expect(image!.text).toContain('bytes of inline image data');
    expect(blocks[1]!['image_url']).toMatch(/^data:image\/png;base64,/);
    expect(blocks[1]!['detail']).toBe(4);

    // The call after the compaction opens on the replacement list, and one of
    // its items is carried only as provider-encrypted text. It was in that
    // call's context; what it said is not on this machine, and the entry the
    // host DID write is what an audit accounts for.
    const after = contextAt(path, 1, { verbatim: true });
    if ('error' in after) throw new Error(after.error);
    const opaque = after.parts.find((p) => p.origin === 'unreadable');
    expect(opaque).toBeDefined();
    expect(opaque!.text).toBeNull();
    expect((opaque!.payload![0] as Record<string, unknown>)['encrypted_content']).toBe('gAAAAABq4_compaction');
  });
});

// Where each ACQUIRED input in a context came from (R-56, H-3818). The
// largest part of a run's context is neither configured nor written by the
// run: it is fetched, and until this it reached every reading as an anonymous
// bucket of tool output. A result names its request by the host's call id and
// carries nothing else, so every case here is about the join back to the
// request — and about the places the join honestly cannot be made.
describe('where an acquired input came from', () => {
  const sessionId = 'cccccccc-1111-2222-3333-444444444444';
  const blob = (hash: string, role: string, content: unknown[]) =>
    ({ type: 'api-request-blob', sessionId, hash, message: { role, content } });
  const shape = {
    type: 'api-request-shape', sessionId, shapeHash: 'shape0',
    timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
    shape: { system: [{ type: 'text', text: 'host block' }], tools: [] },
  };
  const request = (slots: string[], id = 'r0', keep = 0) => ({
    type: 'api-request', sessionId, id, timestamp: '2026-10-29T08:00:01.000Z',
    version: '2.1.300', shapeHash: 'shape0', cwd: '/tmp/seat',
    params: { model: 'claude-opus-5' }, keep, tail: slots,
  });

  // Mutation: leave `acquired` null on every part. The question Arthur asked
  // this capability for — what is in a run's context and where did it come
  // from — has no answer for the bytes that make up most of it.
  it('names the file, ticket and command each result was fetched with', () => {
    const path = write('acq.jsonl', [
      shape,
      blob('m0', 'user', [{ type: 'text', text: 'go' }]),
      blob('m1', 'assistant', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/Users/a/projects/crew/AGENTS.md' } },
        { type: 'tool_use', id: 't2', name: 'mcp__helmo__helmo_get_ticket', input: { ticket_id: 'H-3818', format: 'state' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git -C /tmp log -1' } },
      ]),
      blob('m2', 'user', [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'the rules' }] },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '{"id":"H-3818"}' }] },
        { type: 'tool_result', tool_use_id: 't3', is_error: true, content: [{ type: 'text', text: 'not a repository' }] },
      ]),
      request(['m0', 'm1', 'm2']),
    ]);
    const a = at(path, 0);

    expect(a.parts[2]!.acquired!.map((i) => [i.kind, i.source, i.tool, i.basis, i.source_field])).toEqual([
      ['file', '/Users/a/projects/crew/AGENTS.md', 'Read', 'argument', 'file_path'],
      ['ticket', 'H-3818', 'mcp__helmo__helmo_get_ticket', 'argument', 'ticket_id'],
      ['command', 'git -C /tmp log -1', 'Bash', 'argument', 'command'],
    ]);
    // The request is an earlier slot of the same list, and the reader says
    // which — so a human can check the attribution rather than trust it.
    expect(a.parts[2]!.acquired!.every((i) => i.request_slot === 1)).toBe(true);
    // An error result is still context: it occupied a slot and bytes. It is
    // marked, not dropped, and it is not treated as a source of content.
    expect(a.parts[2]!.acquired!.map((i) => i.is_error)).toEqual([null, null, true]);
  });

  // Mutation: resolve the kind from a table of tool NAMES. The table is this
  // reader's guess about today's tool set, applied to a run made under
  // another one — so it goes quietly wrong instead of reporting `tool`.
  it('reads the source out of the argument field, never out of the tool name', () => {
    const path = write('field.jsonl', [
      shape,
      blob('m0', 'assistant', [
        // A tool this reader has never heard of, carrying a field it knows.
        { type: 'tool_use', id: 't1', name: 'AcmeFetchLocalDoc', input: { file_path: '/tmp/doc.md' } },
        // A tool whose NAME says file, whose arguments name no source at all.
        { type: 'tool_use', id: 't2', name: 'Read', input: { limit: 40 } },
      ]),
      blob('m1', 'user', [
        { type: 'tool_result', tool_use_id: 't1', content: 'the doc' },
        { type: 'tool_result', tool_use_id: 't2', content: 'nothing' },
      ]),
      request(['m0', 'm1']),
    ]);
    const a = at(path, 0);

    expect(a.parts[1]!.acquired!.map((i) => [i.kind, i.source, i.basis])).toEqual([
      ['file', '/tmp/doc.md', 'argument'],
      // Named as a tool call carrying these arguments — not as a file, and
      // not as absent. The kind stays `tool` because nothing but the tool's
      // name says otherwise, and its name is the one thing not read here.
      ['tool', 'limit=40', 'argument_set'],
    ]);
  });

  // Mutation: leave a request with no recognised source field at
  // `no_source_field`. On the measured cohort that is 1,017,091B of acquired
  // context — ticket queries taking filters rather than an id — reaching an
  // audit as 0 distinct sources, so "where did this come from" answers "a
  // tool was called" for a fifth of the bytes.
  it('names a call by its whole argument set when no one field names a thing', () => {
    const body = 'x'.repeat(400);
    const path = write('argset.jsonl', [
      shape,
      blob('m0', 'assistant', [
        { type: 'tool_use', id: 't1', name: 'mcp__helmo__helmo_list_tickets', input: { project: 'R-45', limit: 30 } },
        // The same query, written in the other key order: one source, not two.
        { type: 'tool_use', id: 't2', name: 'mcp__helmo__helmo_list_tickets', input: { limit: 30, project: 'R-45' } },
        // No arguments at all is still an identity — the unfiltered call.
        { type: 'tool_use', id: 't3', name: 'mcp__helmo__helmo_hygiene', input: {} },
        // Content, not a filter: unique to its call, so counting it as a
        // distinct source would report one source per call and say nothing.
        { type: 'tool_use', id: 't4', name: 'mcp__helmo__helmo_create_ticket', input: { title: 'a', body } },
        // A nested object is a structure; flattening it would invent a name.
        { type: 'tool_use', id: 't5', name: 'Acme', input: { actor: { name: 'mason' } } },
      ]),
      blob('m1', 'user', [
        { type: 'tool_result', tool_use_id: 't1', content: 'a' },
        { type: 'tool_result', tool_use_id: 't2', content: 'b' },
        { type: 'tool_result', tool_use_id: 't3', content: 'c' },
        { type: 'tool_result', tool_use_id: 't4', content: 'd' },
        { type: 'tool_result', tool_use_id: 't5', content: 'e' },
      ]),
      request(['m0', 'm1']),
    ]);
    const a = at(path, 0);

    expect(a.parts[1]!.acquired!.map((i) => [i.source, i.basis, i.source_field])).toEqual([
      ['limit=30 project=R-45', 'argument_set', null],
      ['limit=30 project=R-45', 'argument_set', null],
      ['()', 'argument_set', null],
      [null, 'no_source_field', null],
      [null, 'no_source_field', null],
    ]);
    // Five calls of one kind, three of which named themselves, and the two
    // that named the same thing are one source.
    expect(a.acquired.find((k) => k.kind === 'tool')).toMatchObject({ inputs: 5, sources: 2 });
  });

  // Mutation: credit each source with the whole part's bytes. One claude
  // message carries every result of a parallel batch, so a four-call batch
  // would report four times the context it actually was.
  it('sizes each input by its own result, not by the message that carried it', () => {
    const path = write('batch.jsonl', [
      shape,
      blob('m0', 'assistant', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b' } },
      ]),
      blob('m1', 'user', [
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'tool_result', tool_use_id: 't2', content: 'y'.repeat(500) },
      ]),
      request(['m0', 'm1']),
    ]);
    const a = at(path, 0);
    const [small, large] = a.parts[1]!.acquired!;

    expect(large!.bytes).toBeGreaterThan(small!.bytes! * 10);
    // And the two together do not exceed the part they came out of.
    expect(small!.bytes! + large!.bytes!).toBeLessThanOrEqual(a.parts[1]!.bytes!);
  });

  // Mutation: fall back to `tool` when the request is not found. A result
  // whose request has left the context — dropped prefix, compaction — would
  // read as a tool call whose arguments named nothing, which is a claim about
  // a request this reader never saw.
  it('says so when a result request is no longer in the context', () => {
    const path = write('gone.jsonl', [
      shape,
      blob('m0', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }]),
      blob('m1', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]),
      request(['m0', 'm1'], 'r0'),
      // The next call keeps nothing of its predecessor and re-adds only the
      // result: the host dropped the request that produced it.
      { ...request(['m1'], 'r1', 0), base: 'r0' },
    ]);
    const second = at(path, 1).parts[0]!.acquired![0]!;

    expect([second.kind, second.basis, second.call_id, second.tool, second.request_slot])
      .toEqual(['unknown', 'request_absent', 't1', null, null]);
  });

  // Mutation: return an empty list for a part holding no result. `[]` reads
  // as a result whose sources came to nothing; `null` says nothing was
  // acquired here at all, and on an unreadable part says it cannot be known.
  it('carries no acquisition list for a part that is not a result', () => {
    const path = write('plain.jsonl', [
      shape,
      blob('m0', 'user', [{ type: 'text', text: 'go' }]),
      blob('m1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }]),
      blob('m2', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]),
      request(['m0', 'm1', 'm2', 'missing']),
    ]);
    const a = at(path, 0);

    expect(a.parts[0]!.acquired).toBeNull();
    expect(a.parts[1]!.acquired).toBeNull();
    expect(a.parts[2]!.acquired).not.toBeNull();
    expect(a.parts[3]!.origin).toBe('unreadable');
    expect(a.parts[3]!.acquired).toBeNull();
  });

  // Mutation: carry the request arguments on every reading, or withhold the
  // source name until --verbatim. The first puts a second object on every
  // part of a terminal view; the second hides the one field an audit opens
  // with behind a flag.
  it('always names the source, and carries the request arguments only when asked', () => {
    const path = write('view.jsonl', [
      shape,
      blob('m0', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a', offset: 10 } }]),
      blob('m1', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]),
      request(['m0', 'm1']),
    ]);

    expect(at(path, 0).parts[1]!.acquired![0]!.request).toBeNull();
    expect(at(path, 0).parts[1]!.acquired![0]!.source).toBe('/a');
    const full = contextAt(path, 0, { verbatim: true });
    if ('error' in full) throw new Error(full.error);
    expect(full.parts[1]!.acquired![0]!.request).toEqual({ file_path: '/a', offset: 10 });
  });

  // Mutation: count inputs as sources. One file read forty times and forty
  // files are the same number of inputs and a different finding, and the
  // account exists to tell them apart.
  it('accounts for the call context by kind, counting distinct sources', () => {
    const path = write('account.jsonl', [
      shape,
      blob('m0', 'assistant', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } },
      ]),
      blob('m1', 'user', [
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'tool_result', tool_use_id: 't2', content: 'x' },
        { type: 'tool_result', tool_use_id: 't3', content: 'y' },
      ]),
      request(['m0', 'm1']),
    ]);
    const a = at(path, 0);

    expect(a.acquired.find((k) => k.kind === 'file')).toMatchObject({ inputs: 2, sources: 1 });
    expect(a.acquired.find((k) => k.kind === 'command')).toMatchObject({ inputs: 1, sources: 1 });
    // A kind nothing in this call belongs to is absent, not a row of zeroes.
    expect(a.acquired.map((k) => k.kind)).toEqual(expect.not.arrayContaining(['web', 'unknown']));
    // And the reading says it before an operator opens a single part.
    expect(renderContextAt({ ...a, source: a.source } as never)).toContain('acquired — 2 file');
  });

  // Mutation: key the output test on the item TYPE. The rollouts hold
  // `function_call_output` and `custom_tool_call_output` today and the host
  // adds types without asking; an item carrying a call_id and an output is a
  // result whatever it is called.
  it('joins a codex tool output to its call, with the namespace the host recorded', () => {
    const path = write('rollout.jsonl', [
      { type: 'session_meta', timestamp: '2026-10-29T04:00:00.000Z', payload: { session_id: '01a185da-8c88-7463-8b6f-cf9d0d6945cd', cwd: '/tmp/seat' } },
      { type: 'turn_context', timestamp: '2026-10-29T04:00:02.000Z', payload: { turn_id: 'turn-1', model: 'gpt-6-astra' } },
      // A custom tool call carries its WHOLE input as a string: that string
      // is the thing that was run, and there is no field to read it out of.
      { type: 'response_item', timestamp: '2026-10-29T04:00:02.500Z', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'response_item', timestamp: '2026-10-29T04:00:03.000Z', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: 'sed -n 1,40p /tmp/seat/AGENTS.md' } },
      { type: 'token_usage_record', timestamp: '2026-10-29T04:00:03.050Z', payload: { response_id: 'resp_one', turn_id: 'turn-1', usage: { input_tokens: 100 } } },
      { type: 'response_item', timestamp: '2026-10-29T04:00:03.100Z', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: 'the first forty lines' } },
      // A function call carries JSON in `arguments`, and a namespace naming
      // which server answered it.
      { type: 'response_item', timestamp: '2026-10-29T04:00:03.200Z', payload: { type: 'function_call', call_id: 'call_2', name: 'js', namespace: 'mcp__cua_repl', arguments: '{"code":"var app = 1;","title":"look"}' } },
      { type: 'token_usage_record', timestamp: '2026-10-29T04:00:03.250Z', payload: { response_id: 'resp_two', turn_id: 'turn-1', usage: { input_tokens: 200 } } },
      { type: 'response_item', timestamp: '2026-10-29T04:00:03.300Z', payload: { type: 'function_call_output', call_id: 'call_2', output: 'ok' } },
      { type: 'token_usage_record', timestamp: '2026-10-29T04:00:05.000Z', payload: { response_id: 'resp_three', turn_id: 'turn-1', usage: { input_tokens: 300 } } },
    ]);
    // The third call: the first two tool outputs are inputs to it, which is
    // where a codex result ever appears — never in the call that asked.
    const a = at(path, 2);

    expect(a.parts.map((p) => (p.acquired === null ? null : p.acquired.map((i) => [i.kind, i.source, i.tool])))).toEqual([
      // The ask, then the request the model made, then its output.
      null,
      null,
      [['command', 'sed -n 1,40p /tmp/seat/AGENTS.md', 'exec']],
      null,
      // The arguments were written as a JSON string; no field in the parsed
      // object names a thing, so the set itself is the identity — quoted
      // where a value would otherwise run into the next pair.
      [['tool', 'code="var app = 1;" title=look', 'mcp__cua_repl/js']],
    ]);
    expect(a.parts[2]!.acquired![0]!.request_slot).toBe(1);
    expect(a.parts[4]!.acquired![0]!.request_slot).toBe(3);
  });

  // Mutation: build the request map over the TAIL. A call adds the result of
  // a request its predecessor made, so the request is never in the tail with
  // it — every addition in the timeline would read as source-unknown.
  it('names the source of a result in the timeline, whose request came a call earlier', () => {
    const path = write('timeline.jsonl', [
      shape,
      blob('m0', 'user', [{ type: 'text', text: 'go' }]),
      blob('m1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/seat/PROFILE.md' } }]),
      blob('m2', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'the profile' }]),
      request(['m0', 'm1'], 'r0'),
      { ...request(['m2'], 'r1', 2), base: 'r0', timestamp: '2026-10-29T08:00:02.000Z' },
    ]);
    const e = evolution(path);

    const added = e.changes[1]!.added;
    expect(added.map((p) => (p.acquired ?? []).map((i) => i.source))).toEqual([['/tmp/seat/PROFILE.md']]);
    expect(renderContextEvolution({ ...e, source: e.source } as never)).toContain('<- file /tmp/seat/PROFILE.md — via Read');
  });
});
