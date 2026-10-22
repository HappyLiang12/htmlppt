import path from 'node:path';
import { DeckMutationError, type ElementTarget } from '@htmlppt/core';
import { DeckFileExistsError } from '@htmlppt/core/node';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DeckConflictError } from './deck-service.js';

export type ToolOperation = 'read' | 'write';

export interface ToolContext {
  path?: string;
  slideId?: string;
  target?: ElementTarget;
  operation?: ToolOperation;
  outputPath?: string;
}

export class ToolError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

export function errorResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true
  };
}

export function errorPayload(
  error: unknown,
  context: ToolContext
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (context.path) base.path = context.path;
  if (context.slideId) base.slideId = context.slideId;
  if (context.target) base.target = context.target;
  if (context.outputPath) base.outputPath = context.outputPath;

  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: error.message,
      ...base,
      ...error.details
    };
  }
  if (error instanceof DeckFileExistsError) {
    return { code: error.code, message: error.message, ...base };
  }
  if (error instanceof DeckConflictError) {
    return {
      code: 'conflict',
      message: `${error.message} Re-read the deck with get_outline or read_slide, then retry.`,
      ...base,
      ...(error.currentRevision
        ? { currentRevision: error.currentRevision }
        : {})
    };
  }
  if (error instanceof DeckMutationError) {
    return { code: error.code, message: error.message, ...base };
  }

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const targetPath = context.outputPath ?? context.path;
  if (code === 'ENOENT') {
    if (context.operation === 'write') {
      return {
        code: 'directory-not-found',
        message: targetPath
          ? `Parent directory does not exist: ${path.dirname(targetPath)}.`
          : 'Parent directory does not exist.',
        ...base
      };
    }
    return {
      code: 'file-not-found',
      message: `Deck file not found: ${context.path ?? 'unknown path'}.`,
      ...base
    };
  }
  if (code === 'EACCES' || code === 'EISDIR' || code === 'EPERM') {
    if (context.operation === 'write') {
      return {
        code: 'file-unwritable',
        message: targetPath
          ? `Could not write ${targetPath}. Check the path and permissions, then try again.`
          : 'The deck could not be written.',
        ...base
      };
    }
    return {
      code: 'file-unreadable',
      message: `Deck file could not be read: ${context.path ?? 'unknown path'}.`,
      ...base
    };
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    ...base
  };
}

export async function runTool(
  context: ToolContext,
  action: () => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  try {
    return jsonResult(await action());
  } catch (error) {
    return errorResult(errorPayload(error, context));
  }
}
