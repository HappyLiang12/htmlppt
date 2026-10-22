import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { findChromium, renderPdf, renderPngs, RenderError, RendererUnavailableError } from '../src/index.js';

const require = createRequire(import.meta.url);
const deck = (body: string, css = '') => `<!doctype html><html><head><style>
  body { margin: 0; } .slide { width:320px; height:180px; background:rgb(12,34,56); }
  ${css}</style></head><body>${body}</body></html>`;
const twoSlides = deck(`
  <main><section class="slide active" data-slide-id="first" data-width="320" data-height="180">
    <div style="width:40px;height:40px;background:rgb(255,0,0)"></div><span>FIRST</span>
  </section><section class="slide" data-slide-id="second" data-width="320" data-height="180" style="display:none">
    <div style="width:40px;height:40px;background:rgb(0,255,0)"></div><span>SECOND</span>
  </section></main><nav>DO NOT PRINT</nav><script>document.body.innerHTML='SCRIPT RAN'</script>`,
  '.slide { display:flex; align-items:center; justify-content:center; position:absolute; inset:0; gap:10px; } .slide:not(.active) {display:none}');

function pixel(image: PNG, x: number, y: number) {
  const start = (y * image.width + x) * 4;
  return [...image.data.subarray(start, start + 4)];
}

async function pngAt(file: string) {
  return PNG.sync.read(await readFile(file));
}

function redBounds(image: PNG) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (pixel(image, x, y).join(',') === '255,0,0,255') {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
}

const activeSlides = `<section class="slide active" data-width="200" data-height="100"><div class="marker">A</div></section>
  <section class="slide" data-width="200" data-height="100"><div class="marker">B</div></section>`;
const activeCss = (display: string) => `.slide {display:none;width:200px;height:100px;background:white;align-items:center;justify-content:center}
  .slide.active {display:${display}} .marker {width:20px;height:20px;background:red;color:white;font:10px/20px Arial}`;

async function expectCenteredExports(html: string) {
  const source = path.join(dir, 'source.html');
  await writeFile(source, html);
  const files = await renderPngs({ html: await readFile(source, 'utf8'), width: 200, height: 100, outDir: dir, basename: 'centered' });
  expect(files).toHaveLength(2);
  for (const file of files) {
    const image = await pngAt(file);
    expect([image.width, image.height]).toEqual([400, 200]);
    expect.soft(redBounds(image), path.basename(file)).toEqual([180, 80, 40, 40]);
  }
  const outPath = path.join(dir, 'centered.pdf');
  await renderPdf({ html: await readFile(source, 'utf8'), width: 200, height: 100, outPath });
  const pdf = await getDocument({ data: new Uint8Array(await readFile(outPath)), useSystemFonts: true }).promise;
  try {
    expect(pdf.numPages).toBe(2);
    for (let n = 1; n <= 2; n++) {
      const page = await pdf.getPage(n);
      const items = (await page.getTextContent()).items.filter(item => 'str' in item);
      expect(items.map(item => item.str).join('')).toBe(n === 1 ? 'A' : 'B');
      expect.soft(items[0].transform[4]).toBeCloseTo(67.5, 2);
      expect.soft(items[0].transform[5]).toBeGreaterThan(30);
      expect.soft(items[0].transform[5]).toBeLessThan(41);
    }
  } finally {
    await pdf.destroy();
  }
  expect(await readFile(source, 'utf8')).toBe(html);
}

async function rasterizePdfPage(data: Uint8Array, scale: number) {
  const pdf = await getDocument({ data, useSystemFonts: true }).promise;
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as never, viewport }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data
    };
  } finally {
    await pdf.destroy();
  }
}

let dir: string;
let server: Server | undefined;
const sockets = new Set<Socket>();
let originalOverride: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'htmlppt-renderer-'));
  originalOverride = process.env.HTMLPPT_CHROMIUM;
});

afterEach(async () => {
  if (originalOverride === undefined) delete process.env.HTMLPPT_CHROMIUM;
  else process.env.HTMLPPT_CHROMIUM = originalOverride;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  sockets.clear();
  await rm(dir, { recursive: true, force: true });
});

async function serve(handler: RequestListener) {
  server = createServer(handler);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
  return `http://127.0.0.1:${address.port}`;
}

describe('Chromium discovery', () => {
  it('finds a real browser or reports the acceptance environment as blocked', async () => {
    const found = await findChromium();
    expect(found, 'BLOCKED: install Chromium or set HTMLPPT_CHROMIUM; rendering acceptance cannot run').not.toBeNull();
    expect(found!.executablePath).toBeTruthy();
    expect(['env', 'chrome', 'edge', 'chromium']).toContain(found!.source);
    expect(await findChromium({ ...process.env, HTMLPPT_CHROMIUM: found!.executablePath }))
      .toEqual({ executablePath: found!.executablePath, source: 'env' });
  });

  it('never falls through an authoritative missing, empty, or directory override', async () => {
    for (const override of [path.join(dir, 'missing-browser.exe'), '', dir]) {
      process.env.HTMLPPT_CHROMIUM = override;
      expect(await findChromium()).toBeNull();
      await expect(renderPdf({ html: twoSlides, width: 320, height: 180, outPath: path.join(dir, 'out.pdf') }))
        .rejects.toBeInstanceOf(RendererUnavailableError);
      await expect(renderPngs({ html: twoSlides, width: 320, height: 180, outDir: dir, basename: 'out' }))
        .rejects.toThrow(/install.*HTMLPPT_CHROMIUM/i);
    }
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('real Chromium rendering', () => {
  it.each(['flex', 'grid'])('waits for 800ms HTTP CSS before freezing active-state %s layout', async display => {
    const requests: string[] = [];
    const base = await serve((req, res) => {
      requests.push(req.url!);
      const timer = setTimeout(() => {
        res.setHeader('Content-Type', 'text/css');
        res.end(activeCss(display));
      }, 800);
      res.once('close', () => clearTimeout(timer));
    });
    await expectCenteredExports(`<!doctype html><html><head><link rel="stylesheet" href="${base}/delayed.css"></head><body>${activeSlides}</body></html>`);
    expect(requests).toEqual(['/delayed.css', '/delayed.css']);
    expect(sockets.size).toBe(0);
  });

  it.each(['flex', 'grid'])('preserves inline active-state %s layout on every slide', async display => {
    await expectCenteredExports(deck(activeSlides, activeCss(display)));
  });

  it('uses each hidden slide own active-state layout instead of borrowing the visible flex layout', async () => {
    const html = deck(`<section class="slide active" data-width="200" data-height="100"><div class="marker"></div></section>
      <section class="slide grid" data-width="200" data-height="100" style="display:none"><div class="marker"></div><i></i></section>
      <section class="slide block" hidden data-width="200" data-height="100"><div class="marker"></div></section>`,
    `${activeCss('flex')} .slide.grid.active {display:grid;grid-template-columns:20px 20px;column-gap:20px}
      .slide.block.active {display:block}`);
    const files = await renderPngs({ html, width: 200, height: 100, outDir: dir, basename: 'own-layout' });
    expect(files).toHaveLength(3);
    expect.soft(redBounds(await pngAt(files[0]))).toEqual([180, 80, 40, 40]);
    expect.soft(redBounds(await pngAt(files[1]))).toEqual([140, 80, 40, 40]);
    expect.soft(redBounds(await pngAt(files[2]))).toEqual([0, 0, 40, 40]);
  });

  it('settles fonts and background images requested only by a revealed active slide', async () => {
    const requests: string[] = [];
    const asset = new PNG({ width: 1, height: 1 });
    asset.data.set([0, 255, 0, 255]);
    const image = PNG.sync.write(asset);
    const font = await readFile(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
    const base = await serve((req, res) => {
      requests.push(req.url!);
      res.setHeader('Access-Control-Allow-Origin', '*');
      const timer = setTimeout(() => {
        res.setHeader('Content-Type', req.url === '/revealed.ttf' ? 'font/ttf' : 'image/png');
        res.end(req.url === '/revealed.ttf' ? font : image);
      }, 800);
      res.once('close', () => clearTimeout(timer));
    });
    const html = deck(activeSlides, `${activeCss('flex')}
      @font-face {font-family:Revealed;src:url('${base}/revealed.ttf')}
      .slide:nth-of-type(2).active .marker {font-family:Revealed;background-image:url('${base}/revealed.png')}`);
    const files = await renderPngs({ html, width: 200, height: 100, outDir: dir, basename: 'revealed' });
    expect(files).toHaveLength(2);
    expect(pixel(await pngAt(files[1]), 215, 115)).toEqual([0, 255, 0, 255]);
    expect(new Set(requests)).toEqual(new Set(['/revealed.ttf', '/revealed.png']));
    expect(sockets.size).toBe(0);
  });

  it('reports missing HTTP stylesheets without replacing output and closes connections', async () => {
    const requests: string[] = [];
    const base = await serve((req, res) => {
      requests.push(req.url!);
      res.writeHead(404).end('Missing stylesheet');
    });
    const outPath = path.join(dir, 'missing-css.pdf');
    await writeFile(outPath, 'existing output');
    await expect(renderPdf({
      html: deck(activeSlides).replace('</head>', `<link rel="stylesheet" href="${base}/missing.css"></head>`),
      width: 200, height: 100, outPath
    })).rejects.toMatchObject({ name: 'RenderError', message: expect.stringMatching(/missing\.css.*HTTP 404.*Check asset URLs/) });
    expect(requests).toEqual(['/missing.css']);
    expect(sockets.size).toBe(0);
    expect(await readFile(outPath, 'utf8')).toBe('existing output');
    expect(await readdir(dir)).toEqual(['missing-css.pdf']);
  });

  it('times out stalled HTTP stylesheets with an actionable error and no partial PNGs', async () => {
    const requests: string[] = [];
    const base = await serve((req, _res) => { requests.push(req.url!); });
    const start = Date.now();
    await expect(renderPngs({
      html: deck(activeSlides).replace('</head>', `<link rel="stylesheet" href="${base}/stalled.css"></head>`),
      width: 200, height: 100, outDir: dir, basename: 'stalled-css'
    })).rejects.toMatchObject({ name: 'RenderError', message: expect.stringMatching(/timed out.*(asset|stylesheet).*HTTP.*network/i) });
    expect(Date.now() - start).toBeLessThan(25000);
    expect(requests).toEqual(['/stalled.css']);
    expect(sockets.size).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('prints every runtime-hidden slide on an exact zero-margin page without mutating source', async () => {
    const sourcePath = path.join(dir, 'source.html');
    await writeFile(sourcePath, twoSlides);
    const html = await readFile(sourcePath, 'utf8');
    const output = path.join(dir, 'slides.pdf');
    await renderPdf({ html, width: 320, height: 180, outPath: output });
    const pdf = await getDocument({ data: new Uint8Array(await readFile(output)), useSystemFonts: true }).promise;
    try {
      expect(pdf.numPages).toBe(2);
      for (let n = 1; n <= 2; n++) {
        const page = await pdf.getPage(n);
        expect(page.view).toEqual([0, 0, 240, 135]);
        const text = (await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
        expect(text).toContain(n === 1 ? 'FIRST' : 'SECOND');
        expect(text).not.toMatch(/DO NOT PRINT|SCRIPT RAN/);
        expect(text).not.toContain(n === 1 ? 'SECOND' : 'FIRST');
      }
    } finally {
      await pdf.destroy();
    }
    expect(html).toBe(twoSlides);
    expect(await readFile(sourcePath, 'utf8')).toBe(twoSlides);
  });

  it('isolates 2x PNGs while preserving flex positioning and slide backgrounds', async () => {
    const files = await renderPngs({ html: twoSlides, width: 320, height: 180, outDir: dir, basename: 'deck' });
    expect(files).toEqual([path.join(dir, 'deck-s1.png'), path.join(dir, 'deck-s2.png')]);
    for (const [index, file] of files.entries()) {
      const image = await pngAt(file);
      expect([image.width, image.height]).toEqual([640, 360]);
      expect(pixel(image, 5, 5)).toEqual([12, 34, 56, 255]);
      expect(pixel(image, 235, 180)).toEqual(index === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]);
    }
  });

  it.each(['slide', 'page', 'slide-page', 'sections'])('detects unmarked %s slides and uses mixed canvas dimensions', async kind => {
    const attr = kind === 'sections' ? '' : `class="${kind}"`;
    const html = deck(`<main><section ${attr} data-width="200" data-height="100" style="background:rgb(255,0,0)"></section>
      <section ${attr} style="width:120px;height:80px;background:rgb(0,0,255)"></section></main>`,
      'section { display:grid; place-items:center; }');
    const files = await renderPngs({ html, width: 320, height: 180, outDir: dir, basename: 'mixed' });
    expect(files).toHaveLength(2);
    const first = await pngAt(files[0]);
    const second = await pngAt(files[1]);
    expect([first.width, first.height, second.width, second.height]).toEqual([400, 200, 240, 160]);
    expect(pixel(first, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(pixel(second, 20, 20)).toEqual([0, 0, 255, 255]);
  });

  it('uses body fallback and preserves grid layout without canvas markers', async () => {
    const html = deck('<div style="width:20px;height:20px;background:red"></div>',
      'body { display:grid; place-items:center; background:rgb(0,0,255); }');
    const [file] = await renderPngs({ html, width: 100, height: 60, outDir: dir, basename: 'body' });
    const image = await pngAt(file);
    expect([image.width, image.height]).toEqual([200, 120]);
    expect(pixel(image, 100, 60)).toEqual([255, 0, 0, 255]);
    expect(pixel(image, 5, 5)).toEqual([0, 0, 255, 255]);
  });

  it('preserves valid title metadata containing PDF syntax', async () => {
    const html = deck('<section class="slide" data-width="320" data-height="180"></section>')
      .replace('<head>', '<head><title>trailer &lt;&lt; preview endobj startxref (x) \\\\</title>');
    const outPath = path.join(dir, 'metadata.pdf');
    await renderPdf({ html, width: 320, height: 180, outPath });
    const pdf = await getDocument({ data: new Uint8Array(await readFile(outPath)), useSystemFonts: true }).promise;
    try {
      expect(pdf.numPages).toBe(1);
      const page = await pdf.getPage(1);
      expect(page.view).toEqual([0, 0, 240, 135]);
      const metadata = await pdf.getMetadata();
      expect(String((metadata.info as { Title?: string }).Title)).toContain('trailer << preview');
    } finally {
      await pdf.destroy();
    }
  });

  it('rasterizes the exact PDF page without clipped or white edge strips', async () => {
    const outPath = path.join(dir, 'full-bleed.pdf');
    await renderPdf({
      html: deck('<section class="slide" data-width="320" data-height="180"></section>', '.slide { background:rgb(255,0,0) !important; }'),
      width: 320,
      height: 180,
      outPath
    });
    const image = await rasterizePdfPage(new Uint8Array(await readFile(outPath)), 8);
    expect([image.width, image.height]).toEqual([1920, 1080]);
    const red = (x: number, y: number) => {
      const offset = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
      return r > 240 && g < 20 && b < 20;
    };
    // The vector page is full-bleed (320x180 path scaled by 0.75). PDF.js can
    // drop the final device row or column to boundary antialiasing, so require
    // coverage to reach within one pixel of every edge rather than every last
    // pixel; a real clipped or white strip would be wider than that.
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (!red(x, y)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    expect([minX, minY]).toEqual([0, 0]);
    expect(maxX).toBeGreaterThanOrEqual(image.width - 2);
    expect(maxY).toBeGreaterThanOrEqual(image.height - 2);
    for (let x = 0; x < image.width; x++) {
      expect.soft(red(x, 0), `top ${x}`).toBe(true);
      expect.soft(red(x, image.height - 2), `bottom ${x}`).toBe(true);
    }
    for (let y = 0; y < image.height - 1; y++) {
      expect.soft(red(0, y), `left ${y}`).toBe(true);
      expect.soft(red(image.width - 1, y), `right ${y}`).toBe(true);
    }
  });

  it('permits HTTP CSS, fonts and images but blocks authored execution, frames, navigation and local files', async () => {
    const requests: string[] = [];
    const asset = new PNG({ width: 10, height: 10 });
    asset.data.fill(255);
    const image = PNG.sync.write(asset);
    const font = await readFile(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
    const base = await serve((req, res) => {
      requests.push(req.url!);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url === '/style.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(`@font-face {font-family:Fixture;src:url('${base}/font.ttf')} .slide {font-family:Fixture;background-image:url('${base}/background.png')}`);
      } else if (req.url === '/font.ttf') {
        res.setHeader('Content-Type', 'font/ttf'); res.end(font);
      } else if (req.url === '/image.png' || req.url === '/background.png') {
        res.setHeader('Content-Type', 'image/png'); res.end(image);
      } else {
        res.end('forbidden');
      }
    });
    const local = path.join(dir, 'local.svg');
    await writeFile(local, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>');
    const html = deck(`<link rel="stylesheet" href="${base}/style.css">
      <meta http-equiv="refresh" content="0;url=${base}/navigation">
      <link rel="preload" as="fetch" href="${base}/fetch">
      <section class="slide" data-width="100" data-height="100">
        <span>Font loaded</span><img src="${base}/image.png" onload="fetch('${base}/onload')">
        <img style="position:absolute;left:0;top:0;width:100px;height:100px" src="${pathToFileURL(local)}">
        <iframe src="${base}/frame"></iframe><iframe srcdoc="<img src='${base}/srcdoc'>"></iframe>
      </section><script src="${base}/script.js"></script><script>
        fetch('${base}/script-fetch'); new WebSocket('${base.replace('http:', 'ws:')}/socket');
        new Worker('${base}/worker'); navigator.serviceWorker.register('${base}/service-worker');
        location.href='${base}/script-navigation';
      </script>`);
    const [file] = await renderPngs({ html, width: 100, height: 100, outDir: dir, basename: 'isolated' });
    const png = await pngAt(file);
    expect(pixel(png, 190, 190)).toEqual([255, 255, 255, 255]);
    const pdfPath = path.join(dir, 'isolated.pdf');
    await renderPdf({ html, width: 100, height: 100, outPath: pdfPath });
    const pdf = await getDocument({ data: new Uint8Array(await readFile(pdfPath)), useSystemFonts: true }).promise;
    try {
      expect(pdf.numPages).toBe(1);
      const page = await pdf.getPage(1);
      expect(page.view).toEqual([0, 0, 75, 75]);
      expect((await page.getOperatorList()).fnArray).toContain(OPS.paintImageXObject);
    } finally {
      await pdf.destroy();
    }
    expect(new Set(requests)).toEqual(new Set(['/style.css', '/font.ttf', '/image.png', '/background.png']));
    expect(sockets.size).toBe(0);
  });

  it('blocks non-network refresh navigation without losing the original slide', async () => {
    const html = deck('<meta http-equiv="refresh" content="0;url=about:blank"><section class="slide" data-width="100" data-height="100"></section>');
    const [file] = await renderPngs({ html, width: 100, height: 100, outDir: dir, basename: 'navigation' });
    expect(pixel(await pngAt(file), 100, 100)).toEqual([12, 34, 56, 255]);
  });

  it('times out stalled HTTP assets, preserves existing output and closes browser connections', async () => {
    const requested: string[] = [];
    const base = await serve((req, _res) => { requested.push(req.url!); });
    const outPath = path.join(dir, 'timeout.pdf');
    await writeFile(outPath, 'existing output');
    const start = Date.now();
    await expect(renderPdf({
      html: deck(`<section class="slide"><img src="${base}/stalled.png"></section>`),
      width: 320, height: 180, outPath
    })).rejects.toThrow(/timed out.*(asset|font|image).*HTTP|timed out.*(asset|font|image).*network/i);
    expect(Date.now() - start).toBeLessThan(25000);
    expect(requested).toEqual(['/stalled.png']);
    expect(sockets.size).toBe(0);
    expect(await readFile(outPath, 'utf8')).toBe('existing output');
    expect(await readdir(dir)).toEqual(['timeout.pdf']);
  });

  it('keeps PDF placement failures atomic and closes asset connections', async () => {
    const base = await serve((_req, res) => { res.setHeader('Content-Type', 'text/css'); res.end('.slide {color:red}'); });
    const outPath = path.join(dir, 'out.pdf');
    await mkdir(outPath);
    await writeFile(path.join(outPath, 'keep'), 'untouched');
    const rendering = renderPdf({ html: twoSlides.replace('</head>', `<link rel="stylesheet" href="${base}/style.css"></head>`), width: 320, height: 180, outPath });
    await expect(rendering).rejects.toBeInstanceOf(RenderError);
    await expect(rendering).rejects.toMatchObject({ cause: { code: expect.stringMatching(/EISDIR|EEXIST|EPERM|EACCES/), syscall: 'rename' } });
    expect(await readdir(dir)).toEqual(['out.pdf']);
    expect(await readFile(path.join(outPath, 'keep'), 'utf8')).toBe('untouched');
    expect(sockets.size).toBe(0);
  });

  it('reports the failing PNG slide and leaves only complete outputs', async () => {
    await mkdir(path.join(dir, 'deck-s2.png'));
    await writeFile(path.join(dir, 'deck-s2.png', 'keep'), 'untouched');
    await expect(renderPngs({ html: twoSlides, width: 320, height: 180, outDir: dir, basename: 'deck' }))
      .rejects.toMatchObject({ name: 'RenderError', slide: 2 });
    expect((await pngAt(path.join(dir, 'deck-s1.png'))).width).toBe(640);
    expect((await readdir(dir)).sort()).toEqual(['deck-s1.png', 'deck-s2.png']);
    expect(await readFile(path.join(dir, 'deck-s2.png', 'keep'), 'utf8')).toBe('untouched');
  });

  it.each(['', '.', '..', '../escape', 'dir/file', 'dir\\file', 'C:escape', 'CON', 'nul.txt', 'trailing.', 'trailing ', 'bad\u0000name'])('rejects invalid basename %j before writing', async basename => {
    await expect(renderPngs({ html: twoSlides, width: 320, height: 180, outDir: dir, basename }))
      .rejects.toMatchObject({ name: 'RenderError', message: expect.stringMatching(/basename/i) });
    expect(await readdir(dir)).toEqual([]);
  });
});
