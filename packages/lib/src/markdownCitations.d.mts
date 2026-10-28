/** Types for `markdownCitations.mjs`, read by the docs path gate. */

export interface MarkdownCitation {
  /** `destination` — a link, image or definition destination; `code-span` —
   *  one inline code span; `code-line` — one line of a code block. */
  kind: 'destination' | 'code-span' | 'code-line';
  value: string;
  /** 1-based line the site starts on. */
  line: number;
}

export function markdownCitations(source: string): MarkdownCitation[];
