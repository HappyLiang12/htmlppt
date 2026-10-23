import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deckEventsUrl,
  exportDeck,
  fetchDeck,
  flushDeck,
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
