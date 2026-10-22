import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Guide, Handle, Rect } from '../geometry';

export interface CanvasOverlayProps {
  /** Selected object rect in design pixels. */
  rect: Rect | null;
  /** Selection rotation in degrees. */
  rotation: number;
  /** Active snap guides in design pixels. */
  guides: Guide[];
  scale: number;
  /** Nested selections expose an outline only; transforms stay disabled. */
  readOnly: boolean;
  /** `data-ppt-el` id of the selected element, when authored. */
  selectedId: string | null;
  /** Child-index path from the slide to the selected element. */
  selectedPath: readonly number[] | null;
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
 * Renders the selection outline, resize/rotate handles, and snap guides in the
 * editor document. It must stay outside the deck iframe so no editor markup
 * can reach the saved HTML.
 */
export function CanvasOverlay({
  rect,
  rotation,
  guides,
  scale,
  readOnly,
  selectedId,
  selectedPath,
  onResizeStart,
  onRotateStart
}: CanvasOverlayProps) {
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
            className="absolute top-0 h-full w-px bg-rose-400/80"
            style={{ left: guide.position * scale }}
          />
        ) : (
          <div
            key={`y-${index}`}
            data-testid="guide-y"
            className="absolute left-0 h-px w-full bg-rose-400/80"
            style={{ top: guide.position * scale }}
          />
        )
      )}

      {rect && (
        <div
          data-testid="selection-outline"
          data-readonly={readOnly ? 'true' : undefined}
          data-selected-id={selectedId ?? undefined}
          data-selected-path={selectedPath?.join('.')}
          className="pointer-events-none absolute border border-amber-400"
          style={{
            left: rect.x * scale,
            top: rect.y * scale,
            width: rect.width * scale,
            height: rect.height * scale,
            transform: rotation === 0 ? undefined : `rotate(${rotation}deg)`
          }}
        >
          {!readOnly && (
            <>
              {HANDLES.map((handle) => (
                <div
                  key={handle}
                  data-testid={`handle-${handle}`}
                  className="pointer-events-auto absolute h-2.5 w-2.5 rounded-[2px] border border-amber-200 bg-amber-400"
                  style={{
                    ...HANDLE_POSITIONS[handle],
                    transform: 'translate(-50%, -50%)'
                  }}
                  onPointerDown={(event) => onResizeStart(handle, event)}
                />
              ))}
              <div
                data-testid="rotate-handle"
                className="pointer-events-auto absolute left-1/2 h-3 w-3 rounded-full border border-amber-200 bg-amber-400"
                style={{
                  top: 0,
                  transform: 'translate(-50%, calc(-100% - 16px))'
                }}
                onPointerDown={onRotateStart}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
