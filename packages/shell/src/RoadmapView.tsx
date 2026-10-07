import * as React from "react"
import { type ExpandedState } from "@tanstack/react-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { excerpt, expandColumn, RecordTable, recordColumn, type RecordColumn } from "./RecordTable"
import { CopyReference } from "./WorkRecord"
import { projectStatusRole, StatusAlert, StatusBadge } from "./Status"

type Usage = { value: number; basis: string; coverage: string }
type Project = { id: string; title: string; body: string; status: string; actual_usd: number; updated_at: string; parked_reason?: string; unpark_condition?: string; usage_disclosure?: Usage }
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
const status = (value: string) => ({ ship_next: "Ship next", shipped_watching: "Watching", shipped_stable: "Stable" })[value] ?? value.replaceAll("_", " ")
const when = (value: string) => new Date(value).toLocaleString()
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

function ProjectRecord({ row, detail, error }: { row: Row; detail: Detail | null; error: string }) {
  const { project, ranked } = row
  const decision = detail?.events.findLast((e) => e.event_type === "ship_next_set")
  return <>
    <SheetHeader className="border-b pr-12">
      <SheetTitle className="break-words [overflow-wrap:anywhere]">{project.title}</SheetTitle>
      <SheetDescription asChild><div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
        <Reference id={project.id} />
        <StatusBadge status={projectStatusRole(project.status)}>{status(project.status)}</StatusBadge>
        {ranked ? <span>{ranked.explanation}</span> : null}
        <span>Updated {when(project.updated_at)}</span>
        <span>{usageLine(project)}</span>
      </div></SheetDescription>
    </SheetHeader>
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      {error ? <StatusAlert status="attention"><AlertTitle>Could not refresh this record</AlertTitle><AlertDescription>{error}</AlertDescription></StatusAlert> : null}
      {decision ? <p className="text-sm">Ship next · decided by {decision.payload.decided_by}, {when(decision.ts)} — {decision.payload.reason}</p> : null}
      <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{project.body}</p>
      {project.parked_reason || project.unpark_condition ? <Alert><AlertTitle>Parked</AlertTitle><AlertDescription>{project.parked_reason}{project.unpark_condition ? ` · Unparks when: ${project.unpark_condition}` : ""}</AlertDescription></Alert> : null}
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
      meta: { className: "w-10" },
    },
    {
      id: "project",
      header: () => "Project",
      cell: ({ row }) => {
        const { project, ranked } = row.original
        return <div className="flex flex-col">
          <div className="flex flex-wrap items-center gap-1">
            <Reference id={project.id} />
            {/* The title is the way into the record. A phone scrolls these
                columns, so an icon in the last one would be the one control
                that is never on screen; the title always is. */}
            <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-2 py-1 text-left font-medium" onClick={(event) => open(project.id, event.currentTarget)}>
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{project.title}</span>
            </Button>
          </div>
          {/* The server's explanation already says "waits on R-n" and
              "advances nothing stated" under exactly the conditions the old
              badges tested, and a badge only ever appeared on a ranked row.
              One line of the server's own words, not two renderings of it. */}
          {ranked ? <span className="text-muted-foreground px-2 text-xs">{why(ranked.explanation)}</span> : null}
        </div>
      },
      meta: { className: recordColumn },
    },
    { id: "state", header: () => "State", cell: ({ row }) => <StatusBadge status={projectStatusRole(row.original.project.status)}>{status(row.original.project.status)}</StatusBadge>, meta: { className: "w-28" } },
    { id: "usage", header: () => "Usage est.", cell: ({ row }) => <span>${row.original.project.actual_usd.toFixed(2)}</span>, meta: { className: "w-24 text-right tabular-nums" } },
  ]
}

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
     returns the same records does not rebuild five table models. */
  const groups = React.useMemo(() => {
    const byId = new Map(data.projects.map((project) => [project.id, project]))
    /* `ranked` carries its own copy of each project; the one in `projects` is
       the whole record, including the server's usage disclosure. */
    const ranked: Row[] = data.ranked.map((r) => ({ project: byId.get(r.project.id) ?? r.project, ranked: r }))
    const listed = (state: string): Row[] => data.projects.filter((p) => p.status === state).map((project) => ({ project }))
    return [
      { title: "Ship next", rows: ranked.filter((r) => r.project.status === "ship_next"), empty: "Nothing has the go-ahead. The ranked list is waiting for your call." },
      { title: "Shipped — watching", rows: listed("shipped_watching"), empty: "No projects in this section." },
      { title: "The list", rows: ranked.filter((r) => r.project.status !== "ship_next"), empty: "No projects in this section." },
      { title: "Shipped — stable", rows: listed("shipped_stable"), empty: "No projects in this section." },
      { title: "Archived", rows: listed("archived"), empty: "No projects in this section." },
    ]
  }, [data])
  const shipNext = groups[0]!.rows
  const columns = React.useMemo(() => columnsFor(openRecord), [openRecord])
  const open = groups.flatMap((group) => group.rows).find((row) => row.project.id === openId)
  const detail = useProjectDetail(open ? openId : "", open?.project.updated_at)
  const coverage = data.projects.find((p) => p.usage_disclosure)?.usage_disclosure?.coverage

  return <>
    {shipNext.length >= 3 ? <Alert><AlertTitle>A growing work phase</AlertTitle><AlertDescription>What here is close enough to move to watching?</AlertDescription></Alert> : null}
    {groups.map((group, index) => <React.Fragment key={group.title}>
      {group.rows.length || index < 3 ? <section className="flex flex-col gap-2" aria-label={group.title}>
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{group.title} · {group.rows.length}</h2>
        <RecordTable<Row>
          label={group.title}
          columns={columns}
          rows={group.rows}
          rowId={(row) => row.project.id}
          expanded={expanded}
          onExpandedChange={setExpanded}
          empty={group.empty}
          renderExpanded={(row) => {
            const { text, truncated } = excerpt(row.project.body)
            return <div className="flex flex-col items-start gap-2">
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{text}</p>
              <Button variant="outline" size="sm" onClick={(event) => openRecord(row.project.id, event.currentTarget)}>
                {truncated ? "Open full view — this is the record's opening only" : "Open full view"}
              </Button>
            </div>
          }}
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
