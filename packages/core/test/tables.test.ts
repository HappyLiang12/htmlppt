// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  deleteTableColumn,
  deleteTableRow,
  insertTable,
  insertTableColumn,
  insertTableRow,
  tableCellAt,
  tableColumnCount,
  tableHasHeaderRow,
  tableRowCount,
  toggleTableHeaderRow
} from '../src/tables.js';

function slide(): Element {
  document.body.innerHTML =
    '<section data-slide-id="s1" data-width="1600" data-height="900"></section>';
  return document.querySelector('[data-slide-id]')!;
}

function table(rows = 3, columns = 2, header = true): HTMLTableElement {
  return insertTable(slide(), {
    rows,
    columns,
    header,
    x: 100,
    y: 200,
    width: 600
  }) as HTMLTableElement;
}

function cellTexts(element: Element): string[] {
  return Array.from(element.querySelectorAll('td, th')).map(
    (cell) => cell.textContent ?? ''
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('insertTable', () => {
  it('creates a top-level table with a header row and geometry', () => {
    const root = slide();
    const element = insertTable(root, {
      rows: 3,
      columns: 2,
      header: true,
      x: 120,
      y: 80,
      width: 800
    });

    expect(element.parentElement).toBe(root);
    expect(element.tagName).toBe('TABLE');
    expect(element.getAttribute('data-ppt-el')).toBe('e1');
    const html = element as HTMLTableElement;
    expect(html.style.position).toBe('absolute');
    expect(html.style.left).toBe('120px');
    expect(html.style.top).toBe('80px');
    expect(html.style.width).toBe('800px');
    expect(html.style.borderCollapse).toBe('collapse');
    expect(tableRowCount(html)).toBe(3);
    expect(tableColumnCount(html)).toBe(2);
    expect(tableHasHeaderRow(html)).toBe(true);
    const header = html.querySelector('tbody tr:first-child')!;
    expect(header.querySelectorAll('th')).toHaveLength(2);
    expect(header.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(html.querySelectorAll('tr')).toHaveLength(3);
    expect(html.querySelectorAll('td')).toHaveLength(4);
    const firstCell = html.querySelector('td') as HTMLElement;
    expect(firstCell.style.border).toContain('1px solid');
    expect(firstCell.style.padding).toBe('8px 12px');
  });

  it('omits the header when requested and rejects invalid sizes', () => {
    const element = table(2, 2, false);
    expect(tableHasHeaderRow(element)).toBe(false);
    expect(element.querySelector('th')).toBeNull();

    expect(() => insertTable(slide(), { rows: 0, columns: 1 })).toThrow(
      /positive integer/
    );
    expect(() =>
      insertTable(slide(), { rows: MAX_TABLE_ROWS + 1, columns: 1 })
    ).toThrow(/at most 50/);
    expect(() =>
      insertTable(slide(), { rows: 1, columns: MAX_TABLE_COLUMNS + 1 })
    ).toThrow(/at most 20/);
    expect(() => insertTable(slide(), { rows: 1, columns: 1, width: 0 })).toThrow(
      /positive/
    );
    expect(() => insertTable(slide(), { rows: 1.5, columns: 1 })).toThrow(
      /integer/
    );
  });
});

describe('table rows', () => {
  it('inserts above and below with zero-based coordinates', () => {
    const element = table(3, 2, false);
    element.rows[1]!.cells[0]!.textContent = 'middle';

    insertTableRow(element, 1, 'above');
    expect(tableRowCount(element)).toBe(4);
    expect(element.rows[1]!.cells[0]!.textContent).toBe('');
    expect(element.rows[2]!.cells[0]!.textContent).toBe('middle');

    insertTableRow(element, 3, 'below');
    expect(tableRowCount(element)).toBe(5);
    expect(element.rows[4]!.cells.length).toBe(2);
  });

  it('keeps only one header when inserting above it', () => {
    const element = table(3, 2, true);
    (element.rows[0]!.cells[0] as HTMLElement).textContent = 'Head';
    (element.rows[1]!.cells[0] as HTMLElement).textContent = 'Body';

    insertTableRow(element, 0, 'above');

    expect(tableRowCount(element)).toBe(4);
    expect(tableHasHeaderRow(element)).toBe(true);
    expect(element.rows[0]!.cells[0]!.tagName).toBe('TH');
    expect(element.rows[0]!.cells[0]!.textContent).toBe('');
    expect(element.rows[1]!.cells[0]!.tagName).toBe('TD');
    expect(element.rows[1]!.cells[0]!.textContent).toBe('Head');
    expect(element.rows[2]!.cells[0]!.textContent).toBe('Body');
    expect(element.querySelectorAll('thead')).toHaveLength(1);
    expect(element.querySelectorAll('thead tr')).toHaveLength(1);
  });

  it('rejects out-of-range insertion and deletion without mutation', () => {
    const element = table(2, 2, false);
    expect(() => insertTableRow(element, 2, 'above')).toThrow(/outside/);
    expect(() => insertTableRow(element, -1, 'below')).toThrow(/outside/);
    expect(() => insertTableRow(element, 0.5, 'below')).toThrow(/outside/);
    expect(() => deleteTableRow(element, 2)).toThrow(/outside/);
    expect(tableRowCount(element)).toBe(2);
  });

  it('deletes rows but never the last row', () => {
    const element = table(2, 2, false);
    element.rows[0]!.cells[0]!.textContent = 'keep';
    deleteTableRow(element, 1);
    expect(tableRowCount(element)).toBe(1);
    expect(element.rows[0]!.cells[0]!.textContent).toBe('keep');
    expect(() => deleteTableRow(element, 0)).toThrow(/at least one row/);
  });
});

describe('table columns', () => {
  it('inserts left and right across every row', () => {
    const element = table(2, 2, true);
    insertTableColumn(element, 0, 'left');
    expect(tableColumnCount(element)).toBe(3);
    expect(element.rows[0]!.cells[0]!.tagName).toBe('TH');
    expect(element.rows[1]!.cells[0]!.tagName).toBe('TD');
    expect(element.rows[1]!.cells.length).toBe(3);

    insertTableColumn(element, 2, 'right');
    expect(tableColumnCount(element)).toBe(4);
    expect(element.rows[0]!.cells[3]!.tagName).toBe('TH');
  });

  it('rejects out-of-range columns and deleting the last column', () => {
    const element = table(2, 1, false);
    expect(() => insertTableColumn(element, 1, 'left')).toThrow(/outside/);
    expect(() => deleteTableColumn(element, 1)).toThrow(/outside/);
    expect(() => deleteTableColumn(element, 0)).toThrow(/at least one column/);
    expect(tableColumnCount(element)).toBe(1);
  });

  it('deletes columns from every row', () => {
    const element = table(2, 3, false);
    element.rows[0]!.cells[1]!.textContent = 'drop';
    deleteTableColumn(element, 1);
    expect(tableColumnCount(element)).toBe(2);
    expect(cellTexts(element)).not.toContain('drop');
  });
});

describe('header toggling and cell access', () => {
  it('toggles the header while preserving cell content and styles', () => {
    const element = table(2, 2, false);
    const first = element.rows[0]!.cells[0] as HTMLElement;
    first.textContent = 'Column A';
    first.style.background = '#ff0000';

    expect(toggleTableHeaderRow(element)).toBe(true);
    expect(tableHasHeaderRow(element)).toBe(true);
    expect(element.querySelectorAll('thead th')).toHaveLength(2);
    const header = tableCellAt(element, 0, 0);
    expect(header.tagName).toBe('TH');
    expect(header.textContent).toBe('Column A');
    expect((header as HTMLElement).style.background).toBe('rgb(255, 0, 0)');

    expect(toggleTableHeaderRow(element)).toBe(false);
    expect(tableHasHeaderRow(element)).toBe(false);
    expect(element.querySelector('thead')).toBeNull();
    expect(element.rows[0]!.cells[0]!.textContent).toBe('Column A');
  });

  it('resolves cells by zero-based row and column', () => {
    const element = table(3, 3, false);
    element.rows[1]!.cells[2]!.textContent = 'target';
    expect(tableCellAt(element, 1, 2).textContent).toBe('target');
    expect(() => tableCellAt(element, 3, 0)).toThrow(/outside/);
    expect(() => tableCellAt(element, 0, 3)).toThrow(/outside/);
  });

  it('rejects operations on nested tables', () => {
    const element = table(2, 2, false);
    const nested = element.ownerDocument.createElement('table');
    nested.innerHTML = '<tbody><tr><td>x</td></tr></tbody>';
    element.rows[0]!.cells[0]!.appendChild(nested);

    expect(() => insertTableRow(element, 0, 'below')).toThrow(/Nested tables/);
    expect(() => toggleTableHeaderRow(element)).toThrow(/Nested tables/);
  });
});
