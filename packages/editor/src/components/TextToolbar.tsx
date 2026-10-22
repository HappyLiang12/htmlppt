import { useState } from 'react';
import type {
  TextCommand,
  TextToolbarState
} from '../commands/rich-text';

export interface TextToolbarProps {
  state: TextToolbarState;
  error?: string;
  onCommand: (command: TextCommand) => void;
  onLink: () => void;
}

const TEXT_COLORS = [
  '#111827',
  '#ffffff',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0284c7',
  '#7c3aed',
  '#db2777',
  '#475569'
];

const HIGHLIGHTS = [
  '#fff59d',
  '#fecaca',
  '#fed7aa',
  '#bbf7d0',
  '#bfdbfe',
  '#e9d5ff',
  '#f5d0fe',
  '#e5e7eb'
];

const FONTS = [
  { label: 'Arial', value: 'Arial' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Courier New', value: 'Courier New' },
  { label: 'Verdana', value: 'Verdana' },
  { label: 'Trebuchet MS', value: 'Trebuchet MS' },
  { label: 'System UI', value: 'system-ui' }
];

const SIZES = [12, 14, 16, 18, 24, 32, 40, 48, 64, 96];

const LINE_HEIGHTS = ['1', '1.15', '1.3', '1.5', '2'];

type Menu = 'color' | 'highlight' | 'font' | 'size' | 'line' | null;

const BUTTON =
  'rounded border border-white/15 px-1.5 py-1 text-xs text-zinc-300 transition-colors hover:border-white/40 disabled:opacity-40';
const ACTIVE =
  'rounded border border-amber-400/80 bg-amber-400/15 px-1.5 py-1 text-xs text-amber-200';
const MENU =
  'absolute left-0 top-full z-20 mt-1 flex max-h-64 w-max flex-wrap gap-1 rounded border border-white/15 bg-[#161a21] p-2 shadow-xl';

function toggleClass(active: boolean): string {
  return active ? ACTIVE : BUTTON;
}

export function TextToolbar({
  state,
  error,
  onCommand,
  onLink
}: TextToolbarProps) {
  const [menu, setMenu] = useState<Menu>(null);

  const run = (command: TextCommand) => {
    setMenu(null);
    onCommand(command);
  };

  const toggleMenu = (next: Menu) => {
    setMenu((current) => (current === next ? null : next));
  };

  return (
    <div
      data-testid="text-toolbar"
      role="toolbar"
      aria-label="文字格式"
      className="relative flex flex-wrap items-center gap-1 border-b border-amber-400/20 bg-amber-950/20 px-4 py-1.5"
      onPointerDown={(event) => event.preventDefault()}
    >
      <span className="mr-1 text-xs text-amber-200/80">文字</span>

      <button
        type="button"
        data-testid="text-bold"
        title="粗體"
        aria-label="粗體"
        aria-pressed={state.bold}
        className={toggleClass(state.bold)}
        onClick={() => run({ type: 'bold' })}
      >
        B
      </button>
      <button
        type="button"
        data-testid="text-italic"
        title="斜體"
        aria-label="斜體"
        aria-pressed={state.italic}
        className={`${toggleClass(state.italic)} italic`}
        onClick={() => run({ type: 'italic' })}
      >
        I
      </button>
      <button
        type="button"
        data-testid="text-underline"
        title="底線"
        aria-label="底線"
        aria-pressed={state.underline}
        className={`${toggleClass(state.underline)} underline`}
        onClick={() => run({ type: 'underline' })}
      >
        U
      </button>
      <button
        type="button"
        data-testid="text-strike"
        title="刪除線"
        aria-label="刪除線"
        aria-pressed={state.strike}
        className={`${toggleClass(state.strike)} line-through`}
        onClick={() => run({ type: 'strike' })}
      >
        S
      </button>

      <span className="mx-1 h-4 w-px bg-white/15" />

      <div className="relative">
        <button
          type="button"
          data-testid="text-color"
          title="文字顏色"
          aria-label="文字顏色"
          className={BUTTON}
          aria-expanded={menu === 'color'}
          onClick={() => toggleMenu('color')}
        >
          <span
            data-testid="text-color-indicator"
            className="inline-block h-3 w-3 rounded-sm border border-white/30 align-middle"
            style={{ backgroundColor: state.color || '#111827' }}
          />
        </button>
        {menu === 'color' && (
          <div className={MENU}>
            {TEXT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                data-testid={`text-color-${color.slice(1)}`}
                aria-label={`文字顏色 ${color}`}
                title={color}
                className="h-6 w-6 rounded border border-white/30"
                style={{ backgroundColor: color }}
                onClick={() => run({ type: 'color', value: color })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          data-testid="text-highlight"
          title="螢光標示"
          aria-label="螢光標示"
          className={BUTTON}
          aria-expanded={menu === 'highlight'}
          onClick={() => toggleMenu('highlight')}
        >
          <span
            className="inline-block h-3 w-3 rounded-sm border border-white/30 align-middle"
            style={{ backgroundColor: state.highlight || '#fff59d' }}
          />
        </button>
        {menu === 'highlight' && (
          <div className={MENU}>
            {HIGHLIGHTS.map((color) => (
              <button
                key={color}
                type="button"
                data-testid={`text-highlight-${color.slice(1)}`}
                aria-label={`螢光色 ${color}`}
                title={color}
                className="h-6 w-6 rounded border border-white/30"
                style={{ backgroundColor: color }}
                onClick={() => run({ type: 'highlight', value: color })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          data-testid="text-font"
          title="字型"
          aria-label="字型"
          className={BUTTON}
          aria-expanded={menu === 'font'}
          onClick={() => toggleMenu('font')}
        >
          {FONTS.find((font) => font.value === state.fontFamily)?.label ??
            state.fontFamily ??
            '字型'}
          <span className="ml-1 text-[10px]">▾</span>
        </button>
        {menu === 'font' && (
          <div className={`${MENU} flex-col`}>
            {FONTS.map((font) => (
              <button
                key={font.value}
                type="button"
                data-testid={`text-font-${font.value
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')}`}
                className="rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-white/10"
                style={{ fontFamily: font.value }}
                onClick={() => run({ type: 'fontFamily', value: font.value })}
              >
                {font.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          data-testid="text-size"
          title="字級"
          aria-label="字級"
          className={BUTTON}
          aria-expanded={menu === 'size'}
          onClick={() => toggleMenu('size')}
        >
          {state.fontSize}
          <span className="ml-1 text-[10px]">▾</span>
        </button>
        {menu === 'size' && (
          <div className={MENU}>
            {SIZES.map((size) => (
              <button
                key={size}
                type="button"
                data-testid={`text-size-${size}`}
                className="rounded px-2 py-1 text-xs text-zinc-200 hover:bg-white/10"
                onClick={() =>
                  run({ type: 'fontSize', value: `${size}px` })
                }
              >
                {size}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="mx-1 h-4 w-px bg-white/15" />

      {(['left', 'center', 'right', 'justify'] as const).map((align) => (
        <button
          key={align}
          type="button"
          data-testid={`text-align-${align}`}
          title={`對齊 ${align}`}
          aria-label={`對齊 ${align}`}
          aria-pressed={state.align === align}
          className={toggleClass(state.align === align)}
          onClick={() => run({ type: 'align', value: align })}
        >
          {align === 'left'
            ? '⇤'
            : align === 'center'
              ? '↔'
              : align === 'right'
                ? '⇥'
                : '☰'}
        </button>
      ))}

      <div className="relative">
        <button
          type="button"
          data-testid="text-line-height"
          title="行高"
          aria-label="行高"
          className={BUTTON}
          aria-expanded={menu === 'line'}
          onClick={() => toggleMenu('line')}
        >
          行高
        </button>
        {menu === 'line' && (
          <div className={MENU}>
            {LINE_HEIGHTS.map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`text-line-${value.replace('.', '-')}`}
                className="rounded px-2 py-1 text-xs text-zinc-200 hover:bg-white/10"
                onClick={() => run({ type: 'lineHeight', value })}
              >
                {value}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="mx-1 h-4 w-px bg-white/15" />

      <button
        type="button"
        data-testid="text-ul"
        title="項目符號"
        aria-label="項目符號"
        aria-pressed={state.list === 'ul'}
        className={toggleClass(state.list === 'ul')}
        onClick={() => run({ type: 'list', value: 'ul' })}
      >
        • 清單
      </button>
      <button
        type="button"
        data-testid="text-ol"
        title="編號清單"
        aria-label="編號清單"
        aria-pressed={state.list === 'ol'}
        className={toggleClass(state.list === 'ol')}
        onClick={() => run({ type: 'list', value: 'ol' })}
      >
        1. 清單
      </button>

      <button
        type="button"
        data-testid="text-link"
        title="連結"
        aria-label="連結"
        className={toggleClass(state.link !== null)}
        onClick={onLink}
      >
        連結
      </button>
      <button
        type="button"
        data-testid="text-clear"
        title="清除格式"
        aria-label="清除格式"
        className={BUTTON}
        onClick={() => run({ type: 'clear' })}
      >
        清除格式
      </button>

      {error && (
        <span
          data-testid="text-error"
          role="alert"
          className="ml-2 text-xs text-red-300"
        >
          {error}
        </span>
      )}
    </div>
  );
}
