/* What happens next — the work the team will do without Arthur, and roughly how
   long it can keep going (R-43, H-3089). The second of his selected widgets.

   The question is "what will happen next without my intervention?", and the
   whole risk in answering it is sounding more certain than the record allows.
   So the headline distinguishes three readings that a single number would
   collapse:

   - **About N hours** — everything admitted was measurable, so this is the
     whole queue.
   - **At least N hours** — part of it was not, and this is the floor. Said in
     those words, with the count of unmeasured items beside it, because a floor
     presented as a total is the one way this card could mislead him into not
     checking in.
   - **Hours unavailable** — nothing could be measured at all, and the card says
     what is missing rather than drawing a zero.

   Everything that justifies the number — the exclusions, the unmeasured items,
   the sample basis, which seats were counted — is behind one disclosure. The
   glance view is the range, three named outcomes, and the first thing that
   needs him.

   Colour is the restraint UI.md states: queued work, a deliberate hold and a
   date gate are the system working and stay neutral. The two readings that are
   about Arthur carry a role — the step he keeps, and a team with nothing left
   to do. */
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { StatusAlert, StatusBadge } from "./Status"
import { time } from "./RecordTable"

type Span = { low: number; high: number }
type Outcome = { id: string; title: string; owner: string; finishes_after: Span | null }
type Boundary = { id: string; title: string; after: Span | null; reason: string }
type Unknown = { id: string; title: string; owner: string; reason: string }
type Excluded = { id: string; title: string; reason: string; detail: string }

export type RunwayData = {
  as_of: string
  unavailable: string | null
  range: Span | null
  floor: Span | null
  outcomes: Outcome[]
  first_human_boundary: Boundary | null
  unknown_duration: Unknown[]
  excluded: Excluded[]
  coverage: {
    window_days: number
    samples: number
    samples_by_type: Record<string, number>
    estimated: Record<string, number>
    seats: { available: string[]; unavailable: { agent: string; state: string }[] }
    limitations: string[]
  }
}

export function runwayOf(data: unknown): RunwayData | null {
  const value = (data as { next?: RunwayData } | null)?.next
  return value && Array.isArray(value.outcomes) && typeof value.as_of === "string" ? value : null
}

/* Hours under one are read in minutes. "About 0.1–1.5 hours" is the arithmetic
   showing through; a reader wants to know whether to come back after a coffee
   or after lunch. The unit is chosen from the top of the range so the two ends
   are never in different units. */
function span(value: Span): string {
  const unit = (n: number) => (value.high < 1 ? `${Math.round(n * 60)}` : `${n % 1 === 0 ? n : n.toFixed(1)}`)
  const word = value.high < 1 ? "minutes" : "hours"
  return value.low === value.high ? `${unit(value.low)} ${word}` : `${unit(value.low)}–${unit(value.high)} ${word}`
}

/* The exclusions in Arthur's terms. A reason this map does not hold is shown as
   itself rather than dropped, the same call the other cards make for a server
   newer than this build. */
const WHY: Record<string, string> = {
  missing_human_input: "Waiting on you",
  hold: "Deliberately held",
  date_gate: "Gated until a date",
  finite_limit: "Budget spent",
  unavailable_seat: "No seat can work it",
  unreadable_seat: "Seat state unreadable",
}

/** The whole basis for the number, in one place: what was left out and why,
 *  what could not be measured, where the hours came from, and which seats were
 *  counted as able to continue.
 *
 *  Exported apart from the card for the reason `TeamNowSessions` is: a closed
 *  `Collapsible` renders none of its content, so a server-rendered proof of the
 *  card cannot see this at all. The browser run opens the control; the unit
 *  proof renders this directly. */
export function RunwayBasis({ data }: { data: RunwayData }) {
  const { coverage } = data
  const counted = coverage.seats.available
  return <div className="flex flex-col gap-3 pt-3 text-xs">
    <p className="text-muted-foreground">
      {/* Said before the lists, because it is the sentence that makes the whole
          card honest: these hours describe comparable past work, not this work,
          and nobody estimated any of these tickets. */}
      Hours are the middle half (25th to 75th percentile) of recorded
      claim-to-close times on comparable closed work from the last{" "}
      {coverage.window_days} days — {coverage.samples} records. A range is an
      estimate, never a guarantee.
    </p>
    {data.unknown_duration.length ? <div className="flex flex-col gap-1">
      <p className="font-medium">Not counted in the hours</p>
      {data.unknown_duration.map((item) => <p key={item.id} className="[overflow-wrap:anywhere]">
        <a className="font-mono underline-offset-4 hover:underline" href={`/#${item.id}`}>{item.id}</a>
        {` ${item.title} · ${item.reason}`}
      </p>)}
    </div> : null}
    {data.excluded.length ? <div className="flex flex-col gap-1">
      <p className="font-medium">Not runway at all</p>
      {data.excluded.map((item) => <p key={item.id} className="[overflow-wrap:anywhere]">
        <a className="font-mono underline-offset-4 hover:underline" href={`/#${item.id}`}>{item.id}</a>
        {` ${item.title} · ${WHY[item.reason] ?? item.reason}`}
        {item.detail ? `: ${item.detail}` : ""}
      </p>)}
    </div> : null}
    <div className="flex flex-col gap-1">
      <p className="font-medium">Seats counted as able to continue</p>
      <p className="[overflow-wrap:anywhere]">{counted.length ? counted.join(", ") : "none"}</p>
      {coverage.seats.unavailable.length ? <p className="text-muted-foreground [overflow-wrap:anywhere]">
        Not counted: {coverage.seats.unavailable.map((s) => `${s.agent} (${s.state})`).join(", ")}
      </p> : null}
    </div>
    <div className="flex flex-col gap-1">
      <p className="font-medium">What this forecast does not model</p>
      {coverage.limitations.map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
    </div>
  </div>
}

/** The headline. Three readings, never one number standing for all three. */
function Headline({ data }: { data: RunwayData }) {
  const unmeasured = data.unknown_duration.length
  if (data.range) return <p className="text-2xl font-semibold tracking-tight">About {span(data.range)}</p>
  if (data.floor) return <div className="flex flex-col gap-1">
    <p className="text-2xl font-semibold tracking-tight">At least {span(data.floor)}</p>
    <p className="text-muted-foreground text-xs">
      The floor, not the total: {unmeasured === 1 ? "one item" : `${unmeasured} items`} could not be
      measured. The team may continue longer.
    </p>
  </div>
  return <div className="flex flex-col gap-1">
    <p className="text-2xl font-semibold tracking-tight">Hours unavailable</p>
    <p className="text-muted-foreground text-xs">
      {unmeasured
        ? `Nothing the team can start could be measured: ${data.unknown_duration[0]!.reason.toLowerCase()}.`
        : "There is no work the team can start without you."}
    </p>
  </div>
}

/* How many named outcomes the glance view carries. Three keeps the card inside
   its footprint and is as far ahead as a forecast built on a median is worth
   reading; the rest are a count, and Work is one click away. */
const SHOWN = 3

export function Runway({ data }: { data: RunwayData }) {
  const shown = data.outcomes.slice(0, SHOWN)
  const stalled = !data.outcomes.length && data.excluded.some((x) => x.reason === "missing_human_input")
  return <Card aria-label="What happens next">
    <CardHeader>
      <CardTitle>What happens next</CardTitle>
      {/* The instant the forecast was taken, like Team now's. A card held over
          from a failed refresh describes a queue that has since moved, and only
          this line says which queue it was. */}
      <p className="text-muted-foreground text-xs">
        Forecast at <time dateTime={data.as_of}>{time(data.as_of)}</time> · without your intervention
      </p>
    </CardHeader>
    <CardContent className="flex flex-col gap-3 text-sm">
      {data.unavailable
        /* Red, like Team now's unreadable roster and for the same reason: a
           dashboard that cannot say whether the team can continue is the fleet
           unobservable, which is what these widgets exist to prevent. */
        ? <StatusAlert status="failure">
            <AlertTitle>No forecast could be taken</AlertTitle>
            <AlertDescription>{data.unavailable}</AlertDescription>
          </StatusAlert>
        : <>
            <Headline data={data} />
            {stalled
              /* The one reading that is about him: every piece of startable
                 work is waiting on something only he can give. */
              ? <StatusAlert status="attention">
                  <AlertTitle>The team has run out of work it can do alone</AlertTitle>
                  <AlertDescription>
                    {data.excluded.filter((x) => x.reason === "missing_human_input").length} items are waiting on you.
                  </AlertDescription>
                </StatusAlert>
              : null}
            {shown.length ? <ol className="flex flex-col gap-1">
              {shown.map((outcome) => <li key={outcome.id} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <a className="font-mono text-xs underline-offset-4 hover:underline" href={`/#${outcome.id}`}>{outcome.id}</a>
                <span className="[overflow-wrap:anywhere] min-w-0 flex-1">{outcome.title}</span>
                <span className="text-muted-foreground text-xs">{outcome.owner}</span>
                {/* An outcome nobody can time is still an outcome, and says so
                    rather than borrowing the row above's hours. */}
                <span className="text-muted-foreground text-xs tabular-nums">
                  {outcome.finishes_after ? `by ${span(outcome.finishes_after)}` : "timing unknown"}
                </span>
              </li>)}
              {data.outcomes.length > SHOWN ? <li className="text-muted-foreground text-xs">
                +{data.outcomes.length - SHOWN} more in the forecast
              </li> : null}
            </ol> : null}
            {data.first_human_boundary ? <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
              <StatusBadge variant="outline" status="attention">Needs you</StatusBadge>
              <a className="font-mono underline-offset-4 hover:underline" href={`/#${data.first_human_boundary.id}`}>
                {data.first_human_boundary.id}
              </a>
              <span className="[overflow-wrap:anywhere]">
                {data.first_human_boundary.reason}
                {data.first_human_boundary.after ? `, about ${span(data.first_human_boundary.after)} in` : ", timing unknown"}
              </span>
            </p> : null}
          </>}
    </CardContent>
    {data.unavailable ? null : <CardFooter>
      <Collapsible>
        <CollapsibleTrigger asChild><Button variant="outline" size="sm">How this was estimated</Button></CollapsibleTrigger>
        <CollapsibleContent><RunwayBasis data={data} /></CollapsibleContent>
      </Collapsible>
    </CardFooter>}
  </Card>
}
