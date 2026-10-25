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
 * SCOPE. The gate reads prose files only (owner decision 2026-10-16, #1734),
 * so the fixtures for PDF, Office, JSON and standalone HTML went with the
 * readers they tested. The raw-HTML cases that also apply inside Markdown
 * were kept as `.md` fixtures, and the "OUT OF SCOPE BY CONSTRUCTION" group
 * pins the boundary itself: non-prose files that name the retired surface and
 * must stay silent.
 *
 * READER. Since #1732/#1758 the gate reads through the standard parsers
 * (`packages/lib/src/markdownProse.mjs`), so many comments below name passes of
 * the hand-written reader it replaced (`tagSpans`, `crossesBlockBoundary`, the
 * fence walk). They are kept as the history of why each case exists; the
 * case, not the pass that once got it wrong, is what each fixture pins.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
// Unique per run. A FIXED path is reused if a developer already has a
// directory of that name, and the cleanup below then deletes their files —
// reported against the first version of this script, reproduced with a
// `developer-notes.txt` that the run silently removed.
const DIR = `__excision_selftest__${process.pid}_${Date.now().toString(36)}`;

/**
 * `caught: true` — the gate MUST report this file. `false` — must stay silent.
 *
 * `mentions`, where given, is the count the gate must report for the file.
 *
 * `digestSameAs` / `digestDiffersFrom` name another fixture whose digest this
 * one's must equal or differ from. They pin the fingerprint, which a verdict
 * cannot: retitling a governing heading leaves a file caught either way, and
 * whether its digest moves is the whole point (#1758's harness item). A pair
 * states the property (this edit must move it, that one must not) rather than
 * a literal hash, which would be unreadable and churn on unrelated changes.
 */
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
    // Round 10 P1. A container decoder once REPLACED the source text by
    // signature, so a `.md` opening with the four ZIP bytes was scanned as the
    // empty string. The decoders are gone with the prose scope (#1734); this
    // stays to pin that a prose file is always read as itself.
    name: 'pk-prefixed.md',
    caught: true,
    why: 'a text file cannot buy an exemption by opening with a ZIP signature',
    body: Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('\nOperators must deploy the VPFI buy adapter before launch.\n'),
    ]),
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
    // Round 11 P1, the same bypass as `pk-prefixed.md` one format over: a
    // `.md` opening with `%PDF` had its visible text replaced by a PDF
    // decoder's empty output. Kept for the same reason as that fixture.
    name: 'pdf-prefixed.md',
    caught: true,
    why: 'a text file cannot buy an exemption by opening with %PDF',
    body: '%PDF-1.4\nOperators must deploy the VPFI buy adapter before launch.\n',
  },
  {
    // Round 12 P1. A `\` before a delimiter makes it data, not structure:
    // `(https://example/a\)b)` is ONE destination containing a literal `)`.
    // Ending there left `b)` in the stream, wedging the label apart from the
    // word after it.
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
  // ── Round 29.
  {
    // The FOURTH "fixed one path, left its twin" on this gate. `.mdc` went
    // into the markup list and the Markdown flag but not the link-parsing
    // one, so destinations stayed in the rendered stream and separated the
    // words. The three spellings are one shared constant now.
    name: 'mdc-link-destination.mdc',
    caught: true,
    why: 'a Markdown rule file gets link parsing too, not just tag stripping',
    body: 'VPFI [buy](https://example.invalid/config) adapter is live.\n',
  },
  {
    // The excision spec removes `cfgVpfiFixedGlobalCap()` /
    // `cfgVpfiFixedWalletCap()`. Their STORAGE keys were in the inventory
    // under `vpfibuy…` spellings, but the readers carry a different one, so
    // guidance could restore a deleted reader without naming anything the
    // closed-world inventory knew.
    name: 'cap-reader-helper.md',
    caught: true,
    why: 'a removed reader helper is inventory, not just its storage key',
    body: 'Operators call cfgVpfiFixedGlobalCap to read the cap.\n',
  },
  // ── Round 27.
  {
    // A false NEGATIVE my own round-22 fix opened. Preserving UNRECOGNIZED
    // references fixed a false positive (`buy&bogus;adapter` is clean prose),
    // but `&Tab;` is a VALID reference that renders a tab and was simply
    // missing from the table — so it was preserved too, and its letters
    // wedged the phrase apart. The pair only works if the table is complete
    // for whitespace and punctuation; `unknown-entity.html` pins the other
    // half and must keep passing.
    name: 'valid-entity-untabled.md',
    caught: true,
    why: 'a valid whitespace reference renders as space, not as its own name',
    body: 'VPFI buy&Tab;adapter is live.\n',
  },
  {
    // `.mdc` is a Markdown rule file and the tree tracks one. Outside the
    // markup and Markdown classifications it was scanned as plain text, so
    // its inline HTML was never stripped.
    name: 'mdc-is-markdown.mdc',
    caught: true,
    why: 'a Markdown rule file gets the same treatment as its `.md` sibling',
    body: 'VPFI buy<strong>adapter</strong> is live.\n',
  },
  // ── Round 25.
  {
    // A false NEGATIVE, and a correct narrowing of something I refuted a
    // round earlier. The refutation held for its own case — a span CROSSING
    // an ordered marker carries the marker's digits and can never match. This
    // is a different mechanism: the marker manufactures a list CONTAINER
    // whose backticks open a fence, and the whole dead token then sits on a
    // later line, so no digits ever enter it.
    name: 'ordered-no-interrupt.md',
    caught: true,
    why: 'an ordered marker other than `1.` cannot interrupt a paragraph',
    body: 'intro\n2. ```\n   Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    // The same rule one container in. Paragraph tracking has to survive the
    // quote prefix, and the fixture beside this one only pins the top-level
    // spelling. Probed after the fix and kept because it fails against the
    // previous commit — six other probes run with it behaved identically
    // before and after and were dropped.
    name: 'ordered-no-interrupt-quoted.md',
    caught: true,
    why: 'the paragraph a marker cannot interrupt may itself be inside a quote',
    body: '> intro\n> 2. ```\n>    Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    // The control for the case above: `1.` DOES interrupt, so the list and
    // its fence are real and the content stays code. Without this, narrowing
    // the rule too far would pass unnoticed.
    name: 'ordered-one-interrupts.md',
    caught: false,
    why: '`1.` interrupts a paragraph, so its fence is a real fence',
    body: 'intro\n1. ```\n   Operators must deploy the VPFI buy<strong>adapter</strong> now.\n',
  },
  {
    name: 'quote-tab-marker.md',
    caught: false,
    why: 'tab stops are absolute, so a nested marker is measured from its parent',
    body: '> -\t```\n>   Decide what to buy<strong>adapter</strong> next.\n',
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
    name: 'synthesized-tag.md',
    caught: false,
    why: 'malformed markup must not be re-parsed into a tag that was never there',
    body: 'Configure buyOpti<o<strong>></strong>ns before deployment.\n',
  },

  // --- encodings that hide a phrase from a naive read ---

  // --- raw HTML inside Markdown: these were .html fixtures before the prose
  // scope (#1734). Markdown renders inline HTML, so each case still applies,
  // now in the one place the gate reads it. ---
  {
    // Round 16 P1, a regression from round 15's suffix fix. Stripping EVERY tag
    // in the gap removed block boundaries too, so `<p>…fixed-rate buy</p>` and
    // `<p>Back up config…</p>` read as the surviving `buyback` feature and a
    // real hit was suppressed before crossesBlockBoundary ever saw it.
    name: 'buyback-block-html.md',
    caught: true,
    why: 'a paragraph break is not intra-word, whatever the suffix says',
    body:
      '<p>Operators must use the fixed-rate buy</p><p>Back up config before launch.</p>\n',
  },
  {
    // Round 22 P2. Deleting every unrecognized named reference assumed they
    // all render as ignorable punctuation. A browser renders an unknown
    // reference as its own source text, so deleting it manufactured a dead
    // name out of clean prose.
    name: 'unknown-entity-html.md',
    caught: false,
    why: 'an unrecognized character reference stays visible and separates words',
    body: '<p>Decide what to buy&bogus;adapter selection follows.</p>\n',
  },
  {
    name: 'attr-colon-html.md',
    caught: true,
    why: 'attribute values are configuration, not sentences — `:` is not a prose boundary there',
    body: '<div data-operation="buy:adapter"></div>\n',
  },

  // --- #1758: the hand-written reader's grammar gaps, read by the parsers
  // since the gate moved onto micromark and the parse5 tokenizer. Each was a
  // reported, reproduced miss or false block. ---
  {
    name: 'named-ref-letters.md',
    caught: false,
    why: '`&fjlig;` renders the letters fj, which separate the words either side',
    body: 'Decide what to buy&fjlig;adapter selection follows.\n',
  },
  {
    name: 'named-ref-space.md',
    caught: true,
    why: 'every valid reference that renders as space is a space, not only a curated few',
    body: 'Operators must deploy the VPFI buy&ThickSpace;adapter now.\n',
  },
  {
    name: 'malformed-tag.md',
    caught: false,
    why: '`<x @>` is not a tag under CommonMark, so the reader sees it as text',
    body: 'Decide what to buy<x @>Adapter selection follows.\n',
  },
  {
    name: 'escaped-tag.md',
    caught: false,
    why: 'a backslash-escaped tag renders as its own text',
    body: 'Decide what to buy \\<strong>adapter\\</strong> selection follows.\n',
  },
  {
    name: 'inline-script-body.md',
    caught: true,
    why: 'a script body is not rendered, so the words either side of it are one phrase',
    body: 'Operators must deploy the VPFI buy<script>formatting note</script>adapter now.\n',
  },
  {
    name: 'script-body-scanned.md',
    caught: true,
    why: 'a hidden script body is still read, as code',
    body: '<script>\nconst note = "VPFI buy adapter";\n</script>\n',
  },
  {
    name: 'custom-element-inline.md',
    caught: true,
    why: 'a block element is matched by its whole name; `div-inline` renders inline',
    body: 'Operators must deploy the VPFI buy<div-inline>adapter</div-inline> now.\n',
  },
  {
    name: 'menu-is-block.md',
    caught: false,
    why: '`<menu>` is a block element, so it separates the text either side',
    body: 'Decide what to buy<menu>Adapter selection follows.</menu>\n',
  },
  {
    name: 'td-attribute.md',
    caught: true,
    why: 'a table cell tag outside a table keeps its attributes for the tokenizer',
    body: '<td data-operation="buyOptions">cell</td>\n',
  },
  {
    name: 'html-legacy-ref.md',
    caught: true,
    why: 'an HTML block decodes `&nbsp` without its semicolon, as a browser does',
    body: '<p>Operators must deploy the VPFI buy&nbspadapter now.</p>\n',
  },
  {
    name: 'quoted-heading-boundary.md',
    caught: false,
    why: 'a quoted heading is a block of its own',
    body: 'Decide what to buy\n> # Adapter selection follows\n',
  },
  {
    name: 'setext-single-dash.md',
    caught: false,
    why: 'a single `-` under a paragraph is a heading underline, and a heading is a boundary',
    body: 'Decide what to buy\n-\nAdapter selection follows.\n',
  },
  {
    name: 'not-a-destination.md',
    caught: false,
    why: '`[buy](a b)` is not a link, so its parentheses are text the reader sees',
    body: 'Decide what to [buy](a b)Adapter selection follows.\n',
  },
  {
    name: 'inline-script-entity.md',
    caught: false,
    why: 'a script inside a paragraph is read as its raw source, where a reference is not decoded',
    body: 'Decide what to buy<script>buy&ThickSpace;adapter</script> selection follows.\n',
  },
  {
    name: 'inline-script-emphasis.md',
    caught: true,
    why: 'a script inside a paragraph is one raw run, not split by the emphasis Markdown would see',
    body: 'Notes<script>VPFI buy*adapter*</script> follow.\n',
  },
  {
    name: 'fence-info-repeats-body.md',
    caught: true,
    mentions: 2,
    why: 'a fenced body that repeats its info string is a second mention, not the same one',
    body: '```buyOptions\nbuyOptions\n```\n',
  },
  {
    name: 'html-semicolonless-reference.md',
    caught: true,
    mentions: 2,
    why: 'a legacy HTML reference without its semicolon does not merge the two mentions after it',
    body: '<div>&nbsp buyOptions buyOptions</div>\n',
  },
  {
    name: 'html-attribute-reference.md',
    caught: true,
    mentions: 2,
    why: 'an attribute value decodes as parse5 decodes it, so the mentions after its reference keep their own places',
    body: '<span title="&notit; buyOptions buyOptions">x</span>\n',
  },
  {
    name: 'table-cells.md',
    caught: false,
    why: 'two table cells are two blocks',
    body: '| a | b |\n|---|---|\n| Decide what to buy | Adapter selection follows |\n',
  },

  // --- #1732 and #1758 (harness): the DIGEST, not the verdict. Each pair
  // differs in one line; `digestDiffersFrom` says that edit must move the
  // fingerprint, `digestSameAs` that it must not. Every file here is caught
  // with one mention, so the verdict cannot tell them apart. ---
  {
    name: 'digest-retraction.md',
    caught: true,
    why: 'base for the governing-sentence pair',
    body:
      'This surface was removed in #687-A and must not be\nused again. The notes below\nare kept for the record\nonly, so that readers\nknow the VPFI buy adapter\nonce existed.\n\nUnrelated note, first wording.\n',
  },
  {
    // #1732's reproduction: the sentence that decides whether the mention is a
    // record or an instruction sits five wrapped lines above it, outside the
    // two-line window the digest used to hash.
    name: 'digest-retraction-flipped.md',
    caught: true,
    digestDiffersFrom: 'digest-retraction.md',
    why: 'rewording the governing sentence of the same paragraph moves the digest',
    body:
      'This surface remains live and operators must keep\nusing it. The notes below\nare kept for the record\nonly, so that readers\nknow the VPFI buy adapter\nonce existed.\n\nUnrelated note, first wording.\n',
  },
  {
    name: 'digest-retraction-neighbour.md',
    caught: true,
    digestSameAs: 'digest-retraction.md',
    why: 'an edit to a different paragraph does not move the digest',
    body:
      'This surface was removed in #687-A and must not be\nused again. The notes below\nare kept for the record\nonly, so that readers\nknow the VPFI buy adapter\nonce existed.\n\nUnrelated note, reworded entirely.\n',
  },
  {
    name: 'digest-task.md',
    caught: true,
    why: 'base for the task-box pair',
    body: '- [x] Retire the VPFI buy adapter.\n',
  },
  {
    name: 'digest-task-unticked.md',
    caught: true,
    digestDiffersFrom: 'digest-task.md',
    why: 'the list item, task box included, is the unit',
    body: '- [ ] Retire the VPFI buy adapter.\n',
  },
  {
    name: 'digest-nested.md',
    caught: true,
    why: 'base for the nested-list pair',
    body: '- The VPFI buy adapter was removed.\n  - child note, first wording\n\n  Kept for the record.\n',
  },
  {
    name: 'digest-nested-child-edited.md',
    caught: true,
    digestSameAs: 'digest-nested.md',
    why: "a nested list between a parent item's own blocks is not part of the parent's fingerprint",
    body: '- The VPFI buy adapter was removed.\n  - child note, reworded entirely\n\n  Kept for the record.\n',
  },
  {
    name: 'digest-lead-in.md',
    caught: true,
    why: 'base for the parent lead-in pair',
    body: '- Removed contracts:\n  - VpfiBuyAdapter\n',
  },
  {
    name: 'digest-lead-in-reworded.md',
    caught: true,
    digestDiffersFrom: 'digest-lead-in.md',
    why: "a nested item reads under its parent's lead-in, so rewording the lead-in moves the nested mention's fingerprint",
    body: '- Live contracts:\n  - VpfiBuyAdapter\n',
  },
  {
    name: 'digest-column.md',
    caught: true,
    why: 'base for the column-header pair',
    body: '| Contract | Removed |\n|---|---|\n| VpfiBuyAdapter | Yes |\n',
  },
  {
    name: 'digest-column-relabelled.md',
    caught: true,
    digestDiffersFrom: 'digest-column.md',
    why: 'a data row reads under its column headers, so relabelling a column moves the row\'s fingerprint',
    body: '| Contract | Currently deployed |\n|---|---|\n| VpfiBuyAdapter | Yes |\n',
  },
  {
    name: 'digest-column-other-row.md',
    caught: true,
    digestSameAs: 'digest-column.md',
    why: 'another data row of the same table is not part of a row\'s fingerprint',
    body: '| Contract | Removed |\n|---|---|\n| VpfiBuyAdapter | Yes |\n| Other | No |\n',
  },
  {
    name: 'digest-item-table.md',
    caught: true,
    why: 'base for the table-in-item pair',
    body: '- These contracts were removed:\n\n  | VpfiBuyAdapter | x |\n  |---|---|\n  | a | b |\n',
  },
  {
    name: 'digest-item-table-reworded.md',
    caught: true,
    digestDiffersFrom: 'digest-item-table.md',
    why: "a table inside a list item reads under the item's lead-in, so rewording it moves the table's fingerprint",
    body: '- These contracts are currently deployed:\n\n  | VpfiBuyAdapter | x |\n  |---|---|\n  | a | b |\n',
  },
  {
    name: 'digest-bold-lead-in.md',
    caught: true,
    why: 'base for the bold lead-in pair',
    body: '**Status:** These contracts were removed.\n\nAn unrelated paragraph.\n\nVpfiBuyAdapter\n',
  },
  {
    name: 'digest-bold-lead-in-reworded.md',
    caught: true,
    digestDiffersFrom: 'digest-bold-lead-in.md',
    why: 'a bold lead-in governs with its whole paragraph, so rewording the status after its label moves the fingerprint',
    body: '**Status:** These contracts are currently deployed.\n\nAn unrelated paragraph.\n\nVpfiBuyAdapter\n',
  },
  {
    name: 'inline-textarea-emphasis.md',
    caught: false,
    why: 'a textarea inside a paragraph is RCDATA, so its asterisks are text and do not join a name',
    body: 'prefix<textarea>buy*Options*</textarea>suffix\n',
  },
  {
    name: 'inline-textarea-across-paragraphs.md',
    caught: false,
    why: 'a textarea an inline tag opens stays open past blank lines until its end tag, so the paragraphs inside are RCDATA, not emphasis',
    body: 'prefix<textarea>start\n\nbuy*Options*\n\n</textarea>suffix\n',
  },
  {
    name: 'inline-script-across-paragraphs.md',
    caught: false,
    why: 'a script an inline tag opens stays open past blank lines, so a reference after one is not decoded',
    body: 'prefix<script>start\n\nbuy&ThickSpace;adapter\n\n</script>suffix\n',
  },
  {
    name: 'footnote-reference-between-words.md',
    caught: false,
    why: 'a footnote reference renders a visible marker, so the words on either side are not one name',
    body: 'buy[^note]Options\n\n[^note]: separate note\n',
  },
  {
    name: 'html-prototype-tag.md',
    caught: false,
    why: 'a tag named after an Object property is an ordinary tag, not a tokenizer mode',
    body: '<constructor>Ordinary documentation.</constructor>\n',
  },
  {
    name: 'fence-tab-indented-body.md',
    caught: true,
    mentions: 2,
    why: 'a tab the parser expanded to spaces does not merge the mentions after it',
    body: ' ~~~\n\tbuyOptions buyOptions\n ~~~\n',
  },
  {
    name: 'digest-row.md',
    caught: true,
    why: 'base for the table-row pair',
    body: '| Contract | Status |\n|---|---|\n| VPFI buy adapter | Removed |\n',
  },
  {
    name: 'digest-row-status.md',
    caught: true,
    digestDiffersFrom: 'digest-row.md',
    why: 'the table row, not only the cell, is the unit',
    body: '| Contract | Status |\n|---|---|\n| VPFI buy adapter | Live |\n',
  },
  {
    name: 'digest-heading.md',
    caught: true,
    why: 'base for the heading pairs',
    body: '# Historical record\n\n## Notes\n\nThe VPFI buy adapter was deployed here.\n',
  },
  {
    name: 'digest-heading-retitled.md',
    caught: true,
    digestDiffersFrom: 'digest-heading.md',
    why: 'retitling a governing ancestor heading moves the digest',
    body: '# Current procedure\n\n## Notes\n\nThe VPFI buy adapter was deployed here.\n',
  },
  {
    name: 'digest-quote-scope.md',
    caught: true,
    why: 'base for the quoted-heading pair',
    body: '> ## Historical quoted note\n> Kept as written.\n\nThe VPFI buy adapter was removed.\n',
  },
  {
    name: 'digest-quote-scope-retitled.md',
    caught: true,
    digestSameAs: 'digest-quote-scope.md',
    why: 'a heading inside a quote stops governing when the quote ends',
    body: '> ## Current quoted note\n> Kept as written.\n\nThe VPFI buy adapter was removed.\n',
  },

  // --- plain text is prose and in scope ---
  {
    name: 'operator-notes.txt',
    caught: true,
    why: 'a plain-text document is prose, so a live instruction in one is caught',
    body: 'Operators must deploy the VPFI buy adapter before cutover.\n',
  },
  {
    // `#` and `*` mean nothing in plain text, so the Markdown structure rules
    // must not run there: this wrapped sentence is one phrase.
    name: 'wrapped-plain.txt',
    caught: true,
    why: 'a line starting with # is not a heading in plain text',
    body: 'Operators must deploy the VPFI buy\n# adapter before cutover.\n',
  },

  // --- OUT OF SCOPE BY CONSTRUCTION (owner decision 2026-10-16, #1734) ---
  // The gate reads prose files only. Each of these names the retired surface
  // in a file that is not prose, and each must stay SILENT: the scope is a
  // test on the file type, so no rule about the content can bring one back.
  // A failure here means the scope widened, which is a design change and
  // wants an owner decision, not a fixture update.
  {
    // The #1727 round-24 operator case that started #1734: valid JavaScript
    // naming neither surface, fused by prose normalization into `buyadapter`.
    name: 'operands.js',
    caught: false,
    why: 'source code is not prose; `buy + adapter` is two operands',
    body: 'export const total = buy + adapter;\n',
  },
  {
    name: 'copy.ts',
    caught: false,
    why: 'app copy in a source file is outside the prose scope (review catches it, not this gate)',
    body: 'export const msg = "Operators must deploy the VPFI buy adapter before cutover.";\n',
  },
  {
    name: 'help.sh',
    caught: false,
    why: 'shell help text is outside the prose scope',
    body: 'echo "Deploy the VPFI buy adapter before cutover."\n',
  },
  {
    name: 'values.json',
    caught: false,
    why: 'JSON is data, not prose',
    body: '["Decide what to buy", "Adapter selection follows"]\n',
  },
  {
    name: 'page.html',
    caught: false,
    why: 'a standalone HTML file is app source here, outside the prose scope',
    body: '<p>Operators must deploy the VPFI buy adapter before cutover.</p>\n',
  },
  {
    name: 'runbook.pdf',
    caught: false,
    why: 'a container-format document is outside the prose scope',
    body: '%PDF-1.4\nBT (Operators must deploy the VPFI buy adapter) Tj ET\n',
  },
];

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function run() {
  const all = FIXTURES.map((f) => ({ ...f, buf: Buffer.from(f.body) }));
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
  // A new file's line carries its digest: `  <path>  (<n> mention(s))   digest <hex>`.
  const digestOf = (name) => {
    const line = output.split('\n').find((l) => l.trim().startsWith(`${DIR}/${name} `));
    const m = line && /digest ([0-9a-f]{12})\b/.exec(line);
    return m ? m[1] : null;
  };
  for (const f of all) {
    const reported = output.includes(`${DIR}/${f.name}`);
    if (f.mentions !== undefined) {
      const line = output.split('\n').find((l) => l.trim().startsWith(`${DIR}/${f.name} `));
      const m = line && /\((\d+) mention/.exec(line);
      const got = m ? Number(m[1]) : 0;
      if (got !== f.mentions) {
        failures.push(`  ${f.name}\n      expected ${f.mentions} mention(s), got ${got}\n      ${f.why}`);
      }
    }
    if (reported !== f.caught) {
      failures.push(
        `  ${f.name}\n      expected ${f.caught ? 'CAUGHT' : 'clean'}, got ${reported ? 'CAUGHT' : 'clean'}\n      ${f.why}`,
      );
    }
    const other = f.digestSameAs ?? f.digestDiffersFrom;
    if (other) {
      const mine = digestOf(f.name);
      const theirs = digestOf(other);
      const wantSame = f.digestSameAs !== undefined;
      if (!mine || !theirs || (mine === theirs) !== wantSame) {
        failures.push(
          `  ${f.name}\n      expected its digest ${wantSame ? 'EQUAL to' : 'DIFFERENT from'} ${other}'s, ` +
            `got ${mine ?? 'none'} vs ${theirs ?? 'none'}\n      ${f.why}`,
        );
      }
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
