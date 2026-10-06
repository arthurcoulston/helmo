// VENDORED — do not edit. Source: the estate repo, src/components/ui/skeleton.tsx
// Refresh: node scripts/vendor-estate-components.mjs
// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)
//
// shadcn/ui source, style radix-nova, retaining its MIT notice in
// THIRD_PARTY_NOTICES.md. The estate is where this estate agreed that
// configuration (R-11); Helmo vendors it so it stays publishable alone.

import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
