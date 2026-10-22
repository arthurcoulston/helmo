import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { blockDigest, requestRuntimeRecovery, consumeRuntimeRecovery, type RuntimeRecoveryRequest } from '../src/runtime-recovery.js';
import { sGet, sSet, sClear, sPath, streak, withBlockedLock, runningStamp } from '../src/sentinels.js';

const reason = 'runtime failed 3 consecutive iterations (cap 2)';
const at = '2026-10-14T01:05:48.478Z';
const raw = `reason=${reason}\nat=${at}\n`;
const now = Date.parse('2026-10-14T03:00:00Z');
let home: string;
let saved: NodeJS.ProcessEnv;
const request = (): RuntimeRecoveryRequest => ({installation:'test.runtime.recovery',worker:'researcher',ticket:'H-42',reason,at,sha256:blockDigest(raw),expires_at:new Date(now+60_000).toISOString()});

beforeEach(() => {
  saved = {...process.env};
  for (const key of Object.keys(process.env)) if (/^(REV_|HELMO_|ROADMAP_|INSTALLATION_)/.test(key)) delete process.env[key];
  home = mkdtempSync(join(tmpdir(),'runtime-recovery-'));
  process.env.REV_HOME=home; process.env.REV_LABEL='test.runtime.recovery';
  sSet('researcher','BLOCKED',raw);
  for(let i=0;i<3;i++) streak('researcher','fail',true);
  streak('researcher','limit',true);
});
afterEach(() => { process.env=saved; rmSync(home,{recursive:true,force:true}); });

describe('single exact runtime-trip recovery', () => {
  it('queues without clearing, consumes once, resets only fail, audits, and refuses replay after identical refailure', () => {
    const r=request();
    requestRuntimeRecovery('researcher',r,'builder',now);
    expect(sGet('researcher','BLOCKED')).toBe(raw);
    expect(streak('researcher','fail',false)).toBe(3);
    expect(()=>requestRuntimeRecovery('researcher',r,'builder',now)).toThrow();
    // There is a limit streak, but no LIMIT control: preserve the streak.
    expect(consumeRuntimeRecovery('researcher',now)).toBe(true);
    expect(sGet('researcher','BLOCKED')).toBeNull();
    expect(streak('researcher','fail',false)).toBe(0);
    expect(streak('researcher','limit',false)).toBe(1);
    expect(consumeRuntimeRecovery('researcher',now)).toBe(false);
    const audit=JSON.parse(readFileSync(sPath('researcher','RUNTIME_RECOVERY.last.json'),'utf8'));
    expect(audit.decision).toBe('release');
    sSet('researcher','BLOCKED',raw);
    expect(()=>requestRuntimeRecovery('researcher',r,'builder',now)).toThrow('already consumed');
    expect(sGet('researcher','BLOCKED')).toBe(raw);
  });
  it.each(['STOP','HOLD','PACE','LIMIT'] as const)('preserves independently arriving %s and consumes refusal without retry', control => {
    const r=request(); requestRuntimeRecovery('researcher',r,'builder',now);
    sSet('researcher',control,'independent-owner\n');
    expect(consumeRuntimeRecovery('researcher',now)).toBe(false);
    expect(sGet('researcher',control)).toBe('independent-owner\n');
    expect(sGet('researcher','BLOCKED')).toBe(raw);
    expect(streak('researcher','fail',false)).toBe(3);
    sClear('researcher',control);
    expect(consumeRuntimeRecovery('researcher',now)).toBe(false);
    expect(()=>requestRuntimeRecovery('researcher',r,'builder',now)).toThrow('already consumed');
  });
  it('preserves a replacement trip and cannot use the request for a later failure', () => {
    requestRuntimeRecovery('researcher',request(),'builder',now);
    const changed=`reason=${reason}\nat=2026-10-14T03:00:01Z\n`;
    sSet('researcher','BLOCKED',changed);
    expect(consumeRuntimeRecovery('researcher',now)).toBe(false);
    expect(sGet('researcher','BLOCKED')).toBe(changed);
  });
  it('refuses structured/non-runtime block, foreign installation/worker, expired and unbounded requests', () => {
    for(const r of [{...request(),installation:'foreign'},{...request(),worker:'other'},
      {...request(),expires_at:new Date(now).toISOString()},
      {...request(),expires_at:new Date(now+16*60_000).toISOString()},
      {...request(),reason:'capacity exhausted'}])
      expect(()=>requestRuntimeRecovery('researcher',r,'builder',now)).toThrow();
    writeFileSync(sPath('researcher','BLOCKED.json'),'{}');
    expect(()=>requestRuntimeRecovery('researcher',request(),'builder',now)).toThrow('not a plain runtime');
    expect(sGet('researcher','BLOCKED')).toBe(raw);
  });
  it('expires a queued request, and refuses pending pace writes', () => {
    requestRuntimeRecovery('researcher',request(),'builder',now);
    expect(consumeRuntimeRecovery('researcher',now+60_000)).toBe(false);
    expect(sGet('researcher','BLOCKED')).toBe(raw);
    writeFileSync(sPath('researcher','PACE.pending'),'writer');
    expect(()=>requestRuntimeRecovery('researcher',{...request(),expires_at:new Date(now+120_000).toISOString()},'builder',now)).toThrow('PACE write');
  });
  it('refuses an occupied worker, then refuses occupancy arriving after queueing', () => {
    writeFileSync(sPath('researcher','RUNNING'),runningStamp());
    expect(()=>requestRuntimeRecovery('researcher',request(),'builder',now)).toThrow('occupied');
    sClear('researcher','RUNNING');
    requestRuntimeRecovery('researcher',request(),'builder',now);
    writeFileSync(sPath('researcher','RUNNING'),runningStamp());
    expect(consumeRuntimeRecovery('researcher',now)).toBe(false);
    expect(sGet('researcher','BLOCKED')).toBe(raw);
  });
  it('serializes a competing BLOCKED writer in another process and fails closed on an occupied lock', () => {
    withBlockedLock('researcher',()=>{
      const module=join(import.meta.dirname,'..','src','sentinels.ts');
      const script=`import {sSet} from ${JSON.stringify(module)}; try{sSet('researcher','BLOCKED','replacement');process.exit(2);}catch(e){console.log(e.message);}`;
      const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:process.env,encoding:'utf8'});
      expect(result).toContain('BLOCKED control busy');
      expect(()=>sClear('researcher','BLOCKED')).toThrow('busy');
      expect(()=>requestRuntimeRecovery('researcher',request(),'builder',now)).toThrow('busy');
      expect(sGet('researcher','BLOCKED')).toBe(raw);
    });
    expect(existsSync(sPath('researcher','.blocked-lock'))).toBe(false);
  });
});
