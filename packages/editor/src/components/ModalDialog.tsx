import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import { focusableWithin, wrapFocusIndex } from '../focus';

export interface ModalDialogProps {
  label: string;
  onClose: () => void;
  testId?: string;
  /** Selector for the element that should own focus when the dialog opens. */
  initialFocus?: string;
  panelClassName?: string;
  children: ReactNode;
}

/**
 * Modal shell: accessible name, focus trap, Escape close, and focus restored
 * to the opener on unmount. Keys are captured at the document so the dialog
 * stays operable after focus lands on a non-focusable heading or the backdrop.
 */
export function ModalDialog({
  label,
  onClose,
  testId,
  initialFocus,
  panelClassName = '',
  children
}: ModalDialogProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    const first = panel
      ? (initialFocus
          ? panel.querySelector<HTMLElement>(initialFocus)
          : null) ?? focusableWithin(panel)[0]
      : null;
    first?.focus();
    return () => {
      const previous = restoreRef.current;
      restoreRef.current = null;
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusableWithin(panel);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] : items[0])?.focus();
        return;
      }
      const current = items.indexOf(active);
      if (current === -1) {
        event.preventDefault();
        items[0]?.focus();
        return;
      }
      const last = items.length - 1;
      const wrapsOutside =
        (!event.shiftKey && current === last) ||
        (event.shiftKey && current === 0);
      if (wrapsOutside) {
        event.preventDefault();
        items[wrapFocusIndex(current, items.length, event.shiftKey)]?.focus();
      }
      // Interior Tab steps stay with the browser so native controls keep their
      // expected order if the dialog content changes.
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const focusPanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    panelRef.current?.focus();
  };

  return (
    <div
      ref={overlayRef}
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onPointerDown={focusPanel}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`flex max-h-full flex-col gap-3 rounded-lg border border-white/30 bg-[#12151b] p-4 shadow-2xl outline-none ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
