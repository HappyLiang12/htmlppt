// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { insertTable } from '@htmlppt/core';
import { tableContext } from './tables.js';

let slide: Element;

beforeEach(() => {
  document.body.innerHTML =
    '<section data-slide-id="s1" data-width="1600" data-height="900"></section>';
  slide = document.querySelector('[data-slide-id]')!;
});

function table(): HTMLTableElement {
  return insertTable(slide, {
    rows: 3,
    columns: 2,
    header: true,
    x: 0,
    y: 0,
    width: 600
  }) as HTMLTableElement;
}

describe('tableContext', () => {
  it('resolves a selected cell path to zero-based coordinates', () => {
    const element = table();
    element.rows[1]!.cells[1]!.textContent = 'target';

    const context = tableContext(slide, [0, 0, 1, 1]);

    expect(context).not.toBeNull();
    expect(context?.table).toBe(element);
    expect(context?.cell.textContent).toBe('target');
    expect(context?.row).toBe(1);
    expect(context?.column).toBe(1);
    expect(context?.rows).toBe(3);
    expect(context?.columns).toBe(2);
    expect(context?.header).toBe(true);
    expect(context?.tablePath).toEqual([0]);
    expect(context?.cellPath).toEqual([0, 0, 1, 1]);
  });

  it('resolves a descendant selection to its owning cell', () => {
    const element = table();
    const cell = element.rows[2]!.cells[0]!;
    const span = document.createElement('span');
    span.textContent = 'nested';
    cell.appendChild(span);

    const context = tableContext(slide, [0, 0, 2, 0, 0]);

    expect(context?.row).toBe(2);
    expect(context?.column).toBe(0);
    expect(context?.cell).toBe(cell);
    expect(context?.cellPath).toEqual([0, 0, 2, 0]);
  });

  it('returns null when the selection is not inside a cell', () => {
    table();
    slide.appendChild(document.createElement('p'));

    expect(tableContext(slide, [0])).toBeNull();
    expect(tableContext(slide, [1])).toBeNull();
    expect(tableContext(slide, [0, 0])).toBeNull();
    expect(tableContext(slide, [99])).toBeNull();
  });

  it('returns null for nested tables', () => {
    const element = table();
    const nested = document.createElement('table');
    nested.innerHTML = '<tbody><tr><td>inner</td></tr></tbody>';
    element.rows[0]!.cells[0]!.appendChild(nested);

    expect(tableContext(slide, [0, 0, 0, 0])).toBeNull();
  });
});
