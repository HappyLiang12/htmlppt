import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickHtmlFile } from './file-picker';

const INPUT_SELECTOR = 'input[data-testid="file-picker-input"]';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document
    .querySelectorAll(INPUT_SELECTOR)
    .forEach((input) => input.remove());
});

describe('pickHtmlFile', () => {
  it('returns the file and handle from showOpenFilePicker', async () => {
    const file = new File(['<!doctype html>'], 'deck.html', {
      type: 'text/html'
    });
    const handle = {
      kind: 'file',
      name: 'deck.html',
      getFile: vi.fn().mockResolvedValue(file)
    } as unknown as FileSystemFileHandle;
    const picker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', picker);

    await expect(pickHtmlFile()).resolves.toEqual({ file, handle });
    expect(picker).toHaveBeenCalledWith({
      multiple: false,
      types: [
        {
          description: 'HTML deck',
          accept: { 'text/html': ['.html', '.htm'] }
        }
      ]
    });
    expect(document.querySelector(INPUT_SELECTOR)).toBeNull();
  });

  it('resolves null when focus returns without a chosen file', async () => {
    vi.useFakeTimers();
    const pending = pickHtmlFile();
    expect(document.querySelector(INPUT_SELECTOR)).not.toBeNull();

    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeNull();
    expect(document.querySelector(INPUT_SELECTOR)).toBeNull();
  });

  it('keeps the change event authoritative over the focus fallback', async () => {
    vi.useFakeTimers();
    const file = new File(['<!doctype html>'], 'picked.html', {
      type: 'text/html'
    });
    const pending = pickHtmlFile();
    const input = document.querySelector(INPUT_SELECTOR) as HTMLInputElement;
    expect(input).not.toBeNull();
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file]
    });

    window.dispatchEvent(new Event('focus'));
    input.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({ file, handle: null });
    expect(document.querySelector(INPUT_SELECTOR)).toBeNull();
  });
});
