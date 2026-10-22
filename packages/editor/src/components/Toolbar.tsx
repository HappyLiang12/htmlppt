import type { SaveStatus } from '../use-deck-controller';

export type EditorView = 'normal' | 'sorter';

export interface ToolbarProps {
  filePath: string;
  status: SaveStatus;
  activeIndex: number;
  slideCount: number;
  view: EditorView;
  canDelete: boolean;
  onAddSlide: () => void;
  onDuplicateSlide: () => void;
  onDeleteSlide: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPlay: () => void;
  onViewChange: (view: EditorView) => void;
  onPreviousSlide: () => void;
  onNextSlide: () => void;
}

const STATUS_LABEL: Record<SaveStatus, string> = {
  loading: '載入中…',
  ready: '已同步',
  saving: '儲存中…',
  saved: '已儲存',
  external: '外部更新',
  conflict: '衝突',
  'load-error': '載入失敗',
  error: '儲存失敗'
};

const BUTTON_CLASS =
  'rounded border border-white/15 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-white/30 disabled:opacity-40';
const ACTIVE_VIEW_CLASS =
  'rounded border border-amber-400/70 bg-amber-400/10 px-2 py-1 text-xs text-amber-200';

export function Toolbar({
  filePath,
  status,
  activeIndex,
  slideCount,
  view,
  canDelete,
  onAddSlide,
  onDuplicateSlide,
  onDeleteSlide,
  onUndo,
  onRedo,
  onPlay,
  onViewChange,
  onPreviousSlide,
  onNextSlide
}: ToolbarProps) {
  return (
    <header
      data-testid="toolbar"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 px-4 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-sm font-semibold tracking-wide">htmlppt</span>
        <span className="max-w-48 truncate text-xs text-zinc-400">
          {filePath}
        </span>
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
        {STATUS_LABEL[status]}
      </span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="add-slide"
          className={BUTTON_CLASS}
          title="在目前投影片後新增"
          onClick={(event) => {
            // A double click also emits a second click with detail 2; one
            // toolbar gesture must create one slide.
            if (event.detail <= 1) onAddSlide();
          }}
        >
          新增
        </button>
        <button
          type="button"
          data-testid="duplicate-slide"
          className={BUTTON_CLASS}
          title="複製目前投影片"
          onClick={(event) => {
            if (event.detail <= 1) onDuplicateSlide();
          }}
        >
          複製
        </button>
        <button
          type="button"
          data-testid="delete-slide"
          className={BUTTON_CLASS}
          title={canDelete ? '刪除目前投影片' : '至少需要保留一頁'}
          onClick={(event) => {
            if (event.detail <= 1) onDeleteSlide();
          }}
          disabled={!canDelete}
        >
          刪除
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="undo"
          className={BUTTON_CLASS}
          title="復原"
          onClick={onUndo}
        >
          復原
        </button>
        <button
          type="button"
          data-testid="redo"
          className={BUTTON_CLASS}
          title="重做"
          onClick={onRedo}
        >
          重做
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <button
          type="button"
          className={BUTTON_CLASS}
          onClick={onPreviousSlide}
          disabled={activeIndex <= 0}
        >
          上一頁
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
          下一頁
        </button>
      </div>

      <div
        className="flex items-center gap-1"
        role="group"
        aria-label="檢視模式"
      >
        <button
          type="button"
          data-testid="view-normal"
          aria-pressed={view === 'normal'}
          className={view === 'normal' ? ACTIVE_VIEW_CLASS : BUTTON_CLASS}
          onClick={() => onViewChange('normal')}
        >
          一般
        </button>
        <button
          type="button"
          data-testid="view-sorter"
          aria-pressed={view === 'sorter'}
          className={view === 'sorter' ? ACTIVE_VIEW_CLASS : BUTTON_CLASS}
          onClick={() => onViewChange('sorter')}
        >
          排序
        </button>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          data-testid="play"
          className={BUTTON_CLASS}
          title="播放"
          onClick={onPlay}
        >
          播放
        </button>
        <button
          type="button"
          data-testid="export-html"
          className={BUTTON_CLASS}
          title="匯出 HTML（M5 提供）"
          disabled
        >
          匯出 HTML
        </button>
      </div>
    </header>
  );
}
