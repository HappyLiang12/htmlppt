import { detectSlides } from '@htmlppt/core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeck } from '../slide-doc.js';
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

const slides = detectSlides(parseDeck(DECK_HTML));

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

function props(overrides: Partial<InspectorProps> = {}): InspectorProps {
  const first = slides[0];
  if (!first) throw new Error('Missing fixture slide.');
  return {
    slide: first,
    selection: null,
    geometry: null,
    onSelectObject: () => undefined,
    onCommitGeometry: () => true,
    onSetTransition: () => undefined,
    onSetBackground: () => true,
    onClearBackground: () => true,
    onSetNotes: () => undefined,
    ...overrides
  };
}

async function render(overrides: Partial<InspectorProps> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(Inspector, props(overrides)));
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

describe('inspector numeric fields', () => {
  it('restores the formatted baseline when the edit is rejected', async () => {
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
  });
});

describe('inspector notes draft', () => {
  it('drops a draft when the slide changes programmatically', async () => {
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
