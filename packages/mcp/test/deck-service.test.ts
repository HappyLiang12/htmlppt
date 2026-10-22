import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DeckMutationError,
  addSlide,
  deleteSlide,
  setText,
  validateDeck
} from '@htmlppt/core';
import { hashHtml, parseDeckHtml, readDeckFile } from '@htmlppt/core/node';
import { startHost, writeSession, type HostHandle } from '@htmlppt/host';
import { copyFixture, makeTempDir } from '@htmlppt/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeckConflictError,
  DirectDeckService,
  HostDeckService,
  createDeckService
} from '../src/deck-service.js';

interface HostContext {
  host: HostHandle;
  base: string;
  token: string;
  revision: string;
}

let dir: string;
let deckPath: string;
let host: HostHandle | undefined;
let previousHome: string | undefined;

function requireElement(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Expected "${selector}" to match an element.`);
  }
  return element;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject.');
}

async function setupHost(): Promise<HostContext> {
  const editorDir = join(dir, 'editor');
  await mkdir(editorDir);
  await writeFile(
    join(editorDir, 'index.html'),
    '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
    'utf8'
  );
  deckPath = await copyFixture('basic.deck.html', dir);
  const token = randomUUID();
  host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
  const base = new URL(host.url).origin;
  const response = await fetch(`${base}/api/deck`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to read the deck from the host: ${response.status}`);
  }
  const payload = (await response.json()) as { revision: string };
  return { host, base, token, revision: payload.revision };
}

beforeEach(async () => {
  dir = await makeTempDir('htmlppt-mcp-');
  previousHome = process.env.HTMLPPT_HOME;
  process.env.HTMLPPT_HOME = join(dir, 'home');
});

afterEach(async () => {
  try {
    await host?.close();
  } finally {
    host = undefined;
    if (previousHome === undefined) {
      delete process.env.HTMLPPT_HOME;
    } else {
      process.env.HTMLPPT_HOME = previousHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe('DirectDeckService', () => {
  it('loads a deck and normalizes missing ids in memory without writing', async () => {
    const messyPath = await copyFixture('messy.deck.html', dir);
    const original = await readFile(messyPath);
    const originalHtml = original.toString('utf8');
    const service = new DirectDeckService();

    const snapshot = await service.load(messyPath);

    expect(snapshot.filePath).toBe(messyPath);
    expect(snapshot.html).toBe(originalHtml);
    expect(snapshot.revision).toBe(hashHtml(originalHtml));
    const slides = Array.from(snapshot.document.querySelectorAll('section'));
    expect(slides.map((slide) => slide.getAttribute('data-slide-id'))).toEqual([
      's1',
      's2'
    ]);
    expect(
      requireElement(snapshot.document, 'section h1').getAttribute('data-ppt-el')
    ).toBe('e1');
    expect(await readFile(messyPath)).toEqual(original);
  });

  it('saves a mutation as normalized valid html with a new revision', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const original = await readFile(deckPath, 'utf8');
    const service = new DirectDeckService();
    const snapshot = await service.load(deckPath);

    const result = await service.save(deckPath, snapshot, (draft) => {
      setText(requireElement(draft, '[data-ppt-el="e1"]'), 'Edited heading');
      addSlide(draft, {
        html: '<h1>Added slide</h1>',
        notes: 'Added by the service test'
      });
    });

    expect(result.revision).not.toBe(snapshot.revision);
    expect(result.document).not.toBe(snapshot.document);
    expect(
      requireElement(snapshot.document, '[data-ppt-el="e1"]').textContent
    ).toBe('Basic deck');
    expect(result.document.querySelectorAll('[data-slide-id]').length).toBe(3);
    const saved = await readDeckFile(deckPath);
    expect(saved.hash).toBe(result.revision);
    expect(saved.html).not.toBe(original);
    expect(saved.html).toContain('Edited heading');
    expect(saved.html).toContain('Added slide');
    expect(validateDeck(parseDeckHtml(saved.html)).valid).toBe(true);
    const savedDocument = parseDeckHtml(saved.html);
    expect(savedDocument.querySelector('section h1')?.getAttribute('data-ppt-el')).toBe(
      'e1'
    );
    for (const slide of Array.from(
      savedDocument.querySelectorAll('[data-slide-id]')
    )) {
      expect(slide.getAttribute('data-slide-id')).toBeTruthy();
    }
  });

  it('rejects a stale snapshot and leaves the external file byte-identical', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const service = new DirectDeckService();
    const snapshot = await service.load(deckPath);
    const external = (await readFile(deckPath, 'utf8')).replace(
      'Basic deck',
      'External edit'
    );
    await writeFile(deckPath, external, 'utf8');
    const externalBytes = await readFile(deckPath);

    const error = await rejection(
      service.save(deckPath, snapshot, (draft) => {
        setText(requireElement(draft, '[data-ppt-el="e1"]'), 'MCP edit');
      })
    );

    expect(error).toBeInstanceOf(DeckConflictError);
    expect((error as DeckConflictError).code).toBe('conflict');
    expect((error as DeckConflictError).currentRevision).toBe(hashHtml(external));
    expect(await readFile(deckPath)).toEqual(externalBytes);
  });

  it('surfaces DeckMutationError and does not write', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const original = await readFile(deckPath);
    const snapshot = await new DirectDeckService().load(deckPath);

    const error = await rejection(
      new DirectDeckService().save(deckPath, snapshot, (draft) => {
        deleteSlide(draft, 'missing-slide');
      })
    );

    expect(error).toBeInstanceOf(DeckMutationError);
    expect((error as DeckMutationError).code).toBe('slide-not-found');
    expect(await readFile(deckPath)).toEqual(original);
  });

  it('writes raw html with compare-and-swap', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const service = new DirectDeckService();
    const snapshot = await service.load(deckPath);
    const next = snapshot.html.replace('Basic deck', 'Raw write');

    const result = await service.write(deckPath, next, snapshot.revision);

    expect(result.revision).toBe(hashHtml(next));
    expect(await readFile(deckPath, 'utf8')).toBe(next);

    const stale = await rejection(
      service.write(deckPath, next.replace('Raw write', 'Second write'), snapshot.revision)
    );
    expect(stale).toBeInstanceOf(DeckConflictError);
    expect((stale as DeckConflictError).currentRevision).toBe(result.revision);
    expect(await readFile(deckPath, 'utf8')).toBe(next);
  });
});

describe('HostDeckService', () => {
  it('loads and saves through a live host', async () => {
    const ctx = await setupHost();
    const service = new HostDeckService({ hostUrl: ctx.base, token: ctx.token });
    const snapshot = await service.load(deckPath);

    expect(snapshot.filePath).toBe(deckPath);
    expect(snapshot.revision).toBe(ctx.revision);
    expect(snapshot.html).toBe(await readFile(deckPath, 'utf8'));

    const result = await service.save(deckPath, snapshot, (draft) => {
      setText(requireElement(draft, '[data-ppt-el="e2"]'), 'Host edit');
      addSlide(draft, { html: '<h2>Host slide</h2>' });
    });

    expect(result.revision).not.toBe(snapshot.revision);
    expect(result.document.querySelectorAll('[data-slide-id]').length).toBe(3);
    const saved = await readDeckFile(deckPath);
    expect(saved.hash).toBe(result.revision);
    expect(saved.html).toContain('Host edit');
    expect(saved.html).toContain('Host slide');
    expect(validateDeck(parseDeckHtml(saved.html)).valid).toBe(true);
    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    const payload = (await response.json()) as { revision: string };
    expect(payload.revision).toBe(result.revision);
  });

  it('maps a stale revision to DeckConflictError and leaves the external file unchanged', async () => {
    const ctx = await setupHost();
    const service = new HostDeckService({ hostUrl: ctx.base, token: ctx.token });
    const snapshot = await service.load(deckPath);
    const external = (await readFile(deckPath, 'utf8')).replace(
      'Basic deck',
      'External host edit'
    );
    await writeFile(deckPath, external, 'utf8');
    const externalBytes = await readFile(deckPath);

    const error = await rejection(
      service.save(deckPath, snapshot, (draft) => {
        setText(requireElement(draft, '[data-ppt-el="e1"]'), 'MCP host edit');
      })
    );

    expect(error).toBeInstanceOf(DeckConflictError);
    expect((error as DeckConflictError).code).toBe('conflict');
    expect((error as DeckConflictError).currentRevision).toBe(hashHtml(external));
    expect(await readFile(deckPath)).toEqual(externalBytes);
  });

  it('writes raw html against the host revision', async () => {
    const ctx = await setupHost();
    const service = new HostDeckService({ hostUrl: ctx.base, token: ctx.token });
    const snapshot = await service.load(deckPath);
    const next = snapshot.html.replace('Basic deck', 'Host raw write');

    const result = await service.write(deckPath, next, snapshot.revision);

    expect(result.revision).toBe(hashHtml(next));
    expect(await readFile(deckPath, 'utf8')).toBe(next);

    const stale = await rejection(
      service.write(
        deckPath,
        next.replace('Host raw write', 'Host second write'),
        snapshot.revision
      )
    );
    expect(stale).toBeInstanceOf(DeckConflictError);
    expect((stale as DeckConflictError).currentRevision).toBe(result.revision);
  });
});

describe('createDeckService', () => {
  it('honors explicit host options', async () => {
    const ctx = await setupHost();

    const service = await createDeckService(deckPath, {
      hostUrl: ctx.base,
      token: ctx.token
    });

    expect(service).toBeInstanceOf(HostDeckService);
    const snapshot = await service.load(deckPath);
    expect(snapshot.revision).toBe(ctx.revision);
  });

  it('attaches to a live session from the registry', async () => {
    const ctx = await setupHost();
    await writeSession({
      path: deckPath,
      port: ctx.host.port,
      token: ctx.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      revision: ctx.revision
    });

    const service = await createDeckService(deckPath);

    expect(service).toBeInstanceOf(HostDeckService);
    const snapshot = await service.load(deckPath);
    expect(snapshot.revision).toBe(ctx.revision);
  });

  it('falls back to direct access when no session exists', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);

    const service = await createDeckService(deckPath);

    expect(service).toBeInstanceOf(DirectDeckService);
    const snapshot = await service.load(deckPath);
    expect(snapshot.revision).toBe(hashHtml(await readFile(deckPath, 'utf8')));
  });

  it('rejects partial host options', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);

    await expect(
      createDeckService(deckPath, { hostUrl: 'http://127.0.0.1:1' })
    ).rejects.toThrow(/token/i);
  });
});
