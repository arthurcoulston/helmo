import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Reading = { count: number; per_million_tokens: number | null; evidence: string[]; coverage: "measured" | "missing" }
type Bucket = { from: string; to: string; tokens: number; token_coverage: "measured" | "missing"; token_evidence: string[]; acceptance_failures: Reading; test_failures: Reading & { measured_tests: number }; incidents: Reading }
export type HistoryData = { as_of: string; period: "day" | "week" | "month"; actor: string | null; actors: string[]; buckets: Bucket[] }

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })
const href = (ref: string) => /^H-\d+$/.test(ref) ? `/work#${ref}` : /^https?:/.test(ref) ? ref : null
function Evidence({ refs }: { refs: string[] }) {
  if (!refs.length) return <span className="text-muted-foreground text-xs">No events in this interval</span>
  return <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm">{refs.length} source event{refs.length === 1 ? "" : "s"}</Button></CollapsibleTrigger><CollapsibleContent><ul className="space-y-1 text-xs [overflow-wrap:anywhere]">{refs.map((ref, index) => <li key={`${ref}-${index}`}>{href(ref) ? <a className="underline underline-offset-2" href={href(ref)!}>{ref}</a> : <span className="font-mono">{ref}</span>}</li>)}</ul></CollapsibleContent></Collapsible>
}
function ReadingCell({ reading, tests }: { reading: Reading; tests?: number }) {
  if (reading.coverage === "missing") return <div><Badge variant="outline">Coverage missing</Badge><p className="text-muted-foreground text-xs">No zero is claimed.</p></div>
  const rate = tests !== undefined ? (tests > 0 ? `${number(reading.count / tests * 100)}% of ${number(tests)} tests` : "No measured test denominator") : (reading.per_million_tokens === null ? "No measured token denominator" : `${number(reading.per_million_tokens)} / 1M tokens`)
  return <div className="min-w-32"><p className="font-medium tabular-nums">{number(reading.count)}</p><p className="text-muted-foreground text-xs">{rate}</p><Evidence refs={reading.evidence} /></div>
}
const queryHref = (period: string, actor: string | null) => `/history?${new URLSearchParams({ period, ...(actor ? { actor } : {}) })}`
export function HistoryView({ data }: { data: HistoryData }) {
  return <div className="flex min-w-0 flex-col gap-4">
    <Card><CardHeader><CardTitle className="text-base">Measured change over time</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">Acceptance failures, recorded validation failures and incident identifications stay separate. Rates appear only where their denominator was measured.</p>
      <div className="flex flex-wrap gap-2" aria-label="History period">{(["day", "week", "month"] as const).map((period) => <Button key={period} variant={data.period === period ? "default" : "outline"} size="sm" asChild><a href={queryHref(period, data.actor)}>{period[0]!.toUpperCase() + period.slice(1)}</a></Button>)}</div>
      <div className="flex flex-wrap gap-2" aria-label="History actor"><Button variant={data.actor ? "outline" : "default"} size="sm" asChild><a href={queryHref(data.period, null)}>Whole team</a></Button>{data.actors.map((actor) => <Button key={actor} variant={data.actor === actor ? "default" : "outline"} size="sm" asChild><a href={queryHref(data.period, actor)}>{actor}</a></Button>)}</div>
    </CardContent></Card>
    <div className="overflow-x-auto rounded-md border" role="region" aria-label="Failure history"><Table tabIndex={0} aria-label="Failure history" data-above-fold="interval"><TableHeader><TableRow><TableHead data-column="interval">Interval</TableHead><TableHead data-column="tokens">Measured tokens</TableHead><TableHead data-column="acceptance">Acceptance failures</TableHead><TableHead data-column="tests">Recorded test failures</TableHead><TableHead data-column="incidents">Incidents</TableHead></TableRow></TableHeader><TableBody>{data.buckets.map((bucket) => <TableRow key={bucket.from}><TableCell data-column="interval" className="whitespace-normal"><span className="block font-medium">{new Date(bucket.from).toLocaleString()}</span><span className="text-muted-foreground text-xs">to {new Date(bucket.to).toLocaleString()}</span></TableCell><TableCell data-column="tokens" className="whitespace-normal">{bucket.token_coverage === "missing" ? <Badge variant="outline">Coverage missing</Badge> : <><p className="font-medium tabular-nums">{number(bucket.tokens)}</p><Evidence refs={bucket.token_evidence} /></>}</TableCell><TableCell data-column="acceptance" className="whitespace-normal"><ReadingCell reading={bucket.acceptance_failures} /></TableCell><TableCell data-column="tests" className="whitespace-normal"><ReadingCell reading={bucket.test_failures} tests={bucket.test_failures.measured_tests} /></TableCell><TableCell data-column="incidents" className="whitespace-normal"><ReadingCell reading={bucket.incidents} /></TableCell></TableRow>)}</TableBody></Table></div>
    <p className="text-muted-foreground text-xs">Window fixed at {new Date(data.as_of).toLocaleString()}. Only Helmo event-log inputs with supported writers are covered; unrecorded suites and installations are not inferred.</p>
  </div>
}
