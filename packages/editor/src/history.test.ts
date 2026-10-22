import { afterEach, describe, expect, it, vi } from 'vitest';
import { History } from './history.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('History', () => {
  it('returns entries in undo and redo order', () => {
    const history = new History<string>();
    history.push('a');
    history.push('b');
    history.push('c');

    expect(history.canUndo).toBe(true);
    expect(history.undo()).toBe('b');
    expect(history.undo()).toBe('a');
    expect(history.undo()).toBeNull();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    expect(history.redo()).toBe('b');
    expect(history.redo()).toBe('c');
    expect(history.redo()).toBeNull();
    expect(history.canRedo).toBe(false);
  });

  it('keeps the newest 100 entries', () => {
    const history = new History<number>();
    for (let value = 0; value < 101; value += 1) {
      history.push(value);
    }

    for (let value = 99; value >= 1; value -= 1) {
      expect(history.undo()).toBe(value);
    }
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBe(2);
  });

  it('clears the redo branch when pushing after an undo', () => {
    const history = new History<string>();
    history.push('a');
    history.push('b');
    history.push('c');
    expect(history.undo()).toBe('b');

    history.push('d');

    expect(history.canRedo).toBe(false);
    expect(history.redo()).toBeNull();
    expect(history.undo()).toBe('b');
    expect(history.undo()).toBe('a');
  });

  it('coalesces pushes with the same key inside 500 ms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string>();
    history.push('baseline');
    history.push('drag-1', { coalesceKey: 'drag' });

    vi.setSystemTime(400);
    history.push('drag-2', { coalesceKey: 'drag' });

    expect(history.undo()).toBe('baseline');
    expect(history.undo()).toBeNull();
  });

  it('coalesces exactly at the 500 ms boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string>();
    history.push('baseline');
    history.push('edit-1', { coalesceKey: 'text' });

    vi.setSystemTime(500);
    history.push('edit-2', { coalesceKey: 'text' });

    expect(history.undo()).toBe('baseline');
  });

  it('does not coalesce across keys', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string>();
    history.push('baseline');
    history.push('drag', { coalesceKey: 'drag' });
    history.push('resize', { coalesceKey: 'resize' });

    expect(history.undo()).toBe('drag');
    expect(history.undo()).toBe('baseline');
  });

  it('does not coalesce outside the 500 ms window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string>();
    history.push('baseline');
    history.push('edit-1', { coalesceKey: 'text' });

    vi.setSystemTime(501);
    history.push('edit-2', { coalesceKey: 'text' });

    expect(history.undo()).toBe('edit-1');
    expect(history.undo()).toBe('baseline');
  });

  it('restarts the coalescing window on every coalesced push', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string>();
    history.push('baseline');
    history.push('edit-1', { coalesceKey: 'drag' });

    vi.setSystemTime(400);
    history.push('edit-2', { coalesceKey: 'drag' });
    vi.setSystemTime(800);
    history.push('edit-3', { coalesceKey: 'drag' });

    expect(history.undo()).toBe('baseline');
    expect(history.undo()).toBeNull();
  });

  it('does not coalesce after an undo created a new branch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const history = new History<string>();
    history.push('baseline');
    history.push('edit-1', { coalesceKey: 'text' });
    vi.setSystemTime(100);
    history.push('edit-2', { coalesceKey: 'text' });
    expect(history.undo()).toBe('baseline');

    vi.setSystemTime(200);
    history.push('edit-3', { coalesceKey: 'text' });

    expect(history.undo()).toBe('baseline');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });

  it('clears every entry', () => {
    const history = new History<string>();
    history.push('a');
    history.push('b');

    history.clear();

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });
});
