import { useEffect, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '../i18n';

export type ExportFormat = 'html' | 'pdf' | 'png';

export interface ExportMenuProps {
  /** Incremented by the Ctrl/Cmd+Shift+E shortcut to open the menu. */
  signal: number;
  exporting: ExportFormat | null;
  standalone: boolean;
  onExport: (format: ExportFormat) => void;
}

const BUTTON =
  'rounded border border-line-strong px-2 py-1 text-xs text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-40';
const ITEM =
  'rounded px-2 py-1 text-left text-xs text-ink transition-colors hover:bg-hover disabled:opacity-40';

const FORMATS: {
  format: ExportFormat;
  label: MessageKey;
  hint: MessageKey;
  hostOnly: boolean;
}[] = [
  {
    format: 'html',
    label: 'export.html',
    hint: 'export.htmlHint',
    hostOnly: false
  },
  {
    format: 'pdf',
    label: 'export.pdf',
    hint: 'export.pdfHint',
    hostOnly: true
  },
  {
    format: 'png',
    label: 'export.png',
    hint: 'export.pngHint',
    hostOnly: true
  }
];

export function ExportMenu({
  signal,
  exporting,
  standalone,
  onExport
}: ExportMenuProps) {
  const { t } = useI18n();
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
        title={t('export.title')}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        {exporting ? t('export.busy') : t('export.label')}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={t('export.format')}
          data-testid="export-menu"
          className="absolute right-0 top-full z-20 mt-1 flex w-56 flex-col gap-1 rounded border border-line-strong bg-raised p-2 shadow-[0_24px_60px_var(--editor-shadow-panel)]"
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
                    ? t('export.hostOnlyHint')
                    : t(hint)
                }
                onClick={() => choose(format)}
              >
                <span className="block">{t(label)}</span>
                <span className="block text-[10px] text-muted">
                  {standalone && hostOnly ? t('export.hostOnly') : t(hint)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
