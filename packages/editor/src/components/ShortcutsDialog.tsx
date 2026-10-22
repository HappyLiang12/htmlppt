import { ModalDialog } from './ModalDialog';

interface ShortcutRow {
  keys: string;
  description: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: '播放與簡報',
    rows: [
      { keys: 'F5', description: '從第一頁開始播放' },
      { keys: 'Shift+F5', description: '從目前頁開始播放' },
      { keys: 'P', description: '開啟簡報者視窗' },
      { keys: 'F', description: '切換全螢幕' },
      { keys: '→ / Space / PageDown', description: '下一頁' },
      { keys: '← / PageUp', description: '上一頁' },
      { keys: 'Home / End', description: '第一頁 / 最後一頁' },
      { keys: 'Escape', description: '離開播放或取消選取' }
    ]
  },
  {
    title: '編輯',
    rows: [
      { keys: 'Ctrl+Z', description: '復原' },
      { keys: 'Ctrl+Y / Ctrl+Shift+Z', description: '重做' },
      { keys: 'Ctrl+D', description: '複製選取物件' },
      { keys: 'Ctrl+A', description: '全選' },
      { keys: 'Delete / Backspace', description: '刪除選取物件' },
      { keys: 'Ctrl+C / Ctrl+V', description: '複製 / 貼上' },
      { keys: 'Ctrl+G / Ctrl+Shift+G', description: '群組 / 取消群組' },
      { keys: 'Enter', description: '編輯選取文字' },
      { keys: '方向鍵 / Shift+方向鍵', description: '微調 1px / 10px' }
    ]
  },
  {
    title: '檢視與檔案',
    rows: [
      { keys: 'Ctrl+= / Ctrl+-', description: '放大 / 縮小' },
      { keys: 'Ctrl+0', description: '符合視窗' },
      { keys: 'Ctrl+S', description: '立即儲存' },
      { keys: '?', description: '開啟此說明' }
    ]
  }
];

export interface ShortcutsDialogProps {
  onClose: () => void;
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  return (
    <ModalDialog
      label="鍵盤快速鍵"
      testId="shortcuts-dialog"
      onClose={onClose}
      panelClassName="w-[560px]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">鍵盤快速鍵</h2>
          <p className="mt-1 text-[11px] text-zinc-400">
            焦點在輸入框或文字編輯中時，導覽鍵保留給文字輸入。
          </p>
        </div>
        <button
          type="button"
          data-testid="shortcuts-dialog-close"
          aria-label="關閉鍵盤快速鍵"
          onClick={onClose}
          className="rounded border border-white/40 px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-white/60"
        >
          關閉
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto pr-1">
        {GROUPS.map((group) => (
          <section key={group.title} className="mb-3 last:mb-0">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              {group.title}
            </h3>
            <dl className="flex flex-col gap-1">
              {group.rows.map((row) => (
                <div
                  key={row.keys}
                  className="flex items-baseline justify-between gap-4 text-xs"
                >
                  <dt>
                    <kbd className="rounded border border-white/40 bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-zinc-100">
                      {row.keys}
                    </kbd>
                  </dt>
                  <dd className="text-right text-zinc-300">{row.description}</dd>
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
          aria-label="關閉快速鍵說明"
          onClick={onClose}
          className="rounded border border-amber-400/70 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-100 transition-colors hover:bg-amber-400/20"
        >
          關閉
        </button>
      </div>
    </ModalDialog>
  );
}
