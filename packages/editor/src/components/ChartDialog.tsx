import { useEffect, useRef } from 'react';

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
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textarea.current?.focus();
  }, []);

  return (
    <div
      data-testid="chart-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="編輯圖表"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onApply();
        }
      }}
    >
      <div className="flex max-h-full w-[640px] flex-col gap-3 rounded-lg border border-white/15 bg-[#12151b] p-4 shadow-2xl">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">編輯圖表</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
            JSON 需包含 type（bar/line/pie）、labels 與 series；series 的 values
            長度必須等於 labels。Ctrl+Enter 套用，Escape 取消。
          </p>
        </div>
        <textarea
          ref={textarea}
          data-testid="chart-json"
          aria-label="圖表 JSON"
          value={json}
          rows={18}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className="w-full resize-y rounded border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-100 outline-none focus:border-amber-400/70"
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
            className="rounded border border-white/15 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-white/30"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="chart-apply"
            onClick={onApply}
            className="rounded border border-amber-400/70 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100 transition-colors hover:bg-amber-400/20"
          >
            套用
          </button>
        </div>
      </div>
    </div>
  );
}
