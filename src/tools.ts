import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Store } from './store.js';
import { Actor, ACTOR_KINDS, DEP_TYPES, EFFORT_SIZES, HORIZONS, Project, RoadmapError, STATUSES, VALUE_LEVELS } from './types.js';
import { running } from './build.js';
import { Installation } from './install.js';

// Single source of truth for the MCP tool surface, Helmo-style: tool
// descriptions are guidance-as-deployed. Edit them here and only here.

const actorSchema = z
  .object({
    name: z.string(),
    kind: z.enum(ACTOR_KINDS),
    model: z.string().optional(),
    version: z.string().optional(),
    session: z.string().optional(),
  })
  .optional()
  .describe('Who is writing. Omit only when ROADMAP_ACTOR (or HELMO_ACTOR) in the server environment already names you exactly. Interactive sessions: pass your true identity on every write — {name, kind: "agent", model: your exact model ID, version: your harness version}. Writes without a truthful complete identity are rejected.');

function result(data: unknown, warnings: string[] = []): { content: { type: 'text'; text: string }[] } {
  const body: Record<string, unknown> = { result: data };
  if (warnings.length) body['warnings'] = warnings;
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 1) }] };
}

function fail(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const msg = e instanceof RoadmapError ? e.message : `Unexpected error: ${String(e)}`;
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
}

function compact(p: Project) {
  return { id: p.id, title: p.title, status: p.status, actual_usd: p.actual_usd, updated_at: p.updated_at };
}

export function buildServer(store: Store, envActor: Actor | null, install?: Installation): McpServer {
  const resolveActor = (override?: Actor): Actor => override ?? envActor ?? ({} as Actor);
  const identity = store.installationIdentity();
  const label = install?.label ?? identity.process ?? identity.stored ?? 'unknown';
  const ok = (data: unknown, warnings: string[] = []) => {
    const ids = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string' && /^(R|OBJ|BET)-\d+$/.test(value)) ids.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(data);
    return result({
      installation: { name: label, clear: identity.clear, ...(identity.stored ? { stored: identity.stored } : {}), build: running() },
      references: [...ids].map((id) => ({ id, qualified: `${label}:${id}` })),
      ...data as object,
    }, warnings);
  };

  const server = new McpServer({ name: 'helmo-roadmap', version: '0.1.0' });

  server.registerTool(
    'roadmap_add_project',
    {
      description:
        `Add a project to the roadmap — the record of work WORTH doing, the layer above Helmo's tickets of work BEING done. Getting an idea in costs nothing: a title, ideally a sentence of body. Everything else (claims, citations, shaping) accretes later; that is the design, not an omission. Bad ideas belong here too — recording an idea and ranking it low is the process succeeding.\n\n` +
        `A project is a thing that ships ("Helmo v2.0", "Run a hackathon"), not a domain that never ends (that is a Helmo workstream) and not code-shaped by default. New projects enter 'parked' unless you pass status 'shaping' because active work on the description is starting now. Projects are never claimed or executed directly — when one is declared go, a builder breaks it into Helmo tickets and the work happens there.`,
      inputSchema: {
        title: z.string().describe('One line, plain human terms'),
        body: z.string().optional().describe('A sentence is enough to start; the first sweep assesses fit from it'),
        status: z.enum(['parked', 'shaping']).optional(),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        const p = store.createProject(resolveActor(actor as Actor | undefined), input);
        return ok({ id: p.id, project: compact(p) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_get_project',
    {
      description:
        `Fetch one project: current fields, computed blocked-ness, deps, all claims (value/effort, with authors and reasons), objective citations, and the event history. Use it before shaping, critiquing, or re-ranking — the history is where earlier judgments and their reasons live.\n\n` +
        `The response also carries 'revision', the project's state as of this read — every field here is read under one snapshot, so the revision belongs to the text beside it. If what you write next depends on what you just read — reshaping a description, judging it ready, reversing a status — pass that number back as roadmap_update_project's 'if_revision' and the write is refused if a second writer moved the project in between. It covers this project's own record: 'blocked_by' and incoming 'deps' are facts about OTHER projects and can change without moving it, so a decision that turns on the dependency graph needs more than this token.`,
      inputSchema: { project_id: z.string() },
    },
    async ({ project_id }) => {
      try {
        // One snapshot, not seven reads — see Store.projectSnapshot for why the
        // revision is worthless if the body beside it came from another one.
        const { project, ...rest } = store.projectSnapshot(project_id);
        return ok({ ...project, ...rest });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_list_projects',
    {
      description:
        `The roadmap in derived rank order. Rank is never set by hand: facts (ship_next, ready, shaping, blocked, parked) set the tier; judgments (cited objective rank, latest value claim, effort) order within it; every row carries a one-line explanation of its position. Shipped and archived projects are excluded unless you filter for them by status; the response's ship_next array is the current work phase — every project the human has declared go on, and a growing array is a problem to surface, not a neutral fact.\n\n` +
        `The response also carries the charter projection (objectives by the human's rank, and bets) so fit can be assessed without a second call. A project marked "advances nothing stated" is a signal worth reading, not an error — some work is maintenance; the visibility is the point.`,
      inputSchema: {
        status: z.enum(STATUSES).optional().describe('Filter to one status; terminal statuses are only visible this way'),
        limit: z.number().int().optional(),
      },
    },
    async ({ status, limit }) => {
      try {
        if (status === 'shipped_watching' || status === 'shipped_stable' || status === 'archived') {
          // Off the ranked list; a plain listing serves the shelf and the archive.
          const rows = (store.dumpState()['projects'] as Project[]).filter((p) => p.status === status).slice(0, limit ?? 50);
          return ok({ projects: rows.map(compact), count: rows.length });
        }
        let ranked = store.rankProjects();
        if (status) ranked = ranked.filter((r) => r.project.status === status);
        ranked = ranked.slice(0, limit ?? 50);
        const watching = (store.dumpState()['projects'] as Project[]).filter((p) => p.status === 'shipped_watching');
        return ok({
          projects: ranked.map((r) => ({
            ...compact(r.project),
            rank: r.rank,
            explanation: r.explanation,
            ...(r.blocked_by.length ? { blocked_by: r.blocked_by } : {}),
          })),
          count: ranked.length,
          objectives: store.listObjectives().map((o) => ({ id: o.id, rank: o.rank, horizon: o.horizon, statement: o.statement })),
          bets: store.listBets().map((b) => ({ id: b.id, statement: b.statement, stake: b.stake, falsifier: b.falsifier })),
          ship_next: store.shipNextProjects().map((p) => p.id),
          ...(watching.length ? { shipped_watching: watching.map((p) => p.id) } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_update_project',
    {
      description:
        `Record a change to a project: shaping the description, moving it along the ladder (parked · shaping · ready · ship_next · shipped_watching · shipped_stable · archived), parking it with an exit condition. Every call requires a 'note' — one or two lines, human terms; notes are the story the human reads.\n\n` +
        `Status rules the store enforces: ship_next is NEVER set here (roadmap_set_ship_next records that human go-ahead), and the shipped statuses are reachable only from ship_next — nothing ships that the human never declared go on. 'ready' means enough is known to make an informed decision about committing to the project; details may keep being decided while building. An agent declaring it must not be the one who last shaped the description: a second pair of eyes judges commitment-readiness, while a title-only change does not count as shaping. 'shipped_watching' means newly shipped: monitoring, feedback, bug fixes, loose ends. 'shipped_stable' records a standing human decision that the maintenance is worth it — move a project there only when that decision has been stated. When parking, record unpark_condition ("revisit when Helmo has one external user") so a sweep can retest the condition instead of the idea rotting silently. 'archived' is terminal and permanent — the project ran its course and no longer earns its maintenance, all surfaces closed/taken down (ideas killed before shipping land here too); a revived idea is a new project with a 'relates' link.\n\n` +
        `Every one of those rules is decided against the project as it is when the write lands, and a project has more than one writer. If this update depends on what you read first — you reshaped the body you just read, you judged that description ready, you are reversing a status — pass 'if_revision' with the 'revision' that read gave you: the write is then refused, with nothing stored, if anyone moved the project in between, instead of silently landing on top of their change. Omit it for a write that turns on nothing you read. The response carries the new revision either way.`,
      inputSchema: {
        project_id: z.string(),
        note: z.string(),
        if_revision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('The revision this update was decided against, from roadmap_get_project — refuses the write if the project has moved since'),
        status: z.enum(['parked', 'shaping', 'ready', 'shipped_watching', 'shipped_stable', 'archived']).optional(),
        title: z.string().optional(),
        body: z.string().optional().describe('The project description accretes and gets rewritten over months — keep it current enough to support an informed commitment decision'),
        parked_reason: z.string().optional(),
        unpark_condition: z.string().optional().describe('What would unpark this — phrased so a sweep can test it'),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        const { project, revision, warnings } = store.updateProject(resolveActor(actor as Actor | undefined), input);
        return ok({ ...compact(project), revision }, warnings);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_record_claim',
    {
      description:
        `Record a value or effort judgment on a project. Judgments are claims with an author, a date, and a one-line reason — never naked numbers; the latest claim of each kind is what ranking uses, and the history stays. Lowering a project's value is ordinary maintenance, not a dispute: the crew agreeing an idea is low-value is the critique working.\n\n` +
        `value: level high|medium|low. effort: size S|M|L|XL plus predicted_usd — the dollar prediction is checked against the metered actual rolled up from the project's Helmo tickets, which is what teaches the crew what a size really costs and lets falling costs re-sort the list. No hour estimates, no dates.`,
      inputSchema: {
        project_id: z.string(),
        kind: z.enum(['value', 'effort']),
        level: z.enum(VALUE_LEVELS).optional().describe('value claims'),
        size: z.enum(EFFORT_SIZES).optional().describe('effort claims'),
        predicted_usd: z.number().min(0).optional().describe('effort claims: predicted total cost in dollars — the falsifiable half of the estimate'),
        reason: z.string().describe('One line on why — what makes this high/low value, or what the size hinges on'),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok(store.recordClaim(resolveActor(actor as Actor | undefined), input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_record_readiness_verdict',
    {
      description:
        `Record an independent review of a project's commitment-readiness. Read the project first and pass its readiness revision: verdicts on identical state form one append-only set, each reviewer's latest verdict is their own correction, and any FAIL governs. A mixed set is contested. A passing set moves the project to ready; a failed or contested set leaves it shaping. Any non-verdict project change makes the old revision stale, and a refused write stores nothing. The description's last shaper cannot review their own work.`,
      inputSchema: {
        project_id: z.string(),
        reviewed_revision: z.number().int().positive().describe('The readiness_revision from roadmap_get_project'),
        verdict: z.enum(['pass', 'fail']),
        note: z.string().describe('Why it is ready, or the concrete issue that remains'),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        const { project, readiness } = store.recordReadinessVerdict(resolveActor(actor as Actor | undefined), input);
        return ok({ project: compact(project), readiness });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_cite',
    {
      description:
        `Tie a project to a charter objective with a checkable one-line claim of HOW it advances it ("advances OBJ-3, because …"). This is what rescues value from decoration: the human can disagree with the mapping rather than with a number. A project cites zero or more objectives; citing nothing is a visible signal, not an error. action 'remove' drops a citation that no longer holds.`,
      inputSchema: {
        project_id: z.string(),
        objective_id: z.string(),
        claim: z.string().optional().describe("Required when adding: how this project advances the objective, one line"),
        action: z.enum(['add', 'remove']).optional().describe("default 'add'"),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok({ citations: store.cite(resolveActor(actor as Actor | undefined), input) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_link_projects',
    {
      description:
        `Add or remove a typed link between projects. 'blocks' (from_id cannot ship until to_id has shipped — blocked-ness is computed from these, never remembered) or 'relates' (soft association, including a revived idea pointing at its abandoned ancestor). Use 'blocks' sparingly, for true prerequisites.`,
      inputSchema: {
        from_id: z.string(),
        to_id: z.string(),
        type: z.enum(DEP_TYPES),
        action: z.enum(['add', 'remove']).optional().describe("default 'add'"),
        actor: actorSchema,
      },
    },
    async ({ from_id, to_id, type, action, actor }) => {
      try {
        store.link(resolveActor(actor as Actor | undefined), from_id, to_id, type, action ?? 'add');
        return ok({ linked: action !== 'remove', from_id, to_id, type });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_set_ship_next',
    {
      description:
        `Record the human's go-ahead moving a ready project into ship_next — the work phase. This is ALWAYS the human's call: the tool exists for an agent to record a decision the human stated explicitly, with decided_by naming them and reason carrying their one-line why. Never call it on your own judgment, however ready a project looks. Only a 'ready' project can be declared.\n\n` +
        `Several projects may hold ship_next at once, but with resistance: the response carries the resulting count, and a growing work phase is a problem to surface to the human, not a neutral fact — the standing aim is getting projects OFF it (to shipped_watching) when they are close. ship_next is disclosure — the human's current shipping order, readable here — not tasking: seeing it does not authorize starting the work. Building begins when the project is broken into Helmo tickets and those enter the ready queue like any other work.`,
      inputSchema: {
        project_id: z.string(),
        decided_by: z.string().describe('The human who made the call'),
        reason: z.string().describe("The human's one-line why, so the fleet reads a decision, not a flag"),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        const { project, ship_next_count } = store.setShipNext(resolveActor(actor as Actor | undefined), input);
        // Crowding is the only thing worth saying back: until H-1126 this also
        // told the caller to update Helmo's standing notice, which no longer exists.
        const crowded = ship_next_count >= 3
          ? `ship_next now holds ${ship_next_count} projects — a growing work phase is a problem. Tell the human, and look for the ones close enough to move to shipped_watching.`
          : null;
        return ok({ project: compact(project), ship_next_count, ...(crowded ? { note: crowded } : {}) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_record_actual',
    {
      description:
        `Record the metered actual cost for a project — the rollup of cost_usd across its Helmo tickets (query them by the ticket 'project' tag). Absolute total, not a delta; the sweep recomputes and re-records it. Never self-report a guess: this figure is what makes effort predictions falsifiable, and it must come from Helmo's meter.`,
      inputSchema: {
        project_id: z.string(),
        actual_usd: z.number().min(0),
        note: z.string().describe('Where the rollup came from: which Helmo project tag, how many tickets'),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok(compact(store.recordActual(resolveActor(actor as Actor | undefined), input)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'roadmap_set_charter_item',
    {
      description:
        `Upsert one item of the charter projection. The charter is the one thing the human writes and agents only read — it lives in the human's own document, and this records a PROJECTION of it: derive items from that source at the human's direction, never author them. 'source' points back to the authoritative document and derived_at marks when, so drift is visible; when the source changes, re-derive.\n\n` +
        `shape 'objective': statement, horizon near|long|standing, rank (1 = top — the human ranks a dozen objectives once; project rank inherits from this). shape 'bet': statement, stake, falsifier — bets justify projects that advance no objective but cheaply test a written-down belief. Pass id (OBJ-n / BET-n) to update an existing item; omit it to mint one. Gates and stances are recognized shapes for v2 — do not force them into objectives.`,
      inputSchema: {
        shape: z.enum(['objective', 'bet']),
        id: z.string().optional().describe('Update an existing item; omit to create'),
        statement: z.string().describe('Short and quotable — citations point at this'),
        source: z.string().describe('Pointer to the authoritative document this was derived from'),
        horizon: z.enum(HORIZONS).optional().describe('objectives'),
        rank: z.number().int().min(1).optional().describe("objectives: the human's ordering, 1 = top"),
        stake: z.string().optional().describe('bets: what rides on this being true'),
        falsifier: z.string().optional().describe('bets: what would show it false'),
        actor: actorSchema,
      },
    },
    async ({ actor, ...input }) => {
      try {
        return ok(store.setCharterItem(resolveActor(actor as Actor | undefined), input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
