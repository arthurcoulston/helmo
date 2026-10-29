// The acceptance for R-55's startup receipts (H-3573).
//
// Every source, launch journal, host record and blob here is a disposable
// private fixture under a temp REV_HOME and a temp CLAUDE_CONFIG_DIR. Nothing
// reads or edits a live profile, roster or transcript: this feature's job is to
// hold the exact bytes a launch received, so a test that edited a live source
// would be experimenting on the thing it is meant to preserve.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRUNE_INTERVAL_MS, PRUNE_WRITE_GRACE_MS, RETENTION_DAYS, attachSettlement, blobDir, blobPath,
  buildReceipt, compareReceipts, launchAssociation, pruneBlobs, pruneRetainedContent, readReceipt,
  reconstructComposed, recordStartupContext, resolveContent, retain, seatReceipts, startupReading,
} from '../src/startup-context.js';
import { claudeProjectSlug } from '../src/context-coverage.js';
import { systemPrompt } from '../src/shim.js';
import type { LaunchJournalEntry } from '../src/launch-journal.js';
import type { GlobalConfig, LoopConfig, Roster } from '../src/types.js';

let home: string;
let tree: string;
let claude: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['REV_HOME', 'CLAUDE_CONFIG_DIR', 'HELMO_INSTALLATION', 'INSTALLATION_RELEASE']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'rev-startup-'));
  tree = mkdtempSync(join(tmpdir(), 'rev-startup-tree-'));
  claude = mkdtempSync(join(tmpdir(), 'rev-startup-claude-'));
  process.env['REV_HOME'] = home;
  process.env['CLAUDE_CONFIG_DIR'] = claude;
  delete process.env['HELMO_INSTALLATION'];
  process.env['INSTALLATION_RELEASE'] = '2026.10-29';
  writeFileSync(join(tree, 'PROFILE.md'), 'The seat itself, as the roster composes it.\n');
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

const global = (): GlobalConfig => ({ helmo_mcp_server: '/opt/helmo/work/dist/server.js' } as GlobalConfig);

/** Past the window prune holds a just-written blob in. Every fixture here
 *  retains its content moments before it prunes, which is exactly the
 *  in-flight launch the grace exists to protect, so a prune test has to say
 *  which side of it it is standing on. */
const afterGrace = (): Date => new Date(Date.now() + PRUNE_WRITE_GRACE_MS + 60_000);

const roster = (loops: LoopConfig[]): Roster =>
  ({ global: global(), loops: Object.fromEntries(loops.map((l) => [l.name, l])), providers: {} } as unknown as Roster);

const ADMITTED = {
  ticket_id: 'H-3573', basis: 'admitted' as const,
  detail: 'Helmo admitted this launch to this exact ticket and workflow attempt before dispatch.',
  admission_id: 'adm-1',
};

function capture(l: LoopConfig, launchId: string, over: Partial<Parameters<typeof buildReceipt>[2]> = {}) {
  return recordStartupContext(global(), l, {
    launchId, runtime: 'claude', provider: 'claude', model: 'claude-opus-5',
    iterationPrompt: 'Loop iteration 1 for agent mason.',
    association: ADMITTED, installation: 'fixture.rev', ...over,
  });
}

function session(over: Partial<NonNullable<LaunchJournalEntry['session']>> = {}): NonNullable<LaunchJournalEntry['session']> {
  return {
    provider: 'claude', model: 'claude-opus-5',
    provider_session_id: 'aaaaaaaa-1111-2222-3333-444444444444', provider_session_id_state: 'observed',
    started_at: '2026-10-29T13:00:01.000Z', ended_at: '2026-10-29T13:04:59.000Z', outcome: 'ok', ...over,
  };
}

/** A host transcript in the shape claude-code actually retains: the appended
 *  prompt arrives as a suffix of the last system block, with the host's own
 *  text ahead of it in the same block. */
function hostRecord(sessionId: string, opts: { cwd?: string; prompt?: string; system?: unknown; version?: string } = {}): string {
  const dir = join(claude, 'projects', claudeProjectSlug(tree));
  mkdirSync(dir, { recursive: true });
  const system = 'system' in opts ? opts.system : [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: 'text', text: `Harness notes the host writes.\n\n${opts.prompt ?? ''}` },
  ];
  const lines = [
    { type: 'user', sessionId, cwd: opts.cwd ?? tree, version: opts.version ?? '2.1.300', message: { role: 'user' } },
    { type: 'api-request-shape', sessionId, shape: { system, tools: [] } },
  ];
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the bytes a launch is handed', () => {
  // The whole record rests on this. If what the receipt records diverges from
  // what the launcher writes, every hash below is a hash of something no model
  // ever received. `systemPrompt` is the authority and is asserted against,
  // not paraphrased.
  it('is recorded as the exact composition the launcher writes', () => {
    writeFileSync(join(tree, 'skill-a.md'), 'the first appended skill\n');
    writeFileSync(join(tree, 'skill-b.md'), 'the second appended skill\n');
    const l = loop({ skills: [join(tree, 'skill-a.md'), join(tree, 'skill-b.md')] });
    capture(l, 'launch-1');

    const receipt = readReceipt('mason', 'launch-1')!;
    expect(receipt.composed.sha256).toBe(sha(systemPrompt(l)));
    expect(receipt.composed.bytes).toBe(Buffer.byteLength(systemPrompt(l), 'utf8'));
    expect(receipt.sources.map((s) => s.role)).toEqual(['constitution', 'skill', 'skill']);
    expect(receipt.sources.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  // The composition is deliberately NOT stored as its own blob. It is rebuilt
  // from the per-source blobs and the launcher's own framing, and checked
  // against the hash taken at launch — which is what makes the rebuild
  // evidence rather than a plausible reconstruction.
  it('rebuilds byte-exactly from the per-source blobs alone', () => {
    writeFileSync(join(tree, 'skill-a.md'), 'the first appended skill\n');
    const l = loop({ skills: [join(tree, 'skill-a.md')] });
    const launcher = systemPrompt(l);
    capture(l, 'launch-1');

    const rebuilt = reconstructComposed(readReceipt('mason', 'launch-1')!);
    expect(rebuilt.ok).toBe(true);
    expect((rebuilt as { text: string }).text).toBe(launcher);
  });

  it('retains one copy of content two launches share', () => {
    const l = loop();
    capture(l, 'launch-1');
    capture(l, 'launch-2');

    const a = readReceipt('mason', 'launch-1')!;
    const b = readReceipt('mason', 'launch-2')!;
    expect(a.sources[0]!.content.sha256).toBe(b.sources[0]!.content.sha256);
    expect(seatReceipts('mason')).toHaveLength(2);
    // Two receipts, one blob for the constitution: storage is O(distinct
    // content), which is what makes retaining every launch affordable.
    expect(blobPath(a.sources[0]!.content.sha256!)).toBe(blobPath(b.sources[0]!.content.sha256!));
  });
});

describe('a source that changes after the launch', () => {
  // R-55 acceptance 2. The point of retention: the record is not a view onto
  // live files, so editing or deleting a source cannot reach back into it.
  it('does not change what the receipt holds, and the original still reads back', () => {
    const l = loop();
    const original = readFileSync(join(tree, 'PROFILE.md'), 'utf8');
    capture(l, 'launch-1');
    const before = readReceipt('mason', 'launch-1')!;

    writeFileSync(join(tree, 'PROFILE.md'), 'rewritten after the launch\n');
    const after = readReceipt('mason', 'launch-1')!;
    expect(after.sources[0]!.content.sha256).toBe(before.sources[0]!.content.sha256);
    expect((reconstructComposed(after) as { text: string }).text).toBe(original);

    unlinkSync(join(tree, 'PROFILE.md'));
    const deleted = readReceipt('mason', 'launch-1')!;
    expect((reconstructComposed(deleted) as { text: string }).text).toBe(original);
  });

  it('is told apart from its own repository commit', () => {
    // A tracked source that has been edited is recorded by its bytes AND
    // named as modified against the commit, because the commit does not
    // describe what the session received.
    const l = loop();
    capture(l, 'launch-1');
    const receipt = readReceipt('mason', 'launch-1')!;
    // No repository here, so the honest answer is a null commit rather than a
    // guess — the state a file on the operator's machine is really in.
    expect(receipt.repos).toHaveLength(1);
    expect(receipt.repos[0]!.commit).toBeNull();
    expect(receipt.sources[0]!.content.sha256).toBe(sha('The seat itself, as the roster composes it.\n'));
  });
});

describe('comparing two runs', () => {
  // R-55 acceptance 3, and R-45's named evidence limit answered: its check can
  // only say the prompt differs, because the host retains it whole. These
  // receipts hold a hash per file, so the answer is a file name.
  it('names the composed file that moved, not just that the prompt differs', () => {
    writeFileSync(join(tree, 'skill-a.md'), 'the first appended skill\n');
    const l = loop({ skills: [join(tree, 'skill-a.md')] });
    capture(l, 'launch-1');
    writeFileSync(join(tree, 'skill-a.md'), 'the first appended skill, revised\n');
    capture(l, 'launch-2');

    const diff = compareReceipts(readReceipt('mason', 'launch-1')!, readReceipt('mason', 'launch-2')!);
    expect(diff.composed.same).toBe(false);
    expect(diff.summary).toMatchObject({ changed: 1, unchanged: 1, added: 0, removed: 0 });
    const changed = diff.sources.find((s) => s.change === 'changed')!;
    expect(changed.path).toBe(join(tree, 'skill-a.md'));
    expect(changed.claim).toBe('supplied');
    expect(changed.content).toContain('Both sides');
  });

  // H-3573 and Proof's H-3575 finding: a comparison that covered only the
  // files Rev composes would miss a whole class of change, because a CLAUDE.md
  // the host discovers reaches the session too.
  it('names a discovered file that moved as well as a composed one', () => {
    writeFileSync(join(tree, 'CLAUDE.md'), 'project instructions the CLI finds itself\n');
    const l = loop();
    capture(l, 'launch-1', { discovered: [join(tree, 'CLAUDE.md')] });
    writeFileSync(join(tree, 'CLAUDE.md'), 'project instructions, revised\n');
    capture(l, 'launch-2', { discovered: [join(tree, 'CLAUDE.md')] });

    const diff = compareReceipts(readReceipt('mason', 'launch-1')!, readReceipt('mason', 'launch-2')!);
    const changed = diff.sources.find((s) => s.change === 'changed')!;
    expect(changed.path).toBe(join(tree, 'CLAUDE.md'));
    expect(changed.claim).toBe('discovered');
    // The composed prompt did not move, and the comparison says both things.
    expect(diff.composed.same).toBe(true);
  });

  it('separates a skill added to the roster from a skill whose content moved', () => {
    writeFileSync(join(tree, 'skill-a.md'), 'the first appended skill\n');
    writeFileSync(join(tree, 'skill-b.md'), 'the second appended skill\n');
    capture(loop({ skills: [join(tree, 'skill-a.md')] }), 'launch-1');
    capture(loop({ skills: [join(tree, 'skill-a.md'), join(tree, 'skill-b.md')] }), 'launch-2');

    const diff = compareReceipts(readReceipt('mason', 'launch-1')!, readReceipt('mason', 'launch-2')!);
    expect(diff.summary).toMatchObject({ added: 1, changed: 0 });
    expect(diff.sources.find((s) => s.change === 'added')!.path).toBe(join(tree, 'skill-b.md'));
  });

  it('refuses to read a cross-installation comparison as drift in one', () => {
    const l = loop();
    const a = buildReceipt(global(), l, {
      launchId: 'launch-1', runtime: 'claude', provider: 'claude', model: 'claude-opus-5',
      iterationPrompt: 'p', association: ADMITTED, installation: 'one.rev',
    });
    const b = buildReceipt(global(), l, {
      launchId: 'launch-1', runtime: 'claude', provider: 'claude', model: 'claude-opus-5',
      iterationPrompt: 'p', association: ADMITTED, installation: 'two.rev',
    });
    const diff = compareReceipts(a, b);
    expect(diff.comparable).toBe(false);
    expect(diff.note).toContain('different installations');
  });
});

describe('the host record at settlement', () => {
  // This is what turns "this installation recorded these bytes" into "the
  // model was given them". Recorded and confirmed are separate claims.
  it('confirms the recorded bytes when it retains them verbatim', () => {
    writeFileSync(join(tree, 'skill-a.md'), 'the first appended skill\n');
    const l = loop({ skills: [join(tree, 'skill-a.md')] });
    capture(l, 'launch-1');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });

    const receipt = attachSettlement(l, 'launch-1', session())!;
    expect(receipt.settled!.supplied_confirmed).toBe(true);
    expect(receipt.settled!.host.cli_version).toBe('2.1.300');
    expect(receipt.versions.host_cli_version).toBe('2.1.300');
    expect(receipt.settled!.confirmation).toContain('agree');
  });

  // The case the retained copy exists for. R-45's check has to go stale here;
  // this record does not, and says exactly that.
  it('leaves the record unconfirmed but intact when the host pruned its transcript', () => {
    const l = loop();
    capture(l, 'launch-1');
    const receipt = attachSettlement(l, 'launch-1', session())!;

    expect(receipt.settled!.supplied_confirmed).toBeNull();
    expect(receipt.settled!.host.record).toBeNull();
    expect(receipt.settled!.confirmation).toContain('retained copy exists for');
    // Unconfirmed is not lost: the bytes are still here.
    expect(reconstructComposed(receipt).ok).toBe(true);
  });

  it('reports a launch that settled with no session id as unconfirmed, naming that reason', () => {
    const l = loop();
    capture(l, 'launch-1');
    const receipt = attachSettlement(l, 'launch-1', session({ provider_session_id: undefined, provider_session_id_state: 'unsupported' }))!;

    expect(receipt.settled!.supplied_confirmed).toBeNull();
    expect(receipt.settled!.provider_session_id).toBeNull();
    expect(receipt.settled!.confirmation).toContain('no observed provider session id');
  });

  it('reports a contradiction rather than reconciling it', () => {
    const l = loop();
    capture(l, 'launch-1');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: 'bytes nobody recorded\n' });

    const receipt = attachSettlement(l, 'launch-1', session())!;
    expect(receipt.settled!.supplied_confirmed).toBe(false);
    expect(receipt.settled!.confirmation).toContain('does NOT contain');
  });

  it('reports an adapter whose retained shape it cannot read, and claims nothing from it', () => {
    const l = loop();
    capture(l, 'launch-1');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { system: 'a string where the blocks used to be' });

    const receipt = attachSettlement(l, 'launch-1', session())!;
    expect(receipt.settled!.supplied_confirmed).toBeNull();
    expect(receipt.settled!.host.retained_prompt_bytes).toBeNull();
    expect(receipt.settled!.confirmation).toContain('host CLI changed the shape');
  });

  // Capture is adapter-agnostic; confirmation is not. Asking the Claude store
  // about a codex launch would report that store's record as missing, which is
  // a true sentence about the wrong store.
  it('does not claim a missing Claude record for a launch that ran on another adapter', () => {
    const l = loop({ runtime: 'codex' });
    capture(l, 'launch-1', { runtime: 'codex', provider: 'codex' });
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });

    const receipt = attachSettlement(l, 'launch-1', session({ provider: 'codex' }))!;
    expect(receipt.settled!.supplied_confirmed).toBeNull();
    expect(receipt.settled!.host.record).toBeNull();
    expect(receipt.settled!.confirmation).toContain('codex adapter');
    expect(receipt.settled!.confirmation).not.toContain('No host record named');
    // The capture itself is unaffected: the bytes are retained either way.
    expect(reconstructComposed(receipt).ok).toBe(true);
  });

  it('writes the settlement once and does not let a replay overwrite it', () => {
    const l = loop();
    capture(l, 'launch-1');
    hostRecord('aaaaaaaa-1111-2222-3333-444444444444', { prompt: systemPrompt(l) });
    const first = attachSettlement(l, 'launch-1', session())!;
    const second = attachSettlement(l, 'launch-1', session({ outcome: 'failure' }))!;

    expect(second.settled!.outcome).toBe('ok');
    expect(second.settled!.at).toBe(first.settled!.at);
  });
});

describe('an interrupted or refused launch', () => {
  // R-55 acceptance 1's other half. A receipt with no settlement is the
  // truthful state of a launch whose session never returned — it must not
  // acquire a session result it never had.
  it('keeps its first half and claims no session result', () => {
    const l = loop();
    capture(l, 'launch-1');

    const receipt = readReceipt('mason', 'launch-1')!;
    expect(receipt.settled).toBeUndefined();
    expect(receipt.recording.state).toBe('complete');
    expect(reconstructComposed(receipt).ok).toBe(true);
    expect(startupReading(roster([l])).summary).toMatchObject({ complete: 1, settled: 0 });
  });
});

describe('a source the launcher could not read', () => {
  it('records the state, claims no hash, and forms no composition', () => {
    const l = loop({ skills: [join(tree, 'gone.md')] });
    capture(l, 'launch-1');

    const receipt = readReceipt('mason', 'launch-1')!;
    const missing = receipt.sources.find((s) => s.path === join(tree, 'gone.md'))!;
    expect(missing.state).toBe('missing');
    expect(missing.content.sha256).toBeNull();
    expect(missing.content.retention).toBe('not_retained');
    expect(receipt.composed.sha256).toBeNull();
    expect(receipt.composed.reconstructable).toBe(false);
    expect(receipt.composed.limit).toContain('could not be read');
  });

  it('names a fifo rather than reading it', () => {
    const fifo = join(tree, 'fifo.md');
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const made = spawnSync('mkfifo', [fifo]);
    if (made.status !== 0) return;
    capture(loop({ skills: [fifo] }), 'launch-1');

    const source = readReceipt('mason', 'launch-1')!.sources.find((s) => s.path === fifo)!;
    expect(source.state).toBe('unreadable');
    expect(source.content.retention).toBe('not_retained');
  });
});

describe('a forced recording failure', () => {
  // R-55 acceptance 4. Absence must never read as a complete record, so a
  // failure writes a receipt that says it failed — and the work association
  // survives it, which is what makes the failure recoverable rather than a
  // hole.
  it('writes a receipt saying so, keeps the association, and the next launch recovers', () => {
    const l = loop();
    // The blob store cannot be written to: a file where its directory goes.
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(blobDir(), 'not a directory\n');

    const failed = capture(l, 'launch-1');
    expect(failed.state).not.toBe('complete');
    const receipt = readReceipt('mason', 'launch-1')!;
    expect(receipt.recording.state).not.toBe('complete');
    expect(receipt.recording.errors.join(' ')).toMatch(/blob store refused|ENOTDIR|EEXIST/);
    // The association is not lost with the content, and no complete receipt is
    // fabricated: the hash of what was read is kept, the retention is not.
    expect(receipt.association).toMatchObject({ ticket_id: 'H-3573', basis: 'admitted' });
    expect(receipt.sources[0]!.content.sha256).not.toBeNull();
    expect(receipt.sources[0]!.content.retention).toBe('not_retained');
    expect(receipt.composed.reconstructable).toBe(false);
    expect(reconstructComposed(receipt).ok).toBe(false);

    // Repair: remove the obstruction and the next launch records completely.
    unlinkSync(blobDir());
    expect(capture(l, 'launch-2').state).toBe('complete');
    expect(startupReading(roster([l])).summary).toMatchObject({ complete: 1, partial: 1 });
  });

  it('is visible in the reading rather than counted as a pass', () => {
    const l = loop();
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(blobDir(), 'not a directory\n');
    capture(l, 'launch-1');

    const reading = startupReading(roster([l]));
    expect(reading.summary.complete).toBe(0);
    expect(reading.receipts[0]!.reconstruction).toContain('Not reconstructable');
  });
});

describe('two installations with colliding names', () => {
  // R-55 acceptance 5. The ids are installation-qualified and the stores are
  // per-REV_HOME, so a second fleet with the same seat name and the same
  // ticket reads only its own.
  it('do not mix records or borrow each other\'s content', () => {
    const l = loop();
    capture(l, 'shared-launch-id');
    const first = readReceipt('mason', 'shared-launch-id')!;

    const second = mkdtempSync(join(tmpdir(), 'rev-startup-two-'));
    process.env['REV_HOME'] = second;
    try {
      expect(readReceipt('mason', 'shared-launch-id')).toBeNull();
      expect(seatReceipts('mason')).toEqual([]);
      capture(l, 'shared-launch-id', { installation: 'other.rev', iterationPrompt: 'a different iteration' });
      const other = readReceipt('mason', 'shared-launch-id')!;

      expect(other.installation).toBe('other.rev');
      expect(other.id).not.toBe(first.id);
      expect(other.iteration_prompt.sha256).not.toBe(first.iteration_prompt.sha256);
      // Each store holds its own copy of shared content; neither resolves
      // through the other's.
      expect(existsSync(blobPath(other.sources[0]!.content.sha256!))).toBe(true);
      expect(blobPath(other.sources[0]!.content.sha256!)).toContain(second);
    } finally {
      process.env['REV_HOME'] = home;
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('retention', () => {
  it('tells an expired reference apart from one lost inside the horizon', () => {
    const l = loop();
    capture(l, 'launch-1');
    const receipt = readReceipt('mason', 'launch-1')!;
    const ref = receipt.sources[0]!.content;

    expect(resolveContent(ref, receipt.recorded_at).state).toBe('retained');
    rmSync(blobPath(ref.sha256!));
    // Gone while the receipt is young: the store lost what it was holding.
    const lost = resolveContent(ref, receipt.recorded_at);
    expect(lost.state).toBe('lost');
    expect(lost.detail).toContain('inside the retention horizon');
    // Gone past the horizon: the policy dropped it, which is not a defect.
    const later = new Date(Date.parse(receipt.recorded_at) + (RETENTION_DAYS + 5) * 86_400_000);
    const expired = resolveContent(ref, receipt.recorded_at, later);
    expect(expired.state).toBe('expired');
    expect(expired.detail).toContain('was not rewritten');
  });

  it('keeps a blob an old receipt shares with a recent one', () => {
    // Reference-counted over the receipts, not keyed on a blob's own age: two
    // launches far apart share the constitution, and dropping it on its mtime
    // would empty the recent receipt.
    const l = loop();
    // The two launches share the constitution and differ in their iteration
    // prompt, which is what makes this test say two things at once.
    capture(l, 'old-launch', { iterationPrompt: 'Loop iteration 1 for agent mason.' });
    const old = readReceipt('mason', 'old-launch')!;
    const aged = { ...old, recorded_at: new Date(Date.parse(old.recorded_at) - (RETENTION_DAYS + 10) * 86_400_000).toISOString() };
    writeFileSync(join(home, 'state', 'mason', 'startup', `${sha('old-launch')}.json`), JSON.stringify(aged, null, 1));
    capture(l, 'new-launch', { iterationPrompt: 'Loop iteration 2 for agent mason.' });

    const pruned = pruneBlobs({ now: afterGrace(), apply: true });
    expect(pruned.dropped.map((d) => d.sha256)).not.toContain(old.sources[0]!.content.sha256);
    expect(existsSync(blobPath(old.sources[0]!.content.sha256!))).toBe(true);
    // The old receipt's own iteration prompt is not shared, so it goes.
    expect(pruned.dropped.map((d) => d.sha256)).toContain(old.iteration_prompt.sha256);
  });

  it('is a dry report until it is told to apply', () => {
    const l = loop();
    capture(l, 'old-launch');
    const old = readReceipt('mason', 'old-launch')!;
    const aged = { ...old, recorded_at: new Date(Date.parse(old.recorded_at) - (RETENTION_DAYS + 10) * 86_400_000).toISOString() };
    writeFileSync(join(home, 'state', 'mason', 'startup', `${sha('old-launch')}.json`), JSON.stringify(aged, null, 1));

    const dry = pruneBlobs({ now: afterGrace() });
    expect(dry.applied).toBe(false);
    expect(dry.dropped.length).toBeGreaterThan(0);
    for (const d of dry.dropped) expect(existsSync(blobPath(d.sha256))).toBe(true);
  });

  it('holds a blob no receipt references yet, because a launch is still writing one', () => {
    // `retain` returns before the receipt naming it is written. Prune used to
    // be operator-run, so that gap never mattered; with the supervisor running
    // it unasked, a blob dropped inside the gap would make the receipt that
    // lands a second later read `lost` (H-3637).
    const l = loop();
    const orphan = retain('bytes a launch retained a moment ago, with no receipt yet.\n');
    expect(existsSync(blobPath(orphan.sha256))).toBe(true);
    capture(l, 'launch-1');

    const now = pruneBlobs({ apply: true });
    expect(now.dropped).toEqual([]);
    expect(now.held).toBeGreaterThan(0);
    expect(existsSync(blobPath(orphan.sha256))).toBe(true);

    const later = pruneBlobs({ now: afterGrace(), apply: true });
    expect(later.dropped.map((d) => d.sha256)).toContain(orphan.sha256);
    expect(existsSync(blobPath(orphan.sha256))).toBe(false);
  });

  it('keeps a retired seat\'s blobs, because its receipts outlive its roster entry', () => {
    // The live set used to be walked over `roster.loops`, so a seat removed
    // from the roster lost its blobs inside the horizon and its receipts then
    // read `lost` — a store defect reported for a prune's own doing (H-3637).
    const retired = loop({ name: 'herald', seat: 'herald' });
    capture(retired, 'herald-launch');
    const receipt = readReceipt('herald', 'herald-launch')!;

    // Prune with a roster that has never heard of herald.
    const pruned = pruneBlobs({ now: afterGrace(), apply: true });
    expect(pruned.seats).toContain('herald');
    expect(pruned.dropped.map((d) => d.sha256)).not.toContain(receipt.sources[0]!.content.sha256);
    expect(resolveContent(receipt.sources[0]!.content, receipt.recorded_at).state).toBe('retained');
  });

  it('runs itself once a day, which is what makes the horizon a horizon', () => {
    // Finding 3: until this caller existed, nothing but an operator typing
    // `--prune --apply` enforced RETENTION_DAYS (H-3642 set 2027-01-27 against
    // it). Throttled, so the second call in a day is a timestamp read.
    const l = loop();
    capture(l, 'launch-1');
    const orphan = retain('content no receipt will ever name.\n');

    const first = pruneRetainedContent({ now: afterGrace() });
    expect(first.ran).toBe(true);
    expect(first.dropped).toBeGreaterThan(0);
    expect(existsSync(blobPath(orphan.sha256))).toBe(false);

    const again = pruneRetainedContent({ now: afterGrace() });
    expect(again.ran).toBe(false);
    const tomorrow = pruneRetainedContent({ now: new Date(Date.now() + PRUNE_INTERVAL_MS + PRUNE_WRITE_GRACE_MS) });
    expect(tomorrow.ran).toBe(true);
  });

  it('leaves alone anything in the store that is not shaped like a blob', () => {
    const l = loop();
    capture(l, 'launch-1');
    mkdirSync(join(blobDir(), 'not-a-shard'), { recursive: true });
    mkdirSync(join(blobDir(), 'ab'), { recursive: true });
    writeFileSync(join(blobDir(), 'ab', 'README'), 'put here by hand\n');

    const pruned = pruneBlobs({ now: afterGrace(), apply: true });
    expect(pruned.skipped).toContain('not-a-shard');
    expect(pruned.skipped).toContain(join('ab', 'README'));
    expect(existsSync(join(blobDir(), 'ab', 'README'))).toBe(true);
  });
});

describe('a receipt that was not written by this module', () => {
  it('refuses a sha256 that is a path, and reports the content as lost', () => {
    // Ward's probe-tamper.mjs: a receipt naming `../../..`-anything had the
    // store join it and report whether the file existed — an oracle inside the
    // runtime's own trust domain (H-3637). The shape is checked now.
    expect(() => blobPath('../../../etc/hosts')).toThrow('is not a sha256');
    expect(() => blobPath('ABCDEF')).toThrow('is not a sha256');

    const tampered = resolveContent(
      { sha256: '../../../etc/hosts', bytes: 10, retention: 'retained' },
      new Date().toISOString(),
    );
    expect(tampered.state).toBe('lost');
    expect(tampered.detail).toContain('not a 64-character hex sha256');
    expect(tampered.detail).toContain('untrusted');
  });
});

describe('what the record refuses to say', () => {
  it('names the tool surface by server and never its environment', () => {
    // mcpServers puts the Helmo actor stamp and every installation variable in
    // each server's `env`. A receipt is a document somebody reads, so the
    // environment and the arguments are named as excluded, not captured.
    const receipt = readReceipt('mason', (capture(loop(), 'launch-1'), 'launch-1'))!;
    expect(receipt.tools.servers.map((s) => s.name)).toEqual(['helmo']);
    expect(receipt.tools.servers[0]!.command).toBe('node');
    expect(JSON.stringify(receipt.tools)).not.toContain('HELMO_ACTOR');
    expect(JSON.stringify(receipt)).not.toContain('/opt/helmo/work/dist/server.js');
    expect(receipt.tools.excluded).toContain('credentials');
  });

  it('keeps supplied and discovered as separate claims, and never claims either was read', () => {
    writeFileSync(join(tree, 'CLAUDE.md'), 'project instructions the CLI finds itself\n');
    const l = loop();
    capture(l, 'launch-1', { discovered: [join(tree, 'CLAUDE.md')] });

    const receipt = readReceipt('mason', 'launch-1')!;
    expect(receipt.sources.filter((s) => s.claim === 'supplied').map((s) => s.role)).toEqual(['constitution']);
    const discovered = receipt.sources.find((s) => s.claim === 'discovered')!;
    expect(discovered.channel).toContain('discovered by the CLI');
    // A discovered file is retained as evidence of what was there, and it is
    // not part of the composition: including it would claim Rev supplied it.
    expect(discovered.content.retention).toBe('retained');
    expect(receipt.composed.sha256).toBe(sha(systemPrompt(l)));
    expect(receipt.unknowns.join(' ')).toContain('whether the session READ any of this');
    expect(receipt.unknowns.join(' ')).toContain('compacted');
  });

  // Four ways a launch acquires a ticket are four strengths of claim, and the
  // scoped case is the one that would otherwise be overstated: that seat
  // claims inside its own session, so there is genuinely nothing to name at
  // launch and the measured window is the honest answer.
  it('keeps the four association bases apart and never guesses a scoped seat\'s ticket', () => {
    expect(launchAssociation({ admissionId: 'adm-1', ticketId: 'H-1', workflowAttemptId: 'att-1', scoped: true }))
      .toMatchObject({ ticket_id: 'H-1', basis: 'admitted', admission_id: 'adm-1', workflow_attempt_id: 'att-1' });
    expect(launchAssociation({ claimedTicket: 'H-2', scoped: false })).toMatchObject({ ticket_id: 'H-2', basis: 'claimed' });
    expect(launchAssociation({ scoped: false })).toMatchObject({ ticket_id: null, basis: 'none' });

    const scoped = launchAssociation({ scoped: true });
    expect(scoped).toMatchObject({ ticket_id: null, basis: 'scoped_seat_window' });
    expect(scoped.detail).toContain('touched_tickets');

    const l = loop();
    capture(l, 'launch-1', { association: launchAssociation({ scoped: true }) });
    expect(readReceipt('mason', 'launch-1')!.association.basis).toBe('scoped_seat_window');
  });

  it('reports a rebuild that does not hash to what was recorded as a defect in itself', () => {
    const l = loop();
    capture(l, 'launch-1');
    const receipt = readReceipt('mason', 'launch-1')!;
    // Plant bytes under the wrong name: the only way a rebuild could differ
    // from the recorded hash while every blob is present.
    const file = blobPath(receipt.sources[0]!.content.sha256!);
    chmodSync(file, 0o644);
    writeFileSync(file, 'bytes that are not what this hash names\n');

    const rebuilt = reconstructComposed(receipt);
    expect(rebuilt.ok).toBe(false);
    expect((rebuilt as { detail: string }).detail).toContain('does not hash to its own name');
  });
});

describe('the reading', () => {
  it('finds a launch by the ticket its journal names', () => {
    const l = loop();
    capture(l, 'launch-1');
    capture(l, 'launch-2', { association: { ticket_id: 'H-9999', basis: 'claimed', detail: 'a different ticket' } });

    const mine = startupReading(roster([l]), { ticket: 'H-3573' });
    expect(mine.receipts.map((r) => r.launch_id)).toEqual(['launch-1']);
  });

  it('discloses the retention policy and the store it applies to', () => {
    const l = loop();
    capture(l, 'launch-1');
    const reading = startupReading(roster([l]));

    expect(reading.retention.days).toBe(RETENTION_DAYS);
    expect(reading.retention.store).toBe(blobDir());
    expect(reading.receipts[0]!.content_states).toMatchObject({ retained: 1 });
    expect(reading.scope).toContain('not what the session read');
  });

  it('resolves each source\'s own retention field at read time, not just the aggregate', () => {
    // The aggregate and the reconstruction verdict were already read-time; the
    // per-source field echoed the receipt, so a reading with one blob gone
    // counted it `lost` at the top while the line naming THAT file still said
    // `retained` — and the per-source line is the one a reader uses to find
    // out which file is missing (H-3637).
    const l = loop();
    writeFileSync(join(tree, 'SKILL.md'), 'a second composed source.\n');
    capture(l, 'launch-1');
    const receipt = readReceipt('mason', 'launch-1')!;
    const gone = receipt.sources[0]!;
    rmSync(blobPath(gone.content.sha256!));

    const reading = startupReading(roster([l]));
    const source = reading.receipts[0]!.sources.find((s) => s.path === gone.path)!;
    expect(source.content.retention).toBe('lost');
    expect(source.content.sha256).toBe(gone.content.sha256);
    // The stored receipt is not rewritten: the resolution is the reading's.
    expect(readReceipt('mason', 'launch-1')!.sources[0]!.content.retention).toBe('retained');
    // Past the horizon the same field reads `expired`, which is the policy
    // working rather than a defect.
    const later = startupReading(roster([l]), { now: new Date(Date.parse(receipt.recorded_at) + (RETENTION_DAYS + 5) * 86_400_000) });
    expect(later.receipts[0]!.sources.find((s) => s.path === gone.path)!.content.retention).toBe('expired');
  });

  it('carries one status word, and a partial receipt reddens it', () => {
    // Finding 7: the exit code counted a failed recording and lost content and
    // NOT a `partial` receipt, so a store obstructed on every launch recorded
    // `partial` forever behind a green probe (H-3637). `cli.ts` reads this
    // field, so the fix is here and the probe needs no JSON parsing.
    const l = loop();
    capture(l, 'launch-1');
    expect(startupReading(roster([l])).status).toBe('ok');

    // Obstruct the store before the first launch, so `partial` is the only
    // finding in the reading: a blob removed afterwards would also be `lost`,
    // and the point here is the one state that used to stay green on its own.
    mkdirSync(join(home, 'state'), { recursive: true });
    rmSync(blobDir(), { recursive: true });
    writeFileSync(blobDir(), 'not a directory\n');
    const alone = loop({ name: 'herald', seat: 'herald' });
    capture(alone, 'herald-launch');
    const obstructed = startupReading(roster([alone]));
    expect(obstructed.summary).toMatchObject({ partial: 1, failed: 0, lost: 0 });
    expect(obstructed.status).toBe('degraded');
  });

  it('calls content lost inside the horizon a failure, not a degradation', () => {
    const l = loop();
    capture(l, 'launch-1');
    rmSync(blobPath(readReceipt('mason', 'launch-1')!.sources[0]!.content.sha256!));

    const lost = startupReading(roster([l]));
    expect(lost.summary).toMatchObject({ complete: 1, partial: 0, lost: 1 });
    expect(lost.status).toBe('failed');
  });
});
