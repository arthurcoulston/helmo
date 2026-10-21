import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { projectHealthRole, StatusBadge } from "./Status"
import { time } from "./RecordTable"

export type RoadmapNowData = {
  as_of: string
  counts: { Active: number; Planned: number; Proposed: number }
  attention: { id: string; title: string; health: string; reason: string | null }[]
  health_unrecorded: number
}

export function roadmapNowOf(data: unknown): RoadmapNowData | null {
  const value = (data as { roadmap_now?: RoadmapNowData } | null)?.roadmap_now
  return value && typeof value.as_of === "string" && value.counts
    && Array.isArray(value.attention) ? value : null
}

export function RoadmapNow({ data }: { data: RoadmapNowData }) {
  return <Card aria-label="Roadmap now">
    <CardHeader>
      <CardTitle>Roadmap now</CardTitle>
      <p className="text-muted-foreground text-xs">
        Read at <time dateTime={data.as_of}>{time(data.as_of)}</time> · Hidden initiatives excluded
      </p>
    </CardHeader>
    <CardContent className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-3 gap-3">
        {(["Active", "Planned", "Proposed"] as const).map((status) => <div key={status}>
          <dt className="text-muted-foreground text-xs">{status}</dt>
          <dd className="text-xl font-semibold tabular-nums">{data.counts[status]}</dd>
        </div>)}
      </dl>
      {data.attention.length ? <ul className="flex flex-col gap-3">
        {data.attention.map((project) => <li key={project.id} className="flex flex-col gap-1 [overflow-wrap:anywhere]">
          <div className="flex flex-wrap items-center gap-2">
            <a className="font-medium underline-offset-4 hover:underline" href={`/roadmap#${project.id}`}>{project.id} · {project.title}</a>
            <StatusBadge variant="outline" status={projectHealthRole(project.health)}>{project.health}</StatusBadge>
          </div>
          <p>{project.reason || "No reason recorded."}</p>
        </li>)}
      </ul> : <p className="text-muted-foreground">No At risk or Off track health recorded.</p>}
      {data.health_unrecorded > 0 ? <p className="text-muted-foreground text-xs">
        Health not recorded for {data.health_unrecorded} visible {data.health_unrecorded === 1 ? "initiative" : "initiatives"}.
      </p> : null}
    </CardContent>
    <CardFooter><Button asChild variant="outline" size="sm"><a href="/roadmap">Open Roadmap</a></Button></CardFooter>
  </Card>
}
