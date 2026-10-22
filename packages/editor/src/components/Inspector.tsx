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
import type { SelectionTarget } from '../selection';
import type { DeckControllerActions } from '../use-deck-controller';
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

export interface InspectorProps {
  pendingActions: PendingActions;
  slide: SlideInfo | undefined;
  selection: SelectionTarget | null;
  /** Number of selected objects; more than one disables geometry fields. */
  selectionCount?: number;
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
}

const ACTION_CLASS =
  'rounded border border-white/15 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/30 disabled:cursor-not-allowed disabled:opacity-40';

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

const TABS: readonly { id: InspectorTab; label: string }[] = [
  { id: 'design', label: '設計' },
  { id: 'text', label: '文字' },
  { id: 'notes', label: '備註' }
];

const FIELD_CLASS =
  'w-full rounded border border-white/15 bg-black/20 px-2 py-1 text-xs tabular-nums text-zinc-100 outline-none transition-colors focus:border-amber-400/70 disabled:opacity-50';
const SECTION_CLASS =
  'flex flex-col gap-2 border-b border-white/10 px-3 py-3 last:border-b-0';
const HEADING_CLASS =
  'text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500';

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
      <span className="text-[11px] text-zinc-400">{label}</span>
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
      {invalid && <span role="alert" className="text-[11px] text-red-300">數值無效，請修正或按 Escape 取消。</span>}
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
      <span className="text-[11px] text-zinc-400">{label}</span>
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
        <span role="alert" className="text-[11px] text-red-300">
          值無效，請修正或按 Escape 取消。
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

export function Inspector({
  pendingActions,
  slide,
  selection,
  selectionCount = selection ? 1 : 0,
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
  onSetNotes
}: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('design');
  const replaceInput = useRef<HTMLInputElement | null>(null);
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

  const objects = slide ? summarizeObjects(slide.element) : [];
  const multi = selectionCount > 1;
  const readOnly = multi || (selection !== null && selection.path.length > 1);
  const selectedTopPath = selection?.path[0];
  const geometryLocked = readOnly || objectActions.locked || objectActions.hidden;
  const sizeLocked = geometryLocked || objectActions.group;

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
          setBackgroundError('背景值無效，請修正或按 Escape 取消。');
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
    setBackgroundError(onClearBackground() ? '' : '無法清除背景。');
    setBackgroundValue('');
  };

  return (
    <aside
      data-testid="inspector"
      aria-label="屬性面板"
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-white/10 bg-[#0d0f14]"
    >
      <div
        role="tablist"
        aria-label="屬性分頁"
        className="flex border-b border-white/10"
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
                  ? 'border-amber-400 text-amber-200'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {candidate.label}
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
        <section aria-label="物件" className={SECTION_CLASS}>
          <h3 className={HEADING_CLASS}>物件</h3>
          {objects.length === 0 ? (
            <p className="text-xs text-zinc-500">此頁沒有物件。</p>
          ) : (
            <ul data-testid="object-list" className="flex flex-col gap-1">
              {objects.map((object) => {
                const selected = selectedTopPath === object.path[0];
                return (
                  <li
                    key={object.path.join('.')}
                    className={`flex items-stretch gap-1 rounded border transition-colors ${
                      selected
                        ? 'border-amber-400/70 bg-amber-400/10'
                        : 'border-white/10 hover:border-white/25'
                    }`}
                  >
                    <button
                      type="button"
                      data-testid="object-row"
                      data-object-id={object.elementId ?? undefined}
                      data-object-path={object.path.join('.')}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectObject(object.path)}
                      className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs ${
                        selected ? 'text-amber-100' : 'text-zinc-300'
                      }`}
                    >
                      <span className="rounded bg-white/5 px-1 py-0.5 font-mono text-[10px] text-zinc-400">
                        {object.tag}
                      </span>
                      {object.elementId && (
                        <span className="font-mono text-[10px] text-amber-200/80">
                          {object.elementId}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {object.text || '（無文字）'}
                      </span>
                      {object.group && (
                        <span className="rounded bg-sky-400/15 px-1 py-0.5 text-[10px] text-sky-200">
                          群組
                        </span>
                      )}
                      {object.locked && (
                        <span
                          data-testid="object-locked-badge"
                          className="rounded bg-rose-400/15 px-1 py-0.5 text-[10px] text-rose-200"
                        >
                          鎖定
                        </span>
                      )}
                      {object.hidden && (
                        <span
                          data-testid="object-hidden-badge"
                          className="rounded bg-violet-400/15 px-1 py-0.5 text-[10px] text-violet-200"
                        >
                          隱藏
                        </span>
                      )}
                    </button>
                    {object.locked && (
                      <button
                        type="button"
                        data-testid="object-unlock"
                        aria-label={`解鎖 ${object.text || object.elementId || object.tag}`}
                        onClick={() => onObjectRecovery(object.path, 'unlock')}
                        className="shrink-0 px-2 text-[11px] text-rose-200 hover:text-rose-100"
                      >
                        解鎖
                      </button>
                    )}
                    {object.hidden && object.canUnhide && (
                      <button
                        type="button"
                        data-testid="object-unhide"
                        aria-label={`顯示 ${object.text || object.elementId || object.tag}`}
                        onClick={() => onObjectRecovery(object.path, 'unhide')}
                        className="shrink-0 px-2 text-[11px] text-violet-200 hover:text-violet-100"
                      >
                        顯示
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
            aria-label="物件操作"
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>物件操作</h3>
            <div className="grid grid-cols-3 gap-1">
              <ActionButton
                testId="object-group"
                label="群組"
                disabled={!objectActions.canGroup}
                onClick={() => onObjectCommand({ type: 'group' })}
              />
              <ActionButton
                testId="object-ungroup"
                label="取消群組"
                disabled={!objectActions.canUngroup}
                onClick={() => onObjectCommand({ type: 'ungroup' })}
              />
              <ActionButton
                testId="object-order-front"
                label="最前"
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'front' })}
              />
              <ActionButton
                testId="object-order-forward"
                label="上移"
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'forward' })}
              />
              <ActionButton
                testId="object-order-backward"
                label="下移"
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'backward' })}
              />
              <ActionButton
                testId="object-order-back"
                label="最後"
                disabled={!objectActions.canOrder}
                onClick={() => onObjectCommand({ type: 'order', direction: 'back' })}
              />
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  ['left', '左對齊'],
                  ['center', '置中'],
                  ['right', '右對齊'],
                  ['top', '頂端'],
                  ['middle', '垂直置中'],
                  ['bottom', '底部']
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
                label="水平等距"
                disabled={!objectActions.canDistribute}
                onClick={() => onObjectCommand({ type: 'distribute', axis: 'horizontal' })}
              />
              <ActionButton
                testId="distribute-vertical"
                label="垂直等距"
                disabled={!objectActions.canDistribute}
                onClick={() => onObjectCommand({ type: 'distribute', axis: 'vertical' })}
              />
            </div>
            <div className="grid grid-cols-2 gap-1">
              <ActionButton
                testId="object-lock"
                label={objectActions.locked ? '解除鎖定' : '鎖定'}
                disabled={!objectActions.canToggle}
                onClick={() =>
                  onObjectCommand({ type: 'lock', locked: !objectActions.locked })
                }
              />
              <ActionButton
                testId="object-hide"
                label={objectActions.hidden ? '顯示物件' : '隱藏物件'}
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
            aria-label="圖表"
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>圖表</h3>
            <p data-testid="chart-summary" className="text-xs text-zinc-400">
              {chart.type} · {chart.title || '未命名'}
            </p>
            <button
              type="button"
              data-testid="chart-edit"
              disabled={styleDisabled}
              onClick={onEditChart}
              className={ACTION_CLASS}
            >
              編輯圖表資料…
            </button>
          </section>
        )}

        {selection && style && (
          <section
            data-testid="object-style"
            aria-label="物件外觀"
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>
              {style.kind === 'image' ? '圖片' : '外觀'}
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
                    更換圖片…
                  </button>
                  <button
                    type="button"
                    data-testid="image-replace-url"
                    disabled={styleDisabled}
                    onClick={onReplaceImageUrl}
                    className={ACTION_CLASS}
                  >
                    圖片網址…
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
                  label="替代文字"
                  value={style.alt}
                  disabled={styleDisabled}
                  onCommit={onSetImageAlt}
                />
                <span className="text-[11px] text-zinc-400">裁切（%）</span>
                <div className="grid grid-cols-4 gap-1">
                  {(
                    [
                      ['top', '上'],
                      ['right', '右'],
                      ['bottom', '下'],
                      ['left', '左']
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
                    label="圓角"
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
                    label="不透明度"
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
                    label="填色"
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
                    label="邊框顏色"
                    value={style.appearance.stroke}
                    disabled={styleDisabled}
                    placeholder="#000000"
                    onCommit={(value) =>
                      onSetAppearance({ stroke: value.trim() || null })
                    }
                  />
                  <StyleField
                    pendingActions={pendingActions}
                    owner="stroke-width"
                    testId="style-stroke-width"
                    label="邊框寬度"
                    value={style.appearance.strokeWidth}
                    disabled={styleDisabled}
                    placeholder="0"
                    onCommit={(value) => {
                      const parsed = numeric(value);
                      if (value.trim() && parsed === null) return false;
                      return onSetAppearance({ strokeWidth: parsed ?? 0 });
                    }}
                  />
                  {!style.svg && (
                    <StyleField
                      pendingActions={pendingActions}
                      owner="radius"
                      testId="style-radius"
                      label="圓角"
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
                    label="不透明度"
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
                    label="圖形文字"
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
            aria-label="位置與大小"
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>位置與大小</h3>
            {objectActions.hidden ? (
              <p data-testid="object-state-message" className="text-[11px] text-zinc-500">
                物件已隱藏，請先顯示後再調整位置。
              </p>
            ) : objectActions.locked ? (
              <p data-testid="object-state-message" className="text-[11px] text-zinc-500">
                物件已鎖定，請先解除鎖定再調整位置。
              </p>
            ) : multi ? (
              <p className="text-[11px] text-zinc-500">
                已選取 {selectionCount} 個物件；可對齊、分佈、群組，或拖曳移動。
              </p>
            ) : objectActions.group ? (
              <p data-testid="object-state-message" className="text-[11px] text-zinc-500">
                群組僅支援移動與旋轉；取消群組後可調整大小。
              </p>
            ) : (
              readOnly && (
                <p className="text-[11px] text-zinc-500">
                  巢狀選取為唯讀，請先選取最上層物件。
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
                label="寬"
                value={geometry?.width ?? null}
                disabled={sizeLocked || geometry === null}
                pendingActions={pendingActions}
                onCommit={onCommitGeometry}
              />
              <NumberField
                field="height"
                label="高"
                value={geometry?.height ?? null}
                disabled={sizeLocked || geometry === null}
                pendingActions={pendingActions}
                onCommit={onCommitGeometry}
              />
              <div className="col-span-2">
                <NumberField
                  field="rotation"
                  label="旋轉"
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
            aria-label="投影片設定"
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>投影片設定</h3>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">轉場</span>
              <select
                data-testid="transition-select"
                aria-label="轉場"
                value={transitionDraft}
                onChange={(event) =>
                  setTransitionDraft(event.target.value as Transition)
                }
                className={FIELD_CLASS}
              >
                <option value="none">無</option>
                <option value="fade">淡入</option>
                <option value="slide">滑動</option>
              </select>
              <div className="flex gap-1">
                <button
                  type="button"
                  data-testid="transition-preview"
                  disabled={transitionDraft === 'none'}
                  onClick={() => onPreviewTransition(transitionDraft)}
                  className={ACTION_CLASS}
                >
                  預覽
                </button>
                <button
                  type="button"
                  data-testid="transition-apply"
                  disabled={!transitionDirty}
                  onClick={() => onSetTransition(transitionDraft)}
                  className={ACTION_CLASS}
                >
                  套用
                </button>
                <button
                  type="button"
                  data-testid="transition-cancel"
                  disabled={!transitionDirty}
                  onClick={() => setTransitionDraft(committedTransition)}
                  className={ACTION_CLASS}
                >
                  取消
                </button>
              </div>
              {transitionDirty && (
                <span className="text-[11px] text-amber-300">
                  轉場尚未套用。
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">背景</span>
              <div className="flex gap-1">
                <select
                  data-testid="background-kind"
                  aria-label="背景類型"
                  value={backgroundKind}
                  onChange={(event) => changeBackground(event.target.value as BackgroundKind, '')}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') pendingActions.cancelPendingEdit('background');
                  }}
                  className={`${FIELD_CLASS} w-24 shrink-0`}
                >
                  <option value="color">顏色</option>
                  <option value="gradient">漸層</option>
                  <option value="image">圖片 URL</option>
                </select>
                <input
                  type="text"
                  data-testid="background-value"
                  aria-label="背景值"
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
                  className="rounded border border-white/15 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/30 disabled:opacity-40"
                >
                  清除背景
                </button>
                <button
                  type="button"
                  data-testid="apply-background"
                  onClick={applyBackground}
                  disabled={!backgroundValue.trim()}
                  className="rounded border border-white/15 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/30 disabled:opacity-40"
                >
                  套用
                </button>
              </div>
              {backgroundError && (
                <p
                  data-testid="background-error"
                  role="alert"
                  className="text-[11px] text-red-300"
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
          <h3 className={HEADING_CLASS}>文字</h3>
          <p data-testid="text-placeholder" className="text-xs text-zinc-500">
            文字格式工具將於 M4 提供。
          </p>
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
          <h3 className={HEADING_CLASS}>講者備註</h3>
          <textarea
            key={slide?.id ?? 'no-slide'}
            data-testid="notes-input"
            aria-label="講者備註"
            value={notesDraft}
            rows={8}
            placeholder="輸入備註…"
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
          <p className="text-[11px] text-zinc-500">
            備註以隱藏的區塊儲存在投影片內。
          </p>
        </div>
      </div>
    </aside>
  );
}
