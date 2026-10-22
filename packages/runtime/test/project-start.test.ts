import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFeedbackAssignment, createResearchAssignment, researchHandoffSeat } from '../src/helm.js';
import { projectStartPass, validateProjectStart } from '../src/project-start.js';
import { GlobalConfig } from '../src/types.js';

function start(over: Record<string, unknown> = {}) {
  return { startId: 'project-start:ver_2', orgId: 'org_1', orgSlug: 'example-org', projectId: 'proj_1', projectSlug: 'example-project',
    versionId: 'ver_2', versionNumber: 2, contentHash: 'f'.repeat(64), gitRef: '0123abcd'.padEnd(40, '0'), isTest: false,
    directivePath: 'clients/example-org/projects/example-project/directive.md', approvedAt: '2026-01-01T00:00:00.000Z', ...over };
}

function harness(responses: Array<[number, unknown]>) {
  const calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const [status, body] = responses.shift()!;
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, request: request as typeof fetch };
}

function options(request: typeof fetch, assign: (body: string) => string = () => 'H-9@dev.test') {
  const root = mkdtempSync(join(tmpdir(), 'rev-project-start-'));
  return { origin: 'https://example.test', stateFile: join(root, 'project-start.json'), lastRunFile: join(root, 'last.json'),
    request, assign, secret: () => 'NOT_A_REAL_SECRET' };
}

describe('project-start handoff', () => {
  it('is idle when nothing is queued', async () => {
    const h = harness([[204, null]]);
    expect(await projectStartPass(options(h.request))).toBe('idle');
    expect(h.calls.map((c) => c.path)).toEqual(['/api/project-start/claim']);
    expect(h.calls[0]!.headers.get('x-gp-signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('files one research assignment with ids only and reports its ref', async () => {
    const bodies: string[] = [];
    const h = harness([[200, start()], [200, { startId: 'project-start:ver_2', assignmentRef: 'H-9@dev.test', assignedAt: 'now' }]]);
    const o = options(h.request, (body) => { bodies.push(body); return 'H-9@dev.test'; });
    expect(await projectStartPass(o)).toBe('assigned');
    expect(h.calls.map((c) => c.path)).toEqual(['/api/project-start/claim', '/api/project-start/assigned']);
    expect(h.calls[1]!.body).toMatchObject({ startId: 'project-start:ver_2', assignmentRef: 'H-9@dev.test', executorId: 'goodplumb-rev' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('clients/example-org/projects/example-project/directive.md');
    expect(bodies[0]).toContain('section 7');
    expect(bodies[0]).toContain('clients/example-org/projects/example-project/library/');
    expect(bodies[0]).toContain('library-policy-install.ts');
    expect(bodies[0]).toContain('f'.repeat(64));
    // H-2178: a refinement revision's words exist only at its gitRef, never on main.
    expect(bodies[0]).toContain(`git show ${'0123abcd'.padEnd(40, '0')}:clients/example-org/projects/example-project/directive.md`);
    expect(bodies[0]).not.toContain('on goodplumb main');
    expect(bodies[0]).not.toContain('TEST ORGANIZATION');
    expect(JSON.parse(readFileSync(o.lastRunFile, 'utf8'))).toMatchObject({ result: 'assigned', startId: 'project-start:ver_2', ref: 'H-9@dev.test' });
  });

  it('never files twice when the report was lost: the next pass reports the same ticket', async () => {
    let filed = 0;
    const h = harness([[200, start()], [503, { error: 'preparation unavailable' }], [200, start()], [200, {}]]);
    const o = options(h.request, () => { filed += 1; return 'H-9@dev.test'; });
    await expect(projectStartPass(o)).rejects.toThrow(/filed as H-9@dev.test; report refused \(503/);
    expect(await projectStartPass(o)).toBe('reported');
    expect(filed).toBe(1);
    expect(h.calls[3]!.body).toMatchObject({ assignmentRef: 'H-9@dev.test' });
  });

  it('refuses an envelope whose path or ids do not bind the project directive', () => {
    expect(() => validateProjectStart(start({ directivePath: 'clients/other-org/projects/example-project/directive.md' }))).toThrow(/project directive/);
    expect(() => validateProjectStart(start({ startId: 'project-start:ver_1' }))).toThrow(/invalid/);
    expect(() => validateProjectStart(start({ orgSlug: '../x' }))).toThrow(/invalid/);
    expect(() => validateProjectStart(start({ gitRef: undefined }))).toThrow(/invalid/);
    expect(() => validateProjectStart(start({ gitRef: 'main' }))).toThrow(/invalid/);
    expect(() => validateProjectStart(start({ isTest: 'no' }))).toThrow(/invalid/);
  });

  it('marks the assignment of a test organization', async () => {
    const bodies: string[] = [];
    const h = harness([[200, start({ isTest: true })], [200, {}]]);
    expect(await projectStartPass(options(h.request, (body) => { bodies.push(body); return 'H-9@dev.test'; }))).toBe('assigned');
    expect(bodies[0]).toMatch(/^TEST ORGANIZATION: not a real client/);
  });

  it('files nothing and reports nothing for an invalid claim', async () => {
    let filed = 0;
    const h = harness([[200, start({ contentHash: 'nope' })]]);
    await expect(projectStartPass(options(h.request, () => { filed += 1; return 'H-9@dev.test'; }))).rejects.toThrow(/invalid/);
    expect(filed).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it('files the Helmo ticket for the configured research seat, qualified by installation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rev-helm-research-'));
    const cli = join(root, 'helmo.mjs');
    const seen = join(root, 'argv.json');
    writeFileSync(cli, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ id: 'H-7', installation: { label: 'dev.test' } }));\n`);
    const g = { helmo_cli: cli, research_handoff_assignee: 'example-seat' } as GlobalConfig;
    expect(createResearchAssignment(g, 'ids only')).toBe('H-7@dev.test');
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([
      'create', '--title', 'Begin research on a client\'s approved directive', '--body', 'ids only',
      '--workstream', 'goodplumb', '--type', 'research', '--priority', '0', '--assignee', 'example-seat',
    ]);
  });

  it('files under a configured workstream when one is named', () => {
    const root = mkdtempSync(join(tmpdir(), 'rev-helm-research-'));
    const cli = join(root, 'helmo.mjs');
    const seen = join(root, 'argv.json');
    writeFileSync(cli, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ id: 'H-7', installation: { label: 'dev.test' } }));\n`);
    const g = { helmo_cli: cli, research_handoff_assignee: 'example-seat', research_handoff_workstream: 'example-stream' } as GlobalConfig;
    createResearchAssignment(g, 'ids only');
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toContain('example-stream');
  });

  it('is off with no seat configured, and never files to a default seat', () => {
    const g = { helmo_cli: '/nonexistent/helmo.mjs' } as GlobalConfig;
    expect(researchHandoffSeat(g)).toBeNull();
    expect(researchHandoffSeat({ ...g, research_handoff_assignee: '' })).toBeNull();
    expect(() => createResearchAssignment(g, 'ids only')).toThrow(/no research_handoff_assignee/);
    expect(() => createFeedbackAssignment(g, 'ids only')).toThrow(/no research_handoff_assignee/);
  });

  it('refuses a seat name that is not one', () => {
    for (const seat of ['--status', 'Has Space', 'a/b', 'x'.repeat(65)]) {
      expect(() => researchHandoffSeat({ research_handoff_assignee: seat } as GlobalConfig), seat).toThrow(/must be a seat name/);
    }
    expect(researchHandoffSeat({ research_handoff_assignee: 'example-seat' } as GlobalConfig)).toBe('example-seat');
  });
});
