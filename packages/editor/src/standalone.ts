import type { DeckPersistence } from './api';
import { draftKey, writeDraft } from './recovery';

export interface StandaloneSession {
  /** Display name and download name; never a full path. */
  name: string;
  /** Present when opened through the File System Access API. */
  handle: FileSystemFileHandle | null;
}

function fallbackHash(html: string): string {
  let first = 0x811c9dc5;
  let second = 0x1000193;
  for (let index = 0; index < html.length; index += 1) {
    const code = html.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second
    .toString(16)
    .padStart(8, '0')}`;
}

/** Stable local revision; host revisions are SHA-256 and never mix with this. */
export async function hashHtml(html: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(html);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(html));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Standalone saves write the opened file when a File System Access handle
 * exists. Upload-only browsers keep the last state in IndexedDB, so the UI
 * offers an explicit download instead of pretending the file was rewritten.
 */
export function createStandalonePersistence(
  getSession: () => StandaloneSession | null
): DeckPersistence {
  const save = async (html: string): Promise<{ revision: string }> => {
    const session = getSession();
    if (!session) throw new Error('目前沒有開啟的簡報。');
    if (session.handle) {
      const writable = await session.handle.createWritable();
      try {
        await writable.write(html);
      } finally {
        await writable.close();
      }
    } else {
      await writeDraft({
        key: draftKey(session.name),
        filePath: session.name,
        html,
        savedAt: Date.now()
      });
    }
    return { revision: await hashHtml(html) };
  };

  return {
    load: async () => {
      throw new Error('獨立模式需要先開啟 HTML 檔案。');
    },
    save: (html) => save(html),
    flush: (html) => {
      void save(html).catch(() => undefined);
    }
  };
}

export function exportFileName(name: string, suffix = '.export.html'): string {
  const basename = name.replace(/\\/g, '/').split('/').pop() ?? 'deck.html';
  const stem = basename.replace(/\.html?$/i, '') || 'deck';
  return `${stem}${suffix}`;
}

export function downloadHtml(
  html: string,
  name: string,
  suffix = '.export.html'
): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exportFileName(name, suffix);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
