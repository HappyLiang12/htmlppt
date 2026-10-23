import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import type {
  TextCommand,
  TextToolbarState
} from '../commands/rich-text';
import { useI18n } from '../i18n';

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
type OpenMenu = Exclude<Menu, null>;

const BUTTON =
  'rounded border border-white/40 px-1.5 py-1 text-xs text-zinc-300 transition-colors hover:border-white/60 disabled:opacity-40';
const ACTIVE =
  'rounded border border-amber-400/80 bg-amber-400/15 px-1.5 py-1 text-xs text-amber-200';
const MENU =
  'absolute left-0 top-full z-20 mt-1 flex max-h-64 w-max flex-wrap gap-1 rounded border border-white/30 bg-[#161a21] p-2 shadow-xl';

function toggleClass(active: boolean): string {
  return active ? ACTIVE : BUTTON;
}

export function TextToolbar({
  state,
  error,
  onCommand,
  onLink
}: TextToolbarProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<Menu>(null);
  const triggers = useRef<Record<OpenMenu, HTMLButtonElement | null>>({
    color: null,
    highlight: null,
    font: null,
    size: null,
    line: null
  });

  const closeMenu = (name: OpenMenu) => {
    setMenu(null);
    triggers.current[name]?.focus();
  };

  const menuKeyDown = (
    event: {
      key: string;
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    name: OpenMenu
  ) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu(name);
  };

  const triggerProps = (name: OpenMenu) => ({
    ref: (element: HTMLButtonElement | null) => {
      triggers.current[name] = element;
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (menu === name) menuKeyDown(event, name);
    }
  });

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
      aria-label={t('text.toolbar')}
      className="relative flex flex-wrap items-center gap-1 border-b border-amber-400/20 bg-amber-950/20 px-4 py-1.5"
      onPointerDown={(event) => event.preventDefault()}
    >
      <span className="mr-1 text-xs text-amber-200/80">{t('text.group')}</span>

      <button
        type="button"
        data-testid="text-bold"
        title={t('text.bold')}
        aria-label={t('text.bold')}
        aria-pressed={state.bold}
        className={toggleClass(state.bold)}
        onClick={() => run({ type: 'bold' })}
      >
        B
      </button>
      <button
        type="button"
        data-testid="text-italic"
        title={t('text.italic')}
        aria-label={t('text.italic')}
        aria-pressed={state.italic}
        className={`${toggleClass(state.italic)} italic`}
        onClick={() => run({ type: 'italic' })}
      >
        I
      </button>
      <button
        type="button"
        data-testid="text-underline"
        title={t('text.underline')}
        aria-label={t('text.underline')}
        aria-pressed={state.underline}
        className={`${toggleClass(state.underline)} underline`}
        onClick={() => run({ type: 'underline' })}
      >
        U
      </button>
      <button
        type="button"
        data-testid="text-strike"
        title={t('text.strike')}
        aria-label={t('text.strike')}
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
          title={t('text.color')}
          aria-label={t('text.color')}
          className={BUTTON}
          aria-expanded={menu === 'color'}
          {...triggerProps('color')}
          onClick={() => toggleMenu('color')}
        >
          <span
            data-testid="text-color-indicator"
            className="inline-block h-3 w-3 rounded-sm border border-white/30 align-middle"
            style={{ backgroundColor: state.color || '#111827' }}
          />
        </button>
        {menu === 'color' && (
          <div
            data-testid="text-menu-color"
            className={MENU}
            onKeyDown={(event) => menuKeyDown(event, 'color')}
          >
            {TEXT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                data-testid={`text-color-${color.slice(1)}`}
                aria-label={t('text.colorSwatch', { color })}
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
          title={t('text.highlight')}
          aria-label={t('text.highlight')}
          className={BUTTON}
          aria-expanded={menu === 'highlight'}
          {...triggerProps('highlight')}
          onClick={() => toggleMenu('highlight')}
        >
          <span
            className="inline-block h-3 w-3 rounded-sm border border-white/30 align-middle"
            style={{ backgroundColor: state.highlight || '#fff59d' }}
          />
        </button>
        {menu === 'highlight' && (
          <div
            data-testid="text-menu-highlight"
            className={MENU}
            onKeyDown={(event) => menuKeyDown(event, 'highlight')}
          >
            {HIGHLIGHTS.map((color) => (
              <button
                key={color}
                type="button"
                data-testid={`text-highlight-${color.slice(1)}`}
                aria-label={t('text.highlightSwatch', { color })}
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
          title={t('text.font')}
          aria-label={t('text.font')}
          className={BUTTON}
          aria-expanded={menu === 'font'}
          {...triggerProps('font')}
          onClick={() => toggleMenu('font')}
        >
          {FONTS.find((font) => font.value === state.fontFamily)?.label ??
            state.fontFamily ??
            t('text.font')}
          <span className="ml-1 text-[10px]">▾</span>
        </button>
        {menu === 'font' && (
          <div
            data-testid="text-menu-font"
            className={`${MENU} flex-col`}
            onKeyDown={(event) => menuKeyDown(event, 'font')}
          >
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
          title={t('text.size')}
          aria-label={t('text.size')}
          className={BUTTON}
          aria-expanded={menu === 'size'}
          {...triggerProps('size')}
          onClick={() => toggleMenu('size')}
        >
          {state.fontSize}
          <span className="ml-1 text-[10px]">▾</span>
        </button>
        {menu === 'size' && (
          <div
            data-testid="text-menu-size"
            className={MENU}
            onKeyDown={(event) => menuKeyDown(event, 'size')}
          >
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
          title={`${t('text.align')} ${align}`}
          aria-label={`${t('text.align')} ${align}`}
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
          title={t('text.lineHeight')}
          aria-label={t('text.lineHeight')}
          className={BUTTON}
          aria-expanded={menu === 'line'}
          {...triggerProps('line')}
          onClick={() => toggleMenu('line')}
        >
          {t('text.lineHeight')}
        </button>
        {menu === 'line' && (
          <div
            data-testid="text-menu-line"
            className={MENU}
            onKeyDown={(event) => menuKeyDown(event, 'line')}
          >
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
        title={t('text.bulletLabel')}
        aria-label={t('text.bulletLabel')}
        aria-pressed={state.list === 'ul'}
        className={toggleClass(state.list === 'ul')}
        onClick={() => run({ type: 'list', value: 'ul' })}
      >
        {t('text.bullet')}
      </button>
      <button
        type="button"
        data-testid="text-ol"
        title={t('text.orderedLabel')}
        aria-label={t('text.orderedLabel')}
        aria-pressed={state.list === 'ol'}
        className={toggleClass(state.list === 'ol')}
        onClick={() => run({ type: 'list', value: 'ol' })}
      >
        {t('text.ordered')}
      </button>

      <button
        type="button"
        data-testid="text-link"
        title={t('text.link')}
        aria-label={t('text.link')}
        className={toggleClass(state.link !== null)}
        onClick={onLink}
      >
        {t('text.link')}
      </button>
      <button
        type="button"
        data-testid="text-clear"
        title={t('text.clear')}
        aria-label={t('text.clear')}
        className={BUTTON}
        onClick={() => run({ type: 'clear' })}
      >
        {t('text.clear')}
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
