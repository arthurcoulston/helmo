/* Mounts the shell onto a Helmo product document.
   Loaded by every page the app serves; see packages/app/server.mjs. */

import { createRoot } from 'react-dom/client'

import { Shell, type ShellConfig } from '@/shell'
import '@/index.css'

const CONFIG_ID = 'helmo-shell-config'
const ROOT_ID = 'helmo-shell-root'
const PAGE_ID = 'helmo-page'

/** Everything the server already rendered, lifted out of <body> in one piece.
 *
 *  Scripts stay where they are. A <script> that has not run yet re-enters the
 *  document as a NEW element when it is moved, and the browser is entitled to
 *  run it a second time — each product page ends in an inline module that
 *  fetches its own API, so a second run would be a second fetch and, on Work,
 *  a second set of listeners on the same controls. Nothing else in a Helmo
 *  page depends on being a direct child of <body>. */
function liftPage(): DocumentFragment {
  const page = document.createDocumentFragment()
  for (const node of [...document.body.childNodes]) {
    if (node instanceof Element && (node.tagName === 'SCRIPT' || node.id === CONFIG_ID)) continue
    page.append(node)
  }
  return page
}

/** Re-point each product stylesheet's `body` rules at the element its page now
 *  lives in.
 *
 *  Work and Roadmap put their reading column on <body> itself — `margin: 0
 *  auto; max-width: 1080px; padding: …` — so with the page inside the shell,
 *  <body> was still the centred 1080px box and the shell was centred with it:
 *  a sidebar hard against the left edge of the window and a header that
 *  started 132px in. Moving the rule rather than copying its computed values
 *  is what keeps the column responsive — the padding each of these pages
 *  changes under a media query goes on changing, because the declaration is
 *  the same declaration, read through a different selector.
 *
 *  `background` travels with it, and that is a no-op here by arithmetic rather
 *  than by luck: all three products define `--page: var(--background)`, which
 *  is the shell's own `bg-background`. */
function adoptBodyRules(sheets: StyleSheetList) {
  // Not `\bbody\b`: a word boundary also sits between `.` and `body`, so that
  // spelling rewrites Work's own `.body` and `.trow .body` classes into
  // nonsense selectors and silently drops the rules they carry.
  const BODY = /(?<![\w.#-])body\b/g

  // CSSStyleRule carries `cssRules` of its own now that CSS nesting exists, so
  // "has cssRules" no longer tells a grouping rule from a style rule. Asking
  // what the rule IS, then descending into whatever it nests, is the form that
  // does not quietly walk past every rule in the document.
  const repoint = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        // Assigned only when it changed, and never guarded by `BODY.test`:
        // a global regex carries its own lastIndex between calls, so test-
        // then-replace is a pair that works until someone reorders it.
        const repointed = rule.selectorText.replace(BODY, `#${PAGE_ID}`)
        if (repointed !== rule.selectorText) rule.selectorText = repointed
      }
      const nested = (rule as Partial<CSSGroupingRule>).cssRules
      if (nested) repoint(nested)
    }
  }

  for (const sheet of sheets) {
    if (sheet.href?.endsWith('/shell/shell.css')) continue
    try {
      repoint(sheet.cssRules)
    } catch {
      /* a stylesheet this document may not read is not one of ours */
    }
  }
}

function start() {
  const configElement = document.getElementById(CONFIG_ID)
  if (!configElement?.textContent) return
  const config = JSON.parse(configElement.textContent) as ShellConfig

  const page = liftPage()
  const root = document.createElement('div')
  root.id = ROOT_ID
  document.body.prepend(root)

  // Only now: the cut-down preflight in index.css must not reach the product
  // document, and until this line runs the product IS the document.
  adoptBodyRules(document.styleSheets)
  document.documentElement.classList.add('helmo-shell-ready')
  createRoot(root).render(<Shell config={config} page={page} />)
}

start()
