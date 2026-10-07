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
   - Colour is never the carrier. The tint is 1.10–1.45:1 against its surface
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

/** A roadmap project's status. Ship next is the one in motion; stable is the
 *  one that came through; blocked is the one that needs a way opened. Shaping,
 *  ready and parked are the ordinary and the deliberate. */
export function projectStatusRole(status: string): StatusRole | null {
  if (status === "ship_next" || status === "shipped_watching") return "info"
  if (status === "shipped_stable") return "success"
  if (status === "blocked") return "attention"
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
 *  IDLE is the fleet with nothing to do; none of them is a problem. WEDGED and
 *  CRASHED are a loop that cannot continue on its own. */
export function loopStateRole(state: string): StatusRole | null {
  if (state === "WEDGED" || state === "CRASHED") return "failure"
  if (["BLOCKED", "BACKOFF", "LIMIT", "UNKNOWN"].includes(state)) return "attention"
  if (state === "RUNNING") return "info"
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
