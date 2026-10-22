import { useRef, useState, type DragEvent } from 'react';
import type { DraftRecord } from '../recovery';

export interface StandaloneLauncherProps {
  drafts: DraftRecord[];
  error: string;
  busy: boolean;
  onOpenFile: (file: File, handle: FileSystemFileHandle | null) => void;
  onError: (message: string) => void;
  onRestore: (draft: DraftRecord) => void;
  onDiscard: (draft: DraftRecord) => void;
}

const BUTTON =
  'rounded border border-white/40 px-3 py-2 text-sm text-zinc-200 transition-colors hover:border-amber-300/70 disabled:opacity-40';

function formatTime(value: number): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
}

export function StandaloneLauncher({
  drafts,
  error,
  busy,
  onOpenFile,
  onError,
  onRestore,
  onDiscard
}: StandaloneLauncherProps) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const chooseFile = async () => {
    const picker = (
      window as unknown as {
        showOpenFilePicker?: (options: {
          multiple?: boolean;
          types?: { description: string; accept: Record<string, string[]> }[];
        }) => Promise<FileSystemFileHandle[]>;
      }
    ).showOpenFilePicker;
    if (!picker) {
      fileInput.current?.click();
      return;
    }
    try {
      const [handle] = await picker({
        multiple: false,
        types: [
          {
            description: 'HTML deck',
            accept: { 'text/html': ['.html', '.htm'] }
          }
        ]
      });
      if (!handle) return;
      onOpenFile(await handle.getFile(), handle);
    } catch (cause) {
      // Cancelling the native picker is not an error.
      if ((cause as DOMException | undefined)?.name === 'AbortError') return;
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onOpenFile(file, null);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[#0f1115] p-8 text-zinc-100">
      <section
        aria-labelledby="standalone-title"
        className="w-full max-w-xl rounded border border-white/15 bg-[#141821] p-8 shadow-2xl"
      >
        <p className="text-xs uppercase tracking-[0.2em] text-amber-300/80">
          htmlppt
        </p>
        <h1 id="standalone-title" className="mt-2 text-xl font-semibold">
          獨立編輯模式
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          未連上本機 host。開啟或拖入一份 HTML 簡報即可編輯；支援 File System
          Access 的瀏覽器會直接寫回原檔，其他瀏覽器可下載匯出的 HTML。
        </p>

        <div
          data-testid="standalone-drop"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          className={`mt-6 flex flex-col items-center gap-3 rounded border-2 border-dashed p-8 transition-colors ${
            dragging
              ? 'border-amber-300/80 bg-amber-300/5'
              : 'border-white/20'
          }`}
        >
          <button
            type="button"
            data-testid="standalone-open"
            className={BUTTON}
            disabled={busy}
            onClick={() => void chooseFile()}
          >
            開啟 HTML…
          </button>
          <label className="cursor-pointer text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
            或上傳 HTML 檔
            <input
              ref={fileInput}
              data-testid="standalone-file"
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) onOpenFile(file, null);
              }}
            />
          </label>
        </div>

        {error && (
          <p
            data-testid="standalone-error"
            role="alert"
            className="mt-4 rounded border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs text-red-200"
          >
            {error}
          </p>
        )}

        {drafts.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-medium text-zinc-200">
              未儲存的編輯
            </h2>
            <ul className="mt-2 space-y-2">
              {drafts.map((draft) => (
                <li
                  key={draft.key}
                  data-testid="recovery-draft"
                  className="flex flex-wrap items-center gap-3 rounded border border-amber-400/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-100"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {draft.filePath}
                  </span>
                  <span className="text-amber-200/70">
                    {formatTime(draft.savedAt)}
                  </span>
                  <button
                    type="button"
                    data-testid="recovery-restore"
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => onRestore(draft)}
                  >
                    恢復
                  </button>
                  <button
                    type="button"
                    data-testid="recovery-discard"
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => onDiscard(draft)}
                  >
                    捨棄
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-6 text-xs text-zinc-500">
          PDF/PNG 需要本機 Chromium 與 host，請改用
          <code className="mx-1 rounded bg-white/10 px-1 py-0.5">
            htmlppt open deck.html
          </code>
          開啟。
        </p>
      </section>
    </div>
  );
}
