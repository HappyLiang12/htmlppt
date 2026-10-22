import { describe, expect, it } from 'vitest';
import { selectionFromEvent, topLevelObjects } from './selection.js';

function makeSlide(): Element {
  const slide = document.createElement('section');

  const group = document.createElement('div');
  group.setAttribute('data-ppt-group', '1');
  group.setAttribute('data-ppt-el', 'g1');
  const paragraph = document.createElement('p');
  paragraph.setAttribute('data-ppt-el', 'e2');
  paragraph.textContent = 'Body';
  const heading = document.createElement('h1');
  heading.setAttribute('data-ppt-el', 'e1');
  heading.innerHTML = 'Title <span data-ppt-el="e3">nested</span>';
  group.append(paragraph, heading);

  const figure = document.createElement('figure');
  figure.setAttribute('data-ppt-el', 'f1');
  figure.innerHTML = '<figcaption><em>caption</em></figcaption>';

  const notes = document.createElement('aside');
  notes.setAttribute('data-ppt-notes', '1');
  notes.innerHTML = '<p>notes</p>';

  slide.append(group, figure, notes);
  for (const tag of ['script', 'style', 'template', 'link', 'meta']) {
    slide.appendChild(document.createElement(tag));
  }
  return slide;
}

// Regression fixture: excluded siblings before numbered objects mean filtered
// object indices and raw child indices disagree.
function makeNotesFirstSlide(): Element {
  const slide = document.createElement('section');

  const notes = document.createElement('aside');
  notes.setAttribute('data-ppt-notes', '1');
  notes.innerHTML = '<p>Speaker notes</p>';

  const group = document.createElement('div');
  group.setAttribute('data-ppt-group', '1');
  group.setAttribute('data-ppt-el', 'g1');
  const heading = document.createElement('h1');
  heading.setAttribute('data-ppt-el', 'e1');
  heading.innerHTML = 'Title <span data-ppt-el="e2">nested</span>';
  group.append(heading);

  const script = document.createElement('script');
  script.textContent = 'void 0;';

  const figure = document.createElement('figure');
  figure.setAttribute('data-ppt-el', 'f1');

  slide.append(notes, group, script, figure);
  return slide;
}

describe('topLevelObjects', () => {
  it('lists direct object children and skips notes and non-object tags', () => {
    const objects = topLevelObjects(makeSlide());

    expect(objects.map((element) => element.tagName)).toEqual(['DIV', 'FIGURE']);
  });

  it('returns a group wrapper as one object instead of its descendants', () => {
    const objects = topLevelObjects(makeSlide());

    expect(objects).toHaveLength(2);
    expect(objects[0]?.getAttribute('data-ppt-group')).toBe('1');
    expect(objects[0]?.querySelector('h1')).not.toBeNull();
    expect(objects).not.toContainEqual(
      expect.objectContaining({ tagName: 'H1' })
    );
  });

  it('treats the body fallback slide children as top-level objects', () => {
    const body = document.createElement('body');
    const heading = document.createElement('h1');
    heading.setAttribute('data-ppt-el', 'e1');
    body.appendChild(heading);

    expect(topLevelObjects(body)).toEqual([heading]);
  });
});

describe('selectionFromEvent', () => {
  it('selects the nearest top-level ancestor of a nested target', () => {
    const slide = makeSlide();
    const span = slide.querySelector('span');
    if (!span) throw new Error('Missing fixture span.');

    expect(selectionFromEvent(span, slide)).toEqual({
      slideIndex: 0,
      path: [0],
      elementId: 'g1'
    });
  });

  it('returns the slide index supplied by the caller', () => {
    const slide = makeSlide();
    const figure = slide.querySelector('figure');
    if (!figure) throw new Error('Missing fixture figure.');

    expect(selectionFromEvent(figure, slide, { slideIndex: 3 })).toEqual({
      slideIndex: 3,
      path: [1],
      elementId: 'f1'
    });
  });

  it('uses raw child indices when excluded siblings precede an object', () => {
    const slide = makeNotesFirstSlide();
    const span = slide.querySelector('span');
    const figure = slide.querySelector('figure');
    if (!span || !figure) throw new Error('Missing fixture nodes.');

    expect(selectionFromEvent(span, slide)).toEqual({
      slideIndex: 0,
      path: [1],
      elementId: 'g1'
    });
    expect(selectionFromEvent(figure, slide)).toEqual({
      slideIndex: 0,
      path: [3],
      elementId: 'f1'
    });
  });

  it('uses the same raw path for Alt drill with excluded siblings before the object', () => {
    const slide = makeNotesFirstSlide();
    const span = slide.querySelector('span');
    if (!span) throw new Error('Missing fixture span.');

    expect(
      selectionFromEvent(span, slide, { altKey: true, slideIndex: 2 })
    ).toEqual({
      slideIndex: 2,
      path: [1, 0, 0],
      elementId: 'e2'
    });
  });

  it('drills to the deepest element path on Alt-click', () => {
    const slide = makeSlide();
    const span = slide.querySelector('span');
    if (!span) throw new Error('Missing fixture span.');

    expect(
      selectionFromEvent(span, slide, { altKey: true, slideIndex: 1 })
    ).toEqual({
      slideIndex: 1,
      path: [0, 1, 0],
      elementId: 'e3'
    });
  });

  it('returns a one-element path when Alt-clicking a top-level object', () => {
    const slide = makeSlide();
    const figure = slide.querySelector('figure');
    if (!figure) throw new Error('Missing fixture figure.');

    expect(selectionFromEvent(figure, slide, { altKey: true })).toEqual({
      slideIndex: 0,
      path: [1],
      elementId: 'f1'
    });
  });

  it('returns null for targets outside the slide or on its background', () => {
    const slide = makeSlide();

    expect(selectionFromEvent(document.createElement('div'), slide)).toBeNull();
    expect(selectionFromEvent(slide, slide)).toBeNull();
    expect(selectionFromEvent(null, slide)).toBeNull();
  });

  it('returns null for clicks inside excluded top-level elements', () => {
    const slide = makeSlide();
    const notesParagraph = slide.querySelector('aside p');
    const script = slide.querySelector('script');
    if (!notesParagraph || !script) throw new Error('Missing fixture nodes.');

    expect(selectionFromEvent(notesParagraph, slide)).toBeNull();
    expect(selectionFromEvent(script, slide)).toBeNull();
  });

  it('handles the body fallback slide', () => {
    const body = document.createElement('body');
    const heading = document.createElement('h1');
    heading.setAttribute('data-ppt-el', 'e1');
    const span = document.createElement('span');
    heading.appendChild(span);
    body.appendChild(heading);

    expect(selectionFromEvent(span, body)).toEqual({
      slideIndex: 0,
      path: [0],
      elementId: 'e1'
    });
    expect(selectionFromEvent(span, body, { altKey: true })).toEqual({
      slideIndex: 0,
      path: [0, 0],
      elementId: null
    });
  });
});
