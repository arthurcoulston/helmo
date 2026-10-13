/* What Arthur has been told about every incident (R-44, H-3216).

   The notice is DERIVED from the incident record, so recording an incident is
   what notifies him: there is no second act an agent could forget, and no
   stored line that can drift out of agreement with the record the way the
   retired standing notice did (H-1126).

   Nothing here is awaiting him, and both renderings say so in words. The
   surface that does park work — marking a ticket `needs_human` — withholds it
   from every agent ready queue, which is the last thing a live incident needs;
   when a response IS needed the owner files a request and it appears under
   Awaiting you with the rest.

   Two renderings, because the alarm and the record are different jobs:

   - The BAND, at the top of Overview. Three lines at most, and nothing at all
     when there is nothing to say, so Arthur's four ratified Overview readings
     keep the page they were ratified on (H-3092) on an ordinary day. An
     incident is the one thing that may push them down.
   - The TABLE, on Incidents, which is the whole board: what he was told, when,
     and what changed.

   The window comes from the server with the rows. Nothing here can be marked
   read, because the view carries no record data-entry, so the day window is
   what clears a notice — except for an incident still unresolved, whose
   latest notice stays however old it is, so an old open incident reads as
   what it is now rather than as what it was at identification. */
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { incidentNoticeRole, StatusAlert, StatusBadge } from "./Status"
import { time } from "./RecordTable"

type Notice = {
  ticket_id: string
  moment: "identified" | "material_change" | "resolved"
  at: string
  changed: string[]
  stage: string | null
  happening_now: boolean | null
}

export type IncidentNoticesData = {
  as_of: string
  window_started_at: string
  rows: Notice[]
  total: number
  unresolved: string[]
  coverage: { state: string; source: string }
}

export function incidentNoticesOf(data: unknown): IncidentNoticesData | null {
  const value = (data as { incident_notices?: IncidentNoticesData } | null)?.incident_notices
  return value && typeof value.as_of === "string" && Array.isArray(value.rows) && Array.isArray(value.unresolved) ? value : null
}

const MOMENT: Record<Notice["moment"], string> = {
  identified: "Identified",
  material_change: "Changed",
  resolved: "Resolved",
}

/* The field codes in the reader's words. The server sends codes on purpose —
   a notice must never carry a sentence nobody reviewed — so this is where they
   become English, and a code with no entry here is printed as it arrived
   rather than dropped. */
const FIELD: Record<string, string> = {
  stage: "stage",
  happening_now: "whether it is still happening",
  affected: "what is affected",
  owner: "owner",
  cause: "cause",
  containment: "containment",
  fix: "fix",
  human_report_acknowledgement: "your report acknowledged",
  remaining_work: "remaining work",
}

function changedText(notice: Notice): string {
  if (notice.moment === "identified") return "Opened on the record"
  if (!notice.changed.length) return "No material field changed"
  return notice.changed.map((field) => FIELD[field] ?? field).join(", ")
}

const unresolved = (data: IncidentNoticesData, notice: Notice) => data.unresolved.includes(notice.ticket_id)

/* How loud the band is: the loudest thing it is carrying. An incident recorded
   as still happening is red wherever it is drawn, and a band of resolutions is
   green rather than another alarm. */
function bandRole(data: IncidentNoticesData) {
  const roles = data.rows.map((notice) => incidentNoticeRole(notice.moment, notice.happening_now, unresolved(data, notice)))
  for (const role of ["failure", "attention", "success"] as const) if (roles.includes(role)) return role
  return "info"
}

const BAND_LINES = 3

/** The alarm: what is live, and what changed today, at the top of Overview.
 *  Renders nothing when the record has nothing to tell him — an empty band
 *  every day is how a band stops being read. */
export function IncidentNoticeBand({ data }: { data: IncidentNoticesData }) {
  if (!data.rows.length) return null
  const shown = data.rows.slice(0, BAND_LINES)
  const rest = data.rows.length - shown.length
  return (
    <StatusAlert status={bandRole(data)} aria-label="Incident notices">
      <AlertTitle>
        {data.unresolved.length ? `${data.unresolved.length} unresolved ${data.unresolved.length === 1 ? "incident" : "incidents"}` : "Incidents"}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        <ul className="flex flex-col gap-1">
          {shown.map((notice) => (
            <li key={`${notice.ticket_id}-${notice.at}-${notice.moment}`}>
              <a className="font-mono underline underline-offset-2" href={`/incidents/${notice.ticket_id}`}>{notice.ticket_id}</a>
              {` ${MOMENT[notice.moment].toLowerCase()} · ${changedText(notice)}`}
              {notice.happening_now === true && unresolved(data, notice) ? " · still happening" : ""}
              {` · ${time(notice.at)}`}
            </li>
          ))}
        </ul>
        <span>
          {rest > 0 ? `${rest} more ${rest === 1 ? "notice" : "notices"} on ` : "Every notice is on "}
          <a className="underline underline-offset-2" href="/incidents">Incidents</a>. Nothing here is waiting on you.
        </span>
      </AlertDescription>
    </StatusAlert>
  )
}

/** The board: every notice the day window and the unresolved incidents carry,
 *  under the incident records on Incidents. */
export function IncidentNoticeTable({ data }: { data: IncidentNoticesData }) {
  const older = data.total - data.rows.length
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Incident notices">
      <h2 className="text-sm font-medium">What you have been told</h2>
      <p className="text-sm text-muted-foreground">
        Recorded for you at identification, at every material change and at verified resolution,
        from {time(data.window_started_at)} plus every unresolved incident. Nothing here is waiting
        on you — a response is asked for separately, under Awaiting you.
      </p>
      {data.rows.length ? (
        <div className="overflow-x-auto rounded-md border" role="region" aria-label="Incident notice record">
          <Table tabIndex={0} aria-label="Incident notice record" data-above-fold="incident moment">
            <TableHeader>
              <TableRow>
                <TableHead data-column="incident">Incident</TableHead>
                <TableHead data-column="moment">Moment</TableHead>
                <TableHead data-column="changed">What changed</TableHead>
                <TableHead data-column="stage">Stage</TableHead>
                <TableHead data-column="recorded">Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((notice) => (
                <TableRow key={`${notice.ticket_id}-${notice.at}-${notice.moment}`}>
                  <TableCell data-column="incident" className="whitespace-normal">
                    <a className="font-mono underline-offset-2 hover:underline" href={`/incidents/${notice.ticket_id}`}>{notice.ticket_id}</a>
                  </TableCell>
                  <TableCell data-column="moment">
                    <StatusBadge status={incidentNoticeRole(notice.moment, notice.happening_now, unresolved(data, notice))}>{MOMENT[notice.moment]}</StatusBadge>
                  </TableCell>
                  <TableCell data-column="changed" className="whitespace-normal">{changedText(notice)}</TableCell>
                  <TableCell data-column="stage" className="whitespace-normal">
                    {notice.stage ?? "Unknown"}
                    {notice.happening_now === true && unresolved(data, notice) ? <span className="block text-xs text-muted-foreground">still happening</span> : null}
                  </TableCell>
                  <TableCell data-column="recorded" className="whitespace-normal">{time(notice.at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No incident has been recorded since {time(data.window_started_at)}, and none is unresolved.
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        Source {data.coverage.source}.
        {older > 0 ? ` ${older} earlier ${older === 1 ? "notice is" : "notices are"} held on the record outside this window.` : ""}
      </p>
    </section>
  )
}
