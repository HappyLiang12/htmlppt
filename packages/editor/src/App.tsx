import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { detectSlides, type Transition } from '@htmlppt/core';
import {
  nudge,
  normalizeAngle,
  snapRect,
  snapResizeRect,
  toDesignPoint,
  type Guide,
  type Handle,
  type Point,
  type Rect
} from './geometry';
import {
  elementAtPath,
  selectionFromEvent,
  topLevelObjects,
  type SelectionTarget
} from './selection';
import {
  buildSlideSrcDoc,
  commitSlide,
  EDITING_ATTRIBUTE,
  frameSlideElement
} from './slide-doc';
import {
  angleDelta,
  applyRect,
  applyRotation,
  centerOf,
  moveTargets,
  pinToAbsolute,
  rectOf,
  resizeTarget,
  rotationFromPointer,
  rotationOf,
  snapAngle,
  type TransformTarget
} from './transform';
import {
  applyBackground,
  applyGeometryEdit,
  applyInspectorEdit,
  applyNotes,
  applyTransition,
  clearBackground,
  notesOf,
  readGeometry,
  snapshotGeometry,
  type GeometryField,
  type GeometryValues,
  type SlideBackground
} from './inspector-state';
import {
  CanvasOverlay,
  type SelectionBox
} from './components/CanvasOverlay';
import { Inspector } from './components/Inspector';
import { SorterView } from './components/SorterView';
import { ThumbnailRail } from './components/ThumbnailRail';
import { Toolbar, type EditorView } from './components/Toolbar';
import {
  addSlideAfterActive,
  deleteSlideAt,
  duplicateActiveSlide,
  reorderSlides,
  type SlideOpsContext
} from './slide-ops';
import { mapShortcut, isEditableShortcutTarget } from './shortcuts';
import { useDeckController } from './use-deck-controller';

const TEXT_EDITABLE_SELECTOR =
  'h1, h2, h3, p, li, span, td, th, blockquote, figcaption';

const SNAP_THRESHOLD_SCREEN_PX = 6;
const MIN_RESIZE_DESIGN_PX = 4;
const DRAG_THRESHOLD_SCREEN_PX = 2;
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
const ZOOM_STEP = 1.2;

function sameSelection(a: SelectionTarget, b: SelectionTarget): boolean {
  return (
    a.slideIndex === b.slideIndex &&
    a.path.length === b.path.length &&
    a.path.every((index, position) => index === b.path[position])
  );
}

interface GestureBase {
  pointerId: number;
  start: Point;
  moved: boolean;
  altKey: boolean;
  /** The iframe-rendered slide, used for containing-block geometry. */
  slide: Element;
}

interface DragTarget extends TransformTarget {
  path: number[];
  elementId: string | null;
  rotation: number;
}

interface DragSession extends GestureBase {
  kind: 'drag';
  /** Slide origin inside the iframe, for iframe-space overlay coordinates. */
  slideOffset: Point;
  targets: DragTarget[];
  siblingRects: Rect[];
  bounds: Rect;
}

interface ResizeSession extends GestureBase {
  kind: 'resize';
  /** Slide origin inside the iframe, for iframe-space overlay coordinates. */
  slideOffset: Point;
  target: TransformTarget;
  path: number[];
  elementId: string | null;
  handle: Handle;
  siblingRects: Rect[];
  bounds: Rect;
}

interface RotateSession extends GestureBase {
  kind: 'rotate';
  target: TransformTarget;
  path: number[];
  elementId: string | null;
  center: Point;
  startPointerAngle: number;
  startRotation: number;
}

type TransformSession = DragSession | ResizeSession | RotateSession;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function eventElement(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  return node && node.nodeType === 1 ? (node as Element) : null;
}

function isEditableTarget(element: Element | null): boolean {
  if (!element) return false;
  if (element.closest(`[${EDITING_ATTRIBUTE}]`)) return true;
  if ((element as HTMLElement).isContentEditable) return true;
  const tag = element.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function designPointInsideFrame(
  clientX: number,
  clientY: number,
  slide: Element
): Point {
  const slideRect = slide.getBoundingClientRect();
  return { x: clientX - slideRect.left, y: clientY - slideRect.top };
}

function siblingRectsOf(slide: Element, elements: readonly Element[]): Rect[] {
  return topLevelObjects(slide)
    .filter((other) => !elements.includes(other))
    .map((other) => rectOf(other, slide));
}

function boundsOf(width: number, height: number): Rect {
  return { x: 0, y: 0, width, height };
}

function frameRectOf(rect: Rect, offset: Point): Rect {
  return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
}

function frameGuidesOf(guides: Guide[], offset: Point): Guide[] {
  return guides.map((guide) => ({
    ...guide,
    position:
      guide.position + (guide.axis === 'x' ? offset.x : offset.y)
  }));
}

function slideOffsetOf(slide: Element): Point {
  const rect = slide.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}

export function App() {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const canvas = useRef<HTMLElement | null>(null);
  const { state, actions } = useDeckController();
  const {
    slides,
    activeIndex,
    srcDoc,
    scale,
    status,
    error,
    filePath,
    selection,
    selections,
    master
  } = state;

  const activeSlide = slides[activeIndex];

  const [view, setView] = useState<EditorView>('normal');
  const [selectionBoxes, setSelectionBoxes] = useState<SelectionBox[]>([]);
  const [selectionGeometry, setSelectionGeometry] =
    useState<GeometryValues | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [slideOpError, setSlideOpError] = useState('');

  const sessionRef = useRef<TransformSession | null>(null);
  const detachSessionRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const keyDownRef = useRef<
    (event: KeyboardEvent, activeDocument: Document | null) => void
  >(() => undefined);
  const framePointerDownRef = useRef<
    (event: PointerEvent, frameDocument: Document) => void
  >(() => undefined);

  const slideOpsContext = useCallback(
    (): SlideOpsContext => ({
      master: stateRef.current.master,
      slides: stateRef.current.slides,
      activeIndex: stateRef.current.activeIndex,
      commit: actionsRef.current.commit,
      showSlide: actionsRef.current.showSlide
    }),
    []
  );

  const slideOpBusyRef = useRef(false);

  /**
   * Serializes toolbar and sorter slide operations. Each operation navigates
   * only after its save resolves, so a second click while one is in flight
   * would read a stale active index and act on the wrong slide.
   */
  const runSlideOp = useCallback(async (operation: () => Promise<unknown>) => {
    if (slideOpBusyRef.current) return;
    slideOpBusyRef.current = true;
    setSlideOpError('');
    try {
      await operation();
    } catch (cause) {
      // Slide operations report expected failures as return values; anything
      // thrown here is unexpected and must reach the error banner.
      setSlideOpError(errorMessage(cause));
    } finally {
      slideOpBusyRef.current = false;
    }
  }, []);

  const handleAddSlide = useCallback(() => {
    void runSlideOp(() => addSlideAfterActive(slideOpsContext()));
  }, [runSlideOp, slideOpsContext]);

  const handleDuplicateSlide = useCallback(
    (index?: number) => {
      void runSlideOp(() => duplicateActiveSlide(slideOpsContext(), index));
    },
    [runSlideOp, slideOpsContext]
  );

  const handleDeleteSlide = useCallback(
    (index?: number) => {
      void runSlideOp(() => deleteSlideAt(slideOpsContext(), index));
    },
    [runSlideOp, slideOpsContext]
  );

  const handleReorderSlides = useCallback(
    (slideIds: string[]) => {
      void runSlideOp(() => reorderSlides(slideOpsContext(), slideIds));
    },
    [runSlideOp, slideOpsContext]
  );

  /**
   * Inspector edits mutate the master directly; the resulting srcDoc reload
   * renders them without reconciling the iframe clone over the master. The
   * mutation defaults to a no-op for edits applied before commit, so a
   * rejected edit never reaches the history or the save queue.
   */
  const commitMasterDocument = useCallback(
    async (mutate: (master: Document) => void = () => undefined) => {
      try {
        await actionsRef.current.commitMaster(mutate);
        // A successful inspector commit proves the editor is healthy again;
        // do not leave an earlier slide-op failure in the banner.
        setSlideOpError('');
      } catch {
        // The controller surfaced the failure in its status and error state.
      }
    },
    []
  );

  const clearOverlay = useCallback(() => {
    setSelectionBoxes([]);
    setSelectionGeometry(null);
    setGuides([]);
  }, []);

  const handleSelectObject = useCallback((path: number[]) => {
    const current = stateRef.current;
    const slideInfo = current.slides[current.activeIndex];
    if (!slideInfo) return;
    const element = elementAtPath(slideInfo.element, path);
    if (!element) return;
    actionsRef.current.select({
      slideIndex: current.activeIndex,
      path,
      elementId: element.getAttribute('data-ppt-el')?.trim() || null
    });
  }, []);

  const handleGeometryCommit = useCallback(
    (field: GeometryField, value: number): boolean => {
      const current = stateRef.current;
      const selected = current.selection;
      const slideInfo = current.slides[current.activeIndex];
      const frameDocument = frame.current?.contentDocument;
      if (
        !selected ||
        current.selections.length !== 1 ||
        !slideInfo ||
        !frameDocument
      ) {
        return false;
      }
      const slide = frameSlideElement(slideInfo, frameDocument);
      if (!slide) return false;
      const element = elementAtPath(slide, selected.path);
      if (!element) return false;
      const snapshot = snapshotGeometry(element, slide);
      return applyInspectorEdit(
        current.master,
        (master) => applyGeometryEdit(master, selected, snapshot, field, value),
        () => void commitMasterDocument()
      );
    },
    [commitMasterDocument]
  );

  const handleTransitionChange = useCallback(
    (transition: Transition) => {
      const current = stateRef.current;
      const master = current.master;
      if (!master) return;
      const slideIndex = current.activeIndex;
      applyInspectorEdit(
        master,
        (draft) => applyTransition(draft, slideIndex, transition),
        () => void commitMasterDocument()
      );
    },
    [commitMasterDocument]
  );

  const handleBackgroundChange = useCallback(
    (background: SlideBackground): boolean => {
      const current = stateRef.current;
      const master = current.master;
      if (!master) return false;
      const slideIndex = current.activeIndex;
      return applyInspectorEdit(
        master,
        (draft) => applyBackground(draft, slideIndex, background),
        () => void commitMasterDocument()
      );
    },
    [commitMasterDocument]
  );

  const handleClearBackground = useCallback((): boolean => {
    const current = stateRef.current;
    const master = current.master;
    if (!master) return false;
    const slideIndex = current.activeIndex;
    return applyInspectorEdit(
      master,
      (draft) => clearBackground(draft, slideIndex),
      () => void commitMasterDocument()
    );
  }, [commitMasterDocument]);

  const handleNotesChange = useCallback(
    (notes: string) => {
      const current = stateRef.current;
      const master = current.master;
      const slide = current.slides[current.activeIndex];
      if (!master || !slide || notesOf(slide.element) === notes) return;
      const slideIndex = current.activeIndex;
      const before = Array.from(slide.element.children);
      const applied = applyInspectorEdit(
        master,
        (draft) => applyNotes(draft, slideIndex, notes),
        () => void commitMasterDocument()
      );
      if (!applied) return;
      const updated = detectSlides(master)[slideIndex]?.element;
      if (!updated) return;
      const after = Array.from(updated.children);
      const structureChanged =
        after.length !== before.length ||
        after.some((child, index) => child !== before[index]);
      if (structureChanged) {
        // Raw child paths key the selection; adding or removing the notes
        // aside shifts sibling indices and would silently retarget the next
        // geometry edit. Dropping the selection is the safe mapping.
        actionsRef.current.clearSelection();
        clearOverlay();
      }
    },
    [clearOverlay, commitMasterDocument]
  );

  useEffect(() => {
    void actions.load();
  }, [actions]);

  const computeFitScale = useCallback(() => {
    if (!canvas.current) return;
    const current = stateRef.current;
    const slide = current.slides[current.activeIndex];
    if (!slide) return;
    const bounds = canvas.current.getBoundingClientRect();
    const widthScale = Math.max(0.1, (bounds.width - 96) / slide.width);
    const heightScale = Math.max(0.1, (bounds.height - 96) / slide.height);
    actionsRef.current.setScale(Math.min(widthScale, heightScale, 1));
  }, []);

  useEffect(() => {
    computeFitScale();
    window.addEventListener('resize', computeFitScale);
    return () => window.removeEventListener('resize', computeFitScale);
  }, [activeSlide, computeFitScale, view]);

  const frameSlideNow = useCallback((): Element | null => {
    const frameDocument = frame.current?.contentDocument;
    const current = stateRef.current;
    const slideInfo = current.slides[current.activeIndex];
    if (!frameDocument || !slideInfo) return null;
    return frameSlideElement(slideInfo, frameDocument);
  }, []);

  const outerDesignPoint = useCallback(
    (clientX: number, clientY: number, slide: Element): Point => {
      const frameElement = frame.current;
      if (!frameElement) return { x: 0, y: 0 };
      const bounds = frameElement.getBoundingClientRect();
      const point = toDesignPoint(
        clientX,
        clientY,
        {
          x: bounds.left,
          y: bounds.top,
          width: bounds.width,
          height: bounds.height
        },
        stateRef.current.scale
      );
      const slideRect = slide.getBoundingClientRect();
      return { x: point.x - slideRect.left, y: point.y - slideRect.top };
    },
    []
  );

  const commitFrame = useCallback(async () => {
    const frameDocument = frame.current?.contentDocument;
    if (!frameDocument) return;
    try {
      await actionsRef.current.commit((master, slide) =>
        commitSlide(master, slide.index, frameDocument)
      );
    } catch {
      // The controller already surfaced the status and message.
    }
  }, []);

  const changeView = useCallback(
    (next: EditorView) => {
      if (next === view) return;
      // Selection geometry belongs to the canvas iframe, which unmounts in
      // sorter view; dropping it keeps the next mount consistent.
      actionsRef.current.clearSelection();
      clearOverlay();
      setView(next);
    },
    [clearOverlay, view]
  );

  const refreshOverlay = useCallback(() => {
    const current = stateRef.current;
    if (current.selections.length === 0) {
      clearOverlay();
      return;
    }
    const frameDocument = frame.current?.contentDocument;
    const slideInfo = current.slides[current.activeIndex];
    if (!frameDocument || !slideInfo) {
      clearOverlay();
      return;
    }
    const slide = frameSlideElement(slideInfo, frameDocument);
    if (!slide) {
      clearOverlay();
      return;
    }

    const offset = slideOffsetOf(slide);
    const boxes: SelectionBox[] = [];
    let geometry: GeometryValues | null = null;
    for (const target of current.selections) {
      if (target.slideIndex !== current.activeIndex) continue;
      const element = elementAtPath(slide, target.path);
      if (!element) continue;
      boxes.push({
        rect: frameRectOf(rectOf(element, slide), offset),
        rotation: rotationOf(element),
        path: target.path,
        elementId: target.elementId
      });
      if (!geometry) geometry = readGeometry(element, slide);
    }

    if (boxes.length === 0) {
      clearOverlay();
      return;
    }
    setSelectionBoxes(boxes);
    setSelectionGeometry(geometry);
  }, [clearOverlay]);

  useEffect(() => {
    refreshOverlay();
  }, [refreshOverlay, selections, activeIndex, srcDoc, slides, frameEpoch]);

  /**
   * Reloads the preview iframe from the current master document, discarding
   * live gesture styles. The master (not `srcDoc`) is the source of truth
   * after commits, because commits leave the preview DOM untouched.
   */
  const restoreFrameFromMaster = useCallback(() => {
    const frameElement = frame.current;
    const current = stateRef.current;
    if (!frameElement) return;
    const master = current.master;
    const slide = master ? detectSlides(master)[current.activeIndex] : null;
    if (master && slide) {
      frameElement.srcdoc = buildSlideSrcDoc(master, slide);
    } else if (current.srcDoc) {
      frameElement.srcdoc = current.srcDoc;
    }
  }, []);

  const cancelSession = useCallback((): boolean => {
    if (!sessionRef.current) return false;
    sessionRef.current = null;
    detachSessionRef.current?.();
    detachSessionRef.current = null;
    clearOverlay();
    actionsRef.current.clearSelection();
    restoreFrameFromMaster();
    return true;
  }, [clearOverlay, restoreFrameFromMaster]);

  const moveSession = useCallback((point: Point, event: PointerEvent) => {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    const currentScale = stateRef.current.scale;

    if (!session.moved) {
      const threshold = DRAG_THRESHOLD_SCREEN_PX / currentScale;
      const distance = Math.hypot(
        point.x - session.start.x,
        point.y - session.start.y
      );
      if (distance < threshold) return;
      session.moved = true;
      if (session.kind === 'drag') {
        session.targets.forEach((target) =>
          pinToAbsolute(target.element, target.start, session.slide)
        );
      } else {
        pinToAbsolute(
          session.target.element,
          session.target.start,
          session.slide
        );
      }
    }

    event.preventDefault();
    const noSnap = session.altKey || event.altKey;
    const threshold = SNAP_THRESHOLD_SCREEN_PX / currentScale;

    if (session.kind === 'drag') {
      let dx = point.x - session.start.x;
      let dy = point.y - session.start.y;
      let nextGuides: Guide[] = [];
      const primary = session.targets[0];
      if (!noSnap && primary) {
        const moved: Rect = {
          ...primary.start,
          x: primary.start.x + dx,
          y: primary.start.y + dy
        };
        const snapped = snapRect(
          moved,
          session.siblingRects,
          threshold,
          session.bounds
        );
        dx += snapped.rect.x - moved.x;
        dy += snapped.rect.y - moved.y;
        nextGuides = snapped.guides;
      }
      const rects = moveTargets(session.targets, { x: dx, y: dy });
      rects.forEach((rect, index) => {
        const target = session.targets[index];
        if (target) applyRect(target.element, rect, session.slide);
      });
      setSelectionBoxes(
        session.targets.map((target, index) => ({
          rect: frameRectOf(rects[index] ?? target.start, session.slideOffset),
          rotation: target.rotation,
          path: target.path,
          elementId: target.elementId
        }))
      );
      setGuides(frameGuidesOf(nextGuides, session.slideOffset));
      return;
    }

    if (session.kind === 'resize') {
      let rect = resizeTarget(
        session.target,
        session.handle,
        {
          x: point.x - session.start.x,
          y: point.y - session.start.y
        },
        MIN_RESIZE_DESIGN_PX
      );
      let nextGuides: Guide[] = [];
      if (!noSnap) {
        const snapped = snapResizeRect(
          rect,
          session.handle,
          session.siblingRects,
          threshold,
          session.bounds,
          MIN_RESIZE_DESIGN_PX
        );
        rect = snapped.rect;
        nextGuides = snapped.guides;
      }
      applyRect(session.target.element, rect, session.slide);
      setSelectionBoxes([
        {
          rect: frameRectOf(rect, session.slideOffset),
          rotation: rotationOf(session.target.element),
          path: session.path,
          elementId: session.elementId
        }
      ]);
      setGuides(frameGuidesOf(nextGuides, session.slideOffset));
      return;
    }

    const pointerAngle = rotationFromPointer(session.center, point);
    let nextRotation = normalizeAngle(
      session.startRotation +
        angleDelta(session.startPointerAngle, pointerAngle)
    );
    if (event.shiftKey && !noSnap) {
      nextRotation = snapAngle(nextRotation, 15);
    }
    applyRotation(session.target.element, nextRotation);
    setSelectionBoxes([
      {
        rect: frameRectOf(session.target.start, slideOffsetOf(session.slide)),
        rotation: nextRotation,
        path: session.path,
        elementId: session.elementId
      }
    ]);
    setGuides([]);
  }, []);

  const finishSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    detachSessionRef.current?.();
    detachSessionRef.current = null;
    setGuides([]);
    if (!session.moved) {
      refreshOverlay();
      return;
    }
    void commitFrame();
  }, [commitFrame, refreshOverlay]);

  const attachSession = useCallback(
    (slide: Element) => {
      detachSessionRef.current?.();
      detachSessionRef.current = null;
      const frameDocument = frame.current?.contentDocument ?? null;

      const frameMove = (event: PointerEvent) =>
        moveSession(
          designPointInsideFrame(event.clientX, event.clientY, slide),
          event
        );
      const outerMove = (event: PointerEvent) =>
        moveSession(
          outerDesignPoint(event.clientX, event.clientY, slide),
          event
        );
      const onPointerUp = (event: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || event.pointerId !== session.pointerId) return;
        finishSession();
      };
      const onPointerCancel = (event: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || event.pointerId !== session.pointerId) return;
        cancelSession();
      };

      frameDocument?.addEventListener('pointermove', frameMove);
      frameDocument?.addEventListener('pointerup', onPointerUp);
      frameDocument?.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('pointermove', outerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);

      detachSessionRef.current = () => {
        frameDocument?.removeEventListener('pointermove', frameMove);
        frameDocument?.removeEventListener('pointerup', onPointerUp);
        frameDocument?.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('pointermove', outerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
      };
    },
    [cancelSession, finishSession, moveSession, outerDesignPoint]
  );

  const beginDragSession = useCallback(
    (
      items: readonly { element: Element; selection: SelectionTarget }[],
      slide: Element,
      start: Point,
      pointerId: number,
      altKey: boolean
    ) => {
      const current = stateRef.current;
      const slideInfo = current.slides[current.activeIndex];
      if (!slideInfo || items.length === 0) return;
      sessionRef.current = {
        kind: 'drag',
        pointerId,
        start,
        altKey,
        moved: false,
        slide,
        slideOffset: slideOffsetOf(slide),
        targets: items.map((item) => ({
          element: item.element,
          start: rectOf(item.element, slide),
          rotation: rotationOf(item.element),
          path: item.selection.path,
          elementId: item.selection.elementId
        })),
        siblingRects: siblingRectsOf(
          slide,
          items.map((item) => item.element)
        ),
        bounds: boundsOf(slideInfo.width, slideInfo.height)
      };
      attachSession(slide);
    },
    [attachSession]
  );

  const beginResizeSession = useCallback(
    (handle: Handle, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const current = stateRef.current;
      const selected = current.selection;
      const slideInfo = current.slides[current.activeIndex];
      const slide = frameSlideNow();
      if (
        !selected ||
        current.selections.length !== 1 ||
        selected.path.length !== 1 ||
        !slideInfo ||
        !slide
      ) {
        return;
      }
      const element = elementAtPath(slide, selected.path);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep overlay gestures in the editor document; without capture a drag
      // that crosses the iframe boundary gets routed into the iframe.
      event.currentTarget.setPointerCapture(event.pointerId);
      sessionRef.current = {
        kind: 'resize',
        pointerId: event.pointerId,
        start: outerDesignPoint(event.clientX, event.clientY, slide),
        altKey: event.altKey,
        moved: false,
        slide,
        slideOffset: slideOffsetOf(slide),
        target: { element, start: rectOf(element, slide) },
        path: selected.path,
        elementId: selected.elementId,
        handle,
        siblingRects: siblingRectsOf(slide, [element]),
        bounds: boundsOf(slideInfo.width, slideInfo.height)
      };
      attachSession(slide);
    },
    [attachSession, frameSlideNow, outerDesignPoint]
  );

  const beginRotateSession = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const current = stateRef.current;
      const selected = current.selection;
      const slide = frameSlideNow();
      if (
        !selected ||
        current.selections.length !== 1 ||
        selected.path.length !== 1 ||
        !slide
      ) {
        return;
      }
      const element = elementAtPath(slide, selected.path);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const startRect = rectOf(element, slide);
      const center = centerOf(startRect);
      const startPoint = outerDesignPoint(
        event.clientX,
        event.clientY,
        slide
      );
      sessionRef.current = {
        kind: 'rotate',
        pointerId: event.pointerId,
        start: startPoint,
        altKey: event.altKey,
        moved: false,
        slide,
        target: { element, start: startRect },
        path: selected.path,
        elementId: selected.elementId,
        center,
        startPointerAngle: rotationFromPointer(center, startPoint),
        startRotation: rotationOf(element)
      };
      attachSession(slide);
    },
    [attachSession, frameSlideNow, outerDesignPoint]
  );

  const nudgeSelection = useCallback(
    (dx: number, dy: number): boolean => {
      const current = stateRef.current;
      const slideInfo = current.slides[current.activeIndex];
      const slide = frameSlideNow();
      if (!slideInfo || !slide) return false;
      const targets = current.selections.filter(
        (target) =>
          target.slideIndex === current.activeIndex &&
          target.path.length === 1
      );
      if (targets.length === 0) return false;

      const offset = slideOffsetOf(slide);
      const boxes: SelectionBox[] = [];
      let changed = false;
      for (const target of targets) {
        const element = elementAtPath(slide, target.path);
        if (!element) continue;
        const rect = rectOf(element, slide);
        const next = nudge(
          rect,
          dx,
          dy,
          boundsOf(slideInfo.width, slideInfo.height)
        );
        if (next.x === rect.x && next.y === rect.y) {
          boxes.push({
            rect: frameRectOf(rect, offset),
            rotation: rotationOf(element),
            path: target.path,
            elementId: target.elementId
          });
          continue;
        }
        pinToAbsolute(element, next, slide);
        changed = true;
        boxes.push({
          rect: frameRectOf(next, offset),
          rotation: rotationOf(element),
          path: target.path,
          elementId: target.elementId
        });
      }
      if (!changed) return false;
      setSelectionBoxes(boxes);
      setGuides([]);
      void commitFrame();
      return true;
    },
    [commitFrame, frameSlideNow]
  );

  const startTextEditing = useCallback((): boolean => {
    const current = stateRef.current;
    if (current.selections.length !== 1 || !current.selection) return false;
    if (current.selection.path.length < 1) return false;
    const slideInfo = current.slides[current.activeIndex];
    const frameDocument = frame.current?.contentDocument;
    if (!slideInfo || !frameDocument) return false;
    const slide = frameSlideElement(slideInfo, frameDocument);
    if (!slide) return false;
    const selected = elementAtPath(slide, current.selection.path);
    if (!selected) return false;

    const textElement = selected.matches(TEXT_EDITABLE_SELECTOR)
      ? selected
      : selected.querySelector(TEXT_EDITABLE_SELECTOR);
    const editable = textElement as HTMLElement | null;
    if (!editable || !editable.textContent?.trim()) return false;

    editable.setAttribute('contenteditable', 'true');
    editable.setAttribute(EDITING_ATTRIBUTE, 'true');
    editable.focus();
    return true;
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, stateRef.current.scale * factor)
    );
    actionsRef.current.setScale(next);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent, activeDocument: Document | null) => {
      if (event.defaultPrevented) return;
      const active = activeDocument ?? document;
      if (
        isEditableTarget(active.activeElement) ||
        isEditableShortcutTarget(event.target)
      ) {
        return;
      }
      const action = mapShortcut(event);
      if (!action) return;
      const current = stateRef.current;

      if (action.type === 'escape') {
        if (cancelSession()) {
          event.preventDefault();
          return;
        }
        if (current.selection) {
          event.preventDefault();
          actionsRef.current.clearSelection();
          clearOverlay();
        }
        return;
      }

      // A pointer gesture owns the transform until pointerup; shortcuts during
      // it would add extra history entries or mutate the deck mid-drag.
      if (sessionRef.current) {
        event.preventDefault();
        return;
      }

      switch (action.type) {
        case 'undo':
          event.preventDefault();
          actionsRef.current.undo();
          return;
        case 'redo':
          event.preventDefault();
          actionsRef.current.redo();
          return;
        case 'save':
          event.preventDefault();
          void actionsRef.current.saveNow().catch(() => undefined);
          return;
        case 'export':
        case 'group':
        case 'ungroup':
        case 'help':
          // Export is M5; group/ungroup are M4; help is not part of the shell.
          event.preventDefault();
          return;
        case 'select-all':
          event.preventDefault();
          actionsRef.current.selectAll();
          return;
        case 'copy':
          if (current.selections.length === 0) return;
          event.preventDefault();
          actionsRef.current.copySelection();
          return;
        case 'paste':
          event.preventDefault();
          void actionsRef.current.pasteObjects().catch(() => undefined);
          return;
        case 'duplicate':
          if (current.selections.length === 0) return;
          event.preventDefault();
          void actionsRef.current.duplicateSelection().catch(() => undefined);
          return;
        case 'delete':
          if (current.selections.length === 0) return;
          event.preventDefault();
          void actionsRef.current.deleteSelection().catch(() => undefined);
          return;
        case 'zoom-in':
          event.preventDefault();
          zoomBy(ZOOM_STEP);
          return;
        case 'zoom-out':
          event.preventDefault();
          zoomBy(1 / ZOOM_STEP);
          return;
        case 'zoom-fit':
          event.preventDefault();
          computeFitScale();
          return;
        case 'edit': {
          // Enter belongs to a focused button/link before it means "edit".
          const targetElement = eventElement(event.target);
          if (
            targetElement?.closest(
              'button, a, [role="button"], [role="tab"]'
            )
          ) {
            return;
          }
          if (startTextEditing()) event.preventDefault();
          return;
        }
        case 'play':
        case 'play-from-current':
          // Play mode shell is Task 7; keep the browser default suppressed.
          event.preventDefault();
          return;
        case 'nudge': {
          if (current.selections.length > 0) {
            event.preventDefault();
            // Nested selections are read-only: no nudge and no slide change.
            if (current.selections.some((target) => target.path.length !== 1)) {
              return;
            }
            nudgeSelection(action.dx, action.dy);
            return;
          }
          if (action.dx !== 0) {
            event.preventDefault();
            actionsRef.current.showSlide(
              current.activeIndex + (action.dx > 0 ? 1 : -1)
            );
          }
          return;
        }
      }
    },
    [
      cancelSession,
      clearOverlay,
      computeFitScale,
      nudgeSelection,
      startTextEditing,
      zoomBy
    ]
  );

  const handleFramePointerDown = useCallback(
    (event: PointerEvent, frameDocument: Document) => {
      if (event.button !== 0) return;
      const current = stateRef.current;
      const slideInfo = current.slides[current.activeIndex];
      if (!slideInfo) return;
      const target = eventElement(event.target);
      if (!target) return;
      const frameSlide = frameSlideElement(slideInfo, frameDocument);
      if (!frameSlide || !frameSlide.contains(target)) return;
      if (isEditableTarget(target)) return;

      const selected = selectionFromEvent(target, frameSlide, {
        slideIndex: current.activeIndex,
        altKey: event.altKey
      });
      if (!selected) {
        actionsRef.current.clearSelection();
        clearOverlay();
        return;
      }

      if (event.shiftKey) {
        // Shift toggles membership without starting a transform gesture.
        event.preventDefault();
        actionsRef.current.toggleSelect(selected);
        return;
      }

      const existing = current.selections.some((candidate) =>
        sameSelection(candidate, selected)
      );
      if (!existing) actionsRef.current.select(selected);
      // Drilled nested selections show read-only geometry for now.
      if (selected.path.length !== 1) return;

      const dragSelections = existing ? current.selections : [selected];
      const items = dragSelections
        .filter(
          (candidate) =>
            candidate.slideIndex === current.activeIndex &&
            candidate.path.length === 1
        )
        .map((candidate) => ({
          selection: candidate,
          element: elementAtPath(frameSlide, candidate.path)
        }))
        .filter(
          (item): item is { element: Element; selection: SelectionTarget } =>
            item.element !== null
        )
        .sort((a, b) => {
          if (sameSelection(a.selection, selected)) return -1;
          if (sameSelection(b.selection, selected)) return 1;
          return 0;
        });
      if (items.length === 0) return;
      event.preventDefault();
      beginDragSession(
        items,
        frameSlide,
        designPointInsideFrame(event.clientX, event.clientY, frameSlide),
        event.pointerId,
        event.altKey
      );
    },
    [beginDragSession, clearOverlay]
  );

  keyDownRef.current = handleKeyDown;
  framePointerDownRef.current = handleFramePointerDown;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) =>
      keyDownRef.current(event, document);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commit = useCallback(
    async (editable: HTMLElement) => {
      const frameDocument = frame.current?.contentDocument;
      if (!frameDocument) return;

      try {
        await actions.commit((master, slide) => {
          // Drop the editing marker before commitSlide reads the frame:
          // removing contenteditable from the focused element can fire
          // another focusout, which must not re-commit. The controller's
          // guard runs first, so a missing slide leaves the element editable.
          editable.removeAttribute(EDITING_ATTRIBUTE);
          editable.removeAttribute('contenteditable');
          return commitSlide(master, slide.index, frameDocument);
        });
      } catch {
        // The controller already surfaced the status and message.
        editable.setAttribute('contenteditable', 'true');
        editable.setAttribute(EDITING_ATTRIBUTE, 'true');
      }
    },
    [actions]
  );

  const onFrameLoad = useCallback(() => {
    const frameDocument = frame.current?.contentDocument;
    if (!frameDocument) return;

    setFrameEpoch((value) => value + 1);

    frameDocument.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !frameDocument.body.contains(target)) return;
      const editable = target.closest(TEXT_EDITABLE_SELECTOR) as HTMLElement | null;
      if (!editable || !editable.textContent?.trim()) return;
      event.preventDefault();
      editable.setAttribute('contenteditable', 'true');
      editable.setAttribute(EDITING_ATTRIBUTE, 'true');
      editable.focus();
    });

    frameDocument.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const editable = frameDocument.querySelector(
          `[${EDITING_ATTRIBUTE}]`
        ) as HTMLElement | null;
        if (editable) {
          editable.blur();
          event.preventDefault();
          return;
        }
      }
      keyDownRef.current(event, frameDocument);
    });

    frameDocument.addEventListener('focusout', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.hasAttribute(EDITING_ATTRIBUTE)) {
        void commit(target);
      }
    });

    frameDocument.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement | null)?.closest('a');
      if (link) event.preventDefault();
    });

    frameDocument.addEventListener('pointerdown', (event) => {
      framePointerDownRef.current(event, frameDocument);
    });
  }, [commit]);

  const goTo = (index: number) => {
    actions.showSlide(index);
  };

  return (
    <div className="flex h-screen flex-col bg-[#0f1115] text-zinc-100">
      <Toolbar
        filePath={filePath}
        status={status}
        activeIndex={activeIndex}
        slideCount={slides.length}
        view={view}
        canDelete={slides.length > 1}
        onAddSlide={handleAddSlide}
        onDuplicateSlide={() => handleDuplicateSlide()}
        onDeleteSlide={() => handleDeleteSlide()}
        onUndo={actions.undo}
        onRedo={actions.redo}
        onViewChange={changeView}
        onPreviousSlide={() => goTo(activeIndex - 1)}
        onNextSlide={() => goTo(activeIndex + 1)}
      />

      {(error || slideOpError) && (
        <div
          data-testid="editor-error"
          className="max-h-24 overflow-auto border-b border-red-500/30 bg-red-950/60 px-4 py-2 text-xs text-red-200"
        >
          {[error, slideOpError].filter(Boolean).join(' · ')}
        </div>
      )}

      {view === 'sorter' ? (
        <SorterView
          master={master}
          slides={slides}
          activeIndex={activeIndex}
          onSelect={goTo}
          onReorder={handleReorderSlides}
          onDuplicate={(index) => handleDuplicateSlide(index)}
          onDelete={(index) => handleDeleteSlide(index)}
          canDelete={slides.length > 1}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ThumbnailRail
            master={master}
            slides={slides}
            activeIndex={activeIndex}
            onSelect={goTo}
          />

          <main
            ref={canvas}
            data-testid="canvas-preview"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget) return;
              actions.clearSelection();
              clearOverlay();
            }}
            className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#0a0c10] p-12"
          >
            {activeSlide ? (
              <div
                className="relative shadow-2xl shadow-black/60"
                style={{
                  width: activeSlide.width * scale,
                  height: activeSlide.height * scale
                }}
              >
                <iframe
                  ref={frame}
                  title="投影片預覽"
                  sandbox="allow-same-origin"
                  srcDoc={srcDoc}
                  onLoad={onFrameLoad}
                  className="absolute left-0 top-0 border-0 bg-white"
                  style={{
                    width: activeSlide.width,
                    height: activeSlide.height,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left'
                  }}
                />
                <CanvasOverlay
                  boxes={selectionBoxes}
                  guides={guides}
                  scale={scale}
                  readOnly={
                    selectionBoxes.length > 1 ||
                    (selection !== null && selection.path.length > 1)
                  }
                  onResizeStart={beginResizeSession}
                  onRotateStart={beginRotateSession}
                />
              </div>
            ) : status === 'loading' ? (
              <p className="text-sm text-zinc-500">載入中…</p>
            ) : (
              <p className="text-sm text-zinc-500">找不到投影片。</p>
            )}
          </main>

          <Inspector
            slide={activeSlide}
            selection={selection}
            selectionCount={selections.length}
            geometry={selectionGeometry}
            onSelectObject={handleSelectObject}
            onCommitGeometry={handleGeometryCommit}
            onSetTransition={handleTransitionChange}
            onSetBackground={handleBackgroundChange}
            onClearBackground={handleClearBackground}
            onSetNotes={handleNotesChange}
          />
        </div>
      )}
    </div>
  );
}
