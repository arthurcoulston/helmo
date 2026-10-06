import * as React from "react"
import { RoadmapView, type RoadmapData } from "./RoadmapView"
import { CopyReference, TicketDetails, WorkRecord, type WorkRecordData } from "./WorkRecord"
import {
  ActivityIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  LayoutDashboardIcon,
  MapIcon,
  SquareArrowOutUpRightIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type Link = { label: string; href: string }
type Record_ = {
  id?: string
  title?: string
  name?: string
  installation?: string
  status?: string
  state?: string
  body?: string
  detail?: string
  links?: Link[]
}

type Destination = {
  id: string
  label: string
  href: string
  icon: LucideIcon
  rendered: boolean
}

/* `rendered` says which areas this application draws. Roadmap and Runtime are
   still served as their own documents by their own handlers until H-2938 and
   H-2939 move them here; the menu links to them so navigation keeps working,
   and leaving them is a full page load out of this application. */
const DESTINATIONS: Destination[] = [
  {
    id: "overview",
    label: "Overview",
    href: "/overview",
    icon: LayoutDashboardIcon,
    rendered: true,
  },
  {
    id: "work",
    label: "Work",
    href: "/work",
    icon: ClipboardListIcon,
    rendered: true,
  },
  {
    id: "roadmap",
    label: "Roadmap",
    href: "/roadmap",
    icon: MapIcon,
    rendered: true,
  },
  { id: "team", label: "Team", href: "/team", icon: UsersIcon, rendered: true },
  {
    id: "runtime",
    label: "Runtime",
    href: "/run",
    icon: ActivityIcon,
    rendered: false,
  },
]

function activeArea(defaultArea: string) {
  const path = window.location.pathname.replace(/\/$/, "") || DESTINATIONS.find((d) => d.id === defaultArea)!.href
  return DESTINATIONS.find((d) => d.rendered && d.href === path) ?? DESTINATIONS[0]
}

/* The API document's payload is a record list under one of several keys, or a
   single record. Every Helmo area answers one of these shapes, and the view
   has never needed to know which. */
function records(data: unknown): Record_[] {
  if (Array.isArray(data)) return data as Record_[]
  if (data && typeof data === "object") {
    for (const key of ["records", "projects", "loops"] as const) {
      const value = (data as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value as Record_[]
    }
    return [data as Record_]
  }
  return []
}

type AreaState =
  | { status: "loading" }
  | { status: "ready"; records: Record_[]; data: unknown; readAt: string; warning?: string }
  | { status: "error"; message: string }

function useFragment() {
  const [id, setId] = React.useState(location.hash.slice(1))
  React.useEffect(() => {
    const changed = () => setId(location.hash.slice(1))
    window.addEventListener("hashchange", changed)
    return () => window.removeEventListener("hashchange", changed)
  }, [])
  return id
}

function useArea(area: string, selected: string): AreaState {
  const [state, setState] = React.useState<AreaState>({ status: "loading" })
  React.useEffect(() => {
    const controller = new AbortController()
    let pending = false
    async function read() {
      if (pending) return
      pending = true
      try {
        const query = new URLSearchParams()
        if (area === "work") {
          if (new URLSearchParams(location.search).get("whole") === "1") query.set("whole", "1")
          if (/^H-\d+$/.test(selected)) query.set("ticket", selected)
        }
        const response = await fetch(`/api/v1/${area}${query.size ? `?${query}` : ""}`, { headers: { accept: "application/json" }, signal: controller.signal })
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        const document_ = await response.json()
        if (document_.api !== "helmo/v1" || document_.area !== area) throw new Error("Unexpected API document")
        if (!controller.signal.aborted) setState({ status: "ready", records: records(document_.data), data: document_.data, readAt: new Date().toLocaleTimeString() })
      } catch (error) {
        if (!controller.signal.aborted) setState((old) => {
          const message = error instanceof Error ? error.message : String(error)
          return old.status === "ready" ? { ...old, warning: message } : { status: "error", message }
        })
      } finally { pending = false }
    }
    void read()
    const timer = window.setInterval(read, 15_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [area, selected])
  return state
}

function RecordCard({ record }: { record: Record_ }) {
  const title = record.title ?? record.name ?? record.installation ?? "Record"
  const state = record.status ?? record.state
  const body = record.body ?? record.detail
  return (
    <Card id={record.id}>
      <CardHeader>
        {record.id ? (
          <div className="font-mono text-xs text-muted-foreground">
            {record.id}
          </div>
        ) : null}
        <CardTitle>{title}</CardTitle>
        {state ? (
          <div>
            <Badge variant="secondary">{state}</Badge>
          </div>
        ) : null}
      </CardHeader>
      {body ? (
        <CardContent className="text-sm text-muted-foreground">
          {body}
        </CardContent>
      ) : null}
      {record.links?.length ? (
        <CardFooter className="flex-wrap gap-2">
          {record.links.map((link) => (
            <Button key={link.href} variant="outline" size="sm" asChild>
              <a href={link.href}>{link.label}</a>
            </Button>
          ))}
        </CardFooter>
      ) : null}
    </Card>
  )
}

/* ---------- Work: the three things that can be awaiting the operator ----------

   A decision, an action and a sitting share a place on the page and nothing
   else. What differs is the RESPONSE, and the response is the whole point:
   a decision comes back as permission, an action comes back as a report that
   something in the world has already changed, and a sitting comes back in the
   sitting itself — so that card carries no control at all. Two controls that
   look alike is exactly how the three got confused (R-42 I13), which is why
   Ratify is the filled button, "I've done it" is an outline, and a sitting has
   neither.

   Everything these cards read is presented by the server (packages/work
   `awaitingDocument`): the option letters, so "b" means one option whether
   Arthur is reading this page or a relayed phone queue, and the fingerprints,
   which are the consent tokens the write routes re-check inside their
   transaction. Nothing here recomputes either. */

type AwaitingOption = { letter: string; label: string; consequence: string }

type AwaitingCommon = {
  id: string
  title: string
  workstream: string
  project: string | null
  blast_radius: string | null
}

type Decision = AwaitingCommon & {
  unreadable?: true
  fingerprint?: string
  question?: string
  recommendation?: string
  situation?: string
  options?: AwaitingOption[]
  if_unanswered?: string
}

type ActionRequest_ = AwaitingCommon & {
  fingerprint: string
  action: string
  why_human: string
  situation: string
  if_unanswered?: string
}

type Sitting = AwaitingCommon & {
  release: boolean
  sitting: string | null
  sitting_with: string | null
  why_human?: string
  waits_on: string[]
}

type Awaiting = {
  operator: string | null
  token: string
  decisions: Decision[]
  actions: ActionRequest_[]
  sittings: Sitting[]
}

function awaitingOf(data: unknown): Awaiting | null {
  const value = (data as { awaiting?: Awaiting } | null)?.awaiting
  return value && Array.isArray(value.decisions) ? value : null
}

type Recording =
  | { state: "idle" }
  | { state: "busy"; message: string }
  | { state: "done"; message: string }
  | { state: "failed"; message: string }

/** Recording a decision and reporting an action share this choreography and
 *  nothing else: two routes, two payload shapes, two fingerprints. They are
 *  together because the disable-send-reload sequence is identical and a second
 *  copy of it drifts; they stay distinguishable because the caller names the
 *  route and builds the body, and a card that offers one never offers the
 *  other.
 *
 *  The route is relative on purpose: this view is served at `/work` and at
 *  `/work/`, and a relative "answer" resolves correctly under both. */
function useRecording(token: string) {
  const [recording, setRecording] = React.useState<Recording>({ state: "idle" })

  const send = async (route: "answer" | "acted", body: object) => {
    const acting = route === "acted"
    /* An answer is being recorded; an action already happened somewhere else
       and this only writes it down. The words say which. */
    setRecording({ state: "busy", message: acting ? "noting it…" : "recording…" })
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-helmo-answer": token,
        },
        body: JSON.stringify(body),
      })
      const out = (await response.json()) as { error?: string }
      if (!response.ok) {
        throw new Error(out.error ?? (acting ? "report failed" : "answer failed"))
      }
      setRecording({ state: "done", message: acting ? "noted ✓" : "recorded ✓" })
      setTimeout(() => location.reload(), 400)
    } catch (error) {
      setRecording({
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /* Sending and sent both hold the controls shut. Re-enabling on success would
     offer a second click in the gap before the reload, against a fingerprint
     the first click has already spent. */
  const shut = recording.state === "busy" || recording.state === "done"
  return { recording, send, shut }
}

function RecordingStatus({ recording }: { recording: Recording }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={
        recording.state === "failed"
          ? "text-xs text-destructive"
          : "text-muted-foreground text-xs"
      }
    >
      {recording.state === "idle" ? "" : recording.message}
    </span>
  )
}

/** Each card names its own kind, in the same place, in words. The reader
 *  settles "what is being asked of me" from the chip, not from the control. */
function KindChip({ children }: { children: React.ReactNode }) {
  return <Badge variant="outline">{children}</Badge>
}

function RequestMeta({ request }: { request: AwaitingCommon }) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <a className="font-mono" href={`#${request.id}`}>{request.id}</a>
      <CopyReference value={request.id} />
      <span>{request.workstream}</span>
      {request.project ? <span>{request.project}</span> : null}
      {/* "none" is the default and saying it on every card is noise: the
          badge exists to mark work that reaches further than nowhere. */}
      {request.blast_radius && request.blast_radius !== "none" ? (
        <span>reaches: {request.blast_radius}</span>
      ) : null}
    </div>
  )
}

/** The one line a reader needs, labelled with what kind of line it is. */
function AskLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-sm">
      <span className="text-muted-foreground mr-2 text-xs font-medium tracking-wide uppercase">
        {label}
      </span>
      {children}
    </p>
  )
}

/** The supporting situation stays one disclosure below the decision (H-974):
 *  what is being asked comes first, why it is being asked is available. */
function Context({ situation }: { situation: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group -ml-2">
          <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" />
          Context
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="text-muted-foreground pt-2 text-sm">
        {situation}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Silence({ line }: { line?: string }) {
  if (!line) return null
  return (
    <p className="text-muted-foreground text-xs">⏱ If unanswered: {line}</p>
  )
}

/** Awaiting the operator with neither a decision nor an action on it.
 *
 *  Nothing legal writes this — but an imported row carries its status straight
 *  into the tickets table with no request, and a renderer that assumes a
 *  question drew NOTHING for it while still counting it in "awaits you". That
 *  is the one failure the operator can neither see nor recover from, so it
 *  gets a card that says what is missing. */
function UnreadableCard({ request }: { request: Decision }) {
  return (
    <Card id={request.id}>
      <CardHeader>
        <RequestMeta request={request} />
        <CardTitle className="text-base">{request.title}</CardTitle>
        <div>
          <KindChip>⚠ Request unreadable</KindChip>
        </div>
      </CardHeader>
      <CardContent>
        <AskLine label="Nothing recorded">
          <span className="text-muted-foreground">
            awaiting you, but carrying neither a decision nor an action — the
            ticket's own timeline is where what it asked for survives
          </span>
        </AskLine>
      </CardContent>
    </Card>
  )
}

function DecisionCard({
  request,
  awaiting,
}: {
  request: Decision
  awaiting: Awaiting
}) {
  const { recording, send, shut } = useRecording(awaiting.token)
  if (request.unreadable || !request.fingerprint) {
    return <UnreadableCard request={request} />
  }

  const answer = (body: object) =>
    send("answer", {
      ticket_id: request.id,
      question_fingerprint: request.fingerprint,
      ...body,
    })

  /* Ratifying needs something to ratify. `returnToHuman` always writes a
     recommendation, so a question without one is an imported or damaged row —
     and the write route refuses it. Drawing the button anyway offers a click
     that cannot succeed, which reads as a broken page rather than as a record
     that is missing a field. */
  const ratifiable = Boolean(request.recommendation?.trim())
  const answerable = ratifiable || Boolean(request.options?.length)

  return (
    <Card id={request.id}>
      <CardHeader>
        <RequestMeta request={request} />
        <CardTitle className="text-base">{request.title}</CardTitle>
        <div>
          <KindChip>❓ Decision needed</KindChip>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AskLine label="Issue">{request.question}</AskLine>
        {request.options?.length ? (
          <div className="flex flex-col gap-2">
            {request.options.map((option) => {
              const face = (
                <>
                  <Badge variant="secondary" className="font-mono">
                    {option.letter}
                  </Badge>
                  <span className="font-medium">{option.label}</span>
                  <span className="text-muted-foreground">
                    {option.consequence}
                  </span>
                </>
              )
              /* Every offered choice is an answer surface when an operator is
                 configured, and plain text when one is not. */
              return awaiting.operator ? (
                <Button
                  key={option.letter}
                  type="button"
                  variant="outline"
                  disabled={shut}
                  className="h-auto flex-wrap justify-start gap-2 py-2 text-left whitespace-normal"
                  aria-label={`Choose ${option.letter}: ${option.label} — ${option.consequence}`}
                  onClick={() => answer({ choice: option.letter })}
                >
                  {face}
                </Button>
              ) : (
                <div
                  key={option.letter}
                  className="flex flex-wrap items-center gap-2 py-2 text-sm"
                >
                  {face}
                </div>
              )
            })}
          </div>
        ) : null}
        {ratifiable ? (
          <AskLine label="Recommends">{request.recommendation}</AskLine>
        ) : (
          <AskLine label="Recommends">
            <span className="text-muted-foreground">
              nothing recorded
              {answerable
                ? " — one of the choices above is the only answer this card can give"
                : " — and no choices either, so nothing here can be answered; the ticket's own timeline is where what it asked for survives"}
            </span>
          </AskLine>
        )}
        <Silence line={request.if_unanswered} />
        {request.situation ? <Context situation={request.situation} /> : null}
      </CardContent>
      {/* The footer is where this card says what happened, so it appears
          whenever something on the card can be answered — a choice above
          needs somewhere to report itself just as much as Ratify does. */}
      {awaiting.operator && answerable ? (
        <CardFooter className="flex-wrap items-center gap-3">
          {ratifiable ? (
            <Button
              type="button"
              disabled={shut}
              onClick={() => answer({ ratify: true })}
            >
              Ratify recommendation
            </Button>
          ) : null}
          <RecordingStatus recording={recording} />
        </CardFooter>
      ) : null}
    </Card>
  )
}

/** `why_human` is on the face of this card, not behind the disclosure: it is
 *  the field that stops an action being a decision wearing different paint, so
 *  a reader who doubts which they are looking at can settle it without opening
 *  anything. */
function ActionCard({
  request,
  awaiting,
}: {
  request: ActionRequest_
  awaiting: Awaiting
}) {
  const { recording, send, shut } = useRecording(awaiting.token)

  return (
    <Card id={request.id}>
      <CardHeader>
        <RequestMeta request={request} />
        <CardTitle className="text-base">{request.title}</CardTitle>
        <div>
          <KindChip>🛠 Action for you</KindChip>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AskLine label="You do">{request.action}</AskLine>
        <AskLine label="Your hands because">{request.why_human}</AskLine>
        <Silence line={request.if_unanswered} />
        <Context situation={request.situation} />
      </CardContent>
      {awaiting.operator ? (
        <CardFooter className="flex-wrap items-center gap-3">
          {/* An outline, deliberately not the filled Ratify button: reporting
              an action is not granting permission. */}
          <Button
            type="button"
            variant="outline"
            disabled={shut}
            onClick={() =>
              send("acted", {
                ticket_id: request.id,
                done: true,
                action_fingerprint: request.fingerprint,
              })
            }
          >
            I’ve done it
          </Button>
          <RecordingStatus recording={recording} />
        </CardFooter>
      ) : null}
    </Card>
  )
}

/** A sitting carries NO control, and that is the design rather than an
 *  omission: the response to a sitting happens in the sitting, and a button
 *  here would be a way to report one without having had it. There is no form
 *  and no submit on this card, so nothing a keyboard does to it writes. */
function SittingCard({ request }: { request: Sitting }) {
  return (
    <Card id={request.id}>
      <CardHeader>
        <RequestMeta request={request} />
        <CardTitle className="text-base">{request.title}</CardTitle>
        <div className="flex flex-wrap gap-2">
          <KindChip>
            {request.release ? "🚢 Release decision" : "🪑 Needs a sitting"}
            {request.sitting_with ? ` — with ${request.sitting_with}` : ""}
          </KindChip>
          {request.waits_on.length ? (
            <Badge variant="secondary">
              ⛔ waits on {request.waits_on.join(", ")}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <AskLine label="You do, together">
          {request.sitting ?? (
            <span className="text-muted-foreground">
              no line recorded — open the ticket to see what this sitting needs
            </span>
          )}
        </AskLine>
        {request.why_human ? (
          <AskLine label="Your decision because">{request.why_human}</AskLine>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** The hero, in ascending cost to the operator: say a word, do a thing
 *  yourself, sit with an agent. */
function AwaitingYou({ awaiting }: { awaiting: Awaiting }) {
  const count =
    awaiting.decisions.length +
    awaiting.actions.length +
    awaiting.sittings.length

  return (
    <section
      className="flex flex-col gap-3"
      data-helmo-section="awaiting"
      data-count={count}
    >
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Awaiting you
      </h3>
      {count ? (
        <div className="flex flex-col gap-3">
          {awaiting.decisions.map((request) => (
            <div key={request.id} className="flex flex-col gap-1"><DecisionCard request={request} awaiting={awaiting} /><RequestHistory id={request.id} /></div>
          ))}
          {awaiting.actions.map((request) => (
            <div key={request.id} className="flex flex-col gap-1"><ActionCard request={request} awaiting={awaiting} /><RequestHistory id={request.id} /></div>
          ))}
          {awaiting.sittings.map((request) => (
            <div key={request.id} className="flex flex-col gap-1"><SittingCard request={request} /><RequestHistory id={request.id} /></div>
          ))}
        </div>
      ) : (
        <p className="text-sm">✓ Queue is empty. Nothing needs you.</p>
      )}
      {awaiting.operator ? null : (
        <p className="text-muted-foreground text-xs">
          Read-only: no operator is configured, so nothing on this page can be
          answered.
        </p>
      )}
    </section>
  )
}

function RequestHistory({ id }: { id: string }) {
  const [open, setOpen] = React.useState(false)
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger asChild><Button variant="ghost" size="sm">Record and history for {id}</Button></CollapsibleTrigger>
    <CollapsibleContent className="pt-3">{open ? <TicketDetails id={id} /> : null}</CollapsibleContent>
  </Collapsible>
}

function WorkView({ awaiting, record, selected }: { awaiting: Awaiting; record: WorkRecordData; selected: string }) {
  return <>
    <AwaitingYou awaiting={awaiting} />
    <Separator />
    <WorkRecord data={record} selected={selected} />
  </>
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
  )
}

function Loading() {
  return (
    <CardGrid>
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-28 rounded-xl" />
      ))}
    </CardGrid>
  )
}

function AreaView({ area }: { area: Destination }) {
  const selected = useFragment()
  const state = useArea(area.id, selected)

  if (state.status === "loading") {
    return (
      <>
        <Skeleton className="h-4 w-24" />
        <Loading />
      </>
    )
  }

  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not read {area.id}</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    )
  }

  const rows = state.records
  const empty = (
    <p className="text-sm text-muted-foreground">
      No {area.id} records are configured.
    </p>
  )

  if (area.id === "work") {
    const awaiting = awaitingOf(state.data)
    /* The requests are what this area is FOR, so a work document without them
       is an error to say out loud rather than a page to draw half of. */
    if (!awaiting) {
      return (
        <Alert variant="destructive">
          <AlertTitle>Could not read what is awaiting you</AlertTitle>
          <AlertDescription>
            The work document carried no requests. This view needs them
            presented by the server — the option letters and the fingerprints
            are not things a browser may compute.
          </AlertDescription>
        </Alert>
      )
    }
    if (new URLSearchParams(location.search).get("section") === "awaiting") return <AwaitingYou awaiting={awaiting} />
    const record = (state.data as { record?: WorkRecordData }).record
    if (!record) return <Alert variant="destructive"><AlertTitle>Could not read the work record</AlertTitle><AlertDescription>The server returned no record sections.</AlertDescription></Alert>
    return <>
      {state.warning ? <Alert variant="destructive"><AlertTitle>Refresh failed</AlertTitle><AlertDescription>Showing the last good reading from {state.readAt}: {state.warning}</AlertDescription></Alert> : null}
      <WorkView awaiting={awaiting} record={record} selected={selected} />
      <p className="text-muted-foreground text-xs">Refreshed {state.readAt} · updates every 15 seconds</p>
    </>
  }

  if (area.id === "roadmap") return <RoadmapView data={state.data as RoadmapData} selected={selected} />

  if (area.id === "overview") {
    return (
      <>
        <p className="text-sm text-muted-foreground">4 areas</p>
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Areas
          </h3>
          {rows.length ? (
            <CardGrid>
              {rows.slice(0, 4).map((record, index) => (
                <RecordCard key={record.id ?? index} record={record} />
              ))}
            </CardGrid>
          ) : (
            empty
          )}
        </section>
        <Separator />
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Current work
          </h3>
          <p className="text-sm">
            <a className="underline underline-offset-4" href="/work">
              Open Work for decisions, actions, progress and evidence.
            </a>
          </p>
        </section>
      </>
    )
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {rows.length} record{rows.length === 1 ? "" : "s"}
      </p>
      {rows.length ? (
        <CardGrid>
          {rows.map((record, index) => (
            <RecordCard key={record.id ?? record.name ?? index} record={record} />
          ))}
        </CardGrid>
      ) : (
        empty
      )}
    </>
  )
}

/** This page again, in a window of its own.
 *
 *  `window.location.href` and not a rebuilt path, because the context to
 *  preserve is whatever the reader is actually looking at — filters in the
 *  query and the record in the fragment included.
 *
 *  Opened straight from the click, with no `noopener`: the two are same-origin
 *  views of one local dashboard, and a handle back is the only way to tell a
 *  blocked open (null) from a successful one. When it is blocked, the fallback
 *  is a plain link the reader can take themselves — a popup policy that
 *  refuses script-opened windows still honours a click on an anchor. */
function OpenInNewWindow() {
  const [blocked, setBlocked] = React.useState(false)

  const open = () => {
    const opened = window.open(
      window.location.href,
      "_blank",
      "popup=yes,width=1100,height=900"
    )
    setBlocked(!opened)
    opened?.focus()
  }

  return (
    <div className="ml-auto flex items-center gap-2">
      {blocked ? (
        <a
          className="text-xs text-muted-foreground underline underline-offset-2"
          href={window.location.href}
          target="_blank"
          rel="noreferrer"
        >
          Your browser blocked the window — open it here
        </a>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open in new window"
            onClick={open}
          >
            <SquareArrowOutUpRightIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in new window</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function App() {
  const [config, setConfig] = React.useState<{ areas: string[]; defaultArea: string } | null>(null)
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    fetch("/api/v1/ui").then(async (r) => {
      if (!r.ok) throw new Error(`Could not read navigation (${r.status})`)
      return r.json()
    }).then(setConfig).catch((e: Error) => setError(e.message))
  }, [])
  if (error) return <div className="p-4"><Alert variant="destructive"><AlertTitle>Could not open Helmo</AlertTitle><AlertDescription>{error}</AlertDescription></Alert></div>
  if (!config) return <div className="p-4"><Loading /></div>
  const area = activeArea(config.defaultArea)
  if (new URLSearchParams(location.search).get("section") === "awaiting") {
    return <TooltipProvider><main className="p-4"><AreaView area={area} /></main></TooltipProvider>
  }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader className="px-4 py-3 text-sm font-medium">
            Helmo
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {DESTINATIONS.filter((destination) => config.areas.includes(destination.id)).map((destination) => (
                    <SidebarMenuItem key={destination.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={destination.id === area.id}
                      >
                        <a href={destination.href}>
                          <destination.icon />
                          <span>{destination.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          {/* One row: the trigger, this view's title, and the pop-out. The
              menu never gets a row of its own. */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b">
            <div className="flex flex-1 items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-vertical:h-4 data-vertical:self-auto"
              />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{area.label}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <OpenInNewWindow />
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-4 p-4">
            <h2 className="text-lg font-medium">{area.label}</h2>
            <AreaView area={area} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
