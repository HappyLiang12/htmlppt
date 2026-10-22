import {
  chartDataOf,
  parseChartData,
  updateChart,
  type ChartData
} from '@htmlppt/core';

export const DEFAULT_CHART: ChartData = {
  type: 'bar',
  title: 'Chart',
  labels: ['Q1', 'Q2', 'Q3', 'Q4'],
  series: [{ name: 'Series 1', values: [12, 20, 16, 28] }],
  colors: ['#4f7cff'],
  legend: false,
  valueLabels: true
};

export function chartFigure(element: Element | null): Element | null {
  if (!element) return null;
  if (element.tagName.toLowerCase() !== 'figure') return null;
  return element.hasAttribute('data-ppt-chart') ? element : null;
}

export function chartJson(element: Element): string {
  return `${JSON.stringify(chartDataOf(element), null, 2)}\n`;
}

export function refreshChart(element: Element): boolean {
  if (!chartFigure(element)) return false;
  updateChart(element, chartDataOf(element));
  return true;
}

export function refreshCharts(root: Element): void {
  for (const figure of Array.from(
    root.querySelectorAll('figure[data-ppt-chart]')
  )) {
    try {
      refreshChart(figure);
    } catch {
      // Invalid authored chart JSON keeps its existing rendering.
    }
  }
}

export function withChartData(
  element: Element,
  json: string
): { ok: true; data: ChartData } | { ok: false; error: string } {
  try {
    const data = parseChartData(json);
    updateChart(element, data);
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
