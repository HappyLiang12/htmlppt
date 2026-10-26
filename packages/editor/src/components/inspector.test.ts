import { detectSlides } from '@htmlppt/core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeck } from '../slide-doc.js';
import type { Locale } from '../i18n';
import { withLocale } from '../i18n/test-utils.js';
import { useDeckController } from '../use-deck-controller.js';
import { Inspector, type InspectorProps } from './Inspector.js';

const DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inspector fixture</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900" style="background:#112233">
  <aside data-ppt-notes hidden>First notes</aside>
  <h1 data-ppt-el="e1">First</h1>
</section>
<section class="slide" data-slide-id="s2" data-width="1600" data-height="900">
  <aside data-ppt-notes hidden>Second notes</aside>
  <h1 data-ppt-el="e2">Second</h1>
</section>
</main>
</body>
</html>`;

const CONTEXT_DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Context fixture</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="c1" data-width="1600" data-height="900">
  <div class="pad" data-ppt-el="pad">
    <div class="cover"><h1>Title</h1><p>Sub</p></div>
    <p class="foot">x <strong>y</strong></p>
    <div class="textbox"><br></div>
    <div data-ppt-group="1"><p>a</p></div>
  </div>
</section>
</main>
</body>
</html>`;

const slides = detectSlides(parseDeck(DECK_HTML));
const contextSlides = detectSlides(parseDeck(CONTEXT_DECK_HTML));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

type InspectorInputs = Omit<InspectorProps, 'pendingActions'>;

function props(overrides: Partial<InspectorInputs> = {}): InspectorInputs {
  const first = slides[0];
  if (!first) throw new Error('Missing fixture slide.');
  return {
    slide: first,
    selection: null,
    geometry: null,
    objectActions: {
      canGroup: false,
      canUngroup: false,
      canAlign: false,
      canDistribute: false,
      canOrder: false,
      canToggle: false,
      locked: false,
      hidden: false,
      group: false
    },
    onSelectObject: () => undefined,
    onObjectCommand: () => undefined,
    onObjectRecovery: () => undefined,
    onCommitGeometry: () => true,
    onSetAppearance: () => true,
    onSetShapeText: () => true,
    onSetImageAlt: () => true,
    onSetImageCrop: () => true,
    onReplaceImageFile: () => undefined,
    onReplaceImageUrl: () => undefined,
    onEditChart: () => undefined,
    onPreviewTransition: () => undefined,
    onSetTransition: () => undefined,
    onSetBackground: () => true,
    onClearBackground: () => true,
    onSetNotes: () => undefined,
    ...overrides
  };
}

function InspectorHarness(inputs: InspectorInputs) {
  const { actions } = useDeckController({});
  return createElement(Inspector, { ...inputs, pendingActions: actions });
}

async function render(
  overrides: Partial<InspectorInputs> = {},
  locale: Locale = 'zh-Hant'
): Promise<void> {
  await act(async () => {
    const inputs = props(overrides);
    root.render(
      withLocale(
        createElement(InspectorHarness, { ...inputs, key: inputs.slide?.id }),
        locale
      )
    );
  });
}

function inputByTestId(testId: string): HTMLInputElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing input ${testId}.`);
  }
  return element;
}

function textareaByTestId(testId: string): HTMLTextAreaElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing textarea ${testId}.`);
  }
  return element;
}

function selectByTestId(testId: string): HTMLSelectElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Missing select ${testId}.`);
  }
  return element;
}

function buttonByTestId(testId: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${testId}.`);
  }
  return element;
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native value setter.');
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function objectRows(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-testid="object-row"]')
  );
}

function objectRowAt(index: number): HTMLButtonElement {
  const row = objectRows()[index];
  if (!row) throw new Error(`Missing object row ${index}.`);
  return row;
}

function chevronOf(row: HTMLButtonElement): HTMLButtonElement | null {
  return (
    row.parentElement?.querySelector<HTMLButtonElement>('button[aria-label]') ??
    null
  );
}

describe('inspector editing context', () => {
  const contextSlide = contextSlides[0];

  function contextSlideOrThrow(): NonNullable<typeof contextSlide> {
    if (!contextSlide) throw new Error('Missing context fixture slide.');
    return contextSlide;
  }

  it('lists container children with slide-rooted paths and enters by absolute path', async () => {
    const onEnterContext = vi.fn();
    const onSelectObject = vi.fn();
    await render(
      {
        slide: contextSlideOrThrow(),
        contextPath: [0],
        onEnterContext,
        onSelectObject
      },
      'en'
    );

    expect(objectRows().map((row) => row.dataset.objectPath)).toEqual([
      '0.0',
      '0.1',
      '0.2',
      '0.3'
    ]);
    expect(
      objectRows().map(
        (row) => chevronOf(row)?.getAttribute('aria-label') ?? null
      )
    ).toEqual(['Enter cover', null, null, null]);

    const enter = chevronOf(objectRowAt(0));
    if (!enter) throw new Error('Missing enter chevron.');
    await click(enter);

    expect(onEnterContext).toHaveBeenCalledTimes(1);
    expect(onEnterContext).toHaveBeenCalledWith([0, 0]);

    await click(objectRowAt(0));
    expect(onSelectObject).toHaveBeenCalledWith([0, 0]);
  });

  it('omits the enter chevron when no handler is supplied', async () => {
    await render({ slide: contextSlideOrThrow(), contextPath: [0] }, 'en');

    expect(objectRows()).toHaveLength(4);
    expect(objectRows().map((row) => chevronOf(row))).toEqual([
      null,
      null,
      null,
      null
    ]);
    expect(
      container.querySelector('[data-testid="object-list"] button[aria-label]')
    ).toBeNull();
  });

  it('falls back to slide-level rows when the context path is not enterable', async () => {
    const onEnterContext = vi.fn();
    const onSelectObject = vi.fn();
    await render(
      {
        slide: contextSlideOrThrow(),
        // Resolves to the <p> text leaf, which cannot be an editing context.
        contextPath: [0, 1],
        onEnterContext,
        onSelectObject
      },
      'en'
    );

    expect(objectRows().map((row) => row.dataset.objectPath)).toEqual(['0']);
    expect(objectRowAt(0).dataset.objectId).toBe('pad');

    const enter = chevronOf(objectRowAt(0));
    if (!enter) throw new Error('Missing enter chevron.');
    expect(enter.getAttribute('aria-label')).toBe('Enter pad');

    await click(enter);
    expect(onEnterContext).toHaveBeenCalledWith([0]);

    await click(objectRowAt(0));
    expect(onSelectObject).toHaveBeenCalledWith([0]);
  });

  it('treats an unresolvable context path as slide level', async () => {
    await render(
      { slide: contextSlideOrThrow(), contextPath: [9] },
      'en'
    );

    expect(objectRows().map((row) => row.dataset.objectPath)).toEqual(['0']);
    expect(objectRowAt(0).dataset.objectId).toBe('pad');
  });
});

describe('inspector numeric fields', () => {
  it('restores the formatted baseline when a valid edit cannot be applied', async () => {
    const commits: Array<{ field: string; value: number }> = [];
    await render({
      selection: { slideIndex: 0, path: [0], elementId: 'e1' },
      geometry: { x: 120, y: 160, width: 240, height: 120, rotation: 0 },
      onCommitGeometry: (field, value) => {
        commits.push({ field, value });
        return false;
      }
    });

    const input = inputByTestId('field-x');
    expect(input.value).toBe('120');

    await act(async () => {
      input.focus();
      setInputValue(input, '999');
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true
        })
      );
    });

    expect(commits).toEqual([{ field: 'x', value: 999 }]);
    expect(inputByTestId('field-x').value).toBe('120');
    expect(inputByTestId('field-x').getAttribute('aria-invalid')).toBe('false');
  });
});

describe('inspector notes draft', () => {
  it('drops a draft on an approved replacement without committing it to the next slide', async () => {
    const onSetNotes = vi.fn();
    await render({ onSetNotes });

    const textarea = textareaByTestId('notes-input');
    expect(textarea.value).toBe('First notes');
    await act(async () => {
      textarea.focus();
      setInputValue(textarea, 'Draft for the first slide');
    });

    const second = slides[1];
    if (!second) throw new Error('Missing second slide.');
    await render({ slide: second, onSetNotes });

    const next = textareaByTestId('notes-input');
    expect(next.value).toBe('Second notes');
    await act(async () => {
      next.focus();
      next.blur();
    });
    expect(onSetNotes).not.toHaveBeenCalled();
  });
});

describe('inspector transition staging', () => {
  async function choose(value: string): Promise<void> {
    await act(async () => {
      const select = selectByTestId('transition-select');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('previews and cancels without committing', async () => {
    const onSetTransition = vi.fn();
    const onPreviewTransition = vi.fn();
    await render({ onSetTransition, onPreviewTransition });

    expect(selectByTestId('transition-select').value).toBe('none');
    expect(buttonByTestId('transition-preview').disabled).toBe(true);
    expect(buttonByTestId('transition-apply').disabled).toBe(true);
    expect(buttonByTestId('transition-cancel').disabled).toBe(true);

    await choose('slide');
    expect(onSetTransition).not.toHaveBeenCalled();
    expect(buttonByTestId('transition-preview').disabled).toBe(false);
    expect(buttonByTestId('transition-apply').disabled).toBe(false);

    await click(buttonByTestId('transition-preview'));
    expect(onPreviewTransition).toHaveBeenCalledWith('slide');
    expect(onSetTransition).not.toHaveBeenCalled();

    await click(buttonByTestId('transition-cancel'));
    expect(selectByTestId('transition-select').value).toBe('none');
    expect(onSetTransition).not.toHaveBeenCalled();
  });

  it('commits exactly the staged transition on apply', async () => {
    const onSetTransition = vi.fn();
    await render({ onSetTransition });

    await choose('fade');
    expect(onSetTransition).not.toHaveBeenCalled();
    await click(buttonByTestId('transition-apply'));
    expect(onSetTransition).toHaveBeenCalledTimes(1);
    expect(onSetTransition).toHaveBeenCalledWith('fade');
  });
});

describe('inspector background controls', () => {
  it('resets the value input when the kind changes', async () => {
    await render();
    expect(inputByTestId('background-value').value).toBe('rgb(17, 34, 51)');

    await act(async () => {
      const select = selectByTestId('background-kind');
      select.value = 'image';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(selectByTestId('background-kind').value).toBe('image');
    expect(inputByTestId('background-value').value).toBe('');
  });

  it('shows an inline error when the background is rejected', async () => {
    const onSetBackground = vi.fn(() => false);
    await render({ onSetBackground });

    await act(async () => {
      setInputValue(inputByTestId('background-value'), 'not-a-color');
    });
    await click(buttonByTestId('apply-background'));

    expect(onSetBackground).toHaveBeenCalledWith({
      kind: 'color',
      value: 'not-a-color'
    });
    const error = container.querySelector('[data-testid="background-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent?.trim()).not.toBe('');
  });

  it('clears the inline error when the value changes', async () => {
    const onSetBackground = vi.fn(() => false);
    await render({ onSetBackground });

    await act(async () => {
      setInputValue(inputByTestId('background-value'), 'not-a-color');
    });
    await click(buttonByTestId('apply-background'));
    expect(
      container.querySelector('[data-testid="background-error"]')
    ).not.toBeNull();

    // The stale alert must disappear as soon as the user corrects the input.
    await act(async () => {
      setInputValue(inputByTestId('background-value'), '#112233');
    });
    expect(
      container.querySelector('[data-testid="background-error"]')
    ).toBeNull();
  });

  it('clears the background through the clear action', async () => {
    const onClearBackground = vi.fn(() => true);
    await render({ onClearBackground });

    const clear = buttonByTestId('clear-background');
    expect(clear.disabled).toBe(false);
    await click(clear);

    expect(onClearBackground).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="background-error"]')).toBeNull();
  });
});

describe('inspector object appearance', () => {
  const SHAPE_STYLE = {
    kind: 'shape' as const,
    svg: false,
    appearance: {
      fill: 'rgb(79, 124, 255)',
      stroke: '',
      strokeWidth: '',
      radius: '',
      opacity: ''
    },
    text: '',
    alt: '',
    crop: { top: 0, right: 0, bottom: 0, left: 0 }
  };
  const IMAGE_STYLE = {
    ...SHAPE_STYLE,
    kind: 'image' as const,
    appearance: { ...SHAPE_STYLE.appearance, fill: '', radius: '', opacity: '' },
    alt: 'Pixel'
  };
  const selection = { slideIndex: 0, path: [0], elementId: 'e1' };

  it('applies shape appearance values on blur', async () => {
    const onSetAppearance = vi.fn(() => true);
    await render({ selection, style: SHAPE_STYLE, onSetAppearance });

    expect(inputByTestId('style-fill').value).toBe('rgb(79, 124, 255)');
    await act(async () => {
      const fill = inputByTestId('style-fill');
      fill.focus();
      setInputValue(fill, '#ff0000');
      fill.blur();
    });

    expect(onSetAppearance).toHaveBeenCalledWith({ fill: '#ff0000' });
  });

  it('shows validation feedback when an appearance value is rejected', async () => {
    const onSetAppearance = vi.fn(() => false);
    await render({ selection, style: SHAPE_STYLE, onSetAppearance });

    await act(async () => {
      const opacity = inputByTestId('style-opacity');
      opacity.focus();
      setInputValue(opacity, '2');
      opacity.blur();
    });

    expect(onSetAppearance).toHaveBeenCalledWith({ opacity: 2 });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '值無效，請修正或按 Escape 取消。'
    );
  });

  it('offers image replacement, alt text, crop, and style controls', async () => {
    const onSetImageAlt = vi.fn(() => true);
    const onSetImageCrop = vi.fn(() => true);
    await render({
      selection,
      style: IMAGE_STYLE,
      onSetImageAlt,
      onSetImageCrop
    });

    expect(buttonByTestId('image-replace-upload')).not.toBeNull();
    expect(buttonByTestId('image-replace-url')).not.toBeNull();
    expect(inputByTestId('image-alt').value).toBe('Pixel');

    await act(async () => {
      const top = inputByTestId('image-crop-top');
      top.focus();
      setInputValue(top, '10');
      top.blur();
    });
    expect(onSetImageCrop).toHaveBeenCalledWith({
      top: 10,
      right: 0,
      bottom: 0,
      left: 0
    });

    await render({
      selection,
      style: { ...IMAGE_STYLE, crop: { top: 10, right: 0, bottom: 0, left: 0 } },
      onSetImageCrop
    });
    await act(async () => {
      const top = inputByTestId('image-crop-top');
      top.focus();
      setInputValue(top, '0');
      top.blur();
    });
    expect(onSetImageCrop).toHaveBeenLastCalledWith(null);
  });
});
