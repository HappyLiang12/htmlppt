import {
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent
} from 'react';
import type { SlideInfo } from '@htmlppt/core';

export interface PlayViewProps {
  slide: SlideInfo;
  srcDoc: string;
  /**
   * Forwards keyboard events from the play iframe to the editor shell, which
   * owns navigation and exits presenting.
   */
  onKeyDown: (event: KeyboardEvent, activeDocument: Document) => void;
}

function viewportFit(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  if (width <= 0 || height <= 0) return 1;
  return Math.min(window.innerWidth / width, window.innerHeight / height);
}

/**
 * Chrome-free presentation surface. It renders only the active slide in a
 * script-free iframe, scaled to fill the viewport with letterboxing. Visual
 * transitions and presenter view arrive in M4; M3 only keeps the authored
 * transition attributes untouched.
 */
export function PlayView({ slide, srcDoc, onKeyDown }: PlayViewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const [scale, setScale] = useState(() =>
    viewportFit(slide.width, slide.height)
  );

  useLayoutEffect(() => {
    const update = () => setScale(viewportFit(slide.width, slide.height));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [slide.width, slide.height]);

  const handleLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const frameDocument = event.currentTarget.contentDocument;
    if (!frameDocument) return;
    // Keys belong to the deck while its iframe owns focus; forward them so
    // navigation and Escape behave the same as in the parent document.
    frameDocument.addEventListener('keydown', (keyEvent) => {
      onKeyDownRef.current(keyEvent, frameDocument);
    });
  };

  return (
    <div
      data-testid="play-view"
      role="region"
      aria-label="播放模式"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black"
    >
      <div
        className="relative"
        style={{
          width: slide.width * scale,
          height: slide.height * scale
        }}
      >
        <iframe
          ref={frameRef}
          data-testid="play-frame"
          title="播放投影片"
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={handleLoad}
          className="absolute left-0 top-0 border-0 bg-white"
          style={{
            width: slide.width,
            height: slide.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left'
          }}
        />
      </div>
    </div>
  );
}
