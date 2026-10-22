export interface HistoryEntry<T, M = undefined> {
  value: T;
  /**
   * Caller state captured with the value. The editor stores the active slide
   * index so undo and redo restore the context the snapshot was recorded in.
   */
  meta: M;
}

export interface HistoryPushOptions<M = undefined> {
  /**
   * Consecutive pushes with the same key inside the coalescing window replace
   * the previous entry instead of adding a new one.
   */
  coalesceKey?: string;
  meta?: M;
}

interface StoredEntry<T, M> extends HistoryEntry<T, M> {
  coalesceKey?: string;
  pushedAt: number;
}

const CAPACITY = 100;
const COALESCE_WINDOW_MS = 500;

export class History<T, M = undefined> {
  private entries: StoredEntry<T, M>[] = [];
  private index = -1;

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  push(entry: T, options: HistoryPushOptions<M> = {}): void {
    const pushedAt = Date.now();
    const branched = this.index < this.entries.length - 1;
    if (branched) {
      this.entries = this.entries.slice(0, this.index + 1);
    }

    const previous = this.entries[this.index];
    if (
      !branched &&
      previous &&
      options.coalesceKey !== undefined &&
      previous.coalesceKey === options.coalesceKey &&
      pushedAt - previous.pushedAt <= COALESCE_WINDOW_MS
    ) {
      previous.value = entry;
      if ('meta' in options) previous.meta = options.meta as M;
      previous.pushedAt = pushedAt;
      return;
    }

    this.entries.push({
      value: entry,
      meta: options.meta as M,
      coalesceKey: options.coalesceKey,
      pushedAt
    });
    if (this.entries.length > CAPACITY) {
      this.entries.splice(0, this.entries.length - CAPACITY);
    }
    this.index = this.entries.length - 1;
  }

  /**
   * Navigation does not add a history entry, but it changes the active context
   * of the newest snapshot (for example after inserting and showing a slide).
   */
  updateCurrentMeta(meta: M): void {
    const current = this.entries[this.index];
    if (current) current.meta = meta;
  }

  undo(): HistoryEntry<T, M> | null {
    if (!this.canUndo) return null;
    this.index -= 1;
    return this.entryAtCurrent();
  }

  redo(): HistoryEntry<T, M> | null {
    if (!this.canRedo) return null;
    this.index += 1;
    return this.entryAtCurrent();
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }

  private entryAtCurrent(): HistoryEntry<T, M> | null {
    const entry = this.entries[this.index];
    return entry ? { value: entry.value, meta: entry.meta } : null;
  }
}
