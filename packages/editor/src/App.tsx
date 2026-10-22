import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { detectSlides, type SlideInfo, type Transition } from '@htmlppt/core';
import { openDeckEvents, tokenFromLocation } from './api';
import {
  planConflictResolution,
  type ConflictResolution
} from './live-sync';
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
  FRAME_SLIDE_ATTRIBUTE,
  frameSlideElement
} from './slide-doc';
import type { PastedObjectGeometry } from './object-ops';
import {
  applyObjectCommand,
  isGroupElement,
  isHiddenElement,
  isLockedElement,
  type ObjectCommand,
  type ObjectMeasurement
} from './commands/objects';
import {
  angleDelta,
  applyRect,
  applyRotation,
  centerOf,
  containingBlockOffset,
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
import {
  Inspector,
  type ObjectActionState
} from './components/Inspector';
import { PlayView } from './components/PlayView';
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

const NO_OBJECT_ACTIONS: ObjectActionState = {
  canGroup: false,
  canUngroup: false,
  canAlign: false,
  canDistribute: false,
  canOrder: false,
  canToggle: false,
  locked: false,
  hidden: false,
  group: false
};

function selectionElements(
  slide: SlideInfo | undefined,
  selections: readonly SelectionTarget[],
  activeIndex: number
): Element[] | null {
  if (!slide) return null;
  const elements: Element[] = [];
  for (const target of selections) {
    if (target.slideIndex !== activeIndex || target.path.length !== 1) return null;
    const element = elementAtPath(slide.element, target.path);
    if (!element) return null;
    elements.push(element);
  }
  return elements;
}

function objectActionStateFor(
  slide: SlideInfo | undefined,
  selections: readonly SelectionTarget[],
  activeIndex: number
): ObjectActionState {
  const elements = selectionElements(slide, selections, activeIndex);
  if (!elements || elements.length === 0) return NO_OBJECT_ACTIONS;
  const unlocked = elements.every((element) => !isLockedElement(element));
  const visible = elements.every((element) => !isHiddenElement(element));
  const single = elements.length === 1 ? elements[0] ?? null : null;
  return {
    canGroup:
      elements.length >= 2 &&
      unlocked &&
      visible &&
      elements.every(
        (element) => !isGroupElement(element) && !element.querySelector('[data-ppt-group]')
      ),
    canUngroup: Boolean(single && isGroupElement(single) && unlocked && visible),
    canAlign: elements.length >= 2 && unlocked && visible,
    canDistribute: elements.length >= 3 && unlocked && visible,
    canOrder: Boolean(single && unlocked && visible),
    canToggle: Boolean(single),
    locked: isLockedElement(single),
    hidden: isHiddenElement(single),
    group: isGroupElement(single)
  };
}

export function App() {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const canvas = useRef<HTMLElement | null>(null);

  /**
   * Measures a pasted copy in the rendered preview. The master document is
   * inert, so class-supplied positioning and coordinates only resolve here.
   * The staging clone is removed in the same synchronous task.
   */
  const measurePastedObject = useCallback(
    (element: Element): PastedObjectGeometry | null => {
      const frameDocument = frame.current?.contentDocument;
      if (!frameDocument) return null;
      const liveSlide: Element | null =
        frameDocument.querySelector(`[${FRAME_SLIDE_ATTRIBUTE}]`) ??
        frameDocument.body;
      if (!liveSlide) return null;
      const clone = liveSlide.ownerDocument.importNode(element, true) as Element;
      liveSlide.appendChild(clone);
      try {
        const view = liveSlide.ownerDocument.defaultView;
        const position = view?.getComputedStyle(clone).position ?? '';
        const rect = rectOf(clone, liveSlide);
        const block = containingBlockOffset(clone, liveSlide);
        return { x: rect.x - block.x, y: rect.y - block.y, position };
      } finally {
        clone.remove();
      }
    },
    []
  );

  const { state, actions } = useDeckController({ measurePastedObject });
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
    master,
    conflict
  } = state;

  const activeSlide = slides[activeIndex];

  const [view, setView] = useState<EditorView>('normal');
  const [playing, setPlaying] = useState(false);
  const [selectionBoxes, setSelectionBoxes] = useState<SelectionBox[]>([]);
  const [selectionGeometry, setSelectionGeometry] =
    useState<GeometryValues | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [slideOpError, setSlideOpError] = useState('');
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const sessionRef = useRef<TransformSession | null>(null);
  const finishSessionRef = useRef<() => void>(() => undefined);
  const textBaselineRef = useRef(new WeakMap<HTMLElement, string>());
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
    if (slideOpBusyRef.current || !actionsRef.current.settlePendingEdits()) return;
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

  const startPlay = useCallback(
    (fromCurrent: boolean) => {
      if (!actionsRef.current.settlePendingEdits()) return;
      const current = stateRef.current;
      if (current.slides.length === 0) return;
      actionsRef.current.clearSelection();
      clearOverlay();
      if (!fromCurrent) actionsRef.current.showSlide(0);
      setPlaying(true);
    },
    [clearOverlay]
  );

  const resolveConflict = useCallback((choice: ConflictResolution) => {
    const plan = planConflictResolution(choice);
    if (plan.applyExternal) {
      void actionsRef.current.reload();
    } else {
      void actionsRef.current.overwrite();
    }
  }, []);

  const handleSelectObject = useCallback((path: number[]) => {
    if (!actionsRef.current.settlePendingEdits()) return;
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
      if (!actionsRef.current.settlePendingEdits()) return false;
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
      const top = elementAtPath(slideInfo.element, [selected.path[0] ?? -1]);
      if (!top || isLockedElement(top) || isHiddenElement(top)) return false;
      if (isGroupElement(top) && (field === 'width' || field === 'height')) {
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
      if (!actionsRef.current.settlePendingEdits()) return;
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
      if (!actionsRef.current.settlePendingEdits()) return false;
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
    if (!actionsRef.current.settlePendingEdits()) return false;
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
      if (!actionsRef.current.settlePendingEdits()) return;
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

  /**
   * Connects once the initial deck exists, so the hello revision is compared
   * against a loaded master instead of an empty one. EventSource reconnects on
   * its own; a host restart changes the port/token and needs a page reload.
   */
  const liveEventsRef = useRef<EventSource | null>(null);
  useEffect(() => {
    if (liveEventsRef.current || !master) return;
    const token = tokenFromLocation();
    if (!token) return;
    liveEventsRef.current = openDeckEvents(token, (event) => {
      actionsRef.current.receiveRevision(event);
    });
  }, [master]);

  useEffect(
    () => () => {
      liveEventsRef.current?.close();
      liveEventsRef.current = null;
    },
    []
  );

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!stateRef.current.dirty && !stateRef.current.pending) return;
      actionsRef.current.flushBeforeUnload();
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

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
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setCanvasSize((previous) =>
        previous.width === bounds.width && previous.height === bounds.height
          ? previous
          : { width: bounds.width, height: bounds.height }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view, playing]);

  useEffect(() => {
    // Fit only when the slide identity or the canvas size changes. Depending
    // on the SlideInfo object would refit after every commit, because commits
    // re-detect the slide list and a user zoom would be lost.
    computeFitScale();
  }, [
    activeSlide?.id,
    activeSlide?.width,
    activeSlide?.height,
    canvasSize.width,
    canvasSize.height,
    computeFitScale,
    view
  ]);

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
      if (next === view || !actionsRef.current.settlePendingEdits()) return;
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
      if (!element || isHiddenElement(element)) continue;
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
    actionsRef.current.cancelPendingEdit('gesture');
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

    actionsRef.current.changePendingEdit('gesture', {
      apply: () => {
        finishSessionRef.current();
        return true;
      },
      discard: () => {
        sessionRef.current = null;
        detachSessionRef.current?.();
        detachSessionRef.current = null;
        setGuides([]);
      }
    });
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

  const applySession = useCallback(() => {
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
  finishSessionRef.current = applySession;

  const finishSession = useCallback(() => {
    if (sessionRef.current?.moved) actionsRef.current.settlePendingEdits('gesture');
    else applySession();
  }, [applySession]);

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
      if (!element || isLockedElement(element) || isGroupElement(element)) {
        return;
      }
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
      if (!element || isLockedElement(element) || isHiddenElement(element)) {
        return;
      }
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
        if (isLockedElement(element) || isHiddenElement(element)) {
          if (!isHiddenElement(element)) {
            boxes.push({
              rect: frameRectOf(rect, offset),
              rotation: rotationOf(element),
              path: target.path,
              elementId: target.elementId
            });
          }
          continue;
        }
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
    const top = elementAtPath(slide, [current.selection.path[0] ?? -1]);
    if (
      !top ||
      isLockedElement(top) ||
      isHiddenElement(top) ||
      isGroupElement(top)
    ) {
      return false;
    }
    const selected = elementAtPath(slide, current.selection.path);
    if (!selected) return false;

    const textElement = selected.matches(TEXT_EDITABLE_SELECTOR)
      ? selected
      : selected.querySelector(TEXT_EDITABLE_SELECTOR);
    const editable = textElement as HTMLElement | null;
    if (!editable || !editable.textContent?.trim()) return false;

    textBaselineRef.current.set(editable, editable.innerHTML);
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

  const runObjectCommand = useCallback(
    async (
      command: ObjectCommand,
      targets: readonly SelectionTarget[],
      options: { selectResult?: boolean } = {}
    ) => {
      if (targets.length === 0) return;
      if (!actionsRef.current.settlePendingEdits()) return;
      const current = stateRef.current;
      const slideInfo = current.slides[current.activeIndex];
      if (!slideInfo || !current.master) return;
      const slideIndex = current.activeIndex;

      let measurements: ObjectMeasurement[] = [];
      if (
        command.type === 'group' ||
        command.type === 'align' ||
        command.type === 'distribute'
      ) {
        const frameSlide = frameSlideNow();
        if (!frameSlide) return;
        try {
          measurements = targets.map((target) => {
            const element = elementAtPath(frameSlide, target.path);
            if (!element) throw new Error('Select the object again before changing layout.');
            const snapshot = snapshotGeometry(element, frameSlide);
            return { target, rect: snapshot.rect, offset: snapshot.offset };
          });
        } catch {
          return;
        }
      }

      try {
        await actionsRef.current.commitMaster((master) => {
          const result = applyObjectCommand(
            master,
            slideIndex,
            command,
            targets,
            measurements
          );
          if (!result.changed) return false;
          if (options.selectResult !== false && result.targets.length > 0) {
            actionsRef.current.selectTargets(result.targets);
          }
          return true;
        });
      } catch {
        // The controller already surfaced the failure and recorded no history.
      }
    },
    [frameSlideNow]
  );

  const handleObjectCommand = useCallback(
    (command: ObjectCommand) => {
      const current = stateRef.current;
      const targets = current.selections.filter(
        (target) => target.slideIndex === current.activeIndex
      );
      void runObjectCommand(command, targets);
    },
    [runObjectCommand]
  );

  const handleObjectRecovery = useCallback(
    (path: number[], action: 'unlock' | 'unhide') => {
      const current = stateRef.current;
      if (!current.slides[current.activeIndex]) return;
      const target: SelectionTarget = {
        slideIndex: current.activeIndex,
        path,
        elementId: null
      };
      const command: ObjectCommand =
        action === 'unlock'
          ? { type: 'lock', locked: false }
          : { type: 'hide', hidden: false };
      void runObjectCommand(command, [target], { selectResult: false });
    },
    [runObjectCommand]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent, activeDocument: Document | null) => {
      if (event.defaultPrevented) return;
      const active = activeDocument ?? document;
      const editable =
        isEditableTarget(active.activeElement) ||
        isEditableShortcutTarget(event.target);
      const current = stateRef.current;

      if (playing) {
        // F5 restarts at slide 1 while presenting; Shift+F5 is a no-op but
        // must not reach the browser refresh.
        if (event.key === 'F5') {
          event.preventDefault();
          if (
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
          ) {
            actionsRef.current.showSlide(0);
          }
          return;
        }
        // Escape is the exit hatch even when a deck control owns focus.
        if (event.key === 'Escape') {
          event.preventDefault();
          setPlaying(false);
          return;
        }
        if (editable) return;
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return;
        }
        switch (event.key) {
          case 'ArrowLeft':
          case 'PageUp':
            event.preventDefault();
            actionsRef.current.showSlide(current.activeIndex - 1);
            return;
          case 'ArrowRight':
          case ' ':
          case 'Spacebar':
          case 'PageDown':
            event.preventDefault();
            actionsRef.current.showSlide(current.activeIndex + 1);
            return;
          case 'Home':
            event.preventDefault();
            actionsRef.current.showSlide(0);
            return;
          case 'End':
            event.preventDefault();
            actionsRef.current.showSlide(current.slides.length - 1);
            return;
          default:
            return;
        }
      }

      if (editable) return;
      const action = mapShortcut(event);
      if (!action) return;

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
        case 'group':
          if (current.selections.length < 2) return;
          event.preventDefault();
          handleObjectCommand({ type: 'group' });
          return;
        case 'ungroup':
          if (current.selections.length !== 1) return;
          event.preventDefault();
          handleObjectCommand({ type: 'ungroup' });
          return;
        case 'export':
        case 'help':
          // Export is M5; help is not part of the shell.
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
          event.preventDefault();
          startPlay(action.type === 'play-from-current');
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
      handleObjectCommand,
      nudgeSelection,
      playing,
      startPlay,
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
      if (!actionsRef.current.settlePendingEdits()) return;

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
      const clickedTop = elementAtPath(frameSlide, selected.path);
      if (
        !clickedTop ||
        isLockedElement(clickedTop) ||
        isHiddenElement(clickedTop)
      ) {
        // Locked objects stay selectable but inert: no native text selection
        // drag, and no editor transform session.
        if (clickedTop) event.preventDefault();
        return;
      }

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
            item.element !== null &&
            !isLockedElement(item.element) &&
            !isHiddenElement(item.element)
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
      const slideRoot =
        frameDocument.querySelector(`[${FRAME_SLIDE_ATTRIBUTE}]`) ??
        frameDocument.body;
      let top: Element = editable;
      while (top.parentElement && top.parentElement !== slideRoot) {
        top = top.parentElement;
      }
      if (
        isLockedElement(top) ||
        isHiddenElement(top) ||
        isGroupElement(top)
      ) {
        return;
      }
      event.preventDefault();
      if (!editable.hasAttribute(EDITING_ATTRIBUTE)) {
        textBaselineRef.current.set(editable, editable.innerHTML);
      }
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

    const recordTextInput = (editable: HTMLElement) => {
      actionsRef.current.changePendingEdit('text',
        editable.innerHTML === textBaselineRef.current.get(editable) ? null : {
          apply: () => {
            void commit(editable);
            return true;
          },
          discard: () => {
            editable.removeAttribute(EDITING_ATTRIBUTE);
            editable.removeAttribute('contenteditable');
          }
        });
    };

    frameDocument.addEventListener('input', (event) => {
      const target = event.target as HTMLElement | null;
      const editable = target?.closest<HTMLElement>(`[${EDITING_ATTRIBUTE}]`);
      if (editable) recordTextInput(editable);
    });

    frameDocument.addEventListener('focusout', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.hasAttribute(EDITING_ATTRIBUTE)) {
        if (target.innerHTML !== textBaselineRef.current.get(target)) recordTextInput(target);
        actionsRef.current.settlePendingEdits('text');
        target.removeAttribute(EDITING_ATTRIBUTE);
        target.removeAttribute('contenteditable');
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

  const objectActions = objectActionStateFor(activeSlide, selections, activeIndex);
  const primaryObject =
    activeSlide && selection
      ? elementAtPath(activeSlide.element, selection.path)
      : null;
  const overlayHandles =
    primaryObject && isLockedElement(primaryObject)
      ? 'none'
      : primaryObject && isGroupElement(primaryObject)
        ? 'rotate'
        : 'all';

  if (playing && activeSlide) {
    return (
      <PlayView
        slide={activeSlide}
        srcDoc={
          master
            ? buildSlideSrcDoc(master, activeSlide, { markFrame: false })
            : srcDoc
        }
        onKeyDown={(event, playDocument) =>
          keyDownRef.current(event, playDocument)
        }
      />
    );
  }

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
        onPlay={() => startPlay(false)}
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

      {conflict && (
        <div
          data-testid="conflict-banner"
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-400/30 bg-amber-950/50 px-4 py-2 text-xs text-amber-100"
        >
          <span>外部已修改檔案，本機有尚未儲存的變更。</span>
          {state.pending && (
            <span data-testid="pending-edit-instruction">請先套用或取消尚未完成的編輯，再覆寫。</span>
          )}
          <button
            type="button"
            data-testid="conflict-reload"
            disabled={state.recoveryBusy}
            onPointerDown={(event) => event.preventDefault()}
            className="rounded border border-amber-300/50 px-2 py-1 text-xs text-amber-100 transition-colors hover:border-amber-200"
            onClick={() => resolveConflict('reload')}
          >
            重新載入
          </button>
          <button
            type="button"
            data-testid="conflict-overwrite"
            disabled={state.recoveryBusy || state.pending}
            onPointerDown={(event) => event.preventDefault()}
            className="rounded border border-amber-300/50 px-2 py-1 text-xs text-amber-100 transition-colors hover:border-amber-200"
            onClick={() => resolveConflict('overwrite')}
          >
            覆寫
          </button>
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
                  key={state.documentEpoch}
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
                  handles={overlayHandles}
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
            key={`${state.documentEpoch}:${activeSlide?.id}`}
            pendingActions={actions}
            slide={activeSlide}
            selection={selection}
            selectionCount={selections.length}
            geometry={selectionGeometry}
            objectActions={objectActions}
            onSelectObject={handleSelectObject}
            onObjectCommand={handleObjectCommand}
            onObjectRecovery={handleObjectRecovery}
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
