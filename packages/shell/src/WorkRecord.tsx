import * as React from "react"
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

type Evidence = { kind: string; ref: string; note?: string; role?: string }
// Index into the row's own `evidence` array, with what the projection knows
// about that item's purpose. The server sends places, not copies of the
// items, so the heaviest evidence list does not cost the document twice.
type ResultRole = { at: number; inferred?: true; corrected?: true }
type ResultDisplay = { primary: ResultRole | null; others: ResultRole[]; supporting: ResultRole[]; review: ResultRole[]; unstated: ResultRole[] }
type Event = { seq: number; ts: string; event_type: string; actor: { name: string; session?: string }; payload: { note?: string; question?: string; answer?: string } }
type Detail = { ticket: { body: string; uncertainty_note?: string }; events: Event[]; deps: { outgoing: { type: string; to_id: string }[]; incoming: { type: string; from_id: string }[] } }
type Row = {
  id: string; title: string; status: string; workstream: string; type: string
  project?: string; assignee?: string; lane?: string; priority: number
  schedule?: string; not_before?: string; sitting?: string; confidence?: string
  release_handoff?: { current: boolean; stale_reason?: string }; blast_radius?: string; capacity_hold?: { reason: string }
  updated_at: string; closed_at?: string; tokens_total: number; cost_usd_total: number
  evidence: Evidence[]
  display: {
    group: string; waits_on: string[]; gated: boolean; held: boolean; chain: string[]
    acceptance: { state: string; reason: string }
    result: ResultDisplay
    progress: { at: string; note: string; actor: { name: string } } | null
  }
}
export type WorkRecordData = {
  whole: boolean; closed_tail: number; total: number; rows: Row[]
  hygiene: { check: string; ticket_id?: string; workstream?: string; detail: string }[]
}

function time(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function CopyReference({ value }: { value: string }) {
  const [result, setResult] = React.useState("")
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(value)
      setResult(`${value} copied`)
    } catch {
      const focus = document.activeElement as HTMLElement | null
      const field = document.createElement("textarea")
      field.value = value
      field.setAttribute("readonly", "")
      field.style.cssText = "position:fixed;top:-1000px;opacity:0"
      document.body.appendChild(field)
      field.select()
      let copied = false
      try { copied = document.execCommand("copy") } catch { /* announced below */ }
      field.remove()
      focus?.focus()
      setResult(copied ? `${value} copied` : `Could not copy ${value}`)
    }
  }
  return <>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Copy ${value}`} onClick={copy}>
      {result === `${value} copied` ? <CheckIcon /> : <CopyIcon />}
    </Button>
    <span className="sr-only" role="status">{result}</span>
  </>
}

export function TicketDetails({ id, revision }: { id: string; revision?: string }) {
  const [state, setState] = React.useState<{ data?: Detail; error?: string }>({})
  React.useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/v1/work/tickets/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not read ${id} (${response.status})`)
        return (await response.json()).data as Detail
      })
      .then((data) => setState({ data }))
      .catch((error: Error) => { if (!controller.signal.aborted) setState((old) => ({ ...old, error: error.message })) })
    return () => controller.abort()
  }, [id, revision])
  const data = state.data
  const deps = data ? [
    ...data.deps.outgoing.map((d) => ({ type: d.type === "blocks" ? "waits on" : d.type.replaceAll("_", " "), id: d.to_id })),
    ...data.deps.incoming.filter((d) => ["parent", "relates"].includes(d.type)).map((d) => ({ type: d.type === "parent" ? "parent of" : "related", id: d.from_id })),
  ] : []
  return <div className="flex min-w-0 flex-col gap-4 text-sm">
    {state.error ? <Alert variant="destructive"><AlertTitle>Could not refresh the history</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert> : null}
    {!data ? <p className="text-muted-foreground">Loading record…</p> : <>
      <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{data.ticket.body}</p>
      {data.ticket.uncertainty_note ? <Alert><AlertTitle>Where the doubt is</AlertTitle><AlertDescription>{data.ticket.uncertainty_note}</AlertDescription></Alert> : null}
      {deps.length ? <div className="flex flex-wrap gap-2">{deps.map((d, i) => <Badge key={i} variant="outline" asChild><a href={`?whole=1#${d.id}`}>{d.type} {d.id}</a></Badge>)}</div> : null}
      <div className="flex flex-col gap-3" aria-label={`${id} history`}>
        <h3 className="font-medium">History</h3>
        {data.events.filter((e) => !["linked", "unlinked"].includes(e.event_type)).map((event) => <div key={event.seq} className="border-l pl-3">
          <p className="text-muted-foreground text-xs"><time dateTime={event.ts}>{time(event.ts)}</time> · {event.actor.name} · {event.event_type === "answered" && event.actor.session === "dashboard" ? "answered from the dashboard" : event.event_type.replaceAll("_", " ")}</p>
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{event.payload.note ?? event.payload.question ?? event.payload.answer ?? ""}</p>
        </div>)}
      </div>
    </>}
  </div>
}

/** Where a ref can be opened from, for the device currently looking at the
 *  dashboard. A property of this viewing, never of the evidence (contract
 *  §2.5): `elsewhere` is a web address this device cannot reach, and `null` is
 *  a ref no browser opens at all — a commit or a path is not unreachable, it
 *  is simply not a link. The rule itself is unchanged: an http(s) URL whose
 *  host is not a loopback name, unless the dashboard is itself on loopback. */
function target(ref: string): string | "elsewhere" | null {
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"]
  try {
    const url = new URL(ref)
    if (!["http:", "https:"].includes(url.protocol)) return null
    return loopback.includes(location.hostname) || !loopback.includes(url.hostname) ? ref : "elsewhere"
  } catch { return null }
}

/** One evidence item, written out. `action` draws the single prominent control
 *  the record offers; everything else is a plain link or plain text, because a
 *  second identical button is the thing that made prominence meaningless. */
function Reference({ item, role, action }: { item?: Evidence; role: ResultRole; action?: boolean }) {
  // A place the row's own evidence array cannot answer draws nothing. The two
  // always come from the same row of the same response, so this only fires if
  // a projection disagrees with the array it indexes — and drawing one item
  // short beats throwing out of the render and blanking the record.
  if (!item) return null
  const where = target(item.ref)
  const link = where !== null && where !== "elsewhere" ? where : undefined
  return <div className="flex flex-wrap items-center gap-2">
    {action && link ? <Button variant="outline" size="sm" asChild><a href={link}>View result</a></Button> : null}
    {!(action && link) ? <span className="break-words [overflow-wrap:anywhere]">
      <span className="text-muted-foreground">{item.kind} </span>
      {link ? <a className="underline underline-offset-4" href={link}>{item.ref}</a> : <span className="font-mono text-xs">{item.ref}</span>}
    </span> : null}
    {where === "elsewhere" ? <span className="text-muted-foreground">Not reachable from this device</span> : null}
    {!link ? <CopyReference value={item.ref} /> : null}
    {item.note ? <span className="text-muted-foreground">{item.note}</span> : null}
    {role.inferred ? <Badge variant="outline">Purpose not recorded</Badge> : null}
    {role.corrected ? <Badge variant="outline">Role corrected</Badge> : null}
  </div>
}

/** What the work produced, read from the `display.result` projection rather
 *  than from how each ref happens to be spelled (R-42, H-2969). The predicate
 *  this replaced promoted every URL to the result and demoted every commit and
 *  file to review evidence, so 2,153 closed personal-estate tickets with
 *  evidence read "No product result linked". */
function Results({ row }: { row: Row }) {
  const r = row.display.result
  const at = (place: ResultRole) => row.evidence[place.at]
  const group = (label: string, places: ResultRole[]) => places.length ? <div aria-label={label} className="flex flex-col gap-1">
    <span className="font-medium">{label}</span>
    {places.map((place, i) => <Reference key={i} item={at(place)} role={place} />)}
  </div> : null
  return <div className="flex flex-col gap-3 text-sm">
    <div aria-label="Result" className="flex flex-col gap-1">
      <span className="font-medium">{r.others.length ? `Result · ${r.others.length + 1} recorded` : "Result"}</span>
      {r.primary
        ? <Reference item={at(r.primary)} role={r.primary} action />
        : <span className="text-muted-foreground">No result recorded{r.unstated.length ? ` — purpose was not recorded for ${r.unstated.length} item${r.unstated.length === 1 ? "" : "s"} of evidence` : ""}</span>}
      {r.others.map((place, i) => <Reference key={i} item={at(place)} role={place} />)}
    </div>
    {group("Supporting", r.supporting)}
    {group("Review", r.review)}
    {r.primary ? group("Purpose not recorded", r.unstated) : r.unstated.map((place, i) => <Reference key={i} item={at(place)} role={place} />)}
    <p>Release review: {row.display.acceptance.state.replaceAll("_", " ")}</p>
  </div>
}

function RecordRow({ row, selected }: { row: Row; selected: string }) {
  const [open, setOpen] = React.useState(selected === row.id)
  React.useEffect(() => { if (selected === row.id) setOpen(true) }, [selected, row.id])
  const d = row.display
  return <Collapsible open={open} onOpenChange={setOpen} asChild>
    <Card id={row.id} className="gap-0 py-0">
      <div className="flex items-start gap-1 p-3">
        <div className="flex shrink-0 items-center gap-1">
          <a className="font-mono text-xs underline-offset-4 hover:underline" href={`#${row.id}`}>{row.id}</a>
          <CopyReference value={row.id} />
        </div>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-2 py-1 text-left">
            <ChevronRightIcon className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
              <span className="block font-medium">{row.title}</span>
              <span className="text-muted-foreground block text-xs font-normal">{[row.workstream, row.project, row.type, row.assignee, row.lane && `lane ${row.lane}`].filter(Boolean).join(" · ")} · {time(row.closed_at ?? row.updated_at)}</span>
            </span>
          </Button>
        </CollapsibleTrigger>
      </div>
      <div className="flex flex-wrap gap-1 px-3 pb-3">
        {row.priority !== 2 ? <Badge variant="outline">P{row.priority}</Badge> : null}
        {row.release_handoff?.current === false ? <Badge variant="outline" className="whitespace-normal">Release handoff stale · {row.release_handoff.stale_reason ?? "readiness changed"}</Badge> : null}
        {d.waits_on.length ? <Badge variant="outline" className="whitespace-normal">Waits on {d.waits_on.join(", ")}</Badge> : null}
        {d.held ? <Badge variant="outline" className="whitespace-normal">On hold · {row.capacity_hold?.reason}</Badge> : null}
        {d.gated ? <Badge variant="outline">Not before {row.not_before}</Badge> : null}
        {row.schedule ? <Badge variant="outline" className="whitespace-normal">Recurring · {row.schedule}</Badge> : null}
        {row.confidence && row.confidence !== "routine" ? <Badge variant="secondary">{row.confidence.replaceAll("_", " ")}</Badge> : null}
        {row.blast_radius && row.blast_radius !== "none" ? <Badge variant="outline">{row.blast_radius}</Badge> : null}
        {d.acceptance.state !== "not_requested" ? <Badge variant="outline">Acceptance {d.acceptance.reason === "contested" ? "contested" : d.acceptance.state}</Badge> : null}
        {row.status === "done" && !row.evidence.length ? <Badge variant="outline">No evidence</Badge> : null}
      </div>
      <CollapsibleContent>
        <CardContent className="flex flex-col gap-4 border-t pt-4">
          {d.progress ? <p className="text-sm">Last recorded update {time(d.progress.at)} by {d.progress.actor.name}: {d.progress.note}</p> : null}
          {row.sitting ? <p className="text-sm">Needs a sitting: {row.sitting}</p> : null}
          <p className="text-muted-foreground text-xs">{row.tokens_total.toLocaleString()} recorded tokens · ${row.cost_usd_total.toFixed(2)} recorded usage estimate · historical basis may be mixed; unmetered work is excluded</p>
          {d.chain.length ? <p className="text-muted-foreground text-xs">{d.chain.join(" → ")}</p> : null}
          {row.status === "done" ? <Results row={row} /> : null}
          {open ? <TicketDetails id={row.id} revision={row.updated_at} /> : null}
        </CardContent>
      </CollapsibleContent>
    </Card>
  </Collapsible>
}

const GROUPS = [["motion", "In motion"], ["ready", "Ready"], ["blocked", "Blocked"], ["standing", "Standing"], ["done", "Done"], ["cancelled", "Cancelled"]]

export function WorkRecord({ data, selected }: { data: WorkRecordData; selected: string }) {
  React.useEffect(() => {
    if (selected) requestAnimationFrame(() => document.getElementById(selected)?.scrollIntoView({ block: "center" }))
  }, [selected])
  return <>
    <nav aria-label="Record scope" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{data.whole ? "Whole record" : `Current record · every live ticket and the newest ${data.closed_tail} closed`}</span>
      <Button variant="outline" size="sm" asChild><a href={data.whole ? "?" : "?whole=1"}>{data.whole ? "Return to current record" : "Whole record"}</a></Button>
    </nav>
    <div className="flex flex-wrap gap-2">{GROUPS.map(([key, label]) => <Badge key={key} variant="secondary">{data.rows.filter((r) => r.display.group === key).length} {label.toLowerCase()}</Badge>)}</div>
    {data.hygiene.length ? <Collapsible>
      <CollapsibleTrigger asChild><Button variant="outline">Needs grooming · {data.hygiene.length}</Button></CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-3">{data.hygiene.map((f, i) => <p key={i} className="text-sm"><Badge variant="outline">{f.check.replaceAll("_", " ")}</Badge> {f.ticket_id ? <a className="underline" href={`?whole=1#${f.ticket_id}`}>{f.ticket_id}</a> : f.workstream} · {f.detail}</p>)}</CollapsibleContent>
    </Collapsible> : null}
    {GROUPS.map(([key, label]) => {
      const rows = data.rows.filter((r) => r.display.group === key)
      return rows.length ? <section key={key} className="flex flex-col gap-2" aria-label={label}>
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label} · {rows.length}</h2>
        {rows.map((row) => <RecordRow key={row.id} row={row} selected={selected} />)}
      </section> : null
    })}
    {!data.rows.length ? <p className="text-muted-foreground text-sm">No work has been recorded.</p> : null}
  </>
}
