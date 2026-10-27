import { beforeEach, describe, expect, it } from 'vitest';
import { revealPreviewSlide } from './frame-reveal';

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('class');
});

describe('revealPreviewSlide', () => {
  it('reveals an inline-hidden slide root and marks it active', () => {
    document.body.innerHTML =
      '<section id="s" data-ppt-preview-slide="" style="display:none;visibility:hidden;opacity:0"><h1>Two</h1></section>';

    const root = revealPreviewSlide(document) as HTMLElement;

    expect(root.id).toBe('s');
    expect(root.style.display).not.toBe('none');
    expect(window.getComputedStyle(root).visibility).toBe('visible');
    expect(root.classList.contains('active')).toBe(true);
  });

  it('removes the hidden attribute and leaves inner authored hiding alone', () => {
    document.body.innerHTML =
      '<section id="s" data-ppt-preview-slide="" hidden><h1 style="display:none">Two</h1></section>';

    const root = revealPreviewSlide(document) as HTMLElement;

    expect(root.hasAttribute('hidden')).toBe(false);
    expect((root.querySelector('h1') as HTMLElement).style.display).toBe('none');
  });

  it('reveals a hidden ancestor shell', () => {
    document.body.innerHTML =
      '<div id="shell" style="display:none"><section data-ppt-preview-slide=""><h1>Two</h1></section></div>';

    revealPreviewSlide(document);

    expect(document.getElementById('shell')!.style.display).not.toBe('none');
  });

  it('returns null when the frame has no body', () => {
    const empty = { body: null, defaultView: null } as unknown as Document;
    expect(revealPreviewSlide(empty)).toBeNull();
  });
});
