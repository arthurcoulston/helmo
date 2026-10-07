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
   renamed heading must not move the measurement. */
const COLUMNS = [
  ["loop", "Loop"], ["state", "State"], ["workstream", "Workstream"],
  ["model", "Runtime / model"], ["pace", "Pace"], ["spend", "Spend"], ["trace", "Recent trace"],
] as const

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
      {/* Not a `RecordTable`: this one is still upstream's Table under automatic
          layout, so its widths come from its content rather than a declaration.
          Where its fold falls is measurable all the same, and it carries the
          same `data-column`/`data-above-fold` contract the three compact views
          do — the loop and its state are what a 390 window has to read, and
          `verify:ui` fails naming either one the fold cuts. Measured on the
          live roster at 390: loop ends at x61 and state at x151 inside a 356px
          container, with workstream clearing it too. Before H-3001@dev.rev this
          table was in no fold measurement at all. */}
      <Table tabIndex={0} aria-label="Loop status" data-above-fold="loop state">
        <TableCaption className="sr-only">Current loop status, runtime, spend and recent events</TableCaption>
        <TableHeader><TableRow>
          {COLUMNS.map(([id, label]) => <TableHead key={id} data-column={id}>{label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>
          {data.loops.map((loop) => <TableRow key={loop.name}>
            <TableCell data-column="loop" className="align-top font-medium">{loop.name}</TableCell>
            <TableCell data-column="state" className="align-top">
              <StatusBadge variant="outline" status={loopStateRole(loop.state)}>{loop.state}</StatusBadge>
              {loop.reason ? <p className="mt-2 max-w-64 whitespace-normal text-xs [overflow-wrap:anywhere]">{loop.reason}</p> : null}
            </TableCell>
            <TableCell data-column="workstream" className="align-top">{loop.workstream}</TableCell>
            <TableCell data-column="model" className="align-top">{loop.runtime} / {loop.model}</TableCell>
            <TableCell data-column="pace" className="align-top">{loop.pace}</TableCell>
            <TableCell data-column="spend" className="align-top">{loop.spend.tokens ? `${(loop.spend.tokens / 1000).toFixed(1)}k tokens` : "—"}{loop.spend.cost ? ` · $${loop.spend.cost.toFixed(2)}` : ""}</TableCell>
            <TableCell data-column="trace" className="align-top">
              {loop.recent_events.length ? <Collapsible>
                <CollapsibleTrigger asChild><Button variant="outline" size="sm">Recent events for {loop.name}</Button></CollapsibleTrigger>
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
