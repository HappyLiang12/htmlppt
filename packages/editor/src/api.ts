export interface DeckResponse {
  html: string;
  revision: string;
  filePath: string;
}

export function tokenFromLocation(): string {
  return new URLSearchParams(location.search).get('token') ?? '';
}

export async function fetchDeck(token: string): Promise<DeckResponse> {
  const response = await fetch('/api/deck', {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to load deck (${response.status})`);
  }
  return (await response.json()) as DeckResponse;
}

export interface SaveDeckOptions {
  force?: boolean;
}

export async function saveDeck(
  token: string,
  html: string,
  baseRevision: string,
  options: SaveDeckOptions = {}
): Promise<{ revision: string }> {
  const response = await fetch('/api/deck', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      html,
      baseRevision,
      ...(options.force ? { force: true } : {})
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Save failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as { revision: string };
}
