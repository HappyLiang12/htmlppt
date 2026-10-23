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
          <h2 className="text-sm font-semibold text-zinc-100">
            {t('inspector.chartDialog')}
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
            <code className="rounded bg-white/10 px-1 py-0.5">
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
          className="w-full resize-y rounded border border-white/40 bg-black/30 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 outline-none focus:border-amber-400/70"
        />
        {error && (
          <p
            data-testid="chart-error"
            role="alert"
            className="text-[11px] text-red-300"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="chart-cancel"
            onClick={onCancel}
            className="rounded border border-white/40 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/60"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-testid="chart-apply"
            onClick={onApply}
            className="rounded border border-amber-400/70 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100 transition-colors hover:bg-amber-400/20"
          >
            {t('common.apply')}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
