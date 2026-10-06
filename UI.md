# Helmo UI component contract

shadcn/ui is the required component foundation for Helmo. This applies to the
application shell, Overview, Team, Work, Roadmap, Runtime, embedded surfaces,
standalone entry points, and UI prototypes. Read this contract when designing,
building or reviewing any of them.

## Use the components

Use actual shadcn/ui component source and the official documented composition
patterns. Reuse the project's shared components; add missing components from
the upstream registry using the agreed configuration. Preserve upstream source
provenance and make local changes legible. A matching appearance, a dependency
name, or shared design tokens alone does not establish adoption.

Use documented props, variants, composition and the approved theme to meet
product requirements. Do not substitute a hand-written lookalike, another
component system, or a new navigation design where shadcn/ui supplies the
component or pattern. Ordinary layout markup and domain/data logic still
belong to Helmo. If a needed capability is absent, identify that specific gap
for a product decision instead of silently choosing a different foundation.

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

## Preserve the product while aligning it

Keep the agreed information architecture, theme, product meanings and working
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
override this component requirement. Theme tokens remain shared; they are not
a substitute for adopting the components.

## Review and completion

A UI change names the upstream components/patterns it uses and the exact
product behavior it changes. Review the component source/imports and rendered
behavior, not appearance alone. Use actual components in prototypes too; if
the preview tool cannot render them, use component references to discuss the
decision rather than presenting a custom imitation as the implementation.

An alignment audit inventories every rendered surface and maps each remaining
custom component to its replacement. Alignment is complete only when the
inventory has no unexplained deviations and the actual served surfaces pass
the applicable behavior, accessibility, theme and viewport checks. Adding a
configuration file or a shadcn/ui outer shell while retaining bespoke inner
views does not close the audit.

## Upstream references

- [Components and code distribution](https://ui.shadcn.com/docs)
- [Sidebar](https://ui.shadcn.com/docs/components/sidebar)
- [Table](https://ui.shadcn.com/docs/components/table)
- [Data Table](https://ui.shadcn.com/docs/components/data-table)
- [Chart](https://ui.shadcn.com/docs/components/chart)

Use the documentation for the selected component generation and primitive
variant. An upstream example is not permission to silently change the
project's established configuration.
