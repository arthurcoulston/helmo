import * as React from "react"
import {
  ActivityIcon,
  ClipboardListIcon,
  LayoutDashboardIcon,
  MapIcon,
  SquareArrowOutUpRightIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type Link = { label: string; href: string }
type Record_ = {
  id?: string
  title?: string
  name?: string
  installation?: string
  status?: string
  state?: string
  body?: string
  detail?: string
  links?: Link[]
}

type Destination = {
  id: string
  label: string
  href: string
  icon: LucideIcon
  rendered: boolean
}

/* `rendered` says which areas this application draws. Work, Roadmap and
   Runtime are still served as their own documents by their own handlers until
   H-2936–H-2939 move them here; the menu links to them so navigation keeps
   working, and leaving them is a full page load out of this application. */
const DESTINATIONS: Destination[] = [
  {
    id: "overview",
    label: "Overview",
    href: "/overview",
    icon: LayoutDashboardIcon,
    rendered: true,
  },
  {
    id: "work",
    label: "Work",
    href: "/work",
    icon: ClipboardListIcon,
    rendered: false,
  },
  {
    id: "roadmap",
    label: "Roadmap",
    href: "/roadmap",
    icon: MapIcon,
    rendered: false,
  },
  { id: "team", label: "Team", href: "/team", icon: UsersIcon, rendered: true },
  {
    id: "runtime",
    label: "Runtime",
    href: "/run",
    icon: ActivityIcon,
    rendered: false,
  },
]

function activeArea() {
  const path = window.location.pathname.replace(/\/$/, "")
  return DESTINATIONS.find((d) => d.rendered && d.href === path) ?? DESTINATIONS[0]
}

/* The API document's payload is a record list under one of several keys, or a
   single record. Every Helmo area answers one of these shapes, and the view
   has never needed to know which. */
function records(data: unknown): Record_[] {
  if (Array.isArray(data)) return data as Record_[]
  if (data && typeof data === "object") {
    for (const key of ["records", "projects", "loops"] as const) {
      const value = (data as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value as Record_[]
    }
    return [data as Record_]
  }
  return []
}

type AreaState =
  | { status: "loading" }
  | { status: "ready"; records: Record_[] }
  | { status: "error"; message: string }

function useArea(area: string): AreaState {
  const [state, setState] = React.useState<AreaState>({ status: "loading" })

  React.useEffect(() => {
    let live = true
    setState({ status: "loading" })
    fetch(`/api/v1/${area}`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`)
        }
        const document_ = await response.json()
        if (document_.api !== "helmo/v1" || document_.area !== area) {
          throw new Error("unexpected API document")
        }
        return records(document_.data)
      })
      .then((rows) => {
        if (live) setState({ status: "ready", records: rows })
      })
      .catch((error: unknown) => {
        if (live) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return () => {
      live = false
    }
  }, [area])

  return state
}

function RecordCard({ record }: { record: Record_ }) {
  const title = record.title ?? record.name ?? record.installation ?? "Record"
  const state = record.status ?? record.state
  const body = record.body ?? record.detail
  return (
    <Card id={record.id}>
      <CardHeader>
        {record.id ? (
          <div className="font-mono text-xs text-muted-foreground">
            {record.id}
          </div>
        ) : null}
        <CardTitle>{title}</CardTitle>
        {state ? (
          <div>
            <Badge variant="secondary">{state}</Badge>
          </div>
        ) : null}
      </CardHeader>
      {body ? (
        <CardContent className="text-sm text-muted-foreground">
          {body}
        </CardContent>
      ) : null}
      {record.links?.length ? (
        <CardFooter className="flex-wrap gap-2">
          {record.links.map((link) => (
            <Button key={link.href} variant="outline" size="sm" asChild>
              <a href={link.href}>{link.label}</a>
            </Button>
          ))}
        </CardFooter>
      ) : null}
    </Card>
  )
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
  )
}

function Loading() {
  return (
    <CardGrid>
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-28 rounded-xl" />
      ))}
    </CardGrid>
  )
}

function AreaView({ area }: { area: Destination }) {
  const state = useArea(area.id)

  if (state.status === "loading") {
    return (
      <>
        <Skeleton className="h-4 w-24" />
        <Loading />
      </>
    )
  }

  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not read {area.id}</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    )
  }

  const rows = state.records
  const empty = (
    <p className="text-sm text-muted-foreground">
      No {area.id} records are configured.
    </p>
  )

  if (area.id === "overview") {
    return (
      <>
        <p className="text-sm text-muted-foreground">4 areas</p>
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Areas
          </h3>
          {rows.length ? (
            <CardGrid>
              {rows.slice(0, 4).map((record, index) => (
                <RecordCard key={record.id ?? index} record={record} />
              ))}
            </CardGrid>
          ) : (
            empty
          )}
        </section>
        <Separator />
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Current work
          </h3>
          <p className="text-sm">
            <a className="underline underline-offset-4" href="/work">
              Open Work for decisions, actions, progress and evidence.
            </a>
          </p>
        </section>
      </>
    )
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {rows.length} record{rows.length === 1 ? "" : "s"}
      </p>
      {rows.length ? (
        <CardGrid>
          {rows.map((record, index) => (
            <RecordCard key={record.id ?? record.name ?? index} record={record} />
          ))}
        </CardGrid>
      ) : (
        empty
      )}
    </>
  )
}

/** This page again, in a window of its own.
 *
 *  `window.location.href` and not a rebuilt path, because the context to
 *  preserve is whatever the reader is actually looking at — filters in the
 *  query and the record in the fragment included.
 *
 *  Opened straight from the click, with no `noopener`: the two are same-origin
 *  views of one local dashboard, and a handle back is the only way to tell a
 *  blocked open (null) from a successful one. When it is blocked, the fallback
 *  is a plain link the reader can take themselves — a popup policy that
 *  refuses script-opened windows still honours a click on an anchor. */
function OpenInNewWindow() {
  const [blocked, setBlocked] = React.useState(false)

  const open = () => {
    const opened = window.open(
      window.location.href,
      "_blank",
      "popup=yes,width=1100,height=900"
    )
    setBlocked(!opened)
    opened?.focus()
  }

  return (
    <div className="ml-auto flex items-center gap-2">
      {blocked ? (
        <a
          className="text-xs text-muted-foreground underline underline-offset-2"
          href={window.location.href}
          target="_blank"
          rel="noreferrer"
        >
          Your browser blocked the window — open it here
        </a>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Open in new window"
            onClick={open}
          >
            <SquareArrowOutUpRightIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in new window</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function App() {
  const area = activeArea()

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader className="px-4 py-3 text-sm font-medium">
            Helmo
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {DESTINATIONS.map((destination) => (
                    <SidebarMenuItem key={destination.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={destination.id === area.id}
                      >
                        <a href={destination.href}>
                          <destination.icon />
                          <span>{destination.label}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset>
          {/* One row: the trigger, this view's title, and the pop-out. The
              menu never gets a row of its own. */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b">
            <div className="flex flex-1 items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-vertical:h-4 data-vertical:self-auto"
              />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{area.label}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <OpenInNewWindow />
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-4 p-4">
            <h2 className="text-lg font-medium">{area.label}</h2>
            <AreaView area={area} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default App
