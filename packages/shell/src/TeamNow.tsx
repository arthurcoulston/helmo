/* Team now — who is working, who is waiting, who cannot work, at a glance
   (R-44, H-3091). The fourth of Arthur's selected Overview widgets.

   The whole widget is one question: if something has downed tools, can Arthur
   see it without reading anything? So the glance view is one line per agent and
   nothing else, the two states that need him carry their recorded reason on a
   second line, and everything that explains the reading — each session's own
   state word, its workstream, the full reason, how several sessions became one
   chip — is behind a single disclosure.

   What it must never do is read a quiet absence as good news. Every state here
   is Rev's own (`packages/runtime/src/team-now.ts` maps them, and `state()` in
   runtime's view.ts is where they come from); this file translates words and
   draws them, and it has no rule of its own about what counts as idle. */
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { agentStateRole, StatusAlert, StatusBadge } from "./Status"
import { time } from "./RecordTable"

type HeldWork = { id: string; title: string }
type SessionNow = {
  session: string
  agent: string
  source_state: string
  state: string
  workstream: string
  detail: string | null
}
type AgentNow = {
  agent: string
  state: string
  source_state: string
  detail: string | null
  sessions: SessionNow[]
  work: HeldWork[]
}

export type TeamNowData = {
  as_of: string
  agents: AgentNow[]
  unavailable?: string
}

export function teamNowOf(data: unknown): TeamNowData | null {
  const value = (data as { team?: TeamNowData } | null)?.team
  return value && Array.isArray(value.agents) && typeof value.as_of === "string" ? value : null
}

/* The display words for each state the server can send. Arthur's four, plus the
   two that must not be folded into them.

   A state this map does not hold is shown as itself rather than dropped — the
   same call the results card makes about an unmapped category. It cannot
   normally happen: the server already answers `unknown` for a word it does not
   recognise, so this is the second half of the same refusal, for a server newer
   than this build. */
const WORD: Record<string, string> = {
  working: "Working",
  awaiting: "Awaiting work",
  blocked: "Blocked",
  stopped: "Stopped",
  failed: "Failed",
  unknown: "Unknown",
}

/* Which states put their reason in the glance view. The ordinary and the
   deliberate do not: "Stopped — by human: rev stop ward" on five rows is how
   the two rows that need reading stop standing out, and the reason is one
   disclosure away for every state either way. This is the same restraint
   UI.md states for the colours, applied to the words. */
const READ_NOW = new Set(["blocked", "failed", "unknown"])

function label(agent: AgentNow) {
  const word = WORD[agent.state] ?? agent.state
  // An unrecognised state carries the server's own word, because "Unknown" on
  // its own would hide the one thing a reader could act on: which state it was
  // that this build could not read.
  return agent.state === "unknown" && !["UNKNOWN", "unknown"].includes(agent.source_state)
    ? `${word}: ${agent.source_state}`
    : word
}

function Row({ agent }: { agent: AgentNow }) {
  const held = agent.work[0]
  return <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    {/* No truncation: a roster is read by name, and an agent whose name is cut
        is one a reader cannot be sure they have identified. */}
    <span className="font-medium [overflow-wrap:anywhere]">{agent.agent}</span>
    <StatusBadge variant="outline" status={agentStateRole(agent.state)}>{label(agent)}</StatusBadge>
    {/* The ticket it has claimed, which is the only thing in the record that
        says what an agent is working on. The fragment is Work's own record
        link, the same one the results card uses. */}
    {held ? <a className="font-mono text-xs underline-offset-4 hover:underline" href={`/#${held.id}`}>{held.id}</a> : null}
    {agent.work.length > 1 ? <span className="text-muted-foreground text-xs">+{agent.work.length - 1} more held</span> : null}
    {agent.sessions.length > 1 ? <span className="text-muted-foreground text-xs">{agent.sessions.length} sessions</span> : null}
    {READ_NOW.has(agent.state) && agent.detail
      ? <p className="text-muted-foreground line-clamp-1 w-full text-xs">{agent.detail}</p>
      : null}
  </li>
}

/** Every session behind the chips, in the server's own words. This is where the
 *  roll-up is accountable: an agent with two sessions shows both states here,
 *  so a reader can see which one the chip is reporting and that the other was
 *  not discarded.
 *
 *  Exported apart from the card because a closed `Collapsible` renders none of
 *  its content, so a server-rendered proof of the card cannot see this at all
 *  — the same split `RecordPreview` keeps for the same reason. The browser run
 *  opens the control; the unit proof renders this directly. */
export function TeamNowSessions({ agents }: { agents: AgentNow[] }) {
  return <div className="flex flex-col gap-2 pt-3 text-xs">
    <p className="text-muted-foreground">
      One agent is one accountable seat. Where a seat has several sessions, its
      chip is the most significant state among them — a failure or a blockage
      before a session that is running normally — and every session is listed
      here.
    </p>
    {agents.map((agent) => <div key={agent.agent} className="flex flex-col gap-1">
      {agent.sessions.map((session) => <p key={session.session} className="[overflow-wrap:anywhere]">
        <span className="font-medium">{agent.agent}</span>
        {session.session === agent.agent ? "" : ` · session ${session.session}`}
        {` · ${session.source_state} · ${session.workstream}`}
        {session.detail ? ` · ${session.detail}` : ""}
      </p>)}
    </div>)}
  </div>
}

export function TeamNow({ data }: { data: TeamNowData }) {
  return <Card aria-label="Team now">
    <CardHeader>
      <CardTitle>Team now</CardTitle>
      {/* The instant the states were read, not the instant this drew. A card
          held over from a failed refresh is the case this line exists for:
          stale states that say when they were true are usable, and the same
          states redrawn against the reader's clock are not. */}
      <p className="text-muted-foreground text-xs">
        States read at <time dateTime={data.as_of}>{time(data.as_of)}</time>
      </p>
    </CardHeader>
    <CardContent className="text-sm">
      {data.unavailable
        /* An empty roster and an unreadable one are opposite readings, and this
           is the only thing that tells them apart. Red: a dashboard that cannot
           say what the team is doing is the fleet unobservable, which is the
           one failure this card exists to prevent. */
        ? <StatusAlert status="failure">
            <AlertTitle>The roster could not be read</AlertTitle>
            <AlertDescription>{data.unavailable}</AlertDescription>
          </StatusAlert>
        : data.agents.length
          ? <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {data.agents.map((agent) => <Row key={agent.agent} agent={agent} />)}
            </ul>
          : <p className="text-muted-foreground">This installation&rsquo;s roster configures no agents</p>}
    </CardContent>
    {data.agents.length ? <CardFooter>
      <Collapsible>
        <CollapsibleTrigger asChild><Button variant="outline" size="sm">Session detail</Button></CollapsibleTrigger>
        <CollapsibleContent><TeamNowSessions agents={data.agents} /></CollapsibleContent>
      </Collapsible>
    </CardFooter> : null}
  </Card>
}
