import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';

// Stages the fictional board behind the README screenshot (docs/dashboard.png):
// a small agent team mid-launch, with every surface the view renders — a
// question awaiting the human, evidence-backed dones, metered spend, a
// workstream budget, a hygiene flag, and a recurring template.
//
// Never fall through to the default (live) database: an unset DEMO_DB would
// otherwise write fiction into the operator's real record.
const demoDb = process.env.DEMO_DB ?? join(mkdtempSync(join(tmpdir(), 'helmo-demo-')), 'demo.db');
const session = { session: 'demo:seed' };
const scout = { name: 'scout', kind: 'agent', model: 'claude-sonnet-5', version: '1.0', ...session };
const forge = { name: 'forge', kind: 'agent', model: 'claude-opus-5', version: '1.0', ...session };
const quill = { name: 'quill', kind: 'agent', model: 'claude-sonnet-5', version: '1.0', ...session };
const orch = { name: 'orchestrator', kind: 'orchestrator', model: 'claude-fable-5', version: '1.0', ...session };
const store = new Store(demoDb);
const create = (actor, input) => store.createTicket(actor, input).id;

store.setWorkstream(orch, { name: 'site-launch', budget_usd: 120 });

// Done with evidence, routine — the trustworthy baseline.
const thumbs = create(
  forge,
  {
    title: 'Migrate image thumbnails to on-upload resizing',
    body: 'CDN bill spiked from on-the-fly resizes. Move to resize-on-upload, backfill existing originals.',
    workstream: 'site-launch', type: 'build', status: 'in_progress',
  },
);
store.updateTicket(forge, {
  ticket_id: thumbs, status: 'done',
  note: 'Resizes now happen in the upload worker; backfill script processed 3,118 originals with zero failures.',
  evidence: [{ kind: 'commit', ref: '9f41c2a' }],
  confidence: 'routine', blast_radius: 'records',
});

// Done at spot_check, with metered spend — the SPEND stat needs a number.
const backfill = create(
  scout,
  {
    title: 'Backfill 2025 order exports into the warehouse',
    body: 'Finance needs 2025 order history queryable before the launch retro.',
    workstream: 'data-pipeline', type: 'ops', status: 'in_progress',
  },
);
store.updateTicket(scout, {
  ticket_id: backfill, status: 'done',
  note: 'All 12 monthly exports loaded; row counts match source. One March file had a duplicated header row, handled.',
  evidence: [{ kind: 'file', ref: 'warehouse/orders_2025' }],
  confidence: 'spot_check', blast_radius: 'records',
});
store.recordSpend(orch, backfill, { tokens: 841000, cost_usd: 2.94, note: 'harness meter, loop session' });

// In motion, with a draft artifact.
const post = create(
  quill,
  {
    title: 'Draft the launch announcement post',
    body: '800-1200 words for the blog: what shipped, who it is for, migration notes for existing users.',
    workstream: 'site-launch', type: 'writing', status: 'in_progress',
  },
);
store.updateTicket(quill, {
  ticket_id: post,
  note: "Outline approved in yesterday's meeting; first full draft is half done.",
  evidence: [{ kind: 'draft', ref: 'drafts/launch-post.md' }], blast_radius: 'draft',
});

// Awaiting the human — the view's headline card.
const analytics = create(
  scout,
  {
    title: 'Choose the analytics provider before launch',
    body: 'Site launch needs analytics wired in; provider choice is a cost/privacy tradeoff the operator owns.',
    workstream: 'site-launch', type: 'planning', status: 'in_progress',
  },
);
store.returnToHuman(scout, analytics, {
  situation: 'Scripts are ready to wire either provider; the choice affects cookie banners and monthly cost.',
  question: 'Which analytics provider should the new site launch with?',
  options: [
    { label: 'Plausible', consequence: 'No cookie banner needed; $9/mo at current traffic' },
    { label: 'GA4', consequence: 'Free, but requires a consent banner and a privacy-policy update' },
  ],
  recommendation: 'Plausible — the no-banner experience fits the launch story',
});

// Awaiting the human with NO options — the common shape since H-939, and the
// one the surfaces used to have no way to draw: a recommendation that stands on
// its own, with nothing manufactured beside it to make it look like a choice.
const dns = create(
  forge,
  {
    title: 'Point the apex domain at the new host',
    body: 'The new site is built and staged; the cutover is a DNS change nobody but the operator can authorise.',
    workstream: 'site-launch', type: 'ops', status: 'in_progress',
  },
);
store.returnToHuman(forge, dns, {
  situation: 'Staging has been green for three days and the old host is paid up to the end of the month.',
  question: 'Cut the apex domain over to the new host tonight?',
  recommendation: 'Yes — traffic is lowest after 9pm and the old host stays up for a month if we need to go back',
  if_unanswered: 'The launch post is written and cannot go out until the domain moves.',
});

// Awaiting the human with three — the widest a return may carry, and the case
// the a/b/c lettering exists for.
const support = create(
  quill,
  {
    title: 'Decide who answers support mail after launch',
    body: 'Launch will bring first-time users to an inbox nobody currently owns.',
    workstream: 'site-launch', type: 'planning', status: 'in_progress',
  },
);
store.returnToHuman(quill, support, {
  situation: 'Support mail goes to a shared inbox two of us can see and neither of us owns; launch week will be the first real volume.',
  question: 'Who answers support mail in launch week?',
  options: [
    { label: 'an agent drafts, you send', consequence: 'nothing goes out unread, but every reply waits on you' },
    { label: 'an agent answers the routine ones', consequence: 'fast replies; a wrong one reaches a customer before you see it' },
    { label: 'hold the inbox until week two', consequence: 'no risk and no replies; early users get silence' },
  ],
  recommendation: 'Draft-and-send for launch week — the volume is small enough that you can clear it daily, and week one is when a wrong reply costs the most',
  if_unanswered: 'Launch week starts Monday and the inbox is already receiving mail.',
});

// P1 ready while lower-priority work is in motion: trips the
// priority-inversion hygiene flag on purpose.
create(
  forge,
  {
    title: 'Add rate limiting to the public API',
    body: 'Signup opens the API to strangers; per-key rate limits before launch day.',
    workstream: 'site-launch', type: 'build', priority: 1,
  },
);
create(
  scout,
  {
    title: 'Deduplicate the contacts table before the newsletter import',
    body: '~4% duplicate rows by email; merge before the list import so sends do not double.',
    workstream: 'data-pipeline', type: 'ops',
  },
);
create(
  forge,
  {
    title: 'Weekly dependency and advisory audit',
    body: 'npm audit + changelog review across the three services; file tickets for anything real.',
    workstream: 'site-launch', type: 'ops', priority: 3, schedule: '0 9 * * 1',
  },
);

const rows = store.listTickets({ limit: 20 });
store.close();
console.log(`Seeded ${rows.length} tickets into ${demoDb}`);
for (const t of rows) console.log(`  ${t.id}  ${t.status.padEnd(14)} ${t.title}`);
console.log(`\nView it:  HELMO_DB=${demoDb} npm run view`);
console.log('README screenshot recipe: serve the view, then');
console.log('  chrome --headless=new --screenshot=docs/dashboard.png \\');
console.log('    --window-size=1360,860 --force-device-scale-factor=2 --hide-scrollbars http://127.0.0.1:4400');
