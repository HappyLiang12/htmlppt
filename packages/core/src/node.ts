import { parseHTML } from 'linkedom';

export function parseDeckHtml(html: string): Document {
  const { document } = parseHTML(html);
  return document as unknown as Document;
}
