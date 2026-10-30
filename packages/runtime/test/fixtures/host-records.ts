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
 *  and a compaction. */
export function codexRecord(over: { full?: boolean; encryptedReasoning?: boolean } = {}): unknown[] {
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
    // Every reasoning item in a real rollout looks like this: an empty
    // `summary` and the content only as provider-encrypted text. The item was
    // in the call's context; what it said is not on this machine.
    ...(over.encryptedReasoning === true
      ? [{
        type: 'response_item', timestamp: '2026-10-29T04:00:03.500Z', ordinal: 4,
        payload: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAABq4_a3ytF' },
      }]
      : []),
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

