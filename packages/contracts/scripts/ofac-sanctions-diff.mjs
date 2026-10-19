#!/usr/bin/env node
/**
 * #2443 — OFAC SDN → `SanctionsList` DIFF TOOL (offline; signs nothing, sends
 * nothing).
 *
 * The mainnet sanctions source is Vaipakam's own on-chain `SanctionsList`
 * (OR-composed with RedStone's oracle where deployed). Each OFAC publication
 * reaches it as one update, split by signer (step 4). This tool computes that update:
 *
 *   1. Reads Treasury's SDN Advanced XML (`sdn_advanced.xml`) from a local
 *      file (`--xml`) or downloads it (`--fetch` with `--save-xml`, so the
 *      exact bytes behind the recorded hash are kept). Either way the file
 *      is read from disk in pieces, never held whole in memory: parsing the
 *      128 MB 2026-10 publication needs about the size of its result.
 *   2. Extracts every EVM-format digital-currency address (`0x` + 40 hex)
 *      listed under ANY "Digital Currency Address - *" feature type — an
 *      EVM-shaped address is the same key on every EVM chain, whatever asset
 *      label OFAC filed it under. Features whose reliability is "False" are
 *      excluded and reported. Addresses are checksummed and de-duplicated.
 *      Every `0x`/`0X`-prefixed value that is not exactly an address is
 *      reported, raw, as malformed for a human — never guessed at.
 *   3. Reads the CURRENT list from the deployed contract, and only from it,
 *      at ONE pinned block (`--rpc` + `--list`; always the chain's
 *      `finalized` block, Codex #2543 r20, so no reorg can replace the state
 *      an update is computed from); the block is resolved once to its HASH and every
 *      read — version, publication, hash, outstanding counts, count, each
 *      page — is pinned to it by EIP-1898 with `requireCanonical`, using the
 *      census tooling's helper). A file of addresses is not accepted: nothing
 *      ties it to the version it would claim (Codex #2543 r10).
 *   4. Prints the add / remove sets, the source SHA-256 and publication date
 *      (`DateOfIssue` as `YYYYMMDD`), and the ready `applyUpdate` calls, each
 *      carrying the list version it applies to, so it cannot apply to any
 *      other state. Additions and delistings are SEPARATE calls with separate
 *      signers (owner decision 2026-10-18): the adder (the automated
 *      updater) sends the additions, then the remover (the multisig) sends
 *      the delistings against the same publication, both in batches of
 *      `--max-changes-per-call` (default 200) so a large publication fits
 *      each transaction's gas. The contract refuses a delisting from anyone but a
 *      remover. Each call states how many of the publication's additions and
 *      delistings remain after it; the list publishes those counts.
 *
 * WHAT IT REFUSES, AND WHY:
 *   - An INCOMPLETE or malformed document (Codex #2543 r1/r2). ONE tokenizer
 *     (`scanXml`) reads the whole input once; the completeness check and the
 *     extraction consume the same token stream, and no regex ever runs over
 *     raw text, so a comment, processing instruction, CDATA section or
 *     attribute value can never be read as an element. The pass requires every
 *     tag terminated with well-formed, unique, quoted attributes, every element
 *     closed in order, exactly one `<Sanctions>` root closed at the end, and
 *     nothing but whitespace, comments or processing instructions outside it.
 *     A truncated download fails wherever it was cut. CDATA content is
 *     DECODED as the literal text it is by definition (never parsed as
 *     markup); the five predefined entities and numeric character references
 *     are decoded in text and attribute values, and any other entity or a bare
 *     `&` is refused. A DOCTYPE is refused outright (OFAC's file has none, and
 *     an internal subset needs a grammar). This is a structural
 *     well-formedness check, not a full XML 1.0 validator: character-class and
 *     encoding rules would need a parser dependency, and they are not what a
 *     truncated, spliced or commented file breaks.
 *   - A schema version other than the one whose paths it reads (the root
 *     `Version`, today 3), and bytes that are not valid UTF-8 (Codex #2543
 *     r10, r11): a revised layout or a corrupted byte would otherwise read
 *     as a smaller list and delist the difference.
 *   - A file in which it finds NO EVM address, no `DateOfIssue`, or no
 *     digital-currency feature types. A parser that silently finds nothing
 *     would emit a diff that delists everyone.
 *   - A publication that is not NEWER than the one the list records — an
 *     older file would re-list delisted addresses and drop newer designations
 *     while still diffing cleanly against the current state. The same date is
 *     accepted only to finish what that same file declared outstanding
 *     (identical hash, adding no more than its outstanding additions). The
 *     contract enforces the same rule; `--allow-rollback` builds the update
 *     anyway and prints the owner's `authorizePublicationRollback` call that
 *     must be executed first.
 *   - A numeric flag that is not a plain non-negative integer (one parser for
 *     all of them), so a typo cannot silently disable a guard.
 *   - A diff removing more than `--max-remove` addresses (default 10). OFAC
 *     delistings are rare; a large removal set more likely means a truncated
 *     or changed file. Raising the bound is a deliberate act.
 *
 * OPTIONAL ONE-TIME CROSS-CHECK against the RETIRED Chainalysis oracle
 * (`--chainalysis-list <file>`, or `--chainalysis-rpc` + `--chainalysis-oracle`
 * + `--chainalysis-from-block`). It reports three sets — in both, OFAC-only,
 * Chainalysis-only — for HUMAN REVIEW ONLY. Chainalysis-only addresses are
 * never added to the update: that list froze on 2026-03-18 and never removes
 * a delisting made after it, so "Chainalysis has it" is not evidence an
 * address is sanctioned today. Vaipakam's contracts never read that oracle
 * and nothing is configured to it; this tool only replays its public logs.
 *   - Events replayed: `SanctionedAddressesAdded(address[])` and
 *     `SanctionedAddressesRemoved(address[])`, verified against the Sourcify
 *     full-match source of the Ethereum-mainnet deployment
 *     0x40C57923924B5c5c5455c48D93317139ADDaC8fb. The single-address
 *     `SanctionedAddress(address)` event is emitted by `isSanctionedVerbose`,
 *     a CHECK, not a listing, and is deliberately ignored.
 *   - Known deployments: 0x40C57923924B5c5c5455c48D93317139ADDaC8fb (most
 *     chains) and 0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B (Base, NOT
 *     source-verified by us). The address is always an explicit input, and
 *     the tool refuses a contract whose `name()` does not identify itself as
 *     Chainalysis's oracle.
 *
 * Every RPC URL is an input; there are no defaults (an RPC URL often carries
 * a key). `--fetch` uses Node's `fetch`; behind a proxy set
 * `NODE_USE_ENV_PROXY=1`.
 *
 * Usage:
 *   node scripts/ofac-sanctions-diff.mjs --xml sdn_advanced.xml \
 *     --rpc "$RPC" --chain-id 8453 --list 0xList [--confirm-delist 0xA,0xB] [--out update.json]
 *   node scripts/ofac-sanctions-diff.mjs --fetch --save-xml sdn.xml \
 *     --rpc "$RPC" --chain-id 8453 --list 0xList [--max-changes-per-call 200]
 *   … [--chainalysis-rpc "$RPC" --chainalysis-oracle 0x40C5… \
 *      --chainalysis-from-block 14356508 [--log-chunk 10000]]
 *   … [--chainalysis-list chainalysis.json]
 *
 * The signers are decided (owner, 2026-10-18): the adder lists, the multisig
 * remover delists. Where the adder runs is still OPEN (#2443); this tool
 * deliberately stops at calldata.
 */
import { createReadStream, createWriteStream, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, getAddress, encodeFunctionData, parseAbi, parseAbiItem } from 'viem';
// The census tooling's EIP-1898 helper: every state read below is pinned to
// ONE block by HASH with requireCanonical, never by number (Codex #2543 r2).
import { callAtHash } from './census-grandfathered-custody.mjs';
import { isEntryPoint } from './entry-point.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The root namespace OFAC's SDN Advanced export declares. */
export const OFAC_SDN_ADVANCED_NAMESPACE =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML';
/**
 * The root `Version` of the SDN Advanced schema whose paths {@link SDN_PATHS}
 * names. Any other version is refused.
 */
export const OFAC_SDN_ADVANCED_SCHEMA_VERSION = '3';
export const OFAC_SDN_ADVANCED_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML';
export const DEFAULT_MAX_REMOVE = 10;
/**
 * Addresses per `applyUpdate` call, additions and delistings alike. Listing
 * one address costs roughly 70k gas (two set slots, the version stamp, an
 * event) and delisting one less, so 200 stays near 14M gas — under the 2^24
 * per-transaction cap (EIP-7825) and every target chain's block limit.
 * `--max-changes-per-call` changes it.
 */
export const DEFAULT_MAX_CHANGES_PER_CALL = 200;
/** The largest download accepted as a publication: 4× the 2026-10 file (128 MB). */
export const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;

const DCA_PREFIX = 'Digital Currency Address - ';
/** OFAC's reliability vocabulary — the whole of it, as published in schema version 3. */
const RELIABILITY_VALUES = new Set(['Confirmed', 'False', 'Reported', 'Unknown']);
/** The `DetailType` name an address detail carries in OFAC's schema. */
const ADDRESS_DETAIL_TYPE = 'TEXT';
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
/** The zero address: EVM-shaped, but the contract refuses to list or delist it. */
const ZERO_RE = /^0x0{40}$/i;
const HEX_PREFIX_RE = /^0x/i;
/** A run of at least an address's 40 hex digits, anywhere in the source. */
const HEX_RUN_RE = /[0-9a-fA-F]{40,}/g;
const isHexDigit = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * The delisting witness's view of a file: every maximal run of 40+ hex
 * digits, kept with repeats, in two streams (Codex #2543 r19/r20, #2567 r1).
 *   raw(piece)  — the file's text as it arrives. A run can straddle two
 *     pieces, so the hex digits that end a piece wait for the next one.
 *   text(value) — the tokenizer's decoded character data. One element's value
 *     can reach it in several calls — text, then a CDATA section, around a
 *     comment — so the same carry applies across calls: a run split that way
 *     is one run of the decoded text, never two short ones the witness would
 *     miss. Nothing resets the carry, not even an element boundary: joining
 *     two adjacent values can only ADD a mention, which refuses a delisting,
 *     never permits one.
 * `end()` counts both carries and returns `{ raw, text }`. Both OFAC parsers
 * use this one collector, so the witness rule cannot differ between them.
 */
export function createHexRunCollector() {
  const runs = { raw: [], text: [] };
  const carry = { raw: '', text: '' };
  const feed = (stream, s, last) => {
    const joined = carry[stream] + s;
    let cut = joined.length;
    if (!last) while (cut > 0 && isHexDigit(joined.charCodeAt(cut - 1))) cut--;
    for (const run of joined.slice(0, cut).match(HEX_RUN_RE) ?? []) runs[stream].push(run.toLowerCase());
    carry[stream] = joined.slice(cut);
  };
  return {
    raw: (piece) => feed('raw', piece, false),
    text: (value) => feed('text', value, false),
    end() {
      feed('raw', '', true);
      feed('text', '', true);
      return runs;
    },
  };
}

/**
 * A copy of `s` that shares no memory with the text it was cut from. V8 may
 * keep a substring as a view into its parent, so a value cut from a 1 MiB
 * piece of the file would keep that whole piece alive for as long as the
 * value is kept — and the parse keeps every record until the end, which
 * would hold the entire file again. Kept values are copied through here.
 */
const own = (s) => (typeof s === 'string' && s.length > 0 ? Buffer.from(s, 'utf8').toString('utf8') : s);

/** The compiled `SanctionsList` ABI — never hand-typed. */
export function sanctionsListAbi() {
  return JSON.parse(readFileSync(join(HERE, '..', 'src', 'abis', 'SanctionsList.json'), 'utf8'));
}

/** SHA-256 of the exact source bytes, as `0x`-prefixed hex (bytes32). */
export function sourceHash(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Index of the `>` that ends the tag opened at `lt`, skipping quoted
 *  attribute values; -1 when the input ends first. */
function tagEnd(xml, lt) {
  let quote = 0;
  for (let i = lt + 1; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 62) return i;
  }
  return -1;
}

/**
 * One grammar for every element and attribute name: an XML qualified name
 * (Namespaces in XML §4), an NCName optionally preceded by ONE `prefix:`.
 * A name with a second colon is not a QName, so it is refused as malformed
 * instead of resolving its first prefix and dispatching on a "local name"
 * that still carries a colon (Codex #2543 r16). ASCII NCNames only — every
 * name in OFAC's schema is one.
 */
const NCNAME = '[A-Za-z_][\\w.-]*';
const QNAME = `${NCNAME}(?::${NCNAME})?`;
const NAME_RE = new RegExp(`^${QNAME}`);
const ATTR_RE = new RegExp(`\\s+(${QNAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'y');
const PREDEFINED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/**
 * A character outside XML 1.0's `Char` production (§2.2): C0 controls other
 * than tab/LF/CR, surrogates, U+FFFE/U+FFFF. A document carrying one, as a
 * literal or as a character reference, is not well-formed, and its text is
 * not data this tool may act on (Codex #2543 r19).
 */
const NON_XML_CHAR = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

/**
 * Decode the XML-predefined entities and numeric character references in
 * text or an attribute value. Any other `&…` (a named entity, which would
 * need a DTD, or a bare `&`) is refused rather than passed through: a value
 * that cannot be decoded exactly is not data this tool may act on.
 */
export function decodeXmlText(raw, offset = 0) {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s]*);?/g, (whole, ref) => {
    if (!whole.endsWith(';')) throw new Error(`malformed XML: bare '&' near offset ${offset}`);
    if (ref in PREDEFINED_ENTITIES) return PREDEFINED_ENTITIES[ref];
    const num = /^#x([0-9a-fA-F]+)$/.exec(ref) ?? /^#([0-9]+)$/.exec(ref);
    if (num) {
      const cp = Number.parseInt(num[1], ref[1] === 'x' ? 16 : 10);
      if (!Number.isSafeInteger(cp) || cp > 0x10ffff || NON_XML_CHAR.test(String.fromCodePoint(cp))) {
        throw new Error(`malformed XML: &${ref}; near offset ${offset} is not an XML character`);
      }
      return String.fromCodePoint(cp);
    }
    throw new Error(`refusing the undeclared entity &${ref}; near offset ${offset}`);
  });
}

/** `name` without a namespace prefix. */
const localName = (name) => name.slice(name.indexOf(':') + 1);

/** The one prefix XML binds without a declaration (Namespaces in XML §3). */
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * The element's namespace scope: the parent's bindings plus any `xmlns` /
 * `xmlns:p` declared on the element itself. `''` under the key `''` means no
 * default namespace (an `xmlns=""` undeclaration).
 */
function scopeWith(parent, attrs, offset) {
  let scope = parent;
  for (const [k, v] of attrs) {
    if (k !== 'xmlns' && !k.startsWith('xmlns:')) continue;
    const prefix = k === 'xmlns' ? '' : k.slice(6);
    if (prefix === 'xmlns' || (prefix === 'xml' && v !== XML_NS)) throw new Error(`malformed XML: reserved prefix ${prefix} rebound at offset ${offset}`);
    if (prefix !== '' && v === '') throw new Error(`malformed XML: prefix ${prefix} undeclared at offset ${offset}`);
    if (scope === parent) scope = new Map(parent);
    scope.set(prefix, v);
  }
  return scope;
}

/** Expanded namespace of a qualified element name in `scope`; throws on an unbound prefix. */
function resolveNs(qname, scope, offset) {
  const c = qname.indexOf(':');
  if (c === -1) return scope.get('') ?? '';
  const prefix = qname.slice(0, c);
  const ns = scope.get(prefix);
  if (ns === undefined) throw new Error(`malformed XML: unbound namespace prefix ${prefix} in <${qname}> at offset ${offset}`);
  return ns;
}

/**
 * THE tokenizer (Codex #2543 r1/r2). One pass over the WHOLE input that both
 * proves the document complete and drives extraction, so nothing reads raw
 * text with a regex afterwards: a comment, a processing instruction, CDATA
 * content or an attribute value can never be mistaken for an element.
 *
 * It throws unless every tag is terminated and its attributes are
 * well-formed, every element is closed in order, one root named `rootName`
 * closes at the end, and only whitespace, comments or processing
 * instructions lie outside it. A DOCTYPE is refused (OFAC's file has none,
 * and an internal subset would need a grammar). This is a structural
 * well-formedness check, not a full XML 1.0 validator — see the header.
 *
 * It is namespace-aware (Codex #2543 r4): every element's prefix is resolved
 * against the `xmlns` declarations in scope, an unbound prefix is refused,
 * and handlers receive the EXPANDED namespace beside the local name, so a
 * consumer matches on (namespace, local name) — never on a prefix or on a
 * local name alone.
 *
 * Handlers, all optional, receive LOCAL names (no prefix) and the element's
 * namespace URI (`''` when it is in no namespace):
 *   open(name, attrs, depth, ns)   attrs: Map of decoded attribute values
 *   close(name, depth, ns)
 *   text(value)                decoded character data, including CDATA
 *                              content, which is literal text by definition
 *                              (decoded, never parsed as markup).
 */
export function scanXml(xml, handlers = {}, rootName = 'Sanctions') {
  const scanner = createXmlScanner(handlers, rootName);
  scanner.write(xml);
  scanner.end();
}

/**
 * {@link scanXml} fed in pieces, so a 128 MB publication is never held in
 * memory as one string (#2443 adder host). `write(chunk)` takes the next
 * piece of decoded text, `end()` says there is no more. Every construct is
 * handled only once it is COMPLETE in the buffered text — text up to the
 * next `<`, a tag up to its `>`, a comment up to `-->` — so the handlers see
 * exactly what one whole-document pass would show them, wherever the pieces
 * happen to be cut, and every rule {@link scanXml} states holds unchanged.
 * Offsets in errors are counted from the start of the document.
 */
export function createXmlScanner(handlers = {}, rootName = 'Sanctions') {
  const { open = () => {}, close = () => {}, text = () => {} } = handlers;
  const stack = []; // { name, ns, scope }
  const BASE_SCOPE = new Map([['xml', XML_NS]]);
  let root = null;
  let rootClosed = false;
  let buf = ''; // text not yet handled
  let base = 0; // document offset of buf[0]
  let started = false;
  let carry = ''; // a high surrogate cut off at the end of the last piece
  let ended = false;
  // The longest opening a construct is told apart by (`<![CDATA[`): with
  // fewer characters buffered after a `<`, more input may change its kind.
  const LONGEST_OPENER = 9;

  // Handle every complete construct in `buf`; with `final`, everything left.
  function drain(final) {
    const xml = buf;
    const n = xml.length;
    let i = 0;
    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt === -1 && !final) break; // the text may continue in the next piece
      const textEnd = lt === -1 ? n : lt;
      if (textEnd > i) {
        const raw = xml.slice(i, textEnd);
        if (stack.length === 0) {
          if (/\S/.test(raw)) throw new Error(`incomplete XML: content outside the root element at offset ${base + i}`);
        } else text(decodeXmlText(raw, base + i));
        i = textEnd;
      }
      if (lt === -1) break;
      if (!final && n - lt < LONGEST_OPENER) break;
      // -1: the construct is not complete in what is buffered yet.
      const closer = (token, from) => {
        const e = xml.indexOf(token, from);
        if (e === -1 && final) throw new Error(`incomplete XML: unterminated construct at offset ${base + lt}`);
        return e;
      };
      if (xml.startsWith('<!--', lt)) {
        const e = closer('-->', lt + 4);
        if (e === -1) break;
        i = e + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        if (stack.length === 0) throw new Error(`incomplete XML: CDATA outside the root at offset ${base + lt}`);
        const e = closer(']]>', lt + 9);
        if (e === -1) break;
        text(xml.slice(lt + 9, e));
        i = e + 3;
        continue;
      }
      if (xml.startsWith('<?', lt)) {
        const e = closer('?>', lt + 2);
        if (e === -1) break;
        i = e + 2;
        continue;
      }
      if (xml.startsWith('<!', lt)) throw new Error(`refusing a DOCTYPE or markup declaration at offset ${base + lt}`);
      const gt = tagEnd(xml, lt);
      if (gt === -1) {
        if (final) throw new Error(`incomplete XML: unterminated tag at offset ${base + lt}`);
        break;
      }
      tag(xml.slice(lt + 1, gt), base + lt);
      i = gt + 1;
    }
    buf = xml.slice(i);
    base += i;
  }

  // One complete tag; `body` is what lies between its `<` and `>`.
  function tag(body, lt) {
    if (body.startsWith('/')) {
      const name = body.slice(1).trimEnd();
      const top = stack.pop();
      if (top === undefined || top.name !== name) {
        throw new Error(`malformed XML: </${name}> at offset ${lt} closes ${top === undefined ? 'nothing' : `<${top.name}>`}`);
      }
      close(localName(name), stack.length, top.ns);
      if (stack.length === 0) rootClosed = true;
      return;
    }
    const m = body.match(NAME_RE);
    if (!m) throw new Error(`malformed XML: bad tag at offset ${lt}`);
    const name = m[0];
    // The name must end where the tag's attributes or end begin; anything
    // else (a second colon, a stray character) means it is not a QName.
    if (body.length > name.length && !/[\s/]/.test(body[name.length])) {
      throw new Error(`malformed XML: <${body.split(/[\s/]/)[0]}> at offset ${lt} is not a valid qualified name`);
    }
    if (rootClosed || (stack.length === 0 && root !== null)) throw new Error(`malformed XML: second root element <${name}> at offset ${lt}`);
    const selfClosing = body.endsWith('/');
    const attrText = body.slice(name.length, selfClosing ? -1 : undefined);
    const attrs = new Map();
    ATTR_RE.lastIndex = 0;
    let at = 0;
    for (let a; (a = ATTR_RE.exec(attrText)); at = ATTR_RE.lastIndex) {
      if (attrs.has(a[1])) throw new Error(`malformed XML: duplicate attribute ${a[1]} at offset ${lt}`);
      attrs.set(a[1], decodeXmlText(a[2] ?? a[3], lt));
    }
    if (/\S/.test(attrText.slice(at))) throw new Error(`malformed XML: bad attribute syntax in <${name}> at offset ${lt}`);
    if (root === null) {
      root = name;
      if (localName(name) !== rootName) throw new Error(`unexpected root element <${name}> (want <${rootName}>)`);
    }
    const scope = scopeWith(stack.length ? stack[stack.length - 1].scope : BASE_SCOPE, attrs, lt);
    const ns = resolveNs(name, scope, lt);
    open(localName(name), attrs, stack.length, ns);
    if (selfClosing) {
      close(localName(name), stack.length, ns);
      if (stack.length === 0) rootClosed = true;
    } else stack.push({ name, ns, scope });
  }

  function checkChars(s) {
    const bad = NON_XML_CHAR.exec(s);
    if (bad) {
      throw new Error(`malformed XML: U+${bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} at offset ${base + buf.length + bad.index} is not an XML character`);
    }
  }

  return {
    write(chunk) {
      if (ended) throw new Error('the XML scanner was already ended');
      let s = carry + chunk;
      carry = '';
      // A surrogate pair cut between two pieces is one character: hold its
      // first half until the second arrives.
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        carry = s.slice(-1);
        s = s.slice(0, -1);
      }
      if (!started && s.length > 0) {
        started = true;
        if (s.charCodeAt(0) === 0xfeff) {
          s = s.slice(1);
          base = 1;
        }
      }
      checkChars(s);
      buf += s;
      drain(false);
    },
    end() {
      if (ended) throw new Error('the XML scanner was already ended');
      ended = true;
      if (carry) checkChars(carry);
      drain(true);
      if (root === null) throw new Error('incomplete XML: no root element');
      if (stack.length) throw new Error(`incomplete XML: ${stack.length} element(s) never closed, innermost <${stack[stack.length - 1].name}> — the file is truncated`);
    },
  };
}

/** Throws unless `xml` is a complete document — {@link scanXml} with no handlers. */
export function assertCompleteXml(xml, rootName = 'Sanctions') {
  scanXml(xml, {}, rootName);
}

/**
 * The one parser for every numeric flag: a plain decimal non-negative
 * integer within [min, max], as a BigInt. `NaN`, `1e3`, `-1`, `ten`, `0x10`
 * and the empty string are all refused.
 */
export function parseUintArg(flag, value, { min = 0n, max } = {}) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative decimal integer, got "${value}"`);
  }
  const v = BigInt(value);
  if (v < min || (max !== undefined && v > max)) {
    throw new Error(`${flag} must be between ${min} and ${max ?? 'unbounded'}, got ${v}`);
  }
  return v;
}

/**
 * True iff `d` is a real calendar date as `YYYYMMDD`, years 2000–2999 — the
 * contract's rule, month lengths and leap years included (Codex #2543 r10):
 * the date orders publications, so an impossible one is refused, not sorted.
 */
export function isPublicationDate(d) {
  if (!Number.isInteger(d)) return false;
  const year = Math.floor(d / 10000);
  const month = Math.floor(d / 100) % 100;
  const day = d % 100;
  if (year < 2000 || year > 2999 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= days;
}

/**
 * Decode the source bytes as UTF-8, refusing any invalid sequence (Codex
 * #2543 r10). A lenient decode turns a corrupted byte into U+FFFD, and a
 * corrupted address then reads as a non-EVM value — silently dropped, and
 * delisted if it was listed. The hash is taken over the same bytes.
 */
export function decodeSource(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('the source file is not valid UTF-8 — refusing a file whose bytes were corrupted');
  }
}

/**
 * Parse a publication from its BYTES as they arrive — any async iterable of
 * byte chunks, such as a file stream (#2443 adder host). One pass computes
 * the source hash over exactly the bytes parsed, decodes them as UTF-8 with
 * the same refusal as {@link decodeSource}, and feeds the text to
 * {@link createSdnParser}; nothing holds the whole file, so memory stays at
 * the size of the parse result rather than the 128 MB publication.
 */
export async function parseSdnAdvancedStream(chunks) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = createSdnParser();
  let byteLength = 0;
  const decode = (bytes, stream) => {
    try {
      return decoder.decode(bytes, { stream });
    } catch {
      throw new Error('the source file is not valid UTF-8 — refusing a file whose bytes were corrupted');
    }
  };
  for await (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    hash.update(bytes);
    byteLength += bytes.length;
    parser.write(decode(bytes, true));
  }
  parser.write(decode(undefined, false));
  return { parsed: parser.end(), sourceHash: `0x${hash.digest('hex')}`, byteLength };
}

/** {@link parseSdnAdvancedStream} over a file on disk, read in 1 MiB pieces. */
export function parseSdnAdvancedFile(path) {
  return parseSdnAdvancedStream(createReadStream(path, { highWaterMark: 1 << 20 }));
}

/**
 * Download a publication to `path`, streaming it to disk — never into memory
 * — and refusing a response larger than `maxBytes`. The file is written to
 * `path + '.part'` and renamed only once complete, so a cut transfer never
 * leaves something at `path` that looks like a publication.
 */
export async function downloadToFile(url, path, { maxBytes = DEFAULT_MAX_SOURCE_BYTES, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download of ${url} failed: HTTP ${res.status}`);
  if (!res.body) throw new Error(`download of ${url} returned no body`);
  const part = `${path}.part`;
  const file = createWriteStream(part);
  let size = 0;
  try {
    // `pipeline` owns the streams: an error from the response, the size cap
    // or the file (it cannot be opened, the disk fills) rejects this call and
    // destroys both ends, instead of surfacing as an unhandled stream event
    // that would end the process before its caller could report.
    await pipeline(
      res.body,
      async function* capped(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxBytes) throw new Error(`download of ${url} exceeds ${maxBytes} bytes — refusing it`);
          yield chunk;
        }
      },
      file,
    );
  } catch (e) {
    // The write stream opens its file asynchronously; a refusal that lands
    // before that open completes would see the partial file created AFTER
    // it was removed. Wait for the stream to close, then remove.
    if (!file.closed) await new Promise((resolve) => file.once('close', resolve));
    rmSync(part, { force: true });
    throw e;
  }
  renameSync(part, path);
  return size;
}

/**
 * The contract's publication-order rule, applied before calldata is built:
 * a newer date passes; the same publication (identical date and hash) passes
 * again only to finish what it declared outstanding — adding no more than
 * `pendingAdditions` and delisting no more than `pendingDelistings` (a
 * refresh, the adder's next batch, or the remover completing its
 * delistings); anything else is refused unless
 * `allowRollback`, in which case the owner must authorize it on-chain first.
 */
export function checkPublicationOrder({
  recordedDate,
  recordedHash,
  date,
  hash,
  additions,
  removals = 0,
  pendingAdditions = 0,
  pendingDelistings = 0,
  allowRollback = false,
}) {
  if (date > recordedDate) return 'newer';
  const sameFile = date === recordedDate && hash.toLowerCase() === String(recordedHash).toLowerCase();
  if (sameFile && additions <= pendingAdditions && removals <= pendingDelistings) return 'same-publication';
  if (allowRollback) return 'rollback';
  if (sameFile) {
    throw new Error(`the list already records this exact file (${date}) yet differs from it — investigate before updating`);
  }
  throw new Error(
    `publication ${date} (${hash}) is not newer than the recorded ${recordedDate} (${recordedHash}); a rollback or a same-day reissue needs --allow-rollback and the owner's authorizePublicationRollback`,
  );
}

/**
 * The ONLY places the parser reads, as full paths from the root (Codex #2543
 * r5). An element is matched on its whole ancestry, never on its local name,
 * so a same-named element anywhere else in the document — a schema-invalid
 * splice, or a future OFAC element that happens to reuse a name — is never
 * read as sanctions data.
 */
const PARTY_FEATURE = 'Sanctions/DistinctParties/DistinctParty/Profile/Feature';
export const SDN_PATHS = Object.freeze({
  dateOfIssue: 'Sanctions/DateOfIssue',
  year: 'Sanctions/DateOfIssue/Year',
  month: 'Sanctions/DateOfIssue/Month',
  day: 'Sanctions/DateOfIssue/Day',
  featureType: 'Sanctions/ReferenceValueSets/FeatureTypeValues/FeatureType',
  reliability: 'Sanctions/ReferenceValueSets/ReliabilityValues/Reliability',
  detailType: 'Sanctions/ReferenceValueSets/DetailTypeValues/DetailType',
  feature: PARTY_FEATURE,
  featureVersion: `${PARTY_FEATURE}/FeatureVersion`,
  versionDetail: `${PARTY_FEATURE}/FeatureVersion/VersionDetail`,
});
/**
 * Names the schema also uses on paths this tool does not read (dates of
 * birth, document dates, entry events all carry Year/Month/Day). The
 * publication date's own parts are mandatory singletons, so a misplaced one
 * is already refused as missing.
 */
const SHARED_NAMES = new Set(['Year', 'Month', 'Day']);
/**
 * Every element name on a path this tool reads, mapped to the one path it
 * may appear on (Codex #2543 r17). Derived from {@link SDN_PATHS}, so a node
 * of the record structure found anywhere else — under an extra wrapper, one
 * level up, in a sibling subtree — refuses the file instead of being skipped
 * as unrelated structure, which would drop its record and delist its address.
 * In the real 2026-10-15 publication each of these names occurs only on its
 * path.
 */
const ANCHORED_PATHS = (() => {
  const anchored = new Map();
  for (const full of Object.values(SDN_PATHS)) {
    const parts = full.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (SHARED_NAMES.has(parts[i])) continue;
      const at = parts.slice(0, i + 1).join('/');
      const prior = anchored.get(parts[i]);
      if (prior !== undefined && prior !== at) throw new Error(`SDN_PATHS anchors <${parts[i]}> at two paths`);
      anchored.set(parts[i], at);
    }
  }
  return anchored;
})();
/** Paths that identify the publication: each must appear at most once. */
const SDN_SINGLETON_PATHS = new Set([SDN_PATHS.dateOfIssue, SDN_PATHS.year, SDN_PATHS.month, SDN_PATHS.day]);

/**
 * Parse SDN Advanced XML text into its EVM addresses and publication date.
 * PURE; throws on any shape that would make an empty or partial answer look
 * like a real one.
 *
 * Extraction walks the token stream of {@link scanXml} — the same single pass
 * that proves the document complete — and reads only the full paths in
 * {@link SDN_PATHS}. The publication date's block and each of its parts must
 * appear exactly once; a repeated one is refused rather than letting the
 * last value win (Codex #2543 r5).
 * Records are resolved against the reference sets AFTER the pass, so their
 * order in the file does not matter — and every record must resolve: a
 * `FeatureTypeID` or `ReliabilityID` that names no reference value refuses
 * the file rather than silently dropping (or keeping) an address
 * (Codex #2543 r4).
 *
 * Only elements in OFAC's namespace are read. The root must be OFAC's
 * `Sanctions` element; an element in any other namespace is opaque, and
 * nothing inside it is consumed (Codex #2543 r4).
 */
export function parseSdnAdvanced(xml) {
  const parser = createSdnParser();
  parser.write(xml);
  return parser.end();
}

/**
 * {@link parseSdnAdvanced} fed in pieces (#2443 adder host): `write(chunk)`
 * takes the next piece of decoded text and `end()` returns the parse. The
 * rules are the same — it IS the same parser, driven through
 * {@link createXmlScanner} — and so is the result, wherever the pieces are
 * cut; a whole publication is never held as one string.
 */
export function createSdnParser() {
  const path = []; // local names of the open OFAC-namespace elements, root first
  // Every run of 40+ hex digits in the file, raw and in decoded text — the
  // delisting witness buildUpdate checks (see createHexRunCollector).
  const hex = createHexRunCollector();
  const seen = new Map(); // singleton path -> count
  const date = {};
  const featureTypes = new Map();
  const reliability = new Map();
  const detailTypes = new Map();
  // The reference sets, one entry each: full path -> where its values go.
  const refSets = new Map([
    [SDN_PATHS.featureType, { label: 'FeatureType', set: featureTypes }],
    [SDN_PATHS.reliability, { label: 'Reliability', set: reliability }],
    [SDN_PATHS.detailType, { label: 'DetailType', set: detailTypes }],
  ]);
  const records = []; // { typeId, rel, value } — value null: a version with no detail
  let feature = null; // { typeId, versions }
  let version = null; // { rel, details }
  let buf = null; // text accumulator for the element being read
  let reading = null; // the full path `buf` belongs to
  let refId = null;
  let detailTypeId = null; // DetailTypeID of the <VersionDetail> being read

  const scanner = createXmlScanner({
    open(name, attrs, depth, ns) {
      if (depth === 0 && ns !== OFAC_SDN_ADVANCED_NAMESPACE) {
        // Exact match, not a substring test: a namespace that merely
        // CONTAINS the OFAC host is not OFAC's document. If OFAC ever
        // changes its namespace the tool refuses loudly instead of guessing.
        throw new Error(`not an OFAC SDN Advanced XML document (root namespace ${JSON.stringify(ns)}, expected ${OFAC_SDN_ADVANCED_NAMESPACE})`);
      }
      if (depth === 0 && attrs.get('Version') !== OFAC_SDN_ADVANCED_SCHEMA_VERSION) {
        // The paths read below are those of this schema version. A revision
        // may move or redefine part of the record structure while keeping
        // the namespace and enough old paths to parse, and a partial read
        // would delist whatever moved (Codex #2543 r11). Refuse rather than
        // guess; a new version needs the paths re-checked first.
        throw new Error(
          `unsupported OFAC SDN Advanced schema version ${JSON.stringify(attrs.get('Version') ?? null)} (this tool reads version ${OFAC_SDN_ADVANCED_SCHEMA_VERSION})`,
        );
      }
      if (ns !== OFAC_SDN_ADVANCED_NAMESPACE) {
        // OFAC's document carries no element outside its own namespace. One
        // that does is not the schema these paths were checked against, and
        // treating its subtree as absent could silently drop a record and
        // delist its address (Codex #2543 r15). Refuse rather than skip.
        throw new Error(`unexpected element <${name}> in namespace ${JSON.stringify(ns)} — an OFAC SDN Advanced document carries only elements in ${OFAC_SDN_ADVANCED_NAMESPACE}`);
      }
      path.push(name);
      const at = path.join('/');
      if (reading) throw new Error(`unexpected <${name}> inside <${reading}>`);
      const anchor = ANCHORED_PATHS.get(name);
      if (anchor !== undefined && anchor !== at) {
        throw new Error(`<${name}> found at ${at}, but the schema places it only at ${anchor} — refusing a file whose records may have moved`);
      }
      if (SDN_SINGLETON_PATHS.has(at)) {
        const count = (seen.get(at) ?? 0) + 1;
        if (count > 1) throw new Error(`<${at}> appears more than once — refusing an ambiguous publication date`);
        seen.set(at, count);
      }
      switch (at) {
        case SDN_PATHS.year:
        case SDN_PATHS.month:
        case SDN_PATHS.day:
          reading = at;
          buf = '';
          break;
        case SDN_PATHS.versionDetail:
          reading = at;
          detailTypeId = own(attrs.get('DetailTypeID'));
          buf = '';
          break;
        case SDN_PATHS.featureType:
        case SDN_PATHS.reliability:
        case SDN_PATHS.detailType:
          reading = at;
          refId = own(attrs.get('ID'));
          buf = '';
          break;
        case SDN_PATHS.feature:
          feature = { typeId: own(attrs.get('FeatureTypeID')), versions: 0 };
          break;
        case SDN_PATHS.featureVersion:
          feature.versions++;
          version = { rel: own(attrs.get('ReliabilityID')), details: 0 };
          break;
        default:
        // Any other element — including a same-named <Feature> anywhere off
        // the documented path — is structure we do not read.
      }
    },
    text(value) {
      if (reading) buf += value;
      hex.text(value);
    },
    close() {
      const at = path.join('/');
      path.pop();
      if (reading === at) {
        const value = own(buf.trim());
        if (at === SDN_PATHS.year) date.Year = value;
        else if (at === SDN_PATHS.month) date.Month = value;
        else if (at === SDN_PATHS.day) date.Day = value;
        else if (at === SDN_PATHS.versionDetail) {
          version.details++;
          records.push({ typeId: feature.typeId, rel: version.rel, detailTypeId, value });
        }
        else {
          const { label, set } = refSets.get(at);
          if (refId === undefined) throw new Error(`a <${label}> has no ID`);
          if (set.has(refId)) throw new Error(`<${label}> ID ${refId} is defined twice`);
          // An empty definition resolves an ID to nothing: it would silently
          // unmark a False reliability or hide a digital-currency type
          // (Codex #2543 r19).
          if (value === '') throw new Error(`<${label}> ID ${refId} has an empty value`);
          set.set(refId, value);
        }
        reading = null;
        buf = null;
      } else if (at === SDN_PATHS.featureVersion) {
        // A version that carries no detail is still a record: whether it
        // matters depends on its feature type, which resolves after the pass
        // (Codex #2543 r9).
        if (version.details === 0) records.push({ typeId: feature.typeId, rel: version.rel, value: null });
        version = null;
      }
      else if (at === SDN_PATHS.feature) {
        // Likewise a feature with no version at all: one level up from the
        // detail-less version, same rule (Codex #2543 r14). Its type resolves
        // after the pass; it carries no reliability to resolve.
        if (feature.versions === 0) records.push({ typeId: feature.typeId, noVersion: true });
        feature = null;
      }
    },
  });

  return {
    write(chunk) {
      hex.raw(chunk);
      scanner.write(chunk);
    },
    end() {
      scanner.end();
      return resolveSdnRecords({ date, featureTypes, reliability, detailTypes, records, hexRuns: hex.end() });
    },
  };
}

/** The pass after the scan: resolve every record against the reference sets. */
function resolveSdnRecords({ date, featureTypes, reliability, detailTypes, records, hexRuns }) {
  if (!/^\d{4}$/.test(date.Year ?? '') || !/^\d{1,2}$/.test(date.Month ?? '') || !/^\d{1,2}$/.test(date.Day ?? '')) {
    throw new Error('no <DateOfIssue> — cannot identify the publication');
  }
  const publicationId = `${date.Year}-${date.Month.padStart(2, '0')}-${date.Day.padStart(2, '0')}`;
  const publicationDate = Number(publicationId.replaceAll('-', ''));
  if (!isPublicationDate(publicationDate)) throw new Error(`<DateOfIssue> ${publicationId} is not a valid date`);

  const dcaTypes = new Map([...featureTypes].filter(([, n]) => n.startsWith(DCA_PREFIX)).map(([id, n]) => [id, n.slice(DCA_PREFIX.length)]));
  if (dcaTypes.size === 0) throw new Error('no "Digital Currency Address - *" feature types — the file format may have changed');
  // Reliability is a value this tool INTERPRETS (False excludes an
  // address), so its vocabulary is closed: every definition must be one of
  // OFAC's four, and False must be defined. A damaged or renamed value
  // ("FALSE", a typo) would otherwise silently turn excluded entries into
  // listings (Codex #2543 r21).
  for (const [id, name] of reliability) {
    if (!RELIABILITY_VALUES.has(name)) throw new Error(`<Reliability> ID ${id} is ${JSON.stringify(name)}, not one of ${[...RELIABILITY_VALUES].join(', ')} — refusing a reference table this tool cannot interpret`);
  }
  const falseIds = new Set([...reliability].filter(([, n]) => n === 'False').map(([id]) => id));
  if (falseIds.size === 0) throw new Error('no <Reliability> is defined as False — refusing a reference table that cannot mark an entry false');

  const byAddress = new Map(); // lowercase -> { address, assets:Set }
  const excludedFalse = [];
  const malformed = [];
  const nonEvmByAsset = {};
  for (const { typeId, rel, detailTypeId: dt, value, noVersion } of records) {
    if (typeId === undefined || !featureTypes.has(typeId)) {
      throw new Error(`a <Feature> names FeatureTypeID ${JSON.stringify(typeId ?? null)}, which no <FeatureType> defines — refusing a file whose records do not resolve`);
    }
    if (noVersion) {
      // A digital-currency feature with no version is a record we cannot
      // read, exactly like a version with no detail (Codex #2543 r14).
      if (dcaTypes.has(typeId)) {
        throw new Error(`a "${DCA_PREFIX}${dcaTypes.get(typeId)}" <Feature> carries no <FeatureVersion> — refusing a file whose digital-currency records do not resolve`);
      }
      continue;
    }
    if (rel === undefined || !reliability.has(rel)) {
      throw new Error(`a <FeatureVersion> names ReliabilityID ${JSON.stringify(rel ?? null)}, which no <Reliability> defines — refusing a file whose records do not resolve`);
    }
    const asset = dcaTypes.get(typeId);
    if (asset === undefined) continue;
    if (value === null || value === '') {
      // A digital-currency version with no address in it is a record we
      // cannot read, not a record with nothing to list: refuse the file
      // rather than drop the entry silently (Codex #2543 r9).
      throw new Error(`a "${DCA_PREFIX}${asset}" <FeatureVersion> carries no <VersionDetail> address — refusing a file whose digital-currency records do not resolve`);
    }
    // An address is free text in OFAC's schema. A detail of any other type
    // (or none) is not one, however it is shaped, so it is never listed
    // (Codex #2543 r12); the type resolves against the reference set like
    // every other ID.
    if (dt === undefined || !detailTypes.has(dt)) {
      throw new Error(`a <VersionDetail> names DetailTypeID ${JSON.stringify(dt ?? null)}, which no <DetailType> defines — refusing a file whose records do not resolve`);
    }
    if (detailTypes.get(dt) !== ADDRESS_DETAIL_TYPE) {
      throw new Error(`a "${DCA_PREFIX}${asset}" <VersionDetail> is of type ${JSON.stringify(detailTypes.get(dt))}, not ${ADDRESS_DETAIL_TYPE} — refusing a digital-currency record that is not an address`);
    }
    if (EVM_RE.test(value) && ZERO_RE.test(value)) {
      // The contract reverts ZeroAddress on it, so it can never reach a
      // ready update; surface it for review instead (Codex #2543 r7).
      malformed.push({ value, asset });
    } else if (EVM_RE.test(value)) {
      const address = getAddress(value.toLowerCase());
      if (falseIds.has(rel)) {
        excludedFalse.push({ address, asset });
        continue;
      }
      const key = address.toLowerCase();
      if (!byAddress.has(key)) byAddress.set(key, { address, assets: new Set() });
      byAddress.get(key).assets.add(asset);
    } else if (HEX_PREFIX_RE.test(value)) {
      malformed.push({ value, asset });
    } else {
      nonEvmByAsset[asset] = (nonEvmByAsset[asset] ?? 0) + 1;
    }
  }
  if (byAddress.size === 0) throw new Error('no EVM-format digital-currency address found — refusing an empty list');
  const entries = [...byAddress.values()]
    .map((e) => ({ address: e.address, assets: [...e.assets].sort() }))
    .sort((x, y) => x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
  // A False-reliability version of an address listed elsewhere still stands.
  const excluded = excludedFalse.filter((e) => !byAddress.has(e.address.toLowerCase()));
  return { publicationId, publicationDate, addresses: entries.map((e) => e.address), entries, excludedFalse: excluded, malformed, nonEvmByAsset, hexRuns };
}

/** Normalise an address list (checksum, dedupe, sorted); throws on a bad entry. */
export function normaliseAddresses(list, label = 'address list') {
  const seen = new Map();
  for (const raw of list) {
    const s = String(raw).trim();
    if (!EVM_RE.test(s)) throw new Error(`${label}: not an EVM address: ${s}`);
    if (ZERO_RE.test(s)) throw new Error(`${label}: the zero address cannot be listed or delisted`);
    const a = getAddress(s.toLowerCase());
    seen.set(a.toLowerCase(), a);
  }
  return [...seen.values()].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
}

/** `target` minus `current` (to add) and `current` minus `target` (to remove). */
export function diffSets(target, current) {
  const t = new Set(target.map((a) => a.toLowerCase()));
  const c = new Set(current.map((a) => a.toLowerCase()));
  return {
    add: normaliseAddresses(target.filter((a) => !c.has(a.toLowerCase()))),
    remove: normaliseAddresses(current.filter((a) => !t.has(a.toLowerCase()))),
  };
}

/** Three-way comparison with the retired Chainalysis set — REPORT ONLY. */
export function crossCheck(ofac, chainalysis) {
  const o = new Set(ofac.map((a) => a.toLowerCase()));
  const c = new Set(chainalysis.map((a) => a.toLowerCase()));
  return {
    inBoth: normaliseAddresses(ofac.filter((a) => c.has(a.toLowerCase()))),
    ofacOnly: normaliseAddresses(ofac.filter((a) => !c.has(a.toLowerCase()))),
    chainalysisOnly: normaliseAddresses(chainalysis.filter((a) => !o.has(a.toLowerCase()))),
  };
}

/** The verified Chainalysis listing events (see header). */
export const CHAINALYSIS_EVENTS = {
  added: parseAbiItem('event SanctionedAddressesAdded(address[] addrs)'),
  removed: parseAbiItem('event SanctionedAddressesRemoved(address[] addrs)'),
};

/**
 * Replay decoded Chainalysis logs into the final set. PURE. Logs are ordered
 * by (blockNumber, logIndex) here, so a caller's ordering cannot change the
 * answer.
 */
export function replayChainalysisLogs(logs) {
  const ordered = [...logs].sort((x, y) =>
    x.blockNumber === y.blockNumber ? Number(x.logIndex - y.logIndex) : x.blockNumber < y.blockNumber ? -1 : 1,
  );
  const set = new Map();
  for (const l of ordered) {
    for (const raw of l.args.addrs) {
      const a = getAddress(raw.toLowerCase());
      if (l.eventName === 'SanctionedAddressesAdded') set.set(a.toLowerCase(), a);
      else if (l.eventName === 'SanctionedAddressesRemoved') set.delete(a.toLowerCase());
      else throw new Error(`unexpected event ${l.eventName}`);
    }
  }
  return [...set.values()].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
}

/**
 * The `applyUpdate` calls. Refuses a publication that is not newer than the
 * recorded one (see {@link checkPublicationOrder}) and a removal set above
 * `maxRemove`. For an allowed rollback it also returns the owner's
 * `authorizePublicationRollback` calldata, which must execute first.
 *
 * `calls` is the ordered list of `applyUpdate` transactions, each naming its
 * signer and computed against the version the one before it produces: the
 * additions in `adder` batches (one call with nothing, as a refresh, when
 * there is nothing to add or delist), then the delistings in `remover`
 * batches, each batch at most `maxChangesPerCall` addresses. A publication can need several
 * transactions — a first population will not fit one block's gas — so the
 * first call of a NEW publication declares how many additions and delistings
 * remain after it, and every later call repeats that publication and lowers
 * the counts by exactly what it applies, as the contract requires (Codex
 * #2543 r7, r8, r10).
 */
/**
 * THE delisting rule (Codex #2543 r19, the root of r14-r19): OFAC delists an
 * address by removing its record, so the address's 40 hex digits no longer
 * appear anywhere in the file. A delisting is only emitted when that is
 * true. Any parse path that DROPS a record it should have read — a moved or
 * malformed node, an unresolvable reference, a damaged character — leaves
 * the address's digits in the file, and is refused here, whichever path
 * dropped it. The one exception is an address the file still carries ONLY as
 * OFAC-marked False records, which is a real reason to delist: every mention
 * must be accounted for by one of those records (Codex #2543 r20), counted
 * both in the raw bytes and in decoded text, so a False record cannot mask
 * another, damaged mention of the same address.
 */
export function assertDelistingsWitnessed(parsed, remove) {
  const runs = parsed.hexRuns;
  if (!runs || !Array.isArray(runs.raw) || !Array.isArray(runs.text)) {
    throw new Error('parsed source carries no hexRuns — re-parse it with parseSdnAdvanced');
  }
  const mentions = (list, body) => list.reduce((n, run) => n + run.split(body).length - 1, 0);
  const stillInFile = remove.filter((a) => {
    const lower = a.toLowerCase();
    const body = lower.slice(2);
    const falseRecords = (parsed.excludedFalse ?? []).filter((e) => e.address.toLowerCase() === lower).length;
    return mentions(runs.raw, body) !== falseRecords || mentions(runs.text, body) !== falseRecords;
  });
  if (stillInFile.length) {
    throw new Error(
      `refusing to delist ${stillInFile.join(', ')}: the address still appears in the source file, so OFAC has not removed its record — the parser dropped it, and the file needs review`,
    );
  }
}

/**
 * THE second source for a delisting (Codex #2543 r21). A diff of two lists
 * cannot tell a record OFAC removed from one the file lost or damaged — every
 * round from r14 to r21 found another way to lose one. OFAC announces each
 * delisting in its Recent Actions notice, so the operator names the
 * addresses that notice delists, and a removal is emitted only when the diff
 * and that confirmation agree EXACTLY: an unconfirmed removal is refused, and
 * so is a confirmed address the diff does not remove. Malformed values the
 * file carries are named in the refusal, since one may be a damaged copy of
 * an address the diff would otherwise delist.
 */
export function assertDelistingsConfirmed(remove, confirmed, malformed = []) {
  const want = new Set(normaliseAddresses(confirmed, 'confirmed delistings').map((a) => a.toLowerCase()));
  const have = new Set(remove.map((a) => a.toLowerCase()));
  const unconfirmed = remove.filter((a) => !want.has(a.toLowerCase()));
  const notRemoved = [...want].filter((a) => !have.has(a));
  if (unconfirmed.length === 0 && notRemoved.length === 0) return;
  const parts = [];
  if (unconfirmed.length) parts.push(`the diff would delist ${unconfirmed.join(', ')}, which --confirm-delist does not name; check OFAC's Recent Actions notice for this publication and confirm each address it delists`);
  if (notRemoved.length) parts.push(`--confirm-delist names ${notRemoved.join(', ')}, which the diff does not delist`);
  if (malformed.length) parts.push(`the file also carries ${malformed.length} malformed digital-currency value(s) (${malformed.map((m) => JSON.stringify(m.value)).join(', ')}), any of which may be a damaged copy of a listed address`);
  throw new Error(`refusing the delistings: ${parts.join('; ')}`);
}

export function buildUpdate({
  parsed,
  sourceHash: hash,
  current,
  currentVersion,
  recordedDate,
  recordedHash,
  recordedPendingAdditions,
  recordedPendingDelistings,
  allowRollback = false,
  maxRemove = DEFAULT_MAX_REMOVE,
  maxChangesPerCall = DEFAULT_MAX_CHANGES_PER_CALL,
  confirmedDelistings = [],
  signers = 'all',
  abi = sanctionsListAbi(),
}) {
  if (signers !== 'all' && signers !== 'adder') throw new Error(`signers must be 'all' or 'adder', got ${JSON.stringify(signers)}`);
  // The adder service never rolls back: that is the owner's deliberate act.
  if (signers === 'adder' && allowRollback) throw new Error('an adder-only update never rolls back a publication');
  if (!Number.isSafeInteger(maxRemove) || maxRemove < 0) throw new Error(`maxRemove must be a non-negative integer, got ${maxRemove}`);
  if (!Number.isSafeInteger(maxChangesPerCall) || maxChangesPerCall < 1) throw new Error(`maxChangesPerCall must be a positive integer, got ${maxChangesPerCall}`);
  if (recordedDate === undefined || recordedHash === undefined) throw new Error('the recorded publication date and hash are required');
  // No defaults: a guessed count would build calls the contract refuses, or
  // hide a partly applied publication from the reviewer (Codex #2543 r9).
  if (recordedPendingAdditions === undefined || recordedPendingDelistings === undefined) {
    throw new Error('the recorded pendingAdditions and pendingDelistings are required');
  }
  const { add, remove } = diffSets(parsed.addresses, current);
  const pendingAdd = Number(recordedPendingAdditions);
  const pendingDel = Number(recordedPendingDelistings);
  const order = checkPublicationOrder({
    recordedDate: Number(recordedDate),
    recordedHash,
    date: parsed.publicationDate,
    hash,
    additions: add.length,
    removals: remove.length,
    pendingAdditions: pendingAdd,
    pendingDelistings: pendingDel,
    allowRollback,
  });
  if (remove.length > maxRemove) {
    throw new Error(
      `refusing to delist ${remove.length} addresses (limit ${maxRemove}). OFAC delistings are rare; check the source file, then raise --max-remove deliberately.`,
    );
  }
  // The witness holds in both modes: in adder-only mode the delistings are
  // not applied, but their count is DECLARED on-chain as outstanding, and a
  // count the file does not support must not be published either.
  assertDelistingsWitnessed(parsed, remove);
  // Confirmation is required of the calls that delist. An adder-only update
  // delists nothing, so it needs none: its removals wait, declared, for the
  // remover, whose run confirms them (#2443 adder host).
  if (signers === 'all') assertDelistingsConfirmed(remove, confirmedDelistings, parsed.malformed ?? []);
  const version = BigInt(currentVersion);
  // `additionsLeft` / `delistingsLeft` are what the contract publishes as
  // `pendingAdditions` / `pendingDelistings` after each call.
  const calls = [];
  const push = (signer, toAdd, toRemove, additionsLeft, delistingsLeft) => {
    const expectedVersion = version + BigInt(calls.length);
    calls.push({
      signer,
      expectedVersion,
      add: toAdd,
      remove: toRemove,
      additionsLeft,
      delistingsLeft,
      calldata: encodeFunctionData({
        abi,
        functionName: 'applyUpdate',
        args: [expectedVersion, toAdd, toRemove, hash, parsed.publicationDate, additionsLeft, delistingsLeft],
      }),
    });
  };
  // The counts outstanding BEFORE the first call: a NEW publication starts
  // from its whole diff; a REPEAT continues from what the list records, since
  // the contract lowers those only by what is applied.
  let addsLeft = order === 'same-publication' ? pendingAdd : add.length;
  let delsLeft = order === 'same-publication' ? pendingDel : remove.length;
  // One batching rule for both sides (Codex #2543 r10, r12): every call
  // carries at most `maxChangesPerCall` addresses, whichever list they come
  // from, so no call is built that cannot fit a transaction.
  const batches = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i += maxChangesPerCall) out.push(list.slice(i, i + maxChangesPerCall));
    return out;
  };
  // An empty diff is still one adder call: the refresh that records the
  // publication. A delisting-only update goes to the remover alone — except
  // in adder-only mode, where a NEW publication is still recorded by one
  // empty adder call declaring its delistings outstanding, so the list says
  // which publication it follows and what of it is not yet applied. A repeat
  // with nothing left to add gives the adder nothing to do.
  let addBatches;
  if (add.length > 0) addBatches = batches(add);
  else if (signers === 'adder') addBatches = order === 'same-publication' ? [] : [[]];
  else addBatches = remove.length > 0 ? [] : [[]];
  for (const batch of addBatches) {
    addsLeft -= batch.length;
    push('adder', batch, [], addsLeft, delsLeft);
  }
  if (signers === 'all') {
    for (const batch of batches(remove)) {
      delsLeft -= batch.length;
      push('remover', [], batch, addsLeft, delsLeft);
    }
  }
  return {
    add,
    remove,
    // The delistings this update leaves for the remover: all of them in
    // adder-only mode, none otherwise.
    withheldRemovals: signers === 'adder' ? remove : [],
    order,
    authorizeCalldata:
      order === 'rollback'
        ? encodeFunctionData({ abi, functionName: 'authorizePublicationRollback', args: [version, parsed.publicationDate, hash] })
        : null,
    calls,
  };
}

// ── I/O (not exercised by the unit test) ─────────────────────────────

function parseArgs(argv) {
  const flags = new Set(['--fetch', '--help', '--allow-rollback']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument: ${k}`);
    if (flags.has(k)) out[k.slice(2)] = true;
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      out[k.slice(2)] = v;
    }
  }
  return out;
}

function readList(path) {
  const text = readFileSync(path, 'utf8').trim();
  const list = text.startsWith('[') ? JSON.parse(text) : text.split(/\s+/).filter(Boolean);
  return normaliseAddresses(list, path);
}

/**
 * The current list, read as ONE snapshot. The block is resolved once — always
 * the `finalized` tag, never a chosen height: a non-final block could be
 * replaced by a different list state at the same `listVersion`, and the
 * update's `expectedVersion` would still pass (Codex #2543 r20) — to its hash, and every
 * read (version, publication, hash, count, each page) is pinned to that hash
 * with `requireCanonical`, so a reorg during the reads makes them fail
 * instead of mixing two forks at one height.
 */
export async function readCurrentFromChain(client, list, abi, expectedChainId) {
  // The same list address and version can exist on another chain; reads
  // there are self-consistent and wrong (Codex #2543 r21).
  const chainId = BigInt(await client.getChainId());
  if (chainId !== expectedChainId) throw new Error(`--rpc serves chain ${chainId}, not the --chain-id ${expectedChainId} this update is for`);
  const block = await client.getBlock({ blockTag: 'finalized' });
  const blockNumber = block.number;
  const read = (functionName, args = []) => callAtHash(client, block, { address: list, abi, functionName, args });
  const version = await read('listVersion');
  const recordedDate = Number(await read('sourcePublicationDate'));
  const recordedHash = await read('sourceHash');
  const recordedPendingAdditions = Number(await read('pendingAdditions'));
  const recordedPendingDelistings = Number(await read('pendingDelistings'));
  const count = await read('listedCount');
  const addrs = [];
  const PAGE = 200n;
  for (let off = 0n; off < count; off += PAGE) addrs.push(...(await read('listedPage', [off, PAGE])));
  if (BigInt(addrs.length) !== count) throw new Error(`read ${addrs.length} addresses, listedCount says ${count}`);
  return { version, recordedDate, recordedHash, recordedPendingAdditions, recordedPendingDelistings, addresses: normaliseAddresses(addrs, 'on-chain list'), blockNumber, blockHash: block.hash, blockTag: 'finalized', chainId };
}

async function readChainalysisFromChain(rpc, oracle, fromBlock, toBlockArg, chunk) {
  // fromBlock / toBlockArg / chunk arrive already parsed by parseUintArg.
  const client = createPublicClient({ transport: http(rpc) });
  const name = await client.readContract({ address: oracle, abi: parseAbi(['function name() pure returns (string)']), functionName: 'name' });
  if (!/chainalysis/i.test(name)) throw new Error(`${oracle} names itself "${name}", not Chainalysis's oracle — refusing`);
  const toBlock = toBlockArg ?? (await client.getBlockNumber());
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    logs.push(
      ...(await client.getLogs({ address: oracle, events: [CHAINALYSIS_EVENTS.added, CHAINALYSIS_EVENTS.removed], fromBlock: start, toBlock: end, strict: true })),
    );
  }
  return { addresses: replayChainalysisLogs(logs), toBlock, logCount: logs.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  // The publication is streamed to disk and parsed from there in pieces, so
  // the tool never holds the 128 MB file in memory (#2443 adder host).
  let file;
  let source;
  if (args.fetch) {
    if (!args['save-xml']) throw new Error('--fetch needs --save-xml <file>: the download is kept as the record of what was parsed');
    await downloadToFile(OFAC_SDN_ADVANCED_URL, args['save-xml']);
    file = args['save-xml'];
    source = OFAC_SDN_ADVANCED_URL;
  } else if (args.xml) {
    file = args.xml;
    source = args.xml;
  } else throw new Error('give --xml <file> or --fetch');

  const { parsed, sourceHash: hash } = await parseSdnAdvancedFile(file);
  const abi = sanctionsListAbi();

  // The current list is read from the deployed contract and nowhere else
  // (Codex #2543 r10): a file of addresses cannot be tied to the version it
  // claims, so a truncated or stale one would build calldata that applies
  // cleanly while silently keeping a delisted address or dropping a
  // designation.
  if (!args.rpc || !args.list) throw new Error('give the current list: --rpc + --list (the deployed SanctionsList)');
  if (args.current !== undefined) throw new Error('--current (a file of addresses) is no longer accepted: read the list from the chain with --rpc + --list');
  if (args.block !== undefined) throw new Error('--block is no longer accepted: the list is always read at the finalized block, so no reorg can replace the state an update is computed from');
  if (args['chain-id'] === undefined) throw new Error('give --chain-id: the chain the list lives on, checked against what --rpc serves');
  const current = await readCurrentFromChain(createPublicClient({ transport: http(args.rpc) }), getAddress(args.list), abi, parseUintArg('--chain-id', args['chain-id'], { min: 1n }));
  current.source = { chainId: current.chainId.toString(), list: getAddress(args.list), atBlock: current.blockNumber.toString(), atBlockHash: current.blockHash, pinnedFrom: current.blockTag };

  const maxRemove = args['max-remove'] !== undefined ? Number(parseUintArg('--max-remove', args['max-remove'], { max: 1_000_000n })) : DEFAULT_MAX_REMOVE;
  const update = buildUpdate({
    parsed,
    sourceHash: hash,
    current: current.addresses,
    currentVersion: current.version,
    recordedDate: current.recordedDate,
    recordedHash: current.recordedHash,
    recordedPendingAdditions: current.recordedPendingAdditions,
    recordedPendingDelistings: current.recordedPendingDelistings,
    allowRollback: args['allow-rollback'] === true,
    maxRemove,
    confirmedDelistings: args['confirm-delist'] === undefined ? [] : String(args['confirm-delist']).split(',').map((a) => a.trim()).filter(Boolean),
    maxChangesPerCall: args['max-changes-per-call'] !== undefined ? Number(parseUintArg('--max-changes-per-call', args['max-changes-per-call'], { min: 1n, max: 100_000n })) : DEFAULT_MAX_CHANGES_PER_CALL,
    abi,
  });

  let chainalysis;
  if (args['chainalysis-list']) {
    chainalysis = { source: { file: args['chainalysis-list'] }, addresses: readList(args['chainalysis-list']) };
  } else if (args['chainalysis-rpc'] || args['chainalysis-oracle']) {
    if (!args['chainalysis-rpc'] || !args['chainalysis-oracle'] || args['chainalysis-from-block'] === undefined) {
      throw new Error('--chainalysis-rpc, --chainalysis-oracle and --chainalysis-from-block go together');
    }
    const oracle = getAddress(args['chainalysis-oracle']);
    const r = await readChainalysisFromChain(
      args['chainalysis-rpc'],
      oracle,
      parseUintArg('--chainalysis-from-block', args['chainalysis-from-block']),
      args['chainalysis-to-block'] !== undefined ? parseUintArg('--chainalysis-to-block', args['chainalysis-to-block']) : undefined,
      parseUintArg('--log-chunk', args['log-chunk'] ?? '10000', { min: 1n }),
    );
    chainalysis = { source: { oracle, fromBlock: args['chainalysis-from-block'], toBlock: r.toBlock.toString(), logCount: r.logCount }, addresses: r.addresses };
  }

  const report = {
    source: { from: source, sha256: hash, publicationId: parsed.publicationId, publicationDate: parsed.publicationDate, evmAddressCount: parsed.addresses.length },
    excludedFalseReliability: parsed.excludedFalse,
    malformedEvmLikeValues: parsed.malformed,
    nonEvmAddressesByAsset: parsed.nonEvmByAsset,
    current: {
      ...current.source,
      version: current.version.toString(),
      publicationDate: current.recordedDate,
      sourceHash: current.recordedHash,
      pendingAdditions: current.recordedPendingAdditions,
      pendingDelistings: current.recordedPendingDelistings,
      count: current.addresses.length,
    },
    update: {
      expectedVersion: current.version.toString(),
      add: update.add,
      remove: update.remove,
      sourceHash: hash,
      sourcePublicationDate: parsed.publicationDate,
      publicationOrder: update.order,
      calls: update.calls.map((c) => ({ ...c, expectedVersion: c.expectedVersion.toString() })),
      ...(update.authorizeCalldata
        ? { ownerMustFirstCall: { function: 'authorizePublicationRollback', args: [current.version.toString(), parsed.publicationDate, hash], calldata: update.authorizeCalldata } }
        : {}),
    },
  };
  if (chainalysis) {
    const x = crossCheck(parsed.addresses, chainalysis.addresses);
    report.chainalysisCrossCheck = {
      note: 'REVIEW ONLY. Chainalysis-only addresses are NOT added: the retired list froze on 2026-03-18 and never removes later delistings.',
      ...chainalysis.source,
      inBoth: x.inBoth,
      ofacOnly: x.ofacOnly,
      chainalysisOnly: x.chainalysisOnly,
    };
  }
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, `${json}\n`);
  else console.log(json);
  console.error(
    `OFAC ${parsed.publicationId} sha256 ${hash}: ${parsed.addresses.length} EVM addresses; +${update.add.length} -${update.remove.length} against list version ${current.version}.`,
  );
  for (const c of update.calls) {
    console.error(
      `applyUpdate at version ${c.expectedVersion}: +${c.add.length} -${c.remove.length}, leaving +${c.additionsLeft} -${c.delistingsLeft} outstanding, signed by the ${c.signer === 'remover' ? 'REMOVER (the multisig)' : 'adder'}.`,
    );
  }
  console.error(`Current list read at block ${current.blockNumber} (${current.blockHash}, ${current.blockTag}).`);
  if (update.order === 'rollback') {
    console.error(`ROLLBACK: the owner must first call authorizePublicationRollback(${current.version}, ${parsed.publicationDate}, ${hash}); see ownerMustFirstCall.`);
  }
  if (parsed.malformed.length) console.error(`WARNING: ${parsed.malformed.length} malformed EVM-like value(s) need human review.`);
  if (chainalysis?.source.logCount === 0) {
    console.error('WARNING: no Chainalysis listing logs in the scanned range — start --chainalysis-from-block at the oracle\'s deployment block, or the comparison is empty.');
  }
  if (report.chainalysisCrossCheck?.chainalysisOnly.length) {
    console.error(`REVIEW: ${report.chainalysisCrossCheck.chainalysisOnly.length} Chainalysis-only address(es) — not added.`);
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((e) => {
    console.error(`ofac-sanctions-diff: ${e.message}`);
    process.exit(1);
  });
}
