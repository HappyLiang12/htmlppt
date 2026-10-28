import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import type {
  ImageCrop,
  ShapeAppearance,
  ShapeAppearanceValues,
  SlideInfo,
  Transition
} from '@htmlppt/core';
import type { ObjectCommand } from '../commands/objects';
import { useI18n, type MessageKey } from '../i18n';
import {
  elementAtPath,
  isEnterableContainer,
  type SelectionTarget
} from '../selection';
import { componentLabel } from '../component-target';
import type { DeckControllerActions } from '../use-deck-controller';
import { EDIT_HINT_KEYS, type EditHintReason } from '../text-edit-block';
import {
  backgroundOf,
  formatGeometryValue,
  geometryCommitValue,
  notesOf,
  parseGeometryValue,
  summarizeObjects,
  transitionOf,
  type BackgroundKind,
  type GeometryField,
  type GeometryValues,
  type SlideBackground
} from '../inspector-state';

export type InspectorTab = 'design' | 'text' | 'notes';

type PendingActions = Pick<DeckControllerActions,
  'changePendingEdit' | 'cancelPendingEdit' | 'settlePendingEdits'>;

export interface ObjectActionState {
  canGroup: boolean;
  canUngroup: boolean;
  canAlign: boolean;
  canDistribute: boolean;
  canOrder: boolean;
  canToggle: boolean;
  locked: boolean;
  hidden: boolean;
  group: boolean;
}

export interface InspectorStyleState {
  kind: 'shape' | 'image';
  svg: boolean;
  appearance: ShapeAppearanceValues;
  text: string;
  alt: string;
  crop: ImageCrop;
}

export interface InspectorChartState {
  type: string;
  title: string;
}

/**
 * The Text tab's view of the current selection. `reason` only covers reasons
 * the resolver emits; "no selection" maps to idle, never to a rejected
 * gesture, so the panel can index the hint table without a fallback.
 */
export interface InspectorTextAction {
  status: 'idle' | 'editable' | 'blocked' | 'multi';
  canEdit: boolean;
  canFormat: boolean;
  reason?: EditHintReason;
  text?: string;
}

const IDLE_TEXT_ACTION: InspectorTextAction = {
  status: 'idle',
  canEdit: false,
  canFormat: false
};

export interface InspectorProps {
  pendingActions: PendingActions;
  slide: SlideInfo | undefined;
  selection: SelectionTarget | null;
  /** Number of selected objects; more than one disables geometry fields. */
  selectionCount?: number;
  /**
   * A nested target whose top-level ancestor is locked, hidden, or a group.
   * The ancestor owns the subtree, so every geometry field stays disabled.
   */
  blockedByAncestor?: boolean;
  /**
   * The selection moves through a mechanism other than absolute geometry,
   * such as an SVG shape's transform or a table cell's own layout. Numeric
   * x/y/width/height/rotation would write the wrong contract.
   */
  geometryUnavailable?: boolean;
  /** Entered container path; absent means the slide is listed. */
  contextPath?: readonly number[];
  onEnterContext?: (path: number[]) => void;
  geometry: GeometryValues | null;
  style?: InspectorStyleState | null;
  chart?: InspectorChartState | null;
  styleDisabled?: boolean;
  objectActions: ObjectActionState;
  onSelectObject: (path: number[]) => void;
  onObjectCommand: (command: ObjectCommand) => void;
  onObjectRecovery: (path: number[], action: 'unlock' | 'unhide') => void;
  onCommitGeometry: (field: GeometryField, value: number) => boolean;
  onSetAppearance: (appearance: ShapeAppearance) => boolean;
  onSetShapeText: (text: string) => boolean;
  onSetImageAlt: (alt: string) => boolean;
  onSetImageCrop: (crop: ImageCrop | null) => boolean;
  onReplaceImageFile: (file: File) => void;
  onReplaceImageUrl: () => void;
  onEditChart: () => void;
  onPreviewTransition: (transition: Transition) => void;
  onSetTransition: (transition: Transition) => void;
  onSetBackground: (background: SlideBackground) => boolean;
  onClearBackground: () => boolean;
  onSetNotes: (notes: string) => void;
  textAction?: InspectorTextAction;
  onEditText?: () => void;
}

const ACTION_CLASS =
  'rounded border border-line-strong px-2 py-1 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

function ActionButton({
  testId,
  label,
  disabled,
  onClick
}: {
  testId: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={ACTION_CLASS}
    >
      {label}
    </button>
  );
}

const TABS: readonly { id: InspectorTab; labelKey: MessageKey }[] = [
  { id: 'design', labelKey: 'inspector.design' },
  { id: 'text', labelKey: 'inspector.text' },
  { id: 'notes', labelKey: 'inspector.notes' }
];

const FIELD_CLASS =
  'w-full rounded border border-line-strong bg-input px-2 py-1 text-xs tabular-nums text-ink outline-none transition-colors focus:border-accent/70 disabled:opacity-50';
const SECTION_CLASS =
  'flex flex-col gap-2 border-b border-line px-3 py-3 last:border-b-0';
const HEADING_CLASS =
  'text-[11px] font-semibold uppercase tracking-[0.14em] text-muted';

interface NumberFieldProps {
  pendingActions: PendingActions;
  field: GeometryField;
  label: string;
  value: number | null;
  disabled: boolean;
  onCommit: (field: GeometryField, value: number) => boolean;
}

function NumberField({
  pendingActions,
  field,
  label,
  value,
  disabled,
  onCommit
}: NumberFieldProps) {
  const { t } = useI18n();
  const formatted = value === null ? '' : formatGeometryValue(value);
  const [draft, setDraft] = useState(formatted);
  const [invalid, setInvalid] = useState(false);
  const pendingRef = useRef(false);
  const owner = `geometry-${field}`;

  useEffect(() => {
    if (!pendingRef.current) setDraft(formatted);
  }, [formatted]);

  const reset = () => {
    pendingRef.current = false;
    setInvalid(false);
    setDraft(formatted);
  };

  const change = (next: string) => {
    setDraft(next);
    setInvalid(false);
    pendingRef.current = next !== formatted;
    pendingActions.changePendingEdit(owner, pendingRef.current ? {
      apply: () => {
        if (value === null || parseGeometryValue(field, next) === null) {
          setInvalid(true);
          return false;
        }
        const parsed = geometryCommitValue(field, next, value);
        if (parsed !== null && !onCommit(field, parsed)) {
          reset();
          return true;
        }
        pendingRef.current = false;
        setDraft(parsed === null ? formatted : formatGeometryValue(parsed));
        setInvalid(false);
        return true;
      },
      discard: reset
    } : null);
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        data-testid={`field-${field}`}
        aria-label={label}
        value={draft}
        disabled={disabled}
        aria-invalid={invalid}
        onBlur={() => pendingActions.settlePendingEdits(owner)}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            pendingActions.cancelPendingEdit(owner);
            event.currentTarget.blur();
          }
        }}
        className={FIELD_CLASS}
      />
      {invalid && <span role="alert" className="text-[11px] text-danger">{t('inspector.invalidNumber')}</span>}
    </label>
  );
}

interface StyleFieldProps {
  pendingActions: PendingActions;
  owner: string;
  testId: string;
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onCommit: (value: string) => boolean;
}

function StyleField({
  pendingActions,
  owner,
  testId,
  label,
  value,
  disabled,
  placeholder,
  onCommit
}: StyleFieldProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const pendingRef = useRef(false);
  const pendingOwner = `style-${owner}`;

  useEffect(() => {
    if (!pendingRef.current) setDraft(value);
  }, [value]);

  const reset = () => {
    pendingRef.current = false;
    setInvalid(false);
    setDraft(value);
  };

  const change = (next: string) => {
    setDraft(next);
    setInvalid(false);
    pendingRef.current = next !== value;
    pendingActions.changePendingEdit(
      pendingOwner,
      pendingRef.current
        ? {
            apply: () => {
              if (!onCommit(next)) {
                setInvalid(true);
                return false;
              }
              pendingRef.current = false;
              setInvalid(false);
              return true;
            },
            discard: reset
          }
        : null
    );
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type="text"
        data-testid={testId}
        aria-label={label}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={invalid}
        onBlur={() => pendingActions.settlePendingEdits(pendingOwner)}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            pendingActions.cancelPendingEdit(pendingOwner);
            event.currentTarget.blur();
          }
        }}
        className={FIELD_CLASS}
      />
      {invalid && (
        <span role="alert" className="text-[11px] text-danger">
          {t('inspector.invalidValue')}
        </span>
      )}
    </label>
  );
}

function numeric(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// An HTML border needs both a width and a colour. The two fields commit on
// their own, so the half the user did not touch falls back to a visible
// default; otherwise core's width-or-colour-empty rule clears the border the
// other field just created. An emptied field stays an intentional clear.
const DEFAULT_STROKE_COLOR = '#000000';
const DEFAULT_STROKE_WIDTH = 1;

function visibleStrokeWidth(value: string): number {
  const width = parseFloat(value);
  return Number.isFinite(width) && width > 0 ? width : DEFAULT_STROKE_WIDTH;
}

export function Inspector({
  pendingActions,
  slide,
  selection,
  selectionCount = selection ? 1 : 0,
  blockedByAncestor = false,
  geometryUnavailable = false,
  contextPath,
  onEnterContext,
  geometry,
  style = null,
  chart = null,
  styleDisabled = false,
  objectActions,
  onSelectObject,
  onObjectCommand,
  onObjectRecovery,
  onCommitGeometry,
  onSetAppearance,
  onSetShapeText,
  onSetImageAlt,
  onSetImageCrop,
  onReplaceImageFile,
  onReplaceImageUrl,
  onEditChart,
  onPreviewTransition,
  onSetTransition,
  onSetBackground,
  onClearBackground,
  onSetNotes,
  textAction = IDLE_TEXT_ACTION,
  onEditText = () => undefined
}: InspectorProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<InspectorTab>('design');
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const objectListRef = useRef<HTMLUListElement | null>(null);
  const tabRefs = useRef<Record<InspectorTab, HTMLButtonElement | null>>({
    design: null,
    text: null,
    notes: null
  });
  const notes = notesOf(slide?.element);
  const [notesDraft, setNotesDraft] = useState(notes);
  const notesPendingRef = useRef(false);

  const background = backgroundOf(slide?.element);
  const [backgroundKind, setBackgroundKind] = useState<BackgroundKind>(
    background?.kind ?? 'color'
  );
  const [backgroundValue, setBackgroundValue] = useState(
    background?.value ?? ''
  );
  const [backgroundError, setBackgroundError] = useState('');
  const backgroundPendingRef = useRef(false);

  // Staging a transition is local UI state: previews and cancellation never
  // touch the master document; only Apply calls onSetTransition.
  const committedTransition = transitionOf(slide?.element);
  const [transitionDraft, setTransitionDraft] = useState<Transition>(
    committedTransition
  );
  const transitionDirty = transitionDraft !== committedTransition;

  useEffect(() => {
    setTransitionDraft(committedTransition);
  }, [committedTransition, slide?.id]);

  useEffect(() => {
    if (!notesPendingRef.current) setNotesDraft(notes);
  }, [notes]);

  useEffect(() => {
    if (backgroundPendingRef.current) return;
    setBackgroundKind(background?.kind ?? 'color');
    setBackgroundValue(background?.value ?? '');
    setBackgroundError('');
  }, [background?.kind, background?.value, slide?.id]);

  // A non-empty path that no longer resolves to an enterable container is
  // stale: list the slide and keep every row path slide-rooted instead of
  // mixing slide-level rows with a dead prefix.
  const requestedContext = contextPath ?? [];
  const requestedElement =
    slide && requestedContext.length > 0
      ? elementAtPath(slide.element, requestedContext)
      : null;
  const contextActive =
    requestedElement !== null && isEnterableContainer(requestedElement);
  const contextBase = contextActive ? requestedContext : [];
  const contextElement =
    contextActive && requestedElement
      ? requestedElement
      : slide?.element ?? null;
  const objects = contextElement ? summarizeObjects(contextElement) : [];
  const multi = selectionCount > 1;
  // Structural commands stay top-level only, so a nested selection still
  // needs an explanation even though its position, size, and appearance are
  // now editable.
  const nested = selection !== null && selection.path.length > 1;
  const readOnly = multi;
  const selectedTopPath = selection?.path.slice(contextBase.length)[0];
  const geometryLocked =
    readOnly ||
    blockedByAncestor ||
    geometryUnavailable ||
    objectActions.locked ||
    objectActions.hidden;
  const sizeLocked = geometryLocked || objectActions.group;

  // A single selection below the active context can become the new editing
  // context. Leaves, guarded subtrees, the active container itself, and a
  // multi-selection have nothing to enter; without a handler the action has
  // nowhere to go.
  const selectedElement =
    slide && selection ? elementAtPath(slide.element, selection.path) : null;
  const canEnterSelection =
    selection !== null &&
    selectionCount === 1 &&
    onEnterContext !== undefined &&
    selection.path.join('.') !== contextBase.join('.') &&
    selectedElement !== null &&
    isEnterableContainer(selectedElement);
  const enterSelectionPath =
    canEnterSelection && selection ? [...selection.path] : null;

  const selectTab = (next: InspectorTab, focus: boolean) => {
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: InspectorTab
  ) => {
    const order = TABS.map((candidate) => candidate.id);
    const index = order.indexOf(current);
    let nextIndex: number;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % order.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + order.length) % order.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = order.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = order[nextIndex];
    if (next) selectTab(next, true);
  };

  const changeBackground = (kind: BackgroundKind, value: string) => {
    setBackgroundKind(kind);
    setBackgroundValue(value);
    setBackgroundError('');
    backgroundPendingRef.current = kind !== (background?.kind ?? 'color') || value !== (background?.value ?? '');
    pendingActions.changePendingEdit('background', backgroundPendingRef.current ? {
      apply: () => {
        if (!value.trim() || !onSetBackground({ kind, value: value.trim() })) {
          setBackgroundError(t('inspector.invalidBackground'));
          return false;
        }
        backgroundPendingRef.current = false;
        setBackgroundValue(value.trim());
        setBackgroundError('');
        return true;
      },
      discard: () => {
        backgroundPendingRef.current = false;
        setBackgroundKind(background?.kind ?? 'color');
        setBackgroundValue(background?.value ?? '');
        setBackgroundError('');
      }
    } : null);
  };

  const applyBackground = () => pendingActions.settlePendingEdits('background');

  const clearBackground = () => {
    pendingActions.cancelPendingEdit('background');
    setBackgroundError(
      onClearBackground() ? '' : t('inspector.clearBackgroundFailed')
    );
    setBackgroundValue('');
  };

  return (
    <aside
      data-testid="inspector"
      aria-label={t('inspector.panel')}
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface"
    >
      <div
        role="tablist"
        aria-label={t('inspector.tabs')}
        className="flex border-b border-line"
      >
        {TABS.map((candidate) => {
          const active = tab === candidate.id;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              id={`inspector-tab-${candidate.id}`}
              aria-selected={active}
              aria-controls={`inspector-panel-${candidate.id}`}
              data-testid={`inspector-tab-${candidate.id}`}
              ref={(element) => {
                tabRefs.current[candidate.id] = element;
              }}
              tabIndex={active ? 0 : -1}
              onClick={() => selectTab(candidate.id, false)}
              onKeyDown={(event) => handleTabKeyDown(event, candidate.id)}
              className={`flex-1 border-b-2 px-2 py-2 text-xs transition-colors ${
                active
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t(candidate.labelKey)}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="inspector-panel-design"
        aria-labelledby="inspector-tab-design"
        data-testid="inspector-panel-design"
        hidden={tab !== 'design'}
      >
        <section aria-label={t('inspector.objects')} className={SECTION_CLASS}>
          <div className="flex items-center justify-between">
            <h3 className={HEADING_CLASS}>{t('inspector.objects')}</h3>
            {enterSelectionPath && selectedElement && (
              <button
                type="button"
                data-testid="inspector-enter-component"
                aria-label={t('editor.context.enter', {
                  name: componentLabel(selectedElement)
                })}
                onClick={() => {
                  onEnterContext?.(enterSelectionPath);
                  // The action unmounts with the old context; hand focus to
                  // the new object list instead of dropping it to the body.
                  window.requestAnimationFrame(() =>
                    objectListRef.current?.focus()
                  );
                }}
                className={ACTION_CLASS}
              >
                {t('inspector.enterComponent')}
              </button>
            )}
          </div>
          {objects.length === 0 ? (
            <p className="text-xs text-muted">{t('inspector.noObjects')}</p>
          ) : (
            <ul
              ref={objectListRef}
              tabIndex={-1}
              data-testid="object-list"
              className="flex flex-col gap-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {objects.map((object) => {
                const selected = selectedTopPath === object.path[0];
                const objectElement = contextElement?.children[object.index];
                const firstClass = objectElement
                  ?.getAttribute('class')
                  ?.trim()
                  .split(/\s+/)[0];
                const objectPath = [...contextBase, ...object.path];
                return (
                  <li
                    key={object.path.join('.')}
                    className={`flex items-stretch gap-1 rounded border transition-colors ${
                      selected
                        ? 'border-accent/70 bg-accent-soft'
                        : 'border-line hover:border-line-strong'
                    }`}
                  >
                    <button
                      type="button"
                      data-testid="object-row"
                      data-object-id={object.elementId ?? undefined}
                      data-object-path={objectPath.join('.')}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectObject(objectPath)}
                      className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs ${
                        selected ? 'text-accent' : 'text-muted'
                      }`}
                    >
                      <span className="rounded bg-chip px-1 py-0.5 font-mono text-[10px] text-muted">
                        {object.tag}
                      </span>
                      {object.elementId && (
                        <span className="font-mono text-[10px] text-accent">
                          {object.elementId}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {object.text || t('inspector.emptyText')}
                      </span>
                      {object.group && (
                        <span className="rounded bg-chip px-1 py-0.5 text-[10px] text-muted">
                          {t('inspector.group')}
                        </span>
                      )}
                      {object.locked && (
                        <span
                          data-testid="object-locked-badge"
                          className="rounded bg-danger-soft px-1 py-0.5 text-[10px] text-danger"
                        >
                          {t('inspector.locked')}
                        </span>
                      )}
                      {object.hidden && (
                        <span
                          data-testid="object-hidden-badge"
                          className="rounded bg-warning-soft px-1 py-0.5 text-[10px] text-warning"
                        >
                          {t('inspector.hidden')}
                        </span>
                      )}
                    </button>
                    {object.hasChildren && onEnterContext ? (
                      <button
                        type="button"
                        aria-label={t('editor.context.enter', {
                          name: firstClass || object.tag
                        })}
                        onClick={() =>
                          onEnterContext([...contextBase, object.index])
                        }
                        className="shrink-0 px-2 text-[13px] leading-none text-muted transition-colors hover:text-ink"
                      >
                        ›
                      </button>
                    ) : null}
                    {object.locked && (
                      <button
                        type="button"
                        data-testid="object-unlock"
                        aria-label={t('inspector.unlockItemLabel', {
                          name: object.text || object.elementId || object.tag
                        })}
                        onClick={() => onObjectRecovery(objectPath, 'unlock')}
                        className="shrink-0 px-2 text-[11px] text-danger underline-offset-2 hover:underline"
                      >
                        {t('inspector.unlockItem')}
                      </button>
                    )}
                    {object.hidden && object.canUnhide && (
                      <button
                        type="button"
                        data-testid="object-unhide"
                        aria-label={t('inspector.showItemLabel', {
                          name: object.text || object.elementId || object.tag
                        })}
                        onClick={() => onObjectRecovery(objectPath, 'unhide')}
                        className="shrink-0 px-2 text-[11px] text-warning underline-offset-2 hover:underline"
                      >
                        {t('inspector.showItem')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selection && (
          <section
            data-testid="object-actions"
            aria-label={t('inspector.objectActions')}
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>{t('inspector.objectActions')}</h3>
            <div className="grid grid-cols-3 gap-1">
              <ActionButton
                testId="object-group"
                label={t('inspector.group')}
                disabled={!objectActions.canGroup}
                onClick={() => onObjectCommand({ type: 'group' })}
              />
              <ActionButton
                testId="object-ungroup"
                label={t('inspector.ungroup')}
                disabled={!objectActions.canUngroup}
                onClick={() => onObjectCommand({ type: 'ungroup' })}
              />
              <ActionButton
                testId="object-order-front"
                label={t('inspector.toFront')}
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'front' })}
              />
              <ActionButton
                testId="object-order-forward"
                label={t('inspector.forward')}
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'forward' })}
              />
              <ActionButton
                testId="object-order-backward"
                label={t('inspector.backward')}
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'backward' })}
              />
              <ActionButton
                testId="object-order-back"
                label={t('inspector.toBack')}
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'back' })}
              />
            </div>
            <h4 className="text-[11px] text-muted">
              {t('inspector.alignObject')}
            </h4>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  ['left', t('inspector.alignLeft')],
                  ['center', t('inspector.alignCenter')],
                  ['right', t('inspector.alignRight')],
                  ['top', t('inspector.alignTop')],
                  ['middle', t('inspector.alignMiddle')],
                  ['bottom', t('inspector.alignBottom')]
                ] as const
              ).map(([mode, label]) => (
                <ActionButton
                  key={mode}
                  testId={`align-${mode}`}
                  label={label}
                  disabled={!objectActions.canAlign}
                  onClick={() => onObjectCommand({ type: 'align', mode })}
                />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1">
              <ActionButton
                testId="distribute-horizontal"
                label={t('inspector.distributeH')}
                disabled={!objectActions.canDistribute}
                onClick={() => onObjectCommand({ type: 'distribute', axis: 'horizontal' })}
              />
              <ActionButton
                testId="distribute-vertical"
                label={t('inspector.distributeV')}
                disabled={!objectActions.canDistribute}
                onClick={() => onObjectCommand({ type: 'distribute', axis: 'vertical' })}
              />
            </div>
            <div className="grid grid-cols-2 gap-1">
              <ActionButton
                testId="object-lock"
                label={objectActions.locked ? t('inspector.unlock') : t('inspector.locked')}
                disabled={!objectActions.canToggle}
                onClick={() =>
                  onObjectCommand({ type: 'lock', locked: !objectActions.locked })
                }
              />
              <ActionButton
                testId="object-hide"
                label={objectActions.hidden ? t('inspector.show') : t('inspector.hide')}
                disabled={!objectActions.canToggle}
                onClick={() =>
                  onObjectCommand({ type: 'hide', hidden: !objectActions.hidden })
                }
              />
            </div>
          </section>
        )}

        {selection && chart && (
          <section
            data-testid="chart-object"
            aria-label={t('inspector.chart')}
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>{t('inspector.chart')}</h3>
            <p data-testid="chart-summary" className="text-xs text-muted">
              {chart.type} · {chart.title || t('inspector.untitled')}
            </p>
            <button
              type="button"
              data-testid="chart-edit"
              disabled={styleDisabled}
              onClick={onEditChart}
              className={ACTION_CLASS}
            >
              {t('inspector.editChart')}
            </button>
          </section>
        )}

        {selection && style && (
          <section
            data-testid="object-style"
            aria-label={t('inspector.objectAppearance')}
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>
              {style.kind === 'image' ? t('inspector.image') : t('inspector.appearance')}
            </h3>
            {style.kind === 'image' ? (
              <>
                <div className="flex gap-1">
                  <button
                    type="button"
                    data-testid="image-replace-upload"
                    disabled={styleDisabled}
                    onClick={() => replaceInput.current?.click()}
                    className={ACTION_CLASS}
                  >
                    {t('inspector.replaceImage')}
                  </button>
                  <button
                    type="button"
                    data-testid="image-replace-url"
                    disabled={styleDisabled}
                    onClick={onReplaceImageUrl}
                    className={ACTION_CLASS}
                  >
                    {t('inspector.imageUrlAction')}
                  </button>
                </div>
                <input
                  ref={replaceInput}
                  type="file"
                  data-testid="image-replace-input"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) onReplaceImageFile(file);
                  }}
                />
                <StyleField
                  pendingActions={pendingActions}
                  owner="image-alt"
                  testId="image-alt"
                  label={t('inspector.alt')}
                  value={style.alt}
                  disabled={styleDisabled}
                  onCommit={onSetImageAlt}
                />
                <span className="text-[11px] text-muted">{t('inspector.crop')}</span>
                <div className="grid grid-cols-4 gap-1">
                  {(
                    [
                      ['top', t('inspector.top')],
                      ['right', t('inspector.right')],
                      ['bottom', t('inspector.bottom')],
                      ['left', t('inspector.left')]
                    ] as const
                  ).map(([side, label]) => (
                    <StyleField
                      key={side}
                      pendingActions={pendingActions}
                      owner={`crop-${side}`}
                      testId={`image-crop-${side}`}
                      label={label}
                      value={String(style.crop[side])}
                      disabled={styleDisabled}
                      onCommit={(value) => {
                        const parsed = numeric(value);
                        if (parsed === null) return false;
                        const next = { ...style.crop, [side]: parsed };
                        const empty = Object.values(next).every(
                          (inset) => inset === 0
                        );
                        return empty ? onSetImageCrop(null) : onSetImageCrop(next);
                      }}
                    />
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <StyleField
                    pendingActions={pendingActions}
                    owner="image-radius"
                    testId="image-radius"
                    label={t('inspector.radius')}
                    value={style.appearance.radius}
                    disabled={styleDisabled}
                    onCommit={(value) => {
                      const parsed = numeric(value);
                      if (value.trim() && parsed === null) return false;
                      return onSetAppearance({ radius: parsed });
                    }}
                  />
                  <StyleField
                    pendingActions={pendingActions}
                    owner="image-opacity"
                    testId="image-opacity"
                    label={t('inspector.opacity')}
                    value={style.appearance.opacity}
                    disabled={styleDisabled}
                    onCommit={(value) => {
                      const parsed = numeric(value);
                      if (value.trim() && parsed === null) return false;
                      return onSetAppearance({ opacity: parsed });
                    }}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <StyleField
                    pendingActions={pendingActions}
                    owner="fill"
                    testId="style-fill"
                    label={t('inspector.fill')}
                    value={style.appearance.fill}
                    disabled={styleDisabled}
                    placeholder="#4f7cff"
                    onCommit={(value) =>
                      onSetAppearance({ fill: value.trim() || null })
                    }
                  />
                  <StyleField
                    pendingActions={pendingActions}
                    owner="stroke"
                    testId="style-stroke"
                    label={t('inspector.borderColor')}
                    value={style.appearance.stroke}
                    disabled={styleDisabled}
                    placeholder="#000000"
                    onCommit={(value) => {
                      const stroke = value.trim() || null;
                      // The SVG panel reads the width from the first paint
                      // target only, while core maps one width onto every
                      // target; re-sending it on a colour edit would collapse
                      // per-target widths. The SVG branch keeps the width on a
                      // colour-only patch, so only HTML needs the merged half.
                      if (style.svg) return onSetAppearance({ stroke });
                      return onSetAppearance({
                        stroke,
                        strokeWidth: visibleStrokeWidth(
                          style.appearance.strokeWidth
                        )
                      });
                    }}
                  />
                  <StyleField
                    pendingActions={pendingActions}
                    owner="stroke-width"
                    testId="style-stroke-width"
                    label={t('inspector.borderWidth')}
                    value={style.appearance.strokeWidth}
                    disabled={styleDisabled}
                    placeholder="0"
                    onCommit={(value) => {
                      const parsed = numeric(value);
                      if (value.trim() && parsed === null) return false;
                      const width = parsed ?? 0;
                      // An existing colour is already on the element and core
                      // keeps it on a width-only patch, so re-sending it would
                      // only re-validate a value the panel merely echoes (an
                      // SVG gradient reference is not accepted as a colour).
                      // A missing colour is the half that needs the default.
                      if (style.appearance.stroke.trim()) {
                        return onSetAppearance({ strokeWidth: width });
                      }
                      return onSetAppearance({
                        strokeWidth: width,
                        stroke: width > 0 ? DEFAULT_STROKE_COLOR : null
                      });
                    }}
                  />
                  {!style.svg && (
                    <StyleField
                      pendingActions={pendingActions}
                      owner="radius"
                      testId="style-radius"
                      label={t('inspector.radius')}
                      value={style.appearance.radius}
                      disabled={styleDisabled}
                      onCommit={(value) => {
                        const parsed = numeric(value);
                        if (value.trim() && parsed === null) return false;
                        return onSetAppearance({ radius: parsed });
                      }}
                    />
                  )}
                  <StyleField
                    pendingActions={pendingActions}
                    owner="opacity"
                    testId="style-opacity"
                    label={t('inspector.opacity')}
                    value={style.appearance.opacity}
                    disabled={styleDisabled}
                    onCommit={(value) => {
                      const parsed = numeric(value);
                      if (value.trim() && parsed === null) return false;
                      return onSetAppearance({ opacity: parsed });
                    }}
                  />
                </div>
                {style.svg && (
                  <StyleField
                    pendingActions={pendingActions}
                    owner="shape-text"
                    testId="style-shape-text"
                    label={t('inspector.shapeText')}
                    value={style.text}
                    disabled={styleDisabled}
                    onCommit={onSetShapeText}
                  />
                )}
              </>
            )}
          </section>
        )}

        {selection ? (
          <section
            data-testid="inspector-geometry"
            aria-label={t('inspector.geometry')}
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>{t('inspector.geometry')}</h3>
            {objectActions.hidden ? (
              <p data-testid="object-state-message" className="text-[11px] text-muted">
                {t('inspector.hiddenHint')}
              </p>
            ) : objectActions.locked ? (
              <p data-testid="object-state-message" className="text-[11px] text-muted">
                {t('inspector.lockedHint')}
              </p>
            ) : multi ? (
              <p className="text-[11px] text-muted">
                {t('inspector.multiHint', { count: selectionCount })}
              </p>
            ) : objectActions.group ? (
              <p data-testid="object-state-message" className="text-[11px] text-muted">
                {t('inspector.groupHint')}
              </p>
            ) : (
              nested && (
                <p
                  data-testid="inspector-nested-structural"
                  className="text-[11px] text-muted"
                >
                  {t('inspector.nestedStructuralHint')}
                </p>
              )
            )}
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                field="x"
                label="X"
                value={geometry?.x ?? null}
                disabled={geometryLocked || geometry === null}
                pendingActions={pendingActions}
                onCommit={onCommitGeometry}
              />
              <NumberField
                field="y"
                label="Y"
                value={geometry?.y ?? null}
                disabled={geometryLocked || geometry === null}
                pendingActions={pendingActions}
                onCommit={onCommitGeometry}
              />
              <NumberField
                field="width"
                label={t('inspector.width')}
                value={geometry?.width ?? null}
                disabled={sizeLocked || geometry === null}
                pendingActions={pendingActions}
                onCommit={onCommitGeometry}
              />
              <NumberField
                field="height"
                label={t('inspector.height')}
                value={geometry?.height ?? null}
                disabled={sizeLocked || geometry === null}
                pendingActions={pendingActions}
                onCommit={onCommitGeometry}
              />
              <div className="col-span-2">
                <NumberField
                  field="rotation"
                  label={t('inspector.rotation')}
                  value={geometry?.rotation ?? null}
                  disabled={geometryLocked || geometry === null}
                  pendingActions={pendingActions}
                onCommit={onCommitGeometry}
                />
              </div>
            </div>
          </section>
        ) : (
          <section
            data-testid="slide-settings"
            aria-label={t('inspector.slide')}
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>{t('inspector.slide')}</h3>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted">{t('inspector.transition')}</span>
              <select
                data-testid="transition-select"
                aria-label={t('inspector.transition')}
                value={transitionDraft}
                onChange={(event) =>
                  setTransitionDraft(event.target.value as Transition)
                }
                className={FIELD_CLASS}
              >
                <option value="none">{t('inspector.transitionNone')}</option>
                <option value="fade">{t('inspector.transitionFade')}</option>
                <option value="slide">{t('inspector.transitionSlide')}</option>
              </select>
              <div className="flex gap-1">
                <button
                  type="button"
                  data-testid="transition-preview"
                  disabled={transitionDraft === 'none'}
                  onClick={() => onPreviewTransition(transitionDraft)}
                  className={ACTION_CLASS}
                >
                  {t('inspector.preview')}
                </button>
                <button
                  type="button"
                  data-testid="transition-apply"
                  disabled={!transitionDirty}
                  onClick={() => onSetTransition(transitionDraft)}
                  className={ACTION_CLASS}
                >
                  {t('common.apply')}
                </button>
                <button
                  type="button"
                  data-testid="transition-cancel"
                  disabled={!transitionDirty}
                  onClick={() => setTransitionDraft(committedTransition)}
                  className={ACTION_CLASS}
                >
                  {t('common.cancel')}
                </button>
              </div>
              {transitionDirty && (
                <span className="text-[11px] text-warning">
                  {t('inspector.notApplied')}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted">{t('inspector.background')}</span>
              <div className="flex gap-1">
                <select
                  data-testid="background-kind"
                  aria-label={t('inspector.backgroundKind')}
                  value={backgroundKind}
                  onChange={(event) => changeBackground(event.target.value as BackgroundKind, '')}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') pendingActions.cancelPendingEdit('background');
                  }}
                  className={`${FIELD_CLASS} w-24 shrink-0`}
                >
                  <option value="color">{t('inspector.backgroundKindColor')}</option>
                  <option value="gradient">{t('inspector.backgroundKindGradient')}</option>
                  <option value="image">{t('inspector.backgroundImage')}</option>
                </select>
                <input
                  type="text"
                  data-testid="background-value"
                  aria-label={t('inspector.backgroundValue')}
                  value={backgroundValue}
                  placeholder={
                    backgroundKind === 'color'
                      ? '#f7f5ef'
                      : backgroundKind === 'gradient'
                        ? 'linear-gradient(…)'
                        : 'https://…'
                  }
                  onChange={(event) => changeBackground(backgroundKind, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      applyBackground();
                    } else if (event.key === 'Escape') {
                      pendingActions.cancelPendingEdit('background');
                    }
                  }}
                  className={FIELD_CLASS}
                />
              </div>
              <div className="flex justify-end gap-1">
                <button
                  type="button"
                  data-testid="clear-background"
                  onClick={clearBackground}
                  disabled={background === null}
                  className="rounded border border-line-strong px-2 py-1 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
                >
                  {t('inspector.clearBackground')}
                </button>
                <button
                  type="button"
                  data-testid="apply-background"
                  onClick={applyBackground}
                  disabled={!backgroundValue.trim()}
                  className="rounded border border-line-strong px-2 py-1 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
                >
                  {t('common.apply')}
                </button>
              </div>
              {backgroundError && (
                <p
                  data-testid="background-error"
                  role="alert"
                  className="text-[11px] text-danger"
                >
                  {backgroundError}
                </p>
              )}
            </div>
          </section>
        )}
      </div>

      <div
        role="tabpanel"
        id="inspector-panel-text"
        aria-labelledby="inspector-tab-text"
        data-testid="inspector-panel-text"
        hidden={tab !== 'text'}
      >
        <div className={SECTION_CLASS}>
          <h3 className={HEADING_CLASS}>{t('inspector.text')}</h3>
          {textAction.status === 'idle' && (
            <p data-testid="inspector-text-idle" className="text-xs text-muted">
              {t('inspector.textIdle')}
            </p>
          )}
          {textAction.status === 'multi' && (
            <p data-testid="inspector-text-multi" className="text-xs text-muted">
              {t('inspector.textMulti')}
            </p>
          )}
          {textAction.status === 'blocked' && (
            <p data-testid="inspector-text-blocked" className="text-xs text-muted">
              {t(EDIT_HINT_KEYS[textAction.reason ?? 'not-text'])}
            </p>
          )}
          {textAction.status === 'editable' && (
            <>
              <ActionButton
                testId="inspector-edit-text"
                label={t('inspector.editText')}
                onClick={onEditText}
              />
              <p data-testid="inspector-text-hint" className="text-xs text-muted">
                {textAction.text
                  ? t('inspector.textSelected', { text: textAction.text })
                  : t('inspector.textEmpty')}
              </p>
            </>
          )}
        </div>
      </div>

      <div
        role="tabpanel"
        id="inspector-panel-notes"
        aria-labelledby="inspector-tab-notes"
        data-testid="inspector-panel-notes"
        hidden={tab !== 'notes'}
      >
        <div className={SECTION_CLASS}>
          <h3 className={HEADING_CLASS}>{t('inspector.speakerNotes')}</h3>
          <textarea
            key={slide?.id ?? 'no-slide'}
            data-testid="notes-input"
            aria-label={t('inspector.speakerNotes')}
            value={notesDraft}
            rows={8}
            placeholder={t('inspector.notesPlaceholder')}
            onChange={(event) => {
              const next = event.target.value;
              setNotesDraft(next);
              notesPendingRef.current = next !== notes;
              pendingActions.changePendingEdit('notes', notesPendingRef.current ? {
                apply: () => {
                  onSetNotes(next);
                  notesPendingRef.current = false;
                  return true;
                },
                discard: () => {
                  notesPendingRef.current = false;
                  setNotesDraft(notes);
                }
              } : null);
            }}
            onBlur={() => pendingActions.settlePendingEdits('notes')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') pendingActions.cancelPendingEdit('notes');
            }}
            className={`${FIELD_CLASS} resize-y font-sans`}
          />
          <p className="text-[11px] text-muted">
            {t('inspector.notesHint')}
          </p>
        </div>
      </div>
    </aside>
  );
}
