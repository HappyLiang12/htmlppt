import {
  alignElements,
  bringForward,
  bringToFront,
  detectSlides,
  distributeElements,
  groupElements,
  sendBackward,
  sendToBack,
  serializeDeck,
  setHidden,
  setLocked,
  ungroupElement,
  type ElementTarget
} from '@htmlppt/core';
import type { Point, Rect } from '../geometry';
import { elementAtPath, topLevelObjects, type SelectionTarget } from '../selection';

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';
export type OrderDirection = 'front' | 'forward' | 'backward' | 'back';

export type ObjectCommand =
  | { type: 'group' }
  | { type: 'ungroup' }
  | { type: 'align'; mode: AlignMode }
  | { type: 'distribute'; axis: DistributeAxis }
  | { type: 'order'; direction: OrderDirection }
  | { type: 'lock'; locked: boolean }
  | { type: 'hide'; hidden: boolean };

export interface ObjectMeasurement {
  target: SelectionTarget;
  rect: Rect;
  offset: Point;
}

export interface ObjectCommandResult {
  changed: boolean;
  targets: SelectionTarget[];
}

export const LOCKED_ATTRIBUTE = 'data-ppt-locked';
export const GROUP_ATTRIBUTE = 'data-ppt-group';

export function isLockedElement(element: Element | null | undefined): boolean {
  return element?.getAttribute(LOCKED_ATTRIBUTE) === 'true';
}

export function isGroupElement(element: Element | null | undefined): boolean {
  return element?.hasAttribute(GROUP_ATTRIBUTE) === true;
}

export function isHiddenElement(element: Element | null | undefined): boolean {
  return (element as HTMLElement | null)?.style?.display === 'none';
}

function geometryCommand(command: ObjectCommand): boolean {
  return (
    command.type === 'group' ||
    command.type === 'align' ||
    command.type === 'distribute'
  );
}

function minimumCount(command: ObjectCommand): number {
  if (command.type === 'group' || command.type === 'align') return 2;
  if (command.type === 'distribute') return 3;
  return 1;
}

function targetOf(element: Element, slideIndex: number): SelectionTarget {
  return {
    slideIndex,
    path: [],
    elementId: element.getAttribute('data-ppt-el')?.trim() || null
  };
}

function idTarget(element: Element): ElementTarget {
  const id = element.getAttribute('data-ppt-el')?.trim();
  return id ? { elementId: id } : { path: [] };
}

function resolveTargets(
  master: Document,
  slideIndex: number,
  elements: readonly Element[]
): SelectionTarget[] {
  const slide = detectSlides(master)[slideIndex];
  if (!slide) return [];
  const objects = topLevelObjects(slide.element);
  return elements.flatMap((element) => {
    const id = element.getAttribute('data-ppt-el')?.trim();
    const live = id
      ? objects.find((candidate) => candidate.getAttribute('data-ppt-el')?.trim() === id)
      : element;
    if (!live) return [];
    const index = Array.from(slide.element.children).indexOf(live);
    if (index < 0) return [];
    return [{
      ...targetOf(live, slideIndex),
      path: [index]
    }];
  });
}

function stableTarget(master: Document, slideIndex: number, target: SelectionTarget): Element {
  const slide = detectSlides(master)[slideIndex];
  if (!slide) throw new Error('The active slide is missing from the deck.');
  const element = target.elementId
    ? topLevelObjects(slide.element).find(
        (candidate) => candidate.getAttribute('data-ppt-el')?.trim() === target.elementId
      ) ?? null
    : elementAtPath(slide.element, target.path);
  if (!element || element.parentElement !== slide.element) {
    throw new Error('Select top-level slide objects before running this action.');
  }
  if (!topLevelObjects(slide.element).includes(element)) {
    throw new Error('Notes, scripts and styles are not editable objects.');
  }
  return element;
}

function requireUnlocked(element: Element): void {
  if (isLockedElement(element)) {
    throw new Error('Unlock the selected object before changing it.');
  }
}

function requireVisible(element: Element): void {
  if (isHiddenElement(element)) {
    throw new Error('Show the selected object before changing it.');
  }
}

function pinMeasured(
  element: Element,
  measurement: ObjectMeasurement,
  target: SelectionTarget
): void {
  if (measurement.target.path.join('.') !== target.path.join('.')) {
    throw new Error('Object measurements do not match the current selection.');
  }
  if (measurement.offset.x !== 0 || measurement.offset.y !== 0) {
    throw new Error('The object is positioned against a transformed wrapper. Pin it to the slide before grouping or aligning.');
  }
  const style = (element as HTMLElement).style;
  style.position = 'absolute';
  style.left = `${measurement.rect.x}px`;
  style.top = `${measurement.rect.y}px`;
  style.width = `${measurement.rect.width}px`;
  style.height = `${measurement.rect.height}px`;
  style.margin = '0';
  style.boxSizing = 'border-box';
  style.removeProperty('right');
  style.removeProperty('bottom');
}

interface Prepared {
  slide: ReturnType<typeof detectSlides>[number];
  elements: Element[];
  ids: string[];
}

function prepare(
  master: Document,
  slideIndex: number,
  command: ObjectCommand,
  targets: readonly SelectionTarget[],
  measurements: readonly ObjectMeasurement[]
): Prepared {
  const slide = detectSlides(master)[slideIndex];
  if (!slide) throw new Error('The active slide is missing from the deck.');
  if (targets.length < minimumCount(command)) {
    throw new Error(`Select at least ${minimumCount(command)} objects for this action.`);
  }
  if (
    command.type === 'ungroup' ||
    command.type === 'order' ||
    command.type === 'lock' ||
    command.type === 'hide'
  ) {
    if (targets.length !== 1) throw new Error('Select exactly one object for this action.');
  }

  const seen = new Set<string>();
  const elements = targets.map((target) => {
    const key = target.elementId ?? target.path.join('.');
    if (seen.has(key)) throw new Error('Select each object only once.');
    seen.add(key);
    const element = stableTarget(master, slideIndex, target);
    if (command.type === 'ungroup') {
      if (!isGroupElement(element)) throw new Error('Select a group to ungroup.');
      requireUnlocked(element);
      requireVisible(element);
    } else if (command.type === 'lock') {
      // Unlocking must stay available while the object is locked.
    } else if (command.type === 'hide') {
      // Showing must stay available while the object is hidden.
    } else {
      requireUnlocked(element);
      requireVisible(element);
    }
    return element;
  });

  if (command.type === 'group') {
    for (const element of elements) {
      if (isGroupElement(element) || element.querySelector(`[${GROUP_ATTRIBUTE}]`)) {
        throw new Error('Select top-level non-group objects; nested groups are not supported.');
      }
    }
  }

  if (geometryCommand(command)) {
    if (measurements.length !== targets.length) {
      throw new Error('Every selected object must be measured before changing layout.');
    }
    elements.forEach((element, index) => {
      pinMeasured(element, measurements[index] as ObjectMeasurement, targets[index] as SelectionTarget);
    });
  }

  const ids = elements.map((element) => element.getAttribute('data-ppt-el')?.trim() ?? '');
  if (ids.some((id) => !id)) {
    throw new Error('Objects need stable data-ppt-el IDs before object actions.');
  }
  return { slide, elements, ids };
}

function mutate(
  master: Document,
  slideIndex: number,
  command: ObjectCommand,
  targets: readonly SelectionTarget[],
  measurements: readonly ObjectMeasurement[]
): Element[] {
  const { slide, elements, ids } = prepare(master, slideIndex, command, targets, measurements);
  const slideId = slide.id;
  switch (command.type) {
    case 'group': {
      const id = groupElements(master, slideId, ids);
      const created = topLevelObjects(slide.element).find(
        (candidate) => candidate.getAttribute('data-ppt-el')?.trim() === id
      );
      if (!created) throw new Error('The group was created without a resolvable ID.');
      return [created];
    }
    case 'ungroup': {
      const childIds = ungroupElement(master, slideId, idTarget(elements[0] as Element));
      const objects = topLevelObjects(slide.element);
      return childIds.flatMap((id) => {
        const child = objects.find(
          (candidate) => candidate.getAttribute('data-ppt-el')?.trim() === id
        );
        return child ? [child] : [];
      });
    }
    case 'align':
      alignElements(master, slideId, ids.map((elementId) => ({ elementId })), command.mode);
      return elements;
    case 'distribute':
      distributeElements(master, slideId, ids.map((elementId) => ({ elementId })), command.axis);
      return elements;
    case 'order': {
      const target: ElementTarget = { elementId: ids[0] as string };
      if (command.direction === 'front') bringToFront(master, slideId, target);
      else if (command.direction === 'forward') bringForward(master, slideId, target);
      else if (command.direction === 'backward') sendBackward(master, slideId, target);
      else sendToBack(master, slideId, target);
      return elements;
    }
    case 'lock':
      for (const id of ids) setLocked(master, slideId, { elementId: id }, command.locked);
      return elements;
    case 'hide':
      for (const id of ids) setHidden(master, slideId, { elementId: id }, command.hidden);
      return elements;
  }
}

function execute(
  master: Document,
  slideIndex: number,
  command: ObjectCommand,
  targets: readonly SelectionTarget[],
  measurements: readonly ObjectMeasurement[],
  measure: boolean
): ObjectCommandResult {
  const before = measure ? serializeDeck(master) : '';
  const elements = mutate(master, slideIndex, command, targets, measurements);
  if (measure && serializeDeck(master) === before) {
    return { changed: false, targets: [] };
  }
  return {
    changed: true,
    targets: resolveTargets(master, slideIndex, elements)
  };
}

/**
 * Runs one object command atomically. A cloned document is validated first, so
 * pinning or core rejection cannot leave a half-mutated master behind. The
 * returned targets are resolved by stable IDs after the structural change.
 */
export function applyObjectCommand(
  master: Document,
  slideIndex: number,
  command: ObjectCommand,
  targets: readonly SelectionTarget[],
  measurements: readonly ObjectMeasurement[] = []
): ObjectCommandResult {
  const probe = master.cloneNode(true) as Document;
  const probeResult = execute(probe, slideIndex, command, targets, measurements, true);
  if (!probeResult.changed) return { changed: false, targets: [] };
  return execute(master, slideIndex, command, targets, measurements, false);
}
