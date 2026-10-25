/**
 * Markdown and plain text, read as a reader sees them (#1732, #1758).
 *
 * Built for the excision gate (`.github/scripts/check-excision-residue.mjs`),
 * which asks one question of every prose file: does the text a reader sees
 * name the removed VPFI buy surface? Answering that needs two things a
 * line-based scanner can only approximate: which characters are RENDERED, and
 * which rendered characters sit in the SAME BLOCK. The gate used to answer
 * both with its own CommonMark subset (fences, code spans, link labels,
 * containers, Setext underlines, HTML tags), and every review round found
 * another construct it got wrong. #1732 and #1758 were the standing lists.
 * This module hands both questions to the standard parsers instead:
 *
 *   - Markdown: micromark through `mdast-util-from-markdown`, with GFM
 *     (tables, task lists, strikethrough, autolink literals, footnotes). It is
 *     the CommonMark reference implementation for JavaScript, so a construct
 *     the gate meets is read the way a CommonMark renderer reads it.
 *   - HTML inside Markdown: the parse5 TOKENIZER, the WHATWG HTML tokenizer.
 *     The tokenizer and not the tree builder, because the tree builder moves
 *     or drops tokens (a `<td>` outside a table loses its attributes), and
 *     the gate needs every tag and every attribute as written.
 *
 * WHAT IT RETURNS. A list of SEGMENTS. Each is a run of text plus, for every
 * UTF-16 unit of it, the source offset it came from, so a match found in the
 * text can be reported against the file. Text in one segment can be read as
 * one phrase; text in two segments never can. Three kinds:
 *
 *   - `prose`    — rendered text of ONE leaf block: a paragraph, a heading,
 *                  a single table cell, or the visible text of an HTML block
 *                  between two block-level elements. Inline formatting,
 *                  inline HTML tags and comments add nothing to it, so
 *                  `buy <strong>adapter</strong>` reads as the phrase it
 *                  renders. Inline code and image alt text are part of it,
 *                  because a reader sees them. A block-level HTML tag inside
 *                  a paragraph (`<hr>`, `<p>`, `<td>`) ends one segment and
 *                  starts the next.
 *   - `literal`  — code a reader sees verbatim: a fenced or indented code
 *                  block, and the raw text of HTML elements that are never
 *                  rendered as markup (`<script>`, `<style>`, `<template>`
 *                  and the other raw-text elements). One segment per block.
 *   - `interior` — text a reader does NOT see but that names things: each
 *                  HTML tag's name and attributes (one segment per tag),
 *                  each comment, processing instruction or declaration, each
 *                  link or image destination and title, a code block's info
 *                  string, a definition's label, destination and title, a
 *                  full reference's label, a footnote's label. Kept apart so
 *                  nothing in them fuses with rendered text.
 *
 * Each segment also carries its UNIT, the source ranges the gate fingerprints
 * when a mention is found in it: the nearest enclosing list item (its own
 * blocks, one range each, so a nested list or table between two of them is
 * left out), table row or footnote definition, or else the leaf block itself.
 * A list item and not its paragraph, because the item carries status the
 * paragraph does not (a task box `[x]`), and a table row and not its cell,
 * because the row's other cells say what the cell means. The unit's CONTEXT
 * is what governs it without being part of it: the header row of its table,
 * and the own blocks of every list item or footnote its item or table is
 * nested in. `headingChain(offset)` gives the headings that govern a
 * position: the nearest heading before it, then each strictly shallower one
 * before that, up to the first level-one heading. A paragraph that OPENS with
 * bold text (`**Planned:** …`) counts as a heading below level six, because
 * this repository writes sub-sections that way, and the whole paragraph is
 * that heading: the status after the label is what it says.
 *
 * Plain text (`format: 'text'`) has no markup: each run of non-blank lines is
 * one `prose` segment and its own unit, and nothing is a heading.
 *
 * WHAT IT DOES NOT DO. It does not decide what a match means; the gate does
 * (sentence punctuation inside a match, the identifier-only tokens, the
 * surviving-feature suffixes). It does not read MDX syntax: an `.mdx` file is
 * read as Markdown, which is how the gate always treated it. It does not
 * read front matter as metadata.
 *
 * Covered by `markdownProse.test.ts` beside this file.
 */
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { DecodingMode, EntityDecoder, htmlDecodeTree } from 'entities/decode';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference';
import { Tokenizer, TokenizerMode } from 'parse5';

/**
 * HTML elements that separate what a reader sees into different blocks.
 *
 * Every element the HTML standard's rendering section displays as a block, a
 * list item or a table part, matched by WHOLE name, so a custom element such
 * as `<div-inline>` (which renders inline) is not one. The gate kept a shorter
 * hand list that missed `menu` and the table parts, and matched names by
 * prefix (#1758). `<br>` is deliberately absent: a line break inside a
 * paragraph does not end the paragraph, so `buy<br>adapter` is still one
 * phrase.
 */
export const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center',
  'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li',
  'listing', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p',
  'plaintext', 'pre', 'search', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul', 'xmp',
]);

/**
 * Inline elements that render as a box of their own (form controls and
 * embedded content), so the text on either side of one is not one phrase:
 * `buy<textarea>hello</textarea>Options` shows two words with a text box
 * between them. Images are deliberately absent: an image's alt text stands
 * in for it inline, so `VPFI ![buy](x) adapter` reads as one phrase when the
 * image is not shown.
 */
const BOX_TAGS = new Set([
  'audio', 'button', 'canvas', 'embed', 'iframe', 'input', 'meter', 'object',
  'progress', 'select', 'textarea', 'video',
]);

/**
 * Elements whose content the HTML tokenizer reads as raw text, and the mode it
 * reads it in. The HTML tree builder switches the tokenizer into these modes
 * when it sees the start tag; a bare tokenizer has to be told, or the `<b>` in
 * `<script>a<b>c</script>` would be read as a tag.
 *
 * A `Map`, as every table keyed by a name from the document is: an object
 * literal would answer `<constructor>` with `Object`'s constructor.
 */
const RAW_TEXT_MODES = new Map([
  ['script', TokenizerMode.SCRIPT_DATA],
  ['style', TokenizerMode.RAWTEXT],
  ['xmp', TokenizerMode.RAWTEXT],
  ['iframe', TokenizerMode.RAWTEXT],
  ['noembed', TokenizerMode.RAWTEXT],
  ['noframes', TokenizerMode.RAWTEXT],
  ['noscript', TokenizerMode.RAWTEXT],
  ['textarea', TokenizerMode.RCDATA],
  ['title', TokenizerMode.RCDATA],
  ['plaintext', TokenizerMode.PLAINTEXT],
]);

/** Elements whose text is never shown as part of the page. Their text is a
 *  `literal` segment: scanned, but never fused with rendered prose. */
const HIDDEN_TEXT = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'noembed', 'noframes']);

/** Containers whose own blocks are one unit, and what governs the units
 *  nested in them (see `ownRanges` and `governing`). */
const ITEMS = new Set(['listItem', 'footnoteDefinition']);

/** Blocks that carry their own units, so are not part of an enclosing
 *  item's: each list item, and each table row. */
const CARRIES_UNITS = new Set(['list', 'table']);

/**
 * A character reference as CommonMark spells it: always closed by `;`, with a
 * bounded number of digits or name characters.
 */
const MARKDOWN_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/y;

/**
 * The reference starting at `source[i]` (an `&`) as the given grammar reads
 * it — `{ text, length }`, or `null` if that grammar reads no reference there.
 *
 * Each grammar is decoded by the decoder its own parser uses, never by a
 * restatement of it: micromark's for Markdown, and for HTML the `entities`
 * decoder parse5 drives, in the mode parse5 drives it in (`html` for text,
 * `html-attribute` for attribute values). The two grammars differ in ways a
 * restatement had already got wrong: HTML decodes a legacy name without its
 * semicolon (`&nbsp buy`, `&notit;` as `&not` + `it;`), a numeric reference
 * without one, and C1 code points through the Windows-1252 table; Markdown
 * does none of these.
 */
const htmlReference = (() => {
  let text = '';
  const decoder = new EntityDecoder(htmlDecodeTree, (cp) => {
    text += String.fromCodePoint(cp);
  });
  return (source, i, to, mode) => {
    text = '';
    decoder.startEntity(mode);
    const span = source.slice(i, to);
    let length = decoder.write(span, 1);
    if (length < 0) length = decoder.end();
    return length > 0 ? { text, length } : null;
  };
})();

function readReference(grammar, source, i, to) {
  if (grammar === 'html') return htmlReference(source, i, to, DecodingMode.Legacy);
  if (grammar === 'html-attribute') return htmlReference(source, i, to, DecodingMode.Attribute);
  MARKDOWN_REFERENCE.lastIndex = i;
  const m = MARKDOWN_REFERENCE.exec(source);
  if (!m || i + m[0].length > to) return null;
  const [, dec, hex, name] = m;
  if (name !== undefined) {
    const text = decodeNamedCharacterReference(name);
    return text === false ? null : { text, length: m[0].length };
  }
  const text = decodeNumericCharacterReference(dec ?? hex, dec !== undefined ? 10 : 16);
  return { text, length: m[0].length };
}

/**
 * Source offset of every unit of `value`, a parser's reading of
 * `source.slice(from, to)`.
 *
 * Parsers report a position for a whole node, not for each character of its
 * value, and the value differs from its source: container prefixes (`> `,
 * list indentation) and delimiters are gone, backslash escapes and character
 * references are resolved, tabs are expanded and line endings normalized.
 * This walks both in step. Equal characters pair up; a character reference
 * pairs the text it decodes to with its own offset; a Markdown escape pairs
 * the escaped character with its own; a character the parser rewrote (a tab
 * as spaces, CR as LF, NUL as U+FFFD) pairs with the one it replaced; any
 * other source character is something the parser dropped and is skipped.
 *
 * `references` names the grammar the parser resolved references by:
 * `'markdown'` (the default; escapes too), `'html'` (text), `'html-attribute'`
 * (attribute values), or `'none'` for code and raw text, which are NOT
 * decoded — `&amp;` in a code block is five characters of value, and reading
 * it as one reference would push every later character out of step.
 *
 * `fold` compares without case, for HTML tag and attribute names, which the
 * tokenizer lower-cases.
 *
 * The result is exact for everything the gate meets. Where it cannot be (a
 * value character with no source counterpart), that one character is
 * assigned to where the walk last paired, and the walk resumes from there, so
 * one unpaired character costs only its own offset: it cannot push the rest
 * of the value to the end of the node and merge distinct mentions into one.
 */
export function alignOffsets(value, source, from, to, { references = 'markdown', fold = false } = {}) {
  const out = new Array(value.length);
  let i = from;
  let j = 0;
  // Where the walk resumes if value[j] has no counterpart: just past the last
  // source character that paired.
  let resume = from;
  const same = (a, b) => a === b || (fold && a.toLowerCase() === b.toLowerCase());
  while (j < value.length) {
    if (i >= to) {
      out[j++] = Math.max(from, Math.min(resume, to - 1));
      i = resume;
      continue;
    }
    const s = source[i];
    if (references !== 'none' && s === '&') {
      const ref = readReference(references, source, i, to);
      if (ref && value.startsWith(ref.text, j)) {
        for (let k = 0; k < ref.text.length; k++) out[j++] = i;
        i += ref.length;
        resume = i;
        continue;
      }
    }
    if (same(value[j], s)) {
      out[j++] = i++;
      resume = i;
      continue;
    }
    // Characters the parser itself rewrote, paired with what they came from.
    // A tab it expanded to spaces (micromark, to the next tab stop of 4, less
    // any indentation it removed): each of up to four spaces pairs with the
    // tab. A line ending it normalized to LF (parse5's preprocessor turns CR
    // and CR LF into LF). A NUL it replaced with U+FFFD (both parsers).
    // Without these, the walk searched ahead for the rewritten character and
    // paired the text after it with a later, unrelated stretch of the node.
    if (s === '\t' && value[j] === ' ') {
      for (let n = 0; n < 4 && value[j] === ' '; n++) out[j++] = i;
      resume = ++i;
      continue;
    }
    if (s === '\r' && value[j] === '\n') {
      const crlf = i + 1 < to && source[i + 1] === '\n';
      out[j++] = crlf ? i + 1 : i;
      i += crlf ? 2 : 1;
      resume = i;
      continue;
    }
    if (s === '\0' && value[j] === '\uFFFD') {
      out[j++] = i++;
      resume = i;
      continue;
    }
    if (references === 'markdown' && s === '\\' && i + 1 < to && value[j] === source[i + 1]) {
      out[j++] = i + 1;
      i += 2;
      resume = i;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Collects one leaf block's segments.
 *
 * Prose accumulates until something ends it (a block-level HTML tag, or the
 * end of the block). Literal and interior text become their own segments as
 * they arrive.
 */
class BlockSink {
  constructor(unit, segments) {
    this.unit = unit;
    this.segments = segments;
    this.text = '';
    this.map = [];
    // Open elements whose text is never shown (see HIDDEN_TEXT). Kept on the
    // block, not per HTML fragment, because inside a paragraph each inline
    // tag is its own fragment: in `buy<script>note</script>adapter` the
    // text `note` arrives BETWEEN two fragments, and is still inside the
    // script for a browser.
    this.hidden = [];
  }

  /** Text a reader would see unless an open hidden element holds it. */
  prose(text, map) {
    if (this.hidden.length) {
      this.emit('literal', text, map);
      return;
    }
    this.text += text;
    for (const o of map) this.map.push(o);
  }

  breakProse() {
    if (this.text) this.segments.push({ kind: 'prose', text: this.text, map: this.map, unit: this.unit });
    this.text = '';
    this.map = [];
  }

  emit(kind, text, map) {
    if (text) this.segments.push({ kind, text, map, unit: this.unit });
  }

  close() {
    this.breakProse();
  }
}

/**
 * Tokenize an HTML fragment and route what it contains into `sink`.
 *
 * `toFile(k)` turns an offset into `html` into a file offset. `startIn`, if
 * given, is a raw-text element `html` starts inside of (its opening tag was
 * an earlier fragment): the tokenizer starts in that element's mode.
 *
 * Returns `left`, the raw-text element still open at the end of `html` (or
 * null), and `closed`, whether the `startIn` element's end tag was reached.
 */
function readHtml(html, toFile, sink, startIn = null) {
  // Character tokens arrive in small pieces (the tokenizer splits on
  // whitespace and references), and the location it reports for a piece next
  // to a reference can be off by the reference's length. Pieces are therefore
  // pooled until the next non-character token and aligned as one run against
  // the whole source span they cover, which is exact.
  let run = null;
  // Whether the current raw-text element's content is undecoded (script,
  // style: yes; textarea, title: no, those are RCDATA and decode references).
  const { hidden } = sink;
  let rawUndecoded = false;
  // The raw-text element the tokenizer is inside of, or null.
  let rawTag = null;
  let closed = false;
  const enterRaw = (tag, tokenizer) => {
    const mode = RAW_TEXT_MODES.get(tag);
    tokenizer.state = mode;
    tokenizer.lastStartTagName = tag;
    rawTag = tag;
    rawUndecoded = mode === TokenizerMode.SCRIPT_DATA || mode === TokenizerMode.RAWTEXT || mode === TokenizerMode.PLAINTEXT;
  };
  const flush = () => {
    if (!run) return;
    const map = alignOffsets(run.chars, html, run.start, run.end, { references: rawUndecoded ? 'none' : 'html' }).map(toFile);
    sink.prose(run.chars, map);
    run = null;
  };
  const onChars = (t) => {
    const { startOffset, endOffset } = t.location;
    if (!run) run = { chars: t.chars, start: startOffset, end: endOffset };
    else {
      run.chars += t.chars;
      run.start = Math.min(run.start, startOffset);
      run.end = Math.max(run.end, endOffset);
    }
  };
  /**
   * One `interior` segment from [value, start, end, fold, references]
   * pieces. Names fold case (the tokenizer lower-cases them) and hold no
   * references; attribute values are decoded as attribute values; comment
   * and doctype text is not decoded.
   */
  const interior = (pieces) => {
    let text = '';
    const map = [];
    for (const [value, start, end, fold, references] of pieces) {
      if (!value) continue;
      if (text) {
        // A separator between pieces, mapped to the next piece's start, so
        // `data-a="buy" data-b="adapter"` does not read as one name.
        text += ' ';
        map.push(toFile(start));
      }
      text += value;
      for (const o of alignOffsets(value, html, start, end, { fold, references })) map.push(toFile(o));
    }
    sink.emit('interior', text, map);
  };
  const tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onCharacter: onChars,
      onWhitespaceCharacter: onChars,
      onNullCharacter: onChars,
      onStartTag(t) {
        flush();
        const loc = t.location;
        const pieces = [[t.tagName, loc.startOffset, loc.endOffset, true, 'none']];
        for (const a of t.attrs) {
          const at = loc.attrs?.[a.name];
          const [s, e] = at ? [at.startOffset, at.endOffset] : [loc.startOffset, loc.endOffset];
          pieces.push([a.name, s, e, true, 'none']);
          // The value is aligned against the same span, after the name.
          pieces.push([a.value, s + a.name.length, e, false, 'html-attribute']);
        }
        interior(pieces);
        if (BLOCK_TAGS.has(t.tagName) || BOX_TAGS.has(t.tagName)) sink.breakProse();
        // Not `t.selfClosing`: HTML ignores the self-closing flag on an
        // element that is not void, so `<script/>` opens a script whose text
        // runs to `</script>`, as `<script>` does. Every element in these
        // two tables is non-void.
        if (HIDDEN_TEXT.has(t.tagName)) hidden.push(t.tagName);
        if (RAW_TEXT_MODES.has(t.tagName)) enterRaw(t.tagName, tokenizer);
      },
      onEndTag(t) {
        flush();
        rawUndecoded = false;
        // Inside raw text the tokenizer emits only the element's own end
        // tag, so an end tag met there is the one that closes it.
        if (startIn && rawTag === startIn) closed = true;
        rawTag = null;
        interior([[t.tagName, t.location.startOffset, t.location.endOffset, true, 'none']]);
        if (BLOCK_TAGS.has(t.tagName) || BOX_TAGS.has(t.tagName)) sink.breakProse();
        const at = hidden.lastIndexOf(t.tagName);
        if (at !== -1) hidden.length = at;
      },
      onComment(t) {
        // Comments, and everything the HTML tokenizer reads as a bogus
        // comment: processing instructions, CDATA outside foreign content,
        // `<!…>` declarations other than DOCTYPE.
        flush();
        interior([[t.data, t.location.startOffset, t.location.endOffset, false, 'none']]);
      },
      onDoctype(t) {
        flush();
        const { startOffset, endOffset } = t.location;
        interior(
          [t.name, t.publicId, t.systemId]
            .filter((v) => v)
            .map((v) => [v, startOffset, endOffset, true, 'none']),
        );
      },
      onEof() {
        flush();
      },
    },
  );
  if (startIn) {
    enterRaw(startIn, tokenizer);
    if (HIDDEN_TEXT.has(startIn)) hidden.push(startIn);
  }
  tokenizer.write(html, true);
  return { left: rawTag, closed };
}

/**
 * Read a Markdown document. See the module header for what comes back.
 */
/** A sink that keeps nothing, for asking the tokenizer a question. */
const probeSink = () => ({ hidden: [], prose() {}, emit() {}, breakProse() {} });

/**
 * RAW-TEXT REGIONS: where a raw-text element (see RAW_TEXT_MODES) that an
 * html node opens without closing is still open, in the rendered page.
 *
 * Markdown renders everything else as text or escaped markup, so only an
 * html node, inline or block, can close the element, and it closes it where
 * the HTML tokenizer, started in the element's mode, meets its end tag. The
 * element can outlast its paragraph: in
 * `prefix<textarea>start` / blank line / `buy*Options*` / blank line /
 * `</textarea>suffix` the middle paragraph is textarea content to a browser,
 * not emphasis. So the html nodes are walked in document order and each is
 * asked, of the same tokenizer the reader uses, whether it leaves such an
 * element open. A region runs from the end of the node that opened it to the
 * start of the node that closes it, or to the end of the document.
 *
 * Returns the regions, by the offset their opener ends at and by the offset
 * their closer starts at.
 */
function rawTextRegions(tree) {
  const nodes = [];
  const visit = (node) => {
    if (node.type === 'html') nodes.push(node);
    if (node.children) node.children.forEach(visit);
  };
  visit(tree);
  const list = [];
  const openers = new Map();
  const closers = new Map();
  let open = null;
  for (const node of nodes) {
    const [s, e] = span(node);
    if (open && s < open.from) continue;
    const startIn = open ? open.tag : null;
    const { left, closed } = readHtml(node.value, () => 0, probeSink(), startIn);
    if (open && !closed) continue;
    if (open) {
      open.to = s;
      closers.set(s, open.tag);
      open = null;
    }
    if (left) {
      open = { tag: left, from: e, to: Infinity };
      list.push(open);
      openers.set(e, open);
    }
  }
  return { list, openers, closers };
}

/** The source span of an mdast node. */
const span = (node) => [node.position.start.offset, node.position.end.offset];

function readMarkdown(source) {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const segments = [];
  const headings = [];

  /** A value read from `node`'s source span, as file offsets. */
  const aligned = (value, from, to, opts) => alignOffsets(value, source, from, to, opts);

  const regions = rawTextRegions(tree);
  /** The raw-text region `offset` is inside of, or undefined. */
  const insideRaw = (offset) => regions.list.find((r) => r.from <= offset && offset < r.to);

  /**
   * Read an html node (block or inline) into `sink`: started inside the
   * raw-text element it closes, if it closes one; and if it opens one, the
   * element's content after it is read too, as its own segments under the
   * same unit. The opener's sink does not stay inside the element: the
   * Markdown that follows the closing tag is outside it.
   */
  const html = (node, sink) => {
    const [s, e] = span(node);
    const local = aligned(node.value, s, e, { references: 'none' });
    readHtml(node.value, (k) => local[Math.min(k, local.length - 1)] ?? s, sink, regions.closers.get(s) ?? null);
    const region = regions.openers.get(e);
    if (!region) return;
    const at = sink.hidden.lastIndexOf(region.tag);
    if (at !== -1) sink.hidden.length = at;
    const inner = new BlockSink(sink.unit, segments);
    readHtml(source.slice(region.from, region.to), (k) => region.from + k, inner, region.tag);
    inner.close();
  };

  const phrasing = (node, sink) => {
    // Inside a raw-text element, every node micromark made of its content
    // is skipped: the content was read as HTML at the opening tag. A node
    // that starts inside and runs past the closing tag (`*a</textarea>b*`)
    // is entered, for the part after.
    const [s, e] = span(node);
    const region = insideRaw(s);
    if (region) {
      if (node.children && e > region.to) for (const child of node.children) phrasing(child, sink);
      return;
    }
    switch (node.type) {
      case 'text': {
        const [s, e] = span(node);
        sink.prose(node.value, aligned(node.value, s, e));
        return;
      }
      case 'inlineCode': {
        const [s, e] = span(node);
        sink.prose(node.value, aligned(node.value, s, e, { references: 'none' }));
        return;
      }
      case 'break':
        sink.prose('\n', [node.position.start.offset]);
        return;
      case 'html':
        html(node, sink);
        return;
      case 'image':
      case 'imageReference': {
        const [s, e] = span(node);
        const alt = node.alt ?? '';
        const altMap = aligned(alt, s, e);
        sink.prose(alt, altMap);
        // Destination and title come after the alt text in the source.
        const after = altMap.length ? altMap[altMap.length - 1] + 1 : s;
        destination(node, after, e, sink);
        return;
      }
      case 'link':
      case 'linkReference': {
        for (const child of node.children) phrasing(child, sink);
        const [s, e] = span(node);
        const last = node.children[node.children.length - 1];
        destination(node, last ? last.position.end.offset : s, e, sink);
        return;
      }
      case 'footnoteReference':
        // Rendered as a visible marker (a superscript number) this reader
        // cannot reproduce, so the words on either side are not one phrase:
        // `buy[^n]Options` reads `buy¹Options`. The label is scanned on its
        // own.
        sink.breakProse();
        sink.emit('interior', node.label ?? '', aligned(node.label ?? '', s, e));
        return;
      default:
        if (node.children) for (const child of node.children) phrasing(child, sink);
        else if (typeof node.value === 'string') {
          const [s, e] = span(node);
          sink.prose(node.value, aligned(node.value, s, e));
        }
    }
  };

  /** A link's or image's hidden parts: destination, title, and the label of a
   *  FULL reference (`[text][label]`). A collapsed or shortcut reference's
   *  label IS its visible text, so it is not read twice. */
  const destination = (node, from, to, sink) => {
    // An AUTOLINK (`<https://…>`, `<a@b.c>`, or a GFM `www.…` literal) has no
    // destination of its own: its URL is its visible text, sometimes with a
    // `mailto:` or `http://` added. Reading it again would count one mention
    // twice. Only a link written with brackets starts with `[`.
    if (node.type === 'link' && source[node.position.start.offset] !== '[') return;
    let at = from;
    const parts = [];
    if (node.referenceType === 'full' && node.label) parts.push(node.label);
    if (node.url) parts.push(node.url);
    if (node.title) parts.push(node.title);
    for (const value of parts) {
      const map = aligned(value, at, to);
      sink.emit('interior', value, map);
      if (map.length) at = map[map.length - 1] + 1;
    }
  };

  /**
   * A list item's or footnote definition's OWN blocks, NOT the lists and
   * tables in it. Those carry their own units (each item, each row), and
   * folding fifty sub-items or rows into one parent's fingerprint would move
   * it on every edit to any of them. So these are the item's own blocks, one
   * range each, with any list or table between two of them left out; the
   * first starts at the item itself, so its marker and task box are in it.
   */
  const ownRanges = (container) => {
    const ranges = container.children.filter((c) => !CARRIES_UNITS.has(c.type)).map(span);
    if (ranges.length) ranges[0] = [container.position.start.offset, ranges[0][1]];
    return ranges;
  };

  /**
   * The context a block that carries its own units (a list item, a
   * footnote, a table) takes from where it sits: inside a list item or
   * footnote, that item's own blocks govern it, as a lead-in governs what
   * follows it, whatever is between (a blank line, a quote).
   */
  const governing = (container, context) =>
    container && ITEMS.has(container.type) ? [...context, ...ownRanges(container)] : context;

  /**
   * The unit for a leaf block, given the nearest enclosing container and the
   * `context` that governs it: a `start` (where governing headings are looked
   * up from), the source `ranges` the block itself covers, and the `context`
   * ranges, passed through.
   */
  const unitFor = (leaf, container, context) => {
    const [s, e] = span(leaf);
    if (!container) return { start: s, ranges: [[s, e]], context };
    if (container.type === 'tableRow') {
      const row = span(container);
      return { start: row[0], ranges: [row], context };
    }
    const ranges = ownRanges(container);
    return { start: container.position.start.offset, ranges: ranges.length ? ranges : [[s, e]], context };
  };

  const leaf = (node, container, context, read) => {
    const sink = new BlockSink(unitFor(node, container, context), segments);
    read(sink);
    sink.close();
  };

  /**
   * `scopeEnd` is where a heading met here stops governing: the end of the
   * nearest enclosing block quote, list item or footnote. A heading inside a
   * quote titles the quote, not the prose after it (#1758), so retitling
   * `> ## Historical note` must not move the fingerprint of a paragraph
   * below the quote.
   *
   * `context` is what governs the block without being part of it, other than
   * headings: the header row of the table a row is in, and the own blocks of
   * every list item or footnote a nested list is in. A data row reads under
   * its column headers, and a nested item under its parent's lead-in, so
   * turning `| Contract | Removed |` into `| Contract | Currently deployed |`,
   * or `- Removed contracts:` into `- Live contracts:`, rewords every mention
   * beneath it as surely as retitling a heading does, and moves the digest
   * the same way.
   */
  const block = (node, container, scopeEnd, context) => {
    // A block that starts inside a raw-text element is that element's
    // content, not Markdown: it is not a heading, and a leaf of it is not
    // read. One that runs past the closing tag (the paragraph holding
    // `</textarea>suffix`) is read, and its phrasing skips the part inside.
    const [ns, ne] = span(node);
    const region = node.type === 'root' ? undefined : insideRaw(ns);
    if (region && (ne <= region.to || !node.children)) return;
    const inRaw = region !== undefined;
    switch (node.type) {
      case 'heading': {
        const [s, e] = span(node);
        if (!inRaw) headings.push({ offset: s, scopeEnd, level: node.depth, raw: source.slice(s, e) });
        leaf(node, container, context, (sink) => node.children.forEach((c) => phrasing(c, sink)));
        return;
      }
      case 'paragraph': {
        const first = node.children[0];
        if (!inRaw && first && first.type === 'strong' && first.position.start.offset === node.position.start.offset) {
          // The whole paragraph, not just its bold label: in
          // `**Status:** These contracts were removed.` the status is the
          // sentence after the label, and it governs what follows as much
          // as the label does.
          const [s, e] = span(node);
          headings.push({ offset: s, scopeEnd, level: 7, raw: source.slice(s, e) });
        }
        leaf(node, container, context, (sink) => node.children.forEach((c) => phrasing(c, sink)));
        return;
      }
      case 'tableCell':
        leaf(node, container, context, (sink) => node.children.forEach((c) => phrasing(c, sink)));
        return;
      case 'code': {
        const [s, e] = span(node);
        // A FENCED block's body starts on the line after its opening fence,
        // and its info string is on that line. Each is read against its own
        // range: read against the whole block, a body that repeats the info
        // string (```buyOptions / buyOptions) mapped onto the fence line, and
        // two mentions merged into one.
        const fenced = /^ {0,3}(?:`{3,}|~{3,})/.test(source.slice(s, e));
        const firstLineEnd = fenced ? source.slice(s, e).search(/\r\n|\r|\n|$/) + s : s;
        const bodyFrom = fenced ? Math.min(e, firstLineEnd + (source.startsWith('\r\n', firstLineEnd) ? 2 : 1)) : s;
        leaf(node, container, context, (sink) => {
          sink.emit('literal', node.value, aligned(node.value, bodyFrom, e, { references: 'none' }));
          const info = [node.lang, node.meta].filter((v) => v).join(' ');
          if (info) sink.emit('interior', info, aligned(info, s, firstLineEnd));
        });
        return;
      }
      case 'html':
        leaf(node, container, context, (sink) => html(node, sink));
        return;
      case 'definition': {
        const [s, e] = span(node);
        leaf(node, container, context, (sink) => {
          let at = s;
          for (const value of [node.label, node.url, node.title]) {
            if (!value) continue;
            const map = aligned(value, at, e);
            sink.emit('interior', value, map);
            if (map.length) at = map[map.length - 1] + 1;
          }
        });
        return;
      }
      case 'footnoteDefinition': {
        const [s, e] = span(node);
        const own = governing(container, context);
        leaf(node, node, own, (sink) => sink.emit('interior', node.label ?? '', aligned(node.label ?? '', s, e)));
        for (const child of node.children) block(child, node, e, own);
        return;
      }
      case 'listItem': {
        const own = governing(container, context);
        for (const child of node.children) block(child, node, node.position.end.offset, own);
        return;
      }
      case 'table': {
        // The first row is the header; it governs every row after it.
        const own = governing(container, context);
        const [header, ...rows] = node.children;
        if (header) block(header, container, scopeEnd, own);
        const governed = header ? [...own, span(header)] : own;
        for (const row of rows) block(row, container, scopeEnd, governed);
        return;
      }
      case 'tableRow':
        for (const child of node.children) block(child, node, scopeEnd, context);
        return;
      case 'blockquote':
        // A scope for headings, NOT a unit: a quoted banner can run to many
        // paragraphs, and each is its own.
        for (const child of node.children) block(child, container, node.position.end.offset, context);
        return;
      default:
        // root, list, and anything a later extension adds: structure only,
        // read through.
        if (node.children) for (const child of node.children) block(child, container, scopeEnd, context);
    }
  };

  block(tree, null, Infinity, []);
  return { segments, headings };
}

/** Plain text: each run of non-blank lines is one prose segment and unit. */
function readText(source) {
  const segments = [];
  const re = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let start = -1;
  let end = -1;
  const close = () => {
    if (start === -1) return;
    const text = source.slice(start, end);
    const map = Array.from({ length: text.length }, (_, k) => start + k);
    const unit = { start, ranges: [[start, end]], context: [] };
    segments.push({ kind: 'prose', text, map, unit });
    start = -1;
  };
  let m;
  while ((m = re.exec(source)) && m[0] !== '') {
    const line = m[0];
    if (line.trim() === '') close();
    else {
      if (start === -1) start = m.index;
      end = m.index + line.length;
    }
  }
  close();
  return { segments, headings: [] };
}

/**
 * Read a prose document.
 *
 * @param {string} source
 * @param {'markdown' | 'text'} format
 */
export function readProse(source, format) {
  const { segments, headings } = format === 'markdown' ? readMarkdown(source) : readText(source);
  /** Headings governing `offset`, outermost first. */
  const headingChain = (offset) => {
    const chain = [];
    let deepest = Infinity;
    for (let k = headings.length - 1; k >= 0; k--) {
      const h = headings[k];
      if (h.offset >= offset || h.scopeEnd <= offset || h.level >= deepest) continue;
      deepest = h.level;
      chain.push(h.raw);
      if (h.level === 1) break;
    }
    return chain.reverse();
  };
  return { segments, headingChain };
}
