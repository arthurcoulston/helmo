// VENDORED — do not edit. Source: the estate repo, src/lib/utils.ts
// Refresh: node scripts/vendor-estate-components.mjs
// Drift is a test failure: npm test (skipped, loudly, with no estate checkout)
//
// shadcn/ui source, style radix-nova, retaining its MIT notice in
// THIRD_PARTY_NOTICES.md. The estate is where this estate agreed that
// configuration (R-11); Helmo vendors it so it stays publishable alone.

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
