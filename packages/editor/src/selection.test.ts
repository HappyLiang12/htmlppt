import { describe, expect, it } from 'vitest';
import {
  contextEntry,
  describeContextSegment,
  isEnterableContainer,
  selectionFromEvent,
  topLevelObjects
} from './selection.js';

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

describe('isEnterableContainer', () => {
  function parseElement(html: string): Element {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const element = template.content.firstElementChild;
    if (!element) throw new Error('Missing fixture element.');
    return element;
  }

  it('accepts a layout container with object children', () => {
    expect(
      isEnterableContainer(
        parseElement(
          '<div class="pad"><div class="cover">c</div><p>foot</p></div>'
        )
      )
    ).toBe(true);
  });

  it('rejects text leaves that only wrap inline markup', () => {
    expect(isEnterableContainer(parseElement('<p>x <strong>y</strong></p>'))).toBe(
      false
    );
    expect(
      isEnterableContainer(parseElement('<h1><span>Title</span></h1>'))
    ).toBe(false);
  });

  it('rejects a div whose only element children are line breaks', () => {
    expect(isEnterableContainer(parseElement('<div><br></div>'))).toBe(false);
    expect(isEnterableContainer(parseElement('<div></div>'))).toBe(false);
    expect(isEnterableContainer(parseElement('<div>plain text</div>'))).toBe(false);
  });

  it('rejects excluded children so a wrapper of notes or scripts stays inert', () => {
    expect(
      isEnterableContainer(
        parseElement('<div><script>void 0;</script></div>')
      )
    ).toBe(false);
  });

  it('rejects groups so they stay atomic', () => {
    expect(
      isEnterableContainer(parseElement('<div data-ppt-group="1"><p>a</p></div>'))
    ).toBe(false);
  });

  it('rejects a container whose ancestor is a group', () => {
    const slide = parseElement(
      '<section data-slide-id="s1"><div data-ppt-group="1"><div class="inside"><p>a</p></div></div></section>'
    );
    expect(isEnterableContainer(slide.querySelector('.inside') as Element)).toBe(
      false
    );
  });

  it('rejects a container whose ancestor is locked or hidden', () => {
    const locked = parseElement(
      '<section data-slide-id="s1"><div data-ppt-locked="true"><div class="inside"><p>a</p></div></div></section>'
    );
    const hidden = parseElement(
      '<section data-slide-id="s1"><div style="display:none"><div class="inside"><p>a</p></div></div></section>'
    );
    expect(isEnterableContainer(locked.querySelector('.inside') as Element)).toBe(
      false
    );
    expect(isEnterableContainer(hidden.querySelector('.inside') as Element)).toBe(
      false
    );
  });

  it('stops the guard walk at the slide boundary', () => {
    // A wrapper above the slide is not part of the authored subtree this
    // container belongs to, so it cannot make the slide's objects inert.
    const deck = parseElement(
      '<main data-ppt-locked="true"><section data-slide-id="s1"><div class="inside"><p>a</p></div></section></main>'
    );
    expect(isEnterableContainer(deck.querySelector('.inside') as Element)).toBe(
      true
    );
  });
});

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

  it('excludes non-rendered SVG elements from objects', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.append(defs, title, group);
    expect(topLevelObjects(svg)).toEqual([group]);
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

function build(): Element {
  const doc = new DOMParser().parseFromString(
    `<section data-slide-id="s1">
       <div class="halo"></div>
       <div class="pad">
         <div class="cover"><h1>Title</h1><p>Sub</p></div>
         <p class="foot">Footer</p>
       </div>
     </section>`,
    'text/html'
  );
  return doc.querySelector('section') as Element;
}

describe('editing context', () => {
  it('selects the context container child, not the slide-level wrapper', () => {
    const slide = build();
    const h1 = slide.querySelector('h1') as Element;

    const selected = selectionFromEvent(h1, slide, { containerPath: [1] });

    expect(selected?.path).toEqual([1, 0]);
  });

  it('keeps absolute paths for alt-click inside a context', () => {
    const slide = build();
    const h1 = slide.querySelector('h1') as Element;

    const selected = selectionFromEvent(h1, slide, {
      containerPath: [1],
      altKey: true
    });

    expect(selected?.path).toEqual([1, 0, 0]);
  });

  it('enters the nearest container with children', () => {
    const slide = build();
    const cover = slide.querySelector('.cover') as Element;

    expect(contextEntry(slide, cover, [])).toEqual([1, 0]);
  });

  it('does not enter a leaf element', () => {
    const slide = build();
    const foot = slide.querySelector('.foot') as Element;

    expect(contextEntry(slide, foot, [1])).toBeNull();
  });

  it('returns null for the current container and targets outside it', () => {
    const slide = build();
    const pad = slide.querySelector('.pad') as Element;
    const halo = slide.querySelector('.halo') as Element;

    expect(contextEntry(slide, pad, [1])).toBeNull();
    expect(contextEntry(slide, halo, [1])).toBeNull();
  });

  it('does not enter excluded elements such as speaker notes', () => {
    const slide = document.createElement('section');
    const notes = document.createElement('aside');
    notes.setAttribute('data-ppt-notes', '1');
    notes.innerHTML = '<p>Speaker notes</p>';
    slide.appendChild(notes);

    expect(contextEntry(slide, notes, [])).toBeNull();
  });

  it('does not enter text leaves, line-break boxes, or groups', () => {
    const doc = new DOMParser().parseFromString(
      `<section data-slide-id="s1">
         <p class="leaf">x <strong>y</strong></p>
         <h1 class="heading"><span>Title</span></h1>
         <div class="textbox"><br></div>
         <div data-ppt-group="1"><p>a</p></div>
       </section>`,
      'text/html'
    );
    const slide = doc.querySelector('section') as Element;

    expect(contextEntry(slide, slide.querySelector('.leaf') as Element, [])).toBeNull();
    expect(contextEntry(slide, slide.querySelector('.heading') as Element, [])).toBeNull();
    expect(contextEntry(slide, slide.querySelector('.textbox') as Element, [])).toBeNull();
    expect(
      contextEntry(slide, slide.querySelector('[data-ppt-group]') as Element, [])
    ).toBeNull();
  });

  it('keeps raw child indices when an excluded sibling precedes a container', () => {
    const doc = new DOMParser().parseFromString(
      `<section data-slide-id="s1">
         <div class="pad">
           <script>void 0;</script>
           <div class="cover"><p>body</p></div>
         </div>
       </section>`,
      'text/html'
    );
    const slide = doc.querySelector('section') as Element;

    expect(contextEntry(slide, slide.querySelector('.cover') as Element, [0])).toEqual([
      0, 1
    ]);
  });

  it('prepends the absolute container path when entering deeper', () => {
    const doc = new DOMParser().parseFromString(
      `<section data-slide-id="s1">
         <div class="pad"><div class="cover"><div class="card"><p>body</p></div></div></div>
       </section>`,
      'text/html'
    );
    const slide = doc.querySelector('section') as Element;

    expect(
      contextEntry(slide, slide.querySelector('.card') as Element, [0, 0])
    ).toEqual([0, 0, 0]);
  });

  it('keeps slide index, absolute path, and element ids for context selections', () => {
    const doc = new DOMParser().parseFromString(
      `<section data-slide-id="s1">
         <div class="pad">
           <script>void 0;</script>
           <div class="cover" data-ppt-el="c1"><p data-ppt-el="p1">body</p></div>
         </div>
       </section>`,
      'text/html'
    );
    const slide = doc.querySelector('section') as Element;
    const paragraph = slide.querySelector('p') as Element;

    expect(
      selectionFromEvent(paragraph, slide, { containerPath: [0], slideIndex: 5 })
    ).toEqual({
      slideIndex: 5,
      path: [0, 1],
      elementId: 'c1'
    });
    expect(
      selectionFromEvent(paragraph, slide, {
        containerPath: [0],
        slideIndex: 5,
        altKey: true
      })
    ).toEqual({
      slideIndex: 5,
      path: [0, 1, 0],
      elementId: 'p1'
    });
  });

  it('describes a context segment by class, then tag', () => {
    const slide = build();

    expect(describeContextSegment(slide.querySelector('.pad') as Element)).toBe('.pad');
    expect(describeContextSegment(slide.querySelector('h1') as Element)).toBe('h1');
  });

  it('uses the first class of a multi-class segment and ignores blank classes', () => {
    const doc = new DOMParser().parseFromString(
      `<section data-slide-id="s1">
         <div class="  pad   cover  "></div>
         <div class="   "></div>
       </section>`,
      'text/html'
    );
    const elements = Array.from(doc.querySelectorAll('div'));
    if (elements.length !== 2) throw new Error('Missing fixture elements.');

    expect(describeContextSegment(elements[0] as Element)).toBe('.pad');
    expect(describeContextSegment(elements[1] as Element)).toBe('div');
  });
});
