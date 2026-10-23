import { useState, type DragEvent } from 'react';
import { pickHtmlFile } from '../file-picker';
import { useI18n, type Locale } from '../i18n';
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

const DATE_LOCALES: Record<Locale, string> = {
  en: 'en-US',
  'zh-Hant': 'zh-TW',
  'zh-Hans': 'zh-CN'
};

function formatTime(value: number, locale: Locale): string {
  try {
    return new Date(value).toLocaleString(DATE_LOCALES[locale]);
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
  const { t, locale } = useI18n();
  const [dragging, setDragging] = useState(false);

  const chooseFile = async () => {
    try {
      const picked = await pickHtmlFile();
      if (!picked) return;
      onOpenFile(picked.file, picked.handle);
    } catch (cause) {
      // pickHtmlFile treats a cancelled native picker as null, so anything
      // reaching here is a real error.
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
          {t('standalone.title')}
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          {t('standalone.description')}
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
            {t('standalone.open')}
          </button>
          <label className="cursor-pointer text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
            {t('standalone.upload')}
            <input
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
              {t('recovery.available')}
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
                    {formatTime(draft.savedAt, locale)}
                  </span>
                  <button
                    type="button"
                    data-testid="recovery-restore"
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => onRestore(draft)}
                  >
                    {t('recovery.restore')}
                  </button>
                  <button
                    type="button"
                    data-testid="recovery-discard"
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => onDiscard(draft)}
                  >
                    {t('recovery.discard')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-6 text-xs text-zinc-500">
          {t('standalone.commandHint')}{' '}
          <code className="rounded bg-white/10 px-1 py-0.5">
            htmlppt open deck.html
          </code>
        </p>
      </section>
    </div>
  );
}
