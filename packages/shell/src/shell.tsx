import * as React from 'react'
import {
  ActivityIcon,
  ClipboardListIcon,
  LayoutDashboardIcon,
  MapIcon,
  SquareArrowOutUpRightIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export type Destination = { id: string; label: string; href: string }
export type ShellConfig = { area: string; title: string; destinations: Destination[] }

/* The registry carries no icon, so an area this map has not met falls up to a
   neutral mark rather than leaving a hole in the menu. */
const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboardIcon,
  work: ClipboardListIcon,
  roadmap: MapIcon,
  team: UsersIcon,
  runtime: ActivityIcon,
}

/** The upper-right control: this page again, in a window of its own.
 *
 *  `window.location.href` and not a rebuilt path, because the context to
 *  preserve is whatever the reader is actually looking at — Work's query
 *  filters and the ticket in the fragment included.
 *
 *  Opened straight from the click, with no `noopener`: the two are same-origin
 *  views of one local dashboard, and a handle back is the only way to tell a
 *  blocked open (null) from a successful one. When it is blocked, the fallback
 *  is a plain link the reader can take themselves — a popup policy that
 *  refuses script-opened windows still honours a click on an anchor. */
function OpenInNewWindow() {
  const [blocked, setBlocked] = React.useState(false)

  const open = () => {
    const opened = window.open(window.location.href, '_blank', 'popup=yes,width=1100,height=900')
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
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Open in new window" onClick={open}>
              <SquareArrowOutUpRightIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in new window</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

/** The shell around a Helmo product document.
 *
 *  `page` is the document itself, already parsed and already running: the
 *  server renders Work, Roadmap, Runtime and the app page exactly as it did
 *  before, and the shell adopts those nodes rather than re-rendering them.
 *  React never owns that subtree — it is handed to an empty host element once,
 *  so every listener, disclosure and refresh timer the product installed on
 *  its own markup survives the move. */
export function Shell({ config, page }: { config: ShellConfig; page: DocumentFragment }) {
  const host = React.useRef<HTMLDivElement>(null)

  // Layout effect, not a passive one: the page is detached between the lift
  // and this append, and a passive effect runs after paint — one frame of
  // blank document under a shell that is already drawn.
  React.useLayoutEffect(() => {
    host.current?.append(page)
  }, [page])

  return (
    <SidebarProvider data-helmo-shell="">
      <Sidebar>
        <nav aria-label="Helmo areas" className="flex h-full flex-col">
          <SidebarHeader className="px-4 py-3 text-sm font-medium">Helmo</SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {config.destinations.map((destination) => {
                    const Icon = ICONS[destination.id]
                    return (
                      <SidebarMenuItem key={destination.id}>
                        <SidebarMenuButton asChild isActive={destination.id === config.area}>
                          {/* The colour is named rather than inherited: the
                              Runtime page styles every `a` on the document,
                              and an inherited colour has nothing to beat it
                              with. */}
                          <a className="text-sidebar-foreground" href={destination.href}>
                            {Icon ? <Icon /> : null}
                            <span>{destination.label}</span>
                          </a>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </nav>
      </Sidebar>
      <SidebarInset>
        {/* One row: the trigger, this view's title, and the pop-out. The menu
            never gets a row of its own — a row of chrome above every page is
            the space the critique was about. */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="text-sm font-medium" data-helmo-view-title="">{config.title}</span>
          <OpenInNewWindow />
        </header>
        <div id="helmo-page" ref={host} />
      </SidebarInset>
    </SidebarProvider>
  )
}
