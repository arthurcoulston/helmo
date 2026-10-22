import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { claudeApiConfig } from '../src/claude-api.js';
import { loadRoster } from '../src/config.js';
import { runSession, sessionSpec, spawnSession } from '../src/shim.js';
import { choiceExhausted, selectRun } from '../src/routing.js';
import { capacityDecide } from '../src/capacity.js';
import type { GlobalConfig, LoopConfig, RunChoice } from '../src/types.js';

const api: RunChoice = { provider: 'claude-api', runtime: 'claude', billing: 'metered', model: 'claude-sonnet-test', config: {
  api_key_helper: 'printf synthetic-api-key', max_budget_usd: 2, max_turns: 8, timeout_seconds: 30,
} };
const g = { helmo_mcp_server: '/tmp/test-helmo.mjs' } as GlobalConfig;
let home: string;
let loop: LoopConfig;
let oldEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  oldEnv = { ...process.env };
  home = realpathSync(mkdtempSync(join(tmpdir(), 'rev-api-test-')));
  process.env.REV_HOME = home;
  process.env.PATH = `${home}:${oldEnv.PATH}`;
  writeFileSync(join(home, 'PROFILE.md'), 'test constitution');
  loop = { name: 'api-worker', runtime: 'claude', model: api.model, version: 'test', cwd: home, constitution: join(home, 'PROFILE.md'), choices: [api], fallbacks: [] } as unknown as LoopConfig;
});
afterEach(() => {
  process.env = oldEnv;
  rmSync(home, { recursive: true, force: true });
});
function fakeClaude(body: string) {
  writeFileSync(join(home, 'claude'), `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
}
function choice(config: Record<string, unknown>): RunChoice {
  return { ...api, config: { ...api.config, ...config } };
}

describe('explicit Claude API billing', () => {
  it('loads the provider through the roster and preserves a separate subscription provider', () => {
    writeFileSync(join(home, 'roster.toml'), `
[global]
helmo_cli = "test-helmo"
helmo_mcp_server = "test-mcp"
[providers.claude]
billing = "subscription"
[providers.claude.models]
mid = "claude-sonnet-test"
[providers.claude-api]
runtime = "claude"
billing = "metered"
[providers.claude-api.models]
mid = "claude-sonnet-test"
[providers.claude-api.config]
api_key_helper = "printf synthetic-api-key"
max_budget_usd = 2
max_turns = 8
timeout_seconds = 30
[loops.api-worker]
workstream = "test"
cwd = "${home}"
constitution = "${loop.constitution}"
provider = "claude-api"
tier = "mid"
`);
    const roster = loadRoster();
    expect(roster.loops['api-worker']!.choices[0]).toMatchObject(api);
    expect(roster.providers.claude!.billing).toBe('subscription');
    writeFileSync(join(home, 'roster.toml'), readFileSync(join(home, 'roster.toml'), 'utf8').replace('max_turns = 8', 'max_turns = 0'));
    expect(() => loadRoster()).toThrow(/max_turns/);
  });

  it.each([
    { max_budget_usd: 0 }, { max_turns: 1.5 }, { timeout_seconds: Infinity },
    { api_key_helper: '' }, { stop_at: 'tomorrow' }, { max_buget_usd: 1 },
  ])('rejects invalid settings before launch: %j', config => {
    expect(() => claudeApiConfig(choice(config))).toThrow();
  });
  it('does not reinterpret old metered providers as explicit API providers', () => {
    expect(claudeApiConfig({ runtime: 'claude', billing: 'metered' })).toBeUndefined();
    expect(() => claudeApiConfig({ ...api, billing: 'subscription' })).toThrow(/metered/);
  });

  it.each(['exit 1', 'printf ""', 'printf "two words"', 'printf synthetic-secret >&2; exit 1'])('refuses failed/invalid credentials without launching Claude: %s', async helper => {
    fakeClaude(`require('node:fs').writeFileSync('launched','yes')`);
    const result = await runSession(g, loop, 'prompt', api.model, choice({ api_key_helper: helper }));
    expect(result).toMatchObject({ rc: 78, cls: 'apparatus' });
    expect(result.outputTail).not.toContain('synthetic-secret');
    expect(existsSync(join(home, 'launched'))).toBe(false);
  });

  it('launches normal tools/MCP with explicit helper and limits, strips ambient auth and redacts reports', async () => {
    process.env.ANTHROPIC_API_KEY = 'ambient-do-not-use';
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-oauth';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    fakeClaude(`
const fs = require('node:fs');
const args = process.argv.slice(2);
const mcp = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1], 'utf8'));
fs.writeFileSync('capture.json', JSON.stringify({args,mcp,env:process.env}));
console.log(JSON.stringify({session_id:'synthetic-session',usage:{input_tokens:11,output_tokens:7},total_cost_usd:0.03,result:'synthetic-api-key sk-ant-another-secret'}));
console.error('synthetic-api-key');
`);
    const result = await runSession(g, loop, 'prompt', api.model, api, 'test-generation', join(home, 'group'));
    expect(result).toMatchObject({ rc: 0, tokens: 18, cost_usd: 0.03 });
    expect(result.outputTail).not.toMatch(/synthetic-api-key|sk-ant-/);
    const { args, env, mcp } = JSON.parse(readFileSync(join(home, 'capture.json'), 'utf8'));
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--bare');
    expect(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd')+4)).toEqual(['--max-budget-usd','2','--max-turns','8']);
    const settings = JSON.parse(args[args.indexOf('--settings')+1]);
    expect(settings.apiKeyHelper).toBe(api.config!.api_key_helper);
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(settings.env.CLAUDE_CODE_USE_BEDROCK).toBe('0');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(JSON.parse(mcp.mcpServers.helmo.env.HELMO_ACTOR).generation).toBe('test-generation');
    expect(readFileSync(join(home, 'token-log'), 'utf8')).toContain('cost_usd=0.03');
  });

  it('honors the roster API provider when the caller omits a choice', async () => {
    fakeClaude(`require('node:fs').writeFileSync('launched','yes')`);
    const result = await runSession(g, { ...loop, choices: [choice({ api_key_helper: 'exit 1' })] }, 'prompt');
    expect(result.rc).toBe(78);
    expect(existsSync(join(home, 'launched'))).toBe(false);
  });

  it('stops at an expired cutoff before accessing credentials', async () => {
    const result = await runSession(g, loop, 'prompt', api.model, choice({ stop_at: '2020-01-01T00:00:00Z', api_key_helper: 'touch helper-called' }));
    expect(result.outputTail).toMatch(/deadline has passed/);
    expect(existsSync(join(home, 'helper-called'))).toBe(false);
  });
  it('reports unknown usage if the deadline kills an active session', async () => {
    fakeClaude(`setInterval(()=>{},1000)`);
    const result = await runSession(g, loop, 'prompt', api.model, choice({ timeout_seconds: 0.1 }));
    expect(result).toMatchObject({ rc: 78, cls: 'apparatus' });
    expect(result.outputTail).toMatch(/usage is unknown/);
    expect(result.cost_usd).toBeUndefined();
  });
  it('escalates termination when a session ignores TERM', async () => {
    const result = await spawnSession(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { cwd: home, env: process.env, timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(() => process.kill(result.pid!, 0)).toThrow();
  });
  it('keeps the subscription launch unchanged and refuses a misleading external recipe', async () => {
    fakeClaude(`require('node:fs').writeFileSync('args.json',JSON.stringify(process.argv));console.log(JSON.stringify({result:'ok'}))`);
    expect((await runSession(g, { ...loop, choices: [] }, 'prompt')).rc).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'args.json'),'utf8'))).not.toContain('--settings');
    expect(() => sessionSpec(g, loop)).toThrow(/Rev launcher/);
  });
});

describe('API capacity is independent of subscription telemetry', () => {
  const max: RunChoice = { ...api, provider: 'claude', billing: 'subscription', config: undefined };
  const usage = { claude: { fetched_at: new Date().toISOString(), stale: false, limits: [{ kind: 'weekly_all', label: 'weekly', percent: 100, severity: 'normal', resets_at: new Date(Date.now()+86400000).toISOString() }] }, codex: null };
  it('selects API fallback even when Max is exhausted, including headroom routing', () => {
    expect(choiceExhausted(api, usage, 95)).toBe(false);
    expect(choiceExhausted(max, usage, 95)).toBe(true);
    for (const routing of ['rotate','headroom']) {
      expect(selectRun({ ...loop, routing, choices: [max], fallbacks: [api] } as LoopConfig, usage, 1, 95).choice).toBe(api);
    }
  });
  it('the secondary capacity gate switches to API without requesting plan telemetry', () => {
    const result = capacityDecide({ choices: [{ choice: max, snapshot: usage.claude, refreshed: true }, { choice: api, snapshot: null, refreshed: false }], isLoopRun: true, staleIterations: 0, thresholds: { exhaustedPercent: 95, sharedReservePercent: 5, blockHorizonSeconds: 7200, exhaustionCeilingSeconds: 691200, staleGraceIterations: 6, staleWaitSeconds: 900 } });
    expect(result).toMatchObject({ act: 'switch', on: api });
  });
});


describe('allocation guard at native dispatch', () => {
  function allocated(): RunChoice {
    const file = join(home, 'allocation.json');
    const stop_at = '2099-01-01T00:00:00Z';
    const plan = JSON.stringify({ version: 1, id: 'native-test', consumer: loop.name, provider: api.provider,
      helper_sha256: createHash('sha256').update(api.config!.api_key_helper as string).digest('hex'),
      stop_at, reserve_usd: 150, stop_estimate_usd: 25, estimate_multiplier: 5,
      max_budget_usd: 2, max_turns: 8, timeout_seconds: 30 });
    writeFileSync(file, plan, { mode: 0o600 });
    writeFileSync(join(home, 'runs.jsonl'), JSON.stringify({ kind: 'allocation', sha256: createHash('sha256').update(plan).digest('hex') })+'\n', { mode: 0o600 });
    return choice({ allocation_file: file, stop_at });
  }
  it('settles a native receipt and carries accumulation into the next launch', async () => {
    const c = allocated();
    fakeClaude("console.log(JSON.stringify({total_cost_usd:25,result:'ok'}))");
    expect((await runSession(g, loop, 'prompt', api.model, c)).rc).toBe(0);
    expect((await runSession(g, loop, 'prompt', api.model, c)).outputTail).toMatch(/admission refused/);
    const entries = readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(entries.map(e => e.kind)).toEqual(['allocation','reserve','settle']);
    expect(entries[2].cost_usd).toBe(25);
  });
  it.each(['console.log("{}");', 'console.log("broken");', 'console.log(JSON.stringify({total_cost_usd:-1}));', 'process.kill(process.pid,"SIGTERM");'])('retains unknown usage and refuses the next launch: %s', async body => {
    const c = allocated(); fakeClaude(body);
    expect((await runSession(g, loop, 'prompt', api.model, c)).rc).toBe(78);
    expect((await runSession(g, loop, 'prompt', api.model, c)).outputTail).toMatch(/admission refused/);
    expect(readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('missing allocation or ledger cannot start a funded CLI', async () => {
    const c = allocated(); rmSync(join(home, 'runs.jsonl'));
    fakeClaude("require('node:fs').writeFileSync('launched','yes')");
    expect((await runSession(g, loop, 'prompt', api.model, c)).rc).toBe(78);
    expect(existsSync(join(home, 'launched'))).toBe(false);
  });
  it('refuses an overlapping native dispatch while its first reservation is live', async () => {
    const c = allocated();
    fakeClaude("require('node:fs').writeFileSync('launched','yes');setTimeout(()=>console.log(JSON.stringify({total_cost_usd:1,result:'ok'})),200)");
    const first = runSession(g, loop, 'prompt', api.model, c);
    const second = await runSession(g, loop, 'prompt', api.model, c);
    expect(second.outputTail).toMatch(/admission refused/);
    expect((await first).rc).toBe(0);
  });
});
