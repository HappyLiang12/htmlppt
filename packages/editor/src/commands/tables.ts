import {
  tableColumnCount,
  tableHasHeaderRow,
  tableRowCount
} from '@htmlppt/core';

export type TableAction =
  | { type: 'row'; position: 'above' | 'below' }
  | { type: 'delete-row' }
  | { type: 'column'; position: 'left' | 'right' }
  | { type: 'delete-column' }
  | { type: 'toggle-header' };

export interface TableSelectionContext {
  table: Element;
  tablePath: number[];
  cell: HTMLTableCellElement;
  cellPath: number[];
  row: number;
  column: number;
  rows: number;
  columns: number;
  header: boolean;
}

function rowsOf(table: Element): HTMLTableRowElement[] {
  const rows: HTMLTableRowElement[] = [];
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'tr') {
      rows.push(child as HTMLTableRowElement);
    } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const row of Array.from(child.children)) {
        if (row.tagName.toLowerCase() === 'tr') {
          rows.push(row as HTMLTableRowElement);
        }
      }
    }
  }
  return rows;
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter((child) => {
    const tag = child.tagName.toLowerCase();
    return tag === 'td' || tag === 'th';
  });
}

/**
 * Resolves the selected cell and its table from a raw child path. Returns null
 * when the selection is not inside a simple (non-nested) table cell.
 */
export function tableContext(
  slide: Element,
  path: readonly number[]
): TableSelectionContext | null {
  let current: Element = slide;
  let table: Element | null = null;
  let tablePath: number[] = [];
  let cell: HTMLTableCellElement | null = null;
  let cellPath: number[] = [];

  for (let index = 0; index < path.length; index += 1) {
    const child = current.children[path[index] ?? -1];
    if (!child) return null;
    current = child;
    const tag = current.tagName.toLowerCase();
    if (tag === 'table') {
      table = current;
      tablePath = path.slice(0, index + 1);
    } else if (tag === 'td' || tag === 'th') {
      cell = current as HTMLTableCellElement;
      cellPath = path.slice(0, index + 1);
    }
  }

  if (!table || !cell || !table.contains(cell)) return null;
  if (table.querySelector('table')) return null;
  const row = rowsOf(table).indexOf(cell.parentElement as HTMLTableRowElement);
  const column = cellsOf(cell.parentElement as Element).indexOf(cell);
  if (row < 0 || column < 0) return null;
  try {
    return {
      table,
      tablePath,
      cell,
      cellPath,
      row,
      column,
      rows: tableRowCount(table),
      columns: tableColumnCount(table),
      header: tableHasHeaderRow(table)
    };
  } catch {
    return null;
  }
}
