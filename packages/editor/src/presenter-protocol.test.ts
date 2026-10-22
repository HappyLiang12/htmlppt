import { describe, expect, it } from 'vitest';
import {
  isPresenterSessionId,
  parsePresenterMessage,
  presenterChannelName,
  presenterSlideIndex
} from './presenter-protocol.js';

const SESSION = 'f1f3c2a4-54b7-4d61-9c55-a0f0b8b8f9e2';

describe('presenter protocol', () => {
  it('scopes channel names and session ids', () => {
    expect(presenterChannelName(SESSION)).toBe(
      `htmlppt-presenter-${SESSION}`
    );
    expect(isPresenterSessionId(SESSION)).toBe(true);
    expect(isPresenterSessionId('short')).toBe(false);
    expect(isPresenterSessionId('has space here')).toBe(false);
    expect(isPresenterSessionId(null)).toBe(false);
  });

  it('rejects envelopes from another presentation or with unknown types', () => {
    expect(
      parsePresenterMessage({ sessionId: 'other-session-id', type: 'state' }, SESSION)
    ).toBeNull();
    expect(parsePresenterMessage({ sessionId: SESSION, type: 'ping' }, SESSION)).toBeNull();
    expect(parsePresenterMessage(null, SESSION)).toBeNull();
    expect(parsePresenterMessage('state', SESSION)).toBeNull();
  });

  it('validates slide requests and authoritative state ranges', () => {
    expect(
      parsePresenterMessage({ sessionId: SESSION, type: 'slide', index: 2 }, SESSION)
    ).toEqual({ sessionId: SESSION, type: 'slide', index: 2 });
    for (const index of [-1, 1.5, '2', null, undefined]) {
      expect(
        parsePresenterMessage({ sessionId: SESSION, type: 'slide', index }, SESSION)
      ).toBeNull();
    }

    expect(
      parsePresenterMessage(
        { sessionId: SESSION, type: 'state', index: 1, total: 3 },
        SESSION
      )
    ).toEqual({ sessionId: SESSION, type: 'state', index: 1, total: 3 });
    expect(
      parsePresenterMessage(
        { sessionId: SESSION, type: 'state', index: 3, total: 3 },
        SESSION
      )
    ).toBeNull();
    expect(
      parsePresenterMessage(
        { sessionId: SESSION, type: 'state', index: 0, total: 0 },
        SESSION
      )
    ).toBeNull();
  });

  it('accepts snapshots only with a non-empty deck and a valid range', () => {
    expect(
      parsePresenterMessage(
        {
          sessionId: SESSION,
          type: 'snapshot',
          html: '<main data-ppt-deck></main>',
          index: 0,
          total: 2
        },
        SESSION
      )
    ).toMatchObject({ type: 'snapshot', index: 0, total: 2 });
    expect(
      parsePresenterMessage(
        { sessionId: SESSION, type: 'snapshot', html: '', index: 0, total: 2 },
        SESSION
      )
    ).toBeNull();
    expect(
      parsePresenterMessage(
        { sessionId: SESSION, type: 'snapshot', html: '<main></main>', index: 5, total: 2 },
        SESSION
      )
    ).toBeNull();
  });

  it('clamps requests to the authoritative slide count', () => {
    expect(presenterSlideIndex(0, 3)).toBe(0);
    expect(presenterSlideIndex(2, 3)).toBe(2);
    expect(presenterSlideIndex(3, 3)).toBeNull();
    expect(presenterSlideIndex(-1, 3)).toBeNull();
    expect(presenterSlideIndex(1, 0)).toBeNull();
    expect(presenterSlideIndex('1', 3)).toBeNull();
  });
});
