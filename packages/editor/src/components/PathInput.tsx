import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

export interface PathInputProps {
  value: string;
  editable: boolean;
  opening: boolean;
  error: string | null;
  onOpen: (value: string) => void;
  onPick: () => void;
}

export function PathInput({
  value,
  editable,
  opening,
  error,
  onOpen,
  onPick
}: PathInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  const submittingRef = useRef(false);
  const cancellingRef = useRef(false);

  useEffect(() => {
    // A load can replace the deck while the field is focused. Keep the
    // in-progress draft until focus leaves so typing is never clobbered.
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const submit = (): void => {
    if (!editable || opening || submittingRef.current) return;
    const next = draft.trim();
    if (!next || next === value) return;
    submittingRef.current = true;
    onOpen(next);
    queueMicrotask(() => {
      submittingRef.current = false;
    });
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        data-testid="deck-path"
        aria-label={t('path.label')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'deck-path-error' : undefined}
        className="w-64 truncate rounded border border-white/40 bg-black/30 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-amber-400/70"
        value={draft}
        readOnly={!editable}
        disabled={opening}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            // Escape blurs, and that blur would otherwise submit the draft it
            // is discarding. The flag is consumed by the blur handler.
            cancellingRef.current = true;
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        onBlur={() => {
          focusedRef.current = false;
          const cancelled = cancellingRef.current;
          cancellingRef.current = false;
          if (!cancelled) submit();
        }}
      />
      <button
        type="button"
        data-testid="deck-picker"
        className="rounded border border-white/40 px-2 py-1 text-xs text-zinc-300 hover:border-white/60"
        title={t('path.openHint')}
        aria-label={t('path.openHint')}
        disabled={opening}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onPick}
      >
        {t('path.open')}
      </button>
      {error && (
        <span
          id="deck-path-error"
          role="alert"
          className="max-w-64 truncate text-xs text-red-300"
          title={error}
        >
          {error}
        </span>
      )}
    </div>
  );
}
