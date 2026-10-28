import { useEffect, useState } from 'react';
import type { TableAction } from '../commands/tables';
import { useI18n } from '../i18n';

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
  'rounded border border-line-strong px-2 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40';
const COLOR_LABEL = 'flex items-center gap-1 text-[11px] text-muted';

function colorValue(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function TableToolbar({
  state,
  disabled = false,
  onAction,
  onCellStyle
}: TableToolbarProps) {
  const { t } = useI18n();
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
      aria-label={t('table.tools')}
      className="flex flex-nowrap items-center gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-2"
    >
      <span className="mr-1 font-mono text-[11px] text-muted">
        {t('table.position', {
          row: state.row + 1,
          rows: state.rows,
          column: state.column + 1,
          columns: state.columns
        })}
      </span>
      <button
        type="button"
        data-testid="table-row-above"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'row', position: 'above' })}
      >
        {t('table.rowAbove')}
      </button>
      <button
        type="button"
        data-testid="table-row-below"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'row', position: 'below' })}
      >
        {t('table.rowBelow')}
      </button>
      <button
        type="button"
        data-testid="table-row-delete"
        className={BUTTON}
        disabled={disabled || state.rows <= 1}
        onClick={() => onAction({ type: 'delete-row' })}
      >
        {t('table.deleteRow')}
      </button>
      <button
        type="button"
        data-testid="table-col-left"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'column', position: 'left' })}
      >
        {t('table.columnLeft')}
      </button>
      <button
        type="button"
        data-testid="table-col-right"
        className={BUTTON}
        disabled={disabled}
        onClick={() => onAction({ type: 'column', position: 'right' })}
      >
        {t('table.columnRight')}
      </button>
      <button
        type="button"
        data-testid="table-col-delete"
        className={BUTTON}
        disabled={disabled || state.columns <= 1}
        onClick={() => onAction({ type: 'delete-column' })}
      >
        {t('table.deleteColumn')}
      </button>
      <button
        type="button"
        data-testid="table-header-toggle"
        className={BUTTON}
        disabled={disabled}
        aria-pressed={state.header}
        onClick={() => onAction({ type: 'toggle-header' })}
      >
        {state.header ? t('table.removeHeader') : t('table.header')}
      </button>
      <label className={COLOR_LABEL}>
        {t('table.cellFill')}
        <input
          type="color"
          data-testid="table-cell-fill"
          aria-label={t('table.cellFill')}
          value={fill}
          disabled={disabled}
          onChange={(event) => setFill(event.target.value)}
          onBlur={() => {
            if (fill !== colorValue(state.fill, '#ffffff')) {
              onCellStyle({ background: fill });
            }
          }}
          className="h-6 w-8 cursor-pointer rounded border border-line-strong bg-transparent"
        />
      </label>
      <label className={COLOR_LABEL}>
        {t('table.cellBorder')}
        <input
          type="color"
          data-testid="table-cell-border"
          aria-label={t('table.cellBorderLabel')}
          value={border}
          disabled={disabled}
          onChange={(event) => setBorder(event.target.value)}
          onBlur={() => {
            if (border !== colorValue(state.border, '#b9b2a3')) {
              onCellStyle({ 'border-color': border });
            }
          }}
          className="h-6 w-8 cursor-pointer rounded border border-line-strong bg-transparent"
        />
      </label>
    </div>
  );
}
