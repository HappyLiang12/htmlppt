import { describe, expect, it } from 'vitest';
import {
  chartFigure,
  DEFAULT_CHART,
  refreshChart,
  refreshOwnedCharts
} from './charts';

function chartSvg(): Element {
  return document.createElementNS('http://www.w3.org/2000/svg', 'svg');
}

describe('chartFigure', () => {
  it('finds the chart figure from a descendant svg', () => {
    const figure = document.createElement('figure');
    figure.setAttribute('data-ppt-chart', '{}');
    const svg = chartSvg();
    figure.appendChild(svg);
    expect(chartFigure(svg)).toBe(figure);
    expect(chartFigure(figure)).toBe(figure);
    expect(chartFigure(null)).toBeNull();
  });

  it('ignores elements outside a chart figure', () => {
    expect(chartFigure(chartSvg())).toBeNull();
    const div = document.createElement('div');
    expect(chartFigure(div)).toBeNull();
  });

  it('resolves the nearest figure for a nested chart', () => {
    const outer = document.createElement('figure');
    outer.setAttribute('data-ppt-chart', '{}');
    const inner = document.createElement('figure');
    inner.setAttribute('data-ppt-chart', '{}');
    const span = document.createElement('span');
    inner.appendChild(span);
    outer.appendChild(inner);
    expect(chartFigure(span)).toBe(inner);
    expect(chartFigure(inner)).toBe(inner);
  });

  it('refreshes the owning figure from a descendant', () => {
    const figure = document.createElement('figure');
    figure.setAttribute('data-ppt-chart', JSON.stringify(DEFAULT_CHART));
    const svg = chartSvg();
    figure.appendChild(svg);
    document.body.appendChild(figure);
    try {
      expect(refreshChart(svg)).toBe(true);
      expect(figure.querySelector('svg')).not.toBe(svg);
      expect(figure.querySelector('svg')).not.toBeNull();
    } finally {
      figure.remove();
    }
  });
});

function chartWithShape() {
  const figure = document.createElement('figure');
  figure.setAttribute('data-ppt-chart', JSON.stringify(DEFAULT_CHART));
  const svg = chartSvg();
  const circle = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'circle'
  );
  circle.setAttribute('transform', 'rotate(10)');
  svg.appendChild(circle);
  figure.appendChild(svg);
  document.body.appendChild(figure);
  return { figure, svg, circle };
}

describe('refreshOwnedCharts', () => {
  it('leaves the owner svg intact when refreshing a shape inside it', () => {
    const { figure, svg, circle } = chartWithShape();
    try {
      refreshOwnedCharts(circle);

      expect(figure.querySelector('svg')).toBe(svg);
      expect(circle.getAttribute('transform')).toBe('rotate(10)');
    } finally {
      figure.remove();
    }
  });

  it('leaves the owner svg intact when refreshing the svg itself', () => {
    const { figure, svg, circle } = chartWithShape();
    try {
      refreshOwnedCharts(svg);

      expect(figure.querySelector('svg')).toBe(svg);
      expect(circle.getAttribute('transform')).toBe('rotate(10)');
    } finally {
      figure.remove();
    }
  });

  it('re-renders the figure when the figure itself is refreshed', () => {
    const { figure, svg } = chartWithShape();
    try {
      refreshOwnedCharts(figure);

      expect(figure.querySelector('svg')).not.toBe(svg);
      expect(figure.querySelector('svg')).not.toBeNull();
    } finally {
      figure.remove();
    }
  });

  it('re-renders a chart nested inside a refreshed container', () => {
    const { figure, svg } = chartWithShape();
    const card = document.createElement('div');
    document.body.appendChild(card);
    card.appendChild(figure);
    try {
      refreshOwnedCharts(card);

      expect(figure.querySelector('svg')).not.toBe(svg);
      expect(figure.querySelector('svg')).not.toBeNull();
    } finally {
      card.remove();
    }
  });
});
