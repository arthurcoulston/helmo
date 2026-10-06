import * as React from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export type TeamData = { loops: { id: string; name: string; state: string; detail: string; profile: string }[] }

function Member({ member }: { member: TeamData['loops'][number] }) {
  const [open, setOpen] = React.useState(false)
  const [profile, setProfile] = React.useState("")
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    fetch(member.profile, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("The configured profile cannot be read.")
      return (await response.json()).data.body as string
    }).then((body) => { setProfile(body); setError("") }).catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [open, member.profile])
  return <Card>
    <CardHeader><CardTitle>{member.name}</CardTitle><div><Badge variant="secondary">{member.state}</Badge></div></CardHeader>
    <CardContent className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{member.detail}</p>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild><Button variant="outline" size="sm">Profile for {member.name}</Button></CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          {error ? <Alert variant="destructive"><AlertTitle>Profile unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{profile || "Loading profile…"}</p>}
        </CollapsibleContent>
      </Collapsible>
    </CardContent>
  </Card>
}

export function TeamView({ data }: { data: TeamData }) {
  return <>
    <p className="text-muted-foreground text-sm">{data.loops.length} configured members</p>
    {data.loops.length ? <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">{data.loops.map((member) => <Member key={member.id} member={member} />)}</div> : <p className="text-muted-foreground text-sm">No team members are configured.</p>}
  </>
}
