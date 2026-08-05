import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Stages the fictional board behind the README screenshot (docs/dashboard.png):
// a small agent team mid-launch, with every surface the view renders — a
// question awaiting the human, evidence-backed dones, metered spend, workstream
// steering, a hygiene flag, and a recurring template.
//
// Never fall through to the default (live) database: an unset DEMO_DB would
// otherwise write fiction into the operator's real record.
const demoDb = process.env.DEMO_DB ?? join(mkdtempSync(join(tmpdir(), 'helmo-demo-')), 'demo.db');
const repoRoot = join(import.meta.dirname, '..');

const scout = JSON.stringify({ name: 'scout', kind: 'agent', model: 'claude-sonnet-5', version: '1.0' });
const forge = JSON.stringify({ name: 'forge', kind: 'agent', model: 'claude-opus-5', version: '1.0' });
const quill = JSON.stringify({ name: 'quill', kind: 'agent', model: 'claude-sonnet-5', version: '1.0' });
const orch = JSON.stringify({ name: 'orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '1.0' });

const cli = (...args) =>
  JSON.parse(
    execFileSync('npx', ['tsx', 'src/cli.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, HELMO_DB: demoDb },
      encoding: 'utf8',
    }),
  );

const create = (actor, ...args) => cli('create', '--actor', actor, ...args).id;

cli(
  'workstream-set', '--actor', orch, '--name', 'site-launch',
  '--goal', 'The new site is live on the apex domain with analytics and signup working',
  '--budget-usd', '120',
);

// Done with evidence, routine — the trustworthy baseline.
const thumbs = create(
  forge,
  '--title', 'Migrate image thumbnails to on-upload resizing',
  '--body', 'CDN bill spiked from on-the-fly resizes. Move to resize-on-upload, backfill existing originals.',
  '--workstream', 'site-launch', '--type', 'build', '--status', 'in_progress',
);
cli(
  'update', '--actor', forge, '--ticket', thumbs, '--status', 'done',
  '--note', 'Resizes now happen in the upload worker; backfill script processed 3,118 originals with zero failures.',
  '--evidence-kind', 'commit', '--evidence-ref', '9f41c2a',
  '--confidence', 'routine', '--blast-radius', 'records',
);

// Done at spot_check, with metered spend — the SPEND stat needs a number.
const backfill = create(
  scout,
  '--title', 'Backfill 2025 order exports into the warehouse',
  '--body', 'Finance needs 2025 order history queryable before the launch retro.',
  '--workstream', 'data-pipeline', '--type', 'ops', '--status', 'in_progress',
);
cli(
  'update', '--actor', scout, '--ticket', backfill, '--status', 'done',
  '--note', 'All 12 monthly exports loaded; row counts match source. One March file had a duplicated header row, handled.',
  '--evidence-kind', 'file', '--evidence-ref', 'warehouse/orders_2025',
  '--confidence', 'spot_check', '--blast-radius', 'records',
);
cli(
  'record-spend', '--actor', orch, '--ticket', backfill,
  '--tokens', '841000', '--cost-usd', '2.94', '--note', 'harness meter, loop session',
);

// In motion, with a draft artifact.
const post = create(
  quill,
  '--title', 'Draft the launch announcement post',
  '--body', '800-1200 words for the blog: what shipped, who it is for, migration notes for existing users.',
  '--workstream', 'site-launch', '--type', 'writing', '--status', 'in_progress',
);
cli(
  'update', '--actor', quill, '--ticket', post,
  '--note', "Outline approved in yesterday's meeting; first full draft is half done.",
  '--evidence-kind', 'draft', '--evidence-ref', 'drafts/launch-post.md', '--blast-radius', 'draft',
);

// Awaiting the human — the view's headline card.
const analytics = create(
  scout,
  '--title', 'Choose the analytics provider before launch',
  '--body', 'Site launch needs analytics wired in; provider choice is a cost/privacy tradeoff the operator owns.',
  '--workstream', 'site-launch', '--type', 'planning', '--status', 'in_progress',
);
cli(
  'return', '--actor', scout, '--ticket', analytics,
  '--situation', 'Scripts are ready to wire either provider; the choice affects cookie banners and monthly cost.',
  '--question', 'Which analytics provider should the new site launch with?',
  '--options', JSON.stringify([
    { label: 'Plausible', consequence: 'No cookie banner needed; $9/mo at current traffic' },
    { label: 'GA4', consequence: 'Free, but requires a consent banner and a privacy-policy update' },
  ]),
  '--recommendation', 'Plausible — the no-banner experience fits the launch story',
);

// P1 ready while lower-priority work is in motion: trips the
// priority-inversion hygiene flag on purpose.
create(
  forge,
  '--title', 'Add rate limiting to the public API',
  '--body', 'Signup opens the API to strangers; per-key rate limits before launch day.',
  '--workstream', 'site-launch', '--type', 'build', '--priority', '1',
);
create(
  scout,
  '--title', 'Deduplicate the contacts table before the newsletter import',
  '--body', '~4% duplicate rows by email; merge before the list import so sends do not double.',
  '--workstream', 'data-pipeline', '--type', 'ops',
);
create(
  forge,
  '--title', 'Weekly dependency and advisory audit',
  '--body', 'npm audit + changelog review across the three services; file tickets for anything real.',
  '--workstream', 'site-launch', '--type', 'ops', '--priority', '3', '--schedule', '0 9 * * 1',
);

const rows = cli('list', '--limit', '20').tickets;
console.log(`Seeded ${rows.length} tickets into ${demoDb}`);
for (const t of rows) console.log(`  ${t.id}  ${t.status.padEnd(14)} ${t.title}`);
console.log(`\nView it:  HELMO_DB=${demoDb} npm run view`);
console.log('README screenshot recipe: serve the view, then');
console.log('  chrome --headless=new --screenshot=docs/dashboard.png \\');
console.log('    --window-size=1360,860 --force-device-scale-factor=2 --hide-scrollbars http://127.0.0.1:4400');
