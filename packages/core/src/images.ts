import { DeckMutationError } from './target.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const SUPPORTED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml'
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml'
};

const ACCEPTED = 'PNG, JPEG, GIF, WebP, AVIF, or SVG';

function fail(message: string): never {
  throw new DeckMutationError('invalid-image', message);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_MIMES.has(mime.trim().toLowerCase());
}

export function imageMimeFromFileName(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? MIME_BY_EXTENSION[extension] ?? null : null;
}

function dataUrlBytes(payload: string, base64: boolean): number {
  if (!base64) return payload.length;
  const clean = payload.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * Accepts a supported image data URL or an absolute http(s) URL. Local file
 * selection goes through `imageSourceFromFile`, which reuses this check.
 */
export function validateImageSource(source: string): string {
  const value = source.trim();
  if (!value) {
    fail(`Choose an image file or URL. Supported types: ${ACCEPTED}.`);
  }
  if (/^data:/i.test(value)) {
    const comma = value.indexOf(',');
    if (comma === -1) {
      fail('The image data URL is malformed.');
    }
    const meta = value.slice(5, comma);
    const parts = meta.split(';').map((part) => part.trim());
    const mime = (parts[0] ?? '').toLowerCase();
    const base64 = parts.some((part) => part.toLowerCase() === 'base64');
    if (!isSupportedImageMime(mime)) {
      fail(
        `Unsupported image type "${mime || 'unknown'}". Use ${ACCEPTED}.`
      );
    }
    const payload = value.slice(comma + 1);
    if (!payload) {
      fail('The image data URL is empty.');
    }
    const bytes = dataUrlBytes(payload, base64);
    if (bytes === 0) {
      fail('The image data URL is empty.');
    }
    if (bytes > MAX_IMAGE_BYTES) {
      fail(
        `The image is ${formatBytes(bytes)}; the limit is 8 MB. Resize or compress it before inserting.`
      );
    }
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(
      `Image sources must be a data URL, an absolute http(s) URL, or a supported local file (${ACCEPTED}).`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('Image URLs must use http: or https:.');
  }
  return value;
}

export function imageDataUrlFromBytes(
  bytes: Uint8Array,
  mime: string
): string {
  const normalized = mime.trim().toLowerCase();
  if (!isSupportedImageMime(normalized)) {
    fail(`Unsupported image type "${mime}". Use ${ACCEPTED}.`);
  }
  if (bytes.byteLength === 0) {
    fail('The image file is empty.');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    fail(
      `The image is ${formatBytes(bytes.byteLength)}; the limit is 8 MB. Resize or compress it before inserting.`
    );
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${normalized};base64,${btoa(binary)}`;
}

/** Reads a browser File into a validated image data URL. */
export async function imageSourceFromFile(file: File): Promise<string> {
  const declared = file.type.trim().toLowerCase();
  const mime = isSupportedImageMime(declared)
    ? declared
    : imageMimeFromFileName(file.name);
  if (!mime) {
    fail(
      `Unsupported image type "${file.type || file.name}". Use ${ACCEPTED}.`
    );
  }
  if (file.size === 0) {
    fail(`The image file "${file.name}" is empty.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    fail(
      `The image "${file.name}" is ${formatBytes(file.size)}; the limit is 8 MB. Resize or compress it before inserting.`
    );
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(
        reader.result instanceof ArrayBuffer
          ? reader.result
          : new ArrayBuffer(0)
      );
    reader.onerror = () =>
      reject(
        new DeckMutationError(
          'invalid-image',
          `Could not read "${file.name}". Re-select the file and try again.`
        )
      );
    reader.readAsArrayBuffer(file);
  });
  return imageDataUrlFromBytes(new Uint8Array(buffer), mime);
}
