/* Team: what each seat is configured to carry into a session, and what its
   sessions have spent.

   Context is this view's subject, so it takes the emphasis — the composition
   bar is the widest thing a row carries after the member itself. Current
   assignments, ticket lists and work history are Work's; a row links there
   rather than reproducing it.

   Three readings this view must never collapse, because each is a way to
   mislead and the server keeps them apart (packages/runtime `team.ts`):

   - What Rev COMPOSES into the system prompt against what the runtime's CLI
     DISCOVERS in the working tree. Both are configuration a session really
     carries; only the first is Rev's own.
   - What is LOADED at startup against what is AVAILABLE to read. A seat's
     memory corpus runs to hundreds of files; counting it as startup context
     would overstate every member by two orders of magnitude, so it is reported
     beside the startup total and never inside it.
   - What is MEASURED against what is UNMEASURED. The CLI's own system prompt,
     its tool schemas and the iteration prompt are real tokens nobody can count
     from here. They are named, so the total never reads as the whole.

   And the dollars are notional — an API-rate equivalent, not subscription cash
   — which the server states and the footer carries. */
import * as React from "react"
import type { ExpandedState } from "@tanstack/react-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { RecordTable, expandColumn, recordColumn, type RecordColumn } from "./RecordTable"
import { StatusAlert, StatusBadge, contextFileRole, loopStateRole } from "./Status"

export type FileState = "ok" | "tight" | "over" | "uncapped" | "unreadable"
export type MeasuredFile = { path: string; name: string; bytes: number; tokens: number; cap: number | null; state: FileState; error?: string }
export type SeatContext = {
  composed: { profile: MeasuredFile | null; skills: MeasuredFile[]; tokens: number }
  discovered: { files: MeasuredFile[]; tokens: number; note: string }
  memory: { configured: boolean; index: MeasuredFile | null; files: number; tokens: number; note: string }
  startup_tokens: number
  session_cap: null
  unmeasured: string[]
  tokenizer: string
}
export type SeatSpend = {
  period: string
  since: string | null
  tokens: number
  usd: number
  sessions: number
  unknown_sessions: number
  by_model: { model: string; runtime: string; tokens: number; usd: number; sessions: number }[]
  by_day: { day: string; tokens: number; usd: number }[]
}
export type Member = {
  id: string; name: string; state: string; workstream: string; runtime: string; model: string
  context: SeatContext; spend: SeatSpend
}
export type TeamData = {
  period: string
  periods: string[]
  basis: { dollars: string; tokens: string; coverage: string }
  tokenizer: string
  loops: Member[]
}

const PERIOD_LABEL: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", all: "All time" }

/* The chart colours are the preset's own (Mauve), which is what a composition
   bar is for. They carry no status meaning and must not: the four status roles
   say whether something needs Arthur, and a category is not a severity. */
const CATEGORIES = [
  { key: "profile", label: "Profile", fill: "bg-chart-1" },
  { key: "skills", label: "Skills", fill: "bg-chart-2" },
  { key: "tree", label: "Working tree", fill: "bg-chart-3" },
] as const

const count = (n: number) => n.toLocaleString()
const dollars = (n: number) => `$${n.toFixed(2)}`
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n))

function parts(context: SeatContext) {
  return [
    { ...CATEGORIES[0], tokens: context.composed.profile?.tokens ?? 0 },
    { ...CATEGORIES[1], tokens: context.composed.skills.reduce((sum, file) => sum + file.tokens, 0) },
    { ...CATEGORIES[2], tokens: context.discovered.tokens },
  ]
}

/* Colour is never the carrier (UI.md), and a bar is nothing but colour — so
   the composition is also stated in words on the element itself, which is what
   a screen reader and the accessibility audit read. A segment below 2% of the
   bar still gets 2% of its width: a category that is present must be visible,
   and a hairline is indistinguishable from absence. */
function Composition({ context, labelledBy }: { context: SeatContext; labelledBy?: string }) {
  const shown = parts(context).filter((part) => part.tokens > 0)
  const total = context.startup_tokens
  const words = total
    ? `${count(total)} tokens configured at startup: ${shown.map((part) => `${part.label} ${count(part.tokens)}`).join(", ")}`
    : "No configured startup context could be measured"
  return <div className="flex flex-col gap-1">
    <div role="img" aria-label={words} aria-describedby={labelledBy} className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
      {shown.map((part) => <div key={part.key} className={part.fill} style={{ width: `${Math.max(2, (part.tokens / total) * 100)}%` }} />)}
    </div>
    <span className="text-xs tabular-nums">{total ? `${count(total)} tok` : "unmeasured"}</span>
  </div>
}

/* One inventoried file. `tight` and `uncapped` stay neutral: a file deliberately
   kept near its cap is the system working, and an uncapped file is a gap in the
   record rather than a fault in the run. `over` is amber because a ratified cap
   has been breached and only Arthur ratifies a new one; `unreadable` is red
   because the shim refuses to launch a seat whose profile or skill it cannot
   read (rc 78, apparatus) — the loop is already down. */
function FileLine({ file, role, member }: { file: MeasuredFile; role: string; member: string }) {
  const [body, setBody] = React.useState("")
  const [error, setError] = React.useState("")
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (!open || body || error) return
    const controller = new AbortController()
    fetch(`/api/v1/team/members/${encodeURIComponent(member)}/files/${encodeURIComponent(file.path)}`, { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`This file cannot be read (${response.status}).`)
        return (await response.json()).data as { body: string; truncated: boolean }
      })
      .then((read) => setBody(read.body + (read.truncated ? "\n\n…bounded here; the file continues." : "")))
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [open, body, error, member, file.path])
  return <div className="flex flex-col gap-1 border-l pl-3">
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-sm font-medium [overflow-wrap:anywhere]">{file.name}</span>
      <Badge variant="outline">{role}</Badge>
      <span className="text-xs tabular-nums">{count(file.tokens)} tok{file.cap === null ? "" : ` / ${count(file.cap)}`}</span>
      {file.state === "ok" ? null : <StatusBadge status={contextFileRole(file.state)}>{file.state === "uncapped" ? "no cap declared" : file.state}</StatusBadge>}
    </div>
    <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{file.path}{file.state === "unreadable" ? ` — ${file.error}` : ` · ${count(file.bytes)} bytes`}</p>
    {file.state === "unreadable" ? null : <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild><Button variant="outline" size="sm">Read {file.name}</Button></CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {error ? <StatusAlert status="attention"><AlertTitle>Unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></StatusAlert>
          : <p className="max-h-80 overflow-y-auto whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{body || "Loading…"}</p>}
      </CollapsibleContent>
    </Collapsible>}
  </div>
}

function MemberRecord({ member, basis }: { member: Member; basis: TeamData["basis"] }) {
  const { context, spend } = member
  const peak = Math.max(1, ...spend.by_day.map((day) => day.tokens))
  return <>
    <SheetHeader className="border-b pr-12">
      <SheetTitle className="break-words">{member.name}</SheetTitle>
      <SheetDescription asChild><div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
        <StatusBadge status={loopStateRole(member.state)}>{member.state}</StatusBadge>
        <span>{member.workstream}</span>
        <span>{member.runtime} · {member.model}</span>
      </div></SheetDescription>
    </SheetHeader>
    <div className="flex flex-col gap-5 overflow-y-auto p-4">
      <section className="flex flex-col gap-2" aria-label="Configured context">
        <h3 className="text-xs font-medium tracking-wide uppercase">Configured context</h3>
        <Composition context={context} />
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {parts(context).map((part) => <li key={part.key} className="flex items-center gap-1.5">
            <span className={`${part.fill} size-2 rounded-full`} aria-hidden="true" />
            <span>{part.label} {count(part.tokens)}</span>
          </li>)}
        </ul>
        {/* The one number this page refuses to invent. A model's context window
            is not a configured cap, and showing one as the other is how a
            reader concludes a seat has room it was never given. */}
        <p className="text-muted-foreground text-xs">
          Per-file caps are each file's own <code>cap_tokens</code>. No whole-session cap is configured
          anywhere, so none is shown — and a model's context window is not one. Measured with {context.tokenizer}.
        </p>
      </section>

      <section className="flex flex-col gap-3" aria-label="Files">
        <h3 className="text-xs font-medium tracking-wide uppercase">What a session loads</h3>
        {context.composed.profile ? <FileLine file={context.composed.profile} role="profile" member={member.id} /> : null}
        {context.composed.skills.map((file) => <FileLine key={file.path} file={file} role="skill" member={member.id} />)}
        <p className="text-muted-foreground text-xs">{context.discovered.note}</p>
        {context.discovered.files.map((file) => <FileLine key={file.path} file={file} role="working tree" member={member.id} />)}
      </section>

      <section className="flex flex-col gap-3" aria-label="Memory">
        <h3 className="text-xs font-medium tracking-wide uppercase">Memory — available, not loaded</h3>
        <p className="text-muted-foreground text-xs">{context.memory.note}</p>
        {context.memory.configured && context.memory.files ? <p className="text-sm tabular-nums">{count(context.memory.files)} files · roughly {count(context.memory.tokens)} tokens if every one were read</p> : null}
        {context.memory.index ? <FileLine file={context.memory.index} role="memory index" member={member.id} /> : null}
      </section>

      <section className="flex flex-col gap-2" aria-label="Not measured">
        <h3 className="text-xs font-medium tracking-wide uppercase">Not measured</h3>
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          {context.unmeasured.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <p className="text-muted-foreground text-xs">Real tokens in every session that nothing here can count. The startup total above is not the whole of what a session carries.</p>
      </section>

      <section className="flex flex-col gap-3" aria-label="Usage">
        <h3 className="text-xs font-medium tracking-wide uppercase">Usage · {PERIOD_LABEL[spend.period] ?? spend.period}</h3>
        <p className="text-sm tabular-nums">{count(spend.tokens)} tokens · {dollars(spend.usd)} notional · {count(spend.sessions)} metered {spend.sessions === 1 ? "session" : "sessions"}</p>
        {spend.unknown_sessions ? <Alert><AlertTitle>{count(spend.unknown_sessions)} {spend.unknown_sessions === 1 ? "session" : "sessions"} the runtime did not meter</AlertTitle><AlertDescription>Counted here, and absent from the totals above — not added as zero.</AlertDescription></Alert> : null}
        {spend.by_model.length ? <table className="text-xs">
          <caption className="text-muted-foreground pb-1 text-left">By model</caption>
          <tbody>{spend.by_model.map((model) => <tr key={`${model.runtime}/${model.model}`}>
            <th scope="row" className="pr-3 text-left font-normal [overflow-wrap:anywhere]">{model.model}</th>
            <td className="pr-3 tabular-nums">{count(model.tokens)} tok</td>
            <td className="pr-3 tabular-nums">{dollars(model.usd)}</td>
            <td className="tabular-nums">{count(model.sessions)}×</td>
          </tr>)}</tbody>
        </table> : null}
        {/* The trend, and nothing more than the daily sums the log supports. */}
        {spend.by_day.length > 1 ? <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">By day</p>
          <div className="flex h-12 items-end gap-0.5" role="img" aria-label={`Tokens by day: ${spend.by_day.map((day) => `${day.day} ${count(day.tokens)}`).join(", ")}`}>
            {spend.by_day.map((day) => <div key={day.day} className="bg-chart-1 min-h-px w-full rounded-sm" style={{ height: `${(day.tokens / peak) * 100}%` }} />)}
          </div>
          <p className="text-muted-foreground text-xs tabular-nums">{spend.by_day[0]!.day} → {spend.by_day.at(-1)!.day}</p>
        </div> : null}
        <p className="text-muted-foreground text-xs">{basis.dollars}</p>
        <p className="text-muted-foreground text-xs">{basis.tokens}</p>
        <p className="text-muted-foreground text-xs">{basis.coverage}</p>
      </section>

      {/* Work, plainly. It takes no assignee query, and a link that implied
          one would filter nothing while reading as though it had. Current
          assignments are Work's own reading; this view does not reproduce them. */}
      <Button variant="outline" size="sm" asChild><a href="/work">Open Work</a></Button>
    </div>
  </>
}

function columnsFor(open: (id: string, from?: HTMLElement) => void): RecordColumn<Member>[] {
  return [
    expandColumn<Member>((member) => `Show ${member.name}'s context`),
    {
      id: "member",
      header: () => "Member",
      cell: ({ row }) => {
        const member = row.original
        return <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="link" className="h-auto p-0 text-sm font-medium" onClick={(event) => open(member.id, event.currentTarget)}>{member.name}</Button>
            <StatusBadge status={loopStateRole(member.state)}>{member.state}</StatusBadge>
          </div>
          <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{member.workstream} · {member.runtime} · {member.model}</span>
        </div>
      },
      meta: { className: recordColumn },
    },
    /* The subject of the view, so it is the widest declared column and sits
       inside a 390 window beside the member. */
    { id: "context", header: () => "Context", cell: ({ row }) => <Composition context={row.original.context} />, meta: { className: "w-32" } },
    { id: "memory", header: () => "Memory", cell: ({ row }) => <span className="text-xs tabular-nums">{row.original.context.memory.configured ? `${count(row.original.context.memory.files)} files` : "—"}</span>, meta: { className: "w-24" } },
    { id: "tokens", header: () => "Tokens", cell: ({ row }) => <span className="tabular-nums">{tokens(row.original.spend.tokens)}</span>, meta: { className: "w-24 text-right tabular-nums" } },
    { id: "cost", header: () => "Notional", cell: ({ row }) => <span className="tabular-nums">{dollars(row.original.spend.usd)}</span>, meta: { className: "w-24 text-right tabular-nums" } },
  ]
}

export function TeamView({ data, period, onPeriodChange }: { data: TeamData; period: string; onPeriodChange: (period: string) => void }) {
  const [expanded, setExpanded] = React.useState<ExpandedState>({})
  const [openId, setOpenId] = React.useState("")
  /* One Sheet for every row, as Roadmap's is: Radix returns focus to a trigger
     this Sheet does not have, so the opening control is remembered and restored
     through the documented onCloseAutoFocus. */
  const opener = React.useRef<HTMLElement | null>(null)
  const openRecord = React.useCallback((id: string, from?: HTMLElement) => { opener.current = from ?? null; setOpenId(id) }, [])
  const columns = React.useMemo(() => columnsFor(openRecord), [openRecord])
  const open = data.loops.find((member) => member.id === openId)
  const over = data.loops.flatMap((member) => [
    ...(member.context.composed.profile ? [member.context.composed.profile] : []),
    ...member.context.composed.skills, ...member.context.discovered.files,
  ]).filter((file) => file.state === "over" || file.state === "unreadable")

  return <>
    {over.length ? <StatusAlert status={over.some((file) => file.state === "unreadable") ? "failure" : "attention"}>
      <AlertTitle>{over.length} configured {over.length === 1 ? "file needs" : "files need"} your attention</AlertTitle>
      <AlertDescription>{over.map((file) => `${file.name} (${file.state === "unreadable" ? "cannot be read" : `${count(file.tokens)} over a cap of ${count(file.cap!)}`})`).join("; ")}</AlertDescription>
    </StatusAlert> : null}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground text-sm">{data.loops.length} configured {data.loops.length === 1 ? "member" : "members"}</p>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Usage period">
        {data.periods.map((option) => <Button
          key={option}
          size="sm"
          variant={option === period ? "default" : "outline"}
          aria-pressed={option === period}
          onClick={() => onPeriodChange(option)}
        >{PERIOD_LABEL[option] ?? option}</Button>)}
      </div>
    </div>

    <RecordTable<Member>
      label="Team"
      /* The five fixed columns above (44 + 128 + 96 + 96 + 96) plus a 160px
         member floor. The floor is what decides where the fold falls at 390:
         the member and its configured context are the two columns that have to
         be readable without scrolling, and 44 + 160 + 128 keeps both inside the
         window with room to spare. Memory, tokens and notional spend are what
         the region's label offers to scroll for. */
      minWidth="min-w-[620px]"
      columns={columns}
      rows={data.loops}
      rowId={(member) => member.id}
      expanded={expanded}
      onExpandedChange={setExpanded}
      empty="No team members are configured."
      renderExpanded={(member) => <div className="flex flex-col items-start gap-2">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {parts(member.context).map((part) => <li key={part.key} className="flex items-center gap-1.5">
            <span className={`${part.fill} size-2 rounded-full`} aria-hidden="true" />
            <span>{part.label} {count(part.tokens)}</span>
          </li>)}
          <li className="text-muted-foreground">{member.context.memory.configured ? `${count(member.context.memory.files)} memory files available, not loaded` : "no memory directory configured"}</li>
        </ul>
        <Button variant="outline" size="sm" onClick={(event) => openRecord(member.id, event.currentTarget)}>
          Open {member.name} — files, caps and usage
        </Button>
      </div>}
    />

    <p className="text-muted-foreground text-xs">
      Configured context is what a session is set up to load, not an observed live window; token figures are measured
      with {data.tokenizer} and exclude what no one here can count. {data.basis.dollars} {data.basis.coverage}
    </p>

    <Sheet open={!!open} onOpenChange={(next) => { if (!next) setOpenId("") }}>
      <SheetContent
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus() } }}
      >
        {open ? <MemberRecord member={open} basis={data.basis} />
          : <SheetHeader><SheetTitle>No member</SheetTitle></SheetHeader>}
      </SheetContent>
    </Sheet>
  </>
}
