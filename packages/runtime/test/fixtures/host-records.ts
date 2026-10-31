// The host-record fixtures the R-55 acceptances read (H-3724).
//
// Disposable records written into a temp directory by the test that uses them.
// The operator's own transcripts are never read: a reader whose whole job is to
// report what a host retained, tested against a live session, would be
// asserting about a file nothing in this repo controls and would go red on the
// next host upgrade for the right reason at the wrong time.
//
// The fixtures are small, but their SHAPES are taken from real records on the
// machine this was built against — claude-code 2.1.300's base/keep/tail delta
// chain and its compact_boundary metadata, codex 0.164's session_meta,
// world_state, turn_context and compacted entries. Where a fixture departs
// from the real shape, the test that reads it says so.
//
// They live here rather than in one acceptance because the context-query
// acceptance must read the SAME shapes the context-trace acceptance does: a
// query that answered over its own private fixture could drift from the
// reading whose accuracy is measured.

/** A claude record: one shape, then a delta chain of requests whose message
 *  lists are 2, 5 and 8 long — the growth a real session shows. */
export function claudeRecord(over: { blobs?: boolean; compaction?: boolean } = {}): unknown[] {
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
 *  and a compaction.
 *
 *  `compaction: false` leaves the boundary out. A compaction REPLACES the item
 *  list, so a call after one holds the host's `replacement_history` and none of
 *  the items before it — which is the wrong fixture for anything about how a
 *  call's own window is bounded. */
export function codexRecord(over: { full?: boolean; encryptedReasoning?: boolean; secondCall?: boolean; compaction?: boolean; attachment?: boolean } = {}): unknown[] {
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
    {
      type: 'response_item', timestamp: '2026-10-29T04:00:03.000Z', ordinal: 4,
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'the first ask' }] },
    },
    // A message carrying an image the way the host writes one: a line of text
    // naming the file, then the whole image as a base64 data URL. One real
    // carried-in message here holds two of them, 537,630 and 223,746
    // characters, and the model was given them as image tokens.
    ...(over.attachment === true
      ? [{
        type: 'response_item', timestamp: '2026-10-29T04:00:03.200Z', ordinal: 4,
        payload: {
          type: 'message', role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/tmp/shot.png">' },
            { type: 'input_image', image_url: `data:image/png;base64,${'QUJD'.repeat(64)}`, detail: 4 },
            { type: 'input_text', text: '</image>' },
          ],
        },
      }]
      : []),
    // Every reasoning item in a real rollout looks like this: an empty
    // `summary` and the content only as provider-encrypted text. The item was
    // in the call's context; what it said is not on this machine.
    ...(over.encryptedReasoning === true
      ? [{
        type: 'response_item', timestamp: '2026-10-29T04:00:03.500Z', ordinal: 4,
        payload: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAABq4_a3ytF' },
      }]
      : []),
    {
      type: 'response_item', timestamp: '2026-10-29T04:00:04.000Z', ordinal: 5,
      payload: { type: 'custom_tool_call', name: 'exec', arguments: 'printf one' },
    },
    {
      // One per API call, carrying the provider's own response id for it. The
      // rollout's finest call boundary: a turn below is a USER turn, and one
      // loop iteration is a single turn with a dozen calls inside it.
      type: 'token_usage_record', timestamp: '2026-10-29T04:00:05.000Z', ordinal: 6,
      payload: {
        response_id: 'resp_one', turn_id: 'turn-1',
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110 },
      },
    },
  );
  if (over.compaction !== false) {
    entries.push({
      type: 'compacted', timestamp: '2026-10-29T05:00:00.000Z', ordinal: 7,
      payload: {
        message: '', window_number: 1,
        first_window_id: 'w0', previous_window_id: 'w0', window_id: 'w1',
        compaction_response_id: 'resp_abc',
        // What the host says the context IS from here on. The two shapes a
        // resumed rollout really opens with: a readable replacement message,
        // and a `compaction` item carried only as provider-encrypted text.
        replacement_history: [
          { type: 'message', role: 'user', content: [{ type: 'text', text: 'the summary of what came before' }] },
          { type: 'compaction', id: 'cp_1', metadata: { kind: 'window' }, encrypted_content: 'gAAAAABq4_compaction' },
        ],
        retained_context: {
          user_messages: [{}, {}], assistant_messages: [{}],
          user_messages_incomplete: false, assistant_messages_incomplete: true, incomplete: false,
        },
        latest_token_usage_record: {
          usage: { input_tokens: 240_000 },
          turn_token_usage: { input_tokens: 1_900_000 },
        },
      },
    });
  }
  entries.push(
    { type: 'turn_context', timestamp: '2026-10-29T05:00:01.000Z', ordinal: 8, payload: { turn_id: 'turn-2', model: 'gpt-6-astra' } },
  );
  if (over.secondCall === true) {
    entries.push(
      { type: 'response_item', timestamp: '2026-10-29T05:00:02.000Z', ordinal: 9, payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'the next ask' }] } },
      {
        type: 'token_usage_record', timestamp: '2026-10-29T05:00:03.000Z', ordinal: 10,
        payload: {
          response_id: 'resp_two', turn_id: 'turn-2',
          usage: { input_tokens: 240, cached_input_tokens: 90, output_tokens: 20, total_tokens: 260 },
        },
      },
    );
  }
  return entries;
}

/** A claude record holding the half of a session's context the host leaves to
 *  its own transcript: r1 and r2 each add messages no blob is retained for,
 *  and the transcript's assistant entries carry the `requestRef` that joins
 *  them to the request they answered.
 *
 *  m5 IS retained, which makes it the validation slot — the one place the
 *  reconstruction can be compared against what the host actually sent.
 *
 *  Shapes from real records: one assistant entry per content block with an
 *  `apiBlockIndex`, written in the file in a DIFFERENT order from the one they
 *  were sent in; `wireToolInputs` keyed by tool_use id, holding the input as
 *  rewritten for the wire; and user tool_result entries carrying no ref.
 */
export function claudeTranscriptRecord(over: { retained?: unknown[]; sidechain?: boolean; brokenGroup?: boolean } = {}): unknown[] {
  const session = 'aaaaaaaa-1111-2222-3333-444444444444';
  const wireInput = { command: 'cd /tmp/seat && printf two > out' };
  const sent = over.retained ?? [
    { type: 'text', text: 'now the write' },
    { type: 'tool_use', id: 't2', name: 'Bash', input: wireInput },
  ];
  const blob = (hash: string, role: string, content: unknown[]) => ({
    type: 'api-request-blob', sessionId: session, hash, message: { role, content },
  });
  const req = (id: string, base: string | null, keep: number, tail: string[], at: string) => ({
    type: 'api-request', sessionId: session, id, timestamp: at, version: '2.1.300',
    shapeHash: 'shape0', params: { model: 'claude-opus-5' },
    ...(base === null ? {} : { base }), keep, tail, requestDigest: `digest-${id}`,
  });
  const turn = (uuid: string, ref: string, index: number, content: unknown[], wire?: Record<string, unknown>) => ({
    type: 'assistant', sessionId: session, uuid, requestRef: ref, apiBlockIndex: index,
    timestamp: '2026-10-29T08:00:02.000Z', isSidechain: false,
    message: { role: 'assistant', id: `msg-${ref}`, content },
    ...(wire === undefined ? {} : { wireToolInputs: wire }),
  });
  const result = (uuid: string, id: string, text: string) => ({
    type: 'user', sessionId: session, uuid, timestamp: '2026-10-29T08:00:02.500Z', isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });
  return [
    {
      type: 'api-request-shape', sessionId: session, shapeHash: 'shape0',
      timestamp: '2026-10-29T08:00:00.000Z', version: '2.1.300',
      shape: { system: [{ type: 'text', text: 'host block one' }], tools: [{ name: 'Bash' }] },
    },
    blob('m0', 'user', [{ type: 'text', text: 'the iteration prompt' }]),
    blob('m1', 'system', [{ type: 'text', text: '<system-reminder>one</system-reminder>' }]),
    // m2 and m3 are r0's reply: the host retains no blob for either.
    blob('m4', 'system', [{ type: 'text', text: '<system-reminder>two</system-reminder>' }]),
    blob('m5', 'assistant', sent),
    // m6 is r1's tool result: no blob.
    blob('m7', 'system', [{ type: 'text', text: '<system-reminder>three</system-reminder>' }]),
    req('r0', null, 0, ['m0', 'm1'], '2026-10-29T08:00:01.000Z'),
    req('r1', 'r0', 2, ['m2', 'm3', 'm4'], '2026-10-29T08:00:02.000Z'),
    req('r2', 'r1', 5, ['m5', 'm6', 'm7'], '2026-10-29T08:00:03.000Z'),
    // The transcript. The prompt comes before any assistant entry and so
    // belongs to no reply group.
    {
      type: 'user', sessionId: session, uuid: 'u0', timestamp: '2026-10-29T08:00:00.500Z',
      isSidechain: false, message: { role: 'user', content: 'the iteration prompt' },
    },
    turn('a0', 'r0', 0, [{ type: 'text', text: 'I will look' }]),
    turn('a1', 'r0', 1, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], { t1: { command: 'cd /tmp/seat && ls' } }),
    result('u1', 't1', 'two files'),
    ...(over.sidechain === true
      // A subagent's own turn, in the same file, answering a request this
      // stream never made.
      ? [{
        type: 'assistant', sessionId: session, uuid: 'sc0', requestRef: 'r1', apiBlockIndex: 0,
        timestamp: '2026-10-29T08:00:02.100Z', isSidechain: true,
        message: { role: 'assistant', id: 'msg-sub', content: [{ type: 'text', text: 'the subagent' }] },
      }]
      : []),
    // r1's reply: written tool_use first, text second, with the index saying
    // which order they were sent in.
    turn('a2', 'r1', 1, [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'printf two > out' } }], { t2: wireInput }),
    turn('a3', 'r1', 0, [{ type: 'text', text: 'now the write' }]),
    ...(over.brokenGroup === true ? [] : [result('u2', 't2', 'written')]),
  ];
}


/** A codex rollout with TWO compaction boundaries, in the shape the real ones
 *  on this machine have: the `compacted` entry is written straight after a
 *  usage record with no item between, so the boundary's item index equals the
 *  previous call's own window. That is what made the item-index reading put
 *  the boundary on the call BEFORE it — the call `--at` still shows holding
 *  every item the boundary dropped (ward on H-3757, finding 3a).
 *
 *  Six calls, each with its own input token figure, so the pair quoted either
 *  side of a boundary is checkable; and the second boundary's file item count
 *  (4) differs from the parts the call before it held (3), which is the
 *  arithmetic finding 3c is about.
 *
 *  `opensCompacted: true` puts a single boundary at item 0 and call 0 — a
 *  resumed session, 2 of the 20 compacted rollouts on this machine — where
 *  there is no call before the boundary to measure the drop against. */
/** The thread's EARLIER segment: the record a continuation picks up after.
 *
 *  `cut` is how many of these entries are before the history base's byte
 *  offset. The entries after it are the shape all three real parents have — an
 *  aborted turn written seconds before the resume, 9 to 11 entries of it — and
 *  they were in no call of the child, which is why the join is read by bytes
 *  and not by the ordinal (ward on H-3771).
 *
 *  `compacted` gives this segment a boundary of its own, so the context it
 *  hands on is its replacement list plus what it recorded after it, and NOT
 *  every item in the file: 2 of the 3 real parents are that shape, one holding
 *  476 items in its prefix of which 101 were live.
 *
 *  `continues` makes this segment a continuation in its turn, for a thread read
 *  through more than one hop. */
export function codexThreadParentRecord(over: { thread?: string; compacted?: boolean; reconfigured?: boolean; continues?: { thread_id: string; entries_before: number; byte_offset: number } } = {}): { entries: unknown[]; cut: number } {
  const thread = over.thread ?? '01a18468-eb66-7892-841e-3bc876b47680';
  const item = (text: string, at: string) => ({
    type: 'response_item', timestamp: at,
    payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] },
  });
  const before: unknown[] = [
    {
      type: 'session_meta', timestamp: '2026-10-28T14:27:10.000Z',
      payload: {
        session_id: thread, cwd: '/tmp/seat', base_instructions: { text: 'You are Codex.' }, history_mode: 'paginated',
        ...(over.continues === undefined
          ? {}
          : { history_base: { thread_id: over.continues.thread_id, end_ordinal_exclusive: over.continues.entries_before, end_byte_offset: over.continues.byte_offset } }),
      },
    },
    {
      // The configuration the segment hands on, and deliberately NOT the same
      // as the child's own: a continuation segment that records no full state
      // of its own was run under this one, and a reading that inherited the
      // right thing from the wrong file would be indistinguishable if both
      // held the same text.
      type: 'world_state', timestamp: '2026-10-28T14:27:11.000Z',
      // `permissions` is one of the sixteen keys of twenty that no block or
      // tool row decomposes: a reading of an inherited state has to name them
      // from the state it actually used.
      payload: { full: true, state: { agents_md: { directory: '/tmp/seat', text: "the earlier segment's repository rules" }, tools: { clock: 'a clock', ledger: 'the tool only the earlier segment was given' }, permissions: { approval: 'on-request' } } },
    },
    { type: 'turn_context', timestamp: '2026-10-28T14:27:12.000Z', payload: { turn_id: 'turn-0', model: 'gpt-6-astra' } },
    item('earlier ask 1', '2026-10-28T14:27:13.000Z'),
    { type: 'token_usage_record', timestamp: '2026-10-28T14:27:14.000Z', payload: { response_id: 'early_0', turn_id: 'turn-0', usage: { input_tokens: 60, cached_input_tokens: 0 } } },
    item('earlier ask 2', '2026-10-28T14:27:15.000Z'),
    ...(over.compacted === true
      ? [{
          type: 'compacted', timestamp: '2026-10-28T14:27:16.000Z',
          payload: {
            message: 'auto', window_id: 'w0', compaction_response_id: 'resp_w0',
            replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'the summary of the earlier segment' }] }],
            retained_context: { user_messages: [{}], assistant_messages: [{}], incomplete: false },
            latest_token_usage_record: { usage: { input_tokens: 60 }, turn_token_usage: { input_tokens: 90 } },
          },
        }]
      : []),
    item('earlier ask 3', '2026-10-28T14:27:17.000Z'),
    // A SECOND full state before the cut: the host rewrites the whole state
    // when the configuration moves, and the one a continuation segment is
    // handed is the last before the cut and not the segment's first. Two of
    // the three real threads' parents hold more than one.
    ...(over.reconfigured === true
      ? [{
          type: 'world_state', timestamp: '2026-10-28T14:27:17.500Z',
          payload: { full: true, state: { agents_md: { directory: '/tmp/seat', text: 'the rules the earlier segment ended under' }, tools: { clock: 'a clock', ledger: 'the tool only the earlier segment was given', almanac: 'added before the cut' }, permissions: { approval: 'never' } } },
        }]
      : []),
    { type: 'token_usage_record', timestamp: '2026-10-28T14:27:18.000Z', payload: { response_id: 'early_1', turn_id: 'turn-0', usage: { input_tokens: 120, cached_input_tokens: 0 } } },
  ];
  // Written after the cut: the aborted turn every real parent ends with.
  const after: unknown[] = [
    { type: 'event_msg', timestamp: '2026-10-28T21:04:47.000Z', payload: { type: 'task_started' } },
    item('an aborted turn the child never saw', '2026-10-28T21:04:48.000Z'),
    { type: 'event_msg', timestamp: '2026-10-28T21:04:48.500Z', payload: { type: 'turn_aborted' } },
  ];
  return { entries: [...before, ...after], cut: before.length };
}

export function codexCompactionsRecord(over: { opensCompacted?: boolean; continuesThread?: boolean | { thread_id: string; entries_before: number; byte_offset: number }; emptyBase?: boolean; withoutBoundary?: boolean; withoutConfig?: boolean } = {}): unknown[] {
  // A rollout the host wrote as a CONTINUATION of a thread opens at the
  // history base's own ordinal rather than at 0, which is how the three such
  // records on this machine are shaped.
  const stated = typeof over.continuesThread === 'object'
    ? over.continuesThread
    : { thread_id: '01a18468-eb66-7892-841e-3bc876b47680', entries_before: 1_065, byte_offset: 4_150_695 };
  const base = stated.entries_before;
  let ordinal = over.continuesThread ? base : 0;
  const next = (): number => ordinal++;
  const ask = (n: number, at: string) => ({
    type: 'response_item', timestamp: at, ordinal: next(),
    payload: { type: 'message', role: 'user', content: [{ type: 'text', text: `ask ${n}` }] },
  });
  // No model-produced item in a call's window, so `inputs` is `before` and the
  // boundary written next lands on exactly that index.
  const call = (id: string, turn: string, input: number, at: string) => ({
    type: 'token_usage_record', timestamp: at, ordinal: next(),
    payload: { response_id: id, turn_id: turn, usage: { input_tokens: input, cached_input_tokens: 0 } },
  });
  const boundary = (id: string, items: string[], call_input: number, turn_input: number, at: string) => ({
    type: 'compacted', timestamp: at, ordinal: next(),
    payload: {
      message: '', window_id: id, compaction_response_id: `resp_${id}`,
      replacement_history: items.map((text) => ({ type: 'message', role: 'user', content: [{ type: 'text', text }] })),
      retained_context: { user_messages: [{}], assistant_messages: [{}], incomplete: false },
      // Both figures the host writes at a boundary are pre-compaction: the
      // turn's cumulative input, and the call its usage record was written
      // after. Kept far apart from the per-call figures so a reading that
      // quotes the wrong pair is unmistakable.
      latest_token_usage_record: { usage: { input_tokens: call_input }, turn_token_usage: { input_tokens: turn_input } },
    },
  });
  const head: unknown[] = [
    {
      type: 'session_meta', timestamp: '2026-10-22T12:00:00.000Z', ordinal: next(),
      payload: {
        session_id: '01a1651a-98d5-7873-9600-1e5d6f5fa28d', cwd: '/tmp/seat', base_instructions: { text: 'You are Codex.' },
        // Every rollout is written in `paginated` history mode; only a
        // positive `end_ordinal_exclusive` means entries exist that this file
        // does not hold. The ordinary case carries the mode and no base.
        history_mode: 'paginated',
        ...(over.continuesThread
          ? { history_base: { thread_id: stated.thread_id, end_ordinal_exclusive: base, end_byte_offset: stated.byte_offset } }
          // A base the host wrote for a thread this file DID open: no entries
          // precede it, so there is nothing to say. No record on this machine
          // carries this shape — every one of the 867 either omits the field
          // or names a positive ordinal — so the fixture is its only evidence,
          // and it is here because `end_ordinal_exclusive` read without its
          // sign would put the caveat on all 867.
          : over.emptyBase === true
            ? { history_base: { thread_id: '01a1651a-98d5-7873-9600-1e5d6f5fa28d', end_ordinal_exclusive: 0, end_byte_offset: 0 } }
            : {}),
      },
    },
    // A continuation segment need record no full state of its own: the host
    // wrote one in the earlier segment and this file carries only its deltas.
    // That is the shape of 1 of the 3 real continuation segments here, and the
    // reading of it said the call had no instructions at all.
    over.withoutConfig === true
      ? {
          type: 'world_state', timestamp: '2026-10-22T12:00:01.000Z', ordinal: next(),
          payload: { full: false, state: { environments: { shell: 'zsh' } } },
        }
      : {
          type: 'world_state', timestamp: '2026-10-22T12:00:01.000Z', ordinal: next(),
          payload: { full: true, state: { agents_md: { directory: '/tmp/seat', text: 'the repository rules' }, tools: { clock: 'a clock' } } },
        },
    { type: 'turn_context', timestamp: '2026-10-22T12:00:02.000Z', ordinal: next(), payload: { turn_id: 'turn-1', model: 'gpt-6-astra' } },
  ];
  // Calls and additions, and no boundary anywhere: on a continuation segment
  // this is the record whose EVERY call was given context it does not hold,
  // with nothing in it to rebase them (2026-10-25T15-37-49 here, 14 calls).
  if (over.withoutBoundary === true) {
    return [
      ...head,
      ask(1, '2026-10-22T12:00:03.000Z'),
      call('resp_0', 'turn-1', 77_407, '2026-10-22T12:00:04.000Z'),
      ask(2, '2026-10-22T12:00:05.000Z'),
      call('resp_1', 'turn-1', 84_839, '2026-10-22T12:00:06.000Z'),
    ];
  }
  if (over.opensCompacted === true) {
    return [
      ...head,
      boundary('w1', ['the summary of a previous session', 'and its second item'], 23_223, 23_223, '2026-10-22T12:00:03.000Z'),
      ask(1, '2026-10-22T12:00:04.000Z'),
      call('resp_0', 'turn-1', 34_041, '2026-10-22T12:00:05.000Z'),
    ];
  }
  return [
    ...head,
    ask(1, '2026-10-22T12:00:03.000Z'),
    call('resp_0', 'turn-1', 100, '2026-10-22T12:00:04.000Z'),
    ask(2, '2026-10-22T12:00:05.000Z'),
    call('resp_1', 'turn-1', 200, '2026-10-22T12:00:06.000Z'),
    boundary('w1', ['the summary of asks one and two'], 200, 300, '2026-10-22T12:00:07.000Z'),
    call('resp_2', 'turn-1', 20, '2026-10-22T12:00:08.000Z'),
    ask(3, '2026-10-22T12:00:09.000Z'),
    call('resp_3', 'turn-1', 30, '2026-10-22T12:00:10.000Z'),
    ask(4, '2026-10-22T12:00:11.000Z'),
    call('resp_4', 'turn-1', 40, '2026-10-22T12:00:12.000Z'),
    boundary('w2', ['the summary so far', 'and what is still open'], 40, 70, '2026-10-22T12:00:13.000Z'),
    call('resp_5', 'turn-1', 15, '2026-10-22T12:00:14.000Z'),
  ];
}
