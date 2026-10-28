# Editor canvas fit — implementation plan

Date: 2026-10-28
Spec: `docs/superpowers/specs/2026-10-28-editor-canvas-fit-design.md`
Branch: `feat/editor-canvas-fit` from `main` 82c84b6

## Global constraints

- Never commit or push on `main`; the user performs merges.
- No deck-file rewriting; measurement is session-only.
- Play Fit/Fill, the 48 px canvas padding, and export stay unchanged.
- RED before GREEN: every behavior test fails on the pre-fix code first.
- One full `npm run verify` alone on the final HEAD before the PR.
- UI copy unchanged (no new locale keys).
- Build and verify never run concurrently.

## File structure

New:

- `packages/editor/src/canvas-fit.ts` — pure stage/crop helpers.
- `packages/editor/src/canvas-fit.test.ts` — Vitest.
- `e2e/editor-canvas-fit.spec.ts` — Playwright, tag `@feature:editor-canvas-fit`.

Modified:

- `packages/editor/src/App.tsx` — measure on frame load, cropped stage.
- `packages/editor/src/components/ThumbnailRail.tsx` — miniature crop.
- `docs/features.json` — feature entry.
- `docs/contract.md` — editor crop sentence.

---

## Task 1: Pure canvas-fit helpers

**Files:** create `canvas-fit.ts`, `canvas-fit.test.ts`.

Write the failing test first:

```ts
import { describe, expect, it } from 'vitest';
import {
  canvasCrop,
  metadataBox,
  miniatureCrop,
  sameMeasuredBox,
  stageBoxFor
} from './canvas-fit';

const slide = { id: 's1', width: 1600, height: 900 };
const measured = {
  id: 's1',
  box: { left: 0, top: 0, width: 1200, height: 900 }
};

describe('stageBoxFor', () => {
  it('falls back to metadata when nothing was measured', () => {
    expect(stageBoxFor(slide, null)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900
    });
  });
  it('uses the measured box for the same slide', () => {
    expect(stageBoxFor(slide, measured)).toEqual(measured.box);
  });
  it('rejects a measurement from another slide', () => {
    expect(stageBoxFor(slide, { ...measured, id: 's2' })).toEqual(
      metadataBox(slide)
    );
  });
});

describe('canvasCrop', () => {
  it('sizes the stage and translates the frame by the crop origin', () => {
    expect(
      canvasCrop({ left: 120, top: 40, width: 1200, height: 900 }, 0.5)
    ).toEqual({
      width: 600,
      height: 450,
      translateX: -60,
      translateY: -20
    });
  });
  it('is the identity for a metadata-sized box at zero offset', () => {
    expect(canvasCrop(metadataBox(slide), 0.72)).toEqual({
      width: 1152,
      height: 648,
      translateX: 0,
      translateY: 0
    });
  });
});

describe('miniatureCrop', () => {
  it('keeps the display width and follows the box aspect', () => {
    expect(
      miniatureCrop({ left: 0, top: 0, width: 1200, height: 900 }, 152)
    ).toEqual({ scale: 152 / 1200, height: 114, translateX: 0, translateY: 0 });
  });
  it('guards a zero-width box', () => {
    expect(miniatureCrop({ left: 0, top: 0, width: 0, height: 0 }, 152)).toEqual(
      { scale: 1, height: 0, translateX: 0, translateY: 0 }
    );
  });
});

describe('sameMeasuredBox', () => {
  it('compares id and sub-pixel geometry', () => {
    expect(sameMeasuredBox(measured, measured)).toBe(true);
    expect(sameMeasuredBox(measured, { ...measured, id: 's2' })).toBe(false);
    expect(
      sameMeasuredBox(measured, {
        ...measured,
        box: { ...measured.box, width: 1201 }
      })
    ).toBe(false);
    expect(sameMeasuredBox(measured, { ...measured, box: { ...measured.box, left: -0.2 } })).toBe(true);
  });
});
```

Implementation:

```ts
import { sameBox, type SlideBox } from './play-fit';

export interface MeasuredBox {
  id: string;
  box: SlideBox;
}

export interface SlideSize {
  id: string;
  width: number;
  height: number;
}

export function metadataBox(slide: SlideSize): SlideBox {
  return { left: 0, top: 0, width: slide.width, height: slide.height };
}

export function stageBoxFor(
  slide: SlideSize,
  measured: MeasuredBox | null
): SlideBox {
  return measured && measured.id === slide.id ? measured.box : metadataBox(slide);
}

export interface CanvasCrop {
  width: number;
  height: number;
  translateX: number;
  translateY: number;
}

export function canvasCrop(box: SlideBox, scale: number): CanvasCrop {
  return {
    width: box.width * scale,
    height: box.height * scale,
    translateX: 0 - box.left * scale,
    translateY: 0 - box.top * scale
  };
}

export interface MiniatureCrop {
  scale: number;
  height: number;
  translateX: number;
  translateY: number;
}

export function miniatureCrop(box: SlideBox, displayWidth: number): MiniatureCrop {
  const scale = box.width > 0 ? displayWidth / box.width : 1;
  return {
    scale,
    height: box.height * scale,
    translateX: 0 - box.left * scale,
    translateY: 0 - box.top * scale
  };
}

export function sameMeasuredBox(
  a: MeasuredBox | null,
  b: MeasuredBox | null
): boolean {
  return Boolean(a && b && a.id === b.id && sameBox(a.box, b.box));
}

export function parseFitMode(...) // not here
```

Run: `npm test -w @htmlppt/editor -- canvas-fit` (RED, then GREEN).

Commit: `test(editor): define measured stage and crop math` (tests + module
may land together after GREEN).

---

## Task 2: Failing E2E for canvas, thumbnail, and sorter

**File:** create `e2e/editor-canvas-fit.spec.ts`.

Two fixtures:

```ts
const CSS_ONLY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CSS only</title>
<style>
  html, body { margin: 0; padding: 0; background: #0b0d12; }
  .slide { display: none; width: 1200px; height: 900px; background: #f7f5ef; color: #17181c; font: 48px/1.2 sans-serif; }
  .slide.active { display: block; }
  h1 { position: absolute; left: 80px; top: 80px; margin: 0; font-weight: 400; }
</style></head><body>
<main data-ppt-deck>
  <section class="slide active" data-slide-id="s1"><h1 data-ppt-el="title">Four three</h1></section>
  <section class="slide" data-slide-id="s2"><h1>Second</h1></section>
</main></body></html>`;

const DECLARED = `... data-slide-id="s1" data-width="1600" data-height="900" ... 1600x900 CSS ...`;
```

Helpers:

```ts
async function frameOf(page, selector) {
  const handle = await page.locator(selector).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('frame missing');
  return frame;
}
```

Tests:

1. `crops the canvas and miniatures to a CSS-only slide` (tagged)
   - open deck, click thumbnail 1;
   - read iframe rect (`iframe[title="投影片預覽"]`), stage rect (parent);
   - in the canvas frame read the slide root rect (design px) and its offset;
   - compute the slide's screen rect: `stage.left + root.left * scale` etc.,
     where `scale = stage.width / 1600` (metadata width) — or derive
     `scale = iframeRect.width / 1600`;
   - assert the screen rect equals the stage rect within 1 px;
   - assert stage aspect ratio `Math.round(width / height * 100) === 133`;
   - for the first rail thumbnail, assert `miniature` rect equals the
     slide's screen rect within 1 px (the miniature container carries
     `data-testid="slide-miniature"`, added in Task 3);
   - switch to sorter (`view-sorter`), assert the first
     `[data-testid="sorter-slide"]` miniature equals its slide rect too;
   - back to normal; click the h1 in the canvas; expect `text-toolbar`
     `data-mode="selection"`; save via body click; assert the saved HTML has no
     `data-ppt-preview-slide`/`data-ppt-frame-slide`/`active` reveal artifacts.
2. `keeps a declared slide geometry unchanged`
   - stage ratio 178 for a 1600x900 declared deck; slide screen rect equals the
     stage; thumbnails unchanged ratio.

Run to confirm RED: `npm run build && npx playwright test e2e/editor-canvas-fit.spec.ts`
Expected: test 1 fails (stage ratio 178 / band), test 2 passes.

Commit: `test(editor): cover measured canvas crop` (E2E stays failing until the
integration tasks; the plan gate records the RED evidence).

---

## Task 3: Canvas integration

**Files:** `packages/editor/src/App.tsx`, `ThumbnailRail.tsx` (testid only).

1. Import `canvasCrop`, `stageBoxFor`, `sameMeasuredBox`, `type MeasuredBox`
   from `./canvas-fit` and `measureSlideBox` from `./play-fit`.
2. State + ref near `frameEpoch`:

```ts
const [measuredBox, setMeasuredBox] = useState<MeasuredBox | null>(null);
const measuredBoxRef = useRef<MeasuredBox | null>(null);
measuredBoxRef.current = measuredBox;
```

3. In `onFrameLoad`, after `revealPreviewSlide(frameDocument)`:

```ts
const measured = measureSlideBox(frameDocument);
const activeId = stateRef.current.slides[stateRef.current.activeIndex]?.id;
if (measured && activeId) {
  const next = { id: activeId, box: measured };
  setMeasuredBox((previous) => (sameMeasuredBox(previous, next) ? previous : next));
}
```

4. `computeFitScale` uses the stage box:

```ts
const slide = current.slides[current.activeIndex];
if (!slide) return;
const box = stageBoxFor(slide, measuredBoxRef.current);
const widthScale = Math.max(0.1, (bounds.width - 96) / box.width);
const heightScale = Math.max(0.1, (bounds.height - 96) / box.height);
```

5. Fit effect deps: replace `activeSlide?.width/height` with the resolved stage
   box width/height (`stageBox?.width`, `stageBox?.height`).
6. Render:

```tsx
const stageBox = activeSlide
  ? stageBoxFor(activeSlide, measuredBox)
  : null;
const crop = stageBox ? canvasCrop(stageBox, scale) : null;
...
{activeSlide && crop && (
  <div
    className="relative overflow-hidden shadow-[0_24px_80px_var(--editor-shadow-stage)]"
    style={{ width: crop.width, height: crop.height }}
  >
    <iframe
      ...
      style={{
        width: activeSlide.width,
        height: activeSlide.height,
        transform: `translate(${crop.translateX}px, ${crop.translateY}px) scale(${scale})`,
        transformOrigin: 'top left'
      }}
    />
```

7. `SlideMiniature`: add `data-testid="slide-miniature"` to the container
   (no other change in this task).

Run the canvas-only test:
`npm run build && npx playwright test e2e/editor-canvas-fit.spec.ts --grep "crops the canvas"`
Expected: PASS. The miniature assertions inside that test still fail until
Task 4; split the test bodies if needed so the canvas part is independently
selectable (e.g. `test.describe('canvas', ...)` / `test.describe('miniatures', ...)`).

Commit: `feat(editor): crop the canvas stage to the measured slide box`.

---

## Task 4: Miniature crop (rail + sorter)

**File:** `packages/editor/src/components/ThumbnailRail.tsx`.

```tsx
const [measured, setMeasured] = useState<SlideBox | null>(null);
const box = measured ?? { left: 0, top: 0, width: slide.width, height: slide.height };
const crop = miniatureCrop(box, width);
...
<div
  data-testid="slide-miniature"
  className={`relative overflow-hidden bg-white ${className}`}
  style={{ width, height: Math.round(crop.height) }}
  aria-hidden="true"
>
  {srcDoc && (
    <iframe
      ...
      onLoad={(event) => {
        const frameDocument = event.currentTarget.contentDocument;
        if (!frameDocument) return;
        revealPreviewSlide(frameDocument);
        const next = measureSlideBox(frameDocument);
        if (next) setMeasured((previous) => (sameBox(previous, next) ? previous : next));
      }}
      style={{
        width: slide.width,
        height: slide.height,
        transform: `translate(${crop.translateX}px, ${crop.translateY}px) scale(${crop.scale})`,
        transformOrigin: 'top left'
      }}
    />
  )}
</div>
```

`SorterView` needs no change; it renders the same miniature.

Run: `npm run build && npx playwright test e2e/editor-canvas-fit.spec.ts`
Expected: PASS (both tests).

Also run the existing crop-sensitive specs:
`npx playwright test e2e/editor.spec.ts e2e/play-fit.spec.ts e2e/preview-reveal.spec.ts`
Expected: PASS.

Commit: `feat(editor): crop thumbnails and sorter to the measured slide`.

---

## Task 5: Feature matrix and contract

- `docs/features.json`: add
  `{ "id": "editor-canvas-fit", "spec": "Editor canvas fit 2026-10-28", "status": "active", "tests": ["@feature:editor-canvas-fit"] }`.
- `docs/contract.md`: one sentence in the editor preview section: the canvas,
  thumbnail rail, and sorter crop to the slide's measured content box; decks
  whose declared size matches their content are unchanged.

Run: `npm run test:matrix` → active count +1, all tagged.

Commit: `docs: index the editor canvas fit contract`.

---

## Task 6: Gate, manual QA, PR

1. `npm run verify` alone on the final HEAD; capture exit code and summary.
2. Manual QA on the built dist with the probe harness:
   - CSS-only 4:3 deck: canvas stage 4:3, slide rect equals stage, no band;
     thumbnail and sorter crop; click and drag an object; save clean HTML.
   - rich-demo-4x3, aria-conductor-q, rich-demo: stage geometry unchanged;
     Fit/Fill unchanged; export PNG/PDF unchanged; zero console errors.
   - Screenshots under `D:/project/tmp/qa/out/canvas-fit`.
3. Push `feat/editor-canvas-fit`; open a PR against `main` with the gate and QA
   evidence; watch the hosted CI matrix; no merge, tag, or publish.

## Acceptance mapping

- ECF-AC1 → Task 2 test 1 (canvas, rail, sorter rect equality).
- ECF-AC2 → Task 2 test 2 plus the existing specs in Task 4.
- ECF-AC3 → Task 2 selection/save assertions and the existing drag specs.
- ECF-AC4 → `computeFitScale` change plus the existing zoom test.
- ECF-AC5 → unit fallback cases; manual QA with an overflowing box.
- ECF-AC6 → saved-HTML assertion in Task 2.
