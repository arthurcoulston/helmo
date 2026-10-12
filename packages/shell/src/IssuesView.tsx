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
    <Table><TableHeader><TableRow><TableHead>Issue</TableHead><TableHead>Owner</TableHead><TableHead>Observed</TableHead><TableHead>Next action</TableHead><TableHead>Disposition</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={row.key}>
        <TableCell className="min-w-64"><a className="font-medium underline-offset-2 hover:underline" href={row.incident_id ? `/incidents/${row.incident_id}` : row.subject_kind === "ticket" ? `/work#${row.subject_ref}` : "/work"}>{row.check} · {row.subject_ref}</a>{value({ value: row.detail, label: String })}</TableCell>
        <TableCell>{value({ value: row.disposition.owner, label: (v) => v ?? "Unassigned" })}</TableCell>
        <TableCell className="whitespace-nowrap">{new Date(row.first_observed_at).toLocaleString()}<span className="block text-xs text-muted-foreground">latest {new Date(row.latest_observed_at).toLocaleString()} · {row.observation_count} observation{row.observation_count === 1 ? "" : "s"}</span></TableCell>
        <TableCell>{row.disposition.next_action ? value({ value: row.disposition.next_action, label: String }) : "—"}</TableCell>
        <TableCell><Badge variant="secondary">{row.disposition.state}</Badge>{row.recurrence_count ? <span className="block text-xs text-muted-foreground">{row.recurrence_count} recurrence</span> : null}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>
}

export function IssuesView({ data }: { data: IssuesData }) {
  return <div className="flex flex-col gap-4"><p className="text-sm text-muted-foreground">Checks at {new Date(data.as_of).toLocaleString()} · coverage {data.coverage.state} from {data.coverage.source}</p><section aria-labelledby="active-issues"><h2 id="active-issues" className="mb-2 text-lg font-semibold">Active</h2><IssuesTable rows={data.active} label="Active issues" /></section><section aria-labelledby="issue-history"><h2 id="issue-history" className="mb-2 text-lg font-semibold">History</h2><IssuesTable rows={data.history} label="Issue history" /></section></div>
}

export function IssuesCard({ data }: { data: IssuesData }) {
  const active = data.active.filter((row) => row.disposition.state === "active")
  return <Card aria-label="Issues detected"><CardHeader><CardTitle>Issues detected</CardTitle><p className="text-2xl font-semibold">{active.length}</p></CardHeader><CardContent className="flex flex-col gap-2">{active.slice(0, 5).map((row) => <a key={row.key} className="text-sm underline-offset-2 hover:underline" href={row.incident_id ? `/incidents/${row.incident_id}` : "/issues"}>{row.check} · {row.subject_ref}<span className="block text-xs text-muted-foreground">{row.disposition.owner.state === "known" ? row.disposition.owner.value ?? "Unassigned" : "Unknown owner"} · {row.observation_count} observed</span></a>)}{!active.length ? <p className="text-sm text-muted-foreground">No issues were detected by the checks run at {new Date(data.as_of).toLocaleString()}.</p> : null}<a className="text-sm font-medium underline-offset-2 hover:underline" href="/issues">Open issues</a></CardContent></Card>
}
