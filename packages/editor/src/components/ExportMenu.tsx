import { useEffect, useRef, useState } from 'react';

export type ExportFormat = 'html' | 'pdf' | 'png';

export interface ExportMenuProps {
  /** Incremented by the Ctrl/Cmd+Shift+E shortcut to open the menu. */
  signal: number;
  exporting: ExportFormat | null;
  standalone: boolean;
  onExport: (format: ExportFormat) => void;
}

const BUTTON =
  'rounded border border-white/40 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-white/60 disabled:opacity-40';
const ITEM =
  'rounded px-2 py-1 text-left text-xs text-zinc-200 transition-colors hover:bg-white/10 disabled:opacity-40';

const FORMATS: {
  format: ExportFormat;
  label: string;
  hint: string;
  hostOnly: boolean;
}[] = [
  {
    format: 'html',
    label: 'HTML 簡報',
    hint: '匯出不含編輯器痕跡的靜態 HTML',
    hostOnly: false
  },
  {
    format: 'pdf',
    label: 'PDF 文件',
    hint: '每張投影片一頁，需要本機 Chromium',
    hostOnly: true
  },
  {
    format: 'png',
    label: 'PNG 圖片',
    hint: '每張投影片一張 2x 圖片，需要本機 Chromium',
    hostOnly: true
  }
];

export function ExportMenu({
  signal,
  exporting,
  standalone,
  onExport
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (signal > 0) setOpen(true);
  }, [signal]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer, true);
    return () =>
      document.removeEventListener('pointerdown', closeOnPointer, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>(
      'button:not(:disabled)'
    );
    first?.focus();
  }, [open]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  const choose = (format: ExportFormat) => {
    close();
    onExport(format);
  };

  return (
    <div className="relative">
      <button
        ref={trigger}
        type="button"
        data-testid="export-open"
        aria-haspopup="menu"
        aria-expanded={open}
        className={BUTTON}
        disabled={exporting !== null}
        title="匯出（Ctrl+Shift+E）"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        {exporting ? '匯出中…' : '匯出'}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="匯出格式"
          data-testid="export-menu"
          className="absolute right-0 top-full z-20 mt-1 flex w-56 flex-col gap-1 rounded border border-white/30 bg-[#161a21] p-2 shadow-xl"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = Array.from(
              menu.current?.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)'
              ) ?? []
            );
            if (items.length === 0) return;
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            items[(index + delta + items.length) % items.length]?.focus();
          }}
        >
          {FORMATS.map(({ format, label, hint, hostOnly }) => {
            const disabled = exporting !== null || (standalone && hostOnly);
            return (
              <button
                key={format}
                type="button"
                role="menuitem"
                data-testid={`export-${format}`}
                className={ITEM}
                disabled={disabled}
                title={
                  standalone && hostOnly
                    ? '需要本機 host 與 Chromium；請使用 htmlppt open 開啟。'
                    : hint
                }
                onClick={() => choose(format)}
              >
                <span className="block">{label}</span>
                <span className="block text-[10px] text-zinc-400">
                  {standalone && hostOnly ? '需要本機 host' : hint}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
