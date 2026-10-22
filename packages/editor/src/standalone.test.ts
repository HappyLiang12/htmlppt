import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStandalonePersistence,
  downloadHtml,
  exportFileName,
  hashHtml,
  type StandaloneSession
} from './standalone.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('standalone persistence', () => {
  it('derives export names from deck names and paths', () => {
    expect(exportFileName('deck.html')).toBe('deck.export.html');
    expect(exportFileName('Talk.HTM')).toBe('Talk.export.html');
    expect(exportFileName('C:\\decks\\Talk.html')).toBe('Talk.export.html');
    expect(exportFileName('/decks/slide')).toBe('slide.export.html');
    expect(exportFileName('deck.html', '.html')).toBe('deck.html');
  });

  it('hashes content deterministically and detects changes', async () => {
    const first = await hashHtml('<html>一</html>');
    const second = await hashHtml('<html>一</html>');
    const third = await hashHtml('<html>二</html>');
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toMatch(/^[0-9a-f]{8,64}$/);
  });

  it('writes through a File System Access handle', async () => {
    const writes: string[] = [];
    const handle = {
      createWritable: async () => ({
        write: async (value: string) => {
          writes.push(value);
        },
        close: async () => undefined
      })
    } as unknown as FileSystemFileHandle;
    const session: StandaloneSession = { name: 'deck.html', handle };
    const persistence = createStandalonePersistence(() => session);

    const saved = await persistence.save('<html>edited</html>', 'old');

    expect(writes).toEqual(['<html>edited</html>']);
    expect(saved.revision).toBe(await hashHtml('<html>edited</html>'));
  });

  it('rejects saves before a deck is open', async () => {
    const persistence = createStandalonePersistence(() => null);
    await expect(persistence.save('<html></html>', '')).rejects.toThrow(
      /沒有開啟/
    );
    await expect(persistence.load()).rejects.toThrow(/需要先開啟/);
  });

  it('downloads HTML under a file-safe name', () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        clicks.push(this.download);
      }
    );
    const create = vi.fn(() => 'blob:htmlppt');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: create
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revoke
    });

    downloadHtml('<html></html>', 'C:\\decks\\Talk.html');

    expect(clicks).toEqual(['Talk.export.html']);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
