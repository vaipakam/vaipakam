/**
 * #1486 — the CommonMark reading the docs path gate extracts citation sites
 * with. The gate's own fixtures (`.github/scripts/check-docs-paths.selftest.mjs`)
 * pin its verdicts end to end; these pin what the reader hands it.
 */
import { describe, expect, it } from 'vitest';
import { markdownCitations } from './markdownCitations.mjs';

const sites = (source: string) => markdownCitations(source).map(({ kind, value, line }) => `${kind}@${line}:${value}`);

describe('markdownCitations', () => {
  it('reads link, image and definition destinations as the parser resolves them', () => {
    expect(sites('[a](<x y.md> "t") ![i](img.png)\n\n[r]: <d e.md> \'t\'')).toEqual([
      'destination@1:x y.md',
      'destination@1:img.png',
      'destination@3:d e.md',
    ]);
  });

  it('decodes escapes and character references in a destination', () => {
    expect(sites('[a](a\\_b&amp;c.md)')).toEqual(['destination@1:a_b&c.md']);
  });

  it('reports a destination written on the line after its opener at the link', () => {
    expect(sites('see [a](\nx.md)')).toEqual(['destination@1:x.md']);
  });

  it('reads autolinks as destinations with their scheme', () => {
    expect(sites('<https://x.test/a> and www.x.test')).toEqual([
      'destination@1:https://x.test/a',
      'destination@1:http://www.x.test',
    ]);
  });

  it('reads a code span whole, and a link inside one as code', () => {
    expect(sites('`a/b` and `[x](y.md)`')).toEqual(['code-span@1:a/b', 'code-span@1:[x](y.md)']);
  });

  it('numbers each line of a fenced block from the line after its fence', () => {
    expect(sites('text\n\n~~~~bash\ncd a\n```\nls b\n~~~~')).toEqual([
      'code-line@4:cd a',
      'code-line@5:```',
      'code-line@6:ls b',
    ]);
  });

  it('numbers an indented block from its first line, and reads code inside a list', () => {
    expect(sites('para\n\n    one\n    two\n\n- item\n\n  ```\n  three\n  ```')).toEqual([
      'code-line@3:one',
      'code-line@4:two',
      'code-line@9:three',
    ]);
  });

  it('skips raw HTML, comments included', () => {
    expect(sites('<!-- [a](x.md) `y/z` -->\n\n<a href="w.md">w</a>')).toEqual([]);
  });

  it('reads a code span inside a table cell', () => {
    expect(sites('| a |\n| - |\n| `p/q` |')).toEqual(['code-span@3:p/q']);
  });
});
