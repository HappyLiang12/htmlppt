import {
  imageSourceFromFile,
  insertChart,
  insertImage,
  insertShape,
  insertTable,
  insertTextBox,
  validateImageSource,
  type ShapeKind
} from '@htmlppt/core';
import { DEFAULT_CHART } from './charts';

export interface CanvasSize {
  width: number;
  height: number;
}

export interface InsertRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InsertRequest =
  | { kind: 'text'; text?: string }
  | { kind: 'shape'; shape: ShapeKind }
  | { kind: 'table'; rows: number; columns: number }
  | { kind: 'chart' }
  | { kind: 'image'; file?: File; url?: string };

export interface PreparedInsertion {
  apply: (slide: Element) => Element;
}

const DEFAULT_SIZE: Record<InsertRequest['kind'], { width: number; height: number }> =
  {
    text: { width: 480, height: 120 },
    shape: { width: 320, height: 200 },
    table: { width: 960, height: 300 },
    chart: { width: 800, height: 450 },
    image: { width: 480, height: 270 }
  };

export function defaultInsertRect(
  canvas: CanvasSize,
  kind: InsertRequest['kind']
): InsertRect {
  const size = DEFAULT_SIZE[kind];
  const x = Math.max(0, Math.round((canvas.width - size.width) / 2));
  const y = Math.max(0, Math.round((canvas.height - size.height) / 2));
  return { x, y, width: size.width, height: size.height };
}

/**
 * Resolves file reads and URL validation before the master document is
 * touched, so an invalid image never creates an undo entry.
 */
export async function prepareInsertion(
  request: InsertRequest,
  canvas: CanvasSize
): Promise<PreparedInsertion> {
  const rect = defaultInsertRect(canvas, request.kind);
  if (request.kind === 'text') {
    const text = request.text ?? 'Text box';
    return {
      apply: (slide) => insertTextBox(slide, { ...rect, text })
    };
  }
  if (request.kind === 'shape') {
    return {
      apply: (slide) => insertShape(slide, { ...rect, shape: request.shape })
    };
  }
  if (request.kind === 'table') {
    return {
      apply: (slide) =>
        insertTable(slide, {
          rows: request.rows,
          columns: request.columns,
          header: true,
          x: rect.x,
          y: rect.y,
          width: rect.width
        })
    };
  }
  if (request.kind === 'chart') {
    return {
      apply: (slide) =>
        insertChart(slide, {
          data: DEFAULT_CHART,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        })
    };
  }
  const source = request.file
    ? await imageSourceFromFile(request.file)
    : validateImageSource(request.url ?? '');
  return {
    apply: (slide) => insertImage(slide, { ...rect, source })
  };
}
