import { detectSlides, readCanvasSize } from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import type { Page } from 'playwright-core';

export interface SlideCanvas {
  selector: string;
  id: string;
  width: number;
  height: number;
}

export async function prepareSlides(page: Page, fallback: { width: number; height: number }): Promise<SlideCanvas[]> {
  const parsed = parseDeckHtml(await page.content());
  const slides = detectSlides(parsed).map(slide => {
    const parts: string[] = [];
    let element = slide.element;
    while (element.parentElement) {
      const parent = element.parentElement;
      parts.unshift(`:nth-child(${Array.from(parent.children).indexOf(element) + 1})`);
      element = parent;
    }
    const copy = slide.element.cloneNode(false) as Element;
    copy.setAttribute('style', `width:${fallback.width}px;height:${fallback.height}px;${copy.getAttribute('style') ?? ''}`);
    const size = readCanvasSize(copy);
    return { selector: [':root', ...parts].join(' > '), id: slide.id, width: size.width, height: size.height };
  });

  await page.evaluate(canvases => {
    const elements = canvases.map(canvas => document.querySelector<HTMLElement>(canvas.selector)!);
    const style = document.createElement('style');
    style.textContent = '* , *::before, *::after { animation:none !important; transition:none !important; caret-color:transparent !important; }';
    document.head.append(style);
    const set = (element: HTMLElement, values: Record<string, string>) => {
      for (const [key, value] of Object.entries(values)) element.style.setProperty(key, value, 'important');
    };
    const reveal = (element: HTMLElement) => {
      const hidden = element.hidden || getComputedStyle(element).display === 'none';
      element.removeAttribute('hidden');
      if (hidden) element.classList.add('active');
      if (getComputedStyle(element).display !== 'none') return getComputedStyle(element).display;
      const removed: { style: CSSStyleDeclaration; value: string; priority: string }[] = [];
      const removeHiding = (style: CSSStyleDeclaration) => {
        if (style.getPropertyValue('display') !== 'none') return;
        removed.push({ style, value: 'none', priority: style.getPropertyPriority('display') });
        style.removeProperty('display');
      };
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && element.matches(rule.selectorText)) removeHiding(rule.style);
          if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
        }
      };
      removeHiding(element.style);
      for (const sheet of document.styleSheets) {
        try { visit(sheet.cssRules); } catch { /* Cross-origin stylesheets are opaque. */ }
      }
      const display = getComputedStyle(element).display;
      for (const saved of removed) saved.style.setProperty('display', saved.value, saved.priority);
      return display === 'none' ? 'block' : display;
    };
    const displays = elements.map(reveal);
    const ancestors = new Set<HTMLElement>();
    for (const element of elements) {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.add(parent);
    }
    for (const ancestor of ancestors) {
      set(ancestor, {
        display: 'block', position: 'static', transform: 'none', zoom: '1', overflow: 'visible',
        width: 'auto', height: 'auto', 'min-height': '0', 'max-height': 'none',
        margin: '0', padding: '0', border: '0', visibility: 'visible', opacity: '1', 'content-visibility': 'visible'
      });
      for (const child of ancestor.children) {
        if (child instanceof HTMLElement && !ancestors.has(child) && !elements.includes(child)) set(child, { display: 'none' });
      }
    }
    elements.forEach((element, index) => {
      set(element, {
        display: displays[index], position: 'relative', inset: 'auto', transform: 'none', zoom: '1',
        width: `${canvases[index].width}px`, height: `${canvases[index].height}px`,
        'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none',
        margin: '0', 'box-sizing': 'border-box', overflow: 'hidden', visibility: 'visible', opacity: '1',
        'content-visibility': 'visible', 'flex-shrink': '0', 'print-color-adjust': 'exact',
        'break-inside': 'avoid', 'break-before': 'auto', 'break-after': index === elements.length - 1 ? 'auto' : 'page'
      });
    });
    for (const image of document.images) image.loading = 'eager';
  }, slides);
  return slides;
}

export async function preparePrint(page: Page, slides: SlideCanvas[]): Promise<void> {
  await page.evaluate(canvases => {
    const first = canvases[0];
    const style = document.createElement('style');
    style.textContent = `@page { size:${first.width}px ${first.height}px; margin:0; }`;
    document.head.append(style);
    for (const canvas of canvases) {
      const element = document.querySelector<HTMLElement>(canvas.selector)!;
      element.style.setProperty('width', `${first.width}px`, 'important');
      element.style.setProperty('height', `${first.height}px`, 'important');
    }
  }, slides);
}

export async function isolateSlide(page: Page, slides: SlideCanvas[], index: number): Promise<void> {
  await page.setViewportSize({ width: Math.ceil(slides[index].width), height: Math.ceil(slides[index].height) });
  await page.evaluate(({ canvases, selected }) => {
    for (const [index, canvas] of canvases.entries()) {
      const element = document.querySelector<HTMLElement>(canvas.selector)!;
      if (!element.dataset.htmlpptRenderDisplay) element.dataset.htmlpptRenderDisplay = element.style.display;
      element.style.setProperty('display', index === selected ? element.dataset.htmlpptRenderDisplay : 'none', 'important');
      element.style.setProperty('break-after', 'auto', 'important');
    }
  }, { canvases: slides, selected: index });
}
