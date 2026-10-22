# M1 Core Contract Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the M0 core from a parser/validator skeleton into the contract engine every later milestone depends on: deterministic normalization and ids, full validation, outline/read models, validated mutations, runtime hardening, and golden fixtures.

**Architecture:** All work lives in `@htmlppt/core` (pure DOM operations, browser and linkedom compatible) plus the inline runtime and template. Normalization assigns stable ids and returns a change summary; validation is a pure read that emits deterministic diagnostics with locations; mutations clone the master document, apply one operation, normalize, validate, and either return a new document or throw `DeckMutationError`. Golden fixtures pin validation, outline, and normalized HTML across messy real-world decks. M1 exposes no new UI or CLI command; M2/M3 consume these APIs.

**Tech Stack:** TypeScript strict, ESM, linkedom (Node adapter only), Vitest 3, Playwright Chromium, Node >= 20.

**Spec:** `docs/superpowers/specs/2026-10-21-html-ppt-editor-design.md` (§4 contract, §6 MCP tools, §11 import/validation/normalization, Runtime); `docs/superpowers/specs/2026-10-21-test-framework-design.md` (§5 golden tests).

## Global Constraints

- Node >= 20, ESM, TypeScript strict. No new runtime or dev dependencies. No retries, no skips, no mocks of host/filesystem/Chromium.
- The HTML file is the source of truth. Every mutation returns a valid document; no sidecar data.
- Determinism: ids, diagnostic order, outline order, and serialized output must be stable across runs and platforms. No `Date`, randomness, or locale-dependent sorting in core.
- `@htmlppt/core` root entry stays environment-neutral: no `node:` imports. linkedom is used only by `src/node.ts`.
- Do not add editor artifacts, wrapper elements, or classes to saved markup. Normalization only assigns ids, adds `position: relative` when explicitly requested, and removes editor-only attributes.
- UI copy is Traditional Chinese; code, diagnostics, docs, and test names are English.
- Authoring a failing test before production code is mandatory. Golden files are written from a reviewed run and must be inspected line by line before commit.
- Keep `npm run verify` green at every commit. Commit locally only; no push, merge, or publish.

## File Structure

```
packages/core/src/
  types.ts          Diagnostic location, ValidationResult (existing, extended)
  detect.ts         detection + readSize (existing; export helpers used by normalize/validate)
  ids.ts            IdFactory + deterministic default
  normalize.ts      assign ids, artifact cleanup, optional position fix
  validate.ts       full rule set (existing, rewritten)
  outline.ts        getOutline + readSlide read models
  target.ts         ElementTarget resolution
  mutations.ts      element + slide mutations, mutateDeck gate, DeckMutationError
  serialize.ts      existing; unchanged
  template.ts       initial-hidden + print CSS in the generated deck
  index.ts          new exports
packages/core/test/
  validate.test.ts  (extend)
  normalize.test.ts (new)
  outline.test.ts   (new)
  mutations.test.ts (new)
  golden.test.ts    (new)
  template.test.ts  (extend)
packages/runtime/src/index.ts        runtime hardening (initial display, print, input guard)
test-utils/fixtures/
  basic.deck.html (existing), rich.deck.html, messy.deck.html,
  animated.deck.html, external.deck.html, malicious.deck.html,
  *.expected.json / *.expected.html goldens
e2e/runtime.spec.ts                  @feature:runtime E2E
docs/features.json                   add active runtime feature
```

---

### Task 1: Diagnostic locations and error rules

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/detect.ts` (export `readSize` as `readCanvasSize`)
- Modify: `packages/core/src/validate.ts`
- Modify: `packages/core/test/validate.test.ts`

**Interfaces:**
- Produces: `Diagnostic.location?: string`; error codes `duplicate-element-id`, `invalid-canvas-size`, `invalid-transition`, `invalid-runtime-marker`, `duplicate-runtime`, `notes-nested-incorrectly`, `editor-artifacts`; `readCanvasSize(element): { width; height; widthValid; heightValid }` from detect.
- `validateDeck(doc: Document): ValidationResult` keeps its signature.

- [ ] **Step 1: Write failing validation tests**

Append to `packages/core/test/validate.test.ts`:

```ts
describe('validateDeck error rules', () => {
  const run = (body: string) =>
    validateDeck(
      parseDeckHtml(
        `<!doctype html><html><head><title>Deck</title></head><body>${body}</body></html>`
      )
    );

  it('rejects duplicate element ids within a slide but allows them across slides', () => {
    const duplicate = run(
      '<section data-slide-id="s1"><h1 data-ppt-el="e1">A</h1><p data-ppt-el="e1">B</p></section>'
    );
    expect(duplicate.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate-element-id',
        slideId: 's1',
        location: 's1 > h1'
      })
    );

    const across = run(
      '<section data-slide-id="s1"><h1 data-ppt-el="e1">A</h1></section><section data-slide-id="s2"><h1 data-ppt-el="e1">B</h1></section>'
    );
    expect(across.errors).toEqual([]);
  });

  it('rejects invalid canvas attributes', () => {
    const result = run(
      '<section data-slide-id="s1" data-width="wide" data-height="0"></section>'
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-canvas-size',
        slideId: 's1',
        message: 'Slide canvas width "wide" is not a positive number.'
      })
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-canvas-size',
        slideId: 's1',
        message: 'Slide canvas height "0" is not a positive number.'
      })
    );
  });

  it('rejects invalid transitions and accepts the contract values', () => {
    const invalid = run(
      '<section data-slide-id="s1" data-ppt-transition="zoom"></section>'
    );
    expect(invalid.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-transition',
        slideId: 's1',
        location: 's1'
      })
    );

    for (const value of ['none', 'fade', 'slide']) {
      expect(
        run(`<section data-slide-id="s1" data-ppt-transition="${value}"></section>`).errors
      ).toEqual([]);
    }
  });

  it('rejects invalid and duplicate runtime markers', () => {
    const nonScript = run('<div data-ppt-runtime="1"></div><section data-slide-id="s1"></section>');
    expect(nonScript.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-runtime-marker' })
    );

    const wrongValue = run(
      '<section data-slide-id="s1"></section><script data-ppt-runtime="0"></script>'
    );
    expect(wrongValue.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-runtime-marker' })
    );

    const duplicate = run(
      '<section data-slide-id="s1"></section><script data-ppt-runtime="1"></script><script data-ppt-runtime="1"></script>'
    );
    expect(duplicate.errors).toContainEqual(
      expect.objectContaining({ code: 'duplicate-runtime' })
    );
  });

  it('rejects notes that are not a direct child of a slide', () => {
    const nested = run(
      '<section data-slide-id="s1"><div><aside data-ppt-notes hidden>Nested</aside></div></section>'
    );
    expect(nested.errors).toContainEqual(
      expect.objectContaining({
        code: 'notes-nested-incorrectly',
        slideId: 's1',
        location: 's1 > aside'
      })
    );

    const direct = run(
      '<section data-slide-id="s1"><aside data-ppt-notes hidden>Direct</aside></section>'
    );
    expect(direct.errors).toEqual([]);
  });

  it('rejects editor artifacts', () => {
    const result = run(
      '<section data-slide-id="s1"><h1 data-ppt-editing="true">A</h1><p data-ppt-frame-slide="abc">B</p></section>'
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'editor-artifacts',
        message: 'Editor-only attribute "data-ppt-editing" is present.'
      })
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'editor-artifacts',
        message: 'Editor-only attribute "data-ppt-frame-slide" is present.'
      })
    );
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -w @htmlppt/core -- validate`
Expected: FAIL — new codes are absent; `location` is undefined.

- [ ] **Step 3: Implement the error rules**

In `types.ts`, add `location?: string` to `Diagnostic` with the comment "Short human-readable path such as `s2 > figure#chart`."

In `detect.ts`, rename the private `readSize` to `readCanvasSize`, export it, and return validity flags:

```ts
export interface CanvasSize {
  width: number;
  height: number;
  widthValid: boolean;
  heightValid: boolean;
}

export function readCanvasSize(element: Element): CanvasSize {
  const rawWidth = element.getAttribute('data-width');
  const rawHeight = element.getAttribute('data-height');
  const attributeWidth = readAttributeSize(rawWidth);
  const attributeHeight = readAttributeSize(rawHeight);
  const inlineStyle = element.getAttribute('style') ?? '';
  const styleWidth = readStyleSize(inlineStyle, 'width');
  const styleHeight = readStyleSize(inlineStyle, 'height');

  return {
    width: positiveNumber(attributeWidth)
      ? attributeWidth
      : positiveNumber(styleWidth)
        ? styleWidth
        : DEFAULT_WIDTH,
    height: positiveNumber(attributeHeight)
      ? attributeHeight
      : positiveNumber(styleHeight)
        ? styleHeight
        : DEFAULT_HEIGHT,
    widthValid: rawWidth === null || positiveNumber(attributeWidth),
    heightValid: rawHeight === null || positiveNumber(attributeHeight)
  };
}
```

`toSlideInfo` uses `readCanvasSize`. `SlideInfo` gains `widthValid: boolean; heightValid: boolean`.

Rewrite `validate.ts` around a deterministic pass. Exact new helpers and rules:

```ts
const TRANSITIONS = new Set(['none', 'fade', 'slide']);
const RUNTIME_ATTRIBUTE = 'data-ppt-runtime';
const EDITOR_ATTRIBUTES = ['data-ppt-editing', 'data-ppt-frame-slide'];

function elementLocation(slide: SlideInfo | undefined, element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute('id');
  const base = `${tag}${id ? `#${id}` : ''}`;
  return slide ? `${slide.id} > ${base}` : base;
}

function slideFor(
  element: Element,
  slides: SlideInfo[]
): SlideInfo | undefined {
  const elements = new Set(slides.map((slide) => slide.element));
  let current: Element | null = element;
  while (current) {
    const match = slides.find((slide) => slide.element === current);
    if (match && elements.has(current)) return match;
    current = current.parentElement;
  }
  return undefined;
}
```

Inside `validateDeck`, after detection:

```ts
for (const slide of slides) {
  if (slide.element === doc.body) continue;

  if (!slide.widthValid) {
    errors.push(diagnostic('error', 'invalid-canvas-size',
      `Slide canvas width "${slide.element.getAttribute('data-width')}" is not a positive number.`,
      slide.id, slide.id));
  }
  if (!slide.heightValid) {
    errors.push(diagnostic('error', 'invalid-canvas-size',
      `Slide canvas height "${slide.element.getAttribute('data-height')}" is not a positive number.`,
      slide.id, slide.id));
  }

  const transition = slide.element.getAttribute('data-ppt-transition');
  if (transition !== null && !TRANSITIONS.has(transition.trim())) {
    errors.push(diagnostic('error', 'invalid-transition',
      `Transition "${transition}" is not one of none, fade, slide.`,
      slide.id, slide.id));
  }

  const elementIds = new Map<string, number>();
  for (const element of Array.from(slide.element.querySelectorAll('[data-ppt-el]'))) {
    const id = element.getAttribute('data-ppt-el')?.trim();
    if (id) elementIds.set(id, (elementIds.get(id) ?? 0) + 1);
  }
  for (const [id, count] of elementIds) {
    if (count > 1) {
      const first = Array.from(slide.element.querySelectorAll('[data-ppt-el]'))
        .find((element) => element.getAttribute('data-ppt-el')?.trim() === id);
      errors.push(diagnostic('error', 'duplicate-element-id',
        `Element id "${id}" is used ${count} times in slide "${slide.id}".`,
        slide.id, first ? elementLocation(slide, first) : slide.id));
    }
  }
}
```

Diagnostic builder becomes:

```ts
function diagnostic(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  slideId?: string,
  location?: string
): Diagnostic {
  return {
    severity,
    code,
    message,
    ...(slideId ? { slideId } : {}),
    ...(location ? { location } : {})
  };
}
```

Then:

```ts
const markers = Array.from(doc.querySelectorAll(`[${RUNTIME_ATTRIBUTE}]`));
let validRuntimes = 0;
for (const marker of markers) {
  if (marker.tagName !== 'SCRIPT' || marker.getAttribute(RUNTIME_ATTRIBUTE)?.trim() !== '1') {
    errors.push(diagnostic('error', 'invalid-runtime-marker',
      'Runtime marker must be data-ppt-runtime="1" on a script element.'));
  } else {
    validRuntimes += 1;
  }
}
if (validRuntimes > 1) {
  errors.push(diagnostic('error', 'duplicate-runtime',
    'More than one runtime script is present.'));
}

for (const notes of Array.from(doc.querySelectorAll('[data-ppt-notes]'))) {
  const parent = notes.parentElement;
  const owner = slideFor(notes, slides);
  if (!parent || !owner || owner.element !== parent) {
    errors.push(diagnostic('error', 'notes-nested-incorrectly',
      'Speaker notes must be a direct child of a slide.',
      owner?.id, elementLocation(owner, notes)));
  }
}

for (const attribute of EDITOR_ATTRIBUTES) {
  for (const element of Array.from(doc.querySelectorAll(`[${attribute}]`))) {
    const owner = slideFor(element, slides);
    errors.push(diagnostic('error', 'editor-artifacts',
      `Editor-only attribute "${attribute}" is present.`,
      owner?.id, elementLocation(owner, element)));
  }
}
```

Keep the existing empty-document, missing-title, missing-slide-id, duplicate-slide-id, invalid-chart-json, and slide-count behavior. Remove the `no-slides` error: with detection's body fallback it is unreachable except for empty documents, which already emit `empty-document`.

- [ ] **Step 4: Run GREEN and the full core suite**

Run: `npm run test -w @htmlppt/core`
Expected: all pass. Existing exact `info` assertion stays valid (no location on info).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): add validation locations and contract error rules"
```

---

### Task 2: Validation warnings

**Files:**
- Modify: `packages/core/src/validate.ts`
- Modify: `packages/core/test/validate.test.ts`

**Interfaces:**
- Produces warning codes: `single-body-fallback`, `missing-runtime`, `script-present`, `relative-asset`, `fixed-layout`, `mixed-canvas-sizes`, `canvas-content`, `unsupported-group-nesting`. `missing-slide-id`, `missing-title` unchanged.

- [ ] **Step 1: Write failing warning tests**

Append:

```ts
describe('validateDeck warning rules', () => {
  const run = (body: string, head = '') =>
    validateDeck(
      parseDeckHtml(
        `<!doctype html><html><head><title>Deck</title>${head}</head><body>${body}</body></html>`
      )
    );

  it('warns about the single-body fallback without a missing-slide-id warning', () => {
    const result = run('<h1>Whole body</h1>');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'single-body-fallback' })
    );
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'missing-slide-id' })
    );
  });

  it('warns when multiple slides have no runtime', () => {
    const result = run(
      '<section data-slide-id="s1"></section><section data-slide-id="s2"></section>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-runtime' })
    );
  });

  it('does not warn about a missing runtime when one is present', () => {
    const result = run(
      '<section data-slide-id="s1"></section><section data-slide-id="s2"></section><script data-ppt-runtime="1"></script>'
    );
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'missing-runtime' })
    );
  });

  it('warns about non-runtime scripts but allows JSON data', () => {
    const scripts = run(
      '<section data-slide-id="s1"></section><script>window.x = 1;</script>'
    );
    expect(scripts.warnings).toContainEqual(
      expect.objectContaining({ code: 'script-present' })
    );

    const json = run(
      '<section data-slide-id="s1"></section><script type="application/json">{"a":1}</script>'
    );
    expect(json.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'script-present' })
    );
  });

  it('warns about relative assets in attributes and CSS', () => {
    const result = run(
      '<section data-slide-id="s1"><img src="assets/photo.png"><div style="background:url(../bg.png)"></div></section>',
      '<style>.slide { background: url("local.png"); }</style>'
    );
    const codes = result.warnings
      .filter((warning) => warning.code === 'relative-asset')
      .map((warning) => warning.message);
    expect(codes).toEqual([
      'Relative asset "assets/photo.png" is not supported; use a data: or absolute URL.',
      'Relative asset "../bg.png" is not supported; use a data: or absolute URL.',
      'Relative asset "local.png" is not supported; use a data: or absolute URL.'
    ]);
    expect(
      result.warnings.some((warning) => warning.message.includes('data:'))
    ).toBe(false);
  });

  it('does not warn about data, absolute, hash, or scheme URLs', () => {
    const result = run(
      '<section data-slide-id="s1"><img src="data:image/png;base64,AA"><img src="https://example.com/a.png"><a href="#/2">x</a><a href="mailto:a@b.c">m</a></section>'
    );
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'relative-asset' })
    );
  });

  it('warns about fixed and viewport-sized layout', () => {
    const result = run(
      '<section data-slide-id="s1"><div style="position:fixed;height:100vh"></div></section>',
      '<style>.slide { min-height: 100dvh; }</style>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'fixed-layout', slideId: 's1' })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'fixed-layout', location: 'style' })
    );
  });

  it('warns about mixed canvas sizes', () => {
    const result = run(
      '<section data-slide-id="s1" data-width="1600" data-height="900"></section><section data-slide-id="s2" data-width="1920" data-height="1080"></section>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'mixed-canvas-sizes' })
    );
  });

  it('warns about canvas elements and nested groups', () => {
    const result = run(
      '<section data-slide-id="s1"><canvas></canvas><div data-ppt-group><div data-ppt-group></div></div></section>'
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'canvas-content', slideId: 's1' })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'unsupported-group-nesting' })
    );
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -w @htmlppt/core -- validate`
Expected: FAIL — warning codes absent. The existing test `accepts a deck with unique slide ids` also fails once `missing-runtime` exists; update that test first to include `<script data-ppt-runtime="1"></script>` so it still asserts zero warnings.

- [ ] **Step 3: Implement the warnings**

Add helpers:

```ts
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isRelativeUrl(value: string): boolean {
  const url = value.trim();
  if (!url || url.startsWith('#') || url.startsWith('//')) return false;
  return !URL_SCHEME.test(url);
}

function attributeSizeIssue(element: Element, name: string): string | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  const match = raw.trim().match(/^([\d.]+)(?:px)?$/i);
  return match && Number.parseFloat(match[1]) > 0 ? null : raw;
}
```

Rules (append after the error pass, preserving this order):

```ts
const explicitSlides = slides.filter((slide) => slide.element !== doc.body);

if (explicitSlides.length === 0 && !bodyIsEmpty) {
  warnings.push(diagnostic('warning', 'single-body-fallback',
    'No slide elements were found; the body is treated as a single slide.'));
}

for (const slide of explicitSlides) {
  if (!slide.hasId) {
    warnings.push(diagnostic('warning', 'missing-slide-id',
      `Slide ${slide.index + 1} has no data-slide-id.`, slide.id));
  }
}

if (explicitSlides.length > 1 && markers.length === 0) {
  warnings.push(diagnostic('warning', 'missing-runtime',
    'The deck has multiple slides but no presentation runtime.'));
}

for (const script of Array.from(doc.querySelectorAll('script'))) {
  const type = (script.getAttribute('type') ?? '').trim().toLowerCase();
  if (script.getAttribute(RUNTIME_ATTRIBUTE)?.trim() === '1') continue;
  if (type === 'application/json' || type === 'application/ld+json') continue;
  const owner = slideFor(script, slides);
  warnings.push(diagnostic('warning', 'script-present',
    'A non-runtime script is present; scripts do not run in the editor.',
    owner?.id, owner ? elementLocation(owner, script) : 'document > script'));
}

const relativeUrls = new Set<string>();
const warnRelative = (value: string, owner: SlideInfo | undefined, location: string) => {
  if (!isRelativeUrl(value)) return;
  const key = `${location}:${value}`;
  if (relativeUrls.has(key)) return;
  relativeUrls.add(key);
  warnings.push(diagnostic('warning', 'relative-asset',
    `Relative asset "${value.trim()}" is not supported; use a data: or absolute URL.`,
    owner?.id, location));
};

for (const element of Array.from(doc.querySelectorAll('[src], [href]'))) {
  const owner = slideFor(element, slides);
  for (const attribute of ['src', 'href']) {
    const value = element.getAttribute(attribute);
    if (value !== null) warnRelative(value, owner, elementLocation(owner, element));
  }
}

const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
for (const element of Array.from(doc.querySelectorAll('[style]'))) {
  const style = element.getAttribute('style') ?? '';
  const owner = slideFor(element, slides);
  for (const match of style.matchAll(URL_PATTERN)) {
    warnRelative(match[2], owner, elementLocation(owner, element));
  }
}
for (const style of Array.from(doc.querySelectorAll('style'))) {
  for (const match of (style.textContent ?? '').matchAll(URL_PATTERN)) {
    warnRelative(match[2], undefined, 'style');
  }
}

const layoutPattern = /position\s*:\s*fixed|100(?:d|s|l)?vh/i;
for (const element of Array.from(doc.querySelectorAll('[style]'))) {
  if (layoutPattern.test(element.getAttribute('style') ?? '')) {
    const owner = slideFor(element, slides);
    warnings.push(diagnostic('warning', 'fixed-layout',
      'Fixed or viewport-sized layout may not export reliably.',
      owner?.id, elementLocation(owner, element)));
  }
}
for (const style of Array.from(doc.querySelectorAll('style'))) {
  if (layoutPattern.test(style.textContent ?? '')) {
    warnings.push(diagnostic('warning', 'fixed-layout',
      'Fixed or viewport-sized layout may not export reliably.',
      undefined, 'style'));
  }
}

if (new Set(explicitSlides.map((slide) => `${slide.width}x${slide.height}`)).size > 1) {
  warnings.push(diagnostic('warning', 'mixed-canvas-sizes',
    'Slides use different canvas sizes.'));
}

for (const canvas of Array.from(doc.querySelectorAll('canvas'))) {
  const owner = slideFor(canvas, slides);
  warnings.push(diagnostic('warning', 'canvas-content',
    'A <canvas> element cannot be edited visually.',
    owner?.id, elementLocation(owner, canvas)));
}

for (const group of Array.from(doc.querySelectorAll('[data-ppt-group]'))) {
  let parent = group.parentElement;
  while (parent) {
    if (parent.hasAttribute('data-ppt-group')) {
      const owner = slideFor(group, slides);
      warnings.push(diagnostic('warning', 'unsupported-group-nesting',
        'Nested data-ppt-group wrappers are not supported.',
        owner?.id, elementLocation(owner, group)));
      break;
    }
    parent = parent.parentElement;
  }
}
```

The `<style>` location must be exactly `style` so the test above matches.

- [ ] **Step 4: Run GREEN and the full core suite**

Run: `npm run test -w @htmlppt/core`
Expected: all pass. Adjust the pre-existing zero-warning test to include a runtime script before expecting `warnings` to be empty.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/validate.ts packages/core/test/validate.test.ts
git commit -m "feat(core): add contract warning rules"
```

---

### Task 3: Id factory and normalization

**Files:**
- Create: `packages/core/src/ids.ts`
- Create: `packages/core/src/normalize.ts`
- Modify: `packages/core/src/detect.ts` (export `readCanvasSize` from Task 1 is enough)
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/normalize.test.ts`

**Interfaces:**
- Produces: `IdFactory { slideId(existing: ReadonlySet<string>): string; elementId(existing: ReadonlySet<string>, slideIndex: number): string }`; `defaultIdFactory`; `normalizeDeck(doc: Document, options?: NormalizeOptions): NormalizeResult`; `NormalizeOptions { ids?: IdFactory; isStaticPosition?: (element: Element) => boolean }`; `NormalizeResult { changed: boolean; slides: { id: string; elementIds: string[] }[] }`.
- Consumes: `detectSlides`.

- [ ] **Step 1: Write failing normalization tests**

`packages/core/test/normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeDeck } from '../src/normalize.js';
import { parseDeckHtml } from '../src/node.js';
import { serializeDeck } from '../src/serialize.js';

const deck = (body: string) =>
  parseDeckHtml(
    `<!doctype html><html><head><title>Deck</title><style>.slide{color:red}</style></head><body>${body}</body></html>`
  );

describe('normalizeDeck', () => {
  it('assigns missing slide ids in order', () => {
    const doc = deck(
      '<section class="slide"></section><section class="slide"></section><section class="slide"></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.changed).toBe(true);
    expect(
      Array.from(doc.querySelectorAll('[data-slide-id]')).map((slide) =>
        slide.getAttribute('data-slide-id')
      )
    ).toEqual(['s1', 's2', 's3']);
  });

  it('follows detection precedence for partially annotated decks', () => {
    // Detection lets [data-slide-id] shadow classed siblings. Normalization
    // must not silently promote those siblings into slides.
    const doc = deck(
      '<section class="slide" data-slide-id="s2"></section><section class="slide">Ignored by detection</section>'
    );

    const result = normalizeDeck(doc);

    expect(result.slides.map((slide) => slide.id)).toEqual(['s2']);
    expect(doc.querySelectorAll('[data-slide-id]')).toHaveLength(1);
    expect(doc.querySelectorAll('.slide')[1].hasAttribute('data-ppt-el')).toBe(false);
  });

  it('avoids collisions with existing ids', () => {
    const doc = deck(
      '<section class="slide"><h1 data-ppt-el="e3">A</h1><p>B</p></section><section class="slide"><h2>C</h2></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.slides[0].elementIds).toEqual(['e3', 'e1']);
    expect(result.slides[1].elementIds).toEqual(['e1']);
  });

  it('assigns top-level object ids per slide and skips notes and scripts', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"><h1 data-ppt-el="e2">A</h1><p>B</p><aside data-ppt-notes hidden>N</aside><script>x</script><style>.a{}</style><div data-ppt-group><span>C</span></div></section><section class="slide" data-slide-id="s2"><h1>A</h1><p>B</p></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.slides).toEqual([
      { id: 's1', elementIds: ['e2', 'e1', 'e3'] },
      { id: 's2', elementIds: ['e1', 'e2'] }
    ]);
    const group = doc.querySelector('[data-ppt-group]');
    expect(group?.getAttribute('data-ppt-el')).toBe('e3');
    expect(group?.querySelector('span')?.hasAttribute('data-ppt-el')).toBe(false);
    expect(doc.querySelector('aside')?.hasAttribute('data-ppt-el')).toBe(false);
    expect(doc.querySelector('script')?.hasAttribute('data-ppt-el')).toBe(false);
  });

  it('is idempotent and preserves unrelated markup', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"><h1>A</h1></section>'
    );
    normalizeDeck(doc);
    const once = serializeDeck(doc);
    const second = normalizeDeck(doc);

    expect(second.changed).toBe(false);
    expect(serializeDeck(doc)).toBe(once);
    expect(once).toContain('<style>.slide{color:red}</style>');
  });

  it('assigns element ids on the body fallback without adding a slide id', () => {
    const doc = deck('<h1>Body slide</h1><p>Text</p>');

    const result = normalizeDeck(doc);

    expect(result.slides).toEqual([{ id: 'body', elementIds: ['e1', 'e2'] }]);
    expect(doc.body.hasAttribute('data-slide-id')).toBe(false);
    expect(doc.querySelector('h1')?.getAttribute('data-ppt-el')).toBe('e1');
  });

  it('adds position relative only when the predicate says the slide is static', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"></section><section class="slide" data-slide-id="s2" style="position: absolute"></section>'
    );

    normalizeDeck(doc, { isStaticPosition: () => true });

    expect(doc.querySelector('[data-slide-id="s1"]')?.getAttribute('style')).toBe(
      'position: relative;'
    );
    expect(doc.querySelector('[data-slide-id="s2"]')?.getAttribute('style')).toBe(
      'position: absolute'
    );
  });

  it('does not touch positioning without the predicate', () => {
    const doc = deck('<section class="slide" data-slide-id="s1"></section>');

    normalizeDeck(doc);

    expect(doc.querySelector('.slide')?.hasAttribute('style')).toBe(false);
  });

  it('removes editor-only attributes and reports a change', () => {
    const doc = deck(
      '<section class="slide" data-slide-id="s1"><h1 data-ppt-editing="true" data-ppt-frame-slide="x">A</h1></section>'
    );

    const result = normalizeDeck(doc);

    expect(result.changed).toBe(true);
    const heading = doc.querySelector('h1');
    expect(heading?.hasAttribute('data-ppt-editing')).toBe(false);
    expect(heading?.hasAttribute('data-ppt-frame-slide')).toBe(false);
  });

  it('uses an injected id factory', () => {
    const doc = deck('<section class="slide"></section>');

    normalizeDeck(doc, {
      ids: {
        slideId: () => 'custom-slide',
        elementId: (_existing, index) => `custom-${index}`
      }
    });

    expect(doc.querySelector('.slide')?.getAttribute('data-slide-id')).toBe(
      'custom-slide'
    );
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -w @htmlppt/core -- normalize`
Expected: FAIL — `../src/normalize.js` cannot be resolved.

- [ ] **Step 3: Implement ids and normalization**

`packages/core/src/ids.ts`:

```ts
export interface IdFactory {
  slideId(existing: ReadonlySet<string>): string;
  elementId(existing: ReadonlySet<string>, slideIndex: number): string;
}

function smallestFree(prefix: string, existing: ReadonlySet<string>): string {
  let index = 1;
  while (existing.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

export const defaultIdFactory: IdFactory = {
  slideId: (existing) => smallestFree('s', existing),
  elementId: (existing) => smallestFree('e', existing)
};
```

`packages/core/src/normalize.ts`:

```ts
import { detectSlides, type SlideInfo } from './detect.js';
import { defaultIdFactory, type IdFactory } from './ids.js';

export interface NormalizeOptions {
  ids?: IdFactory;
  /** Injected by a browser host; core itself cannot compute styles. */
  isStaticPosition?: (element: Element) => boolean;
}

export interface NormalizedSlide {
  id: string;
  elementIds: string[];
}

export interface NormalizeResult {
  changed: boolean;
  slides: NormalizedSlide[];
}

const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);
const EDITOR_ATTRIBUTES = ['data-ppt-editing', 'data-ppt-frame-slide'];
const POSITION_PATTERN = /(?:^|;)\s*position\s*:/i;

function isObject(element: Element): boolean {
  return !NON_OBJECT_TAGS.has(element.tagName) &&
    !element.hasAttribute('data-ppt-notes');
}

function topLevelObjects(slide: Element): Element[] {
  return Array.from(slide.children).filter(isObject);
}

function objectId(element: Element): string | null {
  const value = element.getAttribute('data-ppt-el')?.trim();
  return value ? value : null;
}

function ensureRelativePosition(element: Element): boolean {
  const style = element.getAttribute('style');
  if (style && POSITION_PATTERN.test(style)) return false;
  const trimmed = style?.trim() ?? '';
  element.setAttribute(
    'style',
    trimmed ? `${trimmed.replace(/;?$/, ';')} position: relative;` : 'position: relative;'
  );
  return true;
}

export function normalizeDeck(
  doc: Document,
  options: NormalizeOptions = {}
): NormalizeResult {
  const ids = options.ids ?? defaultIdFactory;
  const slides = detectSlides(doc);
  const usedSlideIds = new Set(
    slides
      .map((slide) => slide.element.getAttribute('data-slide-id')?.trim())
      .filter((id): id is string => Boolean(id))
  );
  let changed = false;
  const normalized: NormalizedSlide[] = [];

  for (const slide of slides) {
    if (slide.element !== doc.body && !slide.hasId) {
      const id = ids.slideId(usedSlideIds);
      slide.element.setAttribute('data-slide-id', id);
      usedSlideIds.add(id);
      changed = true;
    }

    const usedElementIds = new Set(
      topLevelObjects(slide.element)
        .map(objectId)
        .filter((id): id is string => id !== null)
    );
    const elementIds: string[] = [];
    for (const element of topLevelObjects(slide.element)) {
      let id = objectId(element);
      if (!id) {
        id = ids.elementId(usedElementIds, slide.index);
        element.setAttribute('data-ppt-el', id);
        usedElementIds.add(id);
        changed = true;
      }
      elementIds.push(id);
    }

    if (
      slide.element !== doc.body &&
      options.isStaticPosition?.(slide.element)
    ) {
      changed = ensureRelativePosition(slide.element) || changed;
    }

    normalized.push({ id: slide.element.getAttribute('data-slide-id')?.trim() || 'body', elementIds });
  }

  for (const attribute of EDITOR_ATTRIBUTES) {
    for (const element of Array.from(doc.querySelectorAll(`[${attribute}]`))) {
      element.removeAttribute(attribute);
      changed = true;
    }
  }

  return { changed, slides: normalized };
}
```

Note: return the id actually present after assignment. For body fallback, `slide.hasId` is false and `slide.element === doc.body`, so no slide id is added and the normalized id is `'body'`.

Export from `index.ts`:

```ts
export { normalizeDeck } from './normalize.js';
export type { NormalizeOptions, NormalizeResult, NormalizedSlide } from './normalize.js';
export { defaultIdFactory } from './ids.js';
export type { IdFactory } from './ids.js';
```

- [ ] **Step 4: Run GREEN and the full core suite**

Run: `npm run test -w @htmlppt/core`
Expected: all pass, including existing detect/serialize tests unaffected by normalization.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/normalize.test.ts
git commit -m "feat(core): add deterministic ids and normalization"
```

---

### Task 4: Outline and slide read model

**Files:**
- Create: `packages/core/src/outline.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/outline.test.ts`

**Interfaces:**
- Produces: `getOutline(doc): DeckOutline`; `readSlide(doc, slideId): SlideReadModel`.
- `DeckOutline { title: string; width: number; height: number; slideCount: number; runtime: boolean; slides: OutlineSlide[] }`.
- `OutlineSlide { id: string; index: number; width: number; height: number; transition: string | null; notes: string | null; elements: OutlineElement[] }`.
- `OutlineElement { id: string | null; tag: string; path: number[]; text: string; classes: string[]; group: boolean }`.
- `SlideReadModel { id: string; index: number; html: string; notes: string | null; transition: string | null; width: number; height: number }`.

- [ ] **Step 1: Write failing outline tests**

`packages/core/test/outline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getOutline, readSlide } from '../src/outline.js';
import { parseDeckHtml } from '../src/node.js';

const source = `<!doctype html><html><head><title> Outline deck </title></head><body>
<section data-slide-id="s1" data-width="1280" data-height="720" data-ppt-transition="fade">
  <h1 data-ppt-el="e1" class="title big">Hello
    world</h1>
  <aside data-ppt-notes hidden>Speaker note</aside>
  <div data-ppt-group data-ppt-el="e2"><span>Grouped</span></div>
</section>
<section data-slide-id="s2" data-width="1280" data-height="720"><p>Second</p></section>
<script data-ppt-runtime="1"></script>
</body></html>`;

describe('getOutline', () => {
  it('reports deck and slide metadata in document order', () => {
    const outline = getOutline(parseDeckHtml(source));

    expect(outline).toMatchObject({
      title: 'Outline deck',
      width: 1280,
      height: 720,
      slideCount: 2,
      runtime: true
    });
    expect(outline.slides[0]).toMatchObject({
      id: 's1',
      index: 0,
      transition: 'fade',
      notes: 'Speaker note'
    });
    expect(outline.slides[0].elements).toEqual([
      {
        id: 'e1',
        tag: 'h1',
        path: [0],
        text: 'Hello world',
        classes: ['title', 'big'],
        group: false
      },
      {
        id: 'e2',
        tag: 'div',
        path: [2],
        text: 'Grouped',
        classes: [],
        group: true
      }
    ]);
    expect(outline.slides[1].elements[0]).toMatchObject({
      id: null,
      tag: 'p',
      path: [0],
      text: 'Second'
    });
  });

  it('truncates long text summaries to 120 characters', () => {
    const doc = parseDeckHtml(
      `<!doctype html><html><head><title>T</title></head><body><section data-slide-id="s1"><p>${'x'.repeat(200)}</p></section></body></html>`
    );
    const text = getOutline(doc).slides[0].elements[0].text;
    expect(text).toHaveLength(120);
    expect(text.endsWith('...')).toBe(true);
  });

  it('describes the body fallback', () => {
    const doc = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><h1>Body</h1></body></html>'
    );
    const outline = getOutline(doc);
    expect(outline.slides).toHaveLength(1);
    expect(outline.slides[0].id).toBe('body');
    expect(outline.slides[0].elements[0].tag).toBe('h1');
  });
});

describe('readSlide', () => {
  it('returns the slide html, notes, transition, and canvas', () => {
    const slide = readSlide(parseDeckHtml(source), 's1');

    expect(slide).toMatchObject({
      id: 's1',
      index: 0,
      notes: 'Speaker note',
      transition: 'fade',
      width: 1280,
      height: 720
    });
    expect(slide.html).toContain('data-slide-id="s1"');
    expect(slide.html).toContain('data-ppt-notes');
  });

  it('throws for an unknown slide', () => {
    expect(() => readSlide(parseDeckHtml(source), 'missing')).toThrow(
      'Slide "missing" was not found.'
    );
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -w @htmlppt/core -- outline`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the read models**

`packages/core/src/outline.ts`:

```ts
import { detectSlides, type SlideInfo } from './detect.js';

export interface OutlineElement {
  id: string | null;
  tag: string;
  path: number[];
  text: string;
  classes: string[];
  group: boolean;
}

export interface OutlineSlide {
  id: string;
  index: number;
  width: number;
  height: number;
  transition: string | null;
  notes: string | null;
  elements: OutlineElement[];
}

export interface DeckOutline {
  title: string;
  width: number;
  height: number;
  slideCount: number;
  runtime: boolean;
  slides: OutlineSlide[];
}

export interface SlideReadModel {
  id: string;
  index: number;
  html: string;
  notes: string | null;
  transition: string | null;
  width: number;
  height: number;
}

const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

function summarize(element: Element): string {
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function pathOf(slide: Element, element: Element): number[] {
  const path: number[] = [];
  let current: Element | null = element;
  while (current && current !== slide) {
    const parent: Element | null = current.parentElement;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return current === slide ? path : [];
}

function notesOf(slide: Element): string | null {
  for (const child of Array.from(slide.children)) {
    if (child.hasAttribute('data-ppt-notes')) {
      return (child.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function elementsOf(slide: SlideInfo): OutlineElement[] {
  return Array.from(slide.element.children)
    .filter((element) => !NON_OBJECT_TAGS.has(element.tagName) &&
      !element.hasAttribute('data-ppt-notes'))
    .map((element) => ({
      id: element.getAttribute('data-ppt-el')?.trim() || null,
      tag: element.tagName.toLowerCase(),
      path: pathOf(slide.element, element),
      text: summarize(element),
      classes: Array.from(element.classList),
      group: element.hasAttribute('data-ppt-group')
    }));
}

export function getOutline(doc: Document): DeckOutline {
  const slides = detectSlides(doc);
  const first = slides[0];
  return {
    title: doc.title.trim(),
    width: first?.width ?? 1600,
    height: first?.height ?? 900,
    slideCount: slides.length,
    runtime: doc.querySelector('script[data-ppt-runtime="1"]') !== null,
    slides: slides.map((slide) => ({
      id: slide.id,
      index: slide.index,
      width: slide.width,
      height: slide.height,
      transition: slide.element.getAttribute('data-ppt-transition'),
      notes: notesOf(slide.element),
      elements: elementsOf(slide)
    }))
  };
}

export function readSlide(doc: Document, slideId: string): SlideReadModel {
  const slide = detectSlides(doc).find((candidate) => candidate.id === slideId);
  if (!slide) throw new Error(`Slide "${slideId}" was not found.`);
  return {
    id: slide.id,
    index: slide.index,
    html: slide.element.outerHTML,
    notes: notesOf(slide.element),
    transition: slide.element.getAttribute('data-ppt-transition'),
    width: slide.width,
    height: slide.height
  };
}
```

Export both and their types from `index.ts`.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/core`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/outline.test.ts
git commit -m "feat(core): add outline and slide read models"
```

---

### Task 5: Target resolution, element mutations, mutation gate

**Files:**
- Create: `packages/core/src/target.ts`
- Create: `packages/core/src/mutations.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/mutations.test.ts`

**Interfaces:**
- Produces: `ElementTarget = { elementId: string } | { selector: string } | { path: number[] }`; `resolveTarget(slide: Element, target: ElementTarget): Element`; `DeckMutationError`; `mutateDeck`; element operations `setText`, `setStyle`, `setElementHtml`, `addElement`, `removeElement`.
- Consumes: `detectSlides`, `normalizeDeck`, `validateDeck`.

- [ ] **Step 1: Write failing tests**

`packages/core/test/mutations.test.ts` (element half):

```ts
import { describe, expect, it } from 'vitest';
import {
  DeckMutationError,
  addElement,
  mutateDeck,
  removeElement,
  resolveTarget,
  setElementHtml,
  setStyle,
  setText
} from '../src/mutations.js';
import { parseDeckHtml } from '../src/node.js';

const source = `<!doctype html><html><head><title>Deck</title></head><body><section data-slide-id="s1"><h1 data-ppt-el="e1" class="title">Hello</h1><p data-ppt-el="e2">Body</p></section><section data-slide-id="s2"><h2>Other</h2></section></body></html>`;

const slide = (doc: Document, id = 's1') =>
  doc.querySelector(`[data-slide-id="${id}"]`) as Element;

describe('resolveTarget', () => {
  it('resolves by element id, selector, and path', () => {
    const doc = parseDeckHtml(source);
    const root = slide(doc);
    expect(resolveTarget(root, { elementId: 'e2' }).getAttribute('data-ppt-el')).toBe('e2');
    expect(resolveTarget(root, { selector: 'h1.title' }).tagName).toBe('H1');
    expect(resolveTarget(root, { path: [1] }).getAttribute('data-ppt-el')).toBe('e2');
  });

  it('rejects missing, ambiguous, and invalid targets', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => resolveTarget(root, { elementId: 'nope' })).toThrow(
      expect.objectContaining({ code: 'target-not-found' })
    );
    expect(() => resolveTarget(root, { selector: 'p, h1' })).toThrow(
      expect.objectContaining({ code: 'target-ambiguous' })
    );
    expect(() => resolveTarget(root, { selector: '<<<' })).toThrow(
      expect.objectContaining({ code: 'target-invalid' })
    );
    expect(() => resolveTarget(root, { path: [9] })).toThrow(
      expect.objectContaining({ code: 'target-not-found' })
    );
  });
});

describe('element mutations', () => {
  it('sets text as text, not markup', () => {
    const doc = parseDeckHtml(source);
    const target = resolveTarget(slide(doc), { elementId: 'e1' });
    setText(target, '<b>Escaped</b>');
    expect(target.textContent).toBe('<b>Escaped</b>');
    expect(target.querySelector('b')).toBeNull();
  });

  it('applies and removes inline styles with validation', () => {
    const doc = parseDeckHtml(source);
    const target = resolveTarget(slide(doc), { elementId: 'e1' }) as HTMLElement;
    setStyle(target, { color: 'red', 'font-size': '48px' });
    expect(target.style.color).toBe('red');
    expect(target.style.fontSize).toBe('48px');
    setStyle(target, { color: null });
    expect(target.style.color).toBe('');
    expect(() => setStyle(target, { 'bad property': 'x' })).toThrow(
      expect.objectContaining({ code: 'invalid-style-property' })
    );
  });

  it('replaces element html and adds/removes top-level elements', () => {
    const doc = parseDeckHtml(source);
    const root = slide(doc);
    setElementHtml(resolveTarget(root, { elementId: 'e1' }), '<em>New</em>');
    expect(root.querySelector('h1 em')?.textContent).toBe('New');

    addElement(root, '<div class="badge">New</div>', { elementId: 'e2' });
    const added = resolveTarget(root, { selector: 'div.badge' });
    expect(added.getAttribute('data-ppt-el')).not.toBeNull();

    removeElement(added);
    expect(root.querySelector('div.badge')).toBeNull();
  });

  it('rejects fragments with zero or multiple roots', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => addElement(root, '<b>one</b><b>two</b>')).toThrow(
      expect.objectContaining({ code: 'invalid-fragment' })
    );
    expect(() => addElement(root, 'text only')).toThrow(
      expect.objectContaining({ code: 'invalid-fragment' })
    );
  });

  it('does not remove the slide itself', () => {
    const root = slide(parseDeckHtml(source));
    expect(() => removeElement(root)).toThrow(
      expect.objectContaining({ code: 'cannot-remove-slide' })
    );
  });
});

describe('mutateDeck', () => {
  it('clones, normalizes, and returns a new valid document', () => {
    const before = parseDeckHtml(source);
    const beforeHtml = before.documentElement.outerHTML;

    const { document, result } = mutateDeck(before, (draft) => {
      const root = slide(draft);
      return addElement(root, '<section class="note"><span>Added</span></section>');
    });

    expect(before.documentElement.outerHTML).toBe(beforeHtml);
    expect(result.getAttribute('data-ppt-el')).toBe('e3');
    expect(document.querySelectorAll('[data-ppt-el]')).toHaveLength(3);
    expect(document.querySelector('section.note')).not.toBeNull();
  });

  it('rejects a mutation that produces an invalid deck', () => {
    const doc = parseDeckHtml(source);
    expect(() =>
      mutateDeck(doc, (draft) => {
        setElementHtml(
          resolveTarget(slide(draft), { elementId: 'e1' }),
          '<figure data-ppt-chart="{bad}"></figure>'
        );
      })
    ).toThrow(DeckMutationError);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -w @htmlppt/core -- mutations`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement target resolution and element operations**

`packages/core/src/target.ts`:

```ts
export type ElementTarget =
  | { elementId: string }
  | { selector: string }
  | { path: number[] };

export class DeckMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'DeckMutationError';
  }
}

function fail(code: string, message: string): never {
  throw new DeckMutationError(code, message);
}

export function resolveTarget(slide: Element, target: ElementTarget): Element {
  if ('elementId' in target) {
    const id = target.elementId.trim();
    const matches = Array.from(slide.querySelectorAll('[data-ppt-el]')).filter(
      (element) => element.getAttribute('data-ppt-el')?.trim() === id
    );
    if (matches.length === 0) fail('target-not-found', `Element "${id}" was not found.`);
    if (matches.length > 1) fail('target-ambiguous', `Element "${id}" matches more than one node.`);
    return matches[0];
  }

  if ('selector' in target) {
    let matches: Element[];
    try {
      matches = Array.from(slide.querySelectorAll(target.selector));
    } catch {
      fail('target-invalid', `Selector "${target.selector}" is not valid.`);
    }
    if (matches.length === 0) {
      fail('target-not-found', `Selector "${target.selector}" matched nothing.`);
    }
    if (matches.length > 1) {
      fail('target-ambiguous', `Selector "${target.selector}" matched ${matches.length} nodes.`);
    }
    return matches[0];
  }

  if (target.path.length === 0) fail('target-invalid', 'Target path must not be empty.');
  let current: Element = slide;
  for (const index of target.path) {
    if (!Number.isInteger(index) || index < 0) {
      fail('target-invalid', 'Target path must contain non-negative integers.');
    }
    const child = current.children[index];
    if (!child) fail('target-not-found', 'Target path does not resolve inside the slide.');
    current = child;
  }
  return current;
}
```

`packages/core/src/mutations.ts` element half:

```ts
import { detectSlides, type SlideInfo } from './detect.js';
import { defaultIdFactory } from './ids.js';
import { normalizeDeck } from './normalize.js';
import { DeckMutationError, resolveTarget, type ElementTarget } from './target.js';
import type { Diagnostic } from './types.js';
import { validateDeck } from './validate.js';

export { DeckMutationError, resolveTarget };
export type { ElementTarget };

const STYLE_PROPERTY = /^-?[a-zA-Z][a-zA-Z0-9-]*$/;
const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

function fail(code: string, message: string): never {
  throw new DeckMutationError(code, message);
}

function assignElementId(slide: Element, element: Element): void {
  if (element.getAttribute('data-ppt-el')?.trim()) return;
  const used = new Set(
    Array.from(slide.children)
      .map((child) => child.getAttribute('data-ppt-el')?.trim())
      .filter((id): id is string => Boolean(id))
  );
  element.setAttribute('data-ppt-el', defaultIdFactory.elementId(used, 0));
}

export function setText(target: Element, text: string): void {
  target.textContent = text;
}

export function setStyle(
  target: Element,
  styles: Record<string, string | null>
): void {
  const htmlTarget = target as HTMLElement;
  for (const [property, value] of Object.entries(styles)) {
    if (!STYLE_PROPERTY.test(property)) {
      fail('invalid-style-property', `"${property}" is not a valid CSS property name.`);
    }
    if (value === null || value === '') htmlTarget.style.removeProperty(property);
    else htmlTarget.style.setProperty(property, value);
  }
  if (htmlTarget.getAttribute('style')?.trim() === '') {
    htmlTarget.removeAttribute('style');
  }
}

export function setElementHtml(target: Element, html: string): void {
  target.innerHTML = html;
}

export function addElement(
  slide: Element,
  html: string,
  after?: ElementTarget
): Element {
  const container = slide.ownerDocument.createElement('div');
  container.innerHTML = html;
  if (container.children.length !== 1) {
    fail('invalid-fragment', 'Element HTML must contain exactly one root element.');
  }
  const element = container.firstElementChild as Element;
  container.removeChild(element);
  const reference = after ? resolveTarget(slide, after) : null;
  if (reference === null) {
    slide.appendChild(element);
  } else {
    if (reference === slide) fail('target-invalid', 'Cannot insert after the slide itself.');
    slide.insertBefore(element, reference.nextElementSibling);
  }
  if (!NON_OBJECT_TAGS.has(element.tagName)) assignElementId(slide, element);
  return element;
}

export function removeElement(target: Element): void {
  if (
    target === target.ownerDocument.body ||
    target.hasAttribute('data-slide-id')
  ) {
    fail('cannot-remove-slide', 'The slide itself cannot be removed.');
  }
  const parent = target.parentElement;
  if (!parent) fail('cannot-remove-slide', 'The slide itself cannot be removed.');
  parent.removeChild(target);
}

export function mutateDeck<T>(
  source: Document,
  mutation: (draft: Document) => T
): { document: Document; result: T } {
  const document = source.cloneNode(true) as Document;
  const result = mutation(document);
  normalizeDeck(document);
  const validation = validateDeck(document);
  if (!validation.valid) {
    throw new DeckMutationError(
      'invalid-result',
      `The mutation produced an invalid deck: ${validation.errors
        .map((error: Diagnostic) => error.code)
        .join(', ')}`,
      validation.errors
    );
  }
  return { document, result };
}

export function findSlide(doc: Document, slideId: string): SlideInfo {
  const slides = detectSlides(doc);
  const slide = slides.find((candidate) => candidate.id === slideId && candidate.hasId) ??
    (slideId === 'body' ? slides.find((candidate) => candidate.element === doc.body) : undefined);
  if (!slide) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  return slide;
}
```

Problem: `removeElement(root)` where root has parent body would remove the slide, not throw `cannot-remove-slide`. The test expects throwing. Need a guard: `if (target.hasAttribute('data-slide-id')) fail('cannot-remove-slide', ...)` — but a nested element could have data-slide-id (invalid structure). Better `if (target === target.ownerDocument.body || target === findSlide(...).element)` impossible without doc id. Use `if (target.hasAttribute('data-slide-id'))` plus body check. Slides are identified by data-slide-id or class, but section slide without id could be removed. Ruling: guard any target that is a detected slide root:

```ts
export function removeElement(target: Element): void {
  if (target === target.ownerDocument.body) fail(...);
  if (target.hasAttribute('data-slide-id') || target.hasAttribute('data-ppt-deck')) fail(...);
  ...
}
```
A class-only slide (`<section class="slide">`) could still be removed; add `target.classList.contains('slide')`? That could be a nested object with class slide. Use detection on a cloned doc? Overkill. `removeElement` is called with targets from resolveTarget; callers should not target slides. Add `data-slide-id` guard + body. Test uses data-slide-id. Plan note: nested class-only slides are not guarded; mutations operate on normalized docs with ids by then, so slide roots have data-slide-id. Good: `mutateDeck` normalizes before? It normalizes after mutation. For callers using individual ops on a raw doc, requirement is normalized master doc. Document this: mutation functions expect a normalized document; mutateDeck normalizes the result. Hmm, `addElement` assigns ids via mutateDeck normalization. Tests call ops directly on raw doc; fine.

The test `addElement(root, ...)` then `resolveTarget(root, {selector:'div.badge'})` expects data-ppt-el assigned, but direct `addElement` doesn't normalize. In the test above, the added element won't have data-ppt-el unless addElement assigns it. Modify addElement to assign a temporary id? Better: addElement itself sets an id using an existing per-slide counter. Or test should wrap in mutateDeck for id. The test currently expects `not.toBeNull()` after direct add. To keep simple, `addElement` can assign an id via a helper in mutations: compute existing top-level ids and smallest free, set. Similarly `addSlide` sets slide id. This duplicates normalization logic slightly. Alternative adjust test: `expect(added.hasAttribute('data-ppt-el')).toBe(false);` then mutateDeck test covers id assignment. But user-facing add_element result expects an id. Better addElement assigns id immediately. Implement `nextElementId(slide)` using existing `[data-ppt-el]` top-level set and defaultIdFactory. Since addElement doesn't accept ids, use defaultIdFactory. For custom factories, only addSlide/duplicate accept options. Fine.

```ts
import { defaultIdFactory } from './ids.js';
function assignElementId(slide: Element, element: Element): void {
  if (element.getAttribute('data-ppt-el')?.trim()) return;
  const used = new Set(
    Array.from(slide.children)
      .map((child) => child.getAttribute('data-ppt-el')?.trim())
      .filter((id): id is string => Boolean(id))
  );
  element.setAttribute('data-ppt-el', defaultIdFactory.elementId(used, 0));
}
```
But if the added HTML already has data-ppt-el duplicate, normalization/validation catches. Call assign only when missing.

Target: `setElementHtml` replacing with chart bad then mutateDeck validates. Good.

mutateDeck normalize assigns slide ids for raw docs; for addElement test direct root normalized? The source slide has id already.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/core -- mutations`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/mutations.test.ts
git commit -m "feat(core): add target resolution and element mutations"
```

---

### Task 6: Slide mutations

**Files:**
- Modify: `packages/core/src/mutations.ts`
- Modify: `packages/core/test/mutations.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `Transition = 'none' | 'fade' | 'slide'`; `addSlide(doc, options?): string`; `duplicateSlide(doc, slideId): string`; `deleteSlide(doc, slideId): void`; `moveSlide(doc, slideId, toIndex): void`; `setSlideOrder(doc, slideIds): void`; `updateSlideHtml(doc, slideId, html): void`; `setNotes(doc, slideId, notes): void`; `setTransition(doc, slideId, transition): void`.
- `AddSlideOptions { html?: string; afterSlideId?: string; notes?: string; transition?: Transition; width?: number; height?: number; ids?: IdFactory }`.

- [ ] **Step 1: Write failing slide mutation tests**

Append to `mutations.test.ts`:

```ts
import {
  addSlide,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  setNotes,
  setSlideOrder,
  setTransition,
  updateSlideHtml
} from '../src/mutations.js';

describe('slide mutations', () => {
  const ids = (doc: Document) =>
    Array.from(doc.querySelectorAll('[data-slide-id]')).map((slide) =>
      slide.getAttribute('data-slide-id')
    );

  it('adds a slide after a slide id with canvas and metadata', () => {
    const doc = parseDeckHtml(source);
    const id = addSlide(doc, {
      html: '<h1>Inserted</h1>',
      afterSlideId: 's1',
      notes: 'Talk track',
      transition: 'slide'
    });

    expect(id).toBe('s3');
    expect(ids(doc)).toEqual(['s1', 's3', 's2']);
    const added = doc.querySelector(`[data-slide-id="${id}"]`) as Element;
    expect(added.getAttribute('data-width')).toBeNull();
    expect(added.querySelector('h1')?.getAttribute('data-ppt-el')).toBe('e1');
    expect(added.querySelector('aside[data-ppt-notes]')?.textContent).toBe('Talk track');
    expect(added.getAttribute('data-ppt-transition')).toBe('slide');
  });

  it('duplicates a slide with a new id and deep content', () => {
    const doc = parseDeckHtml(source);
    const id = duplicateSlide(doc, 's1');
    expect(id).toBe('s3');
    expect(ids(doc)).toEqual(['s1', 's3', 's2']);
    expect(doc.querySelector(`[data-slide-id="${id}"] h1`)?.textContent).toBe('Hello');
  });

  it('refuses to delete the last slide and slide operations on the body fallback', () => {
    const single = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><section data-slide-id="s1"></section></body></html>'
    );
    expect(() => deleteSlide(single, 's1')).toThrow(
      expect.objectContaining({ code: 'last-slide' })
    );

    const body = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><h1>Body</h1></body></html>'
    );
    expect(() => addSlide(body)).toThrow(
      expect.objectContaining({ code: 'slide-operations-unavailable' })
    );
  });

  it('deletes and moves slides', () => {
    const doc = parseDeckHtml(source);
    deleteSlide(doc, 's1');
    expect(ids(doc)).toEqual(['s2']);

    const three = parseDeckHtml(source);
    addSlide(three, { html: '<h1>Third</h1>' });
    moveSlide(three, 's3', 0);
    expect(ids(three)).toEqual(['s3', 's1', 's2']);
    expect(() => moveSlide(three, 's1', 9)).toThrow(
      expect.objectContaining({ code: 'index-out-of-range' })
    );
  });

  it('sets a full slide order and rejects partial permutations', () => {
    const doc = parseDeckHtml(source);
    setSlideOrder(doc, ['s2', 's1']);
    expect(ids(doc)).toEqual(['s2', 's1']);
    expect(() => setSlideOrder(doc, ['s1'])).toThrow(
      expect.objectContaining({ code: 'invalid-order' })
    );
    expect(() => setSlideOrder(doc, ['s1', 's1'])).toThrow(
      expect.objectContaining({ code: 'invalid-order' })
    );
  });

  it('replaces slide html while preserving slide attributes', () => {
    const doc = parseDeckHtml(source);
    updateSlideHtml(doc, 's2', '<h2>Replaced</h2><p>Text</p>');
    const updated = doc.querySelector('[data-slide-id="s2"]') as Element;
    expect(updated.getAttribute('data-slide-id')).toBe('s2');
    expect(updated.querySelector('h2')?.textContent).toBe('Replaced');
    expect(updated.querySelectorAll('[data-ppt-el]')).toHaveLength(0);
  });

  it('sets, updates, and removes notes as a direct child', () => {
    const doc = parseDeckHtml(source);
    setNotes(doc, 's2', 'First note');
    expect(doc.querySelector('[data-slide-id="s2"] > aside[data-ppt-notes]')?.textContent).toBe(
      'First note'
    );
    setNotes(doc, 's2', 'Updated');
    expect(doc.querySelectorAll('[data-slide-id="s2"] > aside[data-ppt-notes]')).toHaveLength(1);
    setNotes(doc, 's2', '');
    expect(doc.querySelector('[data-slide-id="s2"] aside[data-ppt-notes]')).toBeNull();
  });

  it('validates transitions before setting them', () => {
    const doc = parseDeckHtml(source);
    setTransition(doc, 's1', 'fade');
    expect(doc.querySelector('[data-slide-id="s1"]')?.getAttribute('data-ppt-transition')).toBe(
      'fade'
    );
    expect(() => setTransition(doc, 's1', 'zoom' as never)).toThrow(
      expect.objectContaining({ code: 'invalid-transition' })
    );
  });

  it('returns an invalid-result error through the gate', () => {
    const doc = parseDeckHtml(source);
    expect(() =>
      mutateDeck(doc, (draft) => {
        setTransition(draft, 's1', 'zoom' as never);
      })
    ).toThrow(DeckMutationError);
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -w @htmlppt/core -- mutations`
Expected: FAIL — slide operations are not exported.

- [ ] **Step 3: Implement slide mutations**

Add to `mutations.ts`:

```ts
import type { IdFactory } from './ids.js';
import { defaultIdFactory } from './ids.js';

export type Transition = 'none' | 'fade' | 'slide';
const TRANSITIONS = new Set<string>(['none', 'fade', 'slide']);

function explicitSlides(doc: Document): SlideInfo[] {
  const slides = detectSlides(doc);
  if (slides.length === 1 && slides[0].element === doc.body) {
    fail('slide-operations-unavailable', 'Slide operations are unavailable on the body fallback.');
  }
  return slides;
}

export interface AddSlideOptions {
  html?: string;
  afterSlideId?: string;
  notes?: string;
  transition?: Transition;
  width?: number;
  height?: number;
  ids?: IdFactory;
}

function appendNotes(slide: Element, notes: string, doc: Document): void {
  const aside = doc.createElement('aside');
  aside.setAttribute('data-ppt-notes', '');
  aside.setAttribute('hidden', '');
  aside.textContent = notes;
  slide.appendChild(aside);
}

export function addSlide(doc: Document, options: AddSlideOptions = {}): string {
  const slides = explicitSlides(doc);
  const ids = options.ids ?? defaultIdFactory;
  const existing = new Set(
    slides.map((slide) => slide.element.getAttribute('data-slide-id')?.trim())
      .filter((id): id is string => Boolean(id))
  );
  const id = ids.slideId(existing);
  const first = slides[0];
  const section = doc.createElement('section');
  section.setAttribute('class', 'slide');
  section.setAttribute('data-slide-id', id);
  if (options.width !== undefined || options.height !== undefined) {
    section.setAttribute('data-width', String(options.width ?? first.width));
    section.setAttribute('data-height', String(options.height ?? first.height));
  }
  if (options.transition) section.setAttribute('data-ppt-transition', options.transition);
  section.innerHTML = options.html ?? '<h1>New slide</h1>';
  for (const child of Array.from(section.children)) {
    if (!child.hasAttribute('data-ppt-notes') && !NON_OBJECT_TAGS.has(child.tagName)) {
      assignElementId(section, child);
    }
  }
  if (options.notes !== undefined && options.notes !== '') {
    appendNotes(section, options.notes, doc);
  }

  const reference = options.afterSlideId
    ? slides.find((slide) => slide.id === options.afterSlideId)?.element
    : slides[slides.length - 1].element;
  if (!reference) fail('slide-not-found', `Slide "${options.afterSlideId}" was not found.`);
  const parent = reference.parentElement;
  if (!parent) fail('slide-operations-unavailable', 'Slides must have a parent element.');
  parent.insertBefore(section, reference.nextElementSibling);
  return id;
}

export function duplicateSlide(doc: Document, slideId: string): string {
  const slides = explicitSlides(doc);
  const source = slides.find((slide) => slide.id === slideId);
  if (!source) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  const existing = new Set(slides.map((slide) => slide.id));
  const id = defaultIdFactory.slideId(existing);
  const clone = source.element.cloneNode(true) as Element;
  clone.setAttribute('data-slide-id', id);
  const parent = source.element.parentElement;
  if (!parent) fail('slide-operations-unavailable', 'Slides must have a parent element.');
  parent.insertBefore(clone, source.element.nextElementSibling);
  return id;
}

export function deleteSlide(doc: Document, slideId: string): void {
  const slides = explicitSlides(doc);
  if (slides.length === 1) fail('last-slide', 'The last slide cannot be deleted.');
  const slide = slides.find((candidate) => candidate.id === slideId);
  if (!slide) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  slide.element.parentElement?.removeChild(slide.element);
}

function reorder(doc: Document, ordered: Element[]): void {
  const current = explicitSlides(doc);
  const lastCurrent = current[current.length - 1].element;
  const parent = lastCurrent.parentElement;
  if (!parent) fail('slide-operations-unavailable', 'Slides must have a parent element.');
  // Anchor after every current slide, so no slide in `ordered` can move the
  // reference while the loop inserts.
  const anchor = lastCurrent.nextElementSibling;
  for (const element of ordered) {
    parent.insertBefore(element, anchor);
  }
}

export function moveSlide(doc: Document, slideId: string, toIndex: number): void {
  const slides = explicitSlides(doc);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= slides.length) {
    fail('index-out-of-range', `Index ${toIndex} is outside 0..${slides.length - 1}.`);
  }
  const source = slides.find((slide) => slide.id === slideId);
  if (!source) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  const ordered = slides.map((slide) => slide.element).filter((element) => element !== source.element);
  ordered.splice(toIndex, 0, source.element);
  reorder(doc, ordered);
}

export function setSlideOrder(doc: Document, slideIds: string[]): void {
  const slides = explicitSlides(doc);
  const current = slides.map((slide) => slide.id);
  if (
    slideIds.length !== current.length ||
    new Set(slideIds).size !== current.length ||
    slideIds.some((id) => !current.includes(id))
  ) {
    fail('invalid-order', 'The new order must list every slide id exactly once.');
  }
  reorder(
    doc,
    slideIds.map((id) => slides.find((slide) => slide.id === id)!.element)
  );
}

export function updateSlideHtml(doc: Document, slideId: string, html: string): void {
  const slides = detectSlides(doc);
  if (slides.length === 1 && slides[0].element === doc.body) {
    fail('slide-operations-unavailable', 'The body fallback slide cannot be replaced wholesale.');
  }
  const slide = slides.find((candidate) => candidate.id === slideId);
  if (!slide) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  slide.element.innerHTML = html;
}

export function setNotes(doc: Document, slideId: string, notes: string): void {
  const slide = findSlide(doc, slideId);
  let aside: Element | null = null;
  for (const child of Array.from(slide.element.children)) {
    if (child.hasAttribute('data-ppt-notes')) {
      aside = child;
      break;
    }
  }
  if (!notes) {
    if (aside) aside.parentElement?.removeChild(aside);
    return;
  }
  if (!aside) {
    aside = doc.createElement('aside');
    aside.setAttribute('data-ppt-notes', '');
    aside.setAttribute('hidden', '');
    slide.element.appendChild(aside);
  }
  aside.textContent = notes;
}

export function setTransition(doc: Document, slideId: string, transition: Transition): void {
  if (!TRANSITIONS.has(transition)) {
    fail('invalid-transition', `Transition "${transition}" is not one of none, fade, slide.`);
  }
  findSlide(doc, slideId).element.setAttribute('data-ppt-transition', transition);
}
```

Adjust the Task 5 test expectation for `addSlide` width: since options don't pass width/height, the new slide has no data-width. Detect falls back to CSS/default; validation allows missing. The test expects null. Good.

`addSlide` after `s1` in source: existing ids s1,s2; default factory returns s3. Insert after s1. `added.querySelector('h1')` gets e1 after normalization? Direct addSlide does not normalize inner content. addElement assigns id, but slide inner HTML isn't assigned element ids. The test expects e1. Add a helper call at end of addSlide: assign ids to top-level objects using defaultIdFactory:

```ts
for (const child of Array.from(section.children)) {
  if (!child.hasAttribute('data-ppt-el') && !child.hasAttribute('data-ppt-notes') && !['SCRIPT','STYLE','TEMPLATE'].includes(child.tagName)) {
    assignElementId(section, child);
  }
}
```
Use the same helper as addElement. Order after innerHTML and notes? Notes appended after h1. Assign before notes. Implement. `updateSlideHtml` test expects zero [data-ppt-el] after direct call (no normalization); consistent.

Duplicate keeps element ids; per-slide scope.

`reorder`: moving each element before the same anchor in sequence results in order [first,second,...] before anchor? Insert first before anchor, then second before anchor (after first), etc. Yes preserves order.

`moveSlide` when moving to same position still reorders; fine.

`findSlide` currently requires hasId; for body fallback, `slideId==='body'` returns body. setNotes on body works. Good. `findSlide` with class-only slide no id after normalization won't happen in gate.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/core`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/mutations.test.ts
git commit -m "feat(core): add validated slide mutations"
```

---

### Task 7: Runtime hardening and initial hidden state

**Files:**
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/core/src/template.ts`
- Modify: `packages/core/test/template.test.ts`
- Create: `e2e/runtime.spec.ts`
- Modify: `docs/features.json`

**Interfaces:**
- Template output: the deck root starts without `data-ppt-ready`; a screen-only rule hides every slide that follows another slide while the root is not ready. Print media never hides slides and only adds page breaks.
- Runtime: marks deck roots ready, hides inactive slides, restores each active slide's original inline display (never fabricates `block`), injects print page-break CSS once, restores display on `beforeprint`/`afterprint`, and ignores navigation keys in editable controls or with modifiers.

- [ ] **Step 1: Write failing template test**

Add to `packages/core/test/template.test.ts`:

```ts
it('hides every slide after the first until the runtime runs', () => {
  const html = createDeckHtml({ slides: 2 });

  expect(html).toContain(
    '@media screen {\n    [data-ppt-deck]:not([data-ppt-ready]) > [data-slide-id] ~ [data-slide-id] { display: none; }\n  }'
  );
  expect(html).toContain('@media print');
  expect(html).toContain('break-after: page');
  expect(html).not.toContain('display: block !important');
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `npm run test -w @htmlppt/core -- template`
Expected: FAIL — rules absent.

- [ ] **Step 3: Update the template**

In `createDeckHtml`'s `<style>`, after the `.slide` rule, add:

```css
  @media screen {
    [data-ppt-deck]:not([data-ppt-ready]) > [data-slide-id] ~ [data-slide-id] { display: none; }
  }
  @media print {
    [data-ppt-deck] > [data-slide-id] { break-after: page; }
  }
```

The screen rule is gated on the absence of `data-ppt-ready`, which the runtime sets before its first `show`. That keeps arbitrary stylesheet display values intact: the runtime only writes `display:none` to inactive slides and restores the active slide's original inline value, never `block`. The print rule does not touch `display`, so authored flex/grid survives printing. Keep the runtime script and the rest of the template unchanged.

- [ ] **Step 4: Run template GREEN**

Run: `npm run test -w @htmlppt/core -- template`
Expected: PASS.

- [ ] **Step 5: Write the failing runtime E2E**

`e2e/runtime.spec.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { execa } from 'execa';
import { serveHtml } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

test.describe('presentation runtime', () => {
  test('shows only the first slide without JavaScript', { tag: '@feature:runtime' }, async ({ browser }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const html = await readFile(join(directory, 'deck.html'), 'utf8');
      const server = await serveHtml(html);
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      try {
        await page.goto(server.url);
        await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      } finally {
        await context.close();
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('prints every slide while preserving stylesheet display', { tag: '@feature:runtime' }, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const file = join(directory, 'deck.html');
      const html = (await readFile(file, 'utf8')).replace(
        '.slide {',
        '.slide { display: flex;'
      );
      const server = await serveHtml(html);
      try {
        await page.goto(server.url);
        await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();

        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        expect(
          await page
            .locator('[data-slide-id="s2"]')
            .evaluate((element) => getComputedStyle(element).display)
        ).toBe('flex');

        await page.emulateMedia({ media: 'print' });
        await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
        await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        expect(
          await page
            .locator('[data-slide-id="s2"]')
            .evaluate((element) => getComputedStyle(element).display)
        ).toBe('flex');

        await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
        await page.emulateMedia({ media: 'screen' });
        await expect(page.locator('[data-slide-id="s1"]')).toBeHidden();
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('ignores navigation keys while typing', { tag: '@feature:runtime' }, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-runtime-'));
    try {
      await execa('node', [cliPath, 'new', 'deck.html', '--slides', '2'], { cwd: directory });
      const file = join(directory, 'deck.html');
      const html = await readFile(file, 'utf8');
      const withInput = html.replace('<h1', '<input id="probe" aria-label="Probe"><h1');
      expect(withInput).toContain('id="probe"');
      const server = await serveHtml(withInput);
      try {
        await page.goto(server.url);
        await page.locator('#probe').focus();
        await page.keyboard.press('ArrowRight');
        expect(page.url()).toContain('#/1');
        await page.locator('body').click({ position: { x: 10, y: 10 } });
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
        expect(page.url()).toContain('#/2');
      } finally {
        await server.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Run and confirm RED**

Run: `npx playwright test e2e/runtime.spec.ts --reporter=list`
Expected: at least "shows only the first slide without JavaScript" and "ignores navigation keys" fail before the runtime change; print may fail too. Record the output.

- [ ] **Step 7: Harden the runtime**

Replace `packages/runtime/src/index.ts` with:

```ts
export const RUNTIME_SOURCE = String.raw`
(() => {
  var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide-id]'));
  if (!slides.length) return;
  var index = 0;
  var runtimeStyle = 'data-ppt-runtime-style';
  var originalDisplay = slides.map(function (slide) { return slide.style.display; });

  Array.prototype.forEach.call(document.querySelectorAll('[data-ppt-deck]'), function (deck) {
    deck.setAttribute('data-ppt-ready', '1');
  });

  function isEditing(target) {
    var element = target;
    while (element) {
      var tag = element.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable) return true;
      if (element === document.body) return false;
      element = element.parentElement;
    }
    return false;
  }

  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach(function (slide, i) {
      slide.style.display = i === index ? originalDisplay[i] : 'none';
    });
    history.replaceState(null, '', '#/' + (index + 1));
  }

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditing(event.target)) return;
    if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown') {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      show(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      show(slides.length - 1);
    }
  });

  window.addEventListener('hashchange', function () {
    var match = /#\/(\d+)/.exec(location.hash);
    if (match) show(Number(match[1]) - 1);
  });

  if (!document.querySelector('[' + runtimeStyle + ']')) {
    var style = document.createElement('style');
    style.setAttribute(runtimeStyle, '1');
    style.textContent = '@media print{[data-slide-id]{break-after:page;page-break-after:always}}';
    document.head.appendChild(style);
  }

  var printState = null;
  window.addEventListener('beforeprint', function () {
    if (printState) return;
    printState = slides.map(function (slide) { return slide.style.display; });
    slides.forEach(function (slide) { slide.style.removeProperty('display'); });
  });
  window.addEventListener('afterprint', function () {
    if (!printState) return;
    slides.forEach(function (slide, i) { slide.style.display = printState[i]; });
    printState = null;
  });

  var initial = /#\/(\d+)/.exec(location.hash);
  show(initial ? Number(initial[1]) - 1 : 0);
})();
`;
```

The runtime marks deck roots ready, which disables the screen-only initial-hide rule while the first `show` hides inactive slides inline. The active slide gets its original inline `display` back (possibly empty), so stylesheet flex/grid is preserved. The injected print style only adds page breaks; `beforeprint` removes runtime-added inline display so every slide prints with its authored layout, and `afterprint` restores the screen state. Keys are ignored in editable controls (including a contenteditable body) and with any modifier.

- [ ] **Step 8: Activate the runtime feature**

In `docs/features.json`, add:

```json
{ "id": "runtime", "spec": "Runtime", "status": "active", "tests": ["@feature:runtime"] }
```

Run: `npm run test:matrix`
Expected: `Feature matrix OK: 2 active, 2 tagged test feature(s).`

- [ ] **Step 9: Run E2E and the editor regression**

Run:

```bash
npm run build
npx playwright test e2e/runtime.spec.ts e2e/skeleton.spec.ts --reporter=list
```

Expected: all pass, including the existing editor walkthrough (the editor preview of slide 2 must still be visible; the CSS rule targets non-first slides but the preview mounts only one slide, which is `:first-of-type`).

Add one assertion to the existing walking-skeleton test after clicking 下一頁 in the editor: `await expect(frame.locator('h1')).toBeVisible();` so a regression in preview visibility is caught.

- [ ] **Step 10: Commit**

```bash
git add packages/runtime packages/core/src/template.ts packages/core/test/template.test.ts e2e docs/features.json
git commit -m "feat(runtime): add initial hidden state, print CSS, and input guards"
```

---

### Task 8: Golden fixtures and M1 exit

**Files:**
- Create: `test-utils/fixtures/rich.deck.html`
- Create: `test-utils/fixtures/messy.deck.html`
- Create: `test-utils/fixtures/animated.deck.html`
- Create: `test-utils/fixtures/external.deck.html`
- Create: `test-utils/fixtures/malicious.deck.html`
- Create: `test-utils/fixtures/*.expected.json` and `messy.normalized.expected.html`
- Create: `packages/core/test/golden.test.ts`

**Interfaces:**
- Consumes all M1 APIs. Produces no new API.

- [ ] **Step 1: Create the fixtures**

`rich.deck.html` (full content):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Rich deck</title>
  <style>
    .slide { width: 1600px; height: 900px; position: relative; overflow: hidden; background: #fff; }
    .title { font: 700 84px/1.05 Inter, sans-serif; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1" data-width="1600" data-height="900" data-ppt-transition="fade">
      <h1 class="title" data-ppt-el="e1">Rich deck</h1>
      <img data-ppt-el="e2" alt="Pixel" src="data:image/png;base64,iVBORw0KGgo=">
      <div data-ppt-el="e3" style="position:absolute;left:100px;top:600px;width:240px;height:120px;background:#e8a33d"></div>
      <div data-ppt-group data-ppt-el="e4"><span>A</span><span>B</span></div>
      <aside data-ppt-notes hidden>Keep this short.</aside>
    </section>
    <section class="slide" data-slide-id="s2" data-width="1600" data-height="900">
      <table data-ppt-el="e1"><thead><tr><th>Q</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
      <figure data-ppt-el="e2" data-ppt-chart='{"type":"bar","labels":["Q1"],"series":[{"name":"USD","values":[12]}]}'>
        <svg viewBox="0 0 100 100"><rect width="10" height="10"></rect></svg>
      </figure>
    </section>
  </main>
  <script data-ppt-runtime="1">(() => {})();</script>
</body>
</html>
```

`messy.deck.html` (no slide ids, one slide with inline canvas, relative assets, scripts and a nested note):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Messy deck</title>
  <style>
    section { position: static; }
    .slide { width: 1280px; height: 720px; background: url(assets/bg.png); }
    .deck-script-marker { color: red; }
  </style>
</head>
<body>
  <div data-ppt-deck>
    <section class="slide" style="width: 1280px; height: 720px">
      <h1>Messy <em>deck</em></h1>
      <p style="position: fixed; top: 0">Fixed copy</p>
      <div><aside data-ppt-notes hidden>Nested note</aside></div>
      <img src="assets/photo.png" alt="Relative">
    </section>
    <section class="slide" data-width="1920" data-height="1080">
      <h2>Second</h2>
      <canvas width="100" height="100"></canvas>
      <div data-ppt-group><div data-ppt-group>Nested group</div></div>
    </section>
  </div>
  <script>window.messy = true;</script>
  <script type="application/json">{"ok":true}</script>
</body>
</html>
```

`animated.deck.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Animated deck</title>
  <style>
    .slide { width: 1600px; height: 900px; position: relative; overflow: hidden; }
    @keyframes rise { from { transform: translateY(40px); opacity: 0 } to { transform: none; opacity: 1 } }
    .rise { animation: rise 600ms ease-out both; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1" data-ppt-transition="slide"><h1 class="rise" data-ppt-el="e1">Animated</h1></section>
    <section class="slide" data-slide-id="s2"><p class="rise" data-ppt-el="e1">Second</p></section>
  </main>
  <script data-ppt-runtime="1">(() => {})();</script>
</body>
</html>
```

`external.deck.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>External deck</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
  <style>.slide { width: 1600px; height: 900px; position: relative; }</style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1"><img data-ppt-el="e1" src="https://example.com/hero.png" alt="Hero"></section>
    <section class="slide" data-slide-id="s2"><img data-ppt-el="e1" src="https://example.com/chart.png" alt="Chart"></section>
  </main>
  <script>document.addEventListener('keydown', () => {});</script>
</body>
</html>
```

`malicious.deck.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Malicious deck</title>
  <style>.slide { width: 1600px; height: 900px; position: relative; }</style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1">
      <h1 data-ppt-el="e1">Malicious</h1>
      <img data-ppt-el="e2" src="x.png" onerror="window.pwned = true">
      <script>window.pwned = true;</script>
    </section>
    <section class="slide" data-slide-id="s2"><p data-ppt-el="e1">Second</p></section>
  </main>
</body>
</html>
```

- [ ] **Step 2: Write semantic golden tests**

`packages/core/test/golden.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeDeck } from '../src/normalize.js';
import { parseDeckHtml } from '../src/node.js';
import { getOutline } from '../src/outline.js';
import { serializeDeck } from '../src/serialize.js';
import { validateDeck } from '../src/validate.js';

const fixtures = fileURLToPath(new URL('../../../test-utils/fixtures/', import.meta.url));
const read = (name: string) => readFileSync(`${fixtures}${name}`, 'utf8');
const parse = (name: string) => parseDeckHtml(read(name));

describe('golden fixtures', () => {
  it.each(['basic.deck.html', 'rich.deck.html', 'messy.deck.html', 'animated.deck.html', 'external.deck.html', 'malicious.deck.html'])(
    'validation matches the golden for %s',
    (name) => {
      const result = validateDeck(parse(name));
      const expected = JSON.parse(read(name.replace('.deck.html', '.validate.expected.json')));
      expect(result).toEqual(expected);
    }
  );

  it('outline matches the golden for rich.deck.html', () => {
    expect(getOutline(parse('rich.deck.html'))).toEqual(
      JSON.parse(read('rich.outline.expected.json'))
    );
  });

  it('normalizes messy.deck.html deterministically and idempotently', () => {
    const doc = parse('messy.deck.html');
    normalizeDeck(doc);
    const once = serializeDeck(doc);
    expect(once).toBe(read('messy.normalized.expected.html'));

    const second = parseDeckHtml(once);
    const result = normalizeDeck(second);
    expect(result.changed).toBe(false);
    expect(serializeDeck(second)).toBe(once);
  });

  it('keeps object counts and runtime presence for every fixture after normalize and serialize', () => {
    for (const name of ['basic.deck.html', 'rich.deck.html', 'messy.deck.html', 'animated.deck.html', 'external.deck.html']) {
      const doc = parse(name);
      const before = getOutline(doc);
      normalizeDeck(doc);
      const after = getOutline(parseDeckHtml(serializeDeck(doc)));
      expect(after.slideCount).toBe(before.slideCount);
      expect(after.slides.map((slide) => slide.elements.length)).toEqual(
        before.slides.map((slide) => slide.elements.length)
      );
      expect(after.runtime).toBe(before.runtime);
    }
  });

  it('handles a generated 100-slide deck without drift', () => {
    const slides = Array.from({ length: 100 }, (_, index) =>
      `<section class="slide"><h1>Slide ${index + 1}</h1></section>`
    ).join('');
    const doc = parseDeckHtml(
      `<!doctype html><html><head><title>Large</title></head><body><main data-ppt-deck>${slides}</main></body></html>`
    );
    const result = normalizeDeck(doc);
    expect(result.slides).toHaveLength(100);
    expect(result.slides[0].id).toBe('s1');
    expect(result.slides[99].id).toBe('s100');
    expect(getOutline(doc).slides[99].elements[0].text).toBe('Slide 100');
  });
});
```

- [ ] **Step 3: Generate the goldens, inspect, and run**

Create a one-off script in the scratch workspace (not committed) that writes `JSON.stringify(validateDeck(doc), null, 2)` for each fixture plus the normalized HTML for messy. Before committing, inspect every golden and confirm:

- `messy`: `single-body-fallback` absent, `missing-slide-id` twice, `missing-runtime`, `mixed-canvas-sizes`, `relative-asset` (bg.png, photo.png), `fixed-layout`, `notes-nested-incorrectly`, `canvas-content`, `unsupported-group-nesting`, `script-present` once (the JSON script is allowed), `editor-artifacts` absent.
- `external`: `missing-runtime`, `script-present`, no `relative-asset` (CDN URLs), no `missing-title`.
- `rich`: no errors; warnings empty.
- `malicious`: `missing-runtime`, `script-present`, `relative-asset` for `x.png`; no errors.
- `animated`: no errors, no warnings.
- `messy.normalized.expected.html` contains assigned ids `s1`, `s2`, `e1`, `e2` in document order, 1280×720 detection from inline style, preserved head/scripts/styles, and no editor attributes.

Run: `npm run test -w @htmlppt/core -- golden`
Expected: PASS.

- [ ] **Step 4: Consider `malicious` in the E2E isolation suite**

Add `malicious.deck.html` to the existing sandbox isolation E2E only if it takes under a second; the M0 test already covers inline scripts, so no new E2E is required in M1. Do not duplicate coverage.

- [ ] **Step 5: Run the full gate**

```bash
npm run verify
npm run test:matrix
git status --porcelain
```

Expected: lint, dependency boundaries, typecheck, core 60+ tests, host/CLI tests, and all Playwright tests pass; matrix `2 active, 2 tagged`; tree clean.

- [ ] **Step 6: Commit**

```bash
git add test-utils/fixtures packages/core/test/golden.test.ts
git commit -m "test(core): add golden contract fixtures"
```

---

## Self-Review

- **Spec coverage:** §4 contract attributes are validated and preserved; §11 normalization (ids, position injectable, artifact cleanup), validation errors/warnings, diagnostics with slide id and location; §6 read models `getOutline`/`readSlide`; MCP mutation list minus assets/tables/charts/groups (M4) and background (editor settings, M3/M4), all slide ops, notes, transitions, and element ops covered; runtime §Runtime initial state, print, navigation guards; test framework §5 fixtures and golden files.
- **Deliberate deviations recorded:** `no-slides` error removed because detection always produces a body fallback; missing canvas attributes are allowed (defaults) while explicitly invalid values are errors; `update_slide_html` refuses the body fallback; duplicate slides keep per-slide object ids; missing-runtime warning suppressed when any runtime marker exists (invalid markers still error). Normalization follows detection precedence: partially annotated decks normalize only the detected slides; ignored classed siblings are a detection-semantics gap deferred to M2/M3, not silently promoted. `set_slide_background` and asset/table/chart/group mutations are deferred with their features.
- **Type consistency:** `SlideInfo` gains `widthValid`/`heightValid`; every consumer uses `readCanvasSize`; `DeckMutationError` is exported from both `target.ts` and `mutations.ts` (same class); `Transition` is used by template-independent mutations only.
- **No placeholders:** every task names exact files, codes, messages, test code, and commands. The only generated artifacts are golden files, with an explicit inspection checklist.

## Execution Handoff

Execute with `superpowers:subagent-driven-development`: one fresh implementer per task, a scoped review after each, fix rounds as needed, and a final whole-branch review before merging to main. Do not push or publish.
