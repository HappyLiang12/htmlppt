import { afterEach, describe, expect, it, vi } from 'vitest';
import { History, type HistoryPushOptions } from './history.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('History', () => {
  it('returns entries in undo and redo order', () => {
    const history = new History<string, number>();
    history.push('a', { meta: 0 });
    history.push('b', { meta: 0 });
    history.push('c', { meta: 0 });

    expect(history.canUndo).toBe(true);
    expect(history.undo()).toEqual({ value: 'b', meta: 0 });
    expect(history.undo()).toEqual({ value: 'a', meta: 0 });
    expect(history.undo()).toBeNull();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    expect(history.redo()).toEqual({ value: 'b', meta: 0 });
    expect(history.redo()).toEqual({ value: 'c', meta: 0 });
    expect(history.redo()).toBeNull();
    expect(history.canRedo).toBe(false);
  });

  it('requires meta on every push so entries never store undefined', () => {
    const history = new History<string, number>();
    const options: HistoryPushOptions<number> = { meta: 0 };
    // @ts-expect-error meta is required; a push without it must not typecheck.
    const missing: HistoryPushOptions<number> = {};

    expect(options.meta).toBe(0);
    expect(missing).toEqual({});
    expect(history.canUndo).toBe(false);
  });

  it('keeps the newest 100 entries', () => {
    const history = new History<number, number>();
    for (let value = 0; value < 101; value += 1) {
      history.push(value, { meta: 0 });
    }

    for (let value = 99; value >= 1; value -= 1) {
      expect(history.undo()?.value).toBe(value);
    }
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()?.value).toBe(2);
  });

  it('clears the redo branch when pushing after an undo', () => {
    const history = new History<string, number>();
    history.push('a', { meta: 0 });
    history.push('b', { meta: 0 });
    history.push('c', { meta: 0 });
    expect(history.undo()?.value).toBe('b');

    history.push('d', { meta: 0 });

    expect(history.canRedo).toBe(false);
    expect(history.redo()).toBeNull();
    expect(history.undo()?.value).toBe('b');
    expect(history.undo()?.value).toBe('a');
  });

  it('carries and restores the meta recorded with each entry', () => {
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('added slide', { meta: 1 });

    expect(history.undo()).toEqual({ value: 'baseline', meta: 0 });
    expect(history.redo()).toEqual({ value: 'added slide', meta: 1 });
  });

  it('updates the current entry meta without adding an entry', () => {
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('added slide', { meta: 0 });

    history.updateCurrentMeta(2);

    expect(history.canRedo).toBe(false);
    expect(history.undo()).toEqual({ value: 'baseline', meta: 0 });
    expect(history.redo()).toEqual({ value: 'added slide', meta: 2 });
  });

  it('keeps the latest meta when a push coalesces', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('drag-1', { coalesceKey: 'drag', meta: 0 });

    vi.setSystemTime(400);
    history.push('drag-2', { coalesceKey: 'drag', meta: 1 });

    expect(history.undo()).toEqual({ value: 'baseline', meta: 0 });
    expect(history.redo()).toEqual({ value: 'drag-2', meta: 1 });
  });

  it('coalesces pushes with the same key inside 500 ms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('drag-1', { coalesceKey: 'drag', meta: 0 });

    vi.setSystemTime(400);
    history.push('drag-2', { coalesceKey: 'drag', meta: 0 });

    expect(history.undo()?.value).toBe('baseline');
    expect(history.undo()).toBeNull();
  });

  it('coalesces exactly at the 500 ms boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('edit-1', { coalesceKey: 'text', meta: 0 });

    vi.setSystemTime(500);
    history.push('edit-2', { coalesceKey: 'text', meta: 0 });

    expect(history.undo()?.value).toBe('baseline');
  });

  it('does not coalesce across keys', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('drag', { coalesceKey: 'drag', meta: 0 });
    history.push('resize', { coalesceKey: 'resize', meta: 0 });

    expect(history.undo()?.value).toBe('drag');
    expect(history.undo()?.value).toBe('baseline');
  });

  it('does not coalesce outside the 500 ms window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('edit-1', { coalesceKey: 'text', meta: 0 });

    vi.setSystemTime(501);
    history.push('edit-2', { coalesceKey: 'text', meta: 0 });

    expect(history.undo()?.value).toBe('edit-1');
    expect(history.undo()?.value).toBe('baseline');
  });

  it('restarts the coalescing window on every coalesced push', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('edit-1', { coalesceKey: 'drag', meta: 0 });

    vi.setSystemTime(400);
    history.push('edit-2', { coalesceKey: 'drag', meta: 0 });
    vi.setSystemTime(800);
    history.push('edit-3', { coalesceKey: 'drag', meta: 0 });

    expect(history.undo()?.value).toBe('baseline');
    expect(history.undo()).toBeNull();
  });

  it('does not coalesce after an undo created a new branch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string, number>();
    history.push('baseline', { meta: 0 });
    history.push('edit-1', { coalesceKey: 'text', meta: 0 });
    vi.setSystemTime(100);
    history.push('edit-2', { coalesceKey: 'text', meta: 0 });
    expect(history.undo()?.value).toBe('baseline');

    vi.setSystemTime(200);
    history.push('edit-3', { coalesceKey: 'text', meta: 0 });

    expect(history.undo()?.value).toBe('baseline');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });

  it('clears every entry', () => {
    const history = new History<string, number>();
    history.push('a', { meta: 0 });
    history.push('b', { meta: 0 });

    history.clear();

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });
});
