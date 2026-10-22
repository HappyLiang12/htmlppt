import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
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
  type SlideBackground,
  type Transition
} from '@htmlppt/core';
import {
  createDeckFileAtomic,
  parseDeckHtml,
  writeDeckFileAtomic
} from '@htmlppt/core/node';
import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DeckAccess,
  cliBinPath,
  hostUrl,
  waitForSession
} from './deck-access.js';
import {
  ToolError,
  jsonResult,
  runTool,
  type ToolContext
} from './errors.js';
import authoring from './resources/authoring.md?raw';
import contract from './resources/contract.md?raw';
import example from './resources/example.html?raw';

const EXAMPLE_RUNTIME_MARKER = '<script data-ppt-runtime="1"></script>';
const CHILD_TERMINATION_TIMEOUT_MS = 2_000;

/**
 * Terminates a spawned editor process that never produced a healthy session.
 * The wait is bounded so a wedged child cannot hang the tool call; the host
 * itself runs in this child, so SIGTERM also closes its listening socket.
 */
function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CHILD_TERMINATION_TIMEOUT_MS);
    timer.unref();
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function withRuntimeSource(html: string): string {
  if (!html.includes(EXAMPLE_RUNTIME_MARKER)) {
    throw new Error(
      'The example resource is missing its data-ppt-runtime script marker.'
    );
  }
  return html.replace(
    EXAMPLE_RUNTIME_MARKER,
    () => `<script data-ppt-runtime="1">${RUNTIME_SOURCE}</script>`
  );
}

const exampleDeck = withRuntimeSource(example);

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
      inputSchema: z.object({}).strict()
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
      return runTool({ path: filePath, operation: 'write' }, async () => {
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
        const written = await createDeckFileAtomic(filePath, html);
        accessor.remember(filePath, {
          document,
          html,
          revision: written.hash,
          filePath
        });
        return { path: filePath, revision: written.hash, created: true };
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

        let session: Awaited<ReturnType<typeof waitForSession>>;
        try {
          session = await waitForSession(filePath);
        } catch (error) {
          await terminateChild(child);
          if (error instanceof ToolError && error.code === 'editor-timeout') {
            throw new ToolError(
              'editor-timeout',
              `${error.message} The started host process was terminated.`
            );
          }
          throw error;
        }
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
        'Export a deck to a self-contained HTML file. Additional formats arrive in a later milestone.',
      inputSchema: {
        path: deckPath,
        format: z.literal('html').default('html'),
        outDir: z
          .string()
          .min(1)
          .optional()
          .describe('Output directory. Defaults to the deck directory.')
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      const context: ToolContext = { path: filePath };
      return runTool(context, async () => {
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
        const outputPath = path.join(
          outputDirectory,
          `${parsedPath.name}.export.html`
        );
        context.operation = 'write';
        context.outputPath = outputPath;
        await mkdir(outputDirectory, { recursive: true });
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
      contents: [{ uri: uri.href, mimeType: 'text/html', text: exampleDeck }]
    })
  );
}
