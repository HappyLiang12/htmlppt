import { setShapeText } from './appearance.js';
import { validateImageSource } from './images.js';
import { appendObject } from './mutations.js';
import { DeckMutationError } from './target.js';

export type ShapeKind =
  | 'rect'
  | 'rounded-rect'
  | 'ellipse'
  | 'triangle'
  | 'line'
  | 'arrow';

export interface InsertRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InsertTextBoxOptions extends InsertRect {
  text: string;
}

export interface InsertShapeOptions extends InsertRect {
  shape: ShapeKind;
  fill?: string;
  stroke?: string;
  radius?: number;
  strokeWidth?: number;
  text?: string;
}

export interface InsertImageOptions extends InsertRect {
  source: string;
  alt?: string;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function fail(message: string): never {
  throw new DeckMutationError('invalid-insert', message);
}

function checkGeometry(options: InsertRect): void {
  for (const [name, value] of Object.entries({
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height
  })) {
    if (!Number.isFinite(value)) {
      fail(`Insertion ${name} must be a finite number.`);
    }
  }
  if (options.width <= 0 || options.height <= 0) {
    fail('Insertion width and height must be positive.');
  }
}

function positionStyle(
  element: HTMLElement | SVGElement,
  options: InsertRect
): void {
  element.style.position = 'absolute';
  element.style.left = `${options.x}px`;
  element.style.top = `${options.y}px`;
  element.style.width = `${options.width}px`;
  element.style.height = `${options.height}px`;
  element.style.margin = '0';
}

export function insertTextBox(
  slide: Element,
  options: InsertTextBoxOptions
): Element {
  checkGeometry(options);
  const element = slide.ownerDocument.createElement('div');
  positionStyle(element, options);
  element.style.padding = '8px';
  element.style.boxSizing = 'border-box';
  element.style.overflow = 'hidden';
  element.textContent = options.text;
  return appendObject(slide, element);
}

export function insertShape(
  slide: Element,
  options: InsertShapeOptions
): Element {
  checkGeometry(options);
  const document = slide.ownerDocument;
  const fill = options.fill ?? '#4f7cff';
  if (options.shape === 'line' || options.shape === 'arrow') {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    positionStyle(svg, options);
    svg.setAttribute('viewBox', `0 0 ${options.width} ${options.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const stroke = options.stroke ?? fill;
    const strokeWidth = options.strokeWidth ?? Math.min(8, options.height);
    if (options.shape === 'line') {
      svg.appendChild(
        lineElement(document, 0, options.height / 2, options.width, options.height / 2, stroke, strokeWidth)
      );
    } else {
      const head = Math.max(
        6,
        Math.min(options.width * 0.3, options.height * 0.8, 48)
      );
      const half = Math.max(
        4,
        Math.min(options.height / 2, options.width / 4, 20)
      );
      if (options.width > head) {
        svg.appendChild(
          lineElement(
            document,
            0,
            options.height / 2,
            options.width - head,
            options.height / 2,
            stroke,
            strokeWidth
          )
        );
      }
      const headElement = document.createElementNS(SVG_NAMESPACE, 'polygon');
      headElement.setAttribute(
        'points',
        `${options.width},${options.height / 2} ${options.width - head},${options.height / 2 - half} ${options.width - head},${options.height / 2 + half}`
      );
      headElement.setAttribute('fill', stroke);
      svg.appendChild(headElement);
    }
    if (options.text?.trim()) setShapeText(svg, options.text);
    return appendObject(slide, svg);
  }

  if (options.shape === 'triangle') {
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    positionStyle(svg, options);
    svg.setAttribute('viewBox', `0 0 ${options.width} ${options.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const polygon = document.createElementNS(SVG_NAMESPACE, 'polygon');
    polygon.setAttribute(
      'points',
      `${options.width / 2},0 ${options.width},${options.height} 0,${options.height}`
    );
    polygon.setAttribute('fill', fill);
    if (options.stroke) {
      polygon.setAttribute('stroke', options.stroke);
      polygon.setAttribute(
        'stroke-width',
        String(options.strokeWidth ?? 2)
      );
    }
    svg.appendChild(polygon);
    if (options.text?.trim()) setShapeText(svg, options.text);
    return appendObject(slide, svg);
  }

  if (
    options.shape !== 'rect' &&
    options.shape !== 'rounded-rect' &&
    options.shape !== 'ellipse'
  ) {
    fail(`Unsupported shape "${String(options.shape)}".`);
  }
  const element = document.createElement('div');
  positionStyle(element, options);
  element.style.background = fill;
  element.style.boxSizing = 'border-box';
  if (options.stroke) {
    element.style.border = `${options.strokeWidth ?? 2}px solid ${options.stroke}`;
  }
  if (options.shape === 'ellipse') {
    element.style.borderRadius = '50%';
  } else if (options.shape === 'rounded-rect') {
    element.style.borderRadius = `${options.radius ?? 24}px`;
  } else if (options.radius !== undefined) {
    element.style.borderRadius = `${options.radius}px`;
  }
  if (options.text !== undefined) element.textContent = options.text;
  return appendObject(slide, element);
}

function lineElement(
  document: Document,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  strokeWidth: number
): Element {
  const line = document.createElementNS(SVG_NAMESPACE, 'line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-width', String(strokeWidth));
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  return line;
}

export function insertImage(
  slide: Element,
  options: InsertImageOptions
): Element {
  checkGeometry(options);
  const element = slide.ownerDocument.createElement('img');
  positionStyle(element, options);
  element.style.objectFit = 'fill';
  element.setAttribute('src', validateImageSource(options.source));
  element.setAttribute('alt', options.alt ?? '');
  return appendObject(slide, element);
}
