// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chartDataOf,
  chartSizeOf,
  insertChart,
  parseChartData,
  renderChartSvg,
  updateChart,
  type ChartData
} from '../src/charts.js';

const BAR: ChartData = {
  type: 'bar',
  title: 'Revenue',
  labels: ['Q1', 'Q2', 'Q3'],
  series: [{ name: 'USD', values: [10, 24, 31] }]
};

function slide(): Element {
  document.body.innerHTML =
    '<section data-slide-id="s1" data-width="1600" data-height="900"></section>';
  return document.querySelector('[data-slide-id]')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('parseChartData', () => {
  it('normalizes defaults and validates series lengths', () => {
    const parsed = parseChartData(JSON.stringify(BAR));
    expect(parsed.title).toBe('Revenue');
    expect(parsed.series).toEqual([{ name: 'USD', values: [10, 24, 31] }]);
    expect(parsed.colors?.length).toBe(1);
    expect(parsed.legend).toBe(false);
    expect(parsed.valueLabels).toBe(false);

    const multi = parseChartData({
      type: 'line',
      labels: ['a', 'b'],
      series: [
        { name: 'one', values: [1, 2] },
        { name: 'two', values: [3, 4] }
      ]
    });
    expect(multi.legend).toBe(true);
    expect(multi.colors?.length).toBe(2);
  });

  it('reports actionable validation errors', () => {
    expect(() => parseChartData('{')).toThrow(/not valid JSON/);
    expect(() => parseChartData({ type: 'area', labels: ['a'], series: [] })).toThrow(
      /"bar", "line", or "pie"/
    );
    expect(() => parseChartData({ type: 'bar', labels: [], series: [] })).toThrow(
      /labels must be a non-empty/
    );
    expect(() =>
      parseChartData({
        type: 'bar',
        labels: ['a', 'b'],
        series: [{ name: 'one', values: [1] }]
      })
    ).toThrow(/values has 1 numbers but labels has 2/);
    expect(() =>
      parseChartData({
        type: 'bar',
        labels: ['a'],
        series: [{ name: 'one', values: [Number.NaN] }]
      })
    ).toThrow(/finite number/);
    expect(() =>
      parseChartData({
        type: 'pie',
        labels: ['a'],
        series: [
          { name: 'one', values: [1] },
          { name: 'two', values: [2] }
        ]
      })
    ).toThrow(/exactly one series/);
    expect(() =>
      parseChartData({
        type: 'pie',
        labels: ['a'],
        series: [{ name: 'one', values: [-1] }]
      })
    ).toThrow(/negative/);
    expect(() =>
      parseChartData({
        type: 'pie',
        labels: ['a'],
        series: [{ name: 'one', values: [0] }]
      })
    ).toThrow(/above zero/);
    expect(() =>
      parseChartData({
        type: 'bar',
        labels: ['a'],
        series: [{ name: 'one', values: [1] }],
        colors: ['url(https://example.com/x)']
      })
    ).toThrow(/URL reference/);
    expect(() =>
      parseChartData({
        type: 'bar',
        labels: ['a'],
        series: [{ name: 'one', values: [1] }],
        legend: 'yes'
      })
    ).toThrow(/legend must be a boolean/);
  });
});

describe('renderChartSvg', () => {
  it('is deterministic and escapes user text', () => {
    const first = renderChartSvg(BAR, 640, 360);
    const second = renderChartSvg(BAR, 640, 360);
    expect(first).toBe(second);
    expect(first).toContain('viewBox="0 0 640 360"');
    expect(first).toContain('<title>Revenue</title>');

    const escaped = renderChartSvg(
      {
        ...BAR,
        title: '<script>alert(1)</script>',
        labels: ['a&b', 'c<d', 'e>f']
      },
      640,
      360
    );
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
    expect(escaped).toContain('a&amp;b');
    expect(escaped).not.toContain('<d');
  });

  it('draws one bar per label and series with value-scaled heights', () => {
    const svg = renderChartSvg(
      {
        type: 'bar',
        labels: ['low', 'high'],
        series: [{ name: 'v', values: [1, 10] }],
        colors: ['#ff0000'],
        legend: false
      },
      640,
      360
    );
    const bars = Array.from(svg.matchAll(/<rect x="[^"]*" y="([^"]*)" width="[^"]*" height="([^"]*)" fill="#ff0000"/g));
    expect(bars).toHaveLength(2);
    expect(Number(bars[0]?.[2])).toBeLessThan(Number(bars[1]?.[2]));
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('low');
    expect(svg).toContain('high');
  });

  it('draws polylines and points for line charts', () => {
    const svg = renderChartSvg(
      {
        type: 'line',
        labels: ['a', 'b', 'c'],
        series: [
          { name: 'one', values: [1, 3, 2] },
          { name: 'two', values: [2, 1, 4] }
        ],
        legend: true,
        valueLabels: true
      },
      640,
      360
    );
    expect(svg.match(/<polyline /g)).toHaveLength(2);
    expect(svg.match(/<circle /g)).toHaveLength(6);
    expect(svg).toContain('>2</text>');
  });

  it('draws pie slices and percentage labels', () => {
    const svg = renderChartSvg(
      {
        type: 'pie',
        labels: ['A', 'B', 'C'],
        series: [{ name: 'share', values: [50, 30, 20] }],
        colors: ['#111111', '#222222', '#333333'],
        legend: true,
        valueLabels: true
      },
      640,
      360
    );
    expect(svg.match(/<path /g)).toHaveLength(3);
    expect(svg).toContain('50%');
    expect(svg).toContain('30%');
    expect(svg).toContain('20%');

    const single = renderChartSvg(
      {
        type: 'pie',
        labels: ['all'],
        series: [{ name: 'share', values: [5] }]
      },
      640,
      360
    );
    expect(single).toContain('<circle ');
    expect(single).not.toContain('<path ');
  });

  it('rejects sizes below the supported minimum', () => {
    expect(() => renderChartSvg(BAR, 100, 100)).toThrow(/160x120/);
  });
});

describe('insert and update', () => {
  it('inserts a chart figure with stored data and rendered svg', () => {
    const element = insertChart(slide(), {
      data: BAR,
      x: 100,
      y: 80,
      width: 800,
      height: 450
    });

    expect(element.tagName).toBe('FIGURE');
    expect(element.getAttribute('data-ppt-el')).toBe('e1');
    expect((element as HTMLElement).style.left).toBe('100px');
    expect((element as HTMLElement).style.width).toBe('800px');
    expect(element.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 800 450'
    );
    expect(chartDataOf(element)).toMatchObject({ type: 'bar', title: 'Revenue' });
    expect(function () {
      element.setAttribute('data-ppt-chart', 'not json');
      chartDataOf(element);
    }).toThrow(/not valid JSON/);
  });

  it('updates data and re-renders at the explicit size', () => {
    const element = insertChart(slide(), {
      data: BAR,
      x: 0,
      y: 0,
      width: 800,
      height: 450
    });

    updateChart(
      element,
      {
        type: 'pie',
        labels: ['A', 'B'],
        series: [{ name: 'share', values: [1, 3] }]
      },
      1000,
      500
    );

    expect(element.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 1000 500'
    );
    expect(element.querySelectorAll('path')).toHaveLength(2);
    expect(chartDataOf(element).type).toBe('pie');

    updateChart(element, BAR);
    expect(element.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 800 450'
    );
  });

  it('derives chart size from inline style, viewBox, or fallback', () => {
    const element = insertChart(slide(), {
      data: BAR,
      x: 0,
      y: 0,
      width: 800,
      height: 450
    });
    expect(chartSizeOf(element)).toEqual({ width: 800, height: 450 });

    (element as HTMLElement).style.width = '';
    (element as HTMLElement).style.height = '';
    expect(chartSizeOf(element)).toEqual({ width: 800, height: 450 });

    element.querySelector('svg')?.remove();
    expect(chartSizeOf(element)).toEqual({ width: 640, height: 360 });
  });
});
