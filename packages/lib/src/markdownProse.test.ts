/**
 * #1732 / #1758 — the reader the excision gate parses prose with. The gate's
 * own fixtures (`.github/scripts/check-excision-residue.selftest.mjs`) pin its
 * verdicts and digests end to end; these pin what the reader hands it:
 * which text is in which segment, where each character came from, which unit
 * a mention is fingerprinted by, and which headings govern it.
 */
import { describe, expect, it } from 'vitest';
import { alignOffsets, readProse } from './markdownProse.mjs';

const md = (source: string) => readProse(source, 'markdown');
const texts = (source: string, kind: string) =>
  md(source)
    .segments.filter((s) => s.kind === kind)
    .map((s) => s.text);

/** Every letter or digit in every segment maps to a source character that
 *  spells it, or to the `&` of the reference that produced it. */
function expectMapped(source: string) {
  for (const segment of md(source).segments) {
    expect(segment.map).toHaveLength(segment.text.length);
    for (let k = 0; k < segment.text.length; k++) {
      const c = segment.text[k];
      if (!/[A-Za-z0-9]/.test(c)) continue;
      const at = source[segment.map[k]];
      expect(at === '&' || at.toLowerCase() === c.toLowerCase(), `${JSON.stringify(c)} at ${k} of ${JSON.stringify(segment.text)}`).toBe(true);
    }
  }
}

describe('alignOffsets', () => {
  it('pairs equal characters and skips what the parser dropped', () => {
    const source = '> buy\n> adapter';
    expect(alignOffsets('buy\nadapter', source, 2, source.length)).toEqual([2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('maps a decoded reference and an escape to their own source', () => {
    const source = 'a&#111;\\*b';
    expect(alignOffsets('ao*b', source, 0, source.length)).toEqual([0, 1, 8, 9]);
  });

  it('does not read references in an undecoded value', () => {
    const source = 'x &amp; y';
    expect(alignOffsets('x &amp; y', source, 0, source.length, { decoded: false })).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps every offset inside the span when the value runs past it', () => {
    expect(alignOffsets('abz', 'ab', 0, 2)).toEqual([0, 1, 1]);
  });
});

describe('readProse — segments', () => {
  it('reads inline formatting and inline tags as the phrase they render', () => {
    expect(texts('The VPFI buy <strong>adapter</strong> is *gone*.\n', 'prose')).toEqual(['The VPFI buy adapter is gone.']);
  });

  it('keeps link destinations and tag attributes out of the rendered text', () => {
    const source = 'See [buy](https://x.test/a "t") and <span data-op="buyOptions">it</span>.\n';
    expect(texts(source, 'prose')).toEqual(['See buy and it.']);
    expect(texts(source, 'interior')).toEqual(['https://x.test/a', 't', 'span data-op buyOptions', 'span']);
  });

  it('reads an autolink once, as its visible text', () => {
    const source = 'Mail <ops@buy-adapter.test> or <https://x.test/buyOptions> or www.x.test/a.\n';
    expect(texts(source, 'prose')).toEqual(['Mail ops@buy-adapter.test or https://x.test/buyOptions or www.x.test/a.']);
    expect(texts(source, 'interior')).toEqual([]);
  });

  it('ends a segment at a block-level tag, not at an inline one', () => {
    expect(texts('one<hr>two<br>three<div-inline>four\n', 'prose')).toEqual(['one', 'twothreefour']);
  });

  it('reads two table cells and two paragraphs as separate blocks', () => {
    expect(texts('| a b | c |\n|---|---|\n| d | e |\n\nf\n\ng\n', 'prose')).toEqual(['a b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('reads code verbatim as literal text, with its info string hidden', () => {
    const source = '```sh title\n<b>x</b> &amp;\n```\n\n    indented\n';
    expect(texts(source, 'literal')).toEqual(['<b>x</b> &amp;', 'indented']);
    expect(texts(source, 'interior')).toEqual(['sh title']);
  });

  it('maps a fenced body to its own lines, not to an info string that repeats it', () => {
    const source = '```buyOptions\nbuyOptions\n```\n';
    const { segments } = md(source);
    const body = segments.find((s) => s.kind === 'literal')!;
    const info = segments.find((s) => s.kind === 'interior')!;
    expect(body.map[0]).toBe(source.indexOf('\nbuyOptions') + 1);
    expect(info.map[0]).toBe(3);
  });

  it('reads an inline script as its raw source, not as Markdown', () => {
    expect(texts('a<script>b&ThickSpace;c *d*</script>e\n', 'literal')).toEqual(['b&ThickSpace;c *d*']);
    expect(texts('a<script>b&ThickSpace;c *d*</script>e\n', 'prose')).toEqual(['ae']);
    expect(texts('a<script>left *open\n', 'literal')).toEqual(['left *open']);
  });

  it('keeps unrendered script text out of the prose, inline or in a block', () => {
    expect(texts('a<script>note</script>b\n', 'prose')).toEqual(['ab']);
    expect(texts('a<script>note</script>b\n', 'literal')).toEqual(['note']);
    expect(texts('<script>\nx<b>y\n</script>\n', 'literal')).toEqual(['\nx<b>y\n']);
  });

  it('decodes references the way each parser does', () => {
    expect(texts('a&ThickSpace;b &fjlig; &bogus;\n', 'prose')).toEqual(['a  b fj &bogus;']);
    expect(texts('<p>a&nbspb</p>\n', 'prose')).toEqual(['a b']);
  });

  it('maps every character back to the source that spells it', () => {
    expectMapped(
      [
        '# Head *one*',
        '',
        '> Quoted buy\n> adapter &#111;k \\*x',
        '',
        '- [x] item [link](https://u.test/p) ![alt text](i.png)',
        '  - nested `code &amp;`',
        '',
        '| c1 | c2 |',
        '|----|----|',
        '| v1 | v2 |',
        '',
        '<div class="k">Block &amp; text <em>em</em><!-- c &amp; amp --></div>',
        '',
        'Inline <!-- note &amp; amp --> comment.',
        '',
        '[ref]: https://d.test "Title"',
        '',
      ].join('\n'),
    );
  });
});

describe('readProse — units', () => {
  const unitText = (source: string, needle: string) => {
    const segment = md(source).segments.find((s) => s.text.includes(needle))!;
    return segment.unit.ranges.map(([from, to]) => source.slice(from, to)).join('|');
  };

  it('fingerprints a list item, task box included, without its nested list', () => {
    const source = '- [x] Retire it.\n  More text.\n  - nested one\n  - nested two\n';
    expect(unitText(source, 'Retire')).toBe('- [x] Retire it.\n  More text.');
    expect(unitText(source, 'nested two')).toBe('- nested two');
  });

  it('leaves out a nested list that sits between two of the item\'s own blocks', () => {
    const source = '- Parent first.\n  - child\n\n  Parent last.\n';
    expect(unitText(source, 'Parent first')).toBe('- Parent first.|Parent last.');
  });

  it('fingerprints a table row, not just its cell', () => {
    const source = '| a | b |\n|---|---|\n| name | Removed |\n';
    expect(unitText(source, 'name')).toBe('| name | Removed |');
  });

  it('fingerprints each paragraph of a quote on its own', () => {
    const source = '> first\n>\n> second\n';
    expect(unitText(source, 'second')).toBe('second');
  });
});

describe('readProse — headingChain', () => {
  const chainAt = (source: string, needle: string) => {
    const { segments, headingChain } = md(source);
    return headingChain(segments.find((s) => s.text.includes(needle))!.unit.start);
  };

  it('keeps each strictly shallower ancestor, up to a level-one heading', () => {
    const source = '# Top\n\n## A\n\n### Deep\n\n## B\n\n**Lead:** in\n\nmention\n';
    expect(chainAt(source, 'mention')).toEqual(['# Top', '## B', '**Lead:**']);
  });

  it('reads Setext headings at their level', () => {
    expect(chainAt('Title\n=====\n\nSub\n---\n\nmention\n', 'mention')).toEqual(['Title\n=====', 'Sub\n---']);
  });

  it('stops a heading governing when its quote or list item ends', () => {
    const source = '# Top\n\n> ## Quoted\n> inside\n\nafter\n';
    expect(chainAt(source, 'inside')).toEqual(['# Top', '## Quoted']);
    expect(chainAt(source, 'after')).toEqual(['# Top']);
  });

  it('ignores a heading-like line inside code', () => {
    expect(chainAt('## Real\n\n```\n# not a heading\n```\n\nmention\n', 'mention')).toEqual(['## Real']);
  });
});

describe('readProse — plain text', () => {
  it('splits paragraphs at blank lines and reads no markup', () => {
    const { segments, headingChain } = readProse('# not a heading\nbuy <b>x</b>\n\r\nnext\r\n', 'text');
    expect(segments.map((s) => s.text)).toEqual(['# not a heading\nbuy <b>x</b>\n', 'next\r\n']);
    expect(headingChain(segments[1].unit.start)).toEqual([]);
  });
});
