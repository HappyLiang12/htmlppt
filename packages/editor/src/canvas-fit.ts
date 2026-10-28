import { sameBox, type SlideBox } from './play-fit';

export interface MeasuredBox {
  id: string;
  box: SlideBox;
}

export interface SlideSize {
  id: string;
  width: number;
  height: number;
}

export interface CanvasCrop {
  width: number;
  height: number;
  translateX: number;
  translateY: number;
}

export interface MiniatureCrop {
  scale: number;
  height: number;
  translateX: number;
  translateY: number;
}

export function metadataBox(slide: SlideSize): SlideBox {
  return { left: 0, top: 0, width: slide.width, height: slide.height };
}

export function stageBoxFor(
  slide: SlideSize,
  measured: MeasuredBox | null
): SlideBox {
  return measured && measured.id === slide.id
    ? measured.box
    : metadataBox(slide);
}

/** Stage size plus the frame translation that crops the surrounding band. */
export function canvasCrop(box: SlideBox, scale: number): CanvasCrop {
  return {
    width: box.width * scale,
    height: box.height * scale,
    translateX: 0 - box.left * scale,
    translateY: 0 - box.top * scale
  };
}

/** Fixed display width scaled to the measured box, with the crop translation. */
export function miniatureCrop(
  box: SlideBox,
  displayWidth: number
): MiniatureCrop {
  const scale = box.width > 0 ? displayWidth / box.width : 1;
  return {
    scale,
    height: box.height * scale,
    translateX: 0 - box.left * scale,
    translateY: 0 - box.top * scale
  };
}

export function sameMeasuredBox(
  a: MeasuredBox | null,
  b: MeasuredBox | null
): boolean {
  return a === null || b === null
    ? a === b
    : a.id === b.id && sameBox(a.box, b.box);
}
