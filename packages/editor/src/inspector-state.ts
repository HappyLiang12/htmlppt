import {
  detectSlides,
  setNotes,
  setTransition,
  type SlideInfo,
  type Transition
} from '@htmlppt/core';
import { normalizeAngle, type Point, type Rect } from './geometry';
import {
  elementAtPath,
  topLevelObjects,
  type SelectionTarget
} from './selection';
import {
  applyRotation,
  containingBlockOffset,
  pinToAbsolute,
  rectOf,
  rotationOf
} from './transform';

export type GeometryField = 'x' | 'y' | 'width' | 'height' | 'rotation';

export interface GeometryValues extends Rect {
  rotation: number;
}

export interface GeometrySnapshot {
  rect: Rect;
  rotation: number;
  /** Offset from the slide origin to the element's containing block. */
  offset: Point;
}

export interface ObjectSummary {
  /** Raw child-index path from the slide, matching SelectionTarget.path. */
  path: number[];
  tag: string;
  elementId: string | null;
  text: string;
}

export type SlideBackground =
  | { kind: 'color'; value: string }
  | { kind: 'gradient'; value: string }
  | { kind: 'image'; value: string };

export type BackgroundKind = SlideBackground['kind'];

export interface BackgroundValue {
  kind: BackgroundKind;
  value: string;
}

const NUMBER_INPUT = /^-?(?:\d+\.?\d*|\.\d+)$/;
const TEXT_SUMMARY_LIMIT = 48;

function isSizeField(field: GeometryField): boolean {
  return field === 'width' || field === 'height';
}

function isValidValue(field: GeometryField, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return !(isSizeField(field) && value <= 0);
}

function validSlide(master: Document, index: number): SlideInfo | null {
  return detectSlides(master)[index] ?? null;
}

/** Slide ids are addressable after normalization, including the body fallback. */
function addressableSlide(master: Document, slide: SlideInfo): boolean {
  return slide.hasId || slide.element === master.body;
}

export function readGeometry(element: Element, slide: Element): GeometryValues {
  return { ...rectOf(element, slide), rotation: rotationOf(element) };
}

/**
 * Captures what a numeric edit needs from the live iframe element: the
 * slide-space rect plus the distance to its absolute containing block.
 */
export function snapshotGeometry(
  element: Element,
  slide: Element
): GeometrySnapshot {
  return {
    rect: rectOf(element, slide),
    rotation: rotationOf(element),
    offset: containingBlockOffset(element, slide)
  };
}

export function formatGeometryValue(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Parses a numeric field input; null means the value must be rejected. */
export function parseGeometryValue(
  field: GeometryField,
  input: string
): number | null {
  const text = input.trim();
  if (!NUMBER_INPUT.test(text)) return null;
  const value = Number(text);
  if (!isValidValue(field, value)) return null;
  return field === 'rotation' ? normalizeAngle(value) : value;
}

/**
 * Applies one numeric field to the master element addressed by the selection
 * path. Flow objects are pinned on their first edit so position and size apply
 * without reflowing the authored layout.
 */
export function applyGeometryEdit(
  master: Document,
  selection: SelectionTarget,
  snapshot: GeometrySnapshot,
  field: GeometryField,
  value: number
): boolean {
  if (!isValidValue(field, value)) return false;
  const slide = validSlide(master, selection.slideIndex);
  if (!slide) return false;
  const element = elementAtPath(slide.element, selection.path);
  if (!element) return false;
  const style = (element as HTMLElement).style;
  if (!style) return false;

  if (field === 'rotation') {
    applyRotation(element, value);
    return true;
  }

  const positioned = style.position === 'absolute' || style.position === 'fixed';
  if (!positioned) {
    pinToAbsolute(element, snapshot.rect, slide.element);
  }
  const offset = snapshot.offset;

  if (field === 'x' || field === 'y') {
    const x = field === 'x' ? value : snapshot.rect.x;
    const y = field === 'y' ? value : snapshot.rect.y;
    style.left = `${x - offset.x}px`;
    style.top = `${y - offset.y}px`;
    return true;
  }

  if (!positioned) {
    // pinToAbsolute wrote slide-origin geometry; rebase the untouched axis to
    // the authored containing block.
    style.left = `${snapshot.rect.x - offset.x}px`;
    style.top = `${snapshot.rect.y - offset.y}px`;
  }
  if (field === 'width') style.width = `${value}px`;
  else style.height = `${value}px`;
  return true;
}

function textSummary(element: Element): string {
  const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return text.length > TEXT_SUMMARY_LIMIT
    ? `${text.slice(0, TEXT_SUMMARY_LIMIT - 1)}…`
    : text;
}

export function summarizeObjects(slide: Element): ObjectSummary[] {
  return topLevelObjects(slide).map((element) => ({
    path: [Array.from(slide.children).indexOf(element)],
    tag: element.tagName.toLowerCase(),
    elementId: element.getAttribute('data-ppt-el')?.trim() || null,
    text: textSummary(element)
  }));
}

function findNotesAside(slide: Element | null | undefined): Element | null {
  if (!slide) return null;
  return (
    Array.from(slide.children).find((child) =>
      child.hasAttribute('data-ppt-notes')
    ) ?? null
  );
}

export function notesOf(slide: Element | null | undefined): string {
  return findNotesAside(slide)?.textContent ?? '';
}

export function applyNotes(
  master: Document,
  slideIndex: number,
  notes: string
): boolean {
  const slide = validSlide(master, slideIndex);
  if (!slide || !addressableSlide(master, slide)) return false;
  setNotes(master, slide.id, notes);
  return true;
}

export function transitionOf(
  slide: Element | null | undefined
): Transition {
  const value = slide?.getAttribute('data-ppt-transition');
  return value === 'fade' || value === 'slide' ? value : 'none';
}

export function applyTransition(
  master: Document,
  slideIndex: number,
  transition: Transition
): boolean {
  const slide = validSlide(master, slideIndex);
  if (!slide || !addressableSlide(master, slide)) return false;
  setTransition(master, slide.id, transition);
  return true;
}

function unescapeCssString(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

function cssUrl(value: string): string {
  return `url("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

const URL_IMAGE = /^url\(\s*(['"]?)(.*?)\1\s*\)$/i;

/** Reads the inline slide background, if the deck authors one. */
export function backgroundOf(
  slide: Element | null | undefined
): BackgroundValue | null {
  const style = (slide as HTMLElement | null)?.style;
  if (!style) return null;

  const image = style.getPropertyValue('background-image').trim();
  const match = URL_IMAGE.exec(image);
  if (match) {
    return { kind: 'image', value: unescapeCssString(match[2] ?? '') };
  }

  const background = style.getPropertyValue('background').trim();
  if (image && /gradient\(/i.test(image)) {
    return { kind: 'gradient', value: background || image };
  }
  if (background) {
    return {
      kind: /gradient\(/i.test(background) ? 'gradient' : 'color',
      value: background
    };
  }

  const color = style.getPropertyValue('background-color').trim();
  return color ? { kind: 'color', value: color } : null;
}

/**
 * Writes exactly one background kind inline and clears the competing values.
 * Setting the shorthand would otherwise leave an old background-image behind.
 */
export function applyBackground(
  master: Document,
  slideIndex: number,
  background: SlideBackground
): boolean {
  const value = background.value.trim();
  if (!value || /[\r\n]/.test(value)) return false;
  const slide = validSlide(master, slideIndex);
  const element = slide?.element as HTMLElement | undefined;
  const style = element?.style;
  if (!style) return false;

  style.removeProperty('background');
  style.removeProperty('background-color');
  style.removeProperty('background-image');

  if (background.kind === 'image') {
    style.setProperty('background-image', cssUrl(value));
  } else {
    style.setProperty('background', value);
  }
  return true;
}
