import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Recorded<T> = { state: "known"; value: T; source_ref: string; recorded_at: string } | { state: "unknown"; reason: string }
type Issue = { key: string; check: string; subject_kind: string; subject_ref: string; detail: Recorded<string>; first_observed_at: string; latest_observed_at: string; observation_count: number; recurrence_count: number; incident_id?: string; disposition: { state: string; owner: Recorded<string | null>; next_action?: Recorded<string> } }
export type IssuesData = { as_of: string; coverage: { state: string; source: string }; active: Issue[]; history: Issue[] }

function value<T>({ value: known, label }: { value: Recorded<T>; label: (v: T) => string }) {
  return known.state === "known"
    ? <span>{label(known.value)} <span className="block text-xs text-muted-foreground">{known.source_ref} · {new Date(known.recorded_at).toLocaleString()}</span></span>
    : <span>Unknown <span className="block text-xs text-muted-foreground">{known.reason}</span></span>
}

function IssuesTable({ rows, label }: { rows: Issue[]; label: string }) {
  if (!rows.length) return <p className="rounded-md border p-4 text-sm text-muted-foreground">No rows.</p>
  return <div className="min-w-0 max-w-full overflow-x-auto rounded-md border" role="region" aria-label={label}>
    <Table tabIndex={0} aria-label={label} data-above-fold="issue" className="table-fixed min-w-[56rem]"><TableHeader><TableRow><TableHead data-column="issue" className="w-44">Issue</TableHead><TableHead data-column="owner" className="w-40">Owner</TableHead><TableHead data-column="observed" className="w-52">Observed</TableHead><TableHead data-column="next-action" className="w-56">Next action</TableHead><TableHead data-column="disposition" className="w-32">Disposition</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={row.key}>
        <TableCell data-column="issue" className="whitespace-normal break-words [overflow-wrap:anywhere]"><a className="font-medium underline-offset-2 hover:underline" href={row.incident_id ? `/incidents/${row.incident_id}` : row.subject_kind === "ticket" ? `/work#${row.subject_ref}` : "/work"}>{row.check} · {row.subject_ref}</a>{value({ value: row.detail, label: String })}</TableCell>
        <TableCell data-column="owner">{value({ value: row.disposition.owner, label: (v) => v ?? "Unassigned" })}</TableCell>
        <TableCell data-column="observed" className="whitespace-nowrap">{new Date(row.first_observed_at).toLocaleString()}<span className="block text-xs text-muted-foreground">latest {new Date(row.latest_observed_at).toLocaleString()} · {row.observation_count} observation{row.observation_count === 1 ? "" : "s"}</span></TableCell>
        <TableCell data-column="next-action">{row.disposition.next_action ? value({ value: row.disposition.next_action, label: String }) : "—"}</TableCell>
        <TableCell data-column="disposition"><Badge variant="secondary">{row.disposition.state}</Badge>{row.recurrence_count ? <span className="block text-xs text-muted-foreground">{row.recurrence_count} recurrence</span> : null}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>
}

export function IssuesView({ data }: { data: IssuesData }) {
  return <div className="flex min-w-0 flex-col gap-4"><p className="text-sm text-muted-foreground">Checks at {new Date(data.as_of).toLocaleString()} · coverage {data.coverage.state} from {data.coverage.source}</p><section className="min-w-0" aria-labelledby="active-issues"><h2 id="active-issues" className="mb-2 text-lg font-semibold">Active</h2><IssuesTable rows={data.active} label="Active issues" /></section><section className="min-w-0" aria-labelledby="issue-history"><h2 id="issue-history" className="mb-2 text-lg font-semibold">History</h2><IssuesTable rows={data.history} label="Issue history" /></section></div>
}

export function IssuesCard({ data }: { data: IssuesData }) {
  const active = data.active.filter((row) => row.disposition.state === "active")
  return <Card aria-label="Issues detected"><CardHeader><CardTitle>Issues detected</CardTitle><p className="text-2xl font-semibold">{active.length}</p></CardHeader><CardContent className="flex flex-col gap-2">{active.slice(0, 5).map((row) => <a key={row.key} className="text-sm underline-offset-2 hover:underline" href={row.incident_id ? `/incidents/${row.incident_id}` : "/issues"}>{row.check} · {row.subject_ref}<span className="block text-xs text-muted-foreground">{row.disposition.owner.state === "known" ? row.disposition.owner.value ?? "Unassigned" : "Unknown owner"} · {row.observation_count} observed</span></a>)}{!active.length ? <p className="text-sm text-muted-foreground">No issues were detected by the checks run at {new Date(data.as_of).toLocaleString()}.</p> : null}<a className="text-sm font-medium underline-offset-2 hover:underline" href="/issues">Open issues</a></CardContent></Card>
}
