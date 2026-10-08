import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { loopStateRole, StatusAlert, StatusBadge, usageSeverityRole } from "./Status"

export type RuntimeData = {
  supervisor: number | null
  supervisor_state: string
  installation: { label: string; home: string; release: string | null; detail: string | null }
  loops: { name: string; state: string; workstream: string; runtime: string; model: string; pace: string; reason?: string; spend: { tokens: number; cost: number }; recent_events: string[] }[]
  reading: { provenance: string; severity: string; usage: { name: string; line: string; severity: string }[] }
  work_link: { local: string; remote: string }
}

/* Each column's name beside its heading, so the two stay together: the heading
   is what a reader sees and the name is what an outside check addresses, and a
   renamed heading must not move the measurement. The geometry each one declares
   is `cell` below, keyed by the same name. */
const COLUMNS = [
  ["loop", "Loop"], ["state", "State"], ["workstream", "Workstream"],
  ["model", "Runtime / model"], ["pace", "Pace"], ["spend", "Spend"], ["trace", "Recent trace"],
] as const

/* What each column declares under the fixed layout below: its width, and
   whether what it holds wraps.

   The widths are measurements of the live roster (H-3048), not estimates — each
   the widest thing the column actually carries plus the cell's 16px of padding:
   loop 45px ("mason"), State's badge 75 ("RUNNING"), workstream 111
   ("knowledge-base"), a current loop's runtime and model 111
   ("claude / claude-fable-5-1"), pace 34 (its own heading), spend's token line
   124, and the trace control 105.

   Trace takes the remainder — `w-full`, which under fixed layout is how one
   column gets what the others leave. Not because it needs the most width at
   rest (its control is the narrowest thing here) but because it is the only
   column that OPENS: the recent-events trace renders inside this cell, and a
   cell under fixed layout cannot grow to hold it the way automatic layout did.
   Measured on ward's live trace: fixed at 144 the longest event wraps to 8
   lines and the row to 649px, where taking the remainder reads at 190 and 5
   lines in a 1280 window — exactly what the page reads like today — and a
   wider window now buys the trace width instead of leaving it pinned. At 390
   the table sits at its floor and the trace is the 144 case, which is the
   narrow-window trade: by then it is behind the horizontal scroll the region's
   label offers. It is still a column rather than the full-width disclosure ROW
   Work's preview reads in — that is a different shape, and this one was already
   cramped at 174px before any of this (H-3048 residual).

   State is 256 for the same reason it used to carry `max-w-64`: that is the
   width a loop's reason was written to read at. Stating it as the column is
   what makes it hold at every window rather than only where there was room.

   Two columns are deliberately sized under their widest row. `page` is parked
   on `claude-haiku-4-5-20251001`, a dated id from before model names were
   short; a column sized for it would cost every row ~60px, so it wraps instead
   — the same call UI.md records for Work's one legacy assignee. "knowledge-base"
   wraps at its hyphen for the same reason. In fact everything that can be long
   wraps rather than widening its column, and that is load-bearing beyond
   taste: `verify:ui`'s spill check reads a cell's ELEMENT children, so a
   `whitespace-nowrap` text node reaching into its neighbour was, until H-3048
   widened it, the one spill nothing could see. It reads geometry now — every
   descendant's right edge against the cell's content box, and the cell's own
   text where it cannot wrap — so these declarations are checked rather than
   merely written down.

   `satisfies` rather than an annotation: each width still reads as its own
   literal, and a column renamed or added to COLUMNS without one of these is a
   type error rather than a cell that silently declares nothing. */
const cell = {
  loop: "w-20 whitespace-normal [overflow-wrap:anywhere]",
  state: "w-64",
  workstream: "w-28 whitespace-normal [overflow-wrap:anywhere]",
  model: "w-36 whitespace-normal [overflow-wrap:anywhere]",
  pace: "w-16 whitespace-normal [overflow-wrap:anywhere]",
  spend: "w-36 whitespace-normal [overflow-wrap:anywhere]",
  trace: "w-full",
} satisfies Record<(typeof COLUMNS)[number][0], string>

/* The table's floor: the fixed columns above (80 + 256 + 112 + 144 + 64 + 144 =
   800) plus the 144 Trace is never squeezed below. Fixed layout never consults
   a cell's own min-width — so a floor stated on the flexible column does
   nothing, and in a table narrower than its fixed siblings `w-full` resolves to
   zero — which is why it lives here, as a literal class Tailwind can generate
   from this source text.

   Where the horizontal fold falls follows from it: at a 390 window the table
   sits at this floor, so State's right edge lands at 336 inside a 356px
   container and both columns this table declares above its fold are read
   without scrolling, clearing it by 20px. Widening a column above without
   raising this moves the fold, and `verify:ui` fails naming the column it
   cuts. */
const FLOOR = "min-w-[944px]"

export function RuntimeView({ data, workAvailable }: { data: RuntimeData; workAvailable: boolean }) {
  return <>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant="secondary">Read-only</Badge>
      {/* The one health reading on this page. A supervisor that is down or
          unobservable is the fleet not working, whichever of the two it is.
          The pid is beside the badge rather than in it: a badge does not wrap,
          and a narrow monitoring window is what this page is read in. */}
      <StatusBadge status={data.supervisor_state === "unknown" ? "attention" : data.supervisor ? "success" : "attention"}>
        Supervisor {data.supervisor_state === "unknown" ? "unobservable" : data.supervisor ? "running" : "down"}
      </StatusBadge>
      {data.supervisor ? <span className="text-muted-foreground text-xs">{data.supervisor_state === "unknown" ? "recorded " : ""}pid {data.supervisor}</span> : null}
      <Badge variant="outline">Installation {data.installation.label}</Badge>
    </div>
    {data.installation.detail ? <StatusAlert status="failure"><AlertTitle>Installation is unclear</AlertTitle><AlertDescription>{data.installation.detail}</AlertDescription></StatusAlert> : null}
    <div className="grid gap-3 md:grid-cols-2">
      {data.reading.usage.map((usage) => <Card key={usage.name}>
        <CardHeader><CardTitle>{usage.name} usage</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
          <p>{usage.line}</p>
          {usage.severity !== "normal" ? <div><StatusBadge variant="outline" status={usageSeverityRole(usage.severity)}>{usage.severity === "unknown" ? "No reading" : usage.severity}</StatusBadge></div> : null}
        </CardContent>
      </Card>)}
    </div>
    <p className="text-muted-foreground text-xs">{data.loops.length} loops · scroll the table horizontally to read every column.</p>
    <div className="min-w-0 rounded-lg border" role="region" aria-label="Loop status — scroll horizontally for all columns">
      {/* Not a `RecordTable` — it has no expanding record and drives no TanStack
          table — but it keeps that module's contract: `data-column`,
          `data-above-fold`, fixed layout and a declared width per column. The
          loop and its state are what a 390 window has to read, and `verify:ui`
          fails naming either one the fold cuts. Before H-3001@dev.rev this
          table was in no fold measurement at all.

          Its widths used to come from its content instead, which is a worse
          thing than it sounds: the automatic minimum of a table 995px wide in a
          992px slot reached out through the scrollable container to
          `SidebarInset`, and the whole page scrolled sideways by 3px at a 1280
          window — a number that grew with the longest loop name, workstream or
          model id in the roster and that nothing in the product bounded. The
          page-overflow assertion that should have caught it was green
          throughout, because `verify:ui` sizes this table from a fixture roster
          narrower than Arthur's (H-3048). Declaring the geometry is what makes
          the fixture's pass a statement about the product.

          Measured, not reasoned: fixed layout plus the floor below removes the
          leak at 390, 640 and 1280 on its own. Containing the intrinsic width
          instead — `container-type: inline-size` on this container, which is
          what actually stops it on the three `RecordTable` views, rather than
          their `overflow-hidden`, which does not — would have hidden the
          content-dependence rather than removed it, and would have left the one
          assertion that found this unable to fire here again. */}
      <Table tabIndex={0} aria-label="Loop status" data-above-fold="loop state" className={`table-fixed ${FLOOR}`}>
        <TableCaption className="sr-only">Current loop status, runtime, spend and recent events</TableCaption>
        <TableHeader><TableRow>
          {COLUMNS.map(([id, label]) => <TableHead key={id} data-column={id} className={cell[id]}>{label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>
          {/* The same `className` on the body cell as on its heading, which is
              `RecordTable`'s pattern: the width is only consulted on the header
              row, but whether a cell wraps has to be stated where the content
              is. `cn` is tailwind-merge, so `whitespace-normal` here replaces
              upstream's `whitespace-nowrap` rather than racing it in the
              stylesheet. */}
          {data.loops.map((loop) => <TableRow key={loop.name}>
            <TableCell data-column="loop" className={`align-top font-medium ${cell.loop}`}>{loop.name}</TableCell>
            <TableCell data-column="state" className={`align-top ${cell.state}`}>
              <StatusBadge variant="outline" status={loopStateRole(loop.state)}>{loop.state}</StatusBadge>
              {/* No `max-w-64`: the column declares the geometry now, and a
                  second bound here would read as the one that mattered. */}
              {loop.reason ? <p className="mt-2 whitespace-normal text-xs [overflow-wrap:anywhere]">{loop.reason}</p> : null}
            </TableCell>
            <TableCell data-column="workstream" className={`align-top ${cell.workstream}`}>{loop.workstream}</TableCell>
            <TableCell data-column="model" className={`align-top ${cell.model}`}>{loop.runtime} / {loop.model}</TableCell>
            <TableCell data-column="pace" className={`align-top ${cell.pace}`}>{loop.pace}</TableCell>
            <TableCell data-column="spend" className={`align-top ${cell.spend}`}>{loop.spend.tokens ? `${(loop.spend.tokens / 1000).toFixed(1)}k tokens` : "—"}{loop.spend.cost ? ` · $${loop.spend.cost.toFixed(2)}` : ""}</TableCell>
            <TableCell data-column="trace" className={`align-top ${cell.trace}`}>
              {loop.recent_events.length ? <Collapsible>
                {/* The loop's name is read out but not drawn: a button labelled
                    "Recent events for knowledge-base-sweeper" would be the one
                    thing in this table still sizing its column from the roster,
                    and this column holds nothing else. Same split as
                    `RecordTable`'s disclosure control. */}
                <CollapsibleTrigger asChild><Button variant="outline" size="sm">Recent events<span className="sr-only"> for {loop.name}</span></Button></CollapsibleTrigger>
                <CollapsibleContent className="flex max-w-lg flex-col gap-2 pt-3">
                  {loop.recent_events.map((event, index) => <p key={index} className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">{event}</p>)}
                </CollapsibleContent>
              </Collapsible> : <span className="text-muted-foreground">No trace yet</span>}
            </TableCell>
          </TableRow>)}
          {!data.loops.length ? <TableRow><TableCell colSpan={7} className="h-24 text-center">No loops in the roster yet.</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </div>
    <div><Button variant="outline" asChild><a href={workAvailable ? "/work" : ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ? data.work_link.local : data.work_link.remote}>Open Work</a></Button></div>
    <Collapsible>
      <CollapsibleTrigger asChild><Button variant="outline" size="sm">Build and installation details</Button></CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-3 text-sm [overflow-wrap:anywhere]">
        {data.reading.severity ? <StatusAlert status="attention"><AlertTitle>Build needs attention</AlertTitle><AlertDescription>{data.reading.provenance}</AlertDescription></StatusAlert> : <p>{data.reading.provenance}</p>}
        <p>Home: {data.installation.home}</p>
        {data.installation.release ? <p>Release: {data.installation.release}</p> : null}
      </CollapsibleContent>
    </Collapsible>
  </>
}
