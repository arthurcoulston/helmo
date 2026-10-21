/* What the four approved status colours MEAN, in one place.

   Arthur's direction (H-2978@dev.rev): important things stand out, slightly
   desaturated, few severity levels. So there are four roles and no more —
   information/in progress, success/healthy, attention/needs you, and
   failure/urgent intervention — and the mappings below are the only place that
   decides which state is which. Each area composes these; none of them carries
   a hex or its own severity rule.

   Two restraints are load-bearing rather than taste:

   - Ordinary queued work and a DELIBERATE hold stay neutral. A dependency
     wait, a capacity hold and a date gate are the system working; colouring
     them makes a backlog look like an incident and then nothing stands out.
   - Colour is never the carrier. The tint is 1.10–1.87:1 against its surface
     by design, so every role is applied to something that already says what it
     means in words. Reading the palette out loud is how you check a mapping:
     if the word were removed, would the colour have to be read? */
import * as React from "react"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"

export type StatusRole = "info" | "success" | "attention" | "failure"

/* Complete literal class strings, never composed. Tailwind generates from
   source text, so a class assembled from a role name at runtime names a rule
   that does not exist and paints nothing, with no error anywhere. */
const INK_AND_TINT: Record<StatusRole, string> = {
  info: "bg-[var(--helmo-info-tint)] text-[var(--helmo-info-ink)]",
  success: "bg-[var(--helmo-success-tint)] text-[var(--helmo-success-ink)]",
  attention: "bg-[var(--helmo-attention-tint)] text-[var(--helmo-attention-ink)]",
  failure: "bg-[var(--helmo-failure-tint)] text-[var(--helmo-failure-ink)]",
}

/* An Alert's description carries its own muted colour, so the role has to
   reach it the way upstream's own destructive variant reaches it. */
const ALERT: Record<StatusRole, string> = {
  info: `${INK_AND_TINT.info} *:data-[slot=alert-description]:text-[var(--helmo-info-ink)]`,
  success: `${INK_AND_TINT.success} *:data-[slot=alert-description]:text-[var(--helmo-success-ink)]`,
  attention: `${INK_AND_TINT.attention} *:data-[slot=alert-description]:text-[var(--helmo-attention-ink)]`,
  failure: `${INK_AND_TINT.failure} *:data-[slot=alert-description]:text-[var(--helmo-failure-ink)]`,
}

/* The ink alone, for text that is already on the page's own surface. Measured
   there too: ≥4.7:1 on every preset surface in both themes. */
const INK: Record<StatusRole, string> = {
  info: "text-[var(--helmo-info-ink)]",
  success: "text-[var(--helmo-success-ink)]",
  attention: "text-[var(--helmo-attention-ink)]",
  failure: "text-[var(--helmo-failure-ink)]",
}

export const inkRole = (role?: StatusRole | null) => (role ? INK[role] : "")
export const tintRole = (role?: StatusRole | null) => (role ? INK_AND_TINT[role] : "")

/** A badge that carries a role when its state has one and reads as ordinary
 *  chrome when it does not. `variant` is the neutral it falls back to, so a
 *  caller keeps the appearance it already had for every uncoloured state.
 *
 *  `data-status-role` is what the browser verification measures: it finds every
 *  rendered role on every layout in both themes, rather than the handful of
 *  selectors this change happened to touch. */
export function StatusBadge({ status, variant = "secondary", className, children, ...props }: React.ComponentProps<typeof Badge> & { status?: StatusRole | null }) {
  return <Badge
    variant={variant}
    data-status-role={status ?? undefined}
    className={[tintRole(status), className].filter(Boolean).join(" ") || undefined}
    {...props}
  >{children}</Badge>
}

/** An alert that carries a role. Same contract as StatusBadge: the role styles
 *  it and `data-status-role` is what the verification measures, so no call site can
 *  paint a colour the proof cannot find. */
export function StatusAlert({ status, className, ...props }: React.ComponentProps<typeof Alert> & { status: StatusRole }) {
  return <Alert data-status-role={status} className={[ALERT[status], className].filter(Boolean).join(" ")} {...props} />
}

/* ---------- the mappings ---------- */

/** A ticket's own status. Done and cancelled stay neutral deliberately: they
 *  sit under a "Done" or "Cancelled" heading in a table of nothing else, so a
 *  colour there is decoration, and thousands of green rows is how a signal
 *  stops being one. Where a closed ticket's outcome IS information — whether
 *  the release review accepted it — the acceptance signal carries it. */
export function ticketStateRole(status: string): StatusRole | null {
  if (status === "in_progress") return "info"
  if (status === "awaiting_human") return "attention"
  return null
}

/** What a stored roadmap status means in today's words (R-46). A row keeps
 *  the word it was written with until the one-shot migration writes the new
 *  one, and the history panel shows old words forever, so both read here. */
export function projectStatusReading(status: string): string {
  return ({
    parked: "Proposed", shaping: "Proposed", ready: "Proposed",
    ship_next: "Active", shipping: "Active",
    shipped_watching: "Monitoring", shipped: "Monitoring", shipped_stable: "Completed",
    archived: "Canceled", abandoned: "Canceled",
  })[status] ?? status
}

/** A roadmap project's status. The work phase is the one in motion; Completed
 *  is the one that came through. Proposed, Paused and Canceled are the ordinary
 *  and the deliberate: an idea nobody has started and a delivery its owner
 *  stopped on purpose are both the system working. Whether an initiative is
 *  GOING well is a different fact, and `projectHealthRole` is where it lives. */
export function projectStatusRole(status: string): StatusRole | null {
  const reading = projectStatusReading(status)
  if (reading === "Planned" || reading === "Active" || reading === "Monitoring") return "info"
  if (reading === "Completed") return "success"
  return null
}

/** How an initiative is going, which its status cannot say: one can be Paused
 *  deliberately AND Off track at the same time, and one field carrying both
 *  was the conflation R-46 set out to end.
 *
 *  All three readings carry a role, which the restraint at the top of this file
 *  otherwise withholds. They earn it by not being the ordinary case: health is
 *  set by the initiative's owner and never derived, so a row only has one
 *  because somebody judged it. Off track is the loud one — the owner saying
 *  this will not arrive as intended, which is the single roadmap reading that
 *  asks for intervention rather than patience.
 *
 *  This replaces a `status === "blocked"` branch that could never fire: no
 *  roadmap status by that name has ever existed, so the attention role it
 *  returned painted nothing. Off track with the blocker named in its reason is
 *  what that branch was reaching for (H-3341). */
export function projectHealthRole(health?: string | null): StatusRole | null {
  if (health === "On track") return "success"
  if (health === "At risk") return "attention"
  if (health === "Off track") return "failure"
  return null
}

/** The release review's verdict on a closed ticket. A contested verdict is two
 *  reviewers disagreeing about whether the work is sound, which no one else
 *  will resolve. */
export function acceptanceRole(state: string, reason?: string): StatusRole | null {
  if (reason === "contested" || state === "failed") return "failure"
  if (state === "accepted") return "success"
  return null
}

/** A loop's state, as Rev's sentinels report it (packages/runtime `state()`).
 *  STOP, HOLD, PARKED, SEAT_HELD and halted are all somebody's decision, and
 *  IDLE is the fleet with nothing to do; none of them is a problem. BACKOFF,
 *  WEDGED and CRASHED record an unexpected loop failure; a supervisor retry
 *  does not turn the crash into a blockage.
 *
 *  BLOCKED is amber, and that was questioned and settled rather than left to
 *  taste. A reviewer read it as a contract conflict — the palette says a
 *  dependency wait stays neutral, so why is this one coloured? Because the
 *  neutral rule is about DELIBERATE pauses, which is why the five states above
 *  are neutral, and a blocked loop is one that has downed tools and will not
 *  restart on its own. Arthur confirmed it: a loop needing his intervention is
 *  amber (H-2987@dev.rev). */
export function loopStateRole(state: string): StatusRole | null {
  if (["BACKOFF", "WEDGED", "CRASHED"].includes(state)) return "failure"
  if (["BLOCKED", "LIMIT", "UNKNOWN"].includes(state)) return "attention"
  if (state === "RUNNING") return "info"
  return null
}

/** An agent's rolled-up state on the condensed roster (packages/runtime
 *  `team-now.ts`). The same severities `loopStateRole` gives the session states
 *  behind it, which `test/status-palette.test.mjs` asserts state by state: the
 *  roll-up may move a state's prominence by choosing which session speaks for
 *  the agent, and it may never move what a state MEANS.
 *
 *  So `awaiting` and `stopped` are neutral — nothing to do and a deliberate
 *  stop are the fleet working — and `unknown` is amber, because a state that
 *  could not be read is a reading Arthur has to take himself. */
export function agentStateRole(state: string): StatusRole | null {
  if (state === "failed") return "failure"
  if (state === "blocked" || state === "unknown") return "attention"
  if (state === "working") return "info"
  return null
}

/** A moment on an incident's record, as Overview's notices draw it (H-3216).
 *
 *  Red is reserved for the incident that is still happening: that is the one
 *  where somebody is being hurt by this right now. An unresolved incident not
 *  recorded as ongoing is amber — it is his to know about, and the team is on
 *  it — and a verified resolution is green, because the one thing a resolution
 *  notice should not do is look like another alarm.
 *
 *  The colour describes the incident as it stands NOW, which is why
 *  `unresolved` is here: the identification of an incident since resolved said
 *  "still happening" when it was recorded and would otherwise keep painting
 *  red under its own green resolution. An earlier notice on a closed incident
 *  is a record, so it takes no colour at all.
 *
 *  `happening_now` unknown is deliberately not red. "Nobody has recorded
 *  whether this is ongoing" is a gap in the record, and painting a gap as an
 *  emergency is how every notice becomes one. */
export function incidentNoticeRole(moment: string, happeningNow: boolean | null, unresolved: boolean): StatusRole | null {
  if (moment === "resolved") return "success"
  if (!unresolved) return null
  if (happeningNow === true) return "failure"
  return "attention"
}

/** A configured context file's standing against its own `cap_tokens`.
 *
 *  `tight` and `uncapped` are deliberately neutral. A file kept just under its
 *  cap is the system working — the cap is a ceiling, and consolidation keeps
 *  these files close to it on purpose — and an uncapped file is a gap in the
 *  record rather than a fault in the run. Colouring either is how ten of ten
 *  rows go amber and the signal stops being one.
 *
 *  `over` is amber because a cap is ratified and only Arthur ratifies a new
 *  one, so a breach is his to settle. `unreadable` is red because the shim
 *  refuses to launch a seat whose profile or roster skill it cannot read (rc
 *  78, apparatus): that loop is already down. */
export function contextFileRole(state: string): StatusRole | null {
  if (state === "unreadable") return "failure"
  if (state === "over") return "attention"
  return null
}

/** A usage window's severity, in the provider's own escalation words
 *  (packages/runtime `usage.ts`) — never a threshold of ours. "unknown" is a
 *  reading we could not take, which is worth seeing but is not a limit. */
export function usageSeverityRole(severity: string): StatusRole | null {
  if (severity === "critical") return "failure"
  if (severity === "warning") return "attention"
  return null
}
