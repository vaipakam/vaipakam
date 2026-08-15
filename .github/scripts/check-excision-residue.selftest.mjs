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
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

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
