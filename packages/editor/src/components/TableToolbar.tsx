import { useEffect, useState } from 'react';
import type { TableAction } from '../commands/tables';

export interface TableToolbarState {
  row: number;
  column: number;
  rows: number;
  columns: number;
  header: boolean;
  fill: string;
  border: string;
}

export interface TableToolbarProps {
  state: TableToolbarState;
  disabled?: boolean;
  onAction: (action: TableAction) => void;
  onCellStyle: (styles: Record<string, string>) => boolean;
}

const BUTTON =
  'rounded border border-white/15 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40';
const COLOR_LABEL = 'flex items-center gap-1 text-[11px] text-zinc-400';

function colorValue(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function TableToolbar({
  state,
  disabled = false,
  onAction,
  onCellStyle
}: TableToolbarProps) {
  const [fill, setFill] = useState(colorValue(state.fill, '#ffffff'));
  const [border, setBorder] = useState(colorValue(state.border, '#b9b2a3'));

  useEffect(() => {
    setFill(colorValue(state.fill, '#ffffff'));
    setBorder(colorValue(state.border, '#b9b2a3'));
  }, [state.fill, state.border, state.row, state.column]);

  return (
    <div
      data-testid="table-toolbar"
      role="toolbar"
      aria-label="表格工具"
      className="flex flex-wrap items-center gap-1 border-b border-white/10 bg-[#12151b] px-3 py-2"
    >
      <span className="mr-1 font-mono text-[11px] text-zinc-500">
        列 {state.row + 1}/{state.rows} · 欄 {state.column + 1}/{state.columns}
      </span>
      <button
        type="button"
        data-testid="table-row-above"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'row', position: 'above' })}
      >
        上方列
      </button>
      <button
        type="button"
        data-testid="table-row-below"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'row', position: 'below' })}
      >
        下方列
      </button>
      <button
        type="button"
        data-testid="table-row-delete"
        className={BUTTON}
        disabled={disabled || state.rows <= 1}
        onClick={() => onAction({ type: 'delete-row' })}
      >
        刪列
      </button>
      <button
        type="button"
        data-testid="table-col-left"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'column', position: 'left' })}
      >
        左方欄
      </button>
      <button
        type="button"
        data-testid="table-col-right"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'column', position: 'right' })}
      >
        右方欄
      </button>
      <button
        type="button"
        data-testid="table-col-delete"
        className={BUTTON}
        disabled={disabled || state.columns <= 1}
        onClick={() => onAction({ type: 'delete-column' })}
      >
        刪欄
      </button>
      <button
        type="button"
        data-testid="table-header-toggle"
        className={BUTTON}
        disabled={disabled}
        aria-pressed={state.header}
        onClick={() => onAction({ type: 'toggle-header' })}
      >
        {state.header ? '取消標題列' : '標題列'}
      </button>
      <label className={COLOR_LABEL}>
        儲存格底色
        <input
          type="color"
          data-testid="table-cell-fill"
          aria-label="儲存格底色"
          value={fill}
          disabled={disabled}
          onChange={(event) => setFill(event.target.value)}
          onBlur={() => {
            if (fill !== colorValue(state.fill, '#ffffff')) {
              onCellStyle({ background: fill });
            }
          }}
          className="h-6 w-8 cursor-pointer rounded border border-white/15 bg-transparent"
        />
      </label>
      <label className={COLOR_LABEL}>
        框線
        <input
          type="color"
          data-testid="table-cell-border"
          aria-label="儲存格框線顏色"
          value={border}
          disabled={disabled}
          onChange={(event) => setBorder(event.target.value)}
          onBlur={() => {
            if (border !== colorValue(state.border, '#b9b2a3')) {
              onCellStyle({ 'border-color': border });
            }
          }}
          className="h-6 w-8 cursor-pointer rounded border border-white/15 bg-transparent"
        />
      </label>
    </div>
  );
}
