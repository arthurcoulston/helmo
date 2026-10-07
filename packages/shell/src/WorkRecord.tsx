import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { type ExpandedState } from "@tanstack/react-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { excerpt, expandColumn, RecordTable, recordColumn, type RecordColumn } from "./RecordTable"
import { acceptanceRole, StatusAlert, StatusBadge, ticketStateRole, type StatusRole } from "./Status"

type Evidence = { kind: string; ref: string; note?: string; role?: string }
// Index into the row's own `evidence` array, with what the projection knows
// about that item's purpose. The server sends places, not copies of the
// items, so the heaviest evidence list does not cost the document twice.
type ResultRole = { at: number; inferred?: true; corrected?: true }
type ResultDisplay = { primary: ResultRole | null; others: ResultRole[]; supporting: ResultRole[]; review: ResultRole[]; unstated: ResultRole[] }
type Event = { seq: number; ts: string; event_type: string; actor: { name: string; session?: string }; payload: { note?: string; question?: string; answer?: string } }
type Detail = { ticket: { body: string; uncertainty_note?: string }; events: Event[]; deps: { outgoing: { type: string; to_id: string }[]; incoming: { type: string; from_id: string }[] } }
type Row = {
  // `body` and `uncertainty_note` are not new: `view.ts` spreads the whole
  // ticket into every row, so the complete record is already in the document
  // the table is drawn from. Declaring them is what lets the row show its own
  // opening and the Sheet show the record without a second read.
  id: string; title: string; body: string; uncertainty_note?: string
  status: string; workstream: string; type: string
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

/** The dependencies and history of one record, read only for the record a
 *  reader has actually opened.
 *
 *  `drawn` says the caller has already written the record's own text out — the
 *  work document carries every body, so the compact table's Sheet shows it
 *  without waiting for this fetch, and in the order a reader wants it. The
 *  awaiting cards hold only a request, so they leave it unset and read the
 *  body this fetch brings. */
export function TicketDetails({ id, revision, drawn }: { id: string; revision?: string; drawn?: boolean }) {
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
    {/* Attention, not failure: the record itself is already on screen from the
        document the table was drawn from, and only its history is missing. */}
    {state.error ? <StatusAlert status="attention"><AlertTitle>Could not refresh the history</AlertTitle><AlertDescription>{state.error}</AlertDescription></StatusAlert> : null}
    {!data ? <p className="text-muted-foreground">Loading record…</p> : <>
      {drawn ? null : <>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{data.ticket.body}</p>
        {data.ticket.uncertainty_note ? <Alert><AlertTitle>Where the doubt is</AlertTitle><AlertDescription>{data.ticket.uncertainty_note}</AlertDescription></Alert> : null}
      </>}
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
      {/* A count, and only a count. It used to read "N recorded", which was a
          claim about every item in it: on the legacy multi-URL records all N
          purposes are the frozen `kind === "url"` guess, and each one says so
          on its own line underneath. The number is true; the word was not. */}
      <span className="font-medium">{r.others.length ? `Result · ${r.others.length + 1}` : "Result"}</span>
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

type Opener = (id: string, from?: HTMLElement) => void

/* The ticket's own status, said the way the operator reads it. The group
   heading says where a row sits in his queue; this column says what the store
   holds, and the two differ exactly where it matters — an open ticket under
   "Blocked" is still open. */
const STATE: Record<string, string> = { open: "Open", in_progress: "In motion", awaiting_human: "Awaiting you", done: "Done", cancelled: "Cancelled" }
const state = (value: string) => STATE[value] ?? value.replaceAll("_", " ")

/* The ticket's own reference: the fragment link a bookmark uses, and the
   qualified spelling to copy. `Reference` above is one evidence item. */
function RecordRef({ id }: { id: string }) {
  return <span className="inline-flex shrink-0 items-center gap-1">
    <a className="font-mono text-xs underline-offset-4 hover:underline" href={`#${id}`}>{id}</a>
    <CopyReference value={id} />
  </span>
}

/** The signals that should reach Arthur before he opens anything: what stands
 *  in front of the work, and what the record itself is flagging.
 *
 *  Each is the short form only. A hold's reason and a stale handoff's reason
 *  are sentences, and a sentence in a row is what made the cards tall — they
 *  are in the record, one control away, which is where the parked reason went
 *  on Roadmap for the same reason.
 *
 *  Three of these are deliberate and stay uncoloured (H-2978): waiting on a
 *  dependency, a capacity hold and a date gate are the queue working as asked,
 *  and the row already says so in words. What takes a colour is a record that
 *  has gone wrong on its own — a handoff that no longer matches readiness, work
 *  its author would not call routine, a closed ticket with nothing to show, and
 *  the release review's verdict. */
function Signals({ row }: { row: Row }) {
  const d = row.display
  const signals: { mark: string; status: StatusRole | null }[] = [
    { mark: d.waits_on.length ? `Waits on ${d.waits_on.join(", ")}` : "", status: null },
    { mark: d.held ? "On hold" : "", status: null },
    { mark: d.gated ? `Not before ${row.not_before}` : "", status: null },
    { mark: row.release_handoff?.current === false ? "Release handoff stale" : "", status: "attention" },
    { mark: row.confidence && row.confidence !== "routine" ? row.confidence.replaceAll("_", " ") : "", status: row.confidence === "needs_review" ? "attention" : null },
    { mark: d.acceptance.state !== "not_requested" ? `Acceptance ${d.acceptance.reason === "contested" ? "contested" : d.acceptance.state}` : "", status: acceptanceRole(d.acceptance.state, d.acceptance.reason) },
    { mark: row.status === "done" && !row.evidence.length ? "No evidence" : "", status: "attention" },
  ]
  const marks = signals.filter((signal) => signal.mark)
  /* A fixed-width column does not grow for a long mark, so a mark wraps rather
     than reaching across the column after it: "Waits on H-2946, H-2948" is one
     badge, and the badge upstream generates is `whitespace-nowrap h-5`. */
  return marks.length ? <span className="flex min-w-0 flex-wrap gap-1">
    {marks.map(({ mark, status }) => <StatusBadge key={mark} variant="outline" status={status} className="h-auto whitespace-normal">{mark}</StatusBadge>)}
  </span> : null
}

/** The whole record, in the Sheet the table opens. Everything the cards held
 *  plus the body they never showed until a fetch returned: the full text, what
 *  is standing in front of it, the last recorded progress, what it cost, what
 *  it produced, and its history.
 *
 *  The heading is the Sheet's own, so it needs the Sheet's context; the record
 *  itself is `TicketRecordContent` below, which renders anywhere and is how
 *  the result contract's proof reads it without a browser. */
export function TicketRecord({ row }: { row: Row }) {
  const d = row.display
  const standing = [
    d.held ? `On hold · ${row.capacity_hold?.reason ?? "no reason recorded"}` : "",
    d.gated ? `Cannot start before ${row.not_before}` : "",
    d.waits_on.length ? `Waits on ${d.waits_on.join(", ")}` : "",
    row.release_handoff?.current === false ? `Release handoff stale · ${row.release_handoff.stale_reason ?? "readiness changed"}` : "",
  ].filter(Boolean)
  return <>
    <SheetHeader className="border-b pr-12">
      <SheetTitle className="break-words [overflow-wrap:anywhere]">{row.title}</SheetTitle>
      <SheetDescription asChild><div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
        <RecordRef id={row.id} />
        <StatusBadge status={ticketStateRole(row.status)}>{state(row.status)}</StatusBadge>
        <Badge variant="outline">P{row.priority}</Badge>
        {row.blast_radius && row.blast_radius !== "none" ? <Badge variant="outline">{row.blast_radius}</Badge> : null}
        {row.schedule ? <Badge variant="outline">Recurring · {row.schedule}</Badge> : null}
        <span>{[row.workstream, row.project, row.type, row.assignee, row.lane && `lane ${row.lane}`].filter(Boolean).join(" · ")}</span>
        <span>{row.closed_at ? "Closed" : "Updated"} {time(row.closed_at ?? row.updated_at)}</span>
      </div></SheetDescription>
    </SheetHeader>
    <TicketRecordContent row={row} standing={standing} />
  </>
}

export function TicketRecordContent({ row, standing = [] }: { row: Row; standing?: string[] }) {
  const d = row.display
  return <div className="flex min-w-0 flex-col gap-4 overflow-y-auto p-4 text-sm">
    {/* What the work IS leads. The document the table was drawn from already
        carries it, so this is here before the history fetch returns. */}
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{row.body}</p>
    {row.uncertainty_note ? <Alert><AlertTitle>Where the doubt is</AlertTitle><AlertDescription>{row.uncertainty_note}</AlertDescription></Alert> : null}
    {standing.length ? <Alert><AlertTitle>Not ready to start</AlertTitle><AlertDescription>
      <div className="flex flex-col gap-1">{standing.map((line) => <span key={line}>{line}</span>)}</div>
    </AlertDescription></Alert> : null}
    {d.progress ? <p>Last recorded update {time(d.progress.at)} by {d.progress.actor.name}: {d.progress.note}</p> : null}
    {row.sitting ? <p>Needs a sitting: {row.sitting}</p> : null}
    {row.status === "done" ? <Results row={row} /> : null}
    <TicketDetails id={row.id} revision={row.updated_at} drawn />
    {/* The accounting last: true, and never the first thing about the work. */}
    <p className="text-muted-foreground text-xs">{row.tokens_total.toLocaleString()} recorded tokens · ${row.cost_usd_total.toFixed(2)} recorded usage estimate · historical basis may be mixed; unmetered work is excluded</p>
    {d.chain.length ? <p className="text-muted-foreground text-xs">{d.chain.join(" → ")}</p> : null}
  </div>
}

function columnsFor(open: Opener): RecordColumn<Row>[] {
  return [
    expandColumn<Row>((row) => `Summary of ${row.id}`),
    {
      id: "work",
      header: () => "Work",
      cell: ({ row }) => {
        const record = row.original
        return <div className="flex min-w-0 flex-col items-start">
          {/* The title asks for the whole column and the reference follows it,
              beside it where the column is wide enough for both and on its own
              line where it is not. The reference used to come FIRST, which at
              640 left a title about 100px of a 256px cell: H-2986's own title
              wrapped to four lines and its collapsed row stood 123px tall,
              which is not a table anyone scans. `basis-48` is what makes that
              conditional — the title claims the floor width before the
              reference gets any, and shrinks below it only when the column
              itself is narrower.

              The title is also the way in. A narrow window scrolls these
              columns, so a control in the last one would be the one never on
              screen; the title always is. */}
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-1">
            <Button variant="ghost" className="h-auto min-w-0 flex-1 basis-48 justify-start whitespace-normal px-2 py-1 text-left font-medium" onClick={(event) => open(record.id, event.currentTarget)}>
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{record.title}</span>
            </Button>
            <RecordRef id={record.id} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2">
            <span className="text-muted-foreground text-xs">{[record.workstream, record.project, record.type].filter(Boolean).join(" · ")}</span>
            <Signals row={record} />
          </div>
        </div>
      },
      meta: { className: recordColumn },
    },
    /* Each width is what the column is actually asked to carry across the whole
       record, plus the cell's padding — measured, because under `table-fixed` a
       column keeps every pixel it declares whether it needs them or not, and
       what it keeps it takes from the title. The widest state is "Cancelled" at
       76px, a priority is one digit, and the latest movement is "Aug 28, 12:44
       AM" at 102px. `verify:ui` fails on a cell wider than its column, so a
       longer word goes red rather than reaching into its neighbour. */
    { id: "state", header: () => "State", cell: ({ row }) => <StatusBadge status={ticketStateRole(row.original.status)}>{state(row.original.status)}</StatusBadge>, meta: { className: "w-24" } },
    { id: "priority", header: () => <span title="Priority: 0 critical, 3 low">P</span>, cell: ({ row }) => <span className="tabular-nums">{row.original.priority}</span>, meta: { className: "w-8 text-right" } },
    /* Who is the exception: assignees are short names, but the record holds
       "claude-code-interactive" at 137px from before they were, and a column
       sized for that would cost every row. It wraps instead. */
    { id: "assignee", header: () => "Who", cell: ({ row }) => <span className="text-xs">{row.original.assignee ?? "—"}</span>, meta: { className: "w-24 whitespace-normal break-words" } },
    { id: "updated", header: () => "Updated", cell: ({ row }) => <span className="text-muted-foreground text-xs">{time(row.original.closed_at ?? row.original.updated_at)}</span>, meta: { className: "w-32" } },
  ]
}

const GROUPS = [["motion", "In motion"], ["ready", "Ready"], ["blocked", "Blocked"], ["standing", "Standing"], ["done", "Done"], ["cancelled", "Cancelled"]]

export function WorkRecord({ data, selected }: { data: WorkRecordData; selected: string }) {
  const [expanded, setExpanded] = React.useState<ExpandedState>({})
  const [openId, setOpenId] = React.useState("")
  /* One Sheet serves every row, so there is no SheetTrigger for Radix to
     restore focus to. The control that opened it is remembered here and
     restored through the documented onCloseAutoFocus. */
  const opener = React.useRef<HTMLElement | null>(null)
  const openRecord = React.useCallback((id: string, from?: HTMLElement) => { opener.current = from ?? null; setOpenId(id) }, [])
  React.useEffect(() => {
    if (selected) requestAnimationFrame(() => document.getElementById(selected)?.scrollIntoView({ block: "center" }))
  }, [selected])
  /* A bookmark, a copied reference, a dependency badge or a grooming finding
     names one ticket: show its record. Keyed on the fragment alone, so the
     fifteen-second refresh cannot reopen a Sheet the reader closed. */
  React.useEffect(() => { if (/^H-\d+$/.test(selected)) openRecord(selected) }, [selected, openRecord])
  const columns = React.useMemo(() => columnsFor(openRecord), [openRecord])
  /* One row array per group, kept across refreshes that return the same
     records, so a poll does not rebuild six table models. */
  const groups = React.useMemo(() => GROUPS.map(([key, label]) => ({ key: key!, label: label!, rows: data.rows.filter((r) => r.display.group === key) })), [data])
  /* Only a record one of these tables actually draws. A decision, an action
     and a sitting are drawn as their own cards above, with their own controls,
     and a fragment naming one must scroll to that card — opening a Sheet over
     it would put a modal between Arthur and the request he came for. */
  const open = React.useMemo(() => groups.flatMap((group) => group.rows), [groups]).find((row) => row.id === openId)

  return <>
    <nav aria-label="Record scope" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{data.whole ? "Whole record" : `Current record · every live ticket and the newest ${data.closed_tail} closed`}</span>
      <Button variant="outline" size="sm" asChild><a href={data.whole ? "?" : "?whole=1"}>{data.whole ? "Return to current record" : "Whole record"}</a></Button>
    </nav>
    <div className="flex flex-wrap gap-2">{groups.map((group) => <Badge key={group.key} variant="secondary">{group.rows.length} {group.label.toLowerCase()}</Badge>)}</div>
    {data.hygiene.length ? <Collapsible>
      <CollapsibleTrigger asChild><Button variant="outline">Needs grooming · {data.hygiene.length}</Button></CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-3">{data.hygiene.map((f, i) => <p key={i} className="text-sm"><Badge variant="outline">{f.check.replaceAll("_", " ")}</Badge> {f.ticket_id ? <a className="underline" href={`?whole=1#${f.ticket_id}`}>{f.ticket_id}</a> : f.workstream} · {f.detail}</p>)}</CollapsibleContent>
    </Collapsible> : null}
    {groups.map((group) => group.rows.length ? <section key={group.key} className="flex flex-col gap-2" aria-label={group.label}>
      <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{group.label} · {group.rows.length}</h2>
      <RecordTable<Row>
        label={group.label}
        /* The five fixed columns above (44 + 96 + 32 + 96 + 128) plus the
           record column's 192px floor. `verify:ui` measures the fold at 390, so
           widening a column without this goes red. */
        minWidth="min-w-[588px]"
        columns={columns}
        rows={group.rows}
        rowId={(row) => row.id}
        expanded={expanded}
        onExpandedChange={setExpanded}
        empty="No work in this section."
        renderExpanded={(row) => {
          const { text, truncated } = excerpt(row.body ?? "")
          return <div className="flex flex-col items-start gap-2">
            <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{text || "This record has no description."}</p>
            <Button variant="outline" size="sm" onClick={(event) => openRecord(row.id, event.currentTarget)}>
              {truncated ? "Open full view — this is the record's opening only" : "Open full view"}
            </Button>
          </div>
        }}
      />
    </section> : null)}
    {!data.rows.length ? <p className="text-muted-foreground text-sm">No work has been recorded.</p> : null}
    <Sheet open={!!open} onOpenChange={(next) => { if (!next) setOpenId("") }}>
      <SheetContent
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus() } }}
      >
        {open ? <TicketRecord row={open} /> : <SheetHeader><SheetTitle>No record</SheetTitle></SheetHeader>}
      </SheetContent>
    </Sheet>
  </>
}
