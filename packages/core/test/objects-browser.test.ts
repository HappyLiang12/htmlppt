import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as operations from '../src/objects.js';
import { parseDeckHtml } from '../src/node.js';
import { serializeDeck } from '../src/serialize.js';

const box = (id: string, style = '', content = '') => `<div data-ppt-el="${id}" style="position:absolute;left:0px;top:0px;width:120px;height:120px;background:red;${style}">${content}</div>`;
const deck = (content: string) => `<!doctype html><html><head></head><body style="margin:0"><section data-slide-id="s1" style="position:relative;width:400px;height:400px">${content}</section></body></html>`;
type Operation = 'bringToFront' | 'bringForward' | 'sendToBack' | 'sendBackward' | 'groupElements' | 'ungroupElement';
type Mode = 'linkedom' | 'browser';
let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/objects.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'objectOperations',
    write: false,
    platform: 'browser'
  });
  bundle = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const doc = globalThis.document;
    const elements = Array.from(doc.querySelectorAll<HTMLElement>('[data-ppt-el], [data-probe]'));
    const name = (element: Element) => element.getAttribute('data-probe') || element.getAttribute('data-ppt-el') || '';
    return {
      order: doc.elementsFromPoint(30, 30).filter((element) => elements.includes(element as HTMLElement) && !element.hasAttribute('data-ppt-group')).map(name),
      rects: Object.fromEntries(elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return [name(element), [rect.x, rect.y, rect.width, rect.height]];
      })),
      markup: Object.fromEntries(elements.map((element) => [name(element), element.outerHTML]))
    };
  });
}

async function mutate(page: Page, mode: Mode, operation: Operation, ids: string[]) {
  if (mode === 'linkedom') {
    const doc = parseDeckHtml(await page.content());
    const before = serializeDeck(doc);
    try {
      const result = operation === 'groupElements'
        ? operations.groupElements(doc, 's1', ids)
        : operations[operation](doc, 's1', { elementId: ids[0] });
      await page.setContent(serializeDeck(doc));
      return { result, code: '', message: '', unchanged: false };
    } catch (error) {
      return { code: (error as { code: string }).code, message: (error as Error).message, unchanged: serializeDeck(doc) === before };
    }
  }
  await page.addScriptTag({ content: bundle });
  return page.evaluate(({ operation, ids }) => {
    const api = (globalThis as typeof globalThis & { objectOperations: typeof operations }).objectOperations;
    const doc = globalThis.document;
    const before = doc.documentElement.outerHTML;
    try {
      const result = operation === 'groupElements'
        ? api.groupElements(doc, 's1', ids)
        : api[operation](doc, 's1', { elementId: ids[0] });
      return { result, code: '', message: '', unchanged: false };
    } catch (error) {
      return { code: (error as { code: string }).code, message: (error as Error).message, unchanged: doc.documentElement.outerHTML === before };
    }
  }, { operation, ids });
}

async function withPage(html: string, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try {
    await page.setContent(deck(html));
    await run(page);
  } finally {
    await page.close();
  }
}

const rounded = (rect: number[]) => rect.map((value) => Math.round(value * 1000) / 1000);

describe.each<Mode>(['linkedom', 'browser'])('%s operations rendered in Chromium', (mode) => {
  it('brings a later static object above an earlier positioned auto object', async () => {
    await withPage(box('a') + '<div data-ppt-el="b" style="width:120px;height:120px;background:blue">B</div>', async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['a', 'b']);
      expect((await mutate(page, mode, 'bringToFront', ['b'])).code).toBe('');
      const after = await snapshot(page);
      console.info('static-front', mode, { before: before.order, after: after.order, rects: after.rects });
      expect(after.order).toEqual(['b', 'a']);
      expect(after.rects).toEqual(before.rects);
    });
  });

  it('does not activate unrelated static insets or change descendant containing blocks', async () => {
    const unrelated = '<div data-ppt-el="u" style="left:100px;top:100px;right:25px;bottom:25px;width:120px;height:120px;background:green"><span data-probe="descendant" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:yellow"></span></div>';
    await withPage(unrelated + box('a') + box('b', 'z-index:1'), async (page) => {
      const before = await snapshot(page);
      expect(before.rects.u).toEqual([0, 0, 120, 120]);
      expect(before.rects.descendant).toEqual([20, 20, 40, 40]);
      expect(before.order).toEqual(['b', 'a', 'descendant', 'u']);
      expect((await mutate(page, mode, 'bringForward', ['a'])).code).toBe('');
      const after = await snapshot(page);
      console.info('unrelated-static', mode, { before: before.rects, after: after.rects, order: after.order });
      expect(after.rects).toEqual(before.rects);
      expect(after.markup.u).toBe(before.markup.u);
      expect(after.order).toEqual(['a', 'b', 'descendant', 'u']);
    });
  });

  it('groups noncontiguous layers at the frontmost selected layer', async () => {
    await withPage(box('c', 'z-index:3') + box('u', 'z-index:1') + box('a', 'z-index:-2') + box('v', 'z-index:2') + box('d', 'z-index:4'), async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['d', 'c', 'v', 'u', 'a']);
      const result = await mutate(page, mode, 'groupElements', ['c', 'a']);
      expect(result.code).toBe('');
      const after = await snapshot(page);
      console.info('noncontiguous-group', mode, { before: before.order, after: after.order });
      expect(after.order).toEqual(['d', 'c', 'a', 'v', 'u']);
      for (const id of ['a', 'c', 'u', 'v', 'd']) expect(after.rects[id]).toEqual(before.rects[id]);
      for (const id of ['u', 'v', 'd']) expect(after.markup[id]).toBe(before.markup[id]);
    });
  });

  it.each([
    ['bringToFront', 'a', ['a', 'b', 'c']],
    ['sendToBack', 'c', ['b', 'a', 'c']],
    ['bringForward', 'a', ['b', 'a', 'c']],
    ['sendBackward', 'c', ['b', 'a', 'c']]
  ] as const)('%s changes actual tied explicit paint order', async (operation, id, expected) => {
    await withPage(box('a', 'z-index:-2') + box('c', 'z-index:5') + box('b', 'z-index:5'), async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['b', 'c', 'a']);
      expect((await mutate(page, mode, operation, [id])).code).toBe('');
      expect((await snapshot(page)).order).toEqual(expected);
      expect((await snapshot(page)).rects).toEqual(before.rects);
    });
  });

  it('preserves representable escaping descendants rather than banning descendants', async () => {
    const child = '<span data-probe="escape" style="position:absolute;left:20px;top:20px;width:40px;height:40px;z-index:100;background:yellow"></span>';
    await withPage(box('u', 'z-index:-1') + box('a', '', child) + box('b'), async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['escape', 'b', 'a', 'u']);
      const grouped = await mutate(page, mode, 'groupElements', ['a', 'b']);
      expect(grouped.code).toBe('');
      const after = await snapshot(page);
      expect(after.order).toEqual(before.order);
      for (const id of ['a', 'b', 'escape', 'u']) expect(after.rects[id]).toEqual(before.rects[id]);
      expect(after.markup.u).toBe(before.markup.u);
      expect((await mutate(page, mode, 'ungroupElement', [grouped.result as string])).code).toBe('');
      expect((await snapshot(page)).order).toEqual(before.order);
      expect((await snapshot(page)).rects).toEqual(before.rects);
    });
  });

  it('does not mistake a high-z descendant inside an existing context for an escape', async () => {
    const child = '<span data-probe="contained" style="position:absolute;left:20px;top:20px;width:40px;height:40px;z-index:100;background:yellow"></span>';
    await withPage(box('a', 'z-index:0', child) + box('b') + box('u', 'z-index:1'), async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['u', 'b', 'contained', 'a']);
      expect((await mutate(page, mode, 'groupElements', ['b', 'a'])).code).toBe('');
      const after = await snapshot(page);
      expect(after.order).toEqual(before.order);
      expect(after.markup.u).toBe(before.markup.u);
    });
  });

  it('brings an object above another auto root’s escaping descendant', async () => {
    const child = '<span data-probe="escape" style="position:absolute;left:20px;top:20px;width:40px;height:40px;z-index:100;background:yellow"></span>';
    await withPage(box('a', '', child) + box('b', 'z-index:1'), async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['escape', 'b', 'a']);
      expect((await mutate(page, mode, 'bringToFront', ['b'])).code).toBe('');
      const after = await snapshot(page);
      expect(after.order).toEqual(['b', 'escape', 'a']);
      expect(after.markup.a).toBe(before.markup.a);
      expect(after.rects).toEqual(before.rects);
    });
  });

  it('can position a static target that already contains its absolute descendants', async () => {
    const child = '<span data-probe="contained" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:yellow"></span>';
    const target = `<div data-ppt-el="a" style="transform:translate(0px);left:100px;top:100px;width:120px;height:120px;background:blue">${child}</div>`;
    await withPage(target + box('b', 'z-index:1'), async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['b', 'contained', 'a']);
      expect((await mutate(page, mode, 'bringToFront', ['a'])).code).toBe('');
      const after = await snapshot(page);
      expect(after.order).toEqual(['contained', 'a', 'b']);
      expect(after.rects).toEqual(before.rects);
      expect(after.markup.b).toBe(before.markup.b);
    });
  });

  it('rejects a target containing-block change before touching any object', async () => {
    const child = '<span data-probe="escape" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:yellow"></span>';
    await withPage(`<div data-ppt-el="a" style="width:120px;height:120px;background:blue">${child}</div>` + box('b'), async (page) => {
      const before = await snapshot(page);
      const result = await mutate(page, mode, 'bringToFront', ['a']);
      expect(result.code).toBe('unsupported-stacking');
      expect(result.message).toMatch(/flatten/i);
      expect(result.unchanged).toBe(true);
      expect(await snapshot(page)).toEqual(before);
    });
  });

  it('rejects reordering that would trap a target descendant below an unrelated upper layer', async () => {
    const child = '<span data-probe="escape" style="position:absolute;left:20px;top:20px;width:40px;height:40px;z-index:100;background:yellow"></span>';
    await withPage(box('a', '', child) + box('b', 'z-index:1') + box('c', 'z-index:2'), async (page) => {
      const before = await snapshot(page);
      const result = await mutate(page, mode, 'bringForward', ['a']);
      expect(result.code).toBe('unsupported-stacking');
      expect(result.message).toMatch(/flatten/i);
      expect(result.unchanged).toBe(true);
      expect(await snapshot(page)).toEqual(before);
    });
  });

  it('keeps unrelated static markup and descendant geometry on group and ungroup', async () => {
    const unrelated = '<div data-ppt-el="u" style="left:100px;top:100px;width:120px;height:120px"><span data-probe="descendant" style="position:absolute;left:20px;top:20px;width:40px;height:40px"></span></div>';
    await withPage(unrelated + box('a') + box('b'), async (page) => {
      const before = await snapshot(page);
      const grouped = await mutate(page, mode, 'groupElements', ['a', 'b']);
      expect(grouped.code).toBe('');
      expect((await snapshot(page)).markup.u).toBe(before.markup.u);
      expect((await mutate(page, mode, 'ungroupElement', [grouped.result as string])).code).toBe('');
      const after = await snapshot(page);
      expect(after.rects).toEqual(before.rects);
      expect(after.markup.u).toBe(before.markup.u);
      expect(after.order).toEqual(before.order);
    });
  });

  it('rejects trapping an escaping high-z descendant below unrelated content without any writes', async () => {
    const child = '<span data-probe="escape" style="position:absolute;left:20px;top:20px;width:40px;height:40px;z-index:100;background:yellow"></span>';
    await withPage(box('a', '', child) + box('b') + box('u', 'z-index:1'), async (page) => {
      const before = await snapshot(page);
      expect(before.order).toEqual(['escape', 'u', 'b', 'a']);
      const result = await mutate(page, mode, 'groupElements', ['a', 'b']);
      const after = await snapshot(page);
      console.info('escaping-group', mode, { result, before: before.order, after: after.order });
      expect(result.code).toBe('unsupported-stacking');
      expect(result.message).toMatch(/flatten/i);
      expect(result.unchanged).toBe(true);
      expect(after).toEqual(before);
    });
  });

  it('preserves rotated non-center-origin visuals through group and ungroup', async () => {
    await withPage(
      box('a', 'left:20px;top:20px;width:60px;height:40px;transform:rotate(90deg);transform-origin:0 0') + box('b', 'left:200px;top:10px;width:50px;height:50px'),
      async (page) => {
        const before = await snapshot(page);
        const grouped = await mutate(page, mode, 'groupElements', ['a', 'b']);
        expect(grouped.code).toBe('');
        const during = await snapshot(page);
        expect(rounded(during.rects.a)).toEqual(rounded(before.rects.a));
        expect(rounded(during.rects.b)).toEqual(rounded(before.rects.b));
        expect((await mutate(page, mode, 'ungroupElement', [grouped.result as string])).code).toBe('');
        const after = await snapshot(page);
        expect(rounded(after.rects.a)).toEqual(rounded(before.rects.a));
        expect(rounded(after.rects.b)).toEqual(rounded(before.rects.b));
      }
    );
  });

  it('round-trips the winning important display declaration', async () => {
    await withPage(box('a', 'display:flex !important;display:grid;left:5px !important'), async (page) => {
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        const api = (globalThis as typeof globalThis & { objectOperations: typeof operations }).objectOperations;
        api.setHidden(document, 's1', { elementId: 'a' }, true);
      });
      const hidden = await page.content();
      const doc = parseDeckHtml(hidden);
      operations.setHidden(doc, 's1', { elementId: 'a' }, false);
      await page.setContent(serializeDeck(doc));
      const display = await page.evaluate(() => getComputedStyle(document.querySelector('[data-ppt-el="a"]') as HTMLElement).display);
      expect(display).toBe('flex');
    });
  });
});
