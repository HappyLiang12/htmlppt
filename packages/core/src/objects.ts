import { defaultIdFactory } from './ids.js';
import { findSlide } from './slides.js';
import { DeckMutationError, resolveTarget, type ElementTarget } from './target.js';

const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const PIXELS = new RegExp(`^(${NUMBER})(?:px)?$`, 'i');
const DEGREES = new RegExp(`^(${NUMBER})deg$`, 'i');
const PERCENT = new RegExp(`^(${NUMBER})%$`);
const DISPLAY_ATTRIBUTE = 'data-ppt-display';

type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
type Axis = 'horizontal' | 'vertical';
interface Box {
  element: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  center: { x: number; y: number };
}

function fail(code: string, message: string): never {
  throw new DeckMutationError(code, message);
}

function isObject(element: Element): element is HTMLElement {
  return !NON_OBJECT_TAGS.has(element.tagName.toUpperCase()) && !element.hasAttribute('data-ppt-notes');
}

function objectTarget(slide: Element, target: ElementTarget): HTMLElement {
  const element = resolveTarget(slide, target);
  if (element.parentElement !== slide || !isObject(element)) {
    fail('target-invalid', 'Object operations require a direct, non-notes object child of the slide.');
  }
  return element;
}

function selection(slide: Element, targets: ElementTarget[], minimum: number): HTMLElement[] {
  if (targets.length < minimum) {
    fail('invalid-selection', `Select at least ${minimum} distinct objects.`);
  }
  const elements = targets.map((target) => objectTarget(slide, target));
  if (new Set(elements).size !== elements.length) {
    fail('invalid-selection', 'Select each object only once.');
  }
  return elements;
}

function pixels(value: string): number | undefined {
  const match = PIXELS.exec(value.trim());
  if (!match || (!/px$/i.test(value.trim()) && Number(match[1]) !== 0)) return undefined;
  const result = Number(match[1]);
  return Number.isFinite(result) ? result : undefined;
}

const MAX_COORDINATE = 1e7;

function clean(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
    fail('invalid-geometry', 'Coordinates are outside the supported precision range.');
  }
  return Math.round(value * 1e10) / 1e10;
}

function normalizeAngle(value: number): number {
  if (!Number.isFinite(value)) fail('unsupported-transform', 'Rotation must be a finite number of degrees.');
  return Math.round((((value % 360) + 360) % 360) * 1e10) / 1e10;
}

interface InlineDeclaration {
  value: string;
  important: boolean;
}

function splitDeclarations(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function declarationMap(element: Element): Map<string, InlineDeclaration> {
  const map = new Map<string, InlineDeclaration>();
  const text = element.getAttribute('style') ?? '';
  for (const part of splitDeclarations(text)) {
    let quote = '';
    let depth = 0;
    let colon = -1;
    for (let index = 0; index < part.length; index += 1) {
      const char = part[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth = Math.max(0, depth - 1);
      else if (char === ':' && depth === 0) {
        colon = index;
        break;
      }
    }
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    if (!/^-?[a-z][a-z0-9-]*$/.test(property)) continue;
    let value = part.slice(colon + 1).trim();
    let important = false;
    const priority = /!\s*important\s*$/i.exec(value);
    if (priority) {
      important = true;
      value = value.slice(0, priority.index).trim();
    }
    if (!value) continue;
    const previous = map.get(property);
    if (previous?.important && !important) continue;
    map.set(property, { value, important });
  }
  return map;
}

interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  ox: number;
  oy: number;
  angle: number;
}

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, ox: 0, oy: 0, angle: 0 };

function multiply(
  left: { a: number; b: number; c: number; d: number; e: number; f: number },
  right: { a: number; b: number; c: number; d: number; e: number; f: number }
) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

function mapPoint(transform: Affine, x: number, y: number): { x: number; y: number } {
  const px = x - transform.ox;
  const py = y - transform.oy;
  return {
    x: transform.ox + transform.a * px + transform.c * py + transform.e,
    y: transform.oy + transform.b * px + transform.d * py + transform.f
  };
}

function worldPoint(transform: Affine, baseX: number, baseY: number, localX: number, localY: number) {
  const mapped = mapPoint(transform, localX, localY);
  return { x: baseX + mapped.x, y: baseY + mapped.y };
}

function worldRect(box: {
  x: number;
  y: number;
  width: number;
  height: number;
  center: { x: number; y: number };
}, transform: Affine) {
  const corners = [
    worldPoint(transform, box.x, box.y, 0, 0),
    worldPoint(transform, box.x, box.y, box.width, 0),
    worldPoint(transform, box.x, box.y, 0, box.height),
    worldPoint(transform, box.x, box.y, box.width, box.height)
  ];
  return {
    left: clean(Math.min(...corners.map((corner) => corner.x))),
    top: clean(Math.min(...corners.map((corner) => corner.y))),
    right: clean(Math.max(...corners.map((corner) => corner.x))),
    bottom: clean(Math.max(...corners.map((corner) => corner.y))),
    center: worldPoint(transform, box.x, box.y, box.width / 2, box.height / 2)
  };
}

function originOf(value: string | undefined, width: number, height: number): { ox: number; oy: number } {
  const unsupported = () => fail('unsupported-transform', 'Use a center, pixel or percentage transform-origin.');
  if (!value) return { ox: width / 2, oy: height / 2 };
  const parts = value.trim().split(/\s+/);
  if (parts.length > 3) unsupported();
  const keyword = (part: string, horizontal: boolean): number | undefined => {
    const token = part.toLowerCase();
    if (token === 'center') return 0.5;
    if (horizontal && token === 'left') return 0;
    if (horizontal && token === 'right') return 1;
    if (!horizontal && token === 'top') return 0;
    if (!horizontal && token === 'bottom') return 1;
    const percent = PERCENT.exec(token);
    if (percent) return Number(percent[1]) / 100;
    const px = pixels(token);
    return px === undefined ? undefined : horizontal ? px / width : px / height;
  };
  if (parts.length === 1) {
    const x = keyword(parts[0], true);
    if (x !== undefined) return { ox: x * width, oy: height / 2 };
    const y = keyword(parts[0], false);
    if (y === undefined) unsupported();
    return { ox: width / 2, oy: (y as number) * height };
  }
  const x = keyword(parts[0], true);
  const y = keyword(parts[1], false);
  if (x === undefined || y === undefined) unsupported();
  if (parts[2] && pixels(parts[2]) !== 0) unsupported();
  return { ox: (x as number) * width, oy: (y as number) * height };
}

function transformOf(element: HTMLElement, width: number, height: number): Affine {
  const unsupported = () => fail('unsupported-transform', 'Use 2D translate/rotate or an equivalent rigid matrix; flatten scale, skew and 3D transforms first.');
  const declarations = declarationMap(element);
  for (const property of ['translate', 'rotate', 'scale', 'perspective', 'offset-path']) {
    const value = declarations.get(property)?.value;
    if (value && value !== 'none') unsupported();
  }
  const origin = originOf(declarations.get('transform-origin')?.value, width, height);
  const transform = declarations.get('transform')?.value?.trim() ?? 'none';
  if (transform === 'none') return { ...IDENTITY, ...origin };
  let matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let remaining = transform;
  while (remaining) {
    const match = /^(translateX|translateY|translate|rotate|matrix)\(([^()]*)\)\s*/i.exec(remaining);
    if (!match) return unsupported();
    const name = match[1].toLowerCase();
    const args = match[2].trim().split(/\s*,\s*|\s+/);
    if (name === 'rotate') {
      const degrees = DEGREES.exec(args[0] ?? '');
      const degree = degrees ? Number(degrees[1]) : Number.NaN;
      if (args.length !== 1 || !Number.isFinite(degree)) unsupported();
      const radians = degree * Math.PI / 180;
      matrix = multiply(matrix, { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 });
    } else if (name === 'matrix') {
      if (args.length !== 6) unsupported();
      const values = args.map((part) => Number(part));
      if (values.some((value) => !Number.isFinite(value))) unsupported();
      matrix = multiply(matrix, { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] });
    } else {
      const values = args.map(pixels);
      if (values.some((value) => value === undefined) || args.length > (name === 'translate' ? 2 : 1)) unsupported();
      const x = name === 'translatey' ? 0 : values[0] as number;
      const y = name === 'translatex' ? 0 : name === 'translatey' ? values[0] as number : values[1] ?? 0;
      matrix = multiply(matrix, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
    }
    remaining = remaining.slice(match[0].length);
  }
  const scaleX = matrix.a * matrix.a + matrix.b * matrix.b;
  const scaleY = matrix.c * matrix.c + matrix.d * matrix.d;
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const dot = matrix.a * matrix.c + matrix.b * matrix.d;
  if (Math.abs(scaleX - 1) > 1e-6 || Math.abs(scaleY - 1) > 1e-6 || Math.abs(determinant - 1) > 1e-6 || Math.abs(dot) > 1e-6) unsupported();
  return { ...matrix, ...origin, angle: normalizeAngle(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI) };
}

function constraint(value: string | undefined, label: string): number | undefined {
  if (!value) return undefined;
  const token = value.trim().toLowerCase();
  if (['auto', 'none', '0', '0px', 'initial', 'unset', 'revert'].includes(token)) return undefined;
  const result = pixels(token);
  if (result === undefined) {
    fail('invalid-geometry', `Use a pixel ${label} or remove it before changing object geometry.`);
  }
  return result;
}

function boxOf(element: HTMLElement): Box {
  const declarations = declarationMap(element);
  const value = (property: string) => declarations.get(property)?.value;
  const invalid = () => fail('invalid-geometry', 'Pin objects to absolute left/top/width/height pixel boxes, without margins or opposing insets; use border-box for padding/borders.');
  const values = ['left', 'top', 'width', 'height'].map((property) => pixels(value(property) ?? ''));
  if (value('position') !== 'absolute' || values.some((entry) => entry === undefined)) return invalid();
  const [x, y, width, height] = values as number[];
  if (width < 0 || height < 0) return invalid();
  for (const property of ['right', 'bottom']) {
    const inset = value(property);
    if (inset && inset !== 'auto') invalid();
  }
  for (const property of ['margin', 'margin-left', 'margin-top', 'margin-right', 'margin-bottom']) {
    const margin = value(property);
    if (margin && !margin.split(/\s+/).every((part) => pixels(part) === 0)) invalid();
  }
  if (value('box-sizing') !== 'border-box') {
    for (const [property, declaration] of declarations) {
      if (/^(padding|border)(-|$)/.test(property) && !['0', '0px', 'none'].includes(declaration.value)) invalid();
    }
  }
  const minWidth = constraint(value('min-width'), 'min-width');
  const maxWidth = constraint(value('max-width'), 'max-width');
  const minHeight = constraint(value('min-height'), 'min-height');
  const maxHeight = constraint(value('max-height'), 'max-height');
  if ((minWidth !== undefined && width < minWidth) || (maxWidth !== undefined && width > maxWidth)
    || (minHeight !== undefined && height < minHeight) || (maxHeight !== undefined && height > maxHeight)) {
    fail('invalid-geometry', 'Min/max constraints change the pinned box; flatten or remove them before changing object geometry.');
  }
  const transform = transformOf(element, width, height);
  const rect = worldRect({ x, y, width, height, center: { x: 0, y: 0 } }, transform);
  return {
    element,
    x,
    y,
    width,
    height,
    angle: transform.angle,
    ...rect
  };
}

function bounds(boxes: Box[]): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom))
  };
}

function setDeclaration(element: HTMLElement, property: string, value: string, important: boolean): void {
  element.style.setProperty(property, value, important ? 'important' : '');
  const reflected = typeof element.style.getPropertyPriority === 'function'
    ? element.style.getPropertyPriority(property) === 'important'
    : false;
  if (important && !reflected) {
    element.style.removeProperty(property);
    const css = element.style.cssText.trim();
    element.setAttribute('style', `${css}${css && !css.endsWith(';') ? ';' : ''}${property}:${value} !important`);
  }
}

function writeProperty(element: HTMLElement, property: string, value: string): void {
  const important = declarationMap(element).get(property)?.important ?? false;
  setDeclaration(element, property, value, important);
}

function position(element: HTMLElement, x: number, y: number): void {
  const left = clean(x);
  const top = clean(y);
  writeProperty(element, 'left', `${left}px`);
  writeProperty(element, 'top', `${top}px`);
}

interface Layer {
  phase: number;
  z: number;
  context: boolean;
  positioned: boolean;
  indexed: boolean;
}

interface PaintEntry {
  element: HTMLElement;
  owner: HTMLElement;
  layer: Layer;
  tree: number;
}

function layerOf(element: HTMLElement, parent: Element | null = element.parentElement): Layer {
  const declarations = declarationMap(element);
  const value = (property: string) => declarations.get(property)?.value;
  const zIndex = value('z-index')?.trim();
  if (zIndex && zIndex !== 'auto' && (!/^[+-]?\d+$/.test(zIndex) || !Number.isSafeInteger(Number(zIndex)))) {
    fail('unsupported-stacking', 'Use an inline safe integer z-index (or auto) before changing object order.');
  }
  const position = value('position');
  const display = value('display') ?? '';
  const parentDisplay = parent ? valueOf(parent, 'display') ?? '' : '';
  const positioned = Boolean(position && position !== 'static');
  const indexed = positioned || ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(parentDisplay);
  const z = indexed && zIndex && zIndex !== 'auto' ? Number(zIndex) : 0;
  const effect = ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter'].some((property) => {
    const entry = value(property);
    return entry && entry !== 'none';
  });
  const opacity = value('opacity');
  const context = Boolean((indexed && zIndex && zIndex !== 'auto') || effect ||
    ['fixed', 'sticky'].includes(position ?? '') ||
    (opacity && Number(opacity) < 1) || value('isolation') === 'isolate' ||
    (value('mix-blend-mode') && value('mix-blend-mode') !== 'normal') ||
    /\b(layout|paint|strict|content)\b/.test(value('contain') ?? '') ||
    /\b(transform|opacity|filter|perspective)\b/.test(value('will-change') ?? ''));
  const inline = /^(inline|inline-block|inline-flex|inline-grid)$/.test(display) ||
    (!display && ['SPAN', 'B', 'I', 'EM', 'STRONG', 'IMG', 'A'].includes(element.tagName.toUpperCase()));
  const float = value('float');
  const phase = z < 0 ? 0 : z > 0 ? 5 : positioned || context ? 4 : float && float !== 'none' ? 2 : inline ? 3 : 1;
  return { phase, z, context, positioned, indexed };
}

function valueOf(element: Element, property: string): string | undefined {
  return declarationMap(element).get(property)?.value;
}

function comparePaint(a: PaintEntry, b: PaintEntry): number {
  return a.layer.phase - b.layer.phase || a.layer.z - b.layer.z || a.tree - b.tree;
}

function paintEntries(parent: Element, elements = Array.from(parent.children).filter(isObject)): PaintEntry[] {
  const entries: PaintEntry[] = [];
  let tree = 0;
  const visit = (element: HTMLElement, owner: HTMLElement, direct: boolean) => {
    const layer = layerOf(element, direct ? parent : element.parentElement);
    if (direct || layer.positioned || layer.context) entries.push({ element, owner, layer, tree: tree++ });
    if (!layer.context) {
      for (const child of Array.from(element.children)) {
        if (isObject(child)) visit(child, owner, false);
      }
    }
  };
  for (const element of elements) visit(element, element, true);
  return entries;
}

function stacking(parent: Element, elements = Array.from(parent.children).filter(isObject)): HTMLElement[] {
  return elements.map((element, tree) => ({ element, owner: element, layer: layerOf(element, parent), tree }))
    .sort(comparePaint).map(({ element }) => element);
}

function stackingHazard(): never {
  return fail('unsupported-stacking', 'An escaping descendant layer would cross unrelated content. Flatten its stacking into an explicit object context, or separate it into a top-level object, before grouping or reordering.');
}

function validateEscaping(entries: PaintEntry[], projected: Map<HTMLElement, PaintEntry>): void {
  for (const entry of entries) {
    if (entry.element === entry.owner || !projected.has(entry.owner)) continue;
    const owner = entries.find((candidate) => candidate.element === entry.owner) as PaintEntry;
    for (const other of entries) {
      if (entry.owner === other.owner) continue;
      const after = projected.get(entry.owner) || entry;
      const otherAfter = projected.get(other.owner) || other;
      if (after === otherAfter) continue;
      const before = Math.sign(comparePaint(entry, other));
      if (before !== Math.sign(comparePaint(owner, other)) && before !== Math.sign(comparePaint(after, otherAfter))) stackingHazard();
    }
  }
}

function indexedEntry(entry: PaintEntry, z: number): PaintEntry {
  return { ...entry, layer: { ...entry.layer, z, phase: z < 0 ? 0 : z > 0 ? 5 : 4, context: true } };
}

function validatePositioning(element: HTMLElement): void {
  const contains = (candidate: HTMLElement) => ['transform', 'translate', 'rotate', 'scale', 'perspective', 'filter', 'backdrop-filter'].some((property) => {
    const value = valueOf(candidate, property);
    return value && value !== 'none';
  }) || /\b(layout|paint|strict|content)\b/.test(valueOf(candidate, 'contain') ?? '') || /\b(transform|perspective|filter)\b/.test(valueOf(candidate, 'will-change') ?? '');
  const visit = (parent: HTMLElement) => {
    if (contains(parent)) return;
    for (const child of Array.from(parent.children).filter(isObject)) {
      if (valueOf(child, 'position') === 'absolute') {
        fail('unsupported-stacking', 'Positioning this static object would change a descendant containing block. Pin or flatten that descendant into the object before reordering.');
      }
      if (!layerOf(child).positioned) visit(child);
    }
  };
  if (!layerOf(element).positioned) visit(element);
}

function writeLayer(element: HTMLElement, z: number): void {
  if (!layerOf(element).indexed) {
    writeProperty(element, 'position', 'relative');
    for (const property of ['inset', 'inset-inline', 'inset-block', 'inset-inline-start', 'inset-inline-end', 'inset-block-start', 'inset-block-end', 'left', 'top', 'right', 'bottom']) {
      element.style.removeProperty(property);
    }
  }
  writeProperty(element, 'z-index', String(z));
}

function planStacking(parent: Element, elements: HTMLElement[], activated?: HTMLElement): Map<HTMLElement, number> {
  const staticIndexes = elements.flatMap((element, index) => layerOf(element, parent).indexed || element === activated ? [] : [index]);
  const firstStatic = staticIndexes[0] ?? -1;
  const lastStatic = staticIndexes[staticIndexes.length - 1] ?? -1;
  if (staticIndexes.length && lastStatic - firstStatic + 1 !== staticIndexes.length) {
    fail('unsupported-stacking', 'Pin the intervening static objects to absolute boxes before inserting a layer between them; their flow layout must not move.');
  }
  const changes = new Map<HTMLElement, number>();
  elements.forEach((element, index) => {
    if (!layerOf(element, parent).indexed && element !== activated) return;
    changes.set(element, firstStatic < 0 ? index : index < firstStatic ? index - firstStatic : index - lastStatic);
  });
  const entries = paintEntries(parent, Array.from(parent.children).filter(isObject));
  const projected = new Map(entries.filter((entry) => changes.has(entry.element)).map((entry) => [entry.element, indexedEntry(entry, changes.get(entry.element) as number)]));
  validateEscaping(entries, projected);
  return changes;
}

function writeStacking(changes: Map<HTMLElement, number>): void {
  for (const [element, z] of changes) writeLayer(element, z);
}

export function groupElements(doc: Document, slideId: string, elementIds: string[]): string {
  const slide = findSlide(doc, slideId).element;
  const elements = selection(slide, elementIds.map((elementId) => ({ elementId })), 2);
  if (elements.some((element) => element.hasAttribute('data-ppt-group') || element.querySelector('[data-ppt-group]'))) {
    fail('target-invalid', 'Select top-level non-group objects; nested groups are not supported.');
  }
  const boxes = elements.map(boxOf);
  const ordered = stacking(slide);
  const selected = ordered.filter((element) => elements.includes(element));
  const anchor = selected[selected.length - 1];
  const entries = paintEntries(slide);
  const groupLayer = entries.find((entry) => entry.element === anchor) as PaintEntry;
  validateEscaping(entries, new Map(selected.map((element) => [element, groupLayer])));
  const used = new Set([slide, ...Array.from(slide.querySelectorAll('[data-ppt-el]'))].map((element) => element.getAttribute('data-ppt-el')?.trim() || '').filter(Boolean));
  const id = defaultIdFactory.elementId(used, 0);
  const group = doc.createElement('div');
  const area = bounds(boxes);
  const left = clean(area.left);
  const top = clean(area.top);
  const width = clean(area.right - area.left);
  const height = clean(area.bottom - area.top);
  const childPositions = boxes.map((box) => ({
    element: box.element,
    x: clean(box.x - area.left),
    y: clean(box.y - area.top)
  }));
  group.setAttribute('data-ppt-group', '');
  group.setAttribute('data-ppt-el', id);
  group.style.position = 'absolute';
  position(group, left, top);
  group.style.width = `${width}px`;
  group.style.height = `${height}px`;
  group.style.zIndex = String(groupLayer.layer.z);
  slide.insertBefore(group, anchor);
  for (const element of selected) group.appendChild(element);
  for (const child of childPositions) position(child.element, child.x, child.y);
  return id;
}

function validateGroupStyle(group: HTMLElement): void {
  const geometry = new Set(['position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'transform', 'transform-origin', 'translate', 'rotate', 'scale', 'perspective', 'offset-path', 'z-index', 'box-sizing']);
  const harmless: Record<string, string[]> = {
    display: ['block'],
    opacity: ['1'],
    overflow: ['visible'],
    background: ['transparent', 'none'],
    'background-color': ['transparent'],
    filter: ['none'],
    'backdrop-filter': ['none'],
    'will-change': ['auto'],
    isolation: ['auto'],
    'mix-blend-mode': ['normal'],
    contain: ['none'],
    'clip-path': ['none'],
    'mask': ['none'],
    'pointer-events': ['auto', 'inherit']
  };
  for (const [property, declaration] of declarationMap(group)) {
    if (geometry.has(property) || declaration.value === 'inherit') continue;
    if (/^(padding|border|margin)(-|$)/.test(property) && ['0', '0px', 'none'].includes(declaration.value)) continue;
    if (harmless[property]?.includes(declaration.value)) continue;
    fail('unsupported-group-style', `Remove or flatten the group's "${property}" style before ungrouping; removing this wrapper would change its children's appearance.`);
  }
}

export function ungroupElement(doc: Document, slideId: string, target: ElementTarget): string[] {
  const slide = findSlide(doc, slideId).element;
  const group = objectTarget(slide, target);
  if (!group.hasAttribute('data-ppt-group')) fail('target-invalid', 'Select a top-level group to ungroup.');
  if (Array.from(group.childNodes).some((node) => node.nodeType === 3 && node.textContent?.trim())) {
    fail('target-invalid', 'Wrap loose group text in an object before ungrouping.');
  }
  validateGroupStyle(group);
  const children = Array.from(group.children);
  if (children.length < 2 || children.some((child) => !isObject(child) || child.hasAttribute('data-ppt-group') || child.querySelector('[data-ppt-group]'))) {
    fail('target-invalid', 'Groups must contain at least two non-group object children and no notes or scripts.');
  }
  const ids = children.map((child) => {
    const id = child.getAttribute('data-ppt-el')?.trim();
    if (!id) fail('target-invalid', 'Every grouped child must have a stable data-ppt-el ID.');
    resolveTarget(slide, { elementId: id });
    return id;
  });
  const groupBox = boxOf(group);
  const groupTransform = transformOf(group, groupBox.width, groupBox.height);
  const boxes = children.map((child) => boxOf(child as HTMLElement));
  let ordered = stacking(slide);
  const childOrder = stacking(group);
  const zIndex = valueOf(group, 'z-index');
  const transform = valueOf(group, 'transform');
  if ((zIndex && zIndex !== 'auto') || (transform && transform !== 'none')) {
    ordered.splice(ordered.indexOf(group), 1, ...childOrder);
  } else {
    const flattened = Array.from(slide.children).flatMap((element) => element === group ? children : [element]).filter(isObject);
    ordered = stacking(slide, flattened);
  }
  const restored = boxes.map((box) => {
    const center = worldPoint(groupTransform, groupBox.x, groupBox.y, box.center.x, box.center.y);
    return {
      element: box.element,
      x: clean(center.x - box.width / 2),
      y: clean(center.y - box.height / 2),
      angle: normalizeAngle(groupTransform.angle + box.angle)
    };
  });
  const flattened = Array.from(slide.children).flatMap((element) => element === group ? children : [element]).filter(isObject);
  const entries = paintEntries(slide, flattened);
  const before = paintEntries(slide).sort(comparePaint).flatMap((entry) => entry.element !== group ? [entry.element] :
    layerOf(group).context ? paintEntries(group).sort(comparePaint).map((child) => child.element) : []);
  const after = [...entries].sort(comparePaint).map((entry) => entry.element);
  const layers = before.length === after.length && before.every((element, index) => element === after[index])
    ? new Map<HTMLElement, number>() : planStacking(slide, ordered);
  validateEscaping(entries, new Map(entries.filter((entry) => layers.has(entry.element)).map((entry) => [entry.element, indexedEntry(entry, layers.get(entry.element) as number)])));
  for (const box of restored) {
    position(box.element, box.x, box.y);
    for (const property of ['transform-origin', 'translate', 'rotate', 'scale', 'perspective', 'offset-path']) box.element.style.removeProperty(property);
    if (box.angle) writeProperty(box.element, 'transform', `rotate(${box.angle}deg)`);
    else box.element.style.removeProperty('transform');
  }
  for (const child of Array.from(group.childNodes)) slide.insertBefore(child, group);
  group.remove();
  writeStacking(layers);
  return ids;
}

export function setLocked(doc: Document, slideId: string, target: ElementTarget, locked: boolean): void {
  const element = objectTarget(findSlide(doc, slideId).element, target);
  if (locked) element.setAttribute('data-ppt-locked', 'true');
  else element.removeAttribute('data-ppt-locked');
}

function restoreDisplay(element: HTMLElement, metadata: string | null): void {
  if (metadata !== null && !metadata.trim()) metadata = null;
  if (metadata === null) {
    element.style.removeProperty('display');
    if (!element.getAttribute('style')?.trim()) element.removeAttribute('style');
    return;
  }
  const match = /^([a-z-]+(?:\s+[a-z-]+)*)(\s*!important)?$/i.exec(metadata.trim());
  if (!match) {
    fail('invalid-display', 'Saved display metadata is invalid; remove the data-ppt-display attribute before unhiding.');
  }
  element.style.removeProperty('display');
  setDeclaration(element, 'display', match[1], Boolean(match[2]));
}

// data-ppt-display stores the effective inline display declaration, including priority.
export function setHidden(doc: Document, slideId: string, target: ElementTarget, hidden: boolean): void {
  const element = objectTarget(findSlide(doc, slideId).element, target);
  if (hidden) {
    if (!element.hasAttribute(DISPLAY_ATTRIBUTE)) {
      const declaration = declarationMap(element).get('display');
      element.setAttribute(DISPLAY_ATTRIBUTE, declaration ? `${declaration.value}${declaration.important ? ' !important' : ''}` : '');
    }
    setDeclaration(element, 'display', 'none', true);
  } else if (element.hasAttribute(DISPLAY_ATTRIBUTE)) {
    const metadata = element.getAttribute(DISPLAY_ATTRIBUTE);
    restoreDisplay(element, metadata);
    element.removeAttribute(DISPLAY_ATTRIBUTE);
  }
}

function reorder(doc: Document, slideId: string, target: ElementTarget, direction: 'front' | 'back' | 'forward' | 'backward'): void {
  const slide = findSlide(doc, slideId).element;
  const element = objectTarget(slide, target);
  const ordered = stacking(slide);
  const entries = paintEntries(slide);
  const entry = entries.find((candidate) => candidate.element === element) as PaintEntry;
  const index = ordered.indexOf(element);
  const destination = direction === 'front' ? ordered.length - 1 : direction === 'back' ? 0 : direction === 'forward' ? Math.min(index + 1, ordered.length - 1) : Math.max(index - 1, 0);
  const towardFront = direction === 'front' || direction === 'forward';
  if (destination === index) {
    const painted = [...entries].sort(comparePaint);
    const edge = towardFront ? painted.slice(-painted.filter((item) => item.owner === element).length) : painted.slice(0, painted.filter((item) => item.owner === element).length);
    if (edge.every((item) => item.owner === element)) return;
  }
  ordered.splice(index, 1);
  ordered.splice(destination, 0, element);
  if (!entry.layer.indexed) validatePositioning(element);
  const candidates = new Set(entries.flatMap(({ layer }) => [layer.z, layer.z + 1, layer.z - 1]));
  for (const z of candidates) {
    if (!Number.isSafeInteger(z) || Math.abs(z) > 2147483647) continue;
    const proposed = indexedEntry(entry, z);
    if (!entries.filter((other) => other.owner !== element).every((other) =>
      Math.sign(comparePaint(proposed, other)) === Math.sign(destination - ordered.indexOf(other.owner)))) continue;
    validateEscaping(entries, new Map([[element, proposed]]));
    writeLayer(element, z);
    return;
  }
  writeStacking(planStacking(slide, ordered, element));
}

export function bringToFront(doc: Document, slideId: string, target: ElementTarget): void {
  reorder(doc, slideId, target, 'front');
}

export function sendToBack(doc: Document, slideId: string, target: ElementTarget): void {
  reorder(doc, slideId, target, 'back');
}

export function bringForward(doc: Document, slideId: string, target: ElementTarget): void {
  reorder(doc, slideId, target, 'forward');
}

export function sendBackward(doc: Document, slideId: string, target: ElementTarget): void {
  reorder(doc, slideId, target, 'backward');
}

export function alignElements(doc: Document, slideId: string, targets: ElementTarget[], mode: Alignment): void {
  const slide = findSlide(doc, slideId).element;
  if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode)) fail('invalid-alignment', 'Choose left, center, right, top, middle or bottom alignment.');
  const boxes = selection(slide, targets, 2).map(boxOf);
  const area = bounds(boxes);
  const placements = boxes.map((box) => {
    let dx = 0;
    let dy = 0;
    if (mode === 'left') dx = area.left - box.left;
    if (mode === 'center') dx = (area.left + area.right - box.left - box.right) / 2;
    if (mode === 'right') dx = area.right - box.right;
    if (mode === 'top') dy = area.top - box.top;
    if (mode === 'middle') dy = (area.top + area.bottom - box.top - box.bottom) / 2;
    if (mode === 'bottom') dy = area.bottom - box.bottom;
    return { element: box.element, x: clean(box.x + dx), y: clean(box.y + dy) };
  });
  for (const placement of placements) position(placement.element, placement.x, placement.y);
}

export function distributeElements(doc: Document, slideId: string, targets: ElementTarget[], axis: Axis): void {
  const slide = findSlide(doc, slideId).element;
  if (!['horizontal', 'vertical'].includes(axis)) fail('invalid-distribution', 'Choose horizontal or vertical distribution.');
  const boxes = selection(slide, targets, 3).map(boxOf);
  const horizontal = axis === 'horizontal';
  const start = horizontal ? 'left' : 'top';
  const end = horizontal ? 'right' : 'bottom';
  const domOrder = Array.from(slide.children);
  boxes.sort((a, b) => a[start] - b[start] || domOrder.indexOf(a.element) - domOrder.indexOf(b.element));
  const total = boxes.reduce((sum, box) => sum + box[end] - box[start], 0);
  const gap = (boxes[boxes.length - 1][end] - boxes[0][start] - total) / (boxes.length - 1);
  const placements: { element: HTMLElement; x: number; y: number }[] = [];
  let cursor = boxes[0][end] + gap;
  for (const box of boxes.slice(1, -1)) {
    const delta = cursor - box[start];
    placements.push({
      element: box.element,
      x: clean(box.x + (horizontal ? delta : 0)),
      y: clean(box.y + (horizontal ? 0 : delta))
    });
    cursor += box[end] - box[start] + gap;
  }
  for (const placement of placements) position(placement.element, placement.x, placement.y);
}
