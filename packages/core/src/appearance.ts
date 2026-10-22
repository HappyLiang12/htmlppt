import { validateImageSource } from './images.js';
import { DeckMutationError } from './target.js';

export interface ShapeAppearance {
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number | null;
  radius?: number | null;
  opacity?: number | null;
}

export interface ShapeAppearanceValues {
  fill: string;
  stroke: string;
  strokeWidth: string;
  radius: string;
  opacity: string;
}

export interface ImageCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const CROP_ATTRIBUTE = 'data-ppt-crop';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_ALT_LENGTH = 1000;

function fail(message: string): never {
  throw new DeckMutationError('invalid-appearance', message);
}

function failImage(message: string): never {
  throw new DeckMutationError('invalid-image', message);
}

function isSvg(element: Element): element is SVGElement {
  return element.tagName.toLowerCase() === 'svg';
}

function paintTargets(element: SVGElement): Element[] {
  return Array.from(
    element.querySelectorAll('line, polygon, polyline, path, rect, circle, ellipse')
  );
}

function validColor(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) fail(`${label} must not be empty.`);
  if (/url\s*\(/i.test(trimmed)) {
    fail(`${label} must be a color, not a URL reference.`);
  }
  return trimmed;
}

/**
 * Applies fill, border, radius, and opacity to an inserted shape. Div shapes
 * use styles; SVG shapes receive attributes so exported markup stays portable.
 */
export function setShapeAppearance(
  element: Element,
  appearance: ShapeAppearance
): void {
  if (isSvg(element)) {
    const targets = paintTargets(element);
    if (targets.length === 0) fail('The SVG shape has no paintable geometry.');
    if ('fill' in appearance && appearance.fill !== undefined) {
      const fill = appearance.fill === null || appearance.fill === ''
        ? null
        : validColor(appearance.fill, 'Fill');
      for (const target of targets) {
        if (target.tagName.toLowerCase() === 'line') continue;
        if (fill === null) target.removeAttribute('fill');
        else target.setAttribute('fill', fill);
      }
    }
    if ('stroke' in appearance && appearance.stroke !== undefined) {
      const stroke = appearance.stroke === null || appearance.stroke === ''
        ? null
        : validColor(appearance.stroke, 'Stroke');
      for (const target of targets) {
        if (stroke === null) target.removeAttribute('stroke');
        else target.setAttribute('stroke', stroke);
      }
    }
    if ('strokeWidth' in appearance) {
      const width = appearance.strokeWidth;
      if (width !== null && width !== undefined) {
        if (!Number.isFinite(width) || width < 0) {
          fail('Stroke width must be a non-negative number.');
        }
        for (const target of targets) {
          if (width === 0) target.removeAttribute('stroke-width');
          else target.setAttribute('stroke-width', String(width));
        }
      }
    }
    if ('radius' in appearance && appearance.radius !== null) {
      fail('SVG shapes do not support a corner radius.');
    }
    if ('opacity' in appearance) {
      applyOpacity(element, appearance.opacity);
    }
    return;
  }

  const html = element as HTMLElement;
  if (!html.style) fail('This element cannot carry shape styles.');
  if ('fill' in appearance && appearance.fill !== undefined) {
    if (appearance.fill === null || appearance.fill === '') {
      html.style.removeProperty('background');
      html.style.removeProperty('background-color');
    } else {
      html.style.backgroundColor = validColor(appearance.fill, 'Fill');
    }
  }
  if ('stroke' in appearance || 'strokeWidth' in appearance) {
    const currentWidth = parseFloat(html.style.borderTopWidth || '0');
    const width =
      appearance.strokeWidth === null || appearance.strokeWidth === undefined
        ? currentWidth
        : appearance.strokeWidth;
    if (!Number.isFinite(width) || width < 0) {
      fail('Stroke width must be a non-negative number.');
    }
    const color =
      appearance.stroke === undefined
        ? html.style.borderTopColor
        : appearance.stroke === null || appearance.stroke === ''
          ? ''
          : validColor(appearance.stroke, 'Stroke');
    if (width > 0 && color) {
      html.style.borderStyle = 'solid';
      html.style.borderWidth = `${width}px`;
      html.style.borderColor = color;
    } else {
      for (const property of ['border', 'border-width', 'border-style', 'border-color']) {
        html.style.removeProperty(property);
      }
    }
  }
  if ('radius' in appearance && appearance.radius !== undefined) {
    const radius = appearance.radius;
    if (radius === null) {
      html.style.removeProperty('border-radius');
    } else {
      if (!Number.isFinite(radius) || radius < 0) {
        fail('Corner radius must be a non-negative number.');
      }
      html.style.borderRadius = `${radius}px`;
    }
  }
  if ('opacity' in appearance) {
    applyOpacity(html, appearance.opacity);
  }
}

function applyOpacity(element: Element, opacity: number | null | undefined): void {
  const html = element as HTMLElement;
  if (opacity === null || opacity === undefined) {
    html.style.removeProperty('opacity');
    return;
  }
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    fail('Opacity must be between 0 and 1.');
  }
  html.style.opacity = String(opacity);
}

export function readShapeAppearance(element: Element): ShapeAppearanceValues {
  if (isSvg(element)) {
    const targets = paintTargets(element);
    const paint = targets.find((target) => target.tagName.toLowerCase() !== 'line') ??
      targets[0];
    return {
      fill: paint?.getAttribute('fill') ?? '',
      stroke: paint?.getAttribute('stroke') ?? '',
      strokeWidth: paint?.getAttribute('stroke-width') ?? '',
      radius: '',
      opacity: (element as SVGElement).style.opacity
    };
  }
  const html = element as HTMLElement;
  const borderWidth = parseFloat(html.style.borderTopWidth || '0');
  return {
    fill: html.style.background || html.style.backgroundColor || '',
    stroke: borderWidth > 0 ? html.style.borderTopColor : '',
    strokeWidth: borderWidth > 0 ? html.style.borderTopWidth : '',
    radius: html.style.borderRadius ?? '',
    opacity: html.style.opacity
  };
}

/**
 * Sets text on a div shape or on an SVG label. SVG text is not inline-editable,
 * so the editor exposes it through the appearance panel.
 */
export function setShapeText(element: Element, text: string): void {
  if (isSvg(element)) {
    let label = element.querySelector('text');
    if (!text.trim()) {
      label?.remove();
      return;
    }
    if (!label) {
      label = element.ownerDocument.createElementNS(SVG_NAMESPACE, 'text');
      label.setAttribute('x', '50%');
      label.setAttribute('y', '50%');
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.setAttribute('font-size', '16');
      label.setAttribute('fill', '#ffffff');
      element.appendChild(label);
    }
    label.textContent = text;
    return;
  }
  if (element.tagName.toLowerCase() === 'img') {
    fail('Images do not contain shape text.');
  }
  const html = element as HTMLElement;
  if (!('textContent' in html)) fail('This element cannot carry shape text.');
  html.textContent = text;
}

export function replaceImageSource(element: Element, source: string): void {
  if (element.tagName.toLowerCase() !== 'img') {
    failImage('Only image objects can be replaced.');
  }
  const validated = validateImageSource(source);
  element.setAttribute('src', validated);
}

export function setImageAlt(element: Element, alt: string): void {
  if (element.tagName.toLowerCase() !== 'img') {
    failImage('Only image objects have alt text.');
  }
  const value = alt.replace(/[\r\n]+/g, ' ').trim();
  if (value.length > MAX_ALT_LENGTH) {
    failImage(`Alt text must be at most ${MAX_ALT_LENGTH} characters.`);
  }
  element.setAttribute('alt', value);
}

export function setImageCrop(element: Element, crop: ImageCrop | null): void {
  if (element.tagName.toLowerCase() !== 'img') {
    failImage('Only image objects can be cropped.');
  }
  const html = element as HTMLElement;
  if (crop === null) {
    element.removeAttribute(CROP_ATTRIBUTE);
    html.style.removeProperty('clip-path');
    return;
  }
  const values = [crop.top, crop.right, crop.bottom, crop.left];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 90)) {
    failImage('Crop insets must be between 0 and 90 percent.');
  }
  if (crop.top + crop.bottom >= 100 || crop.left + crop.right >= 100) {
    failImage('Crop leaves no visible image; reduce the insets.');
  }
  const normalized = values.map((value) => Math.round(value * 100) / 100);
  if (normalized.every((value) => value === 0)) {
    element.removeAttribute(CROP_ATTRIBUTE);
    html.style.removeProperty('clip-path');
    return;
  }
  const [top, right, bottom, left] = normalized as [number, number, number, number];
  element.setAttribute(CROP_ATTRIBUTE, `${top} ${right} ${bottom} ${left}`);
  html.style.clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`;
}

export function imageCropOf(element: Element): ImageCrop | null {
  const raw = element.getAttribute(CROP_ATTRIBUTE);
  if (!raw) return null;
  const values = raw.split(/\s+/).map((value) => Number(value));
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 90)
  ) {
    return null;
  }
  const [top, right, bottom, left] = values as [number, number, number, number];
  if (top + bottom >= 100 || left + right >= 100) return null;
  return { top, right, bottom, left };
}
