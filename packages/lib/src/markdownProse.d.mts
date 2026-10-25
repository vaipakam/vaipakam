/** Types for `markdownProse.mjs`, imported by the excision gate and its test. */

export interface ProseSegment {
  /** `prose` — rendered text of one leaf block; `literal` — code or unrendered
   *  raw text; `interior` — tag names and attributes, comments, destinations. */
  kind: 'prose' | 'literal' | 'interior';
  text: string;
  /** Source offset of every UTF-16 unit of `text`. */
  map: number[];
  /** What the gate fingerprints for a mention found here: the source
   *  `ranges` of the block itself, the `context` ranges that govern it (a
   *  table's header row, enclosing list items' own blocks), and the `start`
   *  its governing headings precede. */
  unit: { start: number; ranges: Array<[number, number]>; context: Array<[number, number]> };
}

export const BLOCK_TAGS: Set<string>;
export function alignOffsets(
  value: string,
  source: string,
  from: number,
  to: number,
  options?: { references?: 'markdown' | 'html' | 'html-attribute' | 'none'; fold?: boolean },
): number[];
export function readProse(
  source: string,
  format: 'markdown' | 'text',
): { segments: ProseSegment[]; headingChain(offset: number): string[] };
