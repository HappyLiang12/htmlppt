import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Guide, Handle, Rect } from '../geometry';
import { useI18n } from '../i18n';

export interface SelectionBox {
  /** Selection rect in design pixels, relative to the slide origin. */
  rect: Rect;
  /** Inline rotation of the selected object in degrees. */
  rotation: number;
  /** Raw child-index path from the slide. */
  path: readonly number[];
  /** `data-ppt-el` id of the selected element, when authored. */
  elementId: string | null;
}

export interface CanvasOverlayProps {
  /** Selected object outlines in design pixels. */
  boxes: readonly SelectionBox[];
  /** Active snap guides in design pixels. */
  guides: Guide[];
  scale: number;
  /**
   * Nested and multi selections expose outlines only; resize, rotate, and
   * numeric geometry stay single-object operations.
   */
  readOnly: boolean;
  /** Groups keep rotation but cannot be resized; locked objects disable both. */
  handles?: 'all' | 'rotate' | 'none';
  onResizeStart: (
    handle: Handle,
    event: ReactPointerEvent<HTMLDivElement>
  ) => void;
  onRotateStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const HANDLE_POSITIONS: Record<Handle, { left: string; top: string }> = {
  nw: { left: '0%', top: '0%' },
  n: { left: '50%', top: '0%' },
  ne: { left: '100%', top: '0%' },
  e: { left: '100%', top: '50%' },
  se: { left: '100%', top: '100%' },
  s: { left: '50%', top: '100%' },
  sw: { left: '0%', top: '100%' },
  w: { left: '0%', top: '50%' }
};

/**
 * Renders selection outlines, resize/rotate handles, and snap guides in the
 * editor document. It must stay outside the deck iframe so no editor markup
 * can reach the saved HTML.
 */
export function CanvasOverlay({
  boxes,
  guides,
  scale,
  readOnly,
  handles = 'all',
  onResizeStart,
  onRotateStart
}: CanvasOverlayProps) {
  const { t } = useI18n();
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      data-testid="canvas-overlay"
    >
      {guides.map((guide, index) =>
        guide.axis === 'x' ? (
          <div
            key={`x-${index}`}
            data-testid="guide-x"
            className="absolute top-0 h-full w-px bg-danger/80"
            style={{ left: guide.position * scale }}
          />
        ) : (
          <div
            key={`y-${index}`}
            data-testid="guide-y"
            className="absolute left-0 h-px w-full bg-danger/80"
            style={{ top: guide.position * scale }}
          />
        )
      )}

      {boxes.map((box, index) => {
        const interactive = index === 0 && !readOnly && handles !== 'none';
        const resizable = interactive && handles !== 'rotate';
        return (
          <div
            key={box.path.join('.') || index}
            data-testid="selection-outline"
            data-readonly={!interactive ? 'true' : undefined}
            data-primary={index === 0 ? 'true' : undefined}
            data-selected-id={box.elementId ?? undefined}
            data-selected-path={box.path.join('.')}
            className={`pointer-events-none absolute ${
              index === 0 ? 'border-2' : 'border'
            } border-accent`}
            style={{
              left: box.rect.x * scale,
              top: box.rect.y * scale,
              width: box.rect.width * scale,
              height: box.rect.height * scale,
              transform:
                box.rotation === 0 ? undefined : `rotate(${box.rotation}deg)`
            }}
          >
            {index === 0 && (
              <span
                data-testid="selection-marker"
                aria-hidden="true"
                className="absolute left-0 top-0 rounded-br bg-accent px-1 text-[10px] font-semibold text-on-accent"
              >
                {t('canvas.selected')}
              </span>
            )}
            {interactive && (
              <>
                {resizable && HANDLES.map((handle) => (
                  <div
                    key={handle}
                    data-testid={`handle-${handle}`}
                    className="pointer-events-auto absolute h-2.5 w-2.5 rounded-[2px] border border-on-accent bg-accent"
                    style={{
                      ...HANDLE_POSITIONS[handle],
                      transform: 'translate(-50%, -50%)'
                    }}
                    onPointerDown={(event) => onResizeStart(handle, event)}
                  />
                ))}
                <div
                  data-testid="rotate-handle"
                  className="pointer-events-auto absolute left-1/2 h-3 w-3 rounded-full border border-on-accent bg-accent"
                  style={{
                    top: 0,
                    transform: 'translate(-50%, calc(-100% - 16px))'
                  }}
                  onPointerDown={onRotateStart}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
