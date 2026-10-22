import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_IMAGE_BYTES,
  DeckMutationError,
  addElement,
  addSlide,
  chartSizeOf,
  createDeckHtml,
  deleteSlide,
  duplicateSlide,
  findSlide,
  formatBytes,
  getElement,
  getOutline,
  imageDataUrlFromBytes,
  imageMimeFromFileName,
  insertImage,
  insertTable,
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
  updateChart,
  updateSlideHtml,
  validateDeck,
  validateImageSource,
  type ElementTarget,
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

const imageSourceSchema = z
  .string()
  .min(1)
  .describe(
    'A supported image data URL, an absolute http(s) URL (validated, never fetched), or a local image path resolved against the server working directory. Local files are embedded as data URLs.'
  );

const chartSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'Chart JSON string or object: { type: "bar"|"line"|"pie", title?, labels: string[], series: [{ name, values: number[] }], colors?, legend?, valueLabels? }.'
  );

const IMAGE_TYPE_HINT = 'PNG, JPEG, GIF, WebP, AVIF, or SVG';

/**
 * Local paths are anything without a URL scheme, plus Windows drive paths
 * (`C:\...`, `C:/...`, and drive-relative `C:...`), which URL parsing would
 * otherwise mistake for a `c:` URL. Protocol-relative and UNC values
 * (`//server/share/x.png`, `\\server\share\x.png`) are not local: resolving
 * them would contact a remote share, so they go through URL validation and
 * fail as `invalid-image` instead.
 */
function isLocalImageSource(value: string): boolean {
  if (/^[\\/]{2}/.test(value)) return false;
  if (/^data:/i.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^[a-z]:/i.test(value)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function imageFailure(message: string): never {
  throw new ToolError('invalid-image', message);
}

function imageReadFailure(filePath: string, error: unknown): never {
  imageFailure(
    `Could not read the image file "${filePath}": ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

/**
 * Reads exactly `size` bytes from an already-open descriptor. A short read
 * means the file shrank after it was measured, so the data is rejected rather
 * than embedded truncated.
 */
async function readImageBytes(
  handle: FileHandle,
  size: number,
  filePath: string
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      size - offset,
      offset
    );
    if (bytesRead === 0) {
      imageFailure(
        `The image file "${filePath}" changed while it was being read. Try again.`
      );
    }
    offset += bytesRead;
  }
  return bytes;
}

/**
 * Opens a local image once, measures that descriptor, and reads from the same
 * descriptor. Checks and bytes therefore come from one open file: a path
 * swapped after the open cannot substitute a FIFO, device, or larger file.
 * Every open, stat, and read failure is an `invalid-image` naming the image
 * path, never a deck `file-not-found`/`file-unreadable` error.
 */
async function localImageDataUrl(
  accessor: DeckAccess,
  input: string
): Promise<string> {
  const filePath = accessor.resolve(input);
  const mime = imageMimeFromFileName(filePath);
  if (!mime) {
    imageFailure(
      `Unsupported image file type for "${filePath}". Use ${IMAGE_TYPE_HINT}.`
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      imageFailure(`Image file not found: ${filePath}.`);
    }
    imageReadFailure(filePath, error);
  }

  let bytes: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      imageFailure(`The image path is not a file: ${filePath}.`);
    }
    if (stats.size === 0) {
      imageFailure(`The image file "${filePath}" is empty.`);
    }
    if (stats.size > MAX_IMAGE_BYTES) {
      imageFailure(
        `The image "${filePath}" is ${formatBytes(stats.size)}; the limit is 8 MB. Resize or compress it before inserting.`
      );
    }
    bytes = await readImageBytes(handle, stats.size, filePath);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    imageReadFailure(filePath, error);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return imageDataUrlFromBytes(bytes, mime);
}

async function resolveImageSource(
  accessor: DeckAccess,
  source: string
): Promise<string> {
  const value = source.trim();
  if (!value) {
    imageFailure(
      `Choose an image file or URL. Supported types: ${IMAGE_TYPE_HINT}.`
    );
  }
  if (isLocalImageSource(value)) {
    return localImageDataUrl(accessor, value);
  }
  // Data and http(s) URLs stay as authored: `validateImageSource` shares the
  // decoded size and MIME checks with the editor, and remote URLs are never
  // fetched on the Node host.
  return validateImageSource(value);
}

/** Resolves an insertion anchor and enforces the direct-child rule. */
function insertionAnchor(
  slide: Element,
  target: ElementTarget | undefined
): Element | null {
  if (!target) return null;
  const reference = resolveTarget(slide, target);
  if (reference.parentElement !== slide) {
    throw new DeckMutationError(
      'target-invalid',
      'The insertion anchor must be a direct child of the slide.'
    );
  }
  return reference;
}

function insertAfterAnchor(
  slide: Element,
  element: Element,
  anchor: Element | null
): void {
  if (anchor) slide.insertBefore(element, anchor.nextElementSibling);
}

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
    'add_image',
    {
      title: 'Add image',
      description:
        'Insert one image as a top-level object. Accepts a data URL, an absolute http(s) URL (never fetched), or a local path embedded as a validated data URL. Local files must be a supported type and at most 8 MB. Optionally inserts after a direct-child target.',
      inputSchema: {
        path: deckPath,
        slideId,
        source: imageSourceSchema,
        width: z
          .number()
          .finite()
          .min(1)
          .optional()
          .describe(
            'Optional width in pixels, at least 1. Height follows the 16:9 default ratio. Defaults to 480.'
          ),
        target: targetSchema.optional()
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          // Local bytes are read before the synchronous mutation callback.
          const source = await resolveImageSource(accessor, args.source);
          const width = args.width ?? 480;
          const height = Math.max(1, Math.round((width * 9) / 16));
          let elementId: string | null = null;
          const result = await accessor.mutate(filePath, (draft) => {
            const slide = findSlide(draft, args.slideId).element;
            const anchor = insertionAnchor(slide, args.target);
            const element = insertImage(slide, {
              source,
              x: 100,
              y: 100,
              width,
              height
            });
            insertAfterAnchor(slide, element, anchor);
            elementId = element.getAttribute('data-ppt-el');
          });
          return { path: filePath, revision: result.revision, elementId };
        }
      );
    }
  );

  server.registerTool(
    'add_table',
    {
      title: 'Add table',
      description:
        'Insert one table object with a header row as a top-level object. Rows and columns are positive integers within the core limits (50 rows, 20 columns). Optionally inserts after a direct-child target.',
      inputSchema: {
        path: deckPath,
        slideId,
        rows: z
          .number()
          .int()
          .describe('Row count including the header row; 1-50.'),
        columns: z.number().int().describe('Column count; 1-20.'),
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
            const anchor = insertionAnchor(slide, args.target);
            const element = insertTable(slide, {
              rows: args.rows,
              columns: args.columns,
              header: true,
              x: 100,
              y: 100,
              width: 960
            });
            insertAfterAnchor(slide, element, anchor);
            elementId = element.getAttribute('data-ppt-el');
          });
          return { path: filePath, revision: result.revision, elementId };
        }
      );
    }
  );

  server.registerTool(
    'update_chart',
    {
      title: 'Update chart',
      description:
        'Replace the data of an existing chart figure (figure[data-ppt-chart]), normalize the JSON, and regenerate its SVG at the persisted size.',
      inputSchema: {
        path: deckPath,
        slideId,
        target: targetSchema,
        chart: chartSchema
      }
    },
    async (args) => {
      const filePath = accessor.resolve(args.path);
      return runTool(
        { path: filePath, slideId: args.slideId, target: args.target },
        async () => {
          let width = 0;
          let height = 0;
          const result = await accessor.mutate(filePath, (draft) => {
            const slide = findSlide(draft, args.slideId).element;
            const element = resolveTarget(slide, args.target);
            if (
              element.tagName.toLowerCase() !== 'figure' ||
              !element.hasAttribute('data-ppt-chart')
            ) {
              throw new ToolError(
                'not-a-chart',
                'The target is not a chart. Charts are <figure data-ppt-chart> elements.'
              );
            }
            updateChart(element, args.chart);
            ({ width, height } = chartSizeOf(element));
          });
          return { path: filePath, revision: result.revision, width, height };
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
