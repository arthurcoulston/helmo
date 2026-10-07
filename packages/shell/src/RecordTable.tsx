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
    meta: { className: "w-8" },
  }
}

export function RecordTable<T extends RowData>({ label, columns, rows, rowId, expanded, onExpandedChange, renderExpanded, empty }: {
  label: string
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
  return <div className="min-w-0 overflow-hidden rounded-md border" role="region" aria-label={`${label} — scroll horizontally for all columns`}>
    <Table tabIndex={0} aria-label={label}>
      <TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id} className="hover:bg-transparent">
        {group.headers.map((header) => <TableHead key={header.id} className={header.column.columnDef.meta?.className}>
          {header.isPlaceholder ? null : <table.FlexRender header={header} />}
        </TableHead>)}
      </TableRow>)}</TableHeader>
      <TableBody>
        {body.length ? body.map((row) => <React.Fragment key={row.id}>
          <TableRow id={row.id}>
            {/* getAllCells, not getVisibleCells: hiding columns is a feature
                this table does not opt into, so that method is not here. */}
            {row.getAllCells().map((cell) => <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
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
