import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Recorded<T> = { state: "known"; value: T; source_ref: string; recorded_at: string } | { state: "unknown"; reason: string }
type Issue = { key: string; check: string; subject_kind: string; subject_ref: string; detail: Recorded<string>; first_observed_at: string; latest_observed_at: string; observation_count: number; recurrence_count: number; incident_id?: string; disposition: { state: string; owner: Recorded<string | null>; next_action?: Recorded<string> } }
export type IssuesData = { as_of: string; coverage: { state: string; source: string; last_recorded_at: string | null }; active: Issue[]; history: Issue[] }

// An empty list is two different statements and must not read as one. "The
// checks found nothing at <time>" needs a sweep to have recorded at that time;
// with no sweep on the record the only true thing to say is that nothing has
// been recorded here yet (H-3216).
function emptyClaim(data: IssuesData): string {
  return data.coverage.last_recorded_at
    ? `No issues were detected by the checks recorded at ${new Date(data.coverage.last_recorded_at).toLocaleString()}.`
    : "No check has recorded into this log yet, so nothing here says whether anything is wrong."
}

// Block, not inline: a value butted straight against whatever precedes it read
// as one word — "data-pipeline" followed by its detail rendered
// "data-pipeline1 unassigned open ticket…" (H-3216).
function value<T>({ value: known, label }: { value: Recorded<T>; label: (v: T) => string }) {
  return known.state === "known"
    ? <span className="block">{label(known.value)}<span className="block text-xs text-muted-foreground">{known.source_ref} · {new Date(known.recorded_at).toLocaleString()}</span></span>
    : <span className="block">Unknown<span className="block text-xs text-muted-foreground">{known.reason}</span></span>
}

// Upstream shadcn's TableCell is `whitespace-nowrap`, which is right for the
// short strings a table usually holds and wrong for every cell here: a source
// ref and a check's next action are both long enough to run straight across
// their neighbours in a fixed layout. Real recorded rows made that visible —
// against fixtures the columns had nothing long enough to collide.
const WRAPS = "whitespace-normal break-words [overflow-wrap:anywhere]"

function IssuesTable({ rows, label, empty }: { rows: Issue[]; label: string; empty: string }) {
  if (!rows.length) return <p className="rounded-md border p-4 text-sm text-muted-foreground">{empty}</p>
  return <div className="min-w-0 max-w-full overflow-x-auto rounded-md border" role="region" aria-label={label}>
    <Table tabIndex={0} aria-label={label} data-above-fold="issue" className="table-fixed min-w-[56rem]"><TableHeader><TableRow><TableHead data-column="issue" className="w-44">Issue</TableHead><TableHead data-column="owner" className="w-40">Owner</TableHead><TableHead data-column="observed" className="w-52">Observed</TableHead><TableHead data-column="next-action" className="w-56">Next action</TableHead><TableHead data-column="disposition" className="w-32">Disposition</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={row.key}>
        <TableCell data-column="issue" className={`align-top ${WRAPS}`}><a className="block font-medium underline-offset-2 hover:underline" href={row.incident_id ? `/incidents/${row.incident_id}` : row.subject_kind === "ticket" ? `/work#${row.subject_ref}` : "/work"}>{row.check} · {row.subject_ref}</a>{value({ value: row.detail, label: String })}</TableCell>
        <TableCell data-column="owner" className={`align-top ${WRAPS}`}>{value({ value: row.disposition.owner, label: (v) => v ?? "Unassigned" })}</TableCell>
        <TableCell data-column="observed" className={`align-top ${WRAPS}`}>{new Date(row.first_observed_at).toLocaleString()}<span className="block text-xs text-muted-foreground">latest {new Date(row.latest_observed_at).toLocaleString()} · {row.observation_count} observation{row.observation_count === 1 ? "" : "s"}</span></TableCell>
        <TableCell data-column="next-action" className={`align-top ${WRAPS}`}>{row.disposition.next_action ? value({ value: row.disposition.next_action, label: String }) : "—"}</TableCell>
        <TableCell data-column="disposition" className={`align-top ${WRAPS}`}><Badge variant="secondary">{row.disposition.state}</Badge>{row.recurrence_count ? <span className="block text-xs text-muted-foreground">{row.recurrence_count} recurrence</span> : null}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>
}

export function IssuesView({ data }: { data: IssuesData }) {
  return <div className="flex min-w-0 flex-col gap-4"><p className="text-sm text-muted-foreground">Read at {new Date(data.as_of).toLocaleString()} · checks last recorded {data.coverage.last_recorded_at ? new Date(data.coverage.last_recorded_at).toLocaleString() : "never"} · coverage {data.coverage.state} from {data.coverage.source}</p><section className="min-w-0" aria-labelledby="current-issues"><h2 id="current-issues" className="text-lg font-semibold">Current</h2><p className="mb-2 text-sm text-muted-foreground">Every unresolved issue, and what has been accepted or resolved in the last 30 days. Unresolved issues never age out.</p><IssuesTable rows={data.active} label="Current issues" empty={emptyClaim(data)} /></section><section className="min-w-0" aria-labelledby="issue-history"><h2 id="issue-history" className="text-lg font-semibold">History</h2><p className="mb-2 text-sm text-muted-foreground">Accepted and resolved more than 30 days ago. Kept, not deleted; a fresh observation reopens the same issue as a recurrence.</p><IssuesTable rows={data.history} label="Issue history" empty="No issue has been accepted or resolved here yet." /></section></div>
}

export function IssuesCard({ data }: { data: IssuesData }) {
  const active = data.active.filter((row) => row.disposition.state === "active")
  return <Card aria-label="Issues detected"><CardHeader><CardTitle>Issues detected</CardTitle><p className="text-2xl font-semibold">{active.length}</p></CardHeader><CardContent className="flex flex-col gap-2">{active.slice(0, 5).map((row) => <a key={row.key} className="text-sm underline-offset-2 hover:underline" href={row.incident_id ? `/incidents/${row.incident_id}` : "/issues"}>{row.check} · {row.subject_ref}<span className="block text-xs text-muted-foreground">{row.disposition.owner.state === "known" ? row.disposition.owner.value ?? "Unassigned" : "Unknown owner"} · {row.observation_count} observed</span></a>)}{!active.length ? <p className="text-sm text-muted-foreground">{emptyClaim(data)}</p> : null}<a className="text-sm font-medium underline-offset-2 hover:underline" href="/issues">Open issues</a></CardContent></Card>
}
