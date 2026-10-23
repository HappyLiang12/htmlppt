import type { ShapeKind } from '@htmlppt/core';
import type { SaveStatus } from '../use-deck-controller';
import {
  useI18n,
  type Locale,
  type MessageKey
} from '../i18n';
import { ExportMenu, type ExportFormat } from './ExportMenu';
import { InsertMenu } from './InsertMenu';
import { PathInput } from './PathInput';

export type EditorView = 'normal' | 'sorter';

export interface ToolbarProps {
  filePath: string;
  pathEditable: boolean;
  openingDeck: boolean;
  openDeckError: string | null;
  onOpenDeck: (path: string) => void;
  onPickDeck: () => void;
  status: SaveStatus;
  activeIndex: number;
  slideCount: number;
  view: EditorView;
  canDelete: boolean;
  onAddSlide: () => void;
  onDuplicateSlide: () => void;
  onDeleteSlide: () => void;
  onInsertText: () => void;
  onInsertShape: (shape: ShapeKind) => void;
  onInsertTable: (rows: number, columns: number) => void;
  onInsertChart: () => void;
  onInsertImageFile: (file: File) => void;
  onInsertImageUrl: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPlay: () => void;
  onOpenHelp: () => void;
  onViewChange: (view: EditorView) => void;
  onPreviousSlide: () => void;
  onNextSlide: () => void;
  onExport: (format: ExportFormat) => void;
  exporting: ExportFormat | null;
  exportSignal: number;
  /** Upload-only standalone tabs cannot write the file or render PDF/PNG. */
  standaloneUpload?: boolean;
  /** Any standalone tab lacks the host renderer required for PDF/PNG. */
  standaloneMode?: boolean;
}

const STATUS_KEY: Record<SaveStatus, MessageKey> = {
  loading: 'common.loading',
  ready: 'common.ready',
  saving: 'common.saving',
  saved: 'common.saved',
  external: 'common.external',
  conflict: 'common.conflict',
  'load-error': 'common.loadFailed',
  error: 'common.saveFailed'
};

const BUTTON_CLASS =
  'rounded border border-white/40 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-white/60 disabled:opacity-40';
const ACTIVE_VIEW_CLASS =
  'rounded border border-amber-400/70 bg-amber-400/10 px-2 py-1 text-xs text-amber-200';

export function Toolbar({
  filePath,
  pathEditable,
  openingDeck,
  openDeckError,
  onOpenDeck,
  onPickDeck,
  status,
  activeIndex,
  slideCount,
  view,
  canDelete,
  onAddSlide,
  onDuplicateSlide,
  onDeleteSlide,
  onInsertText,
  onInsertShape,
  onInsertTable,
  onInsertChart,
  onInsertImageFile,
  onInsertImageUrl,
  onUndo,
  onRedo,
  onPlay,
  onOpenHelp,
  onViewChange,
  onPreviousSlide,
  onNextSlide,
  onExport,
  exporting,
  exportSignal,
  standaloneUpload = false,
  standaloneMode = false
}: ToolbarProps) {
  const { locale, setLocale, t } = useI18n();

  return (
    <header
      data-testid="toolbar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 px-4 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-sm font-semibold tracking-wide">htmlppt</span>
        <PathInput
          value={filePath}
          editable={pathEditable}
          opening={openingDeck}
          error={openDeckError}
          onOpen={onOpenDeck}
          onPick={onPickDeck}
        />
      </div>

      <span
        data-testid="save-status"
        role="status"
        className={`text-xs ${
          status === 'error' || status === 'load-error'
            ? 'text-red-400'
            : status === 'conflict' || status === 'external'
              ? 'text-amber-300'
              : 'text-zinc-400'
        }`}
      >
        {standaloneMode && status === 'ready'
          ? t('status.opened')
          : status === 'saved' && standaloneUpload
            ? t('status.drafted')
            : t(STATUS_KEY[status])}
      </span>
      {standaloneMode && (
        <span
          data-testid="standalone-badge"
          className="rounded border border-amber-400/40 px-2 py-0.5 text-[10px] text-amber-200"
          title={t('toolbar.standaloneHint')}
        >
          {t('toolbar.standaloneBadge')}
        </span>
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="add-slide"
          className={BUTTON_CLASS}
          title={t('toolbar.addHint')}
          onClick={(event) => {
            // A double click also emits a second click with detail 2; one
            // toolbar gesture must create one slide.
            if (event.detail <= 1) onAddSlide();
          }}
        >
          {t('toolbar.add')}
        </button>
        <button
          type="button"
          data-testid="duplicate-slide"
          className={BUTTON_CLASS}
          title={t('toolbar.duplicateHint')}
          onClick={(event) => {
            if (event.detail <= 1) onDuplicateSlide();
          }}
        >
          {t('toolbar.duplicate')}
        </button>
        <button
          type="button"
          data-testid="delete-slide"
          className={BUTTON_CLASS}
          title={
            canDelete ? t('toolbar.deleteHint') : t('toolbar.keepOneSlide')
          }
          onClick={(event) => {
            if (event.detail <= 1) onDeleteSlide();
          }}
          disabled={!canDelete}
        >
          {t('toolbar.deleteSlide')}
        </button>
      </div>

      <InsertMenu
        onInsertText={onInsertText}
        onInsertShape={onInsertShape}
        onInsertTable={onInsertTable}
        onInsertChart={onInsertChart}
        onInsertImageFile={onInsertImageFile}
        onInsertImageUrl={onInsertImageUrl}
      />

      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="undo"
          className={BUTTON_CLASS}
          title={t('shortcuts.undo')}
          onClick={onUndo}
        >
          {t('shortcuts.undo')}
        </button>
        <button
          type="button"
          data-testid="redo"
          className={BUTTON_CLASS}
          title={t('shortcuts.redo')}
          onClick={onRedo}
        >
          {t('shortcuts.redo')}
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <button
          type="button"
          className={BUTTON_CLASS}
          onClick={onPreviousSlide}
          disabled={activeIndex <= 0}
        >
          {t('toolbar.previous')}
        </button>
        <span data-testid="slide-counter" className="tabular-nums">
          {slideCount === 0 ? 0 : activeIndex + 1} / {slideCount}
        </span>
        <button
          type="button"
          className={BUTTON_CLASS}
          onClick={onNextSlide}
          disabled={activeIndex >= slideCount - 1}
        >
          {t('toolbar.next')}
        </button>
      </div>

      <div
        className="flex items-center gap-1"
        role="group"
        aria-label={t('toolbar.viewGroup')}
      >
        <button
          type="button"
          data-testid="view-normal"
          aria-pressed={view === 'normal'}
          className={view === 'normal' ? ACTIVE_VIEW_CLASS : BUTTON_CLASS}
          onClick={() => onViewChange('normal')}
        >
          {t('toolbar.viewNormal')}
        </button>
        <button
          type="button"
          data-testid="view-sorter"
          aria-pressed={view === 'sorter'}
          className={view === 'sorter' ? ACTIVE_VIEW_CLASS : BUTTON_CLASS}
          onClick={() => onViewChange('sorter')}
        >
          {t('toolbar.viewSorter')}
        </button>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <select
          data-testid="locale-select"
          aria-label={t('locale.label')}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
          className="rounded border border-white/40 bg-black/30 px-2 py-1 text-xs text-zinc-200"
        >
          <option value="en">English</option>
          <option value="zh-Hant">繁體中文</option>
          <option value="zh-Hans">简体中文</option>
        </select>
        <button
          type="button"
          data-testid="shortcuts-open"
          aria-label={t('toolbar.shortcuts')}
          aria-haspopup="dialog"
          title={t('toolbar.shortcutsTitle')}
          className={BUTTON_CLASS}
          onClick={onOpenHelp}
        >
          {t('toolbar.shortcuts')}
        </button>
        <button
          type="button"
          data-testid="play"
          className={BUTTON_CLASS}
          title={t('toolbar.play')}
          onClick={onPlay}
        >
          {t('toolbar.play')}
        </button>
        <ExportMenu
          signal={exportSignal}
          exporting={exporting}
          standalone={standaloneMode}
          onExport={onExport}
        />
      </div>
    </header>
  );
}
