/* Team activity — tokens, completions and requests for Arthur over the past day
   and the past week (R-44, H-3090, `crew:projects/r39/TEAM-ACTIVITY-CONTRACT.md`).
   The third of Arthur's selected Overview widgets.

   Three series that cannot share an axis, so they do not share one. Tokens are
   counted in hundreds of thousands, completions and requests in single figures;
   one axis would draw two of them as a flat line, and a shared relative scale
   would draw a two-ticket hour the same height as a 400,000-token hour. Each
   series is therefore its own small chart with its own scale, under its own
   label, over one shared time axis — and because the scale is per series, the
   period total and the peak bucket are printed beside every one of them. Equal
   heights across two rows mean nothing, and the card says so in words.

   Nothing here is normalized or invented. The server sends raw counts per
   bucket and each chart is given its own axis domain, so the plotted number IS
   the stored one — there is no scaled figure anywhere for a reader to mistake
   for a measurement, and the tooltip, the keyboard reading and the numbers
   table all quote the record. A bucket the record cannot speak for is a GAP
   rather than a bar of height zero: "nobody reported anything" and "this
   installation was not recording yet" are different statements, and the second
   must never be drawn as the first.

   Colour carries nothing. The approved preset's chart ramp is sequential and
   identical in both themes, so it cannot tell three categories apart in either
   one: `--chart-1` is invisible on a light card and `--chart-5` on a dark one.
   All three series take the one ramp step that reads on both, and what
   distinguishes them is the row they are in and the words above it. */
import * as React from "react"
import { Bar, BarChart, CartesianGrid, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { time } from "./RecordTable"

type SeriesKey = "tokens" | "completions" | "requests"

type ActivityBucket = {
  starts_at: string
  ends_at: string
  label: string
  length_ms: number
  partial?: true
  before_record?: true
  tokens: number
  completions: number
  requests: number
}

type ActivitySeries = {
  key: SeriesKey
  label: string
  unit: string
  basis: string
  coverage: string
  total: number
  peak: number
  floor: number
}

export type ActivityRangeData = {
  unit: "hour" | "day"
  window_started_at: string
  buckets: ActivityBucket[]
  series: ActivitySeries[]
}

export type TeamActivityData = {
  as_of: string
  time_zone: string
  recording_began_at: string | null
  day: ActivityRangeData
  week: ActivityRangeData
}

export function activityOf(data: unknown): TeamActivityData | null {
  const value = (data as { activity?: TeamActivityData } | null)?.activity
  return value && typeof value.as_of === "string" && Array.isArray(value.day?.buckets) && Array.isArray(value.week?.buckets)
    ? value
    : null
}

const RANGE: { id: "day" | "week"; label: string; summary: string }[] = [
  { id: "day", label: "Day", summary: "the past 24 hours, in hours" },
  { id: "week", label: "Week", summary: "the past 7 days, in days" },
]

const count = (value: number, unit: string) => `${value.toLocaleString()} ${unit}`

/* How long a bucket really covers, in the unit a reader can judge: minutes
   while an hour is still filling, hours for a day — which is how a 23-hour
   daylight-saving day says so. */
const covers = (ms: number) => (ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 360_000) / 10} h`)

/* How many x-axis labels a bucket count can carry without them colliding. The
   narrowest layout the verifier walks is 390px, where 24 hourly labels would
   need 16px each; one in six is the reading that survives it, and every
   bucket's own label is still in the tooltip and the table. */
const tickEvery = (buckets: number) => (buckets > 12 ? 6 : 1)

/** One series: its own chart, its own scale, its own numbers.
 *
 *  The shared axis is drawn once, under the last row, so the three charts read
 *  as one timeline rather than three. The rows above it keep the same plot area
 *  by keeping the same margins — a chart whose axis is hidden still reserves
 *  nothing for it. */
function Series({ series, buckets, axis }: { series: ActivitySeries; buckets: ActivityBucket[]; axis: boolean }) {
  /* Keyed by the bucket's own instant, not by its label. A local clock repeats
     "01:00" the night it falls back, and two bars sharing one category value
     would be drawn on top of each other by a band scale that deduplicates its
     domain — once a year, for an hour, with nothing to show for it. The label
     is looked up for the axis tick and the tooltip instead. */
  const data = buckets.map((bucket) => ({
    at: bucket.starts_at,
    value: bucket.before_record ? null : bucket[series.key],
  }))
  const labels = new Map(buckets.map((bucket) => [bucket.starts_at, bucket.label]))
  /* A zero draws no bar, and so does a bucket from before the record — which
     would leave the two readings identical on the one surface a reader looks
     at first. So the unrecorded span is drawn: a band behind the bars, with the
     card saying in words what it is. The band is always at the old end, because
     recording began before `as_of` or there would be no reading at all. */
  const unrecorded = buckets.filter((bucket) => bucket.before_record)
  /* The domain is what scales the series, so no normalized number is ever
     computed and the tooltip's figure is the stored one. A series with nothing
     in it gets a nominal ceiling and draws a flat line at zero rather than
     dividing by it. */
  const top = series.peak || 1
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium">{series.label}</span>
        <span className="text-muted-foreground text-xs">
          {count(series.total, series.unit)} in this period
          {series.peak
            ? ` · scaled to its own peak of ${count(series.peak, series.unit)}`
            : " · nothing reported, so this line is flat"}
        </span>
      </div>
      {/* The row carrying the shared axis is taller by exactly what the axis
          costs, so all three PLOT areas are the same height. Without that the
          bottom series draws every bar at half the height of the two above it
          for the same share of its own peak — three rows that cannot be read
          as one timeline, which is the whole point of sharing an axis. */}
      <ChartContainer
        config={{ value: { label: series.label, color: "var(--chart-2)" } }}
        className={axis ? "aspect-auto h-[64px] w-full" : "aspect-auto h-[44px] w-full"}
      >
        <BarChart accessibilityLayer data={data} margin={{ top: 2, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} horizontal={false} />
          {unrecorded.length ? (
            <ReferenceArea
              x1={unrecorded[0]!.starts_at}
              x2={unrecorded[unrecorded.length - 1]!.starts_at}
              fill="var(--foreground)"
              fillOpacity={0.07}
              ifOverflow="visible"
            />
          ) : null}
          <YAxis hide domain={[Math.min(0, series.floor), top]} />
          {/* Where zero is, drawn only when something is below it. A bar
              hanging under an invisible baseline reads as a small positive
              one, which is the opposite of what a netted-out correction
              means. */}
          {series.floor < 0 ? <ReferenceLine y={0} stroke="var(--border)" /> : null}
          <XAxis
            dataKey="at"
            hide={!axis}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: string) => labels.get(value) ?? value}
            interval={tickEvery(buckets.length) - 1}
            tickMargin={4}
            minTickGap={0}
          />
          <ChartTooltip
            content={<ChartTooltipContent
              labelFormatter={(value) => labels.get(String(value)) ?? String(value)}
              formatter={(value) => <span className="font-mono tabular-nums">{count(Number(value), series.unit)}</span>}
            />}
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={1} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

/** Every bucket's exact figures, and what each series does and does not count.
 *
 *  This is the textual alternative to the charts, not a supplement to them:
 *  every number a bar stands for is here in words, with its own bucket's local
 *  label and instants. Exported apart from the card for the reason
 *  `TeamNowSessions` is — a closed `Collapsible` renders none of its content,
 *  so a server-rendered proof of the numbers has to render this directly. */
export function TeamActivityNumbers({ range, timeZone }: { range: ActivityRangeData; timeZone: string }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 pt-3 text-xs">
      <div className="flex flex-col gap-1">
        {range.series.map((series) => (
          <p key={series.key} className="[overflow-wrap:anywhere]">
            <span className="font-medium">{series.label}</span>
            {` (${series.unit}) — ${series.basis}. ${series.coverage}.`}
          </p>
        ))}
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          Buckets are cut on the {timeZone} clock
          {range.unit === "hour"
            ? ", so the hour a clock repeats appears twice and the hour it skips not at all"
            : ", so a day either side of a daylight-saving change is 23 or 25 hours"}
          , and the newest is still filling. Each row says how long its bucket
          really is.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{range.unit === "hour" ? "Hour" : "Day"}</TableHead>
            {range.series.map((series) => (
              <TableHead key={series.key} className="text-right">{series.label}</TableHead>
            ))}
            <TableHead className="text-right">Covers</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {range.buckets.map((bucket) => (
            <TableRow key={bucket.starts_at}>
              <TableCell>
                <time dateTime={bucket.starts_at}>{bucket.label}</time>
                {bucket.partial ? <span className="text-muted-foreground"> · still filling</span> : null}
              </TableCell>
              {range.series.map((series) => (
                <TableCell key={series.key} className="text-right font-mono tabular-nums">
                  {bucket.before_record ? <span className="text-muted-foreground">no record</span> : bucket[series.key].toLocaleString()}
                </TableCell>
              ))}
              <TableCell className="text-right tabular-nums">{covers(bucket.length_ms)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function TeamActivity({ data }: { data: TeamActivityData }) {
  const [selected, setSelected] = React.useState<"day" | "week">("day")
  const range = data[selected]
  const chosen = RANGE.find((option) => option.id === selected) ?? RANGE[0]
  return (
    <Card aria-label="Team activity">
      <CardHeader>
        <CardTitle>Team activity</CardTitle>
        {/* The instant the server windowed on, as every card on this page
            carries it: a reading held over from a failed refresh says which
            window it describes instead of being redrawn against the reader's
            clock. The zone is named because a "day" here is a clock's day, and
            a reader in another zone is entitled to know whose. */}
        <p className="text-muted-foreground text-xs">
          {chosen.summary} to <time dateTime={data.as_of}>{time(data.as_of)}</time>, on the {data.time_zone} clock
          {" · "}from <time dateTime={range.window_started_at}>{time(range.window_started_at)}</time>
        </p>
        <div className="flex gap-1 pt-1" role="group" aria-label="Range">
          {RANGE.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option.id === selected ? "secondary" : "ghost"}
              aria-pressed={option.id === selected}
              onClick={() => setSelected(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {/* Said once, in words, because it is the one thing a reader could get
            wrong from the drawing alone. */}
        <p className="text-muted-foreground text-xs">
          Each series is scaled to its own peak: heights compare along a row and
          never between rows.
          {range.buckets.some((bucket) => bucket.before_record)
            ? " The shaded band is before this installation began recording \u2014 unknown, not zero."
            : ""}
          {range.series.some((series) => series.floor < 0)
            ? " A bar below the line is a bucket where a meter cancelled more than was reported in it."
            : ""}
        </p>
        {range.series.map((series, i) => (
          <Series
            key={series.key}
            series={series}
            buckets={range.buckets}
            axis={i === range.series.length - 1}
          />
        ))}
      </CardContent>
      <CardFooter>
        <Collapsible className="w-full">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">Show the numbers</Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <TeamActivityNumbers range={range} timeZone={data.time_zone} />
          </CollapsibleContent>
        </Collapsible>
      </CardFooter>
    </Card>
  )
}
