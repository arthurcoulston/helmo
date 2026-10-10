/* What got done in the past 24 hours — the first of Arthur's selected Overview
   widgets (R-44, `crew:projects/r39/RECENT-RESULTS-CONTRACT.md`).

   The discipline here is that nothing is inferred. A `done` status is not a
   result, a review link is not a deliverable, and a ticket whose author never
   said what came out of it reads as an account that is MISSING rather than as
   a sentence this card wrote for them. That restraint is the whole widget: a
   list of ten plausible accomplishments the record cannot stand behind is
   worse than five it can.

   The window comes from the server with the rows (`as_of`), so two readers on
   two machines agree about what "the past 24 hours" contained, and a document
   held over from a failed refresh labels the window it actually describes. */
import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { acceptanceRole, StatusBadge } from "./Status"
import { time } from "./RecordTable"
import { Reference } from "./WorkRecord"

/* One recorded result as the server sends it: the item's own kind, ref and
   note, plus whatever the projection knows about how its purpose was decided.
   Copies, not indices — see the note on `ResultRow.results` in
   `work/src/presentation.ts` for why this card is the opposite call to the
   whole-record document. */
type ResultItem = {
  kind: string
  ref: string
  note?: string
  inferred?: true
  corrected?: true
}

type ResultRow = {
  id: string
  title: string
  workstream: string
  project: string | null
  closed_at: string
  summary: string | null
  category: string | null
  category_source: "recorded" | "type" | null
  author: string | null
  recorded_at: string | null
  results: ResultItem[]
  acceptance: { state: string; reason: string }
  blast_radius: string
}

export type RecentResultsData = {
  as_of: string
  window_started_at: string
  total: number
  limit: number
  rows: ResultRow[]
}

export function resultsOf(data: unknown): RecentResultsData | null {
  const value = (data as { results?: RecentResultsData } | null)?.results
  return value && Array.isArray(value.rows) && typeof value.as_of === "string" ? value : null
}

/* The approved display words for each machine category. A value this map does
   not hold is a category the server knows and this build does not, so it is
   shown as itself rather than dropped: an unreadable label is a prompt to
   update the map, where a missing badge is silence. */
const CATEGORY: Record<string, string> = {
  feature: "Feature",
  improvement: "Improvement",
  bug_fix: "Bug fix",
  maintenance: "Maintenance",
  research: "Research",
  planning_design: "Planning / design",
  documentation_content: "Documentation / content",
  operations: "Operations",
  review: "Review",
  incident: "Incident",
}

/* The release review, in the operator's words. Every `pending` reason — a
   missing verdict, a stale one, one the author wrote themselves — reads as
   Awaiting review here: the distinction between them is a reviewer's business
   and the Work record carries it; what this card answers is "has anyone
   independently accepted this yet?" */
const REVIEW: Record<string, string> = {
  not_requested: "Not requested",
  pending: "Awaiting review",
  failed: "Review failed",
  accepted: "Accepted",
}

/* How far the work reached, from `blast_radius` exactly. None of these says a
   service is currently live — that is the runtime's to report, and reading
   "Published" as "up right now" is the mistake this wording avoids. */
const DELIVERY: Record<string, string> = {
  none: "None",
  draft: "Draft",
  records: "Recorded",
  sent: "Sent",
  published: "Published",
}

/* What the work produced. `Reference` is Work's own, so reachability and the
   copy control are one implementation: the result ref on this card opens, or
   says it cannot be opened from this device, by exactly the rule the Work
   record applies. Only the first is offered as an action — a row of identical
   buttons is what made prominence meaningless on the Work record. */
function Result({ results }: { results: ResultItem[] }) {
  if (!results.length) {
    return <p className="text-muted-foreground">No result recorded</p>
  }
  return <div className="flex flex-col gap-1">
    {results.map((item, i) => <Reference key={i} item={item} role={{ at: i, ...(item.inferred ? { inferred: item.inferred } : {}), ...(item.corrected ? { corrected: item.corrected } : {}) }} action={i === 0} />)}
  </div>
}

function Row({ row }: { row: ResultRow }) {
  const category = row.category ? CATEGORY[row.category] ?? row.category : null
  return <div className="flex min-w-0 flex-col gap-1.5">
    <div className="flex flex-wrap items-center gap-2">
      <a className="font-mono text-xs underline-offset-4 hover:underline" href={`/#${row.id}`}>{row.id}</a>
      {category
        ? <Badge variant="secondary">{category}</Badge>
        : <Badge variant="outline">Uncategorised</Badge>}
      {/* A mapped category is this build reading an old ticket's routing noun,
          not a judgment its author made. Saying so is what keeps the two
          kinds of category from reading alike. */}
      {row.category_source === "type" ? <span className="text-muted-foreground text-xs">from its type</span> : null}
      <span className="text-muted-foreground text-xs">
        <time dateTime={row.closed_at}>{time(row.closed_at)}</time>
        {row.author ? ` · ${row.author}` : ""}
      </span>
    </div>
    {row.summary
      ? <p className="break-words [overflow-wrap:anywhere]">{row.summary}</p>
      : <p className="text-muted-foreground">Completion account missing</p>}
    <Result results={row.results} />
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <StatusBadge variant="outline" status={acceptanceRole(row.acceptance.state, row.acceptance.reason)}>
        {REVIEW[row.acceptance.state] ?? row.acceptance.state.replaceAll("_", " ")}
      </StatusBadge>
      <Badge variant="outline">Delivery: {DELIVERY[row.blast_radius] ?? row.blast_radius}</Badge>
    </div>
  </div>
}

export function RecentResults({ data }: { data: RecentResultsData }) {
  const remainder = data.total - data.rows.length
  return <Card aria-label="Results · Past 24 hours">
    <CardHeader>
      <CardTitle>Results · Past 24 hours</CardTitle>
      {/* The instant the rows were selected at, not the instant this drew. A
          card held over from a failed refresh keeps its last good rows and
          this line is what tells the reader which window they describe —
          unknown coverage is never redrawn as zero. */}
      <p className="text-muted-foreground text-xs">
        Completed between <time dateTime={data.window_started_at}>{time(data.window_started_at)}</time> and{" "}
        <time dateTime={data.as_of}>{time(data.as_of)}</time>
      </p>
    </CardHeader>
    <CardContent className="flex flex-col gap-3 text-sm">
      {data.rows.length
        ? data.rows.map((row, i) => <React.Fragment key={row.id}>
            {i ? <Separator /> : null}
            <Row row={row} />
          </React.Fragment>)
        : <p className="text-muted-foreground">No completed work was recorded in the past 24 hours</p>}
    </CardContent>
    {remainder > 0 ? <CardFooter>
      <Button variant="outline" size="sm" asChild>
        <a href="/work">{remainder} more completed result{remainder === 1 ? "" : "s"} in Work</a>
      </Button>
    </CardFooter> : null}
  </Card>
}
