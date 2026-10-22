export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

const DEFAULT_EVENT_TIMEOUT_MS = 5_000;
const TIMEOUT = Symbol('timeout');

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/** Minimal SSE reader with a bounded wait for each event. */
export class SseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly queue: SseEvent[] = [];
  private ended = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async next(timeoutMs = DEFAULT_EVENT_TIMEOUT_MS): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.queue.shift();
      if (queued) {
        return queued;
      }
      if (this.ended) {
        throw new Error('The SSE stream ended before the expected event.');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for an SSE event.`
        );
      }
      const result = await withTimeout(this.reader.read(), remaining);
      if (result === TIMEOUT) {
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for an SSE event.`
        );
      }
      if (result.done) {
        this.ended = true;
        continue;
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
      this.drain();
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  private drain(): void {
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary === -1) {
        return;
      }
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let eventName = 'message';
      const data: string[] = [];
      for (const rawLine of block.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith(':')) {
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value =
          colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') {
          eventName = value;
        } else if (field === 'data') {
          data.push(value);
        }
      }
      if (data.length === 0) {
        continue;
      }
      const parsed: unknown = JSON.parse(data.join('\n'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The SSE data is not a JSON object.');
      }
      this.queue.push({
        event: eventName,
        data: parsed as Record<string, unknown>
      });
    }
  }
}

/** Opens a shared SSE reader from a successful event-stream response. */
export function openEventStream(response: Response): SseStream {
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open the event stream: ${response.status}`);
  }
  return new SseStream(response.body);
}
