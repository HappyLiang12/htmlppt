export type PresenterMessage =
  | { sessionId: string; type: 'request' }
  | {
      sessionId: string;
      type: 'snapshot';
      html: string;
      index: number;
      total: number;
    }
  | { sessionId: string; type: 'state'; index: number; total: number }
  | { sessionId: string; type: 'slide'; index: number }
  | { sessionId: string; type: 'bye' };

const SESSION_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function presenterChannelName(sessionId: string): string {
  return `htmlppt-presenter-${sessionId}`;
}

export function isPresenterSessionId(
  value: string | null | undefined
): value is string {
  return typeof value === 'string' && SESSION_PATTERN.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function slideState(
  value: unknown,
  totalLimit: number
): { index: number; total: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { index, total } = record;
  if (!isCount(index) || !isCount(total)) return null;
  if (total < 1 || total > totalLimit) return null;
  if (index < 0 || index >= total) return null;
  return { index, total };
}

/**
 * Validates a channel envelope against the presentation that owns it. Every
 * message is scoped by sessionId so two decks on one origin cannot cross-talk.
 */
export function parsePresenterMessage(
  value: unknown,
  sessionId: string
): PresenterMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.sessionId !== sessionId) return null;
  if (record.type === 'request') return { sessionId, type: 'request' };
  if (record.type === 'bye') return { sessionId, type: 'bye' };
  if (record.type === 'slide') {
    if (!isCount(record.index) || record.index < 0) return null;
    return { sessionId, type: 'slide', index: record.index };
  }
  if (record.type === 'state') {
    const state = slideState(record, 10_000);
    return state ? { sessionId, type: 'state', ...state } : null;
  }
  if (record.type === 'snapshot') {
    if (typeof record.html !== 'string' || record.html.length === 0) {
      return null;
    }
    const state = slideState(record, 10_000);
    return state
      ? { sessionId, type: 'snapshot', html: record.html, ...state }
      : null;
  }
  return null;
}

/** Clamps a presenter request to the authoritative slide range. */
export function presenterSlideIndex(
  value: unknown,
  total: number
): number | null {
  if (!isCount(value) || !isCount(total) || total < 1) return null;
  if (value < 0 || value >= total) return null;
  return value;
}
