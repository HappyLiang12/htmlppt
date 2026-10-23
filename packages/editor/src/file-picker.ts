export interface PickedHtmlFile {
  file: File;
  handle: FileSystemFileHandle | null;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandle[]>;
};

const PICKER_TYPES = [
  {
    description: 'HTML deck',
    accept: { 'text/html': ['.html', '.htm'] }
  }
];

/**
 * How long after the window regains focus to wait for a change event before
 * treating the dialog as dismissed. Browsers without a `cancel` event (older
 * Safari) never resolve the hidden-input promise otherwise.
 */
const FOCUS_FALLBACK_DELAY_MS = 300;

/**
 * Opens one HTML deck through the File System Access picker when available.
 * The returned handle keeps standalone saves writing back to the same file;
 * the hidden-input fallback has no handle, so callers offer a download instead.
 */
export async function pickHtmlFile(): Promise<PickedHtmlFile | null> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({ multiple: false, types: PICKER_TYPES });
      if (!handle) return null;
      return { file: await handle.getFile(), handle };
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return null;
      throw error;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.htm,text/html';
    input.style.display = 'none';
    input.dataset.testid = 'file-picker-input';
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (picked: PickedHtmlFile | null): void => {
      if (settled) return;
      settled = true;
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
      resolve(picked);
    };

    const onChange = (): void => {
      const file = input.files?.[0] ?? null;
      settle(file ? { file, handle: null } : null);
    };

    const onCancel = (): void => settle(null);

    const checkFocus = (): void => {
      if (settled || fallbackTimer !== undefined) return;
      // A selected file's change event is authoritative. The delay gives it a
      // chance to land before an empty picker is treated as dismissed.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined;
        if (!settled && !input.files?.length) settle(null);
      }, FOCUS_FALLBACK_DELAY_MS);
    };

    const onFocus = (): void => checkFocus();
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') checkFocus();
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.body.append(input);
    input.click();
  });
}
