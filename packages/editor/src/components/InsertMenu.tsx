import { useRef, useState } from 'react';
import type { ShapeKind } from '@htmlppt/core';

export interface InsertMenuProps {
  onInsertText: () => void;
  onInsertShape: (shape: ShapeKind) => void;
  onInsertTable: (rows: number, columns: number) => void;
  onInsertChart: () => void;
  onInsertImageFile: (file: File) => void;
  onInsertImageUrl: () => void;
}

const BUTTON =
  'rounded border border-white/40 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-white/60 disabled:opacity-40';
const MENU =
  'absolute left-0 top-full z-20 mt-1 flex w-max flex-col gap-1 rounded border border-white/30 bg-[#161a21] p-2 shadow-xl';
const FIELD =
  'w-16 rounded border border-white/40 bg-black/30 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-amber-400/70';

type MenuName = 'shape' | 'table' | 'image';

const SHAPES: { shape: ShapeKind; label: string }[] = [
  { shape: 'rect', label: '矩形' },
  { shape: 'rounded-rect', label: '圓角矩形' },
  { shape: 'ellipse', label: '橢圓' },
  { shape: 'triangle', label: '三角形' },
  { shape: 'line', label: '線條' },
  { shape: 'arrow', label: '箭頭' }
];

export function InsertMenu({
  onInsertText,
  onInsertShape,
  onInsertTable,
  onInsertChart,
  onInsertImageFile,
  onInsertImageUrl
}: InsertMenuProps) {
  const [menu, setMenu] = useState<MenuName | null>(null);
  const [rows, setRows] = useState('3');
  const [columns, setColumns] = useState('3');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const triggers = useRef<Record<MenuName, HTMLButtonElement | null>>({
    shape: null,
    table: null,
    image: null
  });

  const closeMenu = (name: MenuName) => {
    setMenu(null);
    triggers.current[name]?.focus();
  };

  const menuKeyDown = (
    event: {
      key: string;
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    name: MenuName
  ) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu(name);
  };

  const tableSize = (value: string, limit: number): number | null => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= limit
      ? parsed
      : null;
  };
  const rowCount = tableSize(rows, 50);
  const columnCount = tableSize(columns, 20);

  return (
    <div className="flex items-center gap-1" role="group" aria-label="插入物件">
      <button
        type="button"
        data-testid="insert-text"
        title="插入文字方塊"
        className={BUTTON}
        onClick={onInsertText}
      >
        文字
      </button>

      <div className="relative">
        <button
          type="button"
          data-testid="insert-shape"
          title="插入形狀"
          aria-expanded={menu === 'shape'}
          ref={(element) => {
            triggers.current.shape = element;
          }}
          className={BUTTON}
          onClick={() => setMenu((current) => (current === 'shape' ? null : 'shape'))}
          onKeyDown={(event) => {
            if (menu === 'shape') menuKeyDown(event, 'shape');
          }}
        >
          形狀
        </button>
        {menu === 'shape' && (
          <div
            data-testid="insert-menu-shape"
            className={MENU}
            onKeyDown={(event) => menuKeyDown(event, 'shape')}
          >
            {SHAPES.map(({ shape, label }) => (
              <button
                key={shape}
                type="button"
                data-testid={`insert-shape-${shape}`}
                className="rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-white/10"
                onClick={() => {
                  setMenu(null);
                  onInsertShape(shape);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          data-testid="insert-table"
          title="插入表格"
          aria-expanded={menu === 'table'}
          ref={(element) => {
            triggers.current.table = element;
          }}
          className={BUTTON}
          onClick={() => setMenu((current) => (current === 'table' ? null : 'table'))}
          onKeyDown={(event) => {
            if (menu === 'table') menuKeyDown(event, 'table');
          }}
        >
          表格
        </button>
        {menu === 'table' && (
          <div
            data-testid="insert-menu-table"
            className={MENU}
            onKeyDown={(event) => menuKeyDown(event, 'table')}
          >
            <label className="flex items-center justify-between gap-2 text-xs text-zinc-300">
              列
              <input
                type="number"
                min={1}
                max={50}
                data-testid="table-rows"
                aria-label="表格列數"
                value={rows}
                onChange={(event) => setRows(event.target.value)}
                className={FIELD}
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-xs text-zinc-300">
              欄
              <input
                type="number"
                min={1}
                max={20}
                data-testid="table-columns"
                aria-label="表格欄數"
                value={columns}
                onChange={(event) => setColumns(event.target.value)}
                className={FIELD}
              />
            </label>
            <button
              type="button"
              data-testid="table-insert"
              disabled={rowCount === null || columnCount === null}
              className="rounded bg-amber-400/20 px-2 py-1 text-xs text-amber-100 transition-colors hover:bg-amber-400/30 disabled:opacity-40"
              onClick={() => {
                if (rowCount === null || columnCount === null) return;
                setMenu(null);
                onInsertTable(rowCount, columnCount);
              }}
            >
              插入表格
            </button>
          </div>
        )}
      </div>

      <button
        type="button"
        data-testid="insert-chart"
        title="插入圖表"
        className={BUTTON}
        onClick={onInsertChart}
      >
        圖表
      </button>

      <div className="relative">
        <button
          type="button"
          data-testid="insert-image"
          title="插入圖片"
          aria-expanded={menu === 'image'}
          ref={(element) => {
            triggers.current.image = element;
          }}
          className={BUTTON}
          onClick={() => setMenu((current) => (current === 'image' ? null : 'image'))}
          onKeyDown={(event) => {
            if (menu === 'image') menuKeyDown(event, 'image');
          }}
        >
          圖片
        </button>
        {menu === 'image' && (
          <div
            data-testid="insert-menu-image"
            className={MENU}
            onKeyDown={(event) => menuKeyDown(event, 'image')}
          >
            <button
              type="button"
              data-testid="insert-image-upload"
              className="rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-white/10"
              onClick={() => {
                setMenu(null);
                fileInput.current?.click();
              }}
            >
              上傳圖片…
            </button>
            <button
              type="button"
              data-testid="insert-image-url"
              className="rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-white/10"
              onClick={() => {
                setMenu(null);
                onInsertImageUrl();
              }}
            >
              圖片網址…
            </button>
          </div>
        )}
        <input
          ref={fileInput}
          data-testid="insert-image-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onInsertImageFile(file);
          }}
        />
      </div>
    </div>
  );
}
