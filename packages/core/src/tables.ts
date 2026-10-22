import { appendObject } from './mutations.js';
import { DeckMutationError } from './target.js';

export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLUMNS = 20;
export const TABLE_CELL_PADDING = '8px 12px';
export const TABLE_CELL_BORDER = '1px solid #b9b2a3';

export interface InsertTableOptions {
  rows: number;
  columns: number;
  header?: boolean;
  x?: number;
  y?: number;
  width?: number;
}

function fail(message: string): never {
  throw new DeckMutationError('invalid-table', message);
}

function checkCount(value: number, limit: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    fail(`${label} must be a positive integer.`);
  }
  if (value > limit) {
    fail(`${label} must be at most ${limit}.`);
  }
  return value;
}

function requireTable(element: Element): HTMLTableElement {
  if (element.tagName.toLowerCase() !== 'table') {
    fail('The target is not a table.');
  }
  if (element.querySelector('table')) {
    fail('Nested tables are not supported.');
  }
  return element as HTMLTableElement;
}

function rowsOf(table: HTMLTableElement): HTMLTableRowElement[] {
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

function cellsOf(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return Array.from(row.children).filter((child) => {
    const tag = child.tagName.toLowerCase();
    return tag === 'td' || tag === 'th';
  }) as HTMLTableCellElement[];
}

function columnCount(table: HTMLTableElement): number {
  return rowsOf(table).reduce(
    (maximum, row) => Math.max(maximum, cellsOf(row).length),
    0
  );
}

/**
 * Structural edits index cells by position, so merged cells would be
 * corrupted. Reject them before any mutation instead.
 */
function requireNoMergedCells(table: HTMLTableElement): void {
  for (const cell of Array.from(table.querySelectorAll('td, th'))) {
    for (const name of ['colspan', 'rowspan']) {
      const value = cell.getAttribute(name);
      if (value !== null && Number(value) > 1) {
        fail('Tables with merged cells do not support row or column changes.');
      }
    }
  }
}

function checkRow(table: HTMLTableElement, at: number): HTMLTableRowElement[] {
  const rows = rowsOf(table);
  if (!Number.isInteger(at) || at < 0 || at >= rows.length) {
    fail(`Row ${at} is outside this table (0-${rows.length - 1}).`);
  }
  return rows;
}

function checkColumn(table: HTMLTableElement, at: number): number {
  const columns = columnCount(table);
  if (!Number.isInteger(at) || at < 0 || at >= columns) {
    fail(`Column ${at} is outside this table (0-${columns - 1}).`);
  }
  return columns;
}

function cellElement(
  document: Document,
  header: boolean
): HTMLTableCellElement {
  const cell = document.createElement(header ? 'th' : 'td');
  if (header) cell.setAttribute('scope', 'col');
  cell.setAttribute('style', `border: ${TABLE_CELL_BORDER}; padding: ${TABLE_CELL_PADDING};`);
  return cell as HTMLTableCellElement;
}

/**
 * Inserts a top-level table object. Rows include the optional header row, so
 * row coordinates used by every table operation match the visual order.
 */
export function insertTable(
  slide: Element,
  options: InsertTableOptions
): Element {
  const rows = checkCount(options.rows, MAX_TABLE_ROWS, 'Table rows');
  const columns = checkCount(
    options.columns,
    MAX_TABLE_COLUMNS,
    'Table columns'
  );
  const geometry = [options.x, options.y, options.width].filter(
    (value): value is number => value !== undefined
  );
  if (geometry.some((value) => !Number.isFinite(value))) {
    fail('Table geometry must be finite.');
  }
  if (options.width !== undefined && options.width <= 0) {
    fail('Table width must be positive.');
  }
  const document = slide.ownerDocument;
  const table = document.createElement('table');
  table.style.position = 'absolute';
  table.style.left = `${options.x ?? 0}px`;
  table.style.top = `${options.y ?? 0}px`;
  if (options.width !== undefined) table.style.width = `${options.width}px`;
  table.style.margin = '0';
  table.style.borderCollapse = 'collapse';
  const body = document.createElement('tbody');
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const row = document.createElement('tr');
    const isHeader = options.header === true && rowIndex === 0;
    for (let column = 0; column < columns; column += 1) {
      row.appendChild(cellElement(document, isHeader));
    }
    body.appendChild(row);
  }
  table.appendChild(body);
  return appendObject(slide, table);
}

export function tableRowCount(table: Element): number {
  return rowsOf(requireTable(table)).length;
}

export function tableColumnCount(table: Element): number {
  return columnCount(requireTable(table));
}

export function tableCellAt(
  table: Element,
  row: number,
  column: number
): HTMLTableCellElement {
  const element = requireTable(table);
  const rows = checkRow(element, row);
  const rowElement = rows[row] as HTMLTableRowElement;
  const cells = cellsOf(rowElement);
  if (!Number.isInteger(column) || column < 0 || column >= cells.length) {
    fail(`Column ${column} is outside row ${row} (0-${cells.length - 1}).`);
  }
  return cells[column] as HTMLTableCellElement;
}

export function insertTableRow(
  table: Element,
  at: number,
  position: 'above' | 'below'
): void {
  const element = requireTable(table);
  requireNoMergedCells(element);
  const rows = checkRow(element, at);
  const index = position === 'above' ? at : at + 1;
  const columns = columnCount(element);
  const document = element.ownerDocument;
  const row = document.createElement('tr');

  if (index === 0 && tableHasHeaderRow(element)) {
    // Inserting above the header promotes the new row to header and demotes
    // the old header row into the body, so row 0 stays the only header.
    const body = element.tBodies[0] ?? element.appendChild(document.createElement('tbody'));
    const previous = rows[0] as HTMLTableRowElement;
    for (const cell of cellsOf(previous)) convertCell(document, cell, false);
    body.insertBefore(previous, body.firstChild);
    const head =
      element.tHead ??
      (() => {
        const created = document.createElement('thead');
        element.insertBefore(created, body);
        return created;
      })();
    for (let column = 0; column < columns; column += 1) {
      row.appendChild(cellElement(document, true));
    }
    head.appendChild(row);
    return;
  }

  for (let column = 0; column < columns; column += 1) {
    row.appendChild(cellElement(document, false));
  }
  const reference = rows[index];
  if (reference) {
    reference.parentElement?.insertBefore(row, reference);
    return;
  }
  const body = element.tBodies[0] ?? element.appendChild(document.createElement('tbody'));
  body.appendChild(row);
}

export function deleteTableRow(table: Element, at: number): void {
  const element = requireTable(table);
  requireNoMergedCells(element);
  const rows = checkRow(element, at);
  if (rows.length === 1) {
    fail('A table must keep at least one row.');
  }
  rows[at]?.remove();
}

export function insertTableColumn(
  table: Element,
  at: number,
  position: 'left' | 'right'
): void {
  const element = requireTable(table);
  requireNoMergedCells(element);
  checkColumn(element, at);
  const index = position === 'left' ? at : at + 1;
  const rows = rowsOf(element);
  for (const row of rows) {
    const cells = cellsOf(row);
    const header = cells[0]?.tagName.toLowerCase() === 'th';
    const cell = cellElement(element.ownerDocument, header);
    const reference = cells[index];
    if (reference) row.insertBefore(cell, reference);
    else row.appendChild(cell);
  }
}

export function deleteTableColumn(table: Element, at: number): void {
  const element = requireTable(table);
  requireNoMergedCells(element);
  const columns = checkColumn(element, at);
  if (columns === 1) {
    fail('A table must keep at least one column.');
  }
  for (const row of rowsOf(element)) {
    cellsOf(row)[at]?.remove();
  }
}

function convertCell(
  document: Document,
  cell: HTMLTableCellElement,
  header: boolean
): HTMLTableCellElement {
  const tag = header ? 'th' : 'td';
  if (cell.tagName.toLowerCase() === tag) return cell;
  const next = document.createElement(tag) as HTMLTableCellElement;
  for (const attribute of Array.from(cell.attributes)) {
    if (attribute.name === 'scope') continue;
    next.setAttribute(attribute.name, attribute.value);
  }
  if (header) next.setAttribute('scope', 'col');
  while (cell.firstChild) next.appendChild(cell.firstChild);
  cell.replaceWith(next);
  return next;
}

export function tableHasHeaderRow(table: Element): boolean {
  const element = requireTable(table);
  const first = rowsOf(element)[0];
  const cell = first ? cellsOf(first)[0] : undefined;
  return cell?.tagName.toLowerCase() === 'th';
}

/**
 * Toggles the first row between header (thead + th) and body (tbody + td)
 * without touching cell content or styles.
 */
export function toggleTableHeaderRow(table: Element): boolean {
  const element = requireTable(table);
  const document = element.ownerDocument;
  const rows = rowsOf(element);
  if (rows.length === 0) fail('The table has no rows.');
  const first = rows[0] as HTMLTableRowElement;
  const hasHeader = cellsOf(first)[0]?.tagName.toLowerCase() === 'th';

  if (hasHeader) {
    const body =
      element.tBodies[0] ??
      (() => {
        const created = document.createElement('tbody');
        element.appendChild(created);
        return created;
      })();
    const headerRows = element.tHead
      ? (Array.from(element.tHead.children).filter(
          (child) => child.tagName.toLowerCase() === 'tr'
        ) as HTMLTableRowElement[])
      : [first];
    for (const row of headerRows) {
      for (const cell of cellsOf(row)) {
        convertCell(document, cell, false);
      }
      body.insertBefore(row, body.firstChild);
    }
    element.tHead?.remove();
    return false;
  }

  const head = element.tHead ?? document.createElement('thead');
  if (!element.tHead) element.insertBefore(head, element.firstChild);
  for (const cell of cellsOf(first)) convertCell(document, cell, true);
  head.appendChild(first);
  return true;
}
