import { dirname, join } from 'node:path';
import { DeckFileExistsError } from '@htmlppt/core/node';
import { describe, expect, it } from 'vitest';
import { ToolError, errorPayload } from '../src/errors.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: denied by the operating system`), {
    code
  });
}

const deckPath = join('decks', 'deck.html');
const exportPath = join('decks', 'deck.export.html');

describe('errorPayload', () => {
  it('reports permission failures on reads as unreadable', () => {
    const payload = errorPayload(errno('EACCES'), {
      path: deckPath,
      operation: 'read'
    });

    expect(payload).toMatchObject({
      code: 'file-unreadable',
      path: deckPath
    });
    expect(String(payload.message)).toContain(deckPath);
  });

  it('reports permission failures on writes as unwritable', () => {
    const payload = errorPayload(errno('EPERM'), {
      path: deckPath,
      operation: 'write'
    });

    expect(payload).toMatchObject({
      code: 'file-unwritable',
      path: deckPath
    });
    expect(String(payload.message)).toContain(deckPath);
  });

  it('names the output path for export writes', () => {
    const payload = errorPayload(errno('EACCES'), {
      path: deckPath,
      operation: 'write',
      outputPath: exportPath
    });

    expect(payload).toMatchObject({
      code: 'file-unwritable',
      path: deckPath,
      outputPath: exportPath
    });
    expect(String(payload.message)).toContain(exportPath);
  });

  it('reports a missing parent directory for writes', () => {
    const payload = errorPayload(errno('ENOENT'), {
      path: deckPath,
      operation: 'write'
    });

    expect(payload).toMatchObject({
      code: 'directory-not-found',
      path: deckPath
    });
    expect(String(payload.message)).toContain(dirname(deckPath));
  });

  it('keeps a missing deck on a read as file-not-found', () => {
    expect(errorPayload(errno('ENOENT'), { path: deckPath })).toMatchObject({
      code: 'file-not-found',
      path: deckPath
    });
  });

  it('maps the core create guard to a file-exists ToolError-shaped payload', () => {
    const payload = errorPayload(new DeckFileExistsError(deckPath), {
      path: deckPath,
      operation: 'write'
    });

    expect(payload).toMatchObject({
      code: 'file-exists',
      path: deckPath
    });
    expect(String(payload.message)).toContain(deckPath);
  });

  it('preserves ToolError details and operation context', () => {
    const payload = errorPayload(
      new ToolError('invalid-deck', 'The deck is not valid.', {
        errors: [{ code: 'duplicate-slide-id' }]
      }),
      { path: deckPath, operation: 'write' }
    );

    expect(payload).toMatchObject({
      code: 'invalid-deck',
      message: 'The deck is not valid.',
      path: deckPath,
      errors: [{ code: 'duplicate-slide-id' }]
    });
  });
});
