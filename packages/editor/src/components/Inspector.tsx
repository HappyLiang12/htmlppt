import { useEffect, useRef, useState } from 'react';
import type { SlideInfo, Transition } from '@htmlppt/core';
import type { SelectionTarget } from '../selection';
import {
  backgroundOf,
  formatGeometryValue,
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

export interface InspectorProps {
  slide: SlideInfo | undefined;
  selection: SelectionTarget | null;
  geometry: GeometryValues | null;
  onSelectObject: (path: number[]) => void;
  onCommitGeometry: (field: GeometryField, value: number) => void;
  onSetTransition: (transition: Transition) => void;
  onSetBackground: (background: SlideBackground) => void;
  onSetNotes: (notes: string) => void;
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
  field: GeometryField;
  label: string;
  value: number | null;
  disabled: boolean;
  onCommit: (field: GeometryField, value: number) => void;
}

function NumberField({
  field,
  label,
  value,
  disabled,
  onCommit
}: NumberFieldProps) {
  const formatted = value === null ? '' : formatGeometryValue(value);
  const [draft, setDraft] = useState(formatted);
  const focusedRef = useRef(false);
  const skipCommitRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(formatted);
  }, [formatted]);

  const reset = () => setDraft(formatted);
  const commit = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      reset();
      return;
    }
    if (value === null) {
      reset();
      return;
    }
    const parsed = parseGeometryValue(field, draft);
    if (parsed === null || parsed === value) {
      reset();
      return;
    }
    onCommit(field, parsed);
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
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          commit();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            skipCommitRef.current = true;
            event.currentTarget.blur();
          }
        }}
        className={FIELD_CLASS}
      />
    </label>
  );
}

export function Inspector({
  slide,
  selection,
  geometry,
  onSelectObject,
  onCommitGeometry,
  onSetTransition,
  onSetBackground,
  onSetNotes
}: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('design');
  const notes = notesOf(slide?.element);
  const [notesDraft, setNotesDraft] = useState(notes);
  const notesFocusedRef = useRef(false);

  const background = backgroundOf(slide?.element);
  const [backgroundKind, setBackgroundKind] = useState<BackgroundKind>(
    background?.kind ?? 'color'
  );
  const [backgroundValue, setBackgroundValue] = useState(
    background?.value ?? ''
  );

  useEffect(() => {
    if (!notesFocusedRef.current) setNotesDraft(notes);
  }, [notes, slide?.id]);

  useEffect(() => {
    setBackgroundKind(background?.kind ?? 'color');
    setBackgroundValue(background?.value ?? '');
  }, [background?.kind, background?.value, slide?.id]);

  const objects = slide ? summarizeObjects(slide.element) : [];
  const readOnly = selection !== null && selection.path.length > 1;
  const selectedTopPath = selection?.path[0];

  const applyBackground = () => {
    const value = backgroundValue.trim();
    if (!value) return;
    setBackgroundValue(value);
    onSetBackground({ kind: backgroundKind, value });
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
              onClick={() => setTab(candidate.id)}
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
                  <li key={object.path.join('.')}>
                    <button
                      type="button"
                      data-testid="object-row"
                      data-object-id={object.elementId ?? undefined}
                      data-object-path={object.path.join('.')}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectObject(object.path)}
                      className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors ${
                        selected
                          ? 'border-amber-400/70 bg-amber-400/10 text-amber-100'
                          : 'border-white/10 text-zinc-300 hover:border-white/25'
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
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selection ? (
          <section
            data-testid="inspector-geometry"
            aria-label="位置與大小"
            className={SECTION_CLASS}
          >
            <h3 className={HEADING_CLASS}>位置與大小</h3>
            {readOnly && (
              <p className="text-[11px] text-zinc-500">
                巢狀選取為唯讀，請先選取最上層物件。
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                field="x"
                label="X"
                value={geometry?.x ?? null}
                disabled={readOnly || geometry === null}
                onCommit={onCommitGeometry}
              />
              <NumberField
                field="y"
                label="Y"
                value={geometry?.y ?? null}
                disabled={readOnly || geometry === null}
                onCommit={onCommitGeometry}
              />
              <NumberField
                field="width"
                label="寬"
                value={geometry?.width ?? null}
                disabled={readOnly || geometry === null}
                onCommit={onCommitGeometry}
              />
              <NumberField
                field="height"
                label="高"
                value={geometry?.height ?? null}
                disabled={readOnly || geometry === null}
                onCommit={onCommitGeometry}
              />
              <div className="col-span-2">
                <NumberField
                  field="rotation"
                  label="旋轉"
                  value={geometry?.rotation ?? null}
                  disabled={readOnly || geometry === null}
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
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">轉場</span>
              <select
                data-testid="transition-select"
                aria-label="轉場"
                value={transitionOf(slide?.element)}
                onChange={(event) =>
                  onSetTransition(event.target.value as Transition)
                }
                className={FIELD_CLASS}
              >
                <option value="none">無</option>
                <option value="fade">淡入</option>
                <option value="slide">滑動</option>
              </select>
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">背景</span>
              <div className="flex gap-1">
                <select
                  data-testid="background-kind"
                  aria-label="背景類型"
                  value={backgroundKind}
                  onChange={(event) =>
                    setBackgroundKind(event.target.value as BackgroundKind)
                  }
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
                  onChange={(event) =>
                    setBackgroundValue(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      applyBackground();
                    }
                  }}
                  className={FIELD_CLASS}
                />
              </div>
              <button
                type="button"
                data-testid="apply-background"
                onClick={applyBackground}
                disabled={!backgroundValue.trim()}
                className="self-end rounded border border-white/15 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-white/30 disabled:opacity-40"
              >
                套用
              </button>
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
            data-testid="notes-input"
            aria-label="講者備註"
            value={notesDraft}
            rows={8}
            placeholder="輸入備註…"
            onFocus={() => {
              notesFocusedRef.current = true;
            }}
            onChange={(event) => setNotesDraft(event.target.value)}
            onBlur={() => {
              notesFocusedRef.current = false;
              if (notesDraft !== notes) onSetNotes(notesDraft);
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
