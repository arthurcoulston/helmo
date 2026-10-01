#!/usr/bin/env node
/* Stamps `dist` with the commit it was built from (R-39 Q8, H-2442).

   `dist` is gitignored and `rev redeploy` restarts without building, so the
   supervisor has always loaded an artifact with no provenance at all: on
   2026-09-30 dist/cli.js was built 2026-09-29 19:46 while the supervisor
   running it started 2026-09-27 18:01, and nothing on the machine could say
   what either was built from. The iteration prompt every loop runs is
   compiled from src/loop.ts, so "which reviewed version is the fleet running"
   had no answer. This gives it one.

   THE STAMP TRAVELS WITH THE ARTIFACT. It is dist/BUILD.json, beside the code
   it describes, not a row in a central log directory keyed by repo name. Two
   installs of rev on one machine — the personal supervisor and ~/.rev-gp's —
   build into different checkouts, and a central file could only ever describe
   one of them (H-2435, H-2436). A copy of rev cloned anywhere carries its own
   answer.

   A DIRTY TREE IS RECORDED, NOT REFUSED. `tsc` compiles the working tree, not
   the commit, so on a dirty tree the sha does not certify the artifact. A
   refusal would only push people to build without the stamp; saying so is
   what a reader needs. crew:tools/publishing/sync.mjs made the same call for
   the deploy record it writes, and crew:tools/estate/builds.mjs --check reads
   `dirty` here and reports it.

   Usage:
     node scripts/stamp-build.mjs           # write dist/BUILD.json
     node scripts/stamp-build.mjs --check   # exit 1 if dist has no current stamp

   Runs as npm `postbuild`, so `npm run build` stamps on its own and there is
   no second step for anyone to forget.
*/
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const STAMP = 'BUILD.json';

/** The stamp describes the rest of `dist`, so it can never be its own
 *  evidence of freshness — counting it would make every stale build look
 *  current, which is the one way this check could go quiet. */
export function newestArtifact(dist, list = readdirSync, stat = statSync) {
  let newest = 0;
  let name = null;
  for (const f of list(dist)) {
    if (f === STAMP) continue;
    const m = stat(join(dist, f)).mtimeMs;
    if (m > newest) { newest = m; name = f; }
  }
  return { at: newest, name };
}

/** What `git` says about the tree this build compiled. */
export function headOf(root = ROOT, run = git) {
  return {
    commit: run(root, ['rev-parse', 'HEAD']),
    dirty: run(root, ['status', '--porcelain']).length > 0,
  };
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** The record itself. Pure, so the test drives it without a build. */
export function describeBuild({ repo, commit, dirty, builtAt, node = process.version }) {
  return { repo, commit, dirty, built_at: new Date(builtAt).toISOString(), node };
}

/**
 * Is the stamp a true description of what is in `dist`? Missing is red, and
 * so is a stamp older than the code beside it — that is a rebuild nobody
 * stamped, which reads exactly like a fresh build to anyone who only checks
 * that the file exists.
 */
export function verify({ hasStamp, stampedAt, newest }) {
  if (!hasStamp) return { ok: false, detail: `no ${STAMP} — this build cannot say which commit it came from` };
  if (newest.at > stampedAt)
    return {
      ok: false,
      detail: `${STAMP} is older than dist/${newest.name} — something rebuilt without stamping, so the commit it names is not what is here`,
    };
  return { ok: true, detail: 'stamp describes the artifacts beside it' };
}

function write(dist = join(ROOT, 'dist')) {
  if (!existsSync(dist)) {
    console.error(`stamp-build: ${dist} does not exist — nothing was built`);
    return 1;
  }
  const head = headOf();
  const record = describeBuild({ repo: ROOT, ...head, builtAt: Date.now() });
  writeFileSync(join(dist, STAMP), `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `rev: stamped dist as ${record.commit.slice(0, 7)}${record.dirty ? ' (dirty tree — the sha does not certify this build)' : ''}`,
  );
  return 0;
}

function check(dist = join(ROOT, 'dist')) {
  if (!existsSync(dist)) {
    console.error(`stamp-build: ${dist} does not exist — nothing to check`);
    return 1;
  }
  const file = join(dist, STAMP);
  const hasStamp = existsSync(file);
  const res = verify({
    hasStamp,
    stampedAt: hasStamp ? statSync(file).mtimeMs : 0,
    newest: newestArtifact(dist),
  });
  console.log(`${res.ok ? '  ok ' : 'FAIL '} dist  ${res.detail}`);
  if (res.ok) console.log(`      ${readFileSync(file, 'utf8').trim().replace(/\n\s*/g, ' ')}`);
  return res.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(process.argv[2] === '--check' ? check() : write());
}
