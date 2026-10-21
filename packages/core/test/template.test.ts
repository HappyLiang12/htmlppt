import { describe, expect, it } from 'vitest';
import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import { detectSlides } from '../src/detect.js';
import { parseDeckHtml } from '../src/node.js';
import { createDeckHtml } from '../src/template.js';
import { validateDeck } from '../src/validate.js';

describe('createDeckHtml', () => {
  it('creates a valid deck with the requested slide count', () => {
    const doc = parseDeckHtml(createDeckHtml({ title: 'Demo', slides: 3 }));

    expect(validateDeck(doc).valid).toBe(true);
    expect(detectSlides(doc).map((slide) => slide.id)).toEqual(['s1', 's2', 's3']);
    expect(doc.title).toBe('Demo');
  });

  it('escapes the title', () => {
    const html = createDeckHtml({ title: '<script>alert(1)</script>' });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('embeds the runtime without a nested closing script tag', () => {
    const html = createDeckHtml();

    expect(RUNTIME_SOURCE).not.toContain('</script>');
    expect(html).toContain('data-ppt-runtime="1"');
    expect(html).toContain('ArrowRight');
  });
});
