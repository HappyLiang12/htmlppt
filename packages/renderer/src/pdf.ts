import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';

export async function exactPdfPageSize(
  data: Uint8Array,
  width: number,
  height: number,
  pageCount: number
): Promise<Buffer> {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Canvas width and height must be finite positive numbers.');
  }
  const document = await PDFDocument.load(data, { updateMetadata: false });
  const pages = document.getPages();
  if (pages.length !== pageCount) {
    throw new Error(`Expected ${pageCount} PDF pages, found ${pages.length}.`);
  }
  const targetWidth = width * 72 / 96;
  const targetHeight = height * 72 / 96;
  for (const [index, page] of pages.entries()) {
    const current = page.getSize();
    if (![current.width, current.height].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error(`PDF page ${index + 1} has invalid dimensions.`);
    }
    page.setSize(targetWidth, targetHeight);
    page.scaleContent(targetWidth / current.width, targetHeight / current.height);
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}
