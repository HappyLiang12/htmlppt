import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { flushSync } from 'react-dom';
import {
  chartDataOf,
  deleteTableColumn,
  deleteTableRow,
  detectSlides,
  findSlide,
  imageCropOf,
  imageMimeFromFileName,
  imageSourceFromFile,
  insertTableColumn,
  insertTableRow,
  readShapeAppearance,
  replaceImageSource,
  sanitizePastedText,
  serializeDeck,
  serializeExport,
  setImageAlt,
  setImageCrop,
  setShapeAppearance,
  setShapeText,
  setStyle,
  toggleTableHeaderRow,
  type ImageCrop,
  type ShapeAppearance,
  type ShapeKind,
  type SlideInfo,
  type Transition
} from '@htmlppt/core';
import {
  prepareInsertion,
  type InsertRequest
} from './commands/insert';
import {
  applyTextCommand,
  currentTextRange,
  readTextToolbarState,
  type TextCommand,
  type TextToolbarState
} from './commands/rich-text';
import {
  chartFigure,
  chartJson,
  refreshChart,
  refreshCharts,
  withChartData
} from './commands/charts';
import {
  tableContext,
  type TableAction
} from './commands/tables';
import { TextToolbar } from './components/TextToolbar';
import { TableToolbar } from './components/TableToolbar';
import { ChartDialog } from './components/ChartDialog';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { describeSelection, describeSlide } from './announcements';
import {
  DeckAuthError,
  DeckOpenError,
  exportDeck,
  fetchDeck,
  flushDeck,
  openDeck,
  openDeckEvents,
  saveDeck,
  type DeckPersistence,
  type ExportFormat
} from './api';
import { pickHtmlFile } from './file-picker';
import {
  deleteDraft,
  draftKey,
  hasUnsavedDraft,
  listDrafts,
  readDraft,
  writeDraft,
  type DraftRecord
} from './recovery';
import {
  createStandalonePersistence,
  downloadHtml,
  exportFileName,
  hashHtml,
  type StandaloneSession
} from './standalone';
import { StandaloneLauncher } from './components/StandaloneLauncher';
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
  transitionOf,
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
  type InspectorChartState,
  type InspectorStyleState,
  type ObjectActionState
} from './components/Inspector';
import {
  PlayView,
  isInteractiveDeckTarget,
  type FullscreenState
} from './components/PlayView';
import {
  parsePresenterMessage,
  presenterChannelName,
  presenterSlideIndex
} from './presenter-protocol';
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
import {
  isSwitchedFileConflict,
  useDeckController,
  type DeckControllerState
} from './use-deck-controller';

const TEXT_EDITABLE_SELECTOR =
  'h1, h2, h3, p, li, span, td, th, blockquote, figcaption, div';

// Div shapes and text boxes are leaf objects; a layout div with element
// children keeps its original semantic text target rather than becoming the
// edit surface itself.
function isLeafTextElement(element: HTMLElement): boolean {
  if (element.tagName !== 'DIV') return true;
  return Array.from(element.children).every((child) => child.tagName === 'BR');
}

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

/** The bootstrap URL carries the session token; never echo it to the user. */
function bootstrapOrigin(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function openErrorMessage(error: DeckOpenError): string {
  switch (error.code) {
    case 'invalid-path':
      return '路徑無效；請輸入 HTML 檔案路徑。';
    case 'not-found':
      return '找不到檔案。';
    case 'unsupported-extension':
      return '只支援 .html 或 .htm 檔案。';
    case 'invalid-deck':
      return '這個檔案不是有效的簡報。';
    case 'unauthorized':
      return '未授權，請重新整理頁面。';
    case 'host-closing':
      return '編輯器正在關閉，請稍後再試。';
    case 'deck-unreadable':
      return '無法讀取檔案。';
    case 'deck-already-open': {
      const origin = bootstrapOrigin(error.url);
      return origin
        ? `已在另一個 host 開啟：${origin}`
        : '此簡報已在另一個 host 開啟。';
    }
    default:
      return error.message || '開啟失敗。';
  }
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

  const standaloneRef = useRef<StandaloneSession | null>(null);
  const standalonePersistence = useMemo(
    () => createStandalonePersistence(() => standaloneRef.current),
    []
  );
  const persistence = useMemo<DeckPersistence>(
    () => ({
      load: () => fetchDeck(),
      save: (html, baseRevision, options) =>
        standaloneRef.current
          ? standalonePersistence.save(html, baseRevision, options)
          : saveDeck(html, baseRevision, options),
      flush: (html, baseRevision) => {
        if (standaloneRef.current) {
          standalonePersistence.flush(html, baseRevision);
        } else {
          flushDeck(html, baseRevision);
        }
      }
    }),
    [standalonePersistence]
  );

  const { state, actions } = useDeckController({ measurePastedObject, persistence });
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
    dirty,
    conflict
  } = state;

  const switchedFileConflict = isSwitchedFileConflict(conflict, filePath);

  const activeSlide = slides[activeIndex];

  const [view, setView] = useState<EditorView>('normal');
  const [playing, setPlaying] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const previousSelectionKeyRef = useRef('');
  const [fullscreen, setFullscreen] = useState<FullscreenState>('off');
  const [fullscreenNotice, setFullscreenNotice] = useState('');
  const [presenterError, setPresenterError] = useState('');
  const playingRef = useRef(false);
  const presentationIdRef = useRef<string | null>(null);
  const presentationRef = useRef<{
    sessionId: string;
    channel: BroadcastChannel;
    window: Window;
    closeTimer: number;
  } | null>(null);
  const [transitionPreview, setTransitionPreview] = useState<{
    transition: Transition;
    id: number;
  } | null>(null);
  const transitionPreviewSequence = useRef(0);
  const [selectionBoxes, setSelectionBoxes] = useState<SelectionBox[]>([]);
  const [selectionGeometry, setSelectionGeometry] =
    useState<GeometryValues | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [slideOpError, setSlideOpError] = useState('');
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [mode, setMode] = useState<'unknown' | 'host' | 'standalone'>(
    'unknown'
  );
  const [standalone, setStandalone] = useState<{
    name: string;
    canWrite: boolean;
  } | null>(null);
  const [standaloneDrafts, setStandaloneDrafts] = useState<DraftRecord[]>([]);
  const [standaloneError, setStandaloneError] = useState('');
  const [openingStandalone, setOpeningStandalone] = useState(false);
  const [openingDeck, setOpeningDeck] = useState(false);
  const [openDeckError, setOpenDeckError] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<DraftRecord | null>(null);
  const recoveryCheckedRef = useRef<string | null>(null);
  const downloadedDraftRef = useRef<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportSignal, setExportSignal] = useState(0);

  const sessionRef = useRef<TransformSession | null>(null);
  const finishSessionRef = useRef<() => void>(() => undefined);
  const textBaselineRef = useRef(new WeakMap<HTMLElement, string>());
  const [textToolbar, setTextToolbar] = useState<{
    state: TextToolbarState;
    error: string;
  } | null>(null);
  const [chartEditor, setChartEditor] = useState<{
    json: string;
    error: string;
  } | null>(null);
  const editingElementRef = useRef<HTMLElement | null>(null);
  const lastTextRangeRef = useRef<Range | null>(null);
  const toolbarInteractionRef = useRef(false);
  const textFocusTimerRef = useRef<number | null>(null);
  const toolbarFocusTimerRef = useRef<number | null>(null);
  const textPendingRef = useRef<(editable: HTMLElement) => void>(
    () => undefined
  );
  const detachSessionRef = useRef<(() => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The controller reports save/load completion through state, so an async
  // open must force a render before reading the result from stateRef.
  const [, syncControllerState] = useReducer((version: number) => version + 1, 0);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const keyDownRef = useRef<
    (event: KeyboardEvent, activeDocument: Document | null) => void
  >(() => undefined);
  const framePointerDownRef = useRef<
    (event: PointerEvent, frameDocument: Document) => void
  >(() => undefined);

  useEffect(
    () => () => {
      if (textFocusTimerRef.current !== null) {
        window.clearTimeout(textFocusTimerRef.current);
        textFocusTimerRef.current = null;
      }
      if (toolbarFocusTimerRef.current !== null) {
        window.clearTimeout(toolbarFocusTimerRef.current);
        toolbarFocusTimerRef.current = null;
      }
    },
    []
  );

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

  const requestPlayFullscreen = useCallback(async () => {
    const root = document.documentElement;
    if (
      !document.fullscreenEnabled ||
      typeof root.requestFullscreen !== 'function'
    ) {
      setFullscreen('unavailable');
      setFullscreenNotice(
        '此瀏覽器或環境不支援全螢幕。按 F11 可手動全螢幕；Escape 返回編輯器。'
      );
      return;
    }
    try {
      await root.requestFullscreen();
      setFullscreen('active');
      setFullscreenNotice('');
    } catch {
      setFullscreen('unavailable');
      setFullscreenNotice(
        '瀏覽器未允許全螢幕。按 F11 可手動全螢幕；Escape 返回編輯器。'
      );
    }
  }, []);

  const closePresenter = useCallback((notify: boolean) => {
    const presenter = presentationRef.current;
    if (!presenter) return;
    presentationRef.current = null;
    window.clearInterval(presenter.closeTimer);
    try {
      if (notify) {
        presenter.channel.postMessage({
          sessionId: presenter.sessionId,
          type: 'bye'
        });
      }
    } catch {
      // The presenter window may already be gone.
    }
    try {
      presenter.channel.close();
    } catch {
      // Closing an already-closed channel is harmless.
    }
    if (notify && !presenter.window.closed) {
      presenter.window.close();
    }
  }, []);

  const stopPlay = useCallback(() => {
    playingRef.current = false;
    closePresenter(true);
    setPlaying(false);
    setPresenterError('');
    setFullscreenNotice('');
    setFullscreen('off');
    presentationIdRef.current = null;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [closePresenter]);

  const openPresenter = useCallback(() => {
    if (!playing) return;
    const existing = presentationRef.current;
    if (existing && !existing.window.closed) {
      existing.window.focus();
      return;
    }
    if (existing) closePresenter(false);

    const sessionId =
      presentationIdRef.current ?? crypto.randomUUID();
    presentationIdRef.current = sessionId;
    const popup = window.open(
      `/?presenter=1&session=${encodeURIComponent(sessionId)}`,
      presenterChannelName(sessionId),
      'popup=yes,width=960,height=720'
    );
    if (!popup) {
      setPresenterError(
        '瀏覽器封鎖了簡報者視窗。請允許此網站開啟彈出視窗，再按 P 或「簡報者」重試。'
      );
      return;
    }

    const channel = new BroadcastChannel(presenterChannelName(sessionId));
    const presenter = { sessionId, channel, window: popup, closeTimer: 0 };
    presentationRef.current = presenter;

    let snapshotSlides: DeckControllerState['slides'] | null = null;
    let snapshotHtml = '';
    const sendSnapshot = () => {
      const current = stateRef.current;
      if (!current.master) return;
      if (snapshotSlides !== current.slides) {
        snapshotHtml = serializeDeck(current.master);
        snapshotSlides = current.slides;
        channel.postMessage({
          sessionId,
          type: 'snapshot',
          html: snapshotHtml,
          index: current.activeIndex,
          total: current.slides.length
        });
      }
      channel.postMessage({
        sessionId,
        type: 'state',
        index: current.activeIndex,
        total: current.slides.length
      });
    };

    channel.onmessage = (event) => {
      const message = parsePresenterMessage(event.data, sessionId);
      if (!message) return;
      if (message.type === 'request') {
        sendSnapshot();
      } else if (message.type === 'slide') {
        const current = stateRef.current;
        const target = presenterSlideIndex(
          message.index,
          current.slides.length
        );
        if (target !== null) actionsRef.current.showSlide(target);
      } else if (message.type === 'bye') {
        closePresenter(false);
      }
    };
    presenter.closeTimer = window.setInterval(() => {
      if (popup.closed) closePresenter(false);
    }, 1_000);
    // The popup sends its first request once its channel listener is live;
    // broadcasting before that would be dropped and the cache would suppress
    // the retry.
    setPresenterError('');
  }, [closePresenter, playing]);

  const startPlay = useCallback(
    (fromCurrent: boolean) => {
      if (!actionsRef.current.settlePendingEdits()) return;
      const current = stateRef.current;
      if (current.slides.length === 0) return;
      actionsRef.current.clearSelection();
      clearOverlay();
      if (!fromCurrent) actionsRef.current.showSlide(0);
      presentationIdRef.current = crypto.randomUUID();
      playingRef.current = true;
      setPresenterError('');
      setFullscreenNotice('');
      setFullscreen('off');
      void requestPlayFullscreen();
      setPlaying(true);
    },
    [clearOverlay, requestPlayFullscreen]
  );

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement !== null;
      setFullscreen(active ? 'active' : 'off');
      if (active) {
        setFullscreenNotice('');
      }
      if (!active && playingRef.current) {
        // Fullscreen can end without leaving play (for example when the
        // presenter popup opens). Keep presenting and explain how to return.
        setFullscreenNotice(
          '已離開全螢幕。按 F 重新進入，Escape 返回編輯器。'
        );
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const presenter = presentationRef.current;
    if (!presenter) return;
    if (presenter.window.closed) {
      closePresenter(false);
      return;
    }
    presenter.channel.postMessage({
      sessionId: presenter.sessionId,
      type: 'state',
      index: activeIndex,
      total: slides.length
    });
  }, [playing, activeIndex, slides.length, closePresenter]);

  const resolveConflict = useCallback((choice: ConflictResolution) => {
    if (
      choice === 'overwrite' &&
      isSwitchedFileConflict(
        stateRef.current.conflict,
        stateRef.current.filePath
      )
    ) {
      return;
    }
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
        selected.slideIndex !== current.activeIndex ||
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
        (master) => {
          const applied = applyGeometryEdit(
            master,
            selected,
            snapshot,
            field,
            value
          );
          if (applied && (field === 'width' || field === 'height')) {
            const updated = detectSlides(master)[selected.slideIndex]?.element;
            const element = updated
              ? elementAtPath(updated, selected.path)
              : null;
            if (element) {
              try {
                refreshChart(element);
              } catch {
                // Invalid authored chart JSON does not block geometry edits.
              }
            }
          }
          return applied;
        },
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

  const handlePreviewTransition = useCallback((transition: Transition) => {
    if (transition === 'none') return;
    const reduceMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    if (reduceMotion) return;
    transitionPreviewSequence.current += 1;
    setTransitionPreview({
      transition,
      id: transitionPreviewSequence.current
    });
  }, []);

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

  const applyPathEdit = useCallback(
    (
      slideId: string,
      path: readonly number[],
      mutate: (element: Element) => void
    ): boolean => {
      if (!actionsRef.current.settlePendingEdits()) return false;
      const master = stateRef.current.master;
      if (!master) return false;
      try {
        return applyInspectorEdit(
          master,
          (draft) => {
            const target = findSlide(draft, slideId);
            const element = elementAtPath(target.element, [...path]);
            if (!element) return false;
            mutate(element);
            return true;
          },
          () => void commitMasterDocument()
        );
      } catch {
        return false;
      }
    },
    [commitMasterDocument]
  );

  const applySelectionEdit = useCallback(
    (mutate: (element: Element) => void): boolean => {
      const current = stateRef.current;
      const selection = current.selection;
      const slideInfo = current.slides[current.activeIndex];
      if (
        !selection ||
        selection.slideIndex !== current.activeIndex ||
        current.selections.length !== 1 ||
        !slideInfo
      ) {
        return false;
      }
      const top = elementAtPath(slideInfo.element, [selection.path[0] ?? -1]);
      if (!top || isLockedElement(top) || isHiddenElement(top) || isGroupElement(top)) {
        return false;
      }
      return applyPathEdit(slideInfo.id, selection.path, mutate);
    },
    [applyPathEdit]
  );

  const handleSetAppearance = useCallback(
    (appearance: ShapeAppearance): boolean =>
      applySelectionEdit((element) => setShapeAppearance(element, appearance)),
    [applySelectionEdit]
  );

  const handleSetShapeText = useCallback(
    (text: string): boolean =>
      applySelectionEdit((element) => setShapeText(element, text)),
    [applySelectionEdit]
  );

  const handleSetImageAlt = useCallback(
    (alt: string): boolean =>
      applySelectionEdit((element) => setImageAlt(element, alt)),
    [applySelectionEdit]
  );

  const handleSetImageCrop = useCallback(
    (crop: ImageCrop | null): boolean =>
      applySelectionEdit((element) => setImageCrop(element, crop)),
    [applySelectionEdit]
  );

  const handleReplaceImageFile = useCallback((file: File) => {
    const current = stateRef.current;
    const selection = current.selection;
    const slideInfo = current.slides[current.activeIndex];
    if (
      !selection ||
      selection.slideIndex !== current.activeIndex ||
      current.selections.length !== 1 ||
      !slideInfo
    ) {
      return;
    }
    const slideId = slideInfo.id;
    const path = [...selection.path];
    void (async () => {
      try {
        const source = await imageSourceFromFile(file);
        if (!applyPathEdit(slideId, path, (element) => replaceImageSource(element, source))) {
          setSlideOpError('無法更換圖片；請重新選取物件後再試。');
        }
      } catch (error) {
        setSlideOpError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [applyPathEdit]);

  const handleReplaceImageUrl = useCallback(() => {
    const value = window.prompt('圖片網址（https:// 或 data:image/...）', 'https://');
    if (value === null) return;
    applySelectionEdit((element) => replaceImageSource(element, value));
  }, [applySelectionEdit]);

  const handleTableAction = useCallback(
    (action: TableAction) => {
      if (!actionsRef.current.settlePendingEdits()) return;
      const current = stateRef.current;
      const slideInfo = current.slides[current.activeIndex];
      const selection = current.selection;
      if (
        !selection ||
        selection.slideIndex !== current.activeIndex ||
        !slideInfo ||
        !current.master
      ) {
        return;
      }
      const context = tableContext(slideInfo.element, selection.path);
      if (!context) return;
      const top = elementAtPath(slideInfo.element, [context.tablePath[0] ?? -1]);
      if (!top || isLockedElement(top) || isHiddenElement(top) || isGroupElement(top)) {
        return;
      }
      try {
        const applied = applyInspectorEdit(
          current.master,
          (draft) => {
            const target = findSlide(draft, slideInfo.id);
            const table = elementAtPath(target.element, context.tablePath);
            if (!table) return false;
            if (action.type === 'row') {
              insertTableRow(table, context.row, action.position);
            } else if (action.type === 'delete-row') {
              deleteTableRow(table, context.row);
            } else if (action.type === 'column') {
              insertTableColumn(table, context.column, action.position);
            } else if (action.type === 'delete-column') {
              deleteTableColumn(table, context.column);
            } else {
              toggleTableHeaderRow(table);
            }
            return true;
          },
          () => void commitMasterDocument()
        );
        if (applied) {
          actionsRef.current.clearSelection();
          clearOverlay();
        }
      } catch (error) {
        setSlideOpError(error instanceof Error ? error.message : String(error));
      }
    },
    [clearOverlay, commitMasterDocument]
  );

  const handleTableCellStyle = useCallback(
    (styles: Record<string, string>): boolean => {
      if (!actionsRef.current.settlePendingEdits()) return false;
      const current = stateRef.current;
      const slideInfo = current.slides[current.activeIndex];
      const selection = current.selection;
      if (
        !selection ||
        selection.slideIndex !== current.activeIndex ||
        !slideInfo ||
        !current.master
      ) {
        return false;
      }
      const context = tableContext(slideInfo.element, selection.path);
      if (!context) return false;
      const top = elementAtPath(slideInfo.element, [context.tablePath[0] ?? -1]);
      if (!top || isLockedElement(top) || isHiddenElement(top) || isGroupElement(top)) {
        return false;
      }
      try {
        return applyInspectorEdit(
          current.master,
          (draft) => {
            const target = findSlide(draft, slideInfo.id);
            const cell = elementAtPath(target.element, context.cellPath);
            if (!cell) return false;
            setStyle(cell, styles);
            return true;
          },
          () => void commitMasterDocument()
        );
      } catch {
        return false;
      }
    },
    [commitMasterDocument]
  );

  const handleOpenChartEditor = useCallback(() => {
    const current = stateRef.current;
    const slideInfo = current.slides[current.activeIndex];
    const selection = current.selection;
    if (!selection || selection.slideIndex !== current.activeIndex || !slideInfo) {
      return;
    }
    const element = elementAtPath(slideInfo.element, selection.path);
    if (!chartFigure(element)) return;
    try {
      setChartEditor({ json: chartJson(element as Element), error: '' });
    } catch (error) {
      setSlideOpError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleApplyChart = useCallback(() => {
    const editor = chartEditor;
    if (!editor) return;
    if (!actionsRef.current.settlePendingEdits()) return;
    const current = stateRef.current;
    const slideInfo = current.slides[current.activeIndex];
    const selection = current.selection;
    if (
      !selection ||
      selection.slideIndex !== current.activeIndex ||
      !slideInfo ||
      !current.master
    ) {
      setChartEditor(null);
      return;
    }
    const top = elementAtPath(slideInfo.element, [selection.path[0] ?? -1]);
    if (!top || isLockedElement(top) || isHiddenElement(top) || isGroupElement(top)) {
      return;
    }
    let failure = '';
    const applied = applyInspectorEdit(
      current.master,
      (draft) => {
        const target = findSlide(draft, slideInfo.id);
        const element = elementAtPath(target.element, selection.path);
        if (!element || !chartFigure(element)) {
          failure = '選取的物件不是圖表。';
          return false;
        }
        const result = withChartData(element, editor.json);
        if (!result.ok) {
          failure = result.error;
          return false;
        }
        return true;
      },
      () => void commitMasterDocument()
    );
    if (!applied) {
      setChartEditor({ ...editor, error: failure || '無法套用圖表資料。' });
      return;
    }
    setChartEditor(null);
  }, [chartEditor, commitMasterDocument]);

  const openStandaloneFile = useCallback(
    async (file: File, handle: FileSystemFileHandle | null) => {
      if (!file.name || !/\.html?$/i.test(file.name)) {
        setStandaloneError('請選擇 .html 或 .htm 檔案。');
        return;
      }
      setOpeningStandalone(true);
      setStandaloneError('');
      try {
        const html = await file.text();
        standaloneRef.current = { name: file.name, handle };
        setStandalone({ name: file.name, canWrite: handle !== null });
        setMode('standalone');
        setRecoveryDraft(null);
        recoveryCheckedRef.current = null;
        await actions.load({
          html,
          revision: await hashHtml(html),
          filePath: file.name
        });
      } catch (cause) {
        setStandaloneError(
          cause instanceof Error ? cause.message : String(cause)
        );
      } finally {
        setOpeningStandalone(false);
      }
    },
    [actions]
  );

  const openDeckAtPath = useCallback(
    async (input: string): Promise<void> => {
      if (mode !== 'host' || openingDeck) return;
      setOpenDeckError(null);
      if (!actions.settlePendingEdits()) return;
      setOpeningDeck(true);
      try {
        await actions.saveNow();
        // saveNow can no-op (external busy, failed settlement) without an
        // error; a still-dirty deck must not be replaced under the user. The
        // controller update may not have rendered yet, so flush before reading.
        flushSync(() => syncControllerState());
        if (stateRef.current.dirty) {
          setOpenDeckError('儲存未完成，無法開啟另一個檔案。');
          return;
        }
        if (stateRef.current.conflict || stateRef.current.error) return;
        const opened = await openDeck(input);
        await actions.load(opened);
        // load reports failure as state, and its update may still be waiting
        // for a render. Flush so the URL only changes for a successful load.
        flushSync(() => syncControllerState());
        const current = stateRef.current;
        if (
          current.status === 'load-error' ||
          current.filePath !== opened.filePath
        ) {
          setOpenDeckError('載入失敗，已保留目前簡報。');
          return;
        }
        window.history.replaceState(null, '', opened.url);
      } catch (cause) {
        setOpenDeckError(
          cause instanceof DeckOpenError
            ? openErrorMessage(cause)
            : cause instanceof Error
              ? cause.message
              : String(cause)
        );
      } finally {
        setOpeningDeck(false);
      }
    },
    [mode, openingDeck, actions]
  );

  const pickDeck = useCallback(async (): Promise<void> => {
    if (openingDeck) return;
    setOpenDeckError(null);
    setOpeningDeck(true);
    try {
      const picked = await pickHtmlFile();
      if (!picked) return;
      if (!actions.settlePendingEdits()) return;
      await actions.saveNow();
      flushSync(() => syncControllerState());
      if (stateRef.current.dirty) {
        setOpenDeckError('儲存未完成，無法開啟另一個檔案。');
        return;
      }
      if (stateRef.current.conflict || stateRef.current.error) return;
      await openStandaloneFile(picked.file, picked.handle);
    } catch (cause) {
      setOpenDeckError(
        cause instanceof Error ? cause.message : String(cause)
      );
    } finally {
      setOpeningDeck(false);
    }
  }, [openingDeck, actions, openStandaloneFile]);

  // An open swaps the whole document under any active text/gesture session.
  // Park focus first so the outgoing deck cannot receive further edits.
  useEffect(() => {
    if (!openingDeck) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    const framed = frame.current?.contentDocument?.activeElement;
    if (framed instanceof HTMLElement) framed.blur();
  }, [openingDeck]);

  const restoreStandaloneDraft = useCallback(
    async (draft: DraftRecord) => {
      setOpeningStandalone(true);
      setStandaloneError('');
      try {
        standaloneRef.current = { name: draft.filePath, handle: null };
        setStandalone({ name: draft.filePath, canWrite: false });
        setMode('standalone');
        setStandaloneDrafts((current) =>
          current.filter((item) => item.key !== draft.key)
        );
        await actions.load({
          html: draft.html,
          revision: await hashHtml(draft.html),
          filePath: draft.filePath
        });
        actions.restoreDraft(draft.html);
      } catch (cause) {
        setStandaloneError(
          cause instanceof Error ? cause.message : String(cause)
        );
      } finally {
        setOpeningStandalone(false);
      }
    },
    [actions]
  );

  const discardStandaloneDraft = useCallback((draft: DraftRecord) => {
    void deleteDraft(draft.key);
    setStandaloneDrafts((current) =>
      current.filter((item) => item.key !== draft.key)
    );
  }, []);

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      const current = stateRef.current;
      if (!current.master) return;
      setExportError('');
      setExportMessage('');
      if (mode === 'standalone') {
        const name = standalone?.name ?? current.filePath;
        if (format !== 'html') {
          setExportError(
            '獨立模式不支援 PDF/PNG；請用 htmlppt open 開啟檔案。'
          );
          return;
        }
        downloadHtml(serializeExport(current.master), name);
        void deleteDraft(draftKey(name));
        setRecoveryDraft(null);
        setExportMessage(`已下載 ${exportFileName(name)}。`);
        return;
      }
      setExporting(format);
      try {
        const files = await exportDeck(format);
        setExportMessage(
          `已匯出 ${files.length} 個檔案：${files.join('、')}`
        );
        setAnnouncement(`已匯出 ${files.length} 個檔案。`);
      } catch (cause) {
        setExportError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setExporting(null);
      }
    },
    [mode, standalone?.name]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const deck = await fetchDeck();
        if (cancelled) return;
        setMode('host');
        await actions.load(deck);
      } catch (cause) {
        if (cancelled) return;
        if (
          cause instanceof DeckAuthError &&
          (cause.status === 401 ||
            cause.status === 403 ||
            cause.status >= 500)
        ) {
          setMode('host');
          await actions.load();
          return;
        }
        // A static editor without the host API is the upload/download mode.
        setMode('standalone');
        setStandaloneDrafts(await listDrafts());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actions]);

  // A broadcast rebind in another tab swaps the deck under this tab without a
  // navigation; keep the readable deck URL in step with the new file.
  useEffect(() => {
    if (mode !== 'host' || !filePath || !window.location.pathname.startsWith('/d/')) {
      return;
    }
    const name = filePath.split(/[\\/]/).pop() ?? '';
    if (!name) return;
    const next = `/d/${encodeURIComponent(name)}`;
    if (window.location.pathname !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [mode, filePath]);

  // Hold a debounced local draft while there are unsaved changes. A host save
  // deletes it; an upload-only standalone tab keeps it as its only recovery.
  useEffect(() => {
    if (!master || !dirty || mode === 'unknown') return;
    const name = filePath || standalone?.name || '';
    const key = draftKey(name);
    if (!key) return;
    const html = serializeDeck(master);
    // An explicit download already persisted this content; a pending debounce
    // must not resurrect the draft it just deleted.
    if (downloadedDraftRef.current === html) return;
    downloadedDraftRef.current = null;
    const timer = window.setTimeout(() => {
      void writeDraft({ key, filePath: name, html, savedAt: Date.now() });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [master, dirty, srcDoc, slides, filePath, standalone?.name, mode]);

  useEffect(() => {
    if (dirty || status !== 'saved') return;
    if (mode === 'standalone' && !standalone?.canWrite) return;
    const key = draftKey(filePath || standalone?.name || '');
    if (!key) return;
    void deleteDraft(key);
    setRecoveryDraft(null);
  }, [
    dirty,
    status,
    mode,
    standalone?.canWrite,
    standalone?.name,
    filePath
  ]);

  useEffect(() => {
    if (!master) return;
    const key = draftKey(filePath || standalone?.name || '');
    if (!key || recoveryCheckedRef.current === key) return;
    recoveryCheckedRef.current = key;
    let cancelled = false;
    void readDraft(key).then((draft) => {
      if (!cancelled && hasUnsavedDraft(draft, serializeDeck(master))) {
        setRecoveryDraft(draft);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [master, filePath, standalone?.name]);
  /**
   * Connects once the initial deck exists, so the hello revision is compared
   * against a loaded master instead of an empty one. EventSource reconnects on
   * its own; a host restart changes the port and cookie context, so the page
   * must be reloaded.
   */
  const liveEventsRef = useRef<EventSource | null>(null);
  useEffect(() => {
    if (liveEventsRef.current || !master || mode !== 'host') return;
    liveEventsRef.current = openDeckEvents((event) => {
      actionsRef.current.receiveRevision(event);
    });
  }, [master, mode]);

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

  useEffect(() => {
    const onPageHide = () => closePresenter(true);
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [closePresenter]);

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
    if (session.kind === 'resize') refreshCharts(session.slide);
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

  const beginTextEditing = useCallback((editable: HTMLElement) => {
    const document = editable.ownerDocument;
    const range = currentTextRange(document);
    editingElementRef.current = editable;
    lastTextRangeRef.current =
      range && editable.contains(range.commonAncestorContainer) ? range : null;
    setTextToolbar({
      state: readTextToolbarState(document, editable, lastTextRangeRef.current),
      error: ''
    });
  }, []);

  const endTextEditing = useCallback(() => {
    editingElementRef.current = null;
    lastTextRangeRef.current = null;
    setTextToolbar(null);
  }, []);

  const finishTextEditing = useCallback(
    (editable: HTMLElement) => {
      if (
        !editable.isConnected ||
        !editable.hasAttribute(EDITING_ATTRIBUTE) ||
        editingElementRef.current !== editable
      ) {
        return;
      }
      if (editable.innerHTML !== textBaselineRef.current.get(editable)) {
        textPendingRef.current(editable);
      }
      actionsRef.current.settlePendingEdits('text');
      editable.removeAttribute(EDITING_ATTRIBUTE);
      editable.removeAttribute('contenteditable');
      endTextEditing();
    },
    [endTextEditing]
  );

  // Focus parked in the parent toolbar still belongs to the text session;
  // finish it only once focus leaves the toolbar.
  useEffect(() => {
    const onFocusOut = (event: FocusEvent) => {
      if (toolbarInteractionRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const toolbar = target.closest('[data-testid="text-toolbar"]');
      if (!toolbar) return;
      const related = event.relatedTarget;
      if (related instanceof Node && toolbar.contains(related)) return;
      if (toolbarFocusTimerRef.current !== null) {
        window.clearTimeout(toolbarFocusTimerRef.current);
      }
      toolbarFocusTimerRef.current = window.setTimeout(() => {
        toolbarFocusTimerRef.current = null;
        const editable = editingElementRef.current;
        if (!editable) return;
        const active = document.activeElement;
        if (active === frame.current) return;
        if (
          active instanceof Element &&
          active.closest('[data-testid="text-toolbar"]')
        ) {
          return;
        }
        finishTextEditing(editable);
      }, 0);
    };
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('focusout', onFocusOut, true);
      if (toolbarFocusTimerRef.current !== null) {
        window.clearTimeout(toolbarFocusTimerRef.current);
        toolbarFocusTimerRef.current = null;
      }
    };
  }, [finishTextEditing]);

  const startTextEditing = useCallback((): boolean => {
    const current = stateRef.current;
    if (current.selections.length !== 1 || !current.selection) return false;
    if (current.selection.slideIndex !== current.activeIndex) return false;
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
    if (!editable || !isLeafTextElement(editable)) return false;
    // Empty div shapes and table cells accept a first text entry; other
    // semantic elements require existing content so Enter cannot inject text.
    if (
      !editable.textContent?.trim() &&
      editable.tagName !== 'DIV' &&
      editable.tagName !== 'TD' &&
      editable.tagName !== 'TH'
    ) {
      return false;
    }

    textBaselineRef.current.set(editable, editable.innerHTML);
    editable.setAttribute('contenteditable', 'true');
    editable.setAttribute(EDITING_ATTRIBUTE, 'true');
    editable.focus();
    beginTextEditing(editable);
    return true;
  }, [beginTextEditing]);

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
          stopPlay();
          return;
        }
        if (editable) return;
        // Space activates a focused deck control natively instead of
        // advancing the presentation.
        if (
          (event.key === ' ' || event.key === 'Spacebar') &&
          isInteractiveDeckTarget(event.target)
        ) {
          return;
        }
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return;
        }
        switch (event.key) {
          case 'p':
          case 'P':
            event.preventDefault();
            openPresenter();
            return;
          case 'f':
          case 'F':
            event.preventDefault();
            if (document.fullscreenElement) {
              void document.exitFullscreen().catch(() => undefined);
            } else {
              void requestPlayFullscreen();
            }
            return;
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
      // Modal dialogs own every key while they are open; their own handlers
      // provide Escape and focus trapping. Still suppress browser defaults
      // that would reload the page or open a save dialog behind the dialog.
      if (shortcutsOpen || chartEditor) {
        if (
          event.key === 'F5' ||
          ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')
        ) {
          event.preventDefault();
        }
        return;
      }
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
          if (standaloneRef.current && !standaloneRef.current.handle) {
            const savedMaster = stateRef.current.master;
            const name = standaloneRef.current.name;
            if (savedMaster) {
              const html = serializeDeck(savedMaster);
              downloadedDraftRef.current = html;
              // Await the delete: reloading immediately after the download can
              // otherwise abort the IndexedDB transaction and keep the draft.
              void deleteDraft(draftKey(name)).finally(() => {
                downloadHtml(html, name, '.html');
                setRecoveryDraft(null);
                setAnnouncement('已下載 HTML 檔。');
              });
            }
            return;
          }
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
          event.preventDefault();
          setExportSignal((value) => value + 1);
          return;
        case 'help':
          event.preventDefault();
          setShortcutsOpen(true);
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
      chartEditor,
      clearOverlay,
      computeFitScale,
      handleObjectCommand,
      nudgeSelection,
      playing,
      shortcutsOpen,
      startPlay,
      startTextEditing,
      stopPlay,
      openPresenter,
      requestPlayFullscreen,
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
        endTextEditing();
      } catch {
        // The controller already surfaced the status and message.
        editable.setAttribute('contenteditable', 'true');
        editable.setAttribute(EDITING_ATTRIBUTE, 'true');
      }
    },
    [actions, endTextEditing]
  );

  const onFrameLoad = useCallback(() => {
    const frameDocument = frame.current?.contentDocument;
    if (!frameDocument) return;

    setFrameEpoch((value) => value + 1);

    frameDocument.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !frameDocument.body.contains(target)) return;
      const editable = target.closest(TEXT_EDITABLE_SELECTOR) as HTMLElement | null;
      if (!editable || !isLeafTextElement(editable)) return;
      if (
        !editable.textContent?.trim() &&
        editable.tagName !== 'DIV' &&
        editable.tagName !== 'TD' &&
        editable.tagName !== 'TH'
      ) {
        return;
      }
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
      beginTextEditing(editable);
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
            endTextEditing();
          }
        });
    };
    textPendingRef.current = recordTextInput;

    frameDocument.addEventListener('input', (event) => {
      const target = event.target as HTMLElement | null;
      const editable = target?.closest<HTMLElement>(`[${EDITING_ATTRIBUTE}]`);
      if (editable) recordTextInput(editable);
    });

    frameDocument.addEventListener('paste', (event) => {
      const editable = editingElementRef.current;
      const target = event.target as Node | null;
      if (!editable || !target || !editable.contains(target)) return;
      const text = sanitizePastedText(
        event.clipboardData?.getData('text/plain') ?? ''
      );
      event.preventDefault();
      if (!text) return;
      const selection = frameDocument.getSelection();
      const range =
        selection && selection.rangeCount > 0
          ? selection.getRangeAt(0)
          : lastTextRangeRef.current;
      if (!range || !editable.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      const node = frameDocument.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      lastTextRangeRef.current = range;
      recordTextInput(editable);
      setTextToolbar((current) =>
        current
          ? {
              state: readTextToolbarState(frameDocument, editable, range),
              error: current.error
            }
          : current
      );
    });

    frameDocument.addEventListener('selectionchange', () => {
      const editable = editingElementRef.current;
      if (!editable || !editable.isConnected) return;
      const range = currentTextRange(frameDocument);
      if (range && editable.contains(range.commonAncestorContainer)) {
        lastTextRangeRef.current = range;
      }
      setTextToolbar((current) =>
        current
          ? {
              state: readTextToolbarState(
                frameDocument,
                editable,
                lastTextRangeRef.current
              ),
              error: current.error
            }
          : current
      );
    });

    frameDocument.addEventListener('focusout', (event) => {
      if (toolbarInteractionRef.current) return;
      const target = event.target as HTMLElement | null;
      if (!target?.hasAttribute(EDITING_ATTRIBUTE)) return;
      if (textFocusTimerRef.current !== null) {
        window.clearTimeout(textFocusTimerRef.current);
      }
      // Focus may be moving to the parent toolbar; decide after focus settles.
      textFocusTimerRef.current = window.setTimeout(() => {
        textFocusTimerRef.current = null;
        const active = document.activeElement;
        if (
          active instanceof Element &&
          active.closest('[data-testid="text-toolbar"]')
        ) {
          return;
        }
        finishTextEditing(target);
      }, 0);
    });

    frameDocument.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement | null)?.closest('a');
      if (link) event.preventDefault();
    });

    frameDocument.addEventListener('pointerdown', (event) => {
      framePointerDownRef.current(event, frameDocument);
    });
  }, [beginTextEditing, commit, endTextEditing, finishTextEditing]);

  const applyTextToolbarCommand = useCallback(
    (command: TextCommand) => {
      const frameDocument = frame.current?.contentDocument;
      const editable = editingElementRef.current;
      if (!frameDocument || !editable || !editable.isConnected) {
        endTextEditing();
        return;
      }
      try {
        applyTextCommand(
          frameDocument,
          editable,
          command,
          lastTextRangeRef.current
        );
        lastTextRangeRef.current =
          currentTextRange(frameDocument) ?? lastTextRangeRef.current;
        textPendingRef.current(editable);
        setTextToolbar({
          state: readTextToolbarState(
            frameDocument,
            editable,
            lastTextRangeRef.current
          ),
          error: ''
        });
        editable.focus();
      } catch (error) {
        setTextToolbar({
          state: readTextToolbarState(
            frameDocument,
            editable,
            lastTextRangeRef.current
          ),
          error: error instanceof Error ? error.message : String(error)
        });
        editable.focus();
      }
    },
    [endTextEditing]
  );

  const applyTextLink = useCallback(() => {
    const frameDocument = frame.current?.contentDocument;
    const editable = editingElementRef.current;
    if (!frameDocument || !editable || !editable.isConnected) {
      endTextEditing();
      return;
    }
    const current =
      readTextToolbarState(
        frameDocument,
        editable,
        lastTextRangeRef.current
      ).link ?? '';
    toolbarInteractionRef.current = true;
    let value: string | null = null;
    try {
      value = window.prompt(
        '連結網址（http:、https:、mailto: 或 #片段；留空移除連結）',
        current || 'https://'
      );
    } finally {
      toolbarInteractionRef.current = false;
    }
    if (value === null) return;
    try {
      applyTextCommand(
        frameDocument,
        editable,
        { type: 'link', value },
        lastTextRangeRef.current
      );
      lastTextRangeRef.current =
        currentTextRange(frameDocument) ?? lastTextRangeRef.current;
      textPendingRef.current(editable);
      setTextToolbar({
        state: readTextToolbarState(
          frameDocument,
          editable,
          lastTextRangeRef.current
        ),
        error: ''
      });
      editable.focus();
    } catch (error) {
      setTextToolbar({
        state: readTextToolbarState(
          frameDocument,
          editable,
          lastTextRangeRef.current
        ),
        error: error instanceof Error ? error.message : String(error)
      });
      editable.focus();
    }
  }, [endTextEditing]);

  const runInsertion = useCallback(async (request: InsertRequest) => {
    if (!actionsRef.current.settlePendingEdits()) return;
    const current = stateRef.current;
    const slideInfo = current.slides[current.activeIndex];
    if (!slideInfo || !current.master) return;
    const slideIndex = current.activeIndex;
    setSlideOpError('');
    try {
      const prepared = await prepareInsertion(request, {
        width: slideInfo.width,
        height: slideInfo.height
      });
      const after = stateRef.current;
      if (
        after.activeIndex !== slideIndex ||
        after.slides[slideIndex]?.id !== slideInfo.id
      ) {
        return;
      }
      await actionsRef.current.commitMaster((master) => {
        const target = findSlide(master, slideInfo.id);
        const element = prepared.apply(target.element);
        const path = [Array.from(target.element.children).indexOf(element)];
        const activeIndex = stateRef.current.activeIndex;
        if (
          activeIndex === slideIndex &&
          stateRef.current.slides[slideIndex]?.id === slideInfo.id
        ) {
          actionsRef.current.selectTargets([
            {
              slideIndex: activeIndex,
              path,
              elementId: element.getAttribute('data-ppt-el')
            }
          ]);
        }
        return true;
      });
    } catch (error) {
      setSlideOpError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }, []);

  const handleInsertShape = useCallback(
    (shape: ShapeKind) => {
      void runInsertion({ kind: 'shape', shape });
    },
    [runInsertion]
  );

  const handleInsertImageUrl = useCallback(() => {
    const value = window.prompt(
      '圖片網址（https:// 或 data:image/...）',
      'https://'
    );
    if (value === null) return;
    void runInsertion({ kind: 'image', url: value });
  }, [runInsertion]);

  useEffect(() => {
    if (!frameEpoch) return;
    const frameDocument = frame.current?.contentDocument;
    if (!frameDocument) return;

    const insertImageFiles = (files: FileList | null) => {
      const file = Array.from(files ?? []).find(
        (candidate) =>
          candidate.type.startsWith('image/') ||
          imageMimeFromFileName(candidate.name) !== null
      );
      if (file) void runInsertion({ kind: 'image', file });
    };

    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      insertImageFiles(event.dataTransfer.files);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (editingElementRef.current) return;
      const item = Array.from(event.clipboardData?.items ?? []).find(
        (candidate) =>
          candidate.kind === 'file' && candidate.type.startsWith('image/')
      );
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void runInsertion({ kind: 'image', file });
    };

    const targets: (Document | Window)[] = [frameDocument, window];
    for (const target of targets) {
      target.addEventListener('dragover', onDragOver as EventListener);
      target.addEventListener('drop', onDrop as EventListener);
      target.addEventListener('paste', onPaste as EventListener);
    }
    return () => {
      for (const target of targets) {
        target.removeEventListener('dragover', onDragOver as EventListener);
        target.removeEventListener('drop', onDrop as EventListener);
        target.removeEventListener('paste', onPaste as EventListener);
      }
    };
  }, [frameEpoch, runInsertion]);

  const goTo = (index: number) => {
    actions.showSlide(index);
  };

  const selectionKey = selections
    .map((target) => `${target.slideIndex}:${target.path.join('.')}`)
    .join('|');

  useEffect(() => {
    if (previousSelectionKeyRef.current === selectionKey) return;
    previousSelectionKeyRef.current = selectionKey;
    if (!selectionKey) {
      setAnnouncement('已取消選取');
      return;
    }
    const current = stateRef.current;
    const slide = current.slides[current.activeIndex];
    const target = current.selection;
    const element =
      slide && target ? elementAtPath(slide.element, target.path) : null;
    setAnnouncement(describeSelection(element, current.selections.length));
  }, [selectionKey]);

  useEffect(() => {
    if (slides.length === 0) return;
    setAnnouncement(describeSlide(activeIndex, slides.length));
  }, [activeIndex, activeSlide?.id, slides.length]);

  const objectActions = objectActionStateFor(activeSlide, selections, activeIndex);
  const styleState: InspectorStyleState | null = (() => {
    if (
      !activeSlide ||
      !selection ||
      selections.length !== 1 ||
      selection.path.length > 1
    ) {
      return null;
    }
    const element = elementAtPath(activeSlide.element, selection.path);
    if (!element) return null;
    const tag = element.tagName.toLowerCase();
    const kind = tag === 'img' ? 'image' : tag === 'svg' || tag === 'div' ? 'shape' : null;
    if (!kind) return null;
    return {
      kind,
      svg: tag === 'svg',
      appearance: readShapeAppearance(element),
      text:
        kind === 'shape' && tag === 'svg'
          ? element.querySelector('text')?.textContent ?? ''
          : '',
      alt: element.getAttribute('alt') ?? '',
      crop: imageCropOf(element) ?? { top: 0, right: 0, bottom: 0, left: 0 }
    };
  })();
  const tableSelection =
    activeSlide && selection
      ? tableContext(activeSlide.element, selection.path)
      : null;
  const tableState = tableSelection
    ? {
        row: tableSelection.row,
        column: tableSelection.column,
        rows: tableSelection.rows,
        columns: tableSelection.columns,
        header: tableSelection.header,
        fill:
          tableSelection.cell.style.background ||
          tableSelection.cell.style.backgroundColor,
        border:
          tableSelection.cell.style.borderTopColor ||
          tableSelection.cell.style.borderColor
      }
    : null;
  const primaryObject =
    activeSlide && selection
      ? elementAtPath(activeSlide.element, selection.path)
      : null;
  const chartState: InspectorChartState | null = (() => {
    if (!chartFigure(primaryObject)) return null;
    try {
      const data = chartDataOf(primaryObject as Element);
      return { type: data.type, title: data.title ?? '' };
    } catch {
      return { type: 'invalid', title: '資料無效' };
    }
  })();
  const overlayHandles =
    primaryObject && isLockedElement(primaryObject)
      ? 'none'
      : primaryObject && isGroupElement(primaryObject)
        ? 'rotate'
        : 'all';

  if (mode === 'standalone' && !master) {
    return (
      <StandaloneLauncher
        drafts={standaloneDrafts}
        error={standaloneError || (status === 'load-error' ? error : '')}
        busy={openingStandalone}
        onOpenFile={(file, handle) => void openStandaloneFile(file, handle)}
        onError={setStandaloneError}
        onRestore={(draft) => void restoreStandaloneDraft(draft)}
        onDiscard={discardStandaloneDraft}
      />
    );
  }

  if (playing && activeSlide) {
    return (
      <PlayView
        slide={activeSlide}
        srcDoc={
          master
            ? buildSlideSrcDoc(master, activeSlide, { markFrame: false })
            : srcDoc
        }
        transition={transitionOf(activeSlide.element)}
        fullscreen={fullscreen}
        fullscreenNotice={fullscreenNotice || undefined}
        presenterError={presenterError || undefined}
        onKeyDown={(event, playDocument) =>
          keyDownRef.current(event, playDocument)
        }
        onAdvance={() => {
          const current = stateRef.current;
          actionsRef.current.showSlide(
            Math.min(current.slides.length - 1, current.activeIndex + 1)
          );
        }}
        onOpenPresenter={openPresenter}
      />
    );
  }

  return (
    <div
      className="flex h-screen flex-col bg-[#0f1115] text-zinc-100"
      aria-busy={openingDeck || undefined}
    >
      <p
        data-testid="a11y-status"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      <Toolbar
        filePath={filePath}
        pathEditable={mode === 'host'}
        openingDeck={openingDeck}
        openDeckError={openDeckError}
        onOpenDeck={(path) => void openDeckAtPath(path)}
        onPickDeck={() => void pickDeck()}
        status={status}
        activeIndex={activeIndex}
        slideCount={slides.length}
        view={view}
        canDelete={slides.length > 1}
        onAddSlide={handleAddSlide}
        onDuplicateSlide={() => handleDuplicateSlide()}
        onDeleteSlide={() => handleDeleteSlide()}
        onInsertText={() => void runInsertion({ kind: 'text' })}
        onInsertShape={handleInsertShape}
        onInsertTable={(rows, columns) =>
          void runInsertion({ kind: 'table', rows, columns })
        }
        onInsertChart={() => void runInsertion({ kind: 'chart' })}
        onInsertImageFile={(file) =>
          void runInsertion({ kind: 'image', file })
        }
        onInsertImageUrl={handleInsertImageUrl}
        onUndo={actions.undo}
        onRedo={actions.redo}
        onPlay={() => startPlay(false)}
        onOpenHelp={() => setShortcutsOpen(true)}
        onViewChange={changeView}
        onPreviousSlide={() => goTo(activeIndex - 1)}
        onNextSlide={() => goTo(activeIndex + 1)}
        onExport={handleExport}
        exporting={exporting}
        exportSignal={exportSignal}
        standaloneMode={mode === 'standalone'}
        standaloneUpload={mode === 'standalone' && standalone?.canWrite === false}
      />

      {textToolbar && (
        <TextToolbar
          state={textToolbar.state}
          error={textToolbar.error || undefined}
          onCommand={applyTextToolbarCommand}
          onLink={applyTextLink}
        />
      )}

      {tableState && (
        <TableToolbar
          state={tableState}
          disabled={objectActions.locked || objectActions.hidden}
          onAction={handleTableAction}
          onCellStyle={handleTableCellStyle}
        />
      )}

      {chartEditor && (
        <ChartDialog
          json={chartEditor.json}
          error={chartEditor.error}
          onChange={(json) =>
            setChartEditor((current) =>
              current ? { json, error: '' } : current
            )
          }
          onApply={handleApplyChart}
          onCancel={() => setChartEditor(null)}
        />
      )}

      {shortcutsOpen && (
        <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />
      )}

      {(error || slideOpError || exportError) && (
        <div
          data-testid="editor-error"
          className="max-h-24 overflow-auto border-b border-red-500/30 bg-red-950/60 px-4 py-2 text-xs text-red-200"
        >
          {[error, slideOpError, exportError].filter(Boolean).join(' · ')}
        </div>
      )}

      {exportMessage && (
        <div
          data-testid="export-result"
          role="status"
          className="flex items-center gap-3 border-b border-emerald-500/30 bg-emerald-950/50 px-4 py-2 text-xs text-emerald-100"
        >
          <span className="min-w-0 flex-1 truncate">{exportMessage}</span>
          <button
            type="button"
            data-testid="export-dismiss"
            className="rounded border border-emerald-300/40 px-2 py-0.5 text-emerald-100"
            onClick={() => setExportMessage('')}
          >
            關閉
          </button>
        </div>
      )}

      {recoveryDraft && (
        <div
          data-testid="recovery-banner"
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-400/30 bg-amber-950/40 px-4 py-2 text-xs text-amber-100"
        >
          <span className="min-w-0 flex-1 truncate">
            發現上次未儲存的編輯：{recoveryDraft.filePath}
          </span>
          <button
            type="button"
            data-testid="recovery-restore"
            className="rounded border border-amber-300/50 px-2 py-1 text-xs text-amber-100"
            onClick={() => {
              actions.restoreDraft(recoveryDraft.html);
              setRecoveryDraft(null);
            }}
          >
            恢復
          </button>
          <button
            type="button"
            data-testid="recovery-discard"
            className="rounded border border-amber-300/50 px-2 py-1 text-xs text-amber-100"
            onClick={() => {
              void deleteDraft(recoveryDraft.key);
              setRecoveryDraft(null);
            }}
          >
            捨棄
          </button>
        </div>
      )}

      {conflict && (
        <div
          data-testid="conflict-banner"
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-400/30 bg-amber-950/50 px-4 py-2 text-xs text-amber-100"
        >
          <span>
            {switchedFileConflict
              ? '主機已切換到另一個檔案；只能重新載入。'
              : '外部已修改檔案，本機有尚未儲存的變更。'}
          </span>
          {!switchedFileConflict && state.pending && (
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
          {!switchedFileConflict && (
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
          )}
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
                {transitionPreview && (
                  <div
                    key={transitionPreview.id}
                    data-testid="transition-preview-overlay"
                    data-transition={transitionPreview.transition}
                    className={`htmlppt-transition-preview htmlppt-transition-preview--${transitionPreview.transition}`}
                    onAnimationEnd={() =>
                      setTransitionPreview((current) =>
                        current?.id === transitionPreview.id ? null : current
                      )
                    }
                  />
                )}
              </div>
            ) : status === 'loading' ? (
              <p className="text-sm text-zinc-400">載入中…</p>
            ) : (
              <p className="text-sm text-zinc-400">找不到投影片。</p>
            )}
          </main>

          <Inspector
            key={`${state.documentEpoch}:${activeSlide?.id}`}
            pendingActions={actions}
            slide={activeSlide}
            selection={selection}
            selectionCount={selections.length}
            geometry={selectionGeometry}
            style={styleState}
            chart={chartState}
            styleDisabled={objectActions.locked || objectActions.hidden}
            objectActions={objectActions}
            onSelectObject={handleSelectObject}
            onObjectCommand={handleObjectCommand}
            onObjectRecovery={handleObjectRecovery}
            onCommitGeometry={handleGeometryCommit}
            onSetAppearance={handleSetAppearance}
            onSetShapeText={handleSetShapeText}
            onSetImageAlt={handleSetImageAlt}
            onSetImageCrop={handleSetImageCrop}
            onReplaceImageFile={handleReplaceImageFile}
            onReplaceImageUrl={handleReplaceImageUrl}
            onEditChart={handleOpenChartEditor}
            onPreviewTransition={handlePreviewTransition}
            onSetTransition={handleTransitionChange}
            onSetBackground={handleBackgroundChange}
            onClearBackground={handleClearBackground}
            onSetNotes={handleNotesChange}
          />
        </div>
      )}

      {openingDeck && (
        <div
          data-testid="opening-overlay"
          aria-hidden="true"
          className="fixed inset-0 z-50 cursor-progress bg-black/10"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      )}
    </div>
  );
}
