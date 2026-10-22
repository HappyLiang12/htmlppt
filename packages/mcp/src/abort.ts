/**
 * True when a fetch failed because its AbortSignal fired. Node's
 * AbortSignal.timeout() rejects with a TimeoutError DOMException; other
 * abort paths use AbortError.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const value = error as { name?: unknown; code?: unknown };
  return (
    value.name === 'AbortError' ||
    value.name === 'TimeoutError' ||
    value.code === 'ABORT_ERR'
  );
}
