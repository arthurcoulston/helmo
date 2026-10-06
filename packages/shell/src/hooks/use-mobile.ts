// VENDORED — do not edit. Source: the estate repo, src/hooks/use-mobile.ts
// Refresh: node scripts/vendor-estate-components.mjs
// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)
//
// shadcn/ui source, style radix-nova, retaining its MIT notice in
// THIRD_PARTY_NOTICES.md. The estate is where this estate agreed that
// configuration (R-11); Helmo vendors it so it stays publishable alone.

import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
