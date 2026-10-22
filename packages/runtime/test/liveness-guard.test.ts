import { describe, expect, it, vi } from 'vitest';
import { requireProcessAbsent, requireSessionGroupAbsent } from '../src/liveness-guard.js';

describe('repair liveness guard', () => {
  it.each([
    ['process', requireProcessAbsent, 12345, 12345],
    ['session group', requireSessionGroupAbsent, 12345, -12345],
  ] as const)('requires a valid, observably absent %s', (_name, requireAbsent, identity, target) => {
    expect(() => requireAbsent(1)).toThrow(/refused/);

    const check = vi.spyOn(process, 'kill');
    try {
      check.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
      expect(() => requireAbsent(identity)).not.toThrow();
      expect(check).toHaveBeenLastCalledWith(target, 0);

      check.mockImplementation(() => { throw Object.assign(new Error('hidden'), { code: 'EPERM' }); });
      expect(() => requireAbsent(identity)).toThrow(/unknown/);

      check.mockImplementation(() => true);
      expect(() => requireAbsent(identity)).toThrow(/still live/);
    } finally {
      check.mockRestore();
    }
  });
});
