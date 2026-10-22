import { detectSlides } from '@htmlppt/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_DELAY_MS,
  createAutosave,
  decideRevision,
  planConflictResolution,
  remapSelections
} from './live-sync.js';
import { parseDeck } from './slide-doc.js';

describe('decideRevision', () => {
  it('ignores the revision the editor already synced', () => {
    expect(
      decideRevision(
        { type: 'revision', revision: 'r1', source: 'editor' },
        { revision: 'r1', dirty: false }
      )
    ).toEqual({ type: 'ignore' });
  });

  it('ignores events without a revision', () => {
    expect(
      decideRevision(
        { type: 'revision', revision: '' },
        { revision: 'r1', dirty: true }
      )
    ).toEqual({ type: 'ignore' });
  });

  it('applies a clean external revision', () => {
    expect(
      decideRevision(
        { type: 'revision', revision: 'r2', source: 'external' },
        { revision: 'r1', dirty: false }
      )
    ).toEqual({ type: 'apply', revision: 'r2', source: 'external' });
  });

  it('treats the SSE hello as a revision signal', () => {
    expect(
      decideRevision(
        { type: 'hello', revision: 'r2' },
        { revision: 'r1', dirty: false }
      )
    ).toEqual({ type: 'apply', revision: 'r2', source: undefined });
  });

  it('raises a conflict when local edits are dirty', () => {
    expect(
      decideRevision(
        { type: 'revision', revision: 'r2', source: 'mcp' },
        { revision: 'r1', dirty: true }
      )
    ).toEqual({ type: 'conflict', revision: 'r2', source: 'mcp' });
  });
});

describe('planConflictResolution', () => {
  it('reload discards local edits and clears the banner', () => {
    expect(planConflictResolution('reload')).toEqual({
      applyExternal: true,
      force: false,
      clearConflict: true
    });
  });

  it('overwrite writes local content with force and clears the banner', () => {
    expect(planConflictResolution('overwrite')).toEqual({
      applyExternal: false,
      force: true,
      clearConflict: true
    });
  });
});

describe('remapSelections', () => {
  const previous = parseDeck(`<!doctype html>
<html><body><main data-ppt-deck>
<section class="slide" data-slide-id="s1"><h1 data-ppt-el="e1">One</h1></section>
<section class="slide" data-slide-id="s2"><h1 data-ppt-el="e1">Two</h1></section>
</main></body></html>`);
  const next = parseDeck(`<!doctype html>
<html><body><main data-ppt-deck>
<section class="slide" data-slide-id="s0"><h1 data-ppt-el="e1">Inserted</h1></section>
<section class="slide" data-slide-id="s1"><h1 data-ppt-el="e1">One</h1></section>
<section class="slide" data-slide-id="s2"><p data-ppt-el="p1">Intro</p><h1 data-ppt-el="e1">Two</h1></section>
</main></body></html>`);

  it('remaps by slide id and element id when the element moved', () => {
    expect(
      remapSelections(
        [{ slideIndex: 1, path: [0], elementId: 'e1' }],
        detectSlides(previous),
        detectSlides(next)
      )
    ).toEqual([{ slideIndex: 2, path: [1], elementId: 'e1' }]);
  });

  it('drops selections whose slide or element is gone', () => {
    expect(
      remapSelections(
        [
          { slideIndex: 0, path: [0], elementId: 'missing' },
          { slideIndex: 1, path: [0], elementId: null },
          { slideIndex: 7, path: [0], elementId: 'e1' }
        ],
        detectSlides(previous),
        detectSlides(next)
      )
    ).toEqual([]);
  });
});

describe('autosave debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once 800 ms after the last schedule', () => {
    expect(AUTOSAVE_DELAY_MS).toBe(800);
    const run = vi.fn();
    const autosave = createAutosave(AUTOSAVE_DELAY_MS, run);

    autosave.schedule();
    vi.advanceTimersByTime(400);
    autosave.schedule();
    vi.advanceTimersByTime(799);
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancel drops a pending save and flush runs it immediately', () => {
    const run = vi.fn();
    const autosave = createAutosave(AUTOSAVE_DELAY_MS, run);

    autosave.schedule();
    autosave.cancel();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    expect(run).not.toHaveBeenCalled();

    autosave.schedule();
    autosave.flush();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
