import { describe, expect, it } from 'vitest';
import { installation as workInstallation } from '../../work/src/install.js';
import { qualifiedRecordRef as workRef } from '../../work/src/reference.js';
import { installation as roadmapInstallation } from '../../roadmap/src/install.js';
import { qualifiedRecordRef as roadmapRef } from '../../roadmap/src/reference.js';

describe('family identity parity (T2.b)', () => {
  for (const key of ['HELMO_INSTALLATION', 'ROADMAP_LABEL', 'HELMO_LABEL', 'REV_LABEL'] as const) {
    it(`uses ${key} identically at both product entry points`, () => {
      const env = { [key]: 'estate.c1' } as NodeJS.ProcessEnv;
      const work = workInstallation(env);
      const roadmap = roadmapInstallation(env);
      expect(work.label).toBe('estate.c1');
      expect(roadmap.label).toBe(work.label);
      expect(workRef('H-1', work)).toBe('H-1@estate.c1');
      expect(roadmapRef('R-1', roadmap)).toBe('R-1@estate.c1');
    });
  }

  it('accepts repeated agreement and refuses any distinct accepted value', () => {
    const agreed = { HELMO_INSTALLATION: 'estate.c1', ROADMAP_LABEL: 'estate.c1', HELMO_LABEL: 'estate.c1', REV_LABEL: 'estate.c1' };
    expect(workInstallation(agreed).label).toBe('estate.c1');
    expect(roadmapInstallation(agreed).label).toBe('estate.c1');
    const conflict = { ...agreed, REV_LABEL: 'estate.other' };
    expect(() => workInstallation(conflict)).toThrow(/identity keys disagree/);
    expect(() => roadmapInstallation(conflict)).toThrow(/identity keys disagree/);
  });
});
