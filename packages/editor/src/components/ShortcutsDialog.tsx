import { useI18n, type MessageKey } from '../i18n';
import { ModalDialog } from './ModalDialog';

interface ShortcutRow {
  keys: string;
  keysMessage?: MessageKey;
  description: MessageKey;
}

interface ShortcutGroup {
  title: MessageKey;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'shortcuts.playGroup',
    rows: [
      { keys: 'F5', description: 'shortcuts.playFromStart' },
      { keys: 'Shift+F5', description: 'shortcuts.playFromCurrent' },
      { keys: 'P', description: 'shortcuts.openPresenter' },
      { keys: 'F', description: 'shortcuts.toggleFullscreen' },
      { keys: '→ / Space / PageDown', description: 'shortcuts.nextSlide' },
      { keys: '← / PageUp', description: 'shortcuts.previousSlide' },
      { keys: 'Home / End', description: 'shortcuts.firstLast' },
      { keys: 'Escape', description: 'shortcuts.exitPlay' }
    ]
  },
  {
    title: 'shortcuts.editGroup',
    rows: [
      { keys: 'Ctrl+Z', description: 'shortcuts.undo' },
      { keys: 'Ctrl+Y / Ctrl+Shift+Z', description: 'shortcuts.redo' },
      { keys: 'Ctrl+D', description: 'shortcuts.duplicateSelection' },
      { keys: 'Ctrl+A', description: 'shortcuts.selectAll' },
      { keys: 'Delete / Backspace', description: 'shortcuts.deleteSelection' },
      { keys: 'Ctrl+C / Ctrl+V', description: 'shortcuts.copyPaste' },
      { keys: 'Ctrl+G / Ctrl+Shift+G', description: 'shortcuts.groupUngroup' },
      { keys: 'Enter', description: 'shortcuts.editText' },
      { keys: 'Ctrl+B', description: 'shortcuts.bold' },
      { keys: 'Ctrl+I', description: 'shortcuts.italic' },
      { keys: 'Ctrl+U', description: 'shortcuts.underline' },
      {
        keys: '',
        keysMessage: 'shortcuts.arrowKeys',
        description: 'shortcuts.nudge'
      }
    ]
  },
  {
    title: 'shortcuts.viewGroup',
    rows: [
      { keys: 'Ctrl+= / Ctrl+-', description: 'shortcuts.zoom' },
      { keys: 'Ctrl+0', description: 'shortcuts.fit' },
      { keys: 'Ctrl+S', description: 'shortcuts.save' },
      { keys: '?', description: 'shortcuts.help' }
    ]
  }
];

export interface ShortcutsDialogProps {
  onClose: () => void;
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const { t } = useI18n();

  return (
    <ModalDialog
      label={t('shortcuts.title')}
      testId="shortcuts-dialog"
      onClose={onClose}
      panelClassName="w-[560px]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {t('shortcuts.title')}
          </h2>
          <p className="mt-1 text-[11px] text-muted">
            {t('shortcuts.note')}
          </p>
        </div>
        <button
          type="button"
          data-testid="shortcuts-dialog-close"
          aria-label={t('shortcuts.close')}
          onClick={onClose}
          className="rounded border border-line-strong px-2 py-1 text-xs text-ink transition-colors hover:bg-hover"
        >
          {t('common.close')}
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {GROUPS.map((group) => (
          <section key={group.title} className="mb-3 last:mb-0">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              {t(group.title)}
            </h3>
            <dl className="flex flex-col gap-1">
              {group.rows.map((row) => (
                <div
                  key={row.keys || row.description}
                  className="flex items-baseline justify-between gap-4 text-xs"
                >
                  <dt>
                    <kbd className="rounded border border-line-strong bg-chip px-1.5 py-0.5 font-mono text-[11px] text-ink">
                      {row.keysMessage ? t(row.keysMessage) : row.keys}
                    </kbd>
                  </dt>
                  <dd className="text-right text-muted">
                    {t(row.description)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          data-testid="shortcuts-dialog-done"
          aria-label={t('shortcuts.closeHelp')}
          onClick={onClose}
          className="rounded border border-accent/70 bg-accent-soft px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/20"
        >
          {t('common.close')}
        </button>
      </div>
    </ModalDialog>
  );
}
