#!/usr/bin/env node
/**
 * Regression fixtures for the excision-residue gate.
 *
 * WHY THIS EXISTS. Every round of review on this checker has followed the same
 * shape: a fix for one false negative introduces a false positive, or silences
 * a neighbouring construct. A tag strip that invented matches, a `tagSpans`
 * reuse that switched off attribute scanning, a binary-format exemption that
 * swallowed PDFs, a link-destination skip that deleted three real pinned
 * mentions — each was caught by a reviewer, one round later, because the only
 * verification was ad-hoc fixtures re-typed by hand each time.
 *
 * These are those fixtures, committed. Each records a case that was WRONG at
 * some point and the direction it must fall. A change that re-breaks one is a
 * failing command rather than a finding in the next review.
 *
 * HOW IT WORKS. The checker reads `git ls-files`, so fixtures are staged in a
 * scratch directory inside the repo, the checker is run, and the staging is
 * undone. Nothing is committed and the index is restored even on failure.
 *
 * Run: `node .github/scripts/check-excision-residue.selftest.mjs`
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateRawSync, deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
// Unique per run. A FIXED path is reused if a developer already has a
// directory of that name, and the cleanup below then deletes their files —
// reported against the first version of this script, reproduced with a
// `developer-notes.txt` that the run silently removed.
const DIR = `__excision_selftest__${process.pid}_${Date.now().toString(36)}`;

/** `caught: true` — the gate MUST report this file. `false` — must stay silent. */
const FIXTURES = [
  // --- rendered markup must fuse the words a reader sees as one phrase ---
  {
    name: 'inline-tag.md',
    caught: true,
    why: 'inline formatting splits a phrase the reader sees continuously',
    body: 'Operators must deploy the VPFI buy <strong>adapter</strong> before cutover.\n',
  },
  {
    name: 'attr-with-gt.md',
    caught: true,
    why: 'a quoted attribute containing > must not end the tag for the boundary pass',
    body: 'deploy the buy<span title="1 > 0: yes"> adapter</span> now.\n',
  },
  {
    // Round 7 P1. Every emitted character of an autolink used to map to the
    // opening `<`, so `isIdentifierSpan` was handed a one-character span
    // containing a bracket, decided it was not an identifier, and dropped the
    // match — a dead name written inside a URL passed the gate silently.
    name: 'autolink-identifier.md',
    caught: true,
    why: 'a dead name inside an autolink URL is visible text and must be caught',
    body: 'See <https://example.com/buyOptions> for the retired getter.\n',
  },
  {
    // Round 7 P2. Recognition used to test only the first 2048 characters, so
    // a longer autolink lost its closing `>`, fell through to the tag scanner,
    // and had its visible URL stripped — fusing the words either side back
    // into a false mention on a blocking gate.
    name: 'autolink-long.md',
    caught: false,
    why: 'a long autolink still separates the words either side of it',
    body:
      'deploy the buy<https://example.com/?q=' +
      'x'.repeat(2050) +
      '>Adapter now.\n',
  },
  {
    // Round 9 P2. An angle-bracket run containing whitespace is neither an
    // autolink nor an HTML tag — it is literal visible text. The loose
    // "starts with a letter" test stripped it anyway, fusing the words either
    // side into a mention and BLOCKING a clean file.
    name: 'angle-run-not-a-tag.md',
    caught: false,
    why: 'a bracketed run with whitespace is visible text, not markup to strip',
    body:
      'Decide what to buy<https://example.com some-label>Adapter selection ' +
      'follows.\n',
  },
  {
    // Round 9 P2 (the other one). 100k unterminated `](` used to walk the rest
    // of the file per candidate; this fixture is the shape, kept small enough
    // to stay a fast unit test. Correctness assertion only — the timing claim
    // is measured separately.
    name: 'dest-openers-unterminated.md',
    caught: false,
    why: 'many unterminated link openers must terminate and not false-positive',
    // Deliberately NOT `buy ...](... adapter`: the gate drops non-alphanumerics
    // by design (that is how `buy <strong>adapter</strong>` is caught), so two
    // dead-name words separated only by punctuation ARE a mention under its own
    // rules. My first version of this fixture asserted otherwise and failed,
    // correctly. What this pins is that the scan terminates and invents nothing.
    body: 'Docs ' + ']('.repeat(2000) + ' notes.\n',
  },
  {
    // Round 8 P1. A real DOCX: ZIP of deflated XML. The sentence exists only
    // inside the compressed part, so reading the container's bytes saw nothing
    // and the file passed a gate claiming whole-tree coverage. Built here with
    // `deflateRawSync` rather than committed as a binary blob, so the fixture
    // is reviewable as source.
    name: 'guidance.docx',
    caught: true,
    why: 'a DOCX paragraph naming the retired surface must be read, not skipped',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>' +
          'Operators must deploy the VPFI buy adapter before launch.' +
          '</w:t></w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // The other half, inline direction. Word segments a single WORD across runs
    // at arbitrary points — a spell-check marker here — so a run boundary is
    // nothing on the page and must delete to nothing. `buyRequest` is one of
    // the two `identifierOnly` tokens, so it is caught only if the source span
    // behind it is one word: replacing run tags with a space would break the
    // span and let a dead identifier escape by however Word happened to split
    // it. (My first version of this fixture asserted the opposite — that tags
    // become a space — and failed, correctly: `buy adapter` with only a space
    // between IS a mention under the gate's own rules, in a `.docx` exactly as
    // in a `.md`. Nothing about the space was doing the work.)
    name: 'run-split.docx',
    caught: true,
    why: 'a run boundary inside a word is nothing on the page',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p>' +
          '<w:r><w:t>buy</w:t></w:r>' +
          '<w:proofErr w:type="spellStart"/>' +
          '<w:r><w:t>Request</w:t></w:r>' +
          '</w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // …and the block direction, which is what stops that deletion from fusing
    // the document. A paragraph boundary IS something on the page, so it
    // becomes a blank line and the two sentences either side of it stay two
    // sentences. Same inline-vs-block split the HTML path already draws.
    name: 'paragraph-split.docx',
    caught: false,
    why: 'a paragraph boundary separates what the reader sees',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body>' +
          '<w:p><w:r><w:t>Decide what to buy</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Request a quote from the desk</w:t></w:r></w:p>' +
          '</w:body></w:document>',
      ],
    ],
  },
  {
    // Round 10 P1. Signature alone is claimable by ANY file, and the Office
    // decoder's output REPLACES the source text — so a `.md` opening with the
    // four ZIP bytes had its whole body swapped for the empty string and the
    // gate scanned nothing. Same bypass shape as the `GIF8`-prefixed markdown
    // the binary-signature rule already had to close, arriving one format over.
    name: 'pk-prefixed.md',
    caught: true,
    why: 'a text file cannot buy an exemption by opening with a ZIP signature',
    body: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('\nOperators must deploy the VPFI buy adapter before launch.\n'),
    ]),
  },
  {
    // Round 10 P1. The archive comment is arbitrary bytes; a decoy `PK\x05\x06`
    // planted there is found FIRST by a backward scan. The decoy declares zero
    // entries, so a real document read as zero parts and passed clean. A real
    // EOCD's comment ends exactly at EOF and its central directory starts on a
    // central-directory signature — this fixture's decoy satisfies neither.
    name: 'eocd-in-comment.docx',
    caught: true,
    why: 'a decoy EOCD in the archive comment must not displace the real record',
    zipComment: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(18),
    ]),
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>' +
          'Operators must deploy the VPFI buy adapter before launch.' +
          '</w:t></w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 10 P1. A tab inside a paragraph is inline whitespace — the reader
    // sees two words on one line, exactly as with a space — and treating it as
    // a block break discarded a visible mention. The space already gets this
    // call; the tab is the same call one character over.
    name: 'tab-inline.docx',
    caught: true,
    why: 'a tab within a paragraph is whitespace, not a block boundary',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r>' +
          '<w:t>Deploy the VPFI buy</w:t><w:tab/><w:t>adapter before launch</w:t>' +
          '</w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // A `>` inside a quoted attribute value ends the tag early for a
    // `<[^>]*>` strip, spilling the rest of the attribute into the text — and
    // the spilled `B` sat between `buy` and `adapter`, so the phrase normalized
    // to `buybadapter` and the mention was MISSED. The quote-aware walk ends
    // the tag where the tag ends. (This is also what CodeQL reports as an
    // incomplete one-pass strip; nothing here reaches an HTML sink, but the
    // observation behind the query is correct and this is the fix for it.)
    name: 'attr-gt.docx',
    caught: true,
    why: 'a quoted `>` does not end a tag',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r>' +
          '<w:t>Deploy the VPFI buy</w:t>' +
          '<w:ins w:author="A > B"/>' +
          '<w:t>adapter before launch</w:t>' +
          '</w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 10 P1, the other direction. A worksheet using inline strings gives
    // each cell its own element; with no boundary between them two unrelated
    // cells fused into a mention that no cell contains.
    name: 'cells.xlsx',
    caught: false,
    why: 'separate spreadsheet cells are separate text',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'xl/worksheets/sheet1.xml',
        '<?xml version="1.0"?><worksheet><sheetData><row>' +
          '<c t="inlineStr"><is><t>Decide what to buy</t></is></c>' +
          '<c t="inlineStr"><is><t>Adapter selection follows</t></is></c>' +
          '</row></sheetData></worksheet>',
      ],
    ],
  },
  {
    // Round 10 P1. CDATA is reader-visible text wearing markup's brackets, so
    // the blanket tag strip deleted a whole paragraph written that way.
    name: 'cdata.docx',
    caught: true,
    why: 'a paragraph written as CDATA is still on the page',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>' +
          '<![CDATA[Operators must deploy the VPFI buy adapter before launch.]]>' +
          '</w:t></w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 10 P1. A UTF-16 part decoded as UTF-8 keeps a NUL between every
    // markup character, so `</w:p>` stopped matching the boundary regex and two
    // paragraphs fused into a mention no reader sees.
    name: 'utf16.docx',
    caught: false,
    why: 'a UTF-16 part still has paragraph boundaries',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(
            '<w:document><w:body>' +
              '<w:p><w:r><w:t>Decide what to buy</w:t></w:r></w:p>' +
              '<w:p><w:r><w:t>Adapter selection follows</w:t></w:r></w:p>' +
              '</w:body></w:document>',
            'utf16le',
          ),
        ]),
      ],
    ],
  },
  {
    // Round 10 P1. OOXML names its main part through the package relationships,
    // so a conforming document body need not be called `word/document.xml`. The
    // fixed filename whitelist walked straight past this one.
    name: 'nonstandard-part.docx',
    caught: true,
    why: 'the main part is named by relationship, not by convention',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        '_rels/.rels',
        '<?xml version="1.0"?><Relationships><Relationship Id="rId1" ' +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
          'Target="word/guidance.xml"/></Relationships>',
      ],
      [
        'word/guidance.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>' +
          'Operators must deploy the VPFI buy adapter before launch.' +
          '</w:t></w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 10 P1. A drawing's accessibility description IS reader-visible —
    // assistive technology reads it aloud — but it lives in an attribute, so
    // the blanket tag removal deleted it along with the markup.
    name: 'alt-text.docx',
    caught: true,
    why: 'alt text is read aloud, so it is text',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:drawing>' +
          '<wp:docPr id="1" name="Picture 1" ' +
          'descr="Operators must deploy the VPFI buy adapter before launch."/>' +
          '</w:drawing></w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 11 P1. A comment is not a tag and does not end at its first `>`.
    // The quoted-tag walk read `<!-- A > B -->` as ending after `A >` and
    // emitted ` B -->` as text; the `B` landed between the two words and the
    // phrase normalized to `buybadapter`. Same shape as the quoted-`>` bug the
    // walk was written to fix, one construct over.
    name: 'xml-comment.docx',
    caught: true,
    why: 'an XML comment ends at `-->`, not at its first `>`',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r>' +
          '<w:t>Deploy the VPFI buy</w:t><!-- A > B --><w:t>adapter before launch</w:t>' +
          '</w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 11 P1. XML permits either quote character; matching only `"`
    // exempted the single-quoted spelling of the very accessibility text the
    // double-quoted fixture covers.
    name: 'alt-text-single-quote.docx',
    caught: true,
    why: "alt text is alt text in single quotes too",
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:drawing>' +
          "<wp:docPr id='1' descr='Operators must deploy the VPFI buy adapter before launch.'/>" +
          '</w:drawing></w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 13 P1. XML does not expand character references inside CDATA, so
    // `&#32;` there is four visible characters, not a space. Decoding it after
    // unwrapping fused two words the reader sees held apart and BLOCKED a clean
    // document — the unwrapping has to carry the "this was literal" fact.
    name: 'cdata-entity.docx',
    caught: false,
    why: 'a character reference inside CDATA is literal text',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>' +
          '<![CDATA[Decide what to buy&#32;adapter selection follows.]]>' +
          '</w:t></w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 12 P1. An xmlns binding is SCOPED to the element that declares it.
    // Flattening every declaration in the part let `e:` keep a
    // WordprocessingML meaning after the element that bound it had closed, so
    // a later `<e:p/>` from an ignorable-extension namespace inserted a
    // boundary no reader sees and split a real mention in two.
    name: 'ns-scoped.docx',
    caught: true,
    why: 'a prefix binding does not outlive the element that declares it',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><w:document ' +
          'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r>' +
          '<w:t xmlns:e="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          'Deploy the VPFI buy</w:t>' +
          '<e:p xmlns:e="http://schemas.openxmlformats.org/markup-compatibility/2006"/>' +
          '<w:t>adapter before launch</w:t>' +
          '</w:r></w:p></w:body></w:document>',
      ],
    ],
  },
  {
    // Round 11 P1, the false-BLOCK direction. An XML prefix is an alias a
    // document declares for itself: `w:` is conventional, not required. A
    // literal QName list stopped seeing paragraphs in a part that binds
    // WordprocessingML to `x:`, fused two of them, and blocked a clean file.
    name: 'ns-prefix.docx',
    caught: false,
    why: 'a paragraph is a paragraph under any prefix bound to its namespace',
    zip: [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        '<?xml version="1.0"?><x:document ' +
          'xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<x:body>' +
          '<x:p><x:r><x:t>Decide what to buy</x:t></x:r></x:p>' +
          '<x:p><x:r><x:t>Adapter selection follows</x:t></x:r></x:p>' +
          '</x:body></x:document>',
      ],
    ],
  },
  {
    // Round 11 P1. A bare `](` in running prose is literal visible text under
    // CommonMark — there is no link without an opener — but the destination
    // skip assumed one and deleted the middle of a clean sentence.
    name: 'bare-destination.md',
    caught: false,
    why: 'a `](` with no label before it is ordinary text',
    body: 'Decide what to buy](configuration)Adapter selection follows.\n',
  },
  {
    // Round 11 P1. A processing instruction is raw HTML: passed through to the
    // output, never shown to the reader. It begins `<` with a non-letter after
    // it, so the comment special case missed it and the letter-led tag shape
    // rejected it, leaving its payload wedged between two words.
    name: 'processing-instruction.md',
    caught: true,
    why: 'a processing instruction is invisible markup, like a comment',
    body: 'Operators must deploy the VPFI buy<?target data?>adapter before launch.\n',
  },
  {
    // Round 11 P1, and the same bypass as `pk-prefixed.md` one format over —
    // the Office signature fix earlier this round was not applied to the path
    // it was copied from. `extractPdfText` returns '' for a file with no
    // streams, and that empty string REPLACED the visible Markdown.
    name: 'pdf-prefixed.md',
    caught: true,
    why: 'a text file cannot buy an exemption by opening with %PDF',
    body: '%PDF-1.4\nOperators must deploy the VPFI buy adapter before launch.\n',
  },
  {
    // Round 12 P1. A `\` before a delimiter makes it data, not structure:
    // `(https://example/a\)b)` is ONE destination containing a literal `)`.
    // Ending there left `b)` in the stream, wedging the label apart from the
    // word after it. Same shape as the quoted-`>` case on the Office side.
    name: 'escaped-paren.md',
    caught: true,
    why: 'an escaped `)` does not close a destination',
    body: 'VPFI [buy](https://example.com/a\\)b) adapter selection.\n',
  },
  {
    // Round 12 P1. `#` alone is a valid EMPTY heading — micromark renders it as
    // `<h1></h1>` — so it separates the blocks either side. Requiring
    // whitespace after the marker missed it and fused them.
    name: 'empty-atx.md',
    caught: false,
    why: 'an empty ATX heading is still a block boundary',
    // NO blank lines around the heading — with them the blank-line rule
    // already separates the blocks and the heading rule is never consulted, so
    // the fixture would pass either way and pin nothing. An ATX heading can
    // interrupt a paragraph; confirmed against micromark, which renders this
    // as `<p>…</p><h1></h1><p>…</p>`.
    body: 'Decide what to buy\n#\nAdapter selection follows.\n',
  },
  {
    // Round 12 P1. CommonMark processes no escapes inside a code span, so a
    // delimiter run preceded by `\` still CLOSES it. Rejecting that closer left
    // the span unrecognized, `<foo>` inside it was stripped as HTML, and a
    // clean file was blocked. Verified against the repository's own micromark.
    name: 'codespan-backslash.md',
    caught: false,
    why: 'a backslash does not stop a backtick closing a code span',
    body: '`Decide what to buy <foo>\\`Adapter selection follows.\n',
  },
  {
    // Round 12 P1, the NARROWED half of the declaration finding. `<!>` renders
    // as literal visible text, so stripping it fused the words either side.
    // (The reported example `<!not-html>` is NOT this case — micromark passes
    // it through as a real declaration; see the PR thread.)
    name: 'bare-bang.md',
    caught: false,
    why: '`<!>` is visible text, not a declaration',
    body: 'Decide what to buy<!>Adapter selection follows.\n',
  },
  {
    // Round 13 P1. Escaping is a property of what comes AFTER a backslash run,
    // so a backward walk that charges the run to the character on its LEFT
    // tests the wrong side: the `\` here escapes the `*`, but the walk read it
    // as escaping the `[`, rejected the real opener, and left `zzzz` in the
    // rendered stream between the two words.
    name: 'escaped-label-start.md',
    caught: true,
    why: 'a backslash escapes what follows it, not what precedes it',
    body: 'Operators must deploy the [\\*buy](zzzz) adapter before launch.\n',
  },
  {
    // Round 13 P1. `\\` is an escaped BACKSLASH, so the backtick after it is a
    // live code-span opener. Rejecting any preceded-by-backslash opener missed
    // the span, and the `<foo>` inside it — visible code — was stripped as
    // HTML on a clean file.
    name: 'codespan-double-backslash.md',
    caught: false,
    why: 'two backslashes escape each other, leaving the backtick live',
    body: 'Decide what to buy\\\\` <foo>`Adapter selection follows.\n',
  },
  {
    // Round 14 P1, a regression from round 13's memo. The destination walk also
    // stops at a BLANK LINE, and recording "no closer in the rest of the file"
    // there claimed something one paragraph cannot establish — every later
    // destination was rejected unscanned. A performance memo allowed to lie is
    // worse than no memo.
    name: 'memo-paragraph.md',
    caught: true,
    why: 'an unterminated destination in one paragraph says nothing about the next',
    body:
      '[x](unterminated\n\nOperators must deploy the [buy](zzzz) adapter before launch.\n',
  },
  {
    // Round 14 P2, a regression from round 13's parity check. The regex had
    // already consumed through the candidate's closing run, and that closer was
    // itself the LIVE opener of the real span — so rejecting without rewinding
    // meant the span was never seen and its `<foo>` was stripped as HTML.
    name: 'codespan-rewind.md',
    caught: false,
    why: 'rejecting an escaped opener must not swallow the next live one',
    body: 'Decide what to buy\\`-`<foo>`Adapter selection follows.\n',
  },
  {
    // Round 14 P2. Links cannot contain links: once the inner one is
    // recognized, CommonMark marks the enclosing opener INACTIVE and the outer
    // pair renders literally, `](/middle)` and all — which the reader sees
    // between the two words.
    name: 'nested-link.md',
    caught: false,
    why: 'an inner link deactivates the bracket enclosing it',
    body: 'Decide what to [buy [](/inner)](/middle) adapter selection follows.\n',
  },
  {
    // Round 15 P1, a regression from round 14. Links cannot contain links, but
    // IMAGES CAN — `![alt [x](/inner)](/image)` is a valid image whose
    // description holds a link. Clearing the whole opener stack discarded the
    // image opener and left `/image` in the rendered stream between the words.
    name: 'image-with-link.md',
    caught: true,
    why: 'an image opener survives an inner link',
    body: 'VPFI ![VPFI [buy](/inner)](/image) adapter selection follows.\n',
  },
  {
    // Round 15 P1, a regression from round 14's memo guard. A line of spaces is
    // BLANK under CommonMark; requiring two adjacent newlines missed it, so the
    // walk crossed the paragraph, ran to EOF, and set the absence memo on
    // evidence it had no right to — silencing every later destination.
    name: 'memo-space-line.md',
    caught: true,
    why: 'a whitespace-only line is a paragraph break',
    body:
      '[x](unterminated\n   \nOperators must deploy the [buy](zzzz) adapter before launch.\n',
  },
  {
    // Round 15 P2 — a FALSE POSITIVE on live prose, which is the class the
    // notFollowedBy guard exists to prevent. Treasury buyback is a SURVIVING
    // feature; split by inline formatting, the raw gap held the tags, the guard
    // declined, and the gate reported live work as excision residue.
    name: 'buyback-formatted.md',
    caught: false,
    why: 'the surviving-feature guard must read the rendered stream',
    body: 'The treasury uses a fixed-rate buy<strong>back</strong> auction.\n',
  },
  {
    // Round 16 P1, a regression from round 15's suffix fix. Stripping EVERY tag
    // in the gap removed block boundaries too, so `<p>…fixed-rate buy</p>` and
    // `<p>Back up config…</p>` read as the surviving `buyback` feature and a
    // real hit was suppressed before crossesBlockBoundary ever saw it.
    name: 'buyback-block.html',
    caught: true,
    why: 'a paragraph break is not intra-word, whatever the suffix says',
    body:
      '<p>Operators must use the fixed-rate buy</p><p>Back up config before launch.</p>\n',
  },
  {
    // Round 16 P2. `\!` is an escaped exclamation mark, so the bracket after it
    // opens a LINK, not an image — and since images survive an inner link while
    // links do not, getting it backwards preserved an opener CommonMark had
    // deactivated and stripped a destination the reader sees.
    name: 'escaped-bang.md',
    caught: false,
    why: 'an escaped `!` does not make an image opener',
    body: 'Decide what to \\![buy [](/inner)](/middle) adapter selection follows.\n',
  },
  {
    // Round 16 P2. A bracket inside a code span is literal and opens no label;
    // letting it pair with a later bare `](` in prose stripped visible text.
    name: 'bracket-in-code.md',
    caught: false,
    why: 'a bracket in a code span opens nothing',
    body: 'Decide what to buy `[` ](/middle) Adapter selection follows.\n',
  },
  {
    // Round 16 P1. The normalizer decodes `s` to `s` — that is how the
    // candidate is found — but the identifier validation re-sliced the
    // UNDECODED source and rejected the backslash. Every JSON consumer reads
    // this as the exact retired getter.
    name: 'json-escape-identifier.json',
    caught: true,
    why: 'a JSON unicode escape does not buy an exemption',
    body: '{"operation":"buyOption\\u0073"}\n',
  },
  {
    // Round 16 P2. `.markdown` is the standard long spelling; omitting it let a
    // contributor evade the whole-tree ratchet by extension alone.
    name: 'long-extension.markdown',
    caught: true,
    why: 'the renderer follows the format, not the shorter spelling',
    body: 'Operators must deploy the VPFI buy<strong>adapter</strong> before launch.\n',
  },
  {
    // Round 17 P2, an edge of round 16's literal-region fix. Code spans were
    // excluded from the opener pass but recognized HTML TAGS were not, so the
    // `[` inside `title="["` paired with a later `](` and stripped a run the
    // reader sees.
    name: 'bracket-in-tag.md',
    caught: false,
    why: 'a bracket inside a tag is tag data, not a label opener',
    body: 'Decide what to buy <span title="[">](/middle) Adapter selection follows.\n',
  },
  {
    // Round 17 P2. An indented code block nested in a block quote starts its
    // SOURCE line with `>`, so a raw four-space test never saw it and the
    // literal `<strong>` inside was stripped as markup. CommonMark removes the
    // quote prefix before parsing the block; so must the indentation test.
    name: 'quoted-indented-code.md',
    caught: false,
    why: 'a quote marker is the container prefix, not the block content',
    body:
      'Some prose first.\n\n>\n>     Decide what to buy<strong>adapter</strong> selection follows.\n',
  },
  {
    // Round 18 P1. Four spaces under a LIST ITEM are the list's indentation,
    // not a code block's. Round 17 removed the quote prefix and stopped there,
    // so an ordinary list paragraph was marked literal and its `<strong>`
    // survived as text, letting a live mention pass.
    name: 'list-paragraph.md',
    caught: true,
    why: 'a list continuation paragraph is prose, not indented code',
    body: '- Intro\n\n    Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    // Round 18 P2. A `[` inside an HTML COMMENT is invisible and opens no
    // label; round 17 skipped element tags only, so it paired with a later
    // `](` and stripped a run the reader sees.
    name: 'bracket-in-comment.md',
    caught: false,
    why: 'a bracket inside a comment opens nothing',
    body: 'Decide what to buy <!-- [ --> ](/middle) Adapter selection follows.\n',
  },
  {
    // Round 18 P2. CR alone ends a line in CommonMark. Splitting on LF made a
    // CR-only document ONE logical line, so no blank-line boundary was ever
    // seen and two paragraphs fused.
    name: 'cr-line-endings.md',
    caught: false,
    why: 'a CR-only document still has paragraphs',
    body: 'Decide what to buy\r\rAdapter selection follows.\r',
  },
  {
    // Round 19 P2. `===` makes the line above it an `<h1>`, so it separates two
    // blocks. The `---` form was covered only by ACCIDENT via the
    // thematic-break rule; the level-one form matched nothing and fused the
    // paragraphs either side of a heading.
    name: 'setext-h1.md',
    caught: false,
    why: 'a `===` underline is a heading, and a heading is a boundary',
    body: 'Decide what to buy\n===\nAdapter selection follows.\n',
  },
  {
    // Round 19 P1. A JSON string VALUE is not a sentence. `buy:adapter` names
    // the dead identifier exactly as `buy-adapter` does, but the `:` read as a
    // sentence ender discarded it — while the identical
    // `data-operation="buy:adapter"` was caught by the tag-interior path. The
    // two paths disagreed about the same string.
    name: 'json-colon.json',
    caught: true,
    why: 'a colon inside one JSON value is a separator, not a sentence end',
    body: '{"operation":"buy:adapter"}\n',
  },
  {
    // Round 20 P1. A phrase wrapping across consecutive QUOTED lines is one
    // rendered paragraph — every continuation begins with `>` and none starts a
    // new block — so treating each marker as a boundary let a live mention hide
    // simply by being wrapped inside a quote.
    name: 'quote-wrap.md',
    caught: true,
    why: 'a quoted continuation line does not start a new block',
    body: '> Operators must deploy the VPFI buy\n> adapter before launch.\n',
  },
  {
    // Round 20 P2, a REGRESSION from round 19. The absence of a quote does not
    // prove the span sits inside one: in `.jsonc` it can be comment prose, and
    // the unconditional exemption skipped the sentence rules there.
    name: 'jsonc-comment.jsonc',
    caught: false,
    why: 'a colon in comment prose is still a sentence boundary',
    body: '{\n  // Decide what to buy: Adapter selection follows.\n  "a": 1\n}\n',
  },
  {
    // Round 20 P2. A fence opened inside a LIST ITEM starts after the marker,
    // and a raw-line test saw only whitespace before the backticks — so the
    // fence went unrecognized and the literal `<strong>` inside was stripped as
    // markup, blocking a clean document.
    name: 'fence-in-list.md',
    caught: false,
    why: 'a fence inside a container is still a fence',
    body:
      '- ```\n  Decide what to buy<strong>adapter</strong> selection follows.\n  ```\n',
  },
  // ── Round 23. All six landed on the container-fence code from the commit
  // before, and all six are consequences of ONE missing idea: container
  // IDENTITY. Depth, indentation and quote count each approximate it and each
  // breaks somewhere. They are grouped here because they stand or fall
  // together — any future change that reintroduces a numeric approximation
  // will fail several of them at once, which is the signal worth having.
  {
    name: 'fence-sibling-item.md',
    caught: true,
    why: 'a sibling list item ends the previous item, and the fence in it',
    body: '- ```\n  code\n- Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  // ── Round 24. Three more on the container chain, all false NEGATIVES, all
  // from measuring a container's width the wrong way.
  {
    name: 'fence-tab-marker.md',
    caught: true,
    why: 'a tab after a list marker makes the content column four, not two',
    body: '-\t```\n  Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    name: 'fence-marker-only.md',
    caught: true,
    why: 'a marker alone on its line is a valid empty list item',
    body: '-\n  ```\n  code\n- Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    // The ORDERED form of the empty-marker bypass. The finding named it and
    // the fix covers it, but the fixture beside this one pins only `-`, so
    // nothing held the ordered spelling. Probed after the fix and kept
    // because it fails against the previous commit — four of the five probes
    // run alongside it behaved identically before and after and were dropped.
    name: 'fence-ordered-marker-only.md',
    caught: true,
    why: 'an ordered marker alone on its line is also a valid empty item',
    body: '1.\n   ```\n   code\n2. Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    name: 'fence-quote-inner-list.md',
    caught: true,
    why: "an outer quote's width is not the inner item's continuation indent",
    body: '> - ```\n  > Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  // Three more from probing the container-chain model after it landed, kept
  // because each was WRONG on the commit before it — the sibling rule was
  // reported against `-` only, and these show it holds for the ordered and
  // nested forms too, while the tab case is a false positive the model fixed
  // on the way past. Probes that behaved identically before and after were
  // discarded rather than committed: a fixture that cannot fail asserts
  // nothing, which this suite has already learned four times.
  {
    name: 'fence-ordered-sibling.md',
    caught: true,
    why: 'an ordered sibling item ends the previous item, and the fence in it',
    body: '1. ```\n   code\n2. Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    name: 'fence-nested-sibling.md',
    caught: true,
    why: 'a sibling at the INNER level ends the inner item, and the fence in it',
    body: '- - ```\n    code\n  - Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    name: 'fence-tab-continuation.md',
    caught: false,
    why: 'a tab is four columns, so it continues a two-space list item',
    body: '- ```\n\tbuy<strong>adapter</strong> sample\n  ```\n',
  },
  {
    // NOT a proof of a fix — this case was already caught before the tab
    // change, so it locks existing behaviour rather than demonstrating new.
    // Kept because the indentation measure it exercises did change: a tab is
    // four columns, so `\t```` is indented code and not a fence opener.
    name: 'fence-tab-indent.md',
    caught: true,
    why: 'a tab-indented fence line does not shield the prose below it',
    body: '\t```\nOperators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    name: 'fence-quote-blank.md',
    caught: true,
    why: 'a blank line ends a quote, so the `>` after it opens a new one',
    body: '> ```\n> code\n\n> Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    name: 'fence-optional-indent.md',
    caught: false,
    why: "a fence's own 1-3 space indent is not a container column",
    body: '   ```\nDecide what to buy<strong>adapter</strong> next.\n',
  },
  {
    name: 'fence-reopen-same-line.md',
    caught: false,
    why: 'the line that leaves a container can itself open a new fence',
    body: '- ```\n  code\n~~~\nDecide what to buy<strong>adapter</strong> next.\n~~~\n',
  },
  {
    name: 'fence-inner-marker.md',
    caught: false,
    why: 'inside a top-level fence a `- ` line is code, not a container',
    body: '```\n- ```\nDecide what to buy<strong>adapter</strong> next.\n```\n',
  },
  {
    // Found by adversarial self-review, and the FIRST false NEGATIVE among
    // this PR's container defects — every other one blocked a clean document,
    // which is visible and gets fixed; this one let live text through, which
    // is not. CommonMark closes a fence when its parent container closes, so
    // a blank line and a dedent end both the list item and the fence. The
    // walk tracked only the delimiter, so an unclosed container fence marked
    // the rest of the FILE literal and markup below it was never stripped.
    name: 'fence-container-ends.md',
    caught: true,
    why: 'a fence opened in a list item closes when the list item does',
    body:
      '- ```\n  some code\n\nOperators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    // Found by adversarial self-review after round 22, not by a reviewer. `>`
    // with nothing after it ends the quote's paragraph exactly as an empty
    // line ends an unquoted one — but the raw-span blank-line test sees `>`
    // as non-empty and the depth test sees no change, so two paragraphs in
    // one quote fused. Round 20 opened this when it stopped treating every
    // quoted line as a boundary; until then it was covered by accident.
    name: 'quote-blank-line.md',
    caught: false,
    why: 'a `>` line with no content is a paragraph break inside the quote',
    body: '> Decide what to buy\n>\n> Adapter selection follows.\n',
  },
  {
    // Round 22 P1, accepted in HALF. CommonMark allows a Setext underline of
    // ONE or more characters; requiring three missed the single-character
    // form, fusing the paragraphs either side of a heading. Only the `=` form
    // is relaxed — a lone `-` also spells an empty list item, and #1758
    // carries that half.
    name: 'setext-single-equals.md',
    caught: false,
    why: 'a single `=` is a valid level-one underline, and a heading is a boundary',
    body: 'Decide what to buy\n=\nAdapter selection follows.\n',
  },
  {
    // Round 22 P1. The comment stripper ended a `//` comment at LF only, so a
    // CR-only file's first comment swallowed the rest of the prefix and every
    // structural quote after it went uncounted. The parity then failed toward
    // GREEN, which is the one direction a gate must never fail in.
    name: 'jsonc-cr-comment.jsonc',
    caught: true,
    why: 'a `//` comment ends at CR as well as LF',
    body: '{\r  // A 6" clearance is required.\r  "operation":"buy:adapter"\r}\r',
  },
  {
    // Round 22 P1. CommonMark forbids a backtick in a BACKTICK fence's info
    // string. Accepting one opened a fence that never existed, and every line
    // to the end of the file was then classified as code — live prose below it
    // read as literal and passed.
    name: 'fence-info-backtick.md',
    caught: true,
    why: 'a backtick in the info string means the line is not a fence opener',
    body:
      '```bad`info\nOperators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    // Round 22 P2. Containers interleave in BOTH orders. Two fixed-order
    // replacements handled `> - ` and missed `- > `, because stripping the
    // list marker only exposes the quote after the quote pass has already run.
    name: 'fence-list-quote.md',
    caught: false,
    why: 'a fence inside a quote inside a list is still a fence',
    body:
      '- > ```\n  > Decide what to buy<strong>adapter</strong> selection follows.\n  > ```\n',
  },
  {
    // Round 22 P2. Collapsing every nonzero quote depth into "quoted" made
    // `>` → `>>` read as a paragraph continuation, fusing two fragments that
    // sit in different nested quote blocks.
    name: 'quote-depth.md',
    caught: false,
    why: 'entering a nested quote starts a new block',
    body: '> Decide what to buy\n>> Adapter selection follows.\n',
  },
  {
    // Round 22 P2. Deleting every unrecognized named reference assumed they
    // all render as ignorable punctuation. A browser renders an unknown
    // reference as its own source text, so deleting it manufactured a dead
    // name out of clean prose.
    name: 'unknown-entity.html',
    caught: false,
    why: 'an unrecognized character reference stays visible and separates words',
    body: '<p>Decide what to buy&bogus;adapter selection follows.</p>\n',
  },
  {
    // Round 21 P1. A `"` inside a `.jsonc` COMMENT cannot open a JSON string,
    // but the structural-quote parity counted it — so a single quote in a
    // comment above flipped the span out of the string-value branch, the `:`
    // read as a sentence end, and a real configuration spelling went silent.
    name: 'jsonc-comment-quote.jsonc',
    caught: true,
    why: 'a quote inside a comment does not open a JSON string',
    body: '{\n  // A 6" clearance is required.\n  "operation":"buy:adapter"\n}\n',
  },
  {
    // Round 21 P1, the mirror of round 20's quote-wrap fix. CommonMark allows
    // a LAZY CONTINUATION: a wrapped paragraph's later lines may drop the `>`
    // and remain the same block. Treating the marker's disappearance as a
    // boundary let the same wrapped phrase hide by starting inside a quote and
    // finishing outside it.
    name: 'quote-lazy-continuation.md',
    caught: true,
    why: 'a line that drops the `>` can still continue the quoted paragraph',
    body: '> Operators must deploy the VPFI buy\nadapter before launch.\n',
  },
  {
    // Round 21 P1, the other half of round 20's container fix. The fence was
    // MATCHED against the container-stripped line but its closer was validated
    // against the raw one, so the trailing-content slice landed inside the
    // `> ` prefix and never came back empty. A quoted fence could open and
    // never close, which left every later line in the file classified as code
    // — and a live mention below it passed unseen.
    name: 'quoted-fence-closes.md',
    caught: true,
    why: 'a fence opened inside a block quote also closes inside one',
    body:
      '> ```\n> sample\n> ```\n\nDecide what to buy<strong>adapter</strong> selection follows.\n',
  },
  {
    name: 'link-destination.md',
    caught: true,
    why: 'a link URL sits between two words rendered side by side',
    body: 'Operators must deploy the [buy](https://example.com/config) adapter.\n',
  },
  {
    name: 'char-ref.md',
    caught: true,
    why: 'character references render as the identifier',
    body: 'Configure buyOpti&#111;ns before deployment.\n',
  },
  {
    name: 'attr-colon.html',
    caught: true,
    why: 'attribute values are configuration, not sentences — `:` is not a prose boundary there',
    body: '<div data-operation="buy:adapter"></div>\n',
  },
  {
    name: 'tag-interior.md',
    caught: true,
    why: 'attributes and component names are scanned as their own stream',
    body: '<div data-operation="buyOptions"></div>\n',
  },
  {
    name: 'br-is-not-a-block.md',
    caught: true,
    why: '<br> is a line break; a source newline does not stop a phrase fusing',
    body: 'Operators must deploy the VPFI buy<br>adapter before cutover.\n',
  },

  // --- but genuinely separate text must NOT be fused ---
  {
    name: 'autolink.md',
    caught: false,
    why: 'a Markdown autolink renders as visible text and separates the words either side',
    body: 'Decide what to buy<https://example.com>Adapter selection follows.\n',
  },
  {
    name: 'block-tag.md',
    caught: false,
    why: 'a block-level element separates two visibly distinct thoughts',
    body: 'Decide what to buy<hr>Adapter selection follows.\n',
  },
  {
    name: 'two-json-strings.json',
    caught: false,
    why: 'separate JSON string values never render as one phrase',
    body: '["Decide what to buy", "Adapter selection follows"]\n',
  },
  {
    name: 'synthesized-tag.md',
    caught: false,
    why: 'malformed markup must not be re-parsed into a tag that was never there',
    body: 'Configure buyOpti<o<strong>></strong>ns before deployment.\n',
  },

  // --- encodings that hide a phrase from a naive read ---
  {
    name: 'json-unicode-escape.json',
    caught: true,
    why: 'a \\u escape renders as the character, not as its spelling',
    body: '{"operatorMessage":"Deploy the buy\\u0020adapter before launch"}\n',
  },
  {
    name: 'json-escaped-quote.json',
    caught: true,
    why: 'an escaped quote stays inside ONE string value',
    body: '{"note": "Operators must deploy the VPFI buy \\"adapter\\" before cutover."}\n',
  },
];

/** PDFs are built rather than written literally, so the compression is real. */
function pdfFixtures() {
  const stream = (text) => {
    const raw = Buffer.from(`BT (${text}) Tj ET`);
    const comp = deflateSync(raw);
    return Buffer.concat([
      Buffer.from('%PDF-1.4\n2 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      comp,
      Buffer.from('\nendstream\nendobj\n'),
    ]);
  };
  return [
    {
      name: 'compressed.pdf',
      caught: true,
      why: 'real PDFs Flate-compress their content streams; the phrase is absent from the raw bytes',
      buf: stream('Operators must deploy the VPFI buy adapter'),
    },
    {
      name: 'compressed-clean.pdf',
      caught: false,
      why: 'an ordinary document must not be failed by its drawing operators',
      buf: stream('Quarterly audit summary, nothing removed here'),
    },
    {
      // Round 11 P1. Stream data is arbitrary bytes and may spell `endstream`
      // itself — here inside a valid PDF comment. Truncating the body at the
      // first occurrence meant everything the page actually drew went unread.
      // The declared `/Length` is the real boundary.
      name: 'endstream-in-body.pdf',
      caught: true,
      why: 'a stream ends at its declared length, not at the first `endstream` in its data',
      buf: (() => {
        const body = '% endstream\nBT (Operators must deploy the VPFI buy adapter) Tj ET';
        return Buffer.from(
          `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
        );
      })(),
    },
    {
      // Round 12 P1. Only ONE EOL sequence follows the `stream` keyword; eating
      // a RUN of them consumed the stream's own first byte when the data began
      // with a newline, shifting the declared endpoint off the terminator and
      // dropping back to the `endstream` scan the /Length fix exists to
      // replace.
      name: 'leading-newline.pdf',
      caught: true,
      why: 'the stream data may begin with a newline of its own',
      buf: (() => {
        // TWO leading newlines. With one, the off-by-one endpoint happens to
        // land on the newline before the terminator and the validation still
        // passes — the fixture would pin nothing.
        //
        // The drawn string is HEX-ENCODED, and that is load-bearing. Written as
        // a literal, the phrase sits in the container's own bytes, so the
        // read-as-text fallback recovers it and the fixture passes whether or
        // not the bug is fixed. Compressing instead does not work either: a
        // deflate stream begins with its own header, never a newline, so the
        // off-by-one cannot arise. Both of my earlier attempts at this fixture
        // asserted a catch that proved nothing.
        const hex = Buffer.from('Operators must deploy the VPFI buy adapter')
          .toString('hex')
          .toUpperCase();
        const body = `\n\n% endstream\nBT <${hex}> Tj ET`;
        return Buffer.from(
          `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
        );
      })(),
    },
    {
      // Round 15 P1. PDF end-of-line is CR, LF or CRLF; looking only for LF let
      // a CR-terminated comment swallow the rest of the stream — the same
      // failure the comment skip was added to prevent, one line ending over.
      name: 'comment-cr.pdf',
      caught: true,
      why: 'a PDF comment ends at CR as well as LF',
      buf: (() => {
        const raw = deflateSync(
          Buffer.from(
            '% unmatched ( in comment\rBT (Operators must deploy the VPFI buy adapter) Tj ET',
          ),
        );
        return Buffer.concat([
          Buffer.from(
            `%PDF-1.4\n1 0 obj\n<< /Length ${raw.length} /Filter /FlateDecode >>\nstream\n`,
          ),
          raw,
          Buffer.from('\nendstream\nendobj\n'),
        ]);
      })(),
    },
    {
      // Round 14 P1, a regression from round 13's balanced walk. `%` starts a
      // comment running to end of line; an unmatched `(` inside one was read as
      // opening a literal string, the walk ran to EOF, and every real string
      // after it was abandoned. Compressed, so the read-as-text fallback cannot
      // paper over it.
      name: 'comment-paren.pdf',
      caught: true,
      why: 'a `(` inside a content-stream comment opens nothing',
      buf: (() => {
        const raw = deflateSync(
          Buffer.from(
            '% unmatched ( in comment\nBT (Operators must deploy the VPFI buy adapter) Tj ET',
          ),
        );
        return Buffer.concat([
          Buffer.from(
            `%PDF-1.4\n1 0 obj\n<< /Length ${raw.length} /Filter /FlateDecode >>\nstream\n`,
          ),
          raw,
          Buffer.from('\nendstream\nendobj\n'),
        ]);
      })(),
    },
    {
      // Round 13 P1. A PDF literal string may contain unescaped parentheses so
      // long as they balance. Stopping at the inner `)` extracted
      // `Operators (must` — NON-EMPTY, so the read-as-text fallback never
      // fired and the drawn phrase went unread. A partial decode is worse than
      // none: it looks like success.
      name: 'nested-parens.pdf',
      caught: true,
      why: 'a literal string ends at its BALANCED closing paren',
      buf: (() => {
        const body =
          'BT (Operators (must) deploy the VPFI buy adapter before launch.) Tj ET';
        return Buffer.from(
          `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
        );
      })(),
    },
    {
      // Round 12 P1. The SOURCE spelling is not what the page draws: `\040`
      // renders as a space, but the raw slice normalized to `buy040adapter` —
      // the octal digits are alphanumeric, so the normalizer kept them and they
      // wedged the phrase apart.
      name: 'octal-escape.pdf',
      caught: true,
      why: 'a PDF octal escape renders as the character, not as its digits',
      buf: Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Length 64 >>\nstream\nBT (Operators must deploy the VPFI buy\\040adapter) Tj ET\nendstream\nendobj\n',
      ),
    },
    {
      name: 'uncompressed.pdf',
      caught: true,
      why: 'the uncompressed path must keep working',
      buf: Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Length 60 >>\nstream\nBT (Operators must deploy the VPFI buy adapter) Tj ET\nendstream\nendobj\n',
      ),
    },
  ];
}

/**
 * Office fixtures are built as REAL ZIP archives — local headers, central
 * directory, EOCD — with raw-deflated parts, so the extractor is exercised
 * against the container format rather than a mock of it. Written as source
 * (part name + XML) rather than committed as binary, so a reviewer can read
 * what the document says.
 */
/**
 * CRC-32 for the ZIP headers.
 *
 * NOT `node:zlib`'s `crc32`, which landed in Node 22.2. This repository's
 * engine floor is `>=22.0.0`, and a STATIC import of a missing export fails
 * before any fixture runs — so on a supported 22.0/22.1 the newly mandatory
 * selftest did not merely fail, it could not start. A gate whose own test
 * suite depends on a newer runtime than the project declares is not a gate
 * everyone can run.
 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function zipFixtures() {
  return FIXTURES.filter((f) => f.zip).map((f) => {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, xml] of f.zip) {
      const nameBuf = Buffer.from(name, 'utf8');
      // A part may be given as a Buffer rather than a string, so a fixture can
      // pin the encoding handling with real UTF-16 bytes.
      const raw = Buffer.isBuffer(xml) ? xml : Buffer.from(xml, 'utf8');
      const comp = deflateRawSync(raw);
      const sum = crc32(raw);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(8, 8); // deflate
      lh.writeUInt32LE(sum, 14);
      lh.writeUInt32LE(comp.length, 18);
      lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      locals.push(lh, nameBuf, comp);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(8, 10);
      ch.writeUInt32LE(sum, 16);
      ch.writeUInt32LE(comp.length, 20);
      ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt32LE(offset, 42);
      central.push(ch, nameBuf);
      offset += lh.length + nameBuf.length + comp.length;
    }
    const localPart = Buffer.concat(locals);
    const centralPart = Buffer.concat(central);
    // The archive COMMENT is arbitrary bytes and a fixture may plant a decoy
    // EOCD signature in it — that is the whole point of `eocd-in-comment.docx`.
    const comment = f.zipComment ?? Buffer.alloc(0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(f.zip.length, 8);
    eocd.writeUInt16LE(f.zip.length, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    eocd.writeUInt16LE(comment.length, 20);
    return { ...f, buf: Buffer.concat([localPart, centralPart, eocd, comment]) };
  });
}

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function run() {
  const all = [
    ...FIXTURES.filter((f) => !f.zip).map((f) => ({ ...f, buf: Buffer.from(f.body) })),
    ...zipFixtures(),
    ...pdfFixtures(),
  ];
  // `recursive: false` — refuse to adopt an existing directory rather than
  // writing into, and later deleting, something this run did not create.
  mkdirSync(join(REPO, DIR));
  for (const f of all) writeFileSync(join(REPO, DIR, f.name), f.buf);
  git('add', '--intent-to-add', '--', DIR);
  // `--intent-to-add` is enough for `git ls-files` to report them, and leaves
  // no staged content to clean out of the index afterwards.

  let output = '';
  try {
    output = execFileSync('node', [join(HERE, 'check-excision-residue.mjs')], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }

  const failures = [];
  for (const f of all) {
    const reported = output.includes(`${DIR}/${f.name}`);
    if (reported !== f.caught) {
      failures.push(
        `  ${f.name}\n      expected ${f.caught ? 'CAUGHT' : 'clean'}, got ${reported ? 'CAUGHT' : 'clean'}\n      ${f.why}`,
      );
    }
  }
  return { failures, total: all.length };
}

let result;
try {
  result = run();
} finally {
  try {
    git('rm', '-r', '--cached', '--quiet', '--force', '--', DIR);
  } catch {
    // `--intent-to-add` entries may already be gone; the working tree removal below is what matters.
  }
  rmSync(join(REPO, DIR), { recursive: true, force: true });
}

if (result.failures.length) {
  console.error(`excision-residue selftest: ${result.failures.length} of ${result.total} fixtures wrong\n`);
  console.error(result.failures.join('\n\n'));
  console.error('\nEach fixture records a case that was wrong at some point. A failure here means a change re-broke one.');
  process.exit(1);
}
console.log(`excision-residue selftest: OK — ${result.total} fixtures behave as recorded.`);
