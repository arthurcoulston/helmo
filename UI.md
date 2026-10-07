# Helmo UI component contract

shadcn/ui is the required component foundation for Helmo. This applies to the
application shell, Overview, Team, Work, Roadmap, Runtime, embedded surfaces,
standalone entry points, and UI prototypes. Read this contract when designing,
building or reviewing any of them.

## Standard upstream implementation

The governing requirement is a completely standard shadcn/ui implementation,
compatible with full upstream upgrades, with zero customization or deviation.
This supersedes the earlier permission for estate-specific styling and the
compatibility wrapper used by the first shell preview.

Use the official installation and registry workflow. Arthur selected
[`--preset b6YWkyPAm`](https://ui.shadcn.com/create?preset=b6YWkyPAm) on
2026-10-06 (H-2957@dev.rev). It resolves to Nova; Mauve base, theme and chart
colors; Inter; small radius; Lucide; default menu color; subtle menu accent;
and an inherited heading font. Retain the existing Radix primitive explicitly
with `--base radix`: this preset code does not encode the primitive base.
The resulting style is `radix-nova`, with TypeScript/TSX and CSS variables.
This replaces the earlier neutral/system-font configuration.

Zero customization means no deviations from this official generated preset.
Its selected font, colors and radius are the approved baseline. Install directly
from upstream, without an estate checkout as an intermediate source or upgrade
dependency. Keep generated component source and styling unmodified. Do not add
font/theme overrides, custom CSS resets, cascade-layer changes, selector
rewrites, style overrides or patched component behavior.

Compose the application through documented shadcn components, props, variants
and block patterns in the standard React/Tailwind setup. The framework owns the
page styling. Replace the old DOM-adoption and runtime CSS-rewriting bridge;
preserving that bridge is not a migration requirement. Helmo's routes, data,
content and application behavior remain application code, separate from the
upstream components. Preserve their behavior while replacing their rendering.
If an existing requirement cannot be met by documented composition, identify
the exact conflict for a decision instead of inventing a local exception.

A matching appearance, a component import or equality with another project's
copies does not establish compliance. The comparison baseline is the recorded
official CLI output for the selected configuration, including its supported
alias/import and workspace transformations, not raw pre-transformation registry
bytes. Record the CLI version, retrieval date, resolved preset, lockfile and
generated-source hashes: pinning the CLI alone does not freeze remote registry
content.

### Official setup and workspace integration

The clean reference was generated with shadcn 4.21.3 using
`init --template vite --base radix --preset b6YWkyPAm --no-monorepo` in a
disposable directory. This is the reference recipe, not a command to overwrite
the Helmo repository. Use the official Vite/React/Tailwind v4 installation in
the frontend workspace. Keep its complete generated CSS imports, preset tokens,
base layer and font application, including the Inter package import and
`html` font baseline. Keep the standard `shadcn/tailwind.css` dependency; do not
eject it or hand-inline it. Use the generated Vite theme provider and its root
theme classes. Do not create a separate theme mechanism for embedded or
portalled content.

Configure `components.json` with the actual CSS path and supported aliases;
leave `tailwind.config` blank for Tailwind v4. A single frontend workspace can
own the UI components; unrelated backend packages need no shadcn scaffold. If
UI code is shared across frontend workspaces, follow the official monorepo
aliases/exports and component routing, keep style/icon/baseColor consistent,
and run the CLI from the consuming app. Do not rename/rebuild the whole
repository to imitate a starter's directory names.

For an existing initialized frontend, `shadcn apply b6YWkyPAm` is the official
preset migration command; inspect its effects in a disposable copy first.
Changing only `components.json`, or applying only theme/font, does not establish
full preset adoption. `shadcn preset resolve --json` must report `b6YWkyPAm`
with no fallbacks. For a fresh replacement frontend, initialize with the exact
preset and base above, then compose existing application behavior using it.

### Full upstream refresh and upgrades

shadcn distributes source code; upgrading the CLI or dependencies alone does
not update every installed component. Record the upstream version, preset,
component inventory and official refresh/upgrade commands. Prove in a disposable
copy that the entire installed component set can be refreshed without restoring
local patches, then build and exercise the application. Use the explicit
installed component inventory with `shadcn add <names...> --dry-run` / `--diff`,
then `--overwrite --yes` after reviewing the disposable result. `--all` means
all available registry components, not just those installed. Track registry
helpers/dependencies too; keep domain composition outside generated UI files
so an overwrite does not erase application behavior. Reconcile preset CSS and
documented migrations as well as components and package dependencies. When an
actual newer upstream version is available, test that upgrade and its documented migrations;
reinstalling the same version is refresh evidence, not a version-upgrade claim.
Future upstream breaking changes can require documented application migrations.
Compatibility means following that supported path without maintaining a fork.

## Use the components

The principal mappings are:

| UI responsibility | Foundation |
| --- | --- |
| Navigation and hiding the sidebar | `SidebarProvider`, `Sidebar`, `SidebarTrigger`, and the documented collapsible behavior |
| Simple and interactive tables | `Table`; the shadcn/ui Data Table composition where sorting/filtering or other table behavior is required |
| Charts | shadcn/ui Chart components and their documented chart-library composition |
| Actions and requests | Appropriate shadcn/ui buttons, fields, choice controls and forms |
| Disclosures and detail surfaces | Appropriate shadcn/ui Collapsible, Accordion, Dialog, Sheet, Popover or other documented component |
| Status, help and feedback | Appropriate shadcn/ui Badge, Alert, Tooltip, toast and related components |

These are component mappings, not decisions to add every listed component or
table feature to the product. The sidebar must be hideable using its existing
shadcn/ui capability; the trigger remains accessible. A space critique is not
authorization to replace the navigation framework.

## Header and separate windows

The sidebar show/hide trigger shares one compact header row with the current
view title and breadcrumb, when present, following the
[shadcn sidebar blocks](https://ui.shadcn.com/blocks/sidebar). Do not give the
menu toggle a separate row. Hiding the sidebar reclaims its complete column:
no collapsed icon rail or reserved navigation gutter remains. Use the standard
offcanvas collapse behavior; the trigger stays in the existing view header.
Use the selected generation's upstream header composition, including the
separator alignment. The inspected `radix-nova/sidebar-07` page uses
`data-vertical:h-4 data-vertical:self-auto` on its vertical separator; the
rejected preview omitted the alignment part. Follow the whole documented
composition rather than patching the generated Separator source.

Every page has an upper-right icon control in that same header row to open
the current page in a separate window. Use the shared shadcn icon Button and
Tooltip with an accessible name such as "Open in new window". Preserve the
current view context, including applicable filters and scope, and keep the
original window in place. Navigation and sidebar changes in one window must
not unexpectedly change another monitoring window.

Request the new window directly from the user's click. Browser preferences
and popup policies control the final window/tab behavior; verify the actual
supported desktop browsers and provide a usable fallback if opening is
blocked. Opening the page must not perform work actions or submit forms.
Initial sidebar visibility in the new window, automatic window placement,
and a particular multi-monitor arrangement have not been decided.

## Preserve the product while aligning it

Keep the agreed information architecture, product meanings and working
interactions. Resolve each widget's exact information and behavior
incrementally; do not turn broad subject areas into an assumed widget count or
window arrangement. Small, simultaneously visible monitoring windows require
efficient space use and readable content within the component system.

Preserve decision versus human-action versus sitting semantics, offered
choices, stale-answer protection, result links, copyable references, history,
refresh behavior, keyboard access and visible missing/stale data. Keep
installation isolation, API and route compatibility, and standalone entry
points intact. Component migration grants no new authority to mutate records,
dispatch work, release software or activate an installation.

Historical descriptions of zero-dependency HTML views and token-only adoption
describe the legacy implementation. They do not authorize new bespoke UI or
override this component requirement. Earlier estate-theme preservation does
not override the standard upstream styling requirement.

## Review and completion

A UI change names the upstream components/patterns it uses and the exact
product behavior it changes. Review the component source/imports and rendered
behavior, not appearance alone. Use actual components in prototypes too; if
the preview tool cannot render them, use component references to discuss the
decision rather than presenting a custom imitation as the implementation.

An alignment audit compares generated components, styling and composition
against the official baseline and inventories every rendered surface.
Alignment is complete only with zero local customization or deviation and
passing behavior, accessibility, theme and viewport checks. An outer shell
around bespoke inner views does not close the audit. Verify typography and
alignment visually, including portalled drawers/tooltips. Window acceptance
uses actual simultaneous windows and the blocked-popup path; a stubbed
`window.open` or navigating one page is not that evidence. Independent
reviewers check the exact candidate and full component refresh proof.

## Where this stands

The foundation is now a standard upstream implementation. `packages/shell` is
the official `shadcn@4.21.3` Vite project for `--base radix --preset
b6YWkyPAm` — Nova, Mauve, Inter, small radius, TSX, lucide — with `sidebar
breadcrumb card badge alert collapsible` and their dependencies installed from
the registry. Every generated file is byte-identical to what that CLI writes:
proven by regenerating the pin into a throwaway directory and comparing, not
by comparing with another project's copies. The custom DOM-adoption and
CSS-rewriting bridge is gone, preflight and the cascade layers are upstream's,
and the font baseline is the preset's own Inter, which is also what removes
the missing-font defect. The header divider follows the sidebar block's own
composition (`data-vertical:h-4 data-vertical:self-auto`), which is what
removes the misalignment.

`packages/shell/upstream.json` records the version, template, base, preset,
inventory, official commands, what the preset resolves to, and a sha256 per
generated file. The preset is an opaque code, so the generated files alone
cannot say which one produced them: `upstream:check` asks the CLI
(`preset resolve --json`) inside the project it just generated and fails if
that is not `b6YWkyPAm` with no fallbacks, and the offline test carries
Arthur's selection as a constant of its own, so a pin edited to a different
preset and refreshed is internally consistent and still fails.
`npm run upstream:check --workspace @helmo/shell` is the conformity proof and
`upstream:refresh` is the refresh path; `-- --cli <version>` aims either at a
newer release. 4.21.3 is the current latest, so the recorded evidence is a
same-version full refresh, not a version-upgrade claim.

**Roadmap is a compact reading.** Its groups are standard Data Tables — the
documented shadcn composition, which is TanStack Table v9's feature set
(`tableFeatures`, `useTable`, `table.FlexRender`) over the generated Table —
in the shared `packages/shell/src/RecordTable.tsx`. A row carries the rank,
the reference, the title, the server's own ranking explanation, the state and
the recorded usage estimate, in the groups and the ranked order the server
sends. Expanding a row shows the opening of the record, bounded at 320
characters and cut at a word boundary, plus the way into the full record:
it is an excerpt and is never presented as a summary, because no stored field
says in one line what a project is and deriving a sentence would put a meaning
in front of the reader that nobody wrote. The complete project — body, parked
reason and its exit, citations, claims, dependencies, history — is an
unmodified Sheet, opened from the title without expanding first. The old
"Waits on" and "Advances nothing stated" badges are gone: the server's
explanation already says both, under exactly the conditions the badges tested,
and only ever on a row that also carried the explanation. Nothing was decided
here about status or progress; that is R-46's question.

**Work is the same compact reading.** Its groups — in motion, ready, blocked,
standing, done, cancelled — are the same `RecordTable`, with columns chosen
for scanning: the reference and title, the stream/project/type beneath it,
the state, the priority, the owner, and when it last moved. A row also carries
the signals that should reach Arthur before he opens anything — what it waits
on, that it is on hold, a date it cannot start before, a stale release
handoff, a confidence below routine, an acceptance state, a closed ticket with
no evidence — in their short form only. The sentence behind a hold or a stale
handoff is in the record, exactly as Roadmap's parked reason is: a sentence in
a row is what made the cards tall. Expanding gives the record's own opening,
bounded the same way and never called a summary, plus the way in. The full
ticket is an unmodified Sheet reading in the order a reader wants it — what
the work is, what stands in front of it, the last recorded progress, what it
produced, its dependencies and history, and the recorded token and usage
figures last, where an estimate belongs rather than at the top of the record.

Decision needed, Action for you and Needs a sitting keep their own cards above
the tables, with their own controls, their complete question or action and the
answer path unchanged. A `#H-n` fragment naming one of them scrolls to that
card and opens no Sheet over it: a modal between Arthur and a request he came
to answer would be the one failure this surface cannot afford. The result
heading counts the results a ticket recorded and no longer calls that count
"recorded" — on the legacy records every purpose in it is the frozen
`kind === "url"` guess, and each line underneath already says so.

**All five areas now use the same standard application.** Overview, Work,
Roadmap, Team and Runtime share the official sidebar and components. Work,
Roadmap and Runtime standalone entry points serve that same built document;
`?section=awaiting` draws only the awaiting family and reports its count and
height to a same-origin embedding parent. All three legacy HTML/CSS renderers
are removed. Product behavior lives in `App.tsx`, `WorkRecord.tsx`,
`RoadmapView.tsx`, `TeamView.tsx` and `RuntimeView.tsx`; generated components,
hooks, theme provider and styles remain untouched official output.

The browser verification runs after `npm run prepare:cold && npm run build`
in a disposable checkout of the exact commit: `npm run verify:ui --workspace @helmo/shell`.
Never run it against the shared checkout's intentionally unchanged compiled
artifacts or rebuild that checkout as a workaround.
It uses synthetic stores and the managed headless browser, exercising actual
answers, copies, disclosures, two simultaneous windows, stale-answer refusal,
embedded sizing, failed refreshes, keyboard table scrolling and both themes at
390, 640 and 1280 pixels. `HELMO_AXE_SOURCE` may name an installed axe-core
script for a WCAG A/AA audit of every rendered layout. API tests retain
readiness, blocked-sitting, nonce/fingerprint and installation-isolation
coverage. Removed source-string tests described the superseded HTML/CSS, not
the browser's behavior; they do not define the new component structure.

`H-2940@dev.rev` and `H-2941@dev.rev` are the independent integrated reviews.

Two things in the build are upstream's behavior rather than product decisions,
kept because keeping the generated files unmodified is the requirement: the
template's theme provider stores a light/dark choice in `localStorage` and
toggles it on the `d` key. Window placement, a multi-monitor arrangement, and
initial sidebar visibility in a popped-out window remain undecided; the
application opens with the sidebar shown and reads no cookie back, so no
window moves another.

## Upstream references

- [Components and code distribution](https://ui.shadcn.com/docs)
- [Installation for Vite](https://ui.shadcn.com/docs/installation/vite)
- [CLI](https://ui.shadcn.com/docs/cli)
- [components.json](https://ui.shadcn.com/docs/components-json)
- [Monorepo integration](https://ui.shadcn.com/docs/monorepo)
- [Theming](https://ui.shadcn.com/docs/theming)
- [Vite dark mode](https://ui.shadcn.com/docs/dark-mode/vite)
- [Sidebar (Radix)](https://ui.shadcn.com/docs/components/radix/sidebar)
- [Table](https://ui.shadcn.com/docs/components/table)
- [Data Table](https://ui.shadcn.com/docs/components/data-table)
- [Chart](https://ui.shadcn.com/docs/components/chart)

Use the documentation for the selected component generation and primitive
variant. An upstream example is not permission to silently change the
project's established configuration.
