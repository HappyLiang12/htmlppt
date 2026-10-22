export interface IdFactory {
  slideId(existing: ReadonlySet<string>): string;
  elementId(existing: ReadonlySet<string>, slideIndex: number): string;
}

function smallestFree(prefix: string, existing: ReadonlySet<string>): string {
  let index = 1;
  while (existing.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

export const defaultIdFactory: IdFactory = {
  slideId: (existing) => smallestFree('s', existing),
  elementId: (existing) => smallestFree('e', existing)
};
