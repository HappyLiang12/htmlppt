export interface HistoryPushOptions {
  /**
   * Consecutive pushes with the same key inside the coalescing window replace
   * the previous entry instead of adding a new one.
   */
  coalesceKey?: string;
}

interface StoredEntry<T> {
  value: T;
  coalesceKey?: string;
  pushedAt: number;
}

const CAPACITY = 100;
const COALESCE_WINDOW_MS = 500;

export class History<T> {
  private entries: StoredEntry<T>[] = [];
  private index = -1;

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  push(entry: T, options: HistoryPushOptions = {}): void {
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
      previous.pushedAt = pushedAt;
      return;
    }

    this.entries.push({
      value: entry,
      coalesceKey: options.coalesceKey,
      pushedAt
    });
    if (this.entries.length > CAPACITY) {
      this.entries.splice(0, this.entries.length - CAPACITY);
    }
    this.index = this.entries.length - 1;
  }

  undo(): T | null {
    if (!this.canUndo) return null;
    this.index -= 1;
    return this.entries[this.index]?.value ?? null;
  }

  redo(): T | null {
    if (!this.canRedo) return null;
    this.index += 1;
    return this.entries[this.index]?.value ?? null;
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }
}
