import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeckMutationError,
  addElement,
  addSlide,
  createDeckHtml,
  deleteSlide,
  duplicateSlide,
  findSlide,
  getElement,
  getOutline,
  moveSlide,
  normalizeDeck,
  readSlide,
  removeElement,
  resolveTarget,
  serializeDeck,
  serializeExport,
  setElementHtml,
  setNotes,
  setSlideBackground,
  setSlideOrder,
  setStyle,
  setText,
  setTransition,
  updateSlideHtml,
  validateDeck,
  type ElementTarget,
  type SlideBackground,
  type Transition
} from '@htmlppt/core';
import { hashHtml, parseDeckHtml, writeDeckFileAtomic } from '@htmlppt/core/node';
import { readSession, sessionKey, sessionsDirectory } from '@htmlppt/host';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DeckConflictError,
  createDeckService,
  type DeckSnapshot,
  type SaveResult
} from './deck-service.js';
import authoring from './resources/authoring.md?raw';
import contract from './resources/contract.md?raw';
import example from './resources/example.html?raw';

const SESSION_POLL_INTERVAL_MS = 100;
const SESSION_TIMEOUT_MS = 5_000;
const WORKFLOW_FORMATS = ['html', 'pdf', 'png'] as const;

interface ToolContext {
  path?: string;
  slideId?: string;
  target?: ElementTarget;
}

class ToolError extends Error {
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

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

function errorResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true
  };
}

function errorPayload(
  error: unknown,
  context: ToolContext
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (context.path) base.path = context.path;
  if (context.slideId) base.slideId = context.slideId;
  if (context.target) base.target = context.target;

  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: error.message,
      ...base,
      ...error.details
    };
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
  if (code === 'ENOENT') {
    return {
      code: 'file-not-found',
      message: `Deck file not found: ${context.path ?? 'unknown path'}.`,
      ...base
    };
  }
  if (code === 'EACCES' || code === 'EISDIR' || code === 'EPERM') {
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

async function runTool(
  context: ToolContext,
  action: () => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  try {
    return jsonResult(await action());
  } catch (error) {
    return errorResult(errorPayload(error, context));
  }
}

/**
 * Resolves paths against the server cwd and keeps the last read or written
 * snapshot per file. Mutations compare against that revision so an external
 * edit produces a structured conflict instead of silently overwriting it.
 */
class DeckAccess {
  private readonly cwd: string;
  private readonly snapshots = new Map<string, DeckSnapshot>();

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd);
  }

  get workingDirectory(): string {
    return this.cwd;
  }

  resolve(input: string): string {
    return path.resolve(this.cwd, input);
  }

  async read(filePath: string): Promise<DeckSnapshot> {
    const service = await createDeckService(filePath);
    const snapshot = await service.load(filePath);
    this.snapshots.set(filePath, snapshot);
    return snapshot;
  }

  async mutate(
    filePath: string,
    mutation: (draft: Document) => void
  ): Promise<SaveResult> {
    const service = await createDeckService(filePath);
    const snapshot =
      this.snapshots.get(filePath) ?? (await service.load(filePath));
    const result = await service.save(filePath, snapshot, mutation);
    this.snapshots.set(filePath, {
      document: result.document,
      html: serializeDeck(result.document),
      revision: result.revision,
      filePath
    });
    return result;
  }

  remember(filePath: string, snapshot: DeckSnapshot): void {
    this.snapshots.set(filePath, snapshot);
  }
}

function cliBinPath(): string {
  const bundled = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
}

function hostUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSession(
  filePath: string
): Promise<{ port: number; token: string }> {
  const sessionFile = path.join(
    sessionsDirectory(),
    `${sessionKey(filePath)}.json`
  );
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await readSession(sessionFile);
    if (session && session.path === filePath) {
      return { port: session.port, token: session.token };
    }
    await delay(SESSION_POLL_INTERVAL_MS);
  }
  throw new ToolError(
    'editor-timeout',
    'The editor did not write a session within 5 seconds. Run "htmlppt open <path> --no-browser" manually and check that the editor build exists.'
  );
}

async function assertDeckAbsent(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ToolError(
    'file-exists',
    `Deck already exists: ${filePath}. Choose another path instead of overwriting it.`
  );
}

const deckPath = z
  .string()
  .min(1)
  .describe('Deck HTML path. Relative paths resolve against the server working directory.');

const slideId = z.string().min(1).describe('Slide id such as "s1" or "body".');

const targetSchema = z
  .union([
    z.object({ elementId: z.string().min(1) }).strict(),
    z.object({ selector: z.string().min(1) }).strict(),
    z.object({ path: z.array(z.number().int().nonnegative()) }).strict()
  ])
  .describe(
    'Exactly one of: elementId (data-ppt-el), selector (matches one element), or path (child indices from the slide).'
  );

const transitionSchema = z
  .enum(['none', 'fade', 'slide'])
  .describe('Slide transition.');

const backgroundSchema = z
  .object({
    color: z.string().optional(),
    gradient: z.string().optional(),
    image: z.string().optional()
  })
  .strict()
  .describe('Exactly one of color, gradient, or image.');

const stylesSchema = z
  .record(z.string(), z.union([z.string(), z.null()]))
  .describe('CSS property names mapped to values; null removes a property.');

export interface ToolOptions {
  cwd?: string;
}

export function registerTools(
  server: McpServer,
  options: ToolOptions = {}
): void {
  const accessor = new DeckAccess(options.cwd ?? process.cwd());

  server.registerTool(
    'get_deck_contract',
    {
      title: 'Get deck contract',
      description:
        'Return the deck contract and authoring guidance for htmlppt documents.',
      inputSchema: {}
    },
    async () => jsonResult({ contract, authoring })
  );

  server.registerTool(
    'validate_deck',
    {
      title: 'Validate deck',
      description:
        'Validate a deck against the contract and return errors, warnings, and info with locations.',
      inputSchema: { path: deckPath }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath }, async () => {
        const snapshot = await accessor.read(filePath);
        // Validate the authored bytes, not the in-memory normalization that
        // assigns missing ids for editing.
        const validation = validateDeck(parseDeckHtml(snapshot.html));
        return {
          path: filePath,
          revision: snapshot.revision,
          ...validation
        };
      });
    }
  );

  server.registerTool(
    'get_outline',
    {
      title: 'Get deck outline',
      description:
        'Return deck metadata, slide ids, element ids/paths/tags/text summaries, notes, and transitions.',
      inputSchema: { path: deckPath }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath }, async () => {
        const snapshot = await accessor.read(filePath);
        return {
          path: filePath,
          revision: snapshot.revision,
          outline: getOutline(snapshot.document)
        };
      });
    }
  );

  server.registerTool(
    'read_slide',
    {
      title: 'Read slide',
      description:
        'Return one slide as HTML together with its notes, transition, and canvas size.',
      inputSchema: { path: deckPath, slideId }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        const snapshot = await accessor.read(filePath);
        findSlide(snapshot.document, args.slideId);
        return {
          path: filePath,
          revision: snapshot.revision,
          slide: readSlide(snapshot.document, args.slideId)
        };
      });
    }
  );

  server.registerTool(
    'get_element',
    {
      title: 'Get element',
      description:
        'Return one element as outerHTML and its raw inline style attribute. No layout is computed.',
      inputSchema: { path: deckPath, slideId, target: targetSchema }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          const snapshot = await accessor.read(filePath);
          return {
            path: filePath,
            revision: snapshot.revision,
            ...getElement(snapshot.document, args.slideId, args.target)
          };
        }
      );
    }
  );

  server.registerTool(
    'create_deck',
    {
      title: 'Create deck',
      description:
        'Create a new deck file. Refuses to overwrite an existing file. Custom HTML is normalized and validated.',
      inputSchema: {
        path: deckPath,
        title: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        slides: z.number().int().positive().max(1000).optional(),
        html: z.string().optional(),
        runtime: z
          .boolean()
          .optional()
          .describe('Include the presentation runtime. Defaults to true.')
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath }, async () => {
        await assertDeckAbsent(filePath);
        const document = parseDeckHtml(
          args.html ??
            createDeckHtml({
              title: args.title,
              width: args.width,
              height: args.height,
              slides: args.slides
            })
        );
        if (args.runtime === false) {
          for (const marker of Array.from(
            document.querySelectorAll('script[data-ppt-runtime]')
          )) {
            marker.remove();
          }
        }
        normalizeDeck(document);
        const validation = validateDeck(document);
        if (!validation.valid) {
          throw new ToolError(
            'invalid-deck',
            `The deck is not valid: ${validation.errors
              .map((diagnostic) => diagnostic.code)
              .join(', ')}.`,
            { errors: validation.errors }
          );
        }
        const html = serializeDeck(document);
        try {
          await writeFile(filePath, html, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            throw new ToolError(
              'file-exists',
              `Deck already exists: ${filePath}. Choose another path instead of overwriting it.`
            );
          }
          if (code === 'ENOENT') {
            throw new ToolError(
              'directory-not-found',
              `Parent directory does not exist: ${path.dirname(filePath)}.`
            );
          }
          throw error;
        }
        const revision = hashHtml(html);
        accessor.remember(filePath, {
          document,
          html,
          revision,
          filePath
        });
        return { path: filePath, revision, created: true };
      });
    }
  );

  server.registerTool(
    'add_slide',
    {
      title: 'Add slide',
      description:
        'Add one slide after the last slide or after a given slide id, and return the new slide id.',
      inputSchema: {
        path: deckPath,
        html: z.string().optional(),
        afterSlideId: z.string().min(1).optional(),
        notes: z.string().optional(),
        transition: transitionSchema.optional()
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath }, async () => {
        let newSlideId = '';
        const result = await accessor.mutate(filePath, (draft) => {
          newSlideId = addSlide(draft, {
            html: args.html,
            afterSlideId: args.afterSlideId,
            notes: args.notes,
            transition: args.transition
          });
        });
        return {
          path: filePath,
          revision: result.revision,
          slideId: newSlideId
        };
      });
    }
  );

  server.registerTool(
    'update_slide_html',
    {
      title: 'Update slide HTML',
      description: 'Replace the inner HTML of one slide.',
      inputSchema: { path: deckPath, slideId, html: z.string() }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        const result = await accessor.mutate(filePath, (draft) => {
          updateSlideHtml(draft, args.slideId, args.html);
        });
        return { path: filePath, revision: result.revision };
      });
    }
  );

  server.registerTool(
    'duplicate_slide',
    {
      title: 'Duplicate slide',
      description: 'Duplicate one slide and return the new slide id.',
      inputSchema: { path: deckPath, slideId }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        let newSlideId = '';
        const result = await accessor.mutate(filePath, (draft) => {
          newSlideId = duplicateSlide(draft, args.slideId);
        });
        return {
          path: filePath,
          revision: result.revision,
          slideId: newSlideId
        };
      });
    }
  );

  server.registerTool(
    'delete_slide',
    {
      title: 'Delete slide',
      description: 'Delete one slide. The last remaining slide cannot be deleted.',
      inputSchema: { path: deckPath, slideId }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        const result = await accessor.mutate(filePath, (draft) => {
          deleteSlide(draft, args.slideId);
        });
        return { path: filePath, revision: result.revision };
      });
    }
  );

  server.registerTool(
    'move_slide',
    {
      title: 'Move slide',
      description: 'Move one slide to a zero-based index.',
      inputSchema: {
        path: deckPath,
        slideId,
        toIndex: z.number().int().nonnegative()
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        const result = await accessor.mutate(filePath, (draft) => {
          moveSlide(draft, args.slideId, args.toIndex);
        });
        return { path: filePath, revision: result.revision };
      });
    }
  );

  server.registerTool(
    'set_notes',
    {
      title: 'Set speaker notes',
      description: 'Set or clear the speaker notes for one slide.',
      inputSchema: { path: deckPath, slideId, notes: z.string() }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        const result = await accessor.mutate(filePath, (draft) => {
          setNotes(draft, args.slideId, args.notes);
        });
        return { path: filePath, revision: result.revision };
      });
    }
  );

  server.registerTool(
    'set_transition',
    {
      title: 'Set slide transition',
      description: 'Set the transition for one slide.',
      inputSchema: { path: deckPath, slideId, transition: transitionSchema }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        const transition: Transition = args.transition;
        const result = await accessor.mutate(filePath, (draft) => {
          setTransition(draft, args.slideId, transition);
        });
        return { path: filePath, revision: result.revision };
      });
    }
  );

  server.registerTool(
    'set_slide_background',
    {
      title: 'Set slide background',
      description:
        'Replace a slide background with exactly one color, gradient, or image.',
      inputSchema: { path: deckPath, slideId, background: backgroundSchema }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath, slideId: args.slideId }, async () => {
        const background: SlideBackground = args.background;
        const result = await accessor.mutate(filePath, (draft) => {
          setSlideBackground(draft, args.slideId, background);
        });
        return { path: filePath, revision: result.revision };
      });
    }
  );

  server.registerTool(
    'add_element',
    {
      title: 'Add element',
      description:
        'Insert one raw HTML element as a top-level object in a slide, optionally after a target. Returns the element id when one was assigned.',
      inputSchema: {
        path: deckPath,
        slideId,
        html: z.string(),
        target: targetSchema.optional()
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          let elementId: string | null = null;
          const result = await accessor.mutate(filePath, (draft) => {
            const slide = findSlide(draft, args.slideId).element;
            const element = addElement(slide, args.html, args.target);
            elementId = element.getAttribute('data-ppt-el');
          });
          return {
            path: filePath,
            revision: result.revision,
            elementId
          };
        }
      );
    }
  );

  server.registerTool(
    'set_element_html',
    {
      title: 'Set element HTML',
      description: 'Replace the inner HTML of one element.',
      inputSchema: { path: deckPath, slideId, target: targetSchema, html: z.string() }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          const result = await accessor.mutate(filePath, (draft) => {
            const slide = findSlide(draft, args.slideId).element;
            setElementHtml(resolveTarget(slide, args.target), args.html);
          });
          return { path: filePath, revision: result.revision };
        }
      );
    }
  );

  server.registerTool(
    'set_text',
    {
      title: 'Set element text',
      description:
        'Replace the text content of one element. The text is escaped, not interpreted as HTML.',
      inputSchema: {
        path: deckPath,
        slideId,
        target: targetSchema,
        text: z.string()
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          const result = await accessor.mutate(filePath, (draft) => {
            const slide = findSlide(draft, args.slideId).element;
            setText(resolveTarget(slide, args.target), args.text);
          });
          return { path: filePath, revision: result.revision };
        }
      );
    }
  );

  server.registerTool(
    'set_style',
    {
      title: 'Set element style',
      description:
        'Set or remove inline CSS properties on one element. Use null to remove a property.',
      inputSchema: {
        path: deckPath,
        slideId,
        target: targetSchema,
        styles: stylesSchema
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          const result = await accessor.mutate(filePath, (draft) => {
            const slide = findSlide(draft, args.slideId).element;
            setStyle(resolveTarget(slide, args.target), args.styles);
          });
          return { path: filePath, revision: result.revision };
        }
      );
    }
  );

  server.registerTool(
    'remove_element',
    {
      title: 'Remove element',
      description: 'Remove one element from a slide.',
      inputSchema: { path: deckPath, slideId, target: targetSchema }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          const result = await accessor.mutate(filePath, (draft) => {
            const slide = findSlide(draft, args.slideId).element;
            removeElement(resolveTarget(slide, args.target));
          });
          return { path: filePath, revision: result.revision };
        }
      );
    }
  );

  server.registerTool(
    'set_slide_order',
    {
      title: 'Set slide order',
      description:
        'Reorder all slides. The list must contain every slide id exactly once.',
      inputSchema: {
        path: deckPath,
        slideIds: z.array(z.string().min(1)).min(1)
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath }, async () => {
        const result = await accessor.mutate(filePath, (draft) => {
          setSlideOrder(draft, args.slideIds);
        });
        return { path: filePath, revision: result.revision };
      });
    }
  );

  server.registerTool(
    'open_editor',
    {
      title: 'Open editor',
      description:
        'Start a detached local editor host for a deck and return its tokenized loopback URL.',
      inputSchema: {
        path: deckPath,
        port: z.number().int().min(0).max(65_535).optional(),
        open: z
          .boolean()
          .optional()
          .describe('Open a browser. Defaults to false.')
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath }, async () => {
        await access(filePath);
        const cliBin = cliBinPath();
        try {
          await access(cliBin);
        } catch {
          throw new ToolError(
            'editor-unavailable',
            `The htmlppt CLI build was not found at ${cliBin}. Run "npm run build" first.`
          );
        }
        const editorArgs = ['open', filePath];
        if (args.port !== undefined) {
          editorArgs.push('--port', String(args.port));
        }
        if (!args.open) {
          editorArgs.push('--no-browser');
        }
        const child = spawn(process.execPath, [cliBin, ...editorArgs], {
          cwd: accessor.workingDirectory,
          detached: true,
          stdio: 'ignore'
        });
        child.on('error', () => undefined);
        child.unref();

        const session = await waitForSession(filePath);
        return {
          path: filePath,
          url: hostUrl(session.port, session.token)
        };
      });
    }
  );

  server.registerTool(
    'export_deck',
    {
      title: 'Export deck',
      description:
        'Export a deck to HTML. PDF and PNG export are not available in this milestone.',
      inputSchema: {
        path: deckPath,
        format: z.enum(WORKFLOW_FORMATS).default('html'),
        outDir: z
          .string()
          .min(1)
          .optional()
          .describe('Output directory. Defaults to the deck directory.')
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool({ path: filePath }, async () => {
        if (args.format !== 'html') {
          throw new ToolError(
            'unsupported-format',
            `Only html export is available in this milestone. Received format "${args.format}".`
          );
        }
        const snapshot = await accessor.read(filePath);
        const validation = validateDeck(snapshot.document);
        if (!validation.valid) {
          throw new ToolError(
            'invalid-deck',
            `The deck is not valid: ${validation.errors
              .map((diagnostic) => diagnostic.code)
              .join(', ')}.`,
            { errors: validation.errors }
          );
        }
        const parsedPath = path.parse(filePath);
        const outputDirectory = args.outDir
          ? accessor.resolve(args.outDir)
          : parsedPath.dir;
        await mkdir(outputDirectory, { recursive: true });
        const outputPath = path.join(
          outputDirectory,
          `${parsedPath.name}.export.html`
        );
        await writeDeckFileAtomic(
          outputPath,
          serializeExport(snapshot.document)
        );
        return {
          path: filePath,
          format: 'html',
          outputPath
        };
      });
    }
  );
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'contract',
    'htmlppt://contract',
    {
      title: 'htmlppt deck contract',
      description: 'The htmldeck/v1 document, slide, object, and runtime contract.',
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/markdown', text: contract }
      ]
    })
  );

  server.registerResource(
    'authoring',
    'htmlppt://authoring',
    {
      title: 'htmlppt authoring guidance',
      description: 'Agent-oriented guidance for authoring and editing decks.',
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/markdown', text: authoring }
      ]
    })
  );

  server.registerResource(
    'example',
    'htmlppt://example',
    {
      title: 'htmlppt example deck',
      description: 'A minimal valid deck with text, image, shape, table, chart, notes, and runtime.',
      mimeType: 'text/html'
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/html', text: example }]
    })
  );
}
