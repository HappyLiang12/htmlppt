import { RUNTIME_SOURCE } from '@htmlppt/runtime';

export interface CreateDeckOptions {
  title?: string;
  slides?: number;
  width?: number;
  height?: number;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function slideCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 2;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : fallback;
}

export function createDeckHtml(options: CreateDeckOptions = {}): string {
  const title = options.title?.trim() || 'Untitled deck';
  const count = slideCount(options.slides);
  const width = finitePositive(options.width, 1600);
  const height = finitePositive(options.height, 900);
  const safeTitle = escapeHtml(title);

  const slides = Array.from({ length: count }, (_, index) => {
    const heading = index === 0 ? title : `${title} — ${index + 1}`;
    return `
    <section class="slide" data-slide-id="s${index + 1}" data-width="${width}" data-height="${height}">
      <div class="slide-inner">
        <p class="kicker">htmlppt</p>
        <h1 data-ppt-el="e${index + 1}">${escapeHtml(heading)}</h1>
      </div>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #0b0d12; }
  .slide { width: ${width}px; height: ${height}px; position: relative; overflow: hidden; background: #f7f5ef; color: #17181c; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .slide-inner { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 96px; }
  .kicker { margin: 0 0 18px; font-size: 22px; letter-spacing: .18em; text-transform: uppercase; color: #9a6b1f; }
  h1 { margin: 0; font-size: 96px; line-height: 1.05; max-width: 1200px; }
</style>
</head>
<body>
<main data-ppt-deck>${slides}
</main>
<script data-ppt-runtime="1">${RUNTIME_SOURCE}</script>
</body>
</html>
`;
}
