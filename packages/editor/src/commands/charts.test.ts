import { describe, expect, it } from 'vitest';
import { chartFigure } from './charts';

describe('chartFigure', () => {
  it('finds the chart figure from a descendant svg', () => {
    const figure = document.createElement('figure');
    figure.setAttribute('data-ppt-chart', '{}');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    figure.appendChild(svg);
    expect(chartFigure(svg)).toBe(figure);
    expect(chartFigure(figure)).toBe(figure);
    expect(chartFigure(null)).toBeNull();
  });
});
