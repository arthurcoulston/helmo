/* The compact reading every area shares: upstream's Table driven by TanStack
   Table v9's feature set, with one disclosure row under an expanded record.
   Roadmap composes it in RoadmapView; Work's compact reading is H-2974, and
   this is the module it extends rather than a second table framework. */
import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import { createExpandedRowModel, rowExpandingFeature, tableFeatures, useTable, type ColumnDef, type ExpandedState, type RowData } from "@tanstack/react-table"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export const features = tableFeatures({
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
  columnMeta: {} as { className?: string },
})
export type RecordColumn<T extends RowData> = ColumnDef<typeof features, T>

/* The one short reading a row can carry: verbatim from the start of the
   record, cut at a word boundary. It is an excerpt and never a summary — no
   stored field says in one line what a record is about, and deriving a
   sentence here would put a meaning in front of Arthur that nobody wrote.
   Nothing is lost: the full record is one control away. */
export function excerpt(text: string, limit = 320) {
  const whole = text.trim()
  if (whole.length <= limit) return { text: whole, truncated: false }
  const cut = whole.slice(0, limit)
  const boundary = cut.lastIndexOf(" ")
  return { text: `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`, truncated: true }
}

/* The first column carries the record itself and takes whatever width is left
   over: `w-full`, which under the `table-fixed` below is how one column absorbs
   the remainder while every other keeps exactly the width it asks for.

   Its floor cannot live here. Fixed layout never consults a cell's min-width —
   measured, not assumed: a column asking for 100% of a table narrower than its
   siblings resolves to zero — so the floor is the TABLE's `minWidth`, which
   each view states as its own fixed columns plus that floor. The floor is also
   what decides where the horizontal fold lands on a phone, and at 64 it put the
   fold through the State badge: Work read "In moti" at 390 and Roadmap cut
   "Ship next" harder still (H-2981). A row's two load-bearing columns are the
   work and what state it is in, so the floor is the widest one that keeps both
   inside a 390 window; the columns after them are what the region's label
   offers to scroll for. `verify:ui` measures the fold there, so a column
   widened without its view's floor goes red rather than quietly clipping. */
export const recordColumn = "w-full whitespace-normal"

/* `has-aria-expanded:bg-muted/50` on upstream's TableRow is what tints the
   open row, so the toggle has to carry the state in aria rather than a class. */
export function expandColumn<T extends RowData>(label: (row: T) => string): RecordColumn<T> {
  return {
    id: "expand",
    header: () => <span className="sr-only">Summary</span>,
    cell: ({ row }) => <Button variant="ghost" size="icon-sm" aria-expanded={row.getIsExpanded()} onClick={row.getToggleExpandedHandler()}>
      <ChevronRightIcon className={`transition-transform ${row.getIsExpanded() ? "rotate-90" : ""}`} />
      <span className="sr-only">{label(row.original)}</span>
    </Button>,
    /* 44px: the 28px control plus the cell's own padding. Automatic layout
       used to find this for itself; under `table-fixed` a column that declares
       less simply lets its control reach into the next one. */
    meta: { className: "w-11" },
  }
}

export function RecordTable<T extends RowData>({ label, minWidth, aboveFold, columns, rows, rowId, expanded, onExpandedChange, renderExpanded, empty }: {
  label: string
  /* The view's own floor, as a literal Tailwind class — Tailwind generates from
     source text, so a width composed here would name a rule that does not
     exist. See `recordColumn` for what the number has to be. */
  minWidth: string
  /* The columns this view says a reader must be able to read at 390 without
     scrolling. `verify:ui` measures these and fails naming any one the fold
     cuts, which is what makes the floor above a decision rather than a comment.
     It has to be declared here, with the widths, rather than known by the
     check: the check keyed on a column named "state" instead, and Team — whose
     state badge lives inside its member cell — had no such column, so its fold
     was never measured at all while the two views that happened to have one
     were (H-3001). */
  aboveFold: string[]
  columns: RecordColumn<T>[]
  rows: T[]
  /* Keyed by the record's own id, so expansion survives a refresh that
     reorders or re-ranks the rows rather than following a row index. */
  rowId: (row: T) => string
  expanded: ExpandedState
  onExpandedChange: React.Dispatch<React.SetStateAction<ExpandedState>>
  renderExpanded: (row: T) => React.ReactNode
  empty: string
}) {
  /* autoResetExpanded defaults on, and a fifteen-second refresh replaces the
     row array — which would close every open row on every poll. Expansion is
     the reader's state, not the data's. */
  const table = useTable({ features, data: rows, columns, getRowId: (row) => rowId(row), getRowCanExpand: () => true, autoResetExpanded: false, state: { expanded }, onExpandedChange })
  const body = table.getRowModel().rows
  /* The region label and the focusable table are RuntimeView's pattern: a
     narrow window scrolls these columns, and the keyboard has to reach it. */
  /* `table-fixed`, so a column is the width it asks for and nothing more. Under
     auto layout each group sized its own table from its own content — a row
     carrying "Waits on H-2946, H-2948" has a wider minimum than one that does
     not — so Work's State column started at x317 in two groups and x340 in the
     third, and the eye had no straight edge to run down. Fixed layout takes
     every width from the header row, and the groups all share one of those. */
  return <div className="min-w-0 overflow-hidden rounded-md border" role="region" aria-label={`${label} — scroll horizontally for all columns`}>
    <Table tabIndex={0} aria-label={label} data-above-fold={aboveFold.join(" ")} className={`table-fixed ${minWidth}`}>
      <TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id} className="hover:bg-transparent">
        {/* `data-column` is how the browser verification addresses a column —
            by what it IS rather than by the words a cell happens to hold, so
            measuring where the fold falls does not break on a renamed state. */}
        {group.headers.map((header) => <TableHead key={header.id} data-column={header.column.id} className={header.column.columnDef.meta?.className}>
          {header.isPlaceholder ? null : <table.FlexRender header={header} />}
        </TableHead>)}
      </TableRow>)}</TableHeader>
      <TableBody>
        {body.length ? body.map((row) => <React.Fragment key={row.id}>
          <TableRow id={row.id}>
            {/* getAllCells, not getVisibleCells: hiding columns is a feature
                this table does not opt into, so that method is not here. */}
            {row.getAllCells().map((cell) => <TableCell key={cell.id} data-column={cell.column.id} className={cell.column.columnDef.meta?.className}>
              <table.FlexRender cell={cell} />
            </TableCell>)}
          </TableRow>
          {row.getIsExpanded() ? <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns.length} data-expanded-for={row.id} className="whitespace-normal bg-muted/50 px-3 pb-3">{renderExpanded(row.original)}</TableCell>
          </TableRow> : null}
        </React.Fragment>) : <TableRow className="hover:bg-transparent">
          <TableCell colSpan={columns.length} className="h-16 whitespace-normal text-center text-muted-foreground">{empty}</TableCell>
        </TableRow>}
      </TableBody>
    </Table>
  </div>
}
