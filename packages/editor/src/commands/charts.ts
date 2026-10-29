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

/**
 * Resolves the owning chart figure from the figure itself or any descendant,
 * so selections of the chart's svg or its shapes still reach the data contract
 * kept on the figure.
 */
export function chartFigure(element: Element | null): Element | null {
  if (!element) return null;
  return element.closest('figure[data-ppt-chart]');
}

export function chartJson(element: Element): string {
  return `${JSON.stringify(chartDataOf(element), null, 2)}\n`;
}

export function refreshChart(element: Element): boolean {
  const figure = chartFigure(element);
  if (!figure) return false;
  updateChart(figure, chartDataOf(figure));
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

/**
 * Re-renders the chart figure the element itself is, plus every chart figure
 * nested inside it. A shape or svg inside a figure must not refresh its owner:
 * that re-render replaces the svg and discards the shape's authored or dragged
 * transform. A container that holds a chart still refreshes the chart.
 */
export function refreshOwnedCharts(element: Element): void {
  if (chartFigure(element) === element) {
    try {
      refreshChart(element);
    } catch {
      // Invalid authored chart JSON keeps its existing rendering.
    }
  }
  refreshCharts(element);
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
