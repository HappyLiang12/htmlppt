import { describe, expect, it } from 'vitest';
import {
  deleteDraft,
  draftKey,
  hasUnsavedDraft,
  listDrafts,
  readDraft,
  writeDraft,
  type DraftRecord
} from './recovery.js';

describe('draft recovery helpers', () => {
  it('normalizes separators without changing the file name', () => {
    expect(draftKey('  C:\\decks\\Talk.HTML  ')).toBe('C:/decks/Talk.HTML');
    expect(draftKey('/decks/Talk.html')).toBe('/decks/Talk.html');
  });

  it('treats only different, non-empty content as recoverable', () => {
    const draft: DraftRecord = {
      key: 'deck.html',
      filePath: 'deck.html',
      html: '<html>edited</html>',
      savedAt: 1
    };
    expect(hasUnsavedDraft(draft, '<html>saved</html>')).toBe(true);
    expect(hasUnsavedDraft(draft, draft.html)).toBe(false);
    expect(hasUnsavedDraft(null, '<html>saved</html>')).toBe(false);
    expect(
      hasUnsavedDraft({ ...draft, html: '' }, '<html>saved</html>')
    ).toBe(false);
  });

  it('degrades to a no-op when IndexedDB is unavailable', async () => {
    expect(typeof indexedDB).toBe('undefined');
    await expect(readDraft('deck.html')).resolves.toBeNull();
    await expect(listDrafts()).resolves.toEqual([]);
    await expect(writeDraft({
      key: 'deck.html',
      filePath: 'deck.html',
      html: '<html></html>',
      savedAt: 1
    })).resolves.toBe(false);
    await expect(deleteDraft('deck.html')).resolves.toBe(false);
  });
});
