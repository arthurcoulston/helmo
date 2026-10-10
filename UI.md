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

### The one addition: four status colors

Arthur approved a four-role status palette on 2026-10-06 (H-2978@dev.rev) and
asked for it in the running dashboard. It is an **addition beside** the preset,
not a deviation from it, and the line between those is what the rest of this
section draws. What it permits is exactly the documented
[Adding New Tokens](https://ui.shadcn.com/docs/theming) path and the `className`
composition the [Badge](https://ui.shadcn.com/docs/components/radix/badge#custom-colors)
and [Alert](https://ui.shadcn.com/docs/components/radix/alert#custom-colors)
pages show: application tokens in an application stylesheet, named from
application components. It permits nothing else. No generated file changes, the
Mauve base/theme/chart colors, Inter and the radius are untouched, and
`upstream:check` still proves every generated file byte-identical.

The palette lives in `packages/shell/src/status.css` (eight tokens: an ink and a
tint per role, in light and dark) and its meanings live in
`packages/shell/src/Status.tsx` — one `StatusBadge`, one `StatusAlert`, and the
mapping from each domain state to a role. No area carries a hex or its own
severity rule.

| Role | Means | Light ink / tint | Dark ink / tint |
| --- | --- | --- | --- |
| `info` | information, in progress | `#496A8A` / `#EDF2F7` | `#A9C3DB` / `#26333F` |
| `success` | success, healthy | `#496B55` / `#EDF4EF` | `#AECBB7` / `#29372E` |
| `attention` | needs Arthur | `#886528` / `#FAF3E5` | `#D9BD87` / `#3D3424` |
| `failure` | failure, urgent intervention | `#8A4145` / `#F3D6D6` | `#E9B0B0` / `#563636` |

Three roles are Arthur's specimen exactly. `failure` is his revision of it
(H-2987@dev.rev, 2026-10-06), for something the specimen could not show him
until it was on a page: all four roles came out the same weight — the four light
tints measured 1.10, 1.12, 1.12 and 1.14 against white — so the role meaning
"this needs you now" carried no more weight than the one meaning "this is
waiting for you", and a reader had only the word to go on. The revision is the
tint above all, because at table density a chip's fill is what an eye crosses
the page to and its ink is four words. Same hue as the approved ink, chroma
still far below a saturated red, and the other three roles untouched.

Three rules make it a signal rather than decoration, and all three are enforced:

- **Ordinary and deliberate states take no color.** Queued work, a capacity
  hold, a dependency wait, a date gate, a parked project, a stopped or idle
  loop, and a closed ticket under a "Done" heading all stay the chrome they
  were. Colouring them is how a backlog starts looking like an incident, and
  then nothing stands out. Amber means Arthur; red means it has failed. A loop
  in `BLOCKED` is amber, not neutral: the neutral cases are the deliberate ones,
  and a blocked loop has downed tools and will not restart on its own — asked
  and answered rather than left to taste.
- **Red outranks amber.** `failure`'s tint stands off the ground it is on by at
  least 0.2 more than any other role's, in both themes. Asserted as an ordering
  with a floor under the margin rather than as four fixed ratios, because the
  point is the relationship: a later revision may move any of these colours, and
  what must not survive it is failure quietly flattening back to the rest.
- **Color is never the carrier.** The tint is deliberately 1.10–1.87:1 against
  its surface, so even the loudest of them cannot meet the 3:1 a meaningful
  non-text indicator would need — which is exactly why every role is applied to
  something that already says what it means in words. The ink is what is
  measured: ≥4.5:1 on its own tint and on every preset surface it can land on
  bare, including a row while it is hovered and while it is expanded.

`test/status-palette.test.mjs` holds the tokens, the meanings, the arithmetic
and the ordering; Arthur's approved hexes are written out there the way his
preset selection is written out in `test/upstream.test.mjs`, so the file cannot
check itself against itself. `scripts/verify-ui.mjs` measures the computed colors of
every rendered role on every layout in both themes, finds them by the
`data-status-role` marker rather than by the selectors this change touched, and
fails if a role is never rendered at all — an unpainted palette would otherwise
pass every assertion above it. It checks the red-outranks-amber ordering too, on
the rendered fills and on each ground a chip was actually found standing on, and
refuses to pass unless failure and `attention` were really compared on one
ground in both themes.

Two things about how it reads a color, because both were wrong once and each
hid the other. **The renderer resolves every value, not a regex.** Preset
surfaces are declared in `oklch` and `getComputedStyle` returns them that way,
so a reader of the numeric components gets a colour that does not exist; each
value is painted to a 1×1 canvas and read back in sRGB instead. **Translucent
layers are composited.** Upstream's `TableRow` tints a hovered and an expanded
row with `bg-muted/50`, so a ratio against the declared colour is one nobody is
looking at. Both row states are measured, and each must be shown to have
actually moved the surface before a role on it is read. There is no selected
state to measure — the product never sets `data-[state=selected]`. A closing
assertion keeps that sound as the product grows: every role in a row paints its
own opaque tint, which is the real reason a row's hover cannot change a ratio,
and `inkRole` in a row is what would break it.

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
menu toggle a separate row. Use the standard icon-collapse behavior: a fresh
desktop window starts collapsed with its icon rail visible, and each window
keeps its own explicit choice across refreshes. The trigger stays in the
existing view header; mobile retains the generated offcanvas behavior.
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

A light/dark icon control sits immediately beside that popout control and uses
the generated theme provider, including its stored choice. Work's group-count
badges follow its title in the header; an Archived badge and the completed-list
footer both lead to the existing whole-record reading. Content does not repeat
the page title already present in the header.

Request the new window directly from the user's click. Browser preferences
and popup policies control the final window/tab behavior; verify the actual
supported desktop browsers and provide a usable fallback if opening is
blocked. Opening the page must not perform work actions or submit forms.
The application supplies no size or placement after the initial open request:
browser policy chooses the initial window, and later polling, navigation and
reload must not resize, reposition or recreate it.

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
for scanning: the title and, beside it where the column affords both, the
reference; the stream/project/type beneath them; the state, the priority, the
owner, and when it last moved. Those columns do not fit a phone, and the record
column's floor is what decides where the horizontal fold falls: a row's work and
its state stay inside a 390 window, and the priority, owner and last movement
are what the region's label offers to scroll for. Until H-2946@dev.rev that
floor was wider and the fold ran through the State badge on every table in both
areas — Work read "In moti" at 390 (H-2981@dev.rev) and Roadmap cut its state
harder still. A row also carries the signals that should reach Arthur before he opens anything — what it waits
on, that it is on hold, a date it cannot start before, a stale release
handoff, a confidence below routine, an acceptance state, a closed ticket with
no evidence — in their short form only. The sentence behind a hold or a stale
handoff is in the record, exactly as Roadmap's parked reason is: a sentence in
a row is what made the cards tall. Expanding gives two readings and names each
for what it is — where the record stands, from its latest recorded progress
note, and how the record opens, verbatim and bounded the same way — plus the
way in. Neither is ever called a summary, because no stored field is one
(H-2988): a sentence composed here would read as authored and nobody wrote it.
Both are shown rather than whichever is better, because each alone goes blind
on real records — a cluster filed in one pass shares one opening, a cluster
moved in one pass shares one note. The full
ticket is an unmodified Sheet reading in the order a reader wants it — what
the work is, what stands in front of it, the last recorded progress, what it
produced, its dependencies and history, and the recorded token and usage
figures last, where an estimate belongs rather than at the top of the record.

**A view's groups line up, and the geometry is the view's own.** Each group is
its own table, and under automatic layout each sized its columns from its own
content: a group holding a row that waits on two tickets had a wider minimum
than one that did not, so Work's State column began at x317 in two groups and
x340 in the third, and the eye had no straight edge to run down (H-2988@dev.rev).
`RecordTable` lays its columns out fixed, so every column is the width it asks
for and the groups of one view agree by construction. Three consequences are
load-bearing.

The record column's floor cannot be a minimum on the cell — fixed layout does
not consult one — so it is the table's own `minWidth`, which each view states as
its fixed columns plus that floor; a column widened without it moves the fold.
Roadmap's floor is smaller than Work's, because the rank column in front of it
spends width Work's does not.

Which columns that floor has to keep inside a 390 window is each view's own
call, declared beside the widths as `RecordTable`'s `aboveFold` and carried to
the browser as `data-above-fold`: Work's work and state, Roadmap's project and
state, Team's member and context, Runtime's loop and that loop's state.
Runtime's loop table is not a `RecordTable` — it has no expanding record and
drives no TanStack table — but it declares the same geometry in its own file:
`table-fixed`, a width per column, a floor of 944, and State as the `w-full`
column, because State is the one holding prose. `verify:ui` measures exactly
what a table declares, fails naming any column the fold cuts, and fails a table
that declares nothing at all. Until H-3001@dev.rev it instead measured whatever column was named
`state` — so it read Work and Roadmap, and read neither Team, whose state badge
lives inside its member cell, nor Runtime, which named no column at all. A view
could have put its own subject beyond the fold under a green run; the point of
the declaration is that the skip is impossible rather than unlikely.

Every other column declares what the real record actually asks it to carry, plus
the cell's padding, because under fixed layout a column keeps what it declares
whether it needs it or not, and what it keeps it takes from the title. Those
widths are measurements rather than round numbers: across 2,988 records the
widest state is "Cancelled" at 76px, the latest movement "Aug 28, 12:44 AM" at
102px, the largest project estimate "$175.01" at 59px, and the disclosure
control 28px. Runtime's are measured the same way on the live roster: its loop
45px, State's badge 75, workstream 111, a current loop's runtime and model 111,
pace 34, spend's token line 124, the trace control 105.

Two things are the exception and wrap rather than widen a column for one row.
Work's assignee: the record holds a `claude-code-interactive` from before
assignees were short names. Runtime's model: a parked loop still runs
`claude-haiku-4-5-20251001`, a dated id from the same era. What fixed layout
gives up is the browser's own guarantee that content fits, so `verify:ui` fails
on anything wider than the column holding it: a longer word goes red rather
than reaching into its neighbour. That is measured as geometry — every
descendant's right edge against the cell's content box, plus the cell's own
text where it cannot wrap. It read the direct children's widths until
H-3048@dev.rev, which left a control behind a block child invisible (Runtime's
trace button sits inside a Collapsible's div, and a block reports the cell's
width however far the button reaches) and the text of a `whitespace-nowrap`
cell invisible too, which upstream's `TableCell` is by default. A column
declared at 105px under what it held passed that reading and fails this one.

And because the geometry no longer depends on which records are in a group,
measuring it on a fixture measures the product. The same floor that clears the
fold by 24px on Work's fixtures clears it by 24px on the real record, where
automatic layout had the live Blocked group's state still cut by 32px at 390
while the fixtures passed.

What a fixture still cannot do is make a column meet the widest words that
exist, which is why a fixture row has to carry them. All three of Runtime's
fixture loops were on `workstream = "fixture"` and `model = "fixture-model"`,
so nothing in the run came near a declared width and leaving those columns
`whitespace-nowrap` was green — while the live roster spilled 15px and 57px.
One fixture loop now carries the live roster's widest workstream and that dated
model id, and the figures match exactly. A column sized under its content is a
decision; the fixture row is what keeps it one.

Two things on Runtime the fixture still does not hold, stated so nobody reads
its green as covering them. **`table-fixed` itself**: with the floor and the
widths in place, taking fixed layout away leaves the fixture's content inside
944 and nothing goes red — the page-overflow assertion only fires once content
reaches the slot, which is the content-dependence this all removes. A fixture
loop named long enough to force it would have to be ~20 characters past any
real seat name, and such a name spills Team's member column by 106px, so the
fixture would be distorting a second view to assert on this one. The live
geometry probe is what holds this. **State's 256**: the reason paragraph wraps,
so narrowing that column does not spill anything — it just turns prose into a
tall ribbon. The fold bounds the column from above; nothing bounds it from
below, and the number is a judgement the comment at the call site has to carry.

That 106px on Team's member column is itself a latent defect the widened spill
reading surfaced: like Runtime's before this, it is a `whitespace-nowrap`
column that only fits because every seat name today is short.

Decision needed, Action for you and Needs a sitting keep their own cards above
the tables, with their own controls, their complete question or action and the
answer path unchanged. A `#H-n` fragment naming one of them scrolls to that
card and opens no Sheet over it: a modal between Arthur and a request he came
to answer would be the one failure this surface cannot afford. The result
heading counts the results a ticket recorded and no longer calls that count
"recorded" — on the legacy records every purpose in it is the frozen
`kind === "url"` guess, and each line underneath already says so.

**Overview opens with what got done.** The first of Arthur's selected widgets
(R-44) is one wide Card of up to six completed records from a rolling 24-hour
window, composed from the generated Card, Badge, Button and Separator in
`packages/shell/src/RecentResults.tsx`. Category, review state and delivery are
words first and styling second, so removing the colour loses nothing — the
four status roles are applied through `StatusBadge` exactly as elsewhere. A
result ref reuses the Work record's own `Reference`, so reachability and copy
behaviour are one implementation rather than two surfaces that eventually
disagree about whether a ref opens. Nothing is inferred: a record whose author
never said what it produced reads *Completion account missing*, an old
ticket's routing noun shown as a category is labelled *from its type*, and an
empty window says so rather than drawing nothing. The window itself comes from
the server with the rows, so a card held over from a failed refresh labels the
window it describes instead of being redrawn against the browser's clock.

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
390, 640 and 1280 pixels. At 390 it also measures where each record table's
fold falls, by `data-column` rather than by the words in a cell; the page
itself never overflows there — the table scrolls inside its own container — so
no other measurement in the run can see a state cut in half. At every width it
compares the column geometry of a view's groups against each other, by offset
and width from each table's own left edge, and fails naming the shapes that
disagree; it also fails on anything inside a cell reaching past the column
holding it.

It asserts at every width that the page itself does not scroll sideways, and
that assertion is only as good as the declarations behind it. It was green for
as long as Runtime's loop table sized itself from its content: the automatic
minimum of a table 995px wide in a 992px slot reached out through the scrollable
container to `SidebarInset` and scrolled the whole page by 3px at 1280, on a
roster this run does not hold (H-3048@dev.rev). Three readings, each measured on
the running release rather than reasoned about: `overflow: hidden` on the
container does NOT stop that — it is `container-type: inline-size`, which the
three `RecordTable` views carry for their sticky previews, that does; declaring
the geometry stops it at 390, 640 and 1280 on its own; and declaring it is the
one of the two that leaves this assertion able to fire here again, because
containment would have hidden the content-dependence rather than removed it.

**A control an outside check drives carries a name.** `data-column` is one,
`data-above-fold` the declaration it is measured against; the Ratify button's
`data-helmo-control="ratify"` is the other. The estate's
acceptance smoke (`npm run smoke` in `~/projects/estate`) drives the running
app, so it can only address a control through the DOM — and addressing it by
its visible words means a reworded label silently turns that stop into "no
question to answer" rather than red (H-2998). Rename or restyle freely; keep
the hook. Every one of those 30 layouts is audited against
WCAG 2 A/AA by axe-core, a devDependency of `@helmo/shell` resolved from the
package — there is nothing to set and no way to skip it, and the run asserts
the audit count so a layout that went unaudited is a failure rather than a
quiet omission. A clean `verify:ui` is therefore accessibility evidence; before
H-2982@dev.rev it was not, because the audit ran only when `HELMO_AXE_SOURCE`
named an out-of-tree copy and was silently absent by default. API tests retain
readiness, blocked-sitting, nonce/fingerprint and installation-isolation
coverage. Removed source-string tests described the superseded HTML/CSS, not
the browser's behavior; they do not define the new component structure.

`H-2940@dev.rev` and `H-2941@dev.rev` are the independent integrated reviews.

**Team reads what a seat is configured to carry, and what it spent.** Its one
`RecordTable` gives the configured-context composition the column after the
member, because context is what this view is for; memory, period tokens and
notional dollars are what the region's label offers to scroll for. The
composition bar is the preset's own chart colours — a category is not a
severity, and the four status roles keep their meanings.

Width was not enough to make it the page's subject, and the two findings that
say so are gauge's on the shipped page (H-3003@dev.rev). It was already the
widest column after the member and still lost the glance to that member's bold
name and solid status badge, so the answer is weight rather than more width: a
12px bar and its total at the body size. The badge is deliberately untouched —
its colour and weight belong to the shared status system, and a view that
restyled one surface's badge is how one state ends up two weights on two
pages. And the preset's chart tokens resolve to a near-monochrome value ramp in
both themes, so three hues read as two tones. The colours stay the preset's, so
position carries the composition instead and is made visible: a gap draws every
segment boundary in the track's own colour, which holds whatever the hues do,
and the legend states that it reads left to right along the bar. Colour was
never the carrier here — the bar's `aria-label` and the legend both say the
real numbers in words — but a bar that promises a composition has to show one.

A row states what the roster configured and never what ran, because it sits
beside a live state badge. A seat that rotates has no single configured model,
so the row refuses to pick one of them: it says how many there are and how one
is chosen, the Sheet names them all, and `by_model` — the one reading on the
page taken from what sessions really did — carries its own heading saying so.
Reporting only the primary was the original reading, and on this installation
it showed mason as `gpt-5.6-sol` beside a RUNNING badge while the session
running was `claude-opus-5` (H-3001@dev.rev). A member opens in an
unmodified Sheet: every configured file with its size, its own `cap_tokens` and
a bounded reading of it, the memory corpus beside the startup total rather than
inside it, the overhead nobody can measure named rather than left at zero, and
the period's usage by model and by day. Three distinctions are load-bearing and
each is asserted in `verify:ui` on a fixture configured to exercise it — what
Rev composes against what the CLI discovers, what loads at startup against what
is available to read, and what is measured against what is not. Only two states
take colour: a file over its ratified cap is amber because only Arthur ratifies
a new one, and one the shim cannot read is red because that seat's next launch
already fails. `tight` and `uncapped` stay neutral — a file deliberately kept
near its cap is the system working. No whole-session cap is shown, because none
is configured and a model's context window is not one.

**The four status colors are in.** Work's state and signal badges, Roadmap's
state badges, the three awaiting-request chips, Runtime's supervisor, loop
states and usage severities, and every alert now read in the approved roles;
everything deliberate or ordinary stayed neutral. `src/status.css` and
`src/Status.tsx` are the only places a status color or its meaning is written.
The stock `destructive` variant is no longer used for an application failure:
one bright red beside a muted palette was the inconsistency Arthur asked to
remove, and the dusty red measures better on both themes than the stock value
did. A refresh that failed while the last good reading is still on screen is
amber, not red — nothing is broken for the reader, the reading is just old.

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
