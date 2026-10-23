import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeckRevisionEvent } from './live-sync';
import {
  deckEventsUrl,
  exportDeck,
  fetchDeck,
  flushDeck,
  openDeck,
  openDeckEvents,
  saveDeck
} from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host API authentication', () => {
  it('loads the deck with the same-origin cookie only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        html: '<main data-ppt-deck></main>',
        revision: 'r1',
        filePath: 'deck.html'
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchDeck();

    expect(fetchMock).toHaveBeenCalledWith('/api/deck');
  });

  it('saves without an authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ revision: 'r2' })
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveDeck('<main data-ppt-deck></main>', 'r1');

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('/api/deck');
    expect(call[1].method).toBe('PUT');
    expect(call[1].headers).toEqual({ 'content-type': 'application/json' });
    expect(call[1].credentials).toBeUndefined();
  });

  it('opens the event stream at the same-origin endpoint', () => {
    expect(deckEventsUrl()).toBe('/api/events');
  });

  it('parses the opened file path from a revision event', () => {
    class FakeEventSource {
      static latest: FakeEventSource | null = null;
      readonly listeners = new Map<string, (event: Event) => void>();
      constructor(readonly url: string) {
        FakeEventSource.latest = this;
      }
      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, listener);
      }
      emit(type: string, data: unknown): void {
        this.listeners.get(type)?.({
          data: JSON.stringify(data)
        } as MessageEvent<string>);
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const events: DeckRevisionEvent[] = [];

    openDeckEvents((event) => events.push(event));
    FakeEventSource.latest?.emit('revision', {
      revision: 'r2',
      source: 'external',
      filePath: '/decks/second.html'
    });

    expect(events).toEqual([
      {
        type: 'revision',
        revision: 'r2',
        source: 'external',
        filePath: '/decks/second.html'
      }
    ]);
  });

  it('opens a deck path and surfaces its error code', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          html: '<main data-ppt-deck></main>',
          revision: 'r1',
          filePath: 'D:/decks/next.html',
          url: '/d/next.html'
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'not-found', message: 'Could not read it.' }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(openDeck('next.html')).resolves.toMatchObject({
      url: '/d/next.html'
    });
    await expect(openDeck('missing.html')).rejects.toMatchObject({
      name: 'DeckOpenError',
      status: 404,
      code: 'not-found'
    });
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('/api/open');
    expect(call[1].body).toBe(JSON.stringify({ path: 'next.html' }));
  });

  it('never exposes a raw error body when the payload has no message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'internal' }), {
          status: 500,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response('upstream boom', {
          status: 502,
          headers: { 'content-type': 'text/plain' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(openDeck('deck.html')).rejects.toMatchObject({
      name: 'DeckOpenError',
      code: 'internal',
      message: '開啟失敗。'
    });
    await expect(openDeck('deck.html')).rejects.toMatchObject({
      name: 'DeckOpenError',
      code: 'open-failed',
      message: '開啟失敗。'
    });
  });

  it('exports and flushes with the cookie only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ files: ['deck.pdf'] }))
      .mockResolvedValueOnce(jsonResponse({ revision: 'r2' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exportDeck('pdf')).resolves.toEqual(['deck.pdf']);
    flushDeck('<main data-ppt-deck></main>', 'r1');
    await Promise.resolve();

    const exportCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(exportCall[0]).toBe('/api/export');
    expect(exportCall[1].headers).toEqual({
      'content-type': 'application/json'
    });

    const flushCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(flushCall[0]).toBe('/api/deck');
    expect(flushCall[1].keepalive).toBe(true);
    expect(flushCall[1].headers).toEqual({
      'content-type': 'application/json'
    });
  });
});
