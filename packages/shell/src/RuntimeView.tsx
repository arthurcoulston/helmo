import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export type RuntimeData = {
  supervisor: number | null
  supervisor_state: string
  installation: { label: string; home: string; release: string | null; detail: string | null }
  loops: { name: string; state: string; workstream: string; runtime: string; model: string; pace: string; reason?: string; spend: { tokens: number; cost: number }; recent_events: string[] }[]
  reading: { provenance: string; severity: string; usage: { name: string; line: string; severity: string }[] }
  work_link: { local: string; remote: string }
}

export function RuntimeView({ data, workAvailable }: { data: RuntimeData; workAvailable: boolean }) {
  return <>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant="secondary">Read-only</Badge>
      <span>Supervisor {data.supervisor_state === "unknown" ? `unobservable (recorded pid ${data.supervisor})` : data.supervisor ? `running (pid ${data.supervisor})` : "down"}</span>
      <Badge variant="outline">Installation {data.installation.label}</Badge>
    </div>
    {data.installation.detail ? <Alert variant="destructive"><AlertTitle>Installation is unclear</AlertTitle><AlertDescription>{data.installation.detail}</AlertDescription></Alert> : null}
    <div className="grid gap-3 md:grid-cols-2">
      {data.reading.usage.map((usage) => <Card key={usage.name}>
        <CardHeader><CardTitle>{usage.name} usage</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
          <p>{usage.line}</p>
          {usage.severity !== "normal" ? <div><Badge variant="outline">{usage.severity === "unknown" ? "No reading" : usage.severity}</Badge></div> : null}
        </CardContent>
      </Card>)}
    </div>
    <p className="text-muted-foreground text-xs">{data.loops.length} loops · scroll the table horizontally to read every column.</p>
    <div className="min-w-0 rounded-lg border" role="region" aria-label="Loop status — scroll horizontally for all columns">
      <Table tabIndex={0} aria-label="Loop status">
        <TableCaption className="sr-only">Current loop status, runtime, spend and recent events</TableCaption>
        <TableHeader><TableRow>
          {['Loop', 'State', 'Workstream', 'Runtime / model', 'Pace', 'Spend', 'Recent trace'].map((label) => <TableHead key={label}>{label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>
          {data.loops.map((loop) => <TableRow key={loop.name}>
            <TableCell className="align-top font-medium">{loop.name}</TableCell>
            <TableCell className="align-top">
              <Badge variant="outline">{loop.state}</Badge>
              {loop.reason ? <p className="mt-2 max-w-64 whitespace-normal text-xs [overflow-wrap:anywhere]">{loop.reason}</p> : null}
            </TableCell>
            <TableCell className="align-top">{loop.workstream}</TableCell>
            <TableCell className="align-top">{loop.runtime} / {loop.model}</TableCell>
            <TableCell className="align-top">{loop.pace}</TableCell>
            <TableCell className="align-top">{loop.spend.tokens ? `${(loop.spend.tokens / 1000).toFixed(1)}k tokens` : "—"}{loop.spend.cost ? ` · $${loop.spend.cost.toFixed(2)}` : ""}</TableCell>
            <TableCell className="align-top">
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
        {data.reading.severity ? <Alert><AlertTitle>Build needs attention</AlertTitle><AlertDescription>{data.reading.provenance}</AlertDescription></Alert> : <p>{data.reading.provenance}</p>}
        <p>Home: {data.installation.home}</p>
        {data.installation.release ? <p>Release: {data.installation.release}</p> : null}
      </CollapsibleContent>
    </Collapsible>
  </>
}
