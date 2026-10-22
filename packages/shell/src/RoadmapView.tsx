import * as React from "react"
import { type ExpandedState } from "@tanstack/react-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { expandColumn, type LatestProgress, RecordPreview, RecordTable, recordColumn, type RecordColumn } from "./RecordTable"
import { CopyReference } from "./WorkRecord"
import { projectHealthRole, projectStatusReading, projectStatusRole, StatusAlert, StatusBadge } from "./Status"

type Usage = { value: number; basis: string; coverage: string }
/* What the work store says about one initiative, joined in by `serve.js` because
   the two stores may not read each other (R-47 C1). Optional for that reason and
   not for convenience: served standalone, the Roadmap view has no such field at
   all, and its absence has to read as UNKNOWN rather than as "nothing is
   outstanding" (R-46). `RemainingWork` below is where that distinction lives. */
type Hold = { reason: string; provenance: string; reconsider_when: string }
type OpenTicket = { id: string; title: string; status: string; assignee?: string | null; hold?: Hold | null; needs_human?: string | false | null }
type Standing = { id: string; title: string; schedule: string }
type Remaining = { open: OpenTicket[]; standing: Standing[]; open_count: number; standing_count: number; closed_count: number; tagged: number; reading: string; coverage: string }
type Result = { kind: string; ref: string; note?: string; role?: string }
type Milestone = { id: string; title: string; closed_at?: string | null; result: Result | null }
type Shipped = { milestones: Milestone[]; named_count: number; with_result_count: number; closed_count: number; reading: string; coverage: string }
type Project = { id: string; title: string; body: string; status: string; archived?: number; actual_usd: number; updated_at: string; parked_reason?: string; unpark_condition?: string; usage_disclosure?: Usage; progress?: LatestProgress; health?: string | null; health_reason?: string | null; readiness?: string | null; remaining_work?: Remaining; shipped?: Shipped }
type Claim = { kind: string; level?: string; size?: string; predicted_usd?: number; reason: string; author: string; ts: string }
type Citation = { objective_id: string; claim: string }
type Ranked = { project: Project; rank: number; explanation: string; blocked_by: string[]; citations: Citation[]; value: Claim | null; effort: Claim | null }
type Event = { seq: number; ts: string; event_type: string; actor: { name: string }; payload: { note?: string; reason?: string; claim?: string; decided_by?: string; verdict?: string; diffs?: { status?: { from: string; to: string } } } }
type Detail = { events: Event[]; citations: Citation[]; claims: Claim[]; deps: { incoming: { type: string; from_id: string }[]; outgoing: { type: string; to_id: string }[] } }
type Row = { project: Project; ranked?: Ranked }
type Opener = (id: string, from?: HTMLElement) => void
export type RoadmapData = {
  projects: Project[]; ranked: Ranked[]
  objectives: { id: string; rank: number; statement: string; horizon: string; source: string }[]
  bets: { id: string; statement: string; stake: string; falsifier: string }[]
}
/* Today's word for a stored status, whichever vocabulary the row was written
   with. `projectStatusReading` is the single place that knows both, so this view
   never carries a second legacy map to drift from it (R-46). */
const stateLabel = (value: string) => projectStatusReading(value).replaceAll("_", " ")
const when = (value: string) => new Date(value).toLocaleString()
const day = (value?: string | null) => (value ? new Date(value).toLocaleDateString() : "")
/* A ticket id belongs to the work record, which is another page of this same
   application; `?whole=1` is how Work reaches a row that is already closed, and
   a shipped milestone always is. */
const ticketHref = (id: string) => `/work?whole=1#${id}`
/* The server's explanation opens with the ordinal the rank column already
   states ("3rd — shaping, advances OBJ-1"); the Sheet carries it verbatim. */
const why = (explanation: string) => explanation.replace(/^\d+(?:st|nd|rd|th) — /, "")

function Reference({ id }: { id: string }) {
  return <span className="inline-flex items-center gap-1"><a className="font-mono text-xs" href={`#${id}`}>{id}</a><CopyReference value={id} /></span>
}
function ClaimLine({ claim }: { claim: Claim }) {
  return <p className="text-sm"><span className="font-medium">{claim.kind} {claim.level ?? claim.size}{claim.predicted_usd != null ? ` · $${claim.predicted_usd} planned usage estimate` : ""}</span> — {claim.reason} <span className="text-muted-foreground">({claim.author}, {when(claim.ts)})</span></p>
}

/* One project's history, claims and dependencies, read only for the project
   whose full record is open. */
function useProjectDetail(id: string, updatedAt: string | undefined) {
  const [state, setState] = React.useState<{ detail: Detail | null; error: string }>({ detail: null, error: "" })
  React.useEffect(() => {
    setState({ detail: null, error: "" })
    if (!id) return
    const controller = new AbortController()
    fetch(`/api/v1/roadmap/projects/${id}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not read project history (${response.status})`)
      return (await response.json()).data as Detail
    }).then((detail) => setState({ detail, error: "" })).catch((e: Error) => { if (!controller.signal.aborted) setState({ detail: null, error: e.message }) })
    return () => controller.abort()
  }, [id, updatedAt])
  return state
}

function usageLine(project: Project) {
  return `$${project.actual_usd.toFixed(2)} recorded usage estimate · ${project.usage_disclosure?.coverage ?? "excludes unmetered work"}`
}

/* Health is the owner's judgment and never derived (R-46), so this draws what
   is set and says nothing at all where nothing is — which is every row in a
   store where nobody has recorded one yet. The reason travels with the word
   wherever the word goes: "Off track" alone is a verdict a reader cannot act
   on, and the field is stored with a required reason for that reason. */
function Health({ project, className }: { project: Project; className?: string }) {
  if (!project.health) return null
  return <span className={["inline-flex min-w-0 flex-wrap items-center gap-1", className].filter(Boolean).join(" ")}>
    <StatusBadge status={projectHealthRole(project.health)}>{project.health}</StatusBadge>
    {project.health_reason ? <span className="text-muted-foreground min-w-0 break-words [overflow-wrap:anywhere]">{project.health_reason}</span> : null}
  </span>
}

/* A ticket the work record holds, named so it can be opened there. */
function TicketLink({ id }: { id: string }) {
  return <a className="font-mono text-xs underline-offset-4 hover:underline" href={ticketHref(id)}>{id}</a>
}

/* What remains, with the two rows that look like outstanding work and are not.
   Three constraints this inherits and must not break (R-46):

   - Every count states its denominator in the same sentence, and the server's
     own coverage line is printed verbatim. No percentage is derived from either:
     tickets are filed as work is discovered, so the denominator grows.
   - A recurring template is standing work — never ready, never claimed — and is
     listed apart from the open count as what WATCHES the initiative.
     Counting one would report a delivered initiative as having outstanding
     work forever.
   - An absent field is unknown, never none. The join lives in `serve.js`
     because the two stores may not read each other, so a Roadmap served
     standalone has no reading here at all and has to say so. */
function RemainingWork({ work }: { work?: Remaining }) {
  if (!work) return <section className="flex flex-col gap-1">
    <h3 className="text-sm font-medium">What remains</h3>
    <p className="text-muted-foreground text-sm">Unknown on this Roadmap: it is served without the work record, so it cannot count the initiative's open tickets. That is not the same as none.</p>
  </section>
  return <section className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">What remains · {work.reading}</h3>
    {work.open.length ? <ul className="flex flex-col gap-1">{work.open.map((ticket) => <li key={ticket.id} className="text-sm break-words [overflow-wrap:anywhere]">
      <TicketLink id={ticket.id} /> {ticket.title}
      <span className="text-muted-foreground"> — {ticket.status.replaceAll("_", " ")}{ticket.assignee ? `, ${ticket.assignee}` : ", unassigned"}</span>
      {ticket.hold ? <span className="text-muted-foreground"> · on hold: {ticket.hold.reason}</span> : null}
      {ticket.needs_human ? <span className="text-muted-foreground"> · needs you: {ticket.needs_human}</span> : null}
    </li>)}</ul> : <p className="text-muted-foreground text-sm">No open work is tagged to this initiative.</p>}
    {work.standing.length ? <p className="text-muted-foreground text-sm">
      Watched by {work.standing.map((ticket, i) => <React.Fragment key={ticket.id}>{i ? ", " : ""}<TicketLink id={ticket.id} /> {ticket.title} ({ticket.schedule})</React.Fragment>)} — standing work, never ready and never claimed, so it is not in the open count.
    </p> : null}
    <p className="text-muted-foreground text-xs">{work.coverage}</p>
  </section>
}

/* What shipped: the closed work that left something behind. The newest few are
   named and the rest counted beside them, because a hundred closed tickets is a
   log and the question this answers is "what shipped". The two numbers in the
   reading differ on purpose — a done ticket with no recorded result is a claim
   rather than a record, so it stays in the denominator and is not named. */
function Milestones({ shipped }: { shipped?: Shipped }) {
  if (!shipped) return <section className="flex flex-col gap-1">
    <h3 className="text-sm font-medium">What has shipped</h3>
    <p className="text-muted-foreground text-sm">Unknown on this Roadmap: it is served without the work record, so it cannot name the initiative's delivered work.</p>
  </section>
  return <section className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">What has shipped · {shipped.reading}</h3>
    {shipped.milestones.length ? shipped.milestones.map((milestone) => <div key={milestone.id} className="text-sm break-words [overflow-wrap:anywhere]">
      <TicketLink id={milestone.id} /> {milestone.title}{milestone.closed_at ? <span className="text-muted-foreground"> — {day(milestone.closed_at)}</span> : null}
      {milestone.result ? <p className="text-muted-foreground text-xs break-words [overflow-wrap:anywhere]">
        {/^https?:\/\//.test(milestone.result.ref) ? <a className="underline underline-offset-4" href={milestone.result.ref}>{milestone.result.ref}</a> : <span className="font-mono">{milestone.result.ref}</span>}
        {milestone.result.note ? ` — ${milestone.result.note}` : ""}
      </p> : null}
    </div>) : <p className="text-muted-foreground text-sm">Nothing closed here has left a recorded result yet.</p>}
  </section>
}

function ProjectRecord({ row, detail, error }: { row: Row; detail: Detail | null; error: string }) {
  const { project, ranked } = row
  const decision = detail?.events.findLast((e) => e.event_type === "ship_next_set")
  return <>
    <SheetHeader className="border-b pr-12">
      <SheetTitle className="break-words [overflow-wrap:anywhere]">{project.title}</SheetTitle>
      <SheetDescription asChild><div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
        <Reference id={project.id} />
        <StatusBadge status={projectStatusRole(project.status)}>{stateLabel(project.status)}</StatusBadge>
        {ranked ? <span>{ranked.explanation}</span> : null}
        <span>Updated {when(project.updated_at)}</span>
        <span>{usageLine(project)}</span>
      </div></SheetDescription>
    </SheetHeader>
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      {error ? <StatusAlert status="attention"><AlertTitle>Could not refresh this record</AlertTitle><AlertDescription>{error}</AlertDescription></StatusAlert> : null}
      {/* The go, promoted to a first-class reading: who said it, when, and why.
          The event itself is never rewritten, so it keeps its own name in
          history while the record reads it in today's words (R-46). */}
      {decision ? <p className="text-sm">Go-ahead · decided by {decision.payload.decided_by}, {when(decision.ts)} — {decision.payload.reason}</p> : null}
      <Health project={project} className="text-sm" />
      {project.parked_reason || project.unpark_condition ? <Alert><AlertTitle>On hold</AlertTitle><AlertDescription>{project.parked_reason}{project.unpark_condition ? ` · Resumes when: ${project.unpark_condition}` : ""}</AlertDescription></Alert> : null}
      {/* The six readings R-46 exists for come before the body. A record can
          carry thousands of characters of filing history, and what remains and
          what shipped read under that are readings nobody scrolls to. The body
          is the reference material; these are the answers. */}
      <RemainingWork work={project.remaining_work} />
      <Milestones shipped={project.shipped} />
      <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{project.body}</p>
      {(ranked?.citations ?? detail?.citations ?? []).map((c) => <p key={c.objective_id} className="text-sm"><Reference id={c.objective_id} /> {c.claim}</p>)}
      {ranked ? <>{ranked.value ? <ClaimLine claim={ranked.value} /> : null}{ranked.effort ? <ClaimLine claim={ranked.effort} /> : null}</> : detail?.claims.map((c, i) => <ClaimLine key={i} claim={c} />)}
      {detail ? <>
        <div className="flex flex-wrap gap-2">{detail.deps.outgoing.map((d, i) => <span key={i} className="text-xs">{d.type === "blocks" ? "Waits on" : "Related"} <Reference id={d.to_id} /></span>)}</div>
        <Collapsible><CollapsibleTrigger asChild><Button variant="outline" size="sm">History</Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-3 pt-3">
          {detail.events.map((e) => <div key={e.seq} className="border-l pl-3 text-sm">
            <p className="text-muted-foreground text-xs">{when(e.ts)} · {e.actor.name} · {e.event_type.replaceAll("_", " ")}{e.payload.diffs?.status ? ` · ${e.payload.diffs.status.from} → ${e.payload.diffs.status.to}` : ""}{e.payload.verdict ? ` · ${e.payload.verdict}` : ""}</p>
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{e.payload.note ?? e.payload.reason ?? e.payload.claim ?? ""}</p>
          </div>)}
        </CollapsibleContent></Collapsible>
      </> : !error ? <p className="text-muted-foreground text-sm">Loading history…</p> : null}
    </div>
  </>
}

function columnsFor(open: Opener): RecordColumn<Row>[] {
  return [
    expandColumn<Row>((row) => `Summary of ${row.project.id}`),
    {
      id: "rank",
      header: () => <span title="Position in the server's ranked order">#</span>,
      cell: ({ row }) => <span className="text-muted-foreground text-xs tabular-nums">{row.original.ranked ? row.original.ranked.rank : "—"}</span>,
      meta: { className: "w-8" },
    },
    {
      id: "project",
      header: () => "Project",
      cell: ({ row }) => {
        const { project, ranked } = row.original
        return <div className="flex min-w-0 flex-col items-start">
          {/* Title first and the reference after it, for the reason Work's are:
              the reference used to take the width a title needs before the title
              got any (H-2988). `basis-48` keeps them on one line where the
              column affords it. The title is also the way into the record — a
              phone scrolls these columns, so an icon in the last one would be
              the one control that is never on screen. */}
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-1">
            <Button variant="ghost" className="h-auto min-w-0 flex-1 basis-48 justify-start whitespace-normal px-2 py-1 text-left font-medium" onClick={(event) => open(project.id, event.currentTarget)}>
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{project.title}</span>
            </Button>
            <Reference id={project.id} />
          </div>
          {/* The server's explanation already says "waits on R-n" and
              "advances nothing stated" under exactly the conditions the old
              badges tested, and a badge only ever appeared on a ranked row.
              One line of the server's own words, not two renderings of it. */}
          {ranked ? <span className="text-muted-foreground px-2 text-xs">{why(ranked.explanation)}</span> : null}
          {/* Health goes on the row and not only in the record, because "is it
              healthy?" is a question a reader asks of the whole list at once.
              Readiness deliberately does NOT: the server's explanation above
              already carries it on the rows where it means something, and the
              migration only set it where it did — so a row rendering the field
              generally would print "raw idea" beside delivered work, where it
              reads as "never authorized" (H-3341). */}
          <Health project={project} className="px-2 text-xs" />
        </div>
      },
      meta: { className: recordColumn },
    },
    /* 96px, declared when the widest state was "Ship next" at 72px and the
       largest estimate "$175.01" at 59px. R-46 replaced every word in this
       column — "Monitoring" is now the longest — so the measurement that keeps
       the declaration honest is `verify:ui`'s own: it reports the tightest
       above-fold column at 390 across every layout, which is this one. A column
       keeps what it declares under `table-fixed`, and takes it from the title.
       Narrow it only against that reading, never against a guess. */
    { id: "state", header: () => "State", cell: ({ row }) => <StatusBadge status={projectStatusRole(row.original.project.status)}>{stateLabel(row.original.project.status)}</StatusBadge>, meta: { className: "w-24" } },
    { id: "usage", header: () => "Usage est.", cell: ({ row }) => <span>${row.original.project.actual_usd.toFixed(2)}</span>, meta: { className: "w-20 text-right tabular-nums" } },
  ]
}

/* The seven statuses, in the order a reader asks about them: what is underway,
   what has the go-ahead and has not started, what is only proposed, then what
   is held, watched, finished and dropped. Arthur's direction
   (H-2953@dev.rev); this list is that decision, not a view's taste, and the
   old five sections are gone with it.

   The first three draw whether or not they hold anything. Active and Proposed
   because they are the two ends of the pipeline and an empty one is news, and
   PLANNED because its emptiness is the defect R-46 names first: a go-ahead with
   nothing underway had no home on this screen, so an initiative the operator
   authorized and nobody started read exactly like one half-built — same
   heading, same badge, as work in flight, for as long as it sat there. A
   heading reading `PLANNED · 0` is the fix. */
const SECTIONS: { reading: string; always?: boolean; empty: string }[] = [
  { reading: "Active", always: true, empty: "Nothing is underway. Either nothing has the go-ahead, or nobody has started what has it." },
  { reading: "Planned", always: true, empty: "Nothing is waiting to start — everything with the go-ahead is underway." },
  { reading: "Proposed", always: true, empty: "Nothing is proposed. The list is waiting for an idea." },
  { reading: "Paused", empty: "Nothing is on hold." },
  { reading: "Monitoring", empty: "Nothing is being watched." },
  { reading: "Completed", empty: "Nothing has been completed." },
  { reading: "Canceled", empty: "Nothing has been cancelled." },
]

export function RoadmapView({ data, selected }: { data: RoadmapData; selected: string }) {
  const [expanded, setExpanded] = React.useState<ExpandedState>({})
  const [openId, setOpenId] = React.useState("")
  /* Radix returns focus to a SheetTrigger, and this Sheet has none: one Sheet
     serves every row, opened from the row's own control, from the expanded
     row, or from the fragment. So the opening control is remembered here and
     restored through the documented onCloseAutoFocus. */
  const opener = React.useRef<HTMLElement | null>(null)
  const openRecord = React.useCallback((id: string, from?: HTMLElement) => { opener.current = from ?? null; setOpenId(id) }, [])
  React.useEffect(() => { if (selected) requestAnimationFrame(() => document.getElementById(selected)?.scrollIntoView({ block: "center" })) }, [selected])
  /* A copied reference or a bookmark names one project: show its full record.
     Keyed on the fragment alone, so the fifteen-second refresh cannot reopen
     a Sheet that was closed. */
  React.useEffect(() => { if (/^R-\d+$/.test(selected)) openRecord(selected) }, [selected, openRecord])

  /* Each table keeps its own row array across refreshes, so a poll that
     returns the same records does not rebuild every table model. */
  const { groups, hidden, every } = React.useMemo(() => {
    const byId = new Map(data.projects.map((project) => [project.id, project]))
    /* `ranked` carries its own copy of each project; the one in `projects` is
       the whole record, including the server's usage disclosure and the work
       join. Ranked rows first and in the server's order, then the rows it does
       not rank at all, so every section the ranking reaches keeps it. */
    const rankedIds = new Set(data.ranked.map((r) => r.project.id))
    const every: Row[] = [
      ...data.ranked.map((r) => ({ project: byId.get(r.project.id) ?? r.project, ranked: r })),
      ...data.projects.filter((project) => !rankedIds.has(project.id)).map((project) => ({ project })),
    ]
    /* Grouped by what each stored status MEANS, so a row still carrying a
       pre-R-46 word sits with the rows that mean the same thing. */
    const groups = SECTIONS.map((section) => ({
      ...section,
      rows: every.filter((row) => !row.project.archived && projectStatusReading(row.project.status) === section.reading),
    }))
    /* `archived` is a hide flag and nothing more: it says whether to DRAW the
       row, never what became of it, and each hidden record keeps whatever
       status it was given. So a hidden row is absent from every section — the
       old "Archived" group was the status pretending to be a section — and
       stays reachable through its reference below, which is what a copied
       `R-n` or a bookmark lands on. */
    return { groups, hidden: every.filter((row) => row.project.archived), every }
  }, [data])
  const active = groups[0]!.rows
  const columns = React.useMemo(() => columnsFor(openRecord), [openRecord])
  const open = every.find((row) => row.project.id === openId)
  const detail = useProjectDetail(open ? openId : "", open?.project.updated_at)
  const coverage = data.projects.find((p) => p.usage_disclosure)?.usage_disclosure?.coverage

  return <>
    {active.length >= 3 ? <Alert><AlertTitle>A growing work phase</AlertTitle><AlertDescription>What here is close enough to move to watching?</AlertDescription></Alert> : null}
    {groups.map((group, index) => <React.Fragment key={group.reading}>
      {group.rows.length || group.always ? <section className="flex flex-col gap-2" aria-label={group.reading}>
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{group.reading} · {group.rows.length}</h2>
        <RecordTable<Row>
          label={group.reading}
          /* The four fixed columns above (44 + 32 + 96 + 80) plus a 168px record
             floor — not Work's 192, because the rank column in front of it
             spends width Work does not, and a floor that leaves no room for the
             State badge at 390 puts the fold back through it. See Work's for
             what measures this. */
          minWidth="min-w-[420px]"
          aboveFold={["project", "state"]}
          columns={columns}
          rows={group.rows}
          rowId={(row) => row.project.id}
          expanded={expanded}
          onExpandedChange={setExpanded}
          empty={group.empty}
          renderExpanded={(row) => <RecordPreview
            progress={row.project.progress ?? null}
            body={row.project.body}
            openLabel={`${row.project.id} ${row.project.title}`}
            onOpen={(from) => openRecord(row.project.id, from)}
          />}
        />
      </section> : null}
      {index === 0 && (data.objectives.length || data.bets.length) ? <Card>
        <CardHeader><CardTitle>Charter</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4">
          {data.objectives.map((o) => <div key={o.id} id={o.id} className="text-sm"><Reference id={o.id} /> <Badge variant="outline">#{o.rank}</Badge> <span>{o.statement}</span><p className="text-muted-foreground text-xs">{o.horizon} · from {o.source}</p></div>)}
          {data.bets.map((b) => <div key={b.id} id={b.id} className="text-sm"><Reference id={b.id} /> {b.statement}<p className="text-muted-foreground text-xs">Stake: {b.stake} · falsified by: {b.falsifier}</p></div>)}
        </CardContent>
      </Card> : null}
    </React.Fragment>)}
    {hidden.length ? <p className="text-muted-foreground text-xs">
      {hidden.length} hidden {hidden.length === 1 ? "record is" : "records are"} not listed above. Each keeps its own status and opens from its reference: {hidden.map((row, i) => <React.Fragment key={row.project.id}>{i ? ", " : ""}<a className="font-mono" href={`#${row.project.id}`}>{row.project.id}</a> {stateLabel(row.project.status)}</React.Fragment>)}.
    </p> : null}
    <p className="text-muted-foreground text-xs">Usage est. is a recorded estimate{coverage ? `, covering ${coverage}` : " and excludes unmetered work"}.</p>
    <Sheet open={!!open} onOpenChange={(next) => { if (!next) setOpenId("") }}>
      <SheetContent
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus() } }}
      >
        {open ? <ProjectRecord row={open} detail={detail.detail} error={detail.error} />
          : <SheetHeader><SheetTitle>No project</SheetTitle></SheetHeader>}
      </SheetContent>
    </Sheet>
  </>
}
