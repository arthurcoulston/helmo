import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { CopyReference } from "./WorkRecord"

type Project = { id: string; title: string; body: string; status: string; actual_usd: number; updated_at: string; parked_reason?: string; unpark_condition?: string }
type Claim = { kind: string; level?: string; size?: string; predicted_usd?: number; reason: string; author: string; ts: string }
type Citation = { objective_id: string; claim: string }
type Ranked = { project: Project; rank: number; explanation: string; blocked_by: string[]; citations: Citation[]; value: Claim | null; effort: Claim | null }
type Event = { seq: number; ts: string; event_type: string; actor: { name: string }; payload: { note?: string; reason?: string; claim?: string; decided_by?: string; verdict?: string; diffs?: { status?: { from: string; to: string } } } }
type Detail = { events: Event[]; citations: Citation[]; claims: Claim[]; deps: { incoming: { type: string; from_id: string }[]; outgoing: { type: string; to_id: string }[] } }
export type RoadmapData = {
  projects: Project[]; ranked: Ranked[]
  objectives: { id: string; rank: number; statement: string; horizon: string; source: string }[]
  bets: { id: string; statement: string; stake: string; falsifier: string }[]
}
const status = (value: string) => ({ ship_next: "Ship next", shipped_watching: "Watching", shipped_stable: "Stable" })[value] ?? value.replaceAll("_", " ")
const when = (value: string) => new Date(value).toLocaleString()

function Reference({ id }: { id: string }) {
  return <span className="inline-flex items-center gap-1"><a className="font-mono text-xs" href={`#${id}`}>{id}</a><CopyReference value={id} /></span>
}
function ClaimLine({ claim }: { claim: Claim }) {
  return <p className="text-sm"><span className="font-medium">{claim.kind} {claim.level ?? claim.size}{claim.predicted_usd != null ? ` · $${claim.predicted_usd} predicted` : ""}</span> — {claim.reason} <span className="text-muted-foreground">({claim.author}, {when(claim.ts)})</span></p>
}
function ProjectRow({ project, ranked, selected, hasObjectives }: { project: Project; ranked?: Ranked; selected: string; hasObjectives: boolean }) {
  const [open, setOpen] = React.useState(project.status === "ship_next" || selected === project.id)
  const [detail, setDetail] = React.useState<Detail | null>(null)
  const [error, setError] = React.useState("")
  React.useEffect(() => { if (selected === project.id) setOpen(true) }, [selected, project.id])
  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    fetch(`/api/v1/roadmap/projects/${project.id}`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not read project history (${response.status})`)
      return (await response.json()).data as Detail
    }).then((data) => { setDetail(data); setError("") }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [open, project.id, project.updated_at])
  const decision = detail?.events.findLast((e) => e.event_type === "ship_next_set")
  return <Collapsible open={open} onOpenChange={setOpen} asChild>
    <Card id={project.id} className="gap-0 py-0">
      <div className="flex items-start gap-2 p-3">
        <Reference id={project.id} />
        <CollapsibleTrigger asChild><Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-2 py-1 text-left">
          <ChevronRightIcon className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{project.title}</span>
        </Button></CollapsibleTrigger>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
        <Badge variant="secondary">{status(project.status)}</Badge>
        {ranked ? <span className="text-muted-foreground text-xs">#{ranked.rank} · {ranked.explanation}</span> : null}
        {ranked?.blocked_by.length ? <Badge variant="outline" className="whitespace-normal">Waits on {ranked.blocked_by.join(", ")}</Badge> : null}
        {hasObjectives && ranked && !ranked.citations.length ? <Badge variant="outline">Advances nothing stated</Badge> : null}
        <span className="text-muted-foreground text-xs">Updated {when(project.updated_at)}</span>
        {project.actual_usd ? <span className="text-muted-foreground text-xs">${project.actual_usd.toFixed(2)} metered</span> : null}
      </div>
      <CollapsibleContent><CardContent className="flex flex-col gap-4 border-t pt-4">
        {error ? <Alert variant="destructive"><AlertTitle>Could not refresh this record</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
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
      </CardContent></CollapsibleContent>
    </Card>
  </Collapsible>
}

export function RoadmapView({ data, selected }: { data: RoadmapData; selected: string }) {
  React.useEffect(() => { if (selected) requestAnimationFrame(() => document.getElementById(selected)?.scrollIntoView({ block: "center" })) }, [selected])
  const shipNext = data.ranked.filter((r) => r.project.status === "ship_next")
  const groups = [
    { title: "Ship next", rows: shipNext },
    { title: "Shipped — watching", rows: data.projects.filter((p) => p.status === "shipped_watching").map((project) => ({ project })) },
    { title: "The list", rows: data.ranked.filter((r) => r.project.status !== "ship_next") },
    { title: "Shipped — stable", rows: data.projects.filter((p) => p.status === "shipped_stable").map((project) => ({ project })) },
    { title: "Archived", rows: data.projects.filter((p) => p.status === "archived").map((project) => ({ project })) },
  ]
  return <>
    {shipNext.length >= 3 ? <Alert><AlertTitle>A growing work phase</AlertTitle><AlertDescription>What here is close enough to move to watching?</AlertDescription></Alert> : null}
    {groups.map((group, index) => <React.Fragment key={group.title}>
      {group.rows.length || index < 3 ? <section className="flex flex-col gap-2" aria-label={group.title}>
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{group.title} · {group.rows.length}</h2>
        {group.rows.map((r) => <ProjectRow key={r.project.id} project={r.project} ranked={"rank" in r ? r as Ranked : undefined} selected={selected} hasObjectives={data.objectives.length > 0} />)}
        {!group.rows.length ? <p className="text-muted-foreground text-sm">{index === 0 ? "Nothing has the go-ahead. The ranked list is waiting for your call." : "No projects in this section."}</p> : null}
      </section> : null}
      {index === 0 && (data.objectives.length || data.bets.length) ? <Card>
        <CardHeader><CardTitle>Charter</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4">
          {data.objectives.map((o) => <div key={o.id} id={o.id} className="text-sm"><Reference id={o.id} /> <Badge variant="outline">#{o.rank}</Badge> <span>{o.statement}</span><p className="text-muted-foreground text-xs">{o.horizon} · from {o.source}</p></div>)}
          {data.bets.map((b) => <div key={b.id} id={b.id} className="text-sm"><Reference id={b.id} /> {b.statement}<p className="text-muted-foreground text-xs">Stake: {b.stake} · falsified by: {b.falsifier}</p></div>)}
        </CardContent>
      </Card> : null}
    </React.Fragment>)}
  </>
}
