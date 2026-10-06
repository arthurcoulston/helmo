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

Use the official installation and registry workflow for one recorded upstream
version and preset. The selected configuration remains `radix-nova`, neutral,
TypeScript/TSX and lucide; use that preset's upstream defaults. Install directly
from upstream, without an estate checkout as an intermediate source or upgrade
dependency. Keep generated component source and styling unmodified. Do not add
custom fonts, theme tokens, CSS resets, cascade-layer changes, selector rewrites,
style overrides or patched component behavior.

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
official registry output for the selected configuration.

### Full upstream refresh and upgrades

shadcn distributes source code; upgrading the CLI or dependencies alone does
not update every installed component. Record the upstream version, preset,
component inventory and official refresh/upgrade commands. Prove in a disposable
copy that the entire installed component set can be refreshed without restoring
local patches, then build and exercise the application. When an actual newer
upstream version is available, test that upgrade and its documented migrations;
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

The first shell preview uses real components but does not meet the standard
upstream implementation requirement. It has a custom DOM/CSS compatibility
layer, a missing font baseline and a misaligned header divider. It is not an
accepted foundation. Everything inside it — Work's rows,
requests and disclosures, Roadmap's list, Runtime's table, the app page's
cards — is still hand-written HTML each product renders for itself. The
remaining foundation and app cards belong to `H-2933@dev.rev`; Work requests
and records to `H-2936@dev.rev` and `H-2937@dev.rev`; Roadmap to
`H-2938@dev.rev`; Runtime to `H-2939@dev.rev`. Independent integrated reviews
are `H-2940@dev.rev` and `H-2941@dev.rev`. A shadcn/ui outer shell around
bespoke inner views does not close that audit. `DEV.md` records the existing
implementation and its rejected-foundation status for a coding session.

The current preview starts with the sidebar shown in every window. That is
an implementation default for Arthur to review in `H-2932@dev.rev`, not an
agreed product decision. Independent window state is required: one window's
trigger never moves another's. The component currently writes its
`sidebar_state` cookie, and nothing reads it back. Window placement and a
particular multi-monitor arrangement remain undecided. H-2932 records the
preview review and standard-upstream direction; H-2933 replaces the foundation
before the surface migrations proceed.

## Upstream references

- [Components and code distribution](https://ui.shadcn.com/docs)
- [Installation for Vite](https://ui.shadcn.com/docs/installation/vite)
- [CLI](https://ui.shadcn.com/docs/cli)
- [Sidebar (Radix)](https://ui.shadcn.com/docs/components/radix/sidebar)
- [Table](https://ui.shadcn.com/docs/components/table)
- [Data Table](https://ui.shadcn.com/docs/components/data-table)
- [Chart](https://ui.shadcn.com/docs/components/chart)

Use the documentation for the selected component generation and primitive
variant. An upstream example is not permission to silently change the
project's established configuration.
