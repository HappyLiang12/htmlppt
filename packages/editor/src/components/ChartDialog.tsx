import type { KeyboardEvent } from 'react';
import { useI18n } from '../i18n';
import { ModalDialog } from './ModalDialog';

export interface ChartDialogProps {
  json: string;
  error: string;
  onChange: (json: string) => void;
  onApply: () => void;
  onCancel: () => void;
}

export function ChartDialog({
  json,
  error,
  onChange,
  onApply,
  onCancel
}: ChartDialogProps) {
  const { t } = useI18n();
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onApply();
    }
  };

  return (
    <ModalDialog
      label={t('inspector.chartDialog')}
      testId="chart-dialog"
      onClose={onCancel}
      initialFocus='[data-testid="chart-json"]'
      panelClassName="w-[640px]"
    >
      <div className="flex flex-col gap-3" onKeyDown={handleKeyDown}>
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {t('inspector.chartDialog')}
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            <code className="rounded bg-chip px-1 py-0.5">
              type (bar/line/pie) · labels · series
            </code>{' '}
            {t('inspector.chartHint')}
          </p>
        </div>
        <textarea
          data-testid="chart-json"
          aria-label={t('inspector.chartJson')}
          value={json}
          rows={18}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className="w-full resize-y rounded border border-line-strong bg-input px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none focus:border-accent/70"
        />
        {error && (
          <p
            data-testid="chart-error"
            role="alert"
            className="text-[11px] text-danger"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="chart-cancel"
            onClick={onCancel}
            className="rounded border border-line-strong px-3 py-1.5 text-xs text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-testid="chart-apply"
            onClick={onApply}
            className="rounded border border-accent/70 bg-accent-soft px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/20"
          >
            {t('common.apply')}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
