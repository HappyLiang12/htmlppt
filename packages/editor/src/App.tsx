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
  topLevelObjects
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
import { CanvasOverlay } from './components/CanvasOverlay';
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
import { useDeckController } from './use-deck-controller';

const ARROW_KEYS: Record<string, readonly [number, number] | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};

const SNAP_THRESHOLD_SCREEN_PX = 6;
const MIN_RESIZE_DESIGN_PX = 4;
const DRAG_THRESHOLD_SCREEN_PX = 2;

interface GestureBase {
  pointerId: number;
  start: Point;
  moved: boolean;
  altKey: boolean;
  /** The iframe-rendered slide, used for containing-block geometry. */
  slide: Element;
}

interface DragSession extends GestureBase {
  kind: 'drag';
  /** Slide origin inside the iframe, for iframe-space overlay coordinates. */
  slideOffset: Point;
  targets: TransformTarget[];
  siblingRects: Rect[];
  bounds: Rect;
}

interface ResizeSession extends GestureBase {
  kind: 'resize';
  /** Slide origin inside the iframe, for iframe-space overlay coordinates. */
  slideOffset: Point;
  target: TransformTarget;
  handle: Handle;
  siblingRects: Rect[];
  bounds: Rect;
}

interface RotateSession extends GestureBase {
  kind: 'rotate';
  target: TransformTarget;
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

function siblingRectsOf(slide: Element, element: Element): Rect[] {
  return topLevelObjects(slide)
    .filter((other) => other !== element)
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
    master
  } = state;

  const activeSlide = slides[activeIndex];

  const [view, setView] = useState<EditorView>('normal');
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const [selectionRotation, setSelectionRotation] = useState(0);
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
   * renders them without reconciling the iframe clone over the master.
   */
  const commitMasterDocument = useCallback(
    async (mutate: (master: Document) => void) => {
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
    setSelectionRect(null);
    setSelectionRotation(0);
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
      if (!selected || !slideInfo || !frameDocument) return false;
      const slide = frameSlideElement(slideInfo, frameDocument);
      if (!slide) return false;
      const element = elementAtPath(slide, selected.path);
      if (!element) return false;
      const snapshot = snapshotGeometry(element, slide);
      let applied = false;
      void commitMasterDocument((master) => {
        applied = applyGeometryEdit(master, selected, snapshot, field, value);
      });
      return applied;
    },
    [commitMasterDocument]
  );

  const handleTransitionChange = useCallback(
    (transition: Transition) => {
      const slideIndex = stateRef.current.activeIndex;
      void commitMasterDocument((master) => {
        applyTransition(master, slideIndex, transition);
      });
    },
    [commitMasterDocument]
  );

  const handleBackgroundChange = useCallback(
    (background: SlideBackground): boolean => {
      const slideIndex = stateRef.current.activeIndex;
      let applied = false;
      void commitMasterDocument((master) => {
        applied = applyBackground(master, slideIndex, background);
      });
      return applied;
    },
    [commitMasterDocument]
  );

  const handleClearBackground = useCallback((): boolean => {
    const slideIndex = stateRef.current.activeIndex;
    let cleared = false;
    void commitMasterDocument((master) => {
      cleared = clearBackground(master, slideIndex);
    });
    return cleared;
  }, [commitMasterDocument]);

  const handleNotesChange = useCallback(
    (notes: string) => {
      const current = stateRef.current;
      const slide = current.slides[current.activeIndex];
      if (!slide || notesOf(slide.element) === notes) return;
      const slideIndex = current.activeIndex;
      const before = Array.from(slide.element.children);
      let structureChanged = false;
      void commitMasterDocument((master) => {
        if (!applyNotes(master, slideIndex, notes)) return;
        const updated = detectSlides(master)[slideIndex]?.element;
        if (!updated) return;
        const after = Array.from(updated.children);
        structureChanged =
          after.length !== before.length ||
          after.some((child, index) => child !== before[index]);
      });
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

  useEffect(() => {
    const updateScale = () => {
      if (!canvas.current || !activeSlide) return;
      const bounds = canvas.current.getBoundingClientRect();
      const widthScale = Math.max(0.1, (bounds.width - 96) / activeSlide.width);
      const heightScale = Math.max(
        0.1,
        (bounds.height - 96) / activeSlide.height
      );
      actions.setScale(Math.min(widthScale, heightScale, 1));
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [activeSlide, actions, view]);

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
    const selected = current.selection;
    if (!selected) {
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
    const element = slide ? elementAtPath(slide, selected.path) : null;
    if (!slide || !element) {
      clearOverlay();
      return;
    }
    setSelectionRect(frameRectOf(rectOf(element, slide), slideOffsetOf(slide)));
    setSelectionRotation(rotationOf(element));
    setSelectionGeometry(readGeometry(element, slide));
  }, [clearOverlay]);

  useEffect(() => {
    refreshOverlay();
  }, [refreshOverlay, selection, activeIndex, srcDoc, slides, frameEpoch]);

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
      setSelectionRect(
        rects[0] ? frameRectOf(rects[0], session.slideOffset) : null
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
      setSelectionRect(frameRectOf(rect, session.slideOffset));
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
    setSelectionRotation(nextRotation);
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
      element: Element,
      slide: Element,
      start: Point,
      pointerId: number,
      altKey: boolean
    ) => {
      const current = stateRef.current;
      const slideInfo = current.slides[current.activeIndex];
      if (!slideInfo) return;
      sessionRef.current = {
        kind: 'drag',
        pointerId,
        start,
        altKey,
        moved: false,
        slide,
        slideOffset: slideOffsetOf(slide),
        targets: [{ element, start: rectOf(element, slide) }],
        siblingRects: siblingRectsOf(slide, element),
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
      if (!selected || selected.path.length !== 1 || !slideInfo || !slide) {
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
        handle,
        siblingRects: siblingRectsOf(slide, element),
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
      if (!selected || selected.path.length !== 1 || !slide) return;
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
      const selected = current.selection;
      const slideInfo = current.slides[current.activeIndex];
      const slide = frameSlideNow();
      if (!selected || selected.path.length !== 1 || !slideInfo || !slide) {
        return false;
      }
      const element = elementAtPath(slide, selected.path);
      if (!element) return false;
      const rect = rectOf(element, slide);
      const next = nudge(
        rect,
        dx,
        dy,
        boundsOf(slideInfo.width, slideInfo.height)
      );
      if (next.x === rect.x && next.y === rect.y) return false;
      pinToAbsolute(element, next, slide);
      setSelectionRect(frameRectOf(next, slideOffsetOf(slide)));
      setGuides([]);
      void commitFrame();
      return true;
    },
    [commitFrame, frameSlideNow]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent, activeDocument: Document | null) => {
      if (event.defaultPrevented) return;
      const active = activeDocument ?? document;
      if (isEditableTarget(active.activeElement)) return;
      const current = stateRef.current;

      if (event.key === 'Escape') {
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

      const direction = ARROW_KEYS[event.key];
      if (!direction) return;

      // A pointer gesture owns the transform until pointerup; keyboard nudges
      // during it would add a second history entry and extra offset.
      if (sessionRef.current) {
        event.preventDefault();
        return;
      }

      if (current.selection) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        nudgeSelection(direction[0] * step, direction[1] * step);
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        actionsRef.current.showSlide(
          current.activeIndex + (event.key === 'ArrowRight' ? 1 : -1)
        );
      }
    },
    [cancelSession, clearOverlay, nudgeSelection]
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

      actionsRef.current.select(selected);
      // Drilled nested selections show read-only geometry for now.
      if (selected.path.length !== 1) return;
      const element = elementAtPath(frameSlide, selected.path);
      if (!element) return;
      event.preventDefault();
      beginDragSession(
        element,
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
      const editable = target.closest(
        'h1, h2, h3, p, li, span, td, th, blockquote, figcaption'
      ) as HTMLElement | null;
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
                  rect={selectionRect}
                  rotation={selectionRotation}
                  guides={guides}
                  scale={scale}
                  readOnly={selection !== null && selection.path.length > 1}
                  selectedId={selection?.elementId ?? null}
                  selectedPath={selection?.path ?? null}
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
