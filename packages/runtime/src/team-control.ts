import { sClear, sGet, sHas, sSet } from './sentinels.js';

const OWNER = 'prime';

export function teamStop(names: string[]): { stopped: string[]; refused: string[] } {
  const stopped: string[] = [];
  const refused: string[] = [];
  for (const name of names) {
    const existing = sGet(name, 'STOP');
    if (existing !== null) {
      try { if (JSON.parse(existing).owner === OWNER) { stopped.push(name); continue; } } catch { /* foreign stop */ }
      refused.push(name);
      continue;
    }
    sSet(name, 'STOP', `${JSON.stringify({ owner: OWNER, at: new Date().toISOString() })}\n`);
    stopped.push(name);
  }
  return { stopped, refused };
}

export function teamResume(names: string[]): { resumed: string[]; refused: string[] } {
  const resumed: string[] = [];
  const refused: string[] = [];
  for (const name of names) {
    const stop = sGet(name, 'STOP');
    let owned = false;
    try { owned = JSON.parse(stop ?? '{}').owner === OWNER; } catch { /* operator stop */ }
    if (!owned || sHas(name, 'HOLD') || sHas(name, 'BLOCKED')) {
      refused.push(name);
      continue;
    }
    sClear(name, 'STOP');
    resumed.push(name);
  }
  return { resumed, refused };
}
