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
    const cleanup = (): void => input.remove();
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      resolve(file ? { file, handle: null } : null);
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}
