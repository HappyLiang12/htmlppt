import { appendObject } from './mutations.js';
import { DeckMutationError } from './target.js';

export type ChartType = 'bar' | 'line' | 'pie';

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  type: ChartType;
  title?: string;
  labels: string[];
  series: ChartSeries[];
  colors?: string[];
  legend?: boolean;
  valueLabels?: boolean;
}

export const CHART_ATTRIBUTE = 'data-ppt-chart';
export const DEFAULT_CHART_COLORS = [
  '#4f7cff',
  '#e8a33d',
  '#22a06b',
  '#d64545',
  '#8b5cf6',
  '#0891b2'
];
export const MAX_CHART_LABELS = 50;
export const MAX_CHART_SERIES = 20;

function fail(message: string): never {
  throw new DeckMutationError('invalid-chart', message);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colorValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) fail(`${label} must not be empty.`);
  if (/url\s*\(/i.test(trimmed)) {
    fail(`${label} must be a color, not a URL reference.`);
  }
  if (
    !/^#[0-9a-f]{3,8}$/i.test(trimmed) &&
    !/^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)$/i.test(trimmed) &&
    !/^[a-z]{3,20}$/i.test(trimmed)
  ) {
    fail(`${label} must be a CSS color.`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * Validates and normalizes chart JSON. Errors name the exact field so the
 * editor or an agent can correct the data without guessing.
 */
export function parseChartData(value: string | unknown): ChartData {
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value);
    } catch (error) {
      fail(
        `Chart data is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (!isRecord(raw)) fail('Chart data must be a JSON object.');
  const type = raw.type;
  if (type !== 'bar' && type !== 'line' && type !== 'pie') {
    fail('Chart type must be "bar", "line", or "pie".');
  }
  const labels = raw.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    fail('Chart labels must be a non-empty array.');
  }
  if (labels.length > MAX_CHART_LABELS) {
    fail(`Chart labels must contain at most ${MAX_CHART_LABELS} entries.`);
  }
  const normalizedLabels = labels.map((label, index) =>
    textValue(label, `labels[${index}]`)
  );
  const series = raw.series;
  if (!Array.isArray(series) || series.length === 0) {
    fail('Chart series must be a non-empty array.');
  }
  if (series.length > MAX_CHART_SERIES) {
    fail(`Chart series must contain at most ${MAX_CHART_SERIES} entries.`);
  }
  const normalizedSeries = series.map((entry, index) => {
    if (!isRecord(entry)) fail(`series[${index}] must be an object.`);
    const name = textValue(entry.name, `series[${index}].name`);
    const values = entry.values;
    if (!Array.isArray(values)) {
      fail(`series[${index}].values must be an array of numbers.`);
    }
    if (values.length !== normalizedLabels.length) {
      fail(
        `series[${index}].values has ${values.length} numbers but labels has ${normalizedLabels.length}.`
      );
    }
    const normalizedValues = values.map((number, valueIndex) => {
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        fail(`series[${index}].values[${valueIndex}] must be a finite number.`);
      }
      return number;
    });
    return { name, values: normalizedValues };
  });
  if (type === 'pie') {
    if (normalizedSeries.length !== 1) {
      fail('Pie charts require exactly one series.');
    }
    const values = normalizedSeries[0]?.values ?? [];
    if (values.some((number) => number < 0)) {
      fail('Pie chart values must not be negative.');
    }
    if (values.every((number) => number === 0)) {
      fail('Pie chart values must include at least one value above zero.');
    }
  }
  if (raw.title !== undefined && typeof raw.title !== 'string') {
    fail('Chart title must be a string.');
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length > 200) fail('Chart title must be at most 200 characters.');
  let colors: string[] | undefined;
  if (raw.colors !== undefined) {
    if (!Array.isArray(raw.colors) || raw.colors.length === 0) {
      fail('Chart colors must be a non-empty array of CSS colors.');
    }
    colors = raw.colors.map((color, index) =>
      colorValue(
        typeof color === 'string' ? color : '',
        `colors[${index}]`
      )
    );
    const needed =
      type === 'pie' ? normalizedLabels.length : normalizedSeries.length;
    if (colors.length < needed) {
      fail(`Chart colors must include at least ${needed} entries.`);
    }
  }
  if (raw.legend !== undefined && typeof raw.legend !== 'boolean') {
    fail('Chart legend must be a boolean.');
  }
  if (raw.valueLabels !== undefined && typeof raw.valueLabels !== 'boolean') {
    fail('Chart valueLabels must be a boolean.');
  }
  return {
    type,
    title,
    labels: normalizedLabels,
    series: normalizedSeries,
    colors:
      colors ??
      Array.from(
        {
          length:
            type === 'pie'
              ? normalizedLabels.length
              : normalizedSeries.length
        },
        (_, index) =>
          DEFAULT_CHART_COLORS[index % DEFAULT_CHART_COLORS.length] as string
      ),
    legend: raw.legend === true || (raw.legend === undefined && normalizedSeries.length > 1),
    valueLabels: raw.valueLabels === true
  };
}

export function chartDataOf(element: Element): ChartData {
  const raw = element.getAttribute(CHART_ATTRIBUTE);
  if (!raw) fail('The selected object is not a chart.');
  return parseChartData(raw);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function n(value: number): string {
  return String(round(value));
}

/** Deterministic inline SVG: same data and size produce byte-identical markup. */
export function renderChartSvg(
  data: ChartData,
  width: number,
  height: number
): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 160 || height < 120) {
    fail('Chart size must be at least 160x120 pixels.');
  }
  const w = Math.round(width);
  const h = Math.round(height);
  const palette = data.colors ?? DEFAULT_CHART_COLORS;
  const titleHeight = data.title ? 34 : 0;
  const legendHeight = data.legend ? 24 : 0;
  const padding = 24;
  const axisLeft = 56;
  const bottom = 38;
  const plot = {
    x: axisLeft,
    y: padding + titleHeight + legendHeight,
    width: Math.max(10, w - axisLeft - padding),
    height: Math.max(10, h - (padding + titleHeight + legendHeight) - bottom)
  };
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">`
  );
  parts.push(`<title>${escapeXml(data.title || 'Chart')}</title>`);
  parts.push(`<rect width="${w}" height="${h}" fill="#ffffff"/>`);
  if (data.title) {
    parts.push(
      `<text x="${padding}" y="${padding + 18}" font-family="Inter, sans-serif" font-size="16" font-weight="600" fill="#17181c">${escapeXml(data.title)}</text>`
    );
  }
  if (data.legend) {
    const entries =
      data.type === 'pie'
        ? data.labels.map((label, index) => ({
            name: label,
            color: palette[index % palette.length] as string
          }))
        : data.series.map((entry, index) => ({
            name: entry.name,
            color: palette[index % palette.length] as string
          }));
    let x = padding;
    const y = padding + titleHeight + 12;
    for (const entry of entries) {
      parts.push(
        `<rect x="${n(x)}" y="${n(y - 9)}" width="10" height="10" rx="2" fill="${escapeXml(entry.color)}"/>`
      );
      const label = escapeXml(entry.name);
      parts.push(
        `<text x="${n(x + 15)}" y="${n(y)}" font-family="Inter, sans-serif" font-size="11" fill="#4a4f59">${label}</text>`
      );
      x += 15 + entry.name.length * 6.4 + 18;
    }
  }
  if (data.type === 'pie') {
    parts.push(renderPie(data, palette, plot));
  } else if (data.type === 'bar') {
    parts.push(...renderBar(data, palette, plot));
  } else {
    parts.push(...renderLine(data, palette, plot));
  }
  parts.push('</svg>');
  return parts.join('');
}

interface Plot {
  x: number;
  y: number;
  width: number;
  height: number;
}

function axisScale(data: ChartData): { min: number; max: number } {
  const values = data.series.flatMap((entry) => entry.values);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    max = min + 1;
  } else {
    const pad = (max - min) * 0.08;
    max += pad;
    if (min < 0) min -= pad;
  }
  return { min, max };
}

function yFor(value: number, scale: { min: number; max: number }, plot: Plot): number {
  return plot.y + plot.height - ((value - scale.min) / (scale.max - scale.min)) * plot.height;
}

function renderBar(
  data: ChartData,
  palette: string[],
  plot: Plot
): string[] {
  const parts: string[] = [];
  const scale = axisScale(data);
  for (let step = 0; step <= 4; step += 1) {
    const value = scale.min + ((scale.max - scale.min) * step) / 4;
    const y = yFor(value, scale, plot);
    parts.push(
      `<line x1="${n(plot.x)}" y1="${n(y)}" x2="${n(plot.x + plot.width)}" y2="${n(y)}" stroke="#e5e7eb" stroke-width="1"/>`
    );
    parts.push(
      `<text x="${n(plot.x - 8)}" y="${n(y + 4)}" text-anchor="end" font-family="Inter, sans-serif" font-size="10" fill="#6b7280">${n(value)}</text>`
    );
  }
  const group = plot.width / data.labels.length;
  const barWidth = Math.max(2, (group * 0.72) / data.series.length);
  const zeroY = yFor(0, scale, plot);
  data.series.forEach((entry, seriesIndex) => {
    const color = palette[seriesIndex % palette.length] as string;
    entry.values.forEach((value, index) => {
      const valueY = yFor(value, scale, plot);
      const x =
        plot.x +
        index * group +
        group * 0.14 +
        seriesIndex * barWidth;
      const y = Math.min(valueY, zeroY);
      const height = Math.max(1, Math.abs(zeroY - valueY));
      parts.push(
        `<rect x="${n(x)}" y="${n(y)}" width="${n(barWidth - 1)}" height="${n(height)}" fill="${escapeXml(color)}" rx="1"/>`
      );
      if (data.valueLabels) {
        parts.push(
          `<text x="${n(x + barWidth / 2)}" y="${n(value >= 0 ? y - 4 : y + height + 12)}" text-anchor="middle" font-family="Inter, sans-serif" font-size="10" fill="#374151">${n(value)}</text>`
        );
      }
    });
  });
  data.labels.forEach((label, index) => {
    parts.push(
      `<text x="${n(plot.x + index * group + group / 2)}" y="${n(plot.y + plot.height + 18)}" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" fill="#4a4f59">${escapeXml(label)}</text>`
    );
  });
  return parts;
}

function renderLine(
  data: ChartData,
  palette: string[],
  plot: Plot
): string[] {
  const parts: string[] = [];
  const scale = axisScale(data);
  for (let step = 0; step <= 4; step += 1) {
    const value = scale.min + ((scale.max - scale.min) * step) / 4;
    const y = yFor(value, scale, plot);
    parts.push(
      `<line x1="${n(plot.x)}" y1="${n(y)}" x2="${n(plot.x + plot.width)}" y2="${n(y)}" stroke="#e5e7eb" stroke-width="1"/>`
    );
    parts.push(
      `<text x="${n(plot.x - 8)}" y="${n(y + 4)}" text-anchor="end" font-family="Inter, sans-serif" font-size="10" fill="#6b7280">${n(value)}</text>`
    );
  }
  const step =
    data.labels.length > 1 ? plot.width / (data.labels.length - 1) : 0;
  data.series.forEach((entry, seriesIndex) => {
    const color = palette[seriesIndex % palette.length] as string;
    const points = entry.values.map((value, index) => {
      const x = plot.x + (data.labels.length > 1 ? index * step : plot.width / 2);
      const y = yFor(value, scale, plot);
      return { x, y, value };
    });
    parts.push(
      `<polyline fill="none" stroke="${escapeXml(color)}" stroke-width="2.5" points="${points.map((point) => `${n(point.x)},${n(point.y)}`).join(' ')}"/>`
    );
    for (const point of points) {
      parts.push(
        `<circle cx="${n(point.x)}" cy="${n(point.y)}" r="3" fill="${escapeXml(color)}"/>`
      );
      if (data.valueLabels) {
        parts.push(
          `<text x="${n(point.x)}" y="${n(point.y - 8)}" text-anchor="middle" font-family="Inter, sans-serif" font-size="10" fill="#374151">${n(point.value)}</text>`
        );
      }
    }
  });
  data.labels.forEach((label, index) => {
    const x =
      plot.x + (data.labels.length > 1 ? index * step : plot.width / 2);
    parts.push(
      `<text x="${n(x)}" y="${n(plot.y + plot.height + 18)}" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" fill="#4a4f59">${escapeXml(label)}</text>`
    );
  });
  return parts;
}

function renderPie(data: ChartData, palette: string[], plot: Plot): string {
  const parts: string[] = [];
  const values = data.series[0]?.values ?? [];
  const total = values.reduce((sum, value) => sum + value, 0);
  const radius = Math.max(
    10,
    Math.min(plot.width, plot.height) / 2 - 12
  );
  const cx = plot.x + plot.width / 2;
  const cy = plot.y + plot.height / 2;
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    const start = angle;
    const sweep = (value / total) * Math.PI * 2;
    angle += sweep;
    if (value === 0) return;
    const end = angle;
    const largeArc = sweep > Math.PI ? 1 : 0;
    const x1 = cx + radius * Math.cos(start);
    const y1 = cy + radius * Math.sin(start);
    const x2 = cx + radius * Math.cos(end);
    const y2 = cy + radius * Math.sin(end);
    const color = palette[index % palette.length] as string;
    if (values.filter((entry) => entry > 0).length === 1) {
      parts.push(
        `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}" fill="${escapeXml(color)}"/>`
      );
    } else {
      parts.push(
        `<path d="M ${n(cx)} ${n(cy)} L ${n(x1)} ${n(y1)} A ${n(radius)} ${n(radius)} 0 ${largeArc} 1 ${n(x2)} ${n(y2)} Z" fill="${escapeXml(color)}"/>`
      );
    }
    if (data.valueLabels) {
      const mid = start + sweep / 2;
      parts.push(
        `<text x="${n(cx + (radius * 0.62) * Math.cos(mid))}" y="${n(cy + (radius * 0.62) * Math.sin(mid) + 4)}" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" fill="#ffffff">${n((value / total) * 100)}%</text>`
      );
    }
  });
  return parts.join('');
}

export function chartSizeOf(figure: Element): { width: number; height: number } {
  const html = figure as HTMLElement;
  const parsePx = (value: string): number | null => {
    const match = /^([0-9.]+)px$/.exec(value.trim());
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed >= 160 ? parsed : null;
  };
  const styleWidth = html.style ? parsePx(html.style.width) : null;
  const styleHeight = html.style ? parsePx(html.style.height) : null;
  const viewBox = figure
    .querySelector('svg')
    ?.getAttribute('viewBox')
    ?.split(/\s+/)
    .map((part) => Number(part));
  const width = styleWidth ?? viewBox?.[2] ?? 640;
  const height = styleHeight ?? viewBox?.[3] ?? 360;
  return { width, height };
}

/**
 * Stores normalized data and replaces the rendered SVG. Explicit size wins,
 * then the figure's own size, then the previous SVG viewBox, then 640x360.
 */
export function updateChart(
  figure: Element,
  data: ChartData | string | unknown,
  width?: number,
  height?: number
): void {
  const normalized = parseChartData(data);
  const size =
    width !== undefined && height !== undefined
      ? { width, height }
      : chartSizeOf(figure);
  figure.setAttribute(CHART_ATTRIBUTE, JSON.stringify(normalized));
  figure.innerHTML = renderChartSvg(normalized, size.width, size.height);
}

export interface InsertChartOptions {
  data: ChartData | string | unknown;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function insertChart(
  slide: Element,
  options: InsertChartOptions
): Element {
  for (const value of [options.x, options.y, options.width, options.height]) {
    if (!Number.isFinite(value)) fail('Chart geometry must be finite numbers.');
  }
  if (options.width < 160 || options.height < 120) {
    fail('Chart size must be at least 160x120 pixels.');
  }
  const data = parseChartData(options.data);
  const figure = slide.ownerDocument.createElement('figure');
  figure.style.position = 'absolute';
  figure.style.left = `${options.x}px`;
  figure.style.top = `${options.y}px`;
  figure.style.width = `${options.width}px`;
  figure.style.height = `${options.height}px`;
  figure.style.margin = '0';
  figure.style.overflow = 'hidden';
  updateChart(figure, data, options.width, options.height);
  return appendObject(slide, figure);
}
