import { useState, type DragEvent } from 'react';
import { pickHtmlFile } from '../file-picker';
import { useI18n } from '../i18n';
import type { DraftRecord } from '../recovery';
import { formatDraftTime } from '../standalone';

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
  'rounded border border-line-strong px-3 py-2 text-sm text-ink transition-colors hover:border-accent/70 hover:bg-hover disabled:opacity-40';

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
    <div className="flex h-screen items-center justify-center bg-canvas p-8 text-ink">
      <section
        aria-labelledby="standalone-title"
        className="w-full max-w-xl rounded border border-line-strong bg-surface p-8 shadow-[0_24px_60px_var(--editor-shadow-panel)]"
      >
        <p className="text-xs uppercase tracking-[0.2em] text-accent">
          htmlppt
        </p>
        <h1 id="standalone-title" className="mt-2 text-xl font-semibold">
          {t('standalone.title')}
        </h1>
        <p className="mt-2 text-sm text-muted">
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
              ? 'border-accent/70 bg-accent-soft'
              : 'border-line-strong'
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
          <label className="cursor-pointer text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
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
            className="mt-4 rounded border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        )}

        {drafts.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-medium text-ink">
              {t('recovery.available')}
            </h2>
            <ul className="mt-2 space-y-2">
              {drafts.map((draft) => (
                <li
                  key={draft.key}
                  data-testid="recovery-draft"
                  className="flex flex-wrap items-center gap-3 rounded border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {draft.filePath}
                  </span>
                  <span className="text-warning/70">
                    {formatDraftTime(draft.savedAt, locale)}
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

        <p className="mt-6 text-xs text-muted">
          {t('standalone.commandHint')}{' '}
          <code className="rounded bg-chip px-1 py-0.5">
            htmlppt open deck.html
          </code>
        </p>
      </section>
    </div>
  );
}
