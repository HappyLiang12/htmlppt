import { describe, expect, it } from 'vitest';
import {
  DeckMutationError,
  alignElements,
  bringForward,
  bringToFront,
  distributeElements,
  groupElements,
  normalizeDeck,
  sendBackward,
  sendToBack,
  serializeDeck,
  setHidden,
  setLocked,
  ungroupElement,
  type ElementTarget
} from '../src/index.js';
import { parseDeckHtml } from '../src/node.js';

const target = (elementId: string): ElementTarget => ({ elementId });
const box = (id: string, x: number, y: number, w: number, h: number, extra = '') =>
  `<div data-ppt-el="${id}" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${extra}"><b>${id}</b></div>`;
const deck = (html = box('a', 10, 20, 20, 40) + box('b', 80, 100, 40, 20) + box('c', 210, 180, 60, 60)) =>
  parseDeckHtml(`<!doctype html><html><head><title>Objects</title></head><body><section data-slide-id="s1" style="position:relative">${html}</section></body></html>`);
const root = (doc: Document) => doc.querySelector('[data-slide-id="s1"]') as HTMLElement;
const object = (doc: Document, id: string) => doc.querySelector(`[data-ppt-el="${id}"]`) as HTMLElement;
const rect = (element: HTMLElement) => ['left', 'top', 'width', 'height'].map((key) => Number.parseFloat(element.style.getPropertyValue(key)));
const ids = (element: Element) => Array.from(element.children).map((child) => child.getAttribute('data-ppt-el'));
const selected = ['c', 'a', 'b'].map(target);
const effectiveOrder = (element: Element) => Array.from(element.children)
  .filter((child) => child.hasAttribute('data-ppt-el') && !child.hasAttribute('data-ppt-notes'))
  .sort((a, b) => (Number.parseInt((a as HTMLElement).style.zIndex) || 0) - (Number.parseInt((b as HTMLElement).style.zIndex) || 0))
  .map((child) => child.getAttribute('data-ppt-el'));

function unchanged(doc: Document, run: () => unknown, code: string): void {
  const before = serializeDeck(doc);
  expect(run).toThrow(DeckMutationError);
  expect(run).toThrow(expect.objectContaining({ code }));
  expect(serializeDeck(doc)).toBe(before);
}

describe('object alignment and distribution', () => {
  it.each([
    ['left', [[10, 20, 20, 40], [10, 100, 40, 20], [10, 180, 60, 60]]],
    ['center', [[130, 20, 20, 40], [120, 100, 40, 20], [110, 180, 60, 60]]],
    ['right', [[250, 20, 20, 40], [230, 100, 40, 20], [210, 180, 60, 60]]],
    ['top', [[10, 20, 20, 40], [80, 20, 40, 20], [210, 20, 60, 60]]],
    ['middle', [[10, 110, 20, 40], [80, 120, 40, 20], [210, 100, 60, 60]]],
    ['bottom', [[10, 200, 20, 40], [80, 220, 40, 20], [210, 180, 60, 60]]]
  ] as const)('aligns %s to the selected bounds', (mode, expected) => {
    const doc = deck();
    alignElements(doc, 's1', selected, mode);
    expect(['a', 'b', 'c'].map((id) => rect(object(doc, id)))).toEqual(expected);
    expect(ids(root(doc))).toEqual(['a', 'b', 'c']);
    expect(Array.from(root(doc).querySelectorAll('b')).map((node) => node.textContent)).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['horizontal', [[10, 20, 20, 40], [100, 100, 40, 20], [210, 180, 60, 60]]],
    ['vertical', [[10, 20, 20, 40], [80, 110, 40, 20], [210, 180, 60, 60]]]
  ] as const)('distributes equal %s outer-edge gaps, fixing endpoints', (axis, expected) => {
    const doc = deck();
    distributeElements(doc, 's1', selected, axis);
    expect(['a', 'b', 'c'].map((id) => rect(object(doc, id)))).toEqual(expected);
    expect(ids(root(doc))).toEqual(['a', 'b', 'c']);
  });

  it('distributes four uneven boxes with negative equal gaps', () => {
    const doc = deck(box('a', 0, 0, 100, 20) + box('b', 20, 0, 80, 20) + box('c', 40, 0, 60, 20) + box('d', 90, 0, 10, 20));
    distributeElements(doc, 's1', ['d', 'b', 'a', 'c'].map(target), 'horizontal');
    expect(['a', 'b', 'c', 'd'].map((id) => rect(object(doc, id))[0])).toEqual([0, 50, 80, 90]);
  });

  it('aligns rotated and translated boxes by visible outer bounds', () => {
    const doc = deck(box('a', 10, 20, 20, 40, 'transform:rotate(90deg)') + box('b', 100, 30, 40, 20, 'transform:translate(10px, 5px)'));
    alignElements(doc, 's1', ['a', 'b'].map(target), 'left');
    expect(rect(object(doc, 'a'))).toEqual([10, 20, 20, 40]);
    expect(rect(object(doc, 'b'))).toEqual([-10, 30, 40, 20]);
    expect(object(doc, 'a').style.transform).toBe('rotate(90deg)');
    expect(object(doc, 'b').style.transform).toBe('translate(10px, 5px)');
  });

  it('distributes rotated boxes by their visible widths', () => {
    const doc = deck(box('a', 10, 20, 20, 40, 'transform:rotate(90deg)') + box('b', 60, 20, 20, 20) + box('c', 130, 20, 20, 40, 'transform:rotate(90deg)'));
    distributeElements(doc, 's1', ['b', 'c', 'a'].map(target), 'horizontal');
    expect(rect(object(doc, 'b'))).toEqual([70, 20, 20, 20]);
  });

  it.each([
    [[], 'invalid-selection'],
    [[target('a')], 'invalid-selection'],
    [[target('a'), { selector: '[data-ppt-el="a"]' }], 'invalid-selection'],
    [[target('a'), target('missing')], 'target-not-found'],
    [[target('a'), { path: [1, 0] }], 'target-invalid'],
    [[target('a'), { selector: 'div' }], 'target-ambiguous'],
    [[target('a'), { selector: '<<<' }], 'target-invalid'],
    [[target('a'), { path: [] }], 'target-invalid']
  ] as [ElementTarget[], string][])('rejects invalid alignment selection %j atomically', (targets, code) => {
    const doc = deck();
    unchanged(doc, () => alignElements(doc, 's1', targets, 'right'), code);
  });

  it('requires three distinct distribution objects and validates runtime enums', () => {
    const doc = deck();
    unchanged(doc, () => distributeElements(doc, 's1', ['a', 'b'].map(target), 'horizontal'), 'invalid-selection');
    unchanged(doc, () => distributeElements(doc, 's1', [target('a'), target('b'), { path: [0] }], 'horizontal'), 'invalid-selection');
    unchanged(doc, () => alignElements(doc, 's1', selected, 'diagonal' as never), 'invalid-alignment');
    unchanged(doc, () => distributeElements(doc, 's1', selected, 'diagonal' as never), 'invalid-distribution');
  });

  it.each(['position:relative', 'left:10%', 'width:auto', 'height:-1px', 'right:10px', 'margin-left:2px', 'padding:2px', 'transform:scale(2)', 'transform:matrix(1.2,0,0,1,0,0)'])('rejects unsupported geometry %s before any alignment/distribution writes', (style) => {
    const doc = deck();
    object(doc, 'c').setAttribute('style', `${object(doc, 'c').getAttribute('style')};${style}`);
    const code = style.startsWith('transform') ? 'unsupported-transform' : 'invalid-geometry';
    unchanged(doc, () => alignElements(doc, 's1', selected, 'left'), code);
    unchanged(doc, () => distributeElements(doc, 's1', selected, 'horizontal'), code);
  });
});

describe('grouping and ungrouping', () => {
  it('creates an enclosing absolute group with stable unique IDs, content and child order', () => {
    const doc = deck(box('e1', 5, 5, 5, 5) + box('a', 10, 20, 20, 40) + '<!--keep--><aside data-ppt-notes>Notes</aside>' + box('b', 80, 100, 40, 20) + box('e3', 300, 300, 10, 10));
    object(doc, 'e3').innerHTML = '<span data-ppt-el="e2">Unrelated</span>';
    root(doc).setAttribute('data-ppt-el', 'e4');
    const a = object(doc, 'a');
    const b = object(doc, 'b');
    const unrelated = object(doc, 'e3').innerHTML;
    const id = groupElements(doc, 's1', ['b', 'a']);
    expect(id).toBe('e5');
    const group = object(doc, id);
    expect(group.tagName).toBe('DIV');
    expect(group.hasAttribute('data-ppt-group')).toBe(true);
    expect(group.style.position).toBe('absolute');
    expect(rect(group)).toEqual([10, 20, 110, 100]);
    expect(ids(group)).toEqual(['a', 'b']);
    expect(rect(a)).toEqual([0, 0, 20, 40]);
    expect(rect(b)).toEqual([70, 80, 40, 20]);
    expect(object(doc, 'a')).toBe(a);
    expect(a.innerHTML).toBe('<b>a</b>');
    expect(effectiveOrder(root(doc))).toEqual(['e1', 'e5', 'e3']);
    expect(ids(root(doc)).filter((value) => value !== id)).toEqual(['e1', null, 'e3']);
    expect(object(doc, 'e3').innerHTML).toBe(unrelated);
    expect(root(doc).innerHTML).toContain('<!--keep-->');
    normalizeDeck(doc);
    const parsed = parseDeckHtml(serializeDeck(doc));
    expect(object(parsed, id).hasAttribute('data-ppt-group')).toBe(true);
    expect(ungroupElement(parsed, 's1', target(id))).toEqual(['a', 'b']);
    expect(rect(object(parsed, 'a'))).toEqual([10, 20, 20, 40]);
    expect(rect(object(parsed, 'b'))).toEqual([80, 100, 40, 20]);
    expect(effectiveOrder(root(parsed))).toEqual(['e1', 'a', 'b', 'e3']);
    expect(root(parsed).querySelector('[data-ppt-group]')).toBeNull();
  });

  it('encloses rotated children without rewriting their transforms', () => {
    const doc = deck(box('a', 10, 20, 20, 40, 'transform:rotate(90deg)') + box('b', 100, 80, 40, 20));
    const id = groupElements(doc, 's1', ['a', 'b']);
    expect(rect(object(doc, id))).toEqual([0, 30, 140, 70]);
    expect(rect(object(doc, 'a'))).toEqual([10, -10, 20, 40]);
    expect(object(doc, 'a').style.transform).toBe('rotate(90deg)');
    ungroupElement(doc, 's1', target(id));
    expect(rect(object(doc, 'a'))).toEqual([10, 20, 20, 40]);
    expect(object(doc, 'a').style.transform).toBe('rotate(90deg)');
  });

  it('composes moved group rotation and a rotated child into slide coordinates', () => {
    const doc = deck(box('a', 10, 20, 20, 40) + box('b', 100, 80, 40, 20, 'transform:rotate(90deg)'));
    const id = groupElements(doc, 's1', ['a', 'b']);
    expect(rect(object(doc, id))).toEqual([10, 20, 120, 90]);
    const group = object(doc, id);
    group.style.left = '200px';
    group.style.top = '300px';
    group.style.transform = 'rotate(90deg)';
    expect(ungroupElement(doc, 's1', target(id))).toEqual(['a', 'b']);
    expect(rect(object(doc, 'a'))).toEqual([275, 275, 20, 40]);
    expect(rect(object(doc, 'b'))).toEqual([215, 385, 40, 20]);
    expect(object(doc, 'a').style.transform).toBe('rotate(90deg)');
    expect(object(doc, 'b').style.transform).toBe('rotate(180deg)');
  });

  it.each([
    ['translate(30px, -10px) rotate(90deg)', [305, 265, 20, 40], [245, 375, 40, 20]],
    ['rotate(90deg) translate(30px, -10px)', [285, 305, 20, 40], [225, 415, 40, 20]],
    ['translateX(30px) translateY(-10px)', [230, 290, 20, 40], [320, 350, 40, 20]]
  ] as const)('composes CSS transform order: %s', (transform, a, b) => {
    const doc = deck(box('a', 10, 20, 20, 40) + box('b', 100, 80, 40, 20, 'transform:rotate(90deg)'));
    const id = groupElements(doc, 's1', ['a', 'b']);
    object(doc, id).style.left = '200px';
    object(doc, id).style.top = '300px';
    object(doc, id).style.transform = transform;
    ungroupElement(doc, 's1', target(id));
    expect(rect(object(doc, 'a'))).toEqual(a);
    expect(rect(object(doc, 'b'))).toEqual(b);
  });

  it('composes child translation and a non-right-angle group rotation', () => {
    const doc = deck(`<div data-ppt-group data-ppt-el="g" style="position:absolute;left:100px;top:200px;width:100px;height:100px;transform:rotate(45deg)">${box('a', 0, 0, 20, 20, 'transform:translate(10px, 0px) rotate(-45deg)')}${box('b', 80, 80, 20, 20)}</div>`);
    ungroupElement(doc, 's1', target('g'));
    const [x, y] = rect(object(doc, 'a'));
    expect(x).toBeCloseTo(147.0710678119, 8);
    expect(y).toBeCloseTo(190.5025253169, 8);
    expect(object(doc, 'a').style.transform || '').toBe('');
    expect(object(doc, 'b').style.transform).toBe('rotate(45deg)');
  });

  it('preserves effective stacking when DOM order differs from authored z-index', () => {
    const doc = deck(box('a', 10, 20, 20, 40, 'z-index:20') + box('u', 20, 20, 40, 20, 'z-index:100') + box('b', 30, 20, 20, 20, 'z-index:-3') + box('v', 40, 20, 20, 20, 'z-index:200'));
    const id = groupElements(doc, 's1', ['a', 'b']);
    expect(effectiveOrder(root(doc))).toEqual([id, 'u', 'v']);
    expect(effectiveOrder(object(doc, id))).toEqual(['b', 'a']);
    expect(ids(root(doc)).filter((value) => value !== id)).toEqual(['u', 'v']);
    expect(ungroupElement(doc, 's1', target(id))).toEqual(['b', 'a']);
    expect(effectiveOrder(root(doc))).toEqual(['b', 'a', 'u', 'v']);
  });

  it('places a noncontiguous group at the frontmost selected layer', () => {
    const doc = deck();
    const unrelated = object(doc, 'b').outerHTML;
    const id = groupElements(doc, 's1', ['c', 'a']);
    expect(effectiveOrder(root(doc))).toEqual(['b', id]);
    expect(ids(object(doc, id))).toEqual(['a', 'c']);
    expect(object(doc, 'b').outerHTML).toBe(unrelated);
  });

  it.each([
    [[], 'invalid-selection'],
    [['a'], 'invalid-selection'],
    [['a', ' a '], 'invalid-selection'],
    [['a', 'missing'], 'target-not-found'],
    [['a', 'nested'], 'target-invalid'],
    [['a', 'notes'], 'target-invalid'],
    [['a', 'g'], 'target-invalid']
  ] as [string[], string][])('rejects invalid group selection %j atomically', (selection, code) => {
    const doc = deck(box('a', 0, 0, 10, 10) + box('b', 20, 20, 10, 10) + '<div data-ppt-el="g" data-ppt-group><span data-ppt-el="nested">Child</span></div><aside data-ppt-notes data-ppt-el="notes">Notes</aside>');
    unchanged(doc, () => groupElements(doc, 's1', selection), code);
  });

  it.each(['transform:scale(2)', 'transform:skewX(10deg)', 'transform:matrix(1.2,0,0,1,0,0)', 'transform:translate3d(0,0,0)', 'transform:translate(50%,0)', 'transform:skewY(10deg)', 'rotate:20deg', 'scale:2'])('rejects unsupported group/child transforms %s atomically', (style) => {
    const doc = deck();
    object(doc, 'b').setAttribute('style', `${object(doc, 'b').getAttribute('style')};${style}`);
    unchanged(doc, () => groupElements(doc, 's1', ['a', 'b']), 'unsupported-transform');
    const valid = deck();
    const id = groupElements(valid, 's1', ['a', 'b']);
    object(valid, id).setAttribute('style', `${object(valid, id).getAttribute('style')};${style}`);
    unchanged(valid, () => ungroupElement(valid, 's1', target(id)), 'unsupported-transform');
  });

  it('validates all children before ungrouping or assigning IDs', () => {
    const doc = deck(`<div data-ppt-group data-ppt-el="g" style="position:absolute;left:10px;top:20px;width:100px;height:100px">${box('a', 0, 0, 10, 10)}${box('b', 20, 20, 10, 10, 'left:auto')}</div>`);
    unchanged(doc, () => ungroupElement(doc, 's1', target('g')), 'invalid-geometry');
    object(doc, 'b').style.left = '20px';
    object(doc, 'b').removeAttribute('data-ppt-el');
    unchanged(doc, () => ungroupElement(doc, 's1', target('g')), 'target-invalid');
  });

  it('validates every selected box before grouping', () => {
    const doc = deck();
    object(doc, 'b').style.width = '50%';
    unchanged(doc, () => groupElements(doc, 's1', ['a', 'b']), 'invalid-geometry');
  });

  it('preserves group comments, whitespace and child DOM order while restoring effective stacking', () => {
    const doc = deck(`<div data-ppt-group data-ppt-el="g" style="position:absolute;left:10px;top:20px;width:100px;height:100px">\n<!--before-->${box('a', 0, 0, 10, 10, 'z-index:3')}\n<!--between-->${box('b', 20, 20, 10, 10, 'z-index:1')}\n<!--after--></div>`);
    const nodes = Array.from(object(doc, 'g').childNodes);
    expect(ungroupElement(doc, 's1', target('g'))).toEqual(['a', 'b']);
    expect(Array.from(root(doc).childNodes)).toEqual(nodes);
    expect(effectiveOrder(root(doc))).toEqual(['b', 'a']);
  });

  it.each([
    ['padding:10px;box-sizing:border-box', 'unsupported-group-style'],
    ['border:2px solid red;box-sizing:border-box', 'unsupported-group-style'],
    ['opacity:0.5', 'unsupported-group-style'],
    ['overflow:hidden', 'unsupported-group-style'],
    ['display:none', 'unsupported-group-style']
  ])('rejects group wrapper effects that cannot be preserved: %s', (style, code) => {
    const doc = deck();
    const id = groupElements(doc, 's1', ['a', 'b']);
    object(doc, id).setAttribute('style', `${object(doc, id).getAttribute('style')};${style}`);
    unchanged(doc, () => ungroupElement(doc, 's1', target(id)), code);
  });

  it('rejects loose text in an authored group rather than discarding it', () => {
    const doc = deck();
    const id = groupElements(doc, 's1', ['a', 'b']);
    object(doc, id).appendChild(doc.createTextNode('Authored text'));
    unchanged(doc, () => ungroupElement(doc, 's1', target(id)), 'target-invalid');
  });

  it.each([
    ['', ['b', 'u', 'a']],
    ['transform:rotate(0deg)', ['b', 'a', 'u']],
    ['z-index:20', ['u', 'b', 'a']]
  ] as const)('preserves authored group stacking with context %j', (style, expected) => {
    const doc = deck(`<div data-ppt-group data-ppt-el="g" style="position:absolute;left:10px;top:20px;width:100px;height:100px;${style}">${box('a', 0, 0, 10, 10, 'z-index:20')}${box('b', 20, 20, 10, 10, 'z-index:-1')}</div>${box('u', 0, 0, 10, 10, 'z-index:10')}`);
    ungroupElement(doc, 's1', target('g'));
    expect(effectiveOrder(root(doc))).toEqual(expected);
    expect(rect(object(doc, 'a'))).toEqual([10, 20, 10, 10]);
    expect(rect(object(doc, 'b'))).toEqual([30, 40, 10, 10]);
  });

  it('rejects a non-group, nested group, notes child and duplicate child IDs', () => {
    const doc = deck();
    unchanged(doc, () => ungroupElement(doc, 's1', target('a')), 'target-invalid');
    const id = groupElements(doc, 's1', ['a', 'b']);
    object(doc, 'b').setAttribute('data-ppt-group', '');
    unchanged(doc, () => ungroupElement(doc, 's1', target(id)), 'target-invalid');
    object(doc, 'b').removeAttribute('data-ppt-group');
    object(doc, 'b').setAttribute('data-ppt-notes', '');
    unchanged(doc, () => ungroupElement(doc, 's1', target(id)), 'target-invalid');
    object(doc, 'b').removeAttribute('data-ppt-notes');
    object(doc, 'b').setAttribute('data-ppt-el', 'a');
    unchanged(doc, () => ungroupElement(doc, 's1', target(id)), 'target-ambiguous');
  });
});

describe('object lock and visibility', () => {
  it('sets/removes the persisted lock attribute without changing styles or content', () => {
    const doc = deck();
    const before = root(doc).innerHTML;
    setLocked(doc, 's1', { path: [0] }, true);
    expect(object(doc, 'a').getAttribute('data-ppt-locked')).toBe('true');
    setLocked(doc, 's1', { selector: '[data-ppt-el="a"]' }, false);
    expect(root(doc).innerHTML).toBe(before);
  });

  it('remembers the effective inline display when authored declarations repeat', () => {
    const doc = deck(box('a', 0, 0, 10, 10, 'display:flex;display:grid'));
    setHidden(doc, 's1', target('a'), true);
    const parsed = parseDeckHtml(serializeDeck(doc));
    setHidden(parsed, 's1', target('a'), false);
    expect(object(parsed, 'a').style.display).toBe('grid');
  });

  it.each(['flex', 'grid', 'inline-flex', 'none', 'grid !important', ''])('restores authored inline display %j after repeated hide and serialization', (display) => {
    const doc = deck(box('a', 0, 0, 10, 10, display ? `display:${display}` : ''));
    setHidden(doc, 's1', target('a'), true);
    setHidden(doc, 's1', target('a'), true);
    expect(object(doc, 'a').style.display.replace(/\s*!important$/, '')).toBe('none');
    expect(object(doc, 'a').hasAttribute('data-ppt-display')).toBe(true);
    normalizeDeck(doc);
    const parsed = parseDeckHtml(serializeDeck(doc));
    setHidden(parsed, 's1', target('a'), false);
    expect(object(parsed, 'a').style.getPropertyValue('display')).toBe(display);
    expect(object(parsed, 'a').hasAttribute('data-ppt-display')).toBe(false);
    const after = serializeDeck(parsed);
    setHidden(parsed, 's1', target('a'), false);
    expect(serializeDeck(parsed)).toBe(after);
  });
});

describe('object stacking', () => {
  const stacked = () => deck(box('a', 0, 0, 10, 10, 'z-index:10') + '<!--anchor--><aside data-ppt-el="notes" data-ppt-notes>Notes</aside><script>void 0</script><style>.keep{color:red}</style>' + box('b', 0, 0, 10, 10, 'z-index:-4') + box('c', 0, 0, 10, 10, 'z-index:10') + box('d', 0, 0, 10, 10));

  it.each([
    [bringToFront, 'b', ['d', 'a', 'c', 'b']],
    [sendToBack, 'c', ['c', 'b', 'd', 'a']],
    [bringForward, 'd', ['b', 'a', 'd', 'c']],
    [sendBackward, 'a', ['b', 'a', 'd', 'c']]
  ] as const)('%s changes effective explicit z-order by the requested amount', (operation, id, expected) => {
    const doc = stacked();
    const siblings = Array.from(root(doc).children).filter((child) => child !== object(doc, id));
    const content = siblings.map((child) => child.innerHTML);
    operation(doc, 's1', target(id));
    expect(effectiveOrder(root(doc))).toEqual(expected);
    expect(Array.from(root(doc).children).filter((child) => child !== object(doc, id))).toEqual(siblings);
    expect(siblings.map((child) => child.innerHTML)).toEqual(content);
    expect(object(doc, 'notes').getAttribute('style')).toBeNull();
    expect(root(doc).innerHTML).toContain('<!--anchor-->');
  });

  it.each([[bringToFront, 'c'], [bringForward, 'c'], [sendToBack, 'b'], [sendBackward, 'b']] as const)('%s is a byte-stable no-op at the effective boundary', (operation, id) => {
    const doc = stacked();
    const before = serializeDeck(doc);
    operation(doc, 's1', target(id));
    expect(serializeDeck(doc)).toBe(before);
  });

  it('makes target z-index effective without positioning unrelated static objects', () => {
    const doc = deck('<div data-ppt-el="a">A</div><div data-ppt-el="b">B</div>');
    const unrelated = object(doc, 'b').outerHTML;
    bringToFront(doc, 's1', target('a'));
    expect(object(doc, 'a').style.position).toBe('relative');
    expect(object(doc, 'b').outerHTML).toBe(unrelated);
  });

  it('ignores ineffective z-index on static objects before reordering', () => {
    const doc = deck('<div data-ppt-el="a" style="z-index:100">A</div>' + box('b', 0, 0, 10, 10, 'z-index:1') + box('c', 0, 0, 10, 10, 'z-index:2'));
    bringForward(doc, 's1', target('a'));
    expect(effectiveOrder(root(doc))).toEqual(['b', 'a', 'c']);
  });

  it('rejects unresolved z-index expressions without touching any siblings', () => {
    const doc = deck();
    object(doc, 'c').style.zIndex = 'var(--layer)';
    unchanged(doc, () => bringToFront(doc, 's1', target('a')), 'unsupported-stacking');
    unchanged(doc, () => groupElements(doc, 's1', ['a', 'b']), 'unsupported-stacking');
  });
});

describe('review hardening', () => {
  it('preserves non-center origins and rigid matrix rotations through group and ungroup', () => {
    for (const transform of ['rotate(90deg);transform-origin:0 0', 'matrix(0,1,-1,0,0,0);transform-origin:0 0']) {
      const doc = deck(box('a', 10, 20, 20, 40, `transform:${transform}`) + box('b', 0, 0, 10, 10));
      const id = groupElements(doc, 's1', ['a', 'b']);
      expect(rect(object(doc, id))).toEqual([-30, 0, 40, 40]);
      ungroupElement(doc, 's1', target(id));
      expect(rect(object(doc, 'a'))).toEqual([-20, 10, 20, 40]);
      expect(object(doc, 'a').style.getPropertyValue('transform')).toBe('rotate(90deg)');
      expect(rect(object(doc, 'b'))).toEqual([0, 0, 10, 10]);
    }
  });

  it('accepts finite pixel and percentage origins on rotated objects', () => {
    const doc = deck(box('a', 10, 20, 20, 40, 'transform:rotate(90deg);transform-origin:25% 10px') + box('b', 0, 0, 10, 10));
    const id = groupElements(doc, 's1', ['a', 'b']);
    expect(rect(object(doc, id))).toEqual([-15, 0, 40, 45]);
    ungroupElement(doc, 's1', target(id));
    expect(rect(object(doc, 'a'))).toEqual([-5, 15, 20, 40]);
    expect(object(doc, 'a').style.getPropertyValue('transform')).toBe('rotate(90deg)');
  });

  it('rejects min/max constraints that change the pinned box before any write', () => {
    const doc = deck();
    object(doc, 'b').setAttribute('style', `${object(doc, 'b').getAttribute('style')};width:20px;min-width:100px`);
    unchanged(doc, () => alignElements(doc, 's1', selected, 'left'), 'invalid-geometry');
    unchanged(doc, () => groupElements(doc, 's1', ['a', 'b']), 'invalid-geometry');
  });

  it('rejects overflowing derived coordinates before writing any object', () => {
    const doc = deck();
    object(doc, 'c').style.left = `${'1'}${'0'.repeat(300)}px`;
    unchanged(doc, () => alignElements(doc, 's1', selected, 'left'), 'invalid-geometry');
    unchanged(doc, () => groupElements(doc, 's1', ['a', 'c']), 'invalid-geometry');
  });

  it('validates display restoration metadata before changing any style', () => {
    const doc = deck();
    setHidden(doc, 's1', target('a'), true);
    object(doc, 'a').setAttribute('data-ppt-display', 'grid;left:999px;position:fixed');
    unchanged(doc, () => setHidden(doc, 's1', target('a'), false), 'invalid-display');
  });

  it('keeps the winning important display declaration across serialization', () => {
    const doc = parseDeckHtml(`<!doctype html><html><body><section data-slide-id="s1" style="position:relative">${box('a', 0, 0, 10, 10, 'display:flex !important;display:grid;left:5px !important;z-index:1 !important')}</section></body></html>`);
    setHidden(doc, 's1', target('a'), true);
    const parsed = parseDeckHtml(serializeDeck(doc));
    setHidden(parsed, 's1', target('a'), false);
    expect(object(parsed, 'a').style.getPropertyValue('display').startsWith('flex')).toBe(true);
    expect(() => alignElements(parsed, 's1', [target('a')], 'left')).toThrow(DeckMutationError);
  });

  it('allows harmless inherited group wrapper styles', () => {
    const doc = deck(`<div data-ppt-group data-ppt-el="g" style="position:absolute;left:10px;top:20px;width:100px;height:100px;color:inherit">${box('a', 0, 0, 10, 10)}${box('b', 20, 20, 10, 10)}</div>`);
    expect(ungroupElement(doc, 's1', target('g'))).toEqual(['a', 'b']);
  });
});

describe('shared object target validation', () => {
  const operations = [
    (doc: Document, slideId: string, value: ElementTarget) => setLocked(doc, slideId, value, true),
    (doc: Document, slideId: string, value: ElementTarget) => setHidden(doc, slideId, value, true),
    bringToFront, sendToBack, bringForward, sendBackward,
    (doc: Document, slideId: string, value: ElementTarget) => alignElements(doc, slideId, [target('a'), value], 'left'),
    (doc: Document, slideId: string, value: ElementTarget) => distributeElements(doc, slideId, [target('a'), target('b'), value], 'horizontal')
  ];

  it.each(operations)('rejects missing slide, nested/non-object targets before mutation: %s', (operation) => {
    const doc = deck(box('a', 0, 0, 10, 10) + box('b', 30, 30, 10, 10) + '<aside data-ppt-el="notes" data-ppt-notes>Notes</aside><script>void 0</script><style></style><template></template><link><meta>');
    unchanged(doc, () => operation(doc, 'missing', target('a')), 'slide-not-found');
    unchanged(doc, () => operation(doc, 's1', target('missing')), 'target-not-found');
    for (const value of [{ path: [0, 0] }, target('notes'), ...['script', 'style', 'template', 'link', 'meta'].map((selector) => ({ selector }))]) {
      unchanged(doc, () => operation(doc, 's1', value), 'target-invalid');
    }
  });
});
