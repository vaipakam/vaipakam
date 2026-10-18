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
 *      file (`--xml`) or downloads it (`--fetch`, optionally `--save-xml` so
 *      the exact bytes behind the recorded hash are kept).
 *   2. Extracts every EVM-format digital-currency address (`0x` + 40 hex)
 *      listed under ANY "Digital Currency Address - *" feature type — an
 *      EVM-shaped address is the same key on every EVM chain, whatever asset
 *      label OFAC filed it under. Features whose reliability is "False" are
 *      excluded and reported. Addresses are checksummed and de-duplicated.
 *      Every `0x`/`0X`-prefixed value that is not exactly an address is
 *      reported, raw, as malformed for a human — never guessed at.
 *   3. Reads the CURRENT list: from the deployed contract at ONE pinned block
 *      (`--rpc` + `--list` [+ `--block N`, default the `finalized` block];
 *      the block is resolved once to its HASH and every read — version,
 *      publication, hash, count, each page — is pinned to it by EIP-1898
 *      with `requireCanonical`, using the census tooling's helper), or from a file (`--current` + `--current-version`
 *      + `--current-publication` [+ `--current-source-hash`]
 *      [+ `--current-pending`, the list's `pendingDelistings`, default 0]).
 *   4. Prints the add / remove sets, the source SHA-256 and publication date
 *      (`DateOfIssue` as `YYYYMMDD`), and the ready `applyUpdate` calls, each
 *      carrying the list version it applies to, so it cannot apply to any
 *      other state. Additions and delistings are SEPARATE calls with separate
 *      signers (owner decision 2026-10-18): the adder (the automated
 *      updater) sends the additions, then the remover (the multisig) sends
 *      the delistings against the same publication. The contract refuses a
 *      delisting from anyone but a remover.
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
 *   - A file in which it finds NO EVM address, no `DateOfIssue`, or no
 *     digital-currency feature types. A parser that silently finds nothing
 *     would emit a diff that delists everyone.
 *   - A publication that is not NEWER than the one the list records — an
 *     older file would re-list delisted addresses and drop newer designations
 *     while still diffing cleanly against the current state. The same date is
 *     accepted only as a refresh (identical hash, nothing to change). The
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
 *     --rpc "$RPC" --list 0xList [--block N] [--out update.json]
 *   node scripts/ofac-sanctions-diff.mjs --fetch --save-xml sdn.xml \
 *     --current current.json --current-version 3 \
 *     --current-publication 20261015 --current-source-hash 0x…
 *   … [--chainalysis-rpc "$RPC" --chainalysis-oracle 0x40C5… \
 *      --chainalysis-from-block 14356508 [--log-chunk 10000]]
 *   … [--chainalysis-list chainalysis.json]
 *
 * The signers are decided (owner, 2026-10-18): the adder lists, the multisig
 * remover delists. Where the adder runs is still OPEN (#2443); this tool
 * deliberately stops at calldata.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, http, getAddress, encodeFunctionData, parseAbi, parseAbiItem } from 'viem';
// The census tooling's EIP-1898 helper: every state read below is pinned to
// ONE block by HASH with requireCanonical, never by number (Codex #2543 r2).
import { callAtHash } from './census-grandfathered-custody.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The root namespace OFAC's SDN Advanced export declares. */
export const OFAC_SDN_ADVANCED_NAMESPACE =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML';
export const OFAC_SDN_ADVANCED_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML';
export const DEFAULT_MAX_REMOVE = 10;

const DCA_PREFIX = 'Digital Currency Address - ';
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
/** The zero address: EVM-shaped, but the contract refuses to list or delist it. */
const ZERO_RE = /^0x0{40}$/i;
const HEX_PREFIX_RE = /^0x/i;

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

const NAME_RE = /^[A-Za-z_][\w.:-]*/;
const ATTR_RE = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const PREDEFINED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

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
      if (!Number.isSafeInteger(cp) || cp > 0x10ffff) throw new Error(`malformed XML: bad character reference &${ref}; near offset ${offset}`);
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
  const { open = () => {}, close = () => {}, text = () => {} } = handlers;
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack = []; // { name, ns, scope }
  const BASE_SCOPE = new Map([['xml', XML_NS]]);
  let root = null;
  let rootClosed = false;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = xml.slice(i, textEnd);
      if (stack.length === 0) {
        if (/\S/.test(raw)) throw new Error(`incomplete XML: content outside the root element at offset ${i}`);
      } else text(decodeXmlText(raw, i));
    }
    if (lt === -1) break;
    const closer = (token, from) => {
      const e = xml.indexOf(token, from);
      if (e === -1) throw new Error(`incomplete XML: unterminated construct at offset ${lt}`);
      return e;
    };
    if (xml.startsWith('<!--', lt)) {
      i = closer('-->', lt + 4) + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw new Error(`incomplete XML: CDATA outside the root at offset ${lt}`);
      const e = closer(']]>', lt + 9);
      text(xml.slice(lt + 9, e));
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      i = closer('?>', lt + 2) + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new Error(`refusing a DOCTYPE or markup declaration at offset ${lt}`);
    const gt = tagEnd(xml, lt);
    if (gt === -1) throw new Error(`incomplete XML: unterminated tag at offset ${lt}`);
    const body = xml.slice(lt + 1, gt);
    if (body.startsWith('/')) {
      const name = body.slice(1).trimEnd();
      const top = stack.pop();
      if (top === undefined || top.name !== name) {
        throw new Error(`malformed XML: </${name}> at offset ${lt} closes ${top === undefined ? 'nothing' : `<${top.name}>`}`);
      }
      close(localName(name), stack.length, top.ns);
      if (stack.length === 0) rootClosed = true;
    } else {
      const m = body.match(NAME_RE);
      if (!m) throw new Error(`malformed XML: bad tag at offset ${lt}`);
      const name = m[0];
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
    i = gt + 1;
  }
  if (root === null) throw new Error('incomplete XML: no root element');
  if (stack.length) throw new Error(`incomplete XML: ${stack.length} element(s) never closed, innermost <${stack[stack.length - 1].name}> — the file is truncated`);
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

/** True iff `d` is a `YYYYMMDD` shape the contract accepts. */
export function isPublicationDate(d) {
  const year = Math.floor(d / 10000);
  const month = Math.floor(d / 100) % 100;
  const day = d % 100;
  return Number.isInteger(d) && year >= 2000 && year <= 2999 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * The contract's publication-order rule, applied before calldata is built:
 * a newer date passes; the same publication (identical date and hash) passes
 * again only when it adds nothing — a refresh, or the remover completing that
 * publication's delistings; anything else is refused unless `allowRollback`,
 * in which case the owner must authorize it on-chain first.
 */
export function checkPublicationOrder({ recordedDate, recordedHash, date, hash, noAdditions, allowRollback = false }) {
  if (date > recordedDate) return 'newer';
  if (date === recordedDate && hash.toLowerCase() === String(recordedHash).toLowerCase() && noAdditions) return 'same-publication';
  if (allowRollback) return 'rollback';
  if (date === recordedDate && hash.toLowerCase() === String(recordedHash).toLowerCase()) {
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
  feature: PARTY_FEATURE,
  featureVersion: `${PARTY_FEATURE}/FeatureVersion`,
  versionDetail: `${PARTY_FEATURE}/FeatureVersion/VersionDetail`,
});
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
  const path = []; // local names of the open OFAC-namespace elements, root first
  const seen = new Map(); // singleton path -> count
  const date = {};
  const featureTypes = new Map();
  const reliability = new Map();
  const records = []; // { typeId, rel, value }
  let feature = null; // { typeId }
  let version = null; // { rel }
  let buf = null; // text accumulator for the element being read
  let reading = null; // the full path `buf` belongs to
  let refId = null;
  let foreignDepth = 0; // >0 while inside an element outside OFAC's namespace

  scanXml(xml, {
    open(name, attrs, depth, ns) {
      if (depth === 0 && ns !== OFAC_SDN_ADVANCED_NAMESPACE) {
        // Exact match, not a substring test: a namespace that merely
        // CONTAINS the OFAC host is not OFAC's document. If OFAC ever
        // changes its namespace the tool refuses loudly instead of guessing.
        throw new Error(`not an OFAC SDN Advanced XML document (root namespace ${JSON.stringify(ns)}, expected ${OFAC_SDN_ADVANCED_NAMESPACE})`);
      }
      if (foreignDepth > 0 || ns !== OFAC_SDN_ADVANCED_NAMESPACE) {
        if (reading) throw new Error(`unexpected foreign-namespace <${name}> inside <${reading}>`);
        foreignDepth++;
        return;
      }
      path.push(name);
      const at = path.join('/');
      if (reading) throw new Error(`unexpected <${name}> inside <${reading}>`);
      if (SDN_SINGLETON_PATHS.has(at)) {
        const count = (seen.get(at) ?? 0) + 1;
        if (count > 1) throw new Error(`<${at}> appears more than once — refusing an ambiguous publication date`);
        seen.set(at, count);
      }
      switch (at) {
        case SDN_PATHS.year:
        case SDN_PATHS.month:
        case SDN_PATHS.day:
        case SDN_PATHS.versionDetail:
          reading = at;
          buf = '';
          break;
        case SDN_PATHS.featureType:
        case SDN_PATHS.reliability:
          reading = at;
          refId = attrs.get('ID');
          buf = '';
          break;
        case SDN_PATHS.feature:
          feature = { typeId: attrs.get('FeatureTypeID') };
          break;
        case SDN_PATHS.featureVersion:
          version = { rel: attrs.get('ReliabilityID') };
          break;
        default:
        // Any other element — including a same-named <Feature> anywhere off
        // the documented path — is structure we do not read.
      }
    },
    text(value) {
      if (reading && foreignDepth === 0) buf += value;
    },
    close() {
      if (foreignDepth > 0) {
        foreignDepth--;
        return;
      }
      const at = path.join('/');
      path.pop();
      if (reading === at) {
        const value = buf.trim();
        if (at === SDN_PATHS.year) date.Year = value;
        else if (at === SDN_PATHS.month) date.Month = value;
        else if (at === SDN_PATHS.day) date.Day = value;
        else if (at === SDN_PATHS.versionDetail) records.push({ typeId: feature.typeId, rel: version.rel, value });
        else {
          const label = at === SDN_PATHS.featureType ? 'FeatureType' : 'Reliability';
          const set = at === SDN_PATHS.featureType ? featureTypes : reliability;
          if (refId === undefined) throw new Error(`a <${label}> has no ID`);
          if (set.has(refId)) throw new Error(`<${label}> ID ${refId} is defined twice`);
          set.set(refId, value);
        }
        reading = null;
        buf = null;
      } else if (at === SDN_PATHS.featureVersion) version = null;
      else if (at === SDN_PATHS.feature) feature = null;
    },
  });

  if (!/^\d{4}$/.test(date.Year ?? '') || !/^\d{1,2}$/.test(date.Month ?? '') || !/^\d{1,2}$/.test(date.Day ?? '')) {
    throw new Error('no <DateOfIssue> — cannot identify the publication');
  }
  const publicationId = `${date.Year}-${date.Month.padStart(2, '0')}-${date.Day.padStart(2, '0')}`;
  const publicationDate = Number(publicationId.replaceAll('-', ''));
  if (!isPublicationDate(publicationDate)) throw new Error(`<DateOfIssue> ${publicationId} is not a valid date`);

  const dcaTypes = new Map([...featureTypes].filter(([, n]) => n.startsWith(DCA_PREFIX)).map(([id, n]) => [id, n.slice(DCA_PREFIX.length)]));
  if (dcaTypes.size === 0) throw new Error('no "Digital Currency Address - *" feature types — the file format may have changed');
  const falseIds = new Set([...reliability].filter(([, n]) => n === 'False').map(([id]) => id));

  const byAddress = new Map(); // lowercase -> { address, assets:Set }
  const excludedFalse = [];
  const malformed = [];
  const nonEvmByAsset = {};
  for (const { typeId, rel, value } of records) {
    if (typeId === undefined || !featureTypes.has(typeId)) {
      throw new Error(`a <Feature> names FeatureTypeID ${JSON.stringify(typeId ?? null)}, which no <FeatureType> defines — refusing a file whose records do not resolve`);
    }
    if (rel === undefined || !reliability.has(rel)) {
      throw new Error(`a <FeatureVersion> names ReliabilityID ${JSON.stringify(rel ?? null)}, which no <Reliability> defines — refusing a file whose records do not resolve`);
    }
    const asset = dcaTypes.get(typeId);
    if (asset === undefined) continue;
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
  return { publicationId, publicationDate, addresses: entries.map((e) => e.address), entries, excludedFalse: excluded, malformed, nonEvmByAsset };
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
 * The `applyUpdate` call. Refuses a publication that is not newer than the
 * recorded one (see {@link checkPublicationOrder}) and a removal set above
 * `maxRemove`. For an allowed rollback it also returns the owner's
 * `authorizePublicationRollback` calldata, which must execute first.
 *
 * `calls` is the ordered list of `applyUpdate` transactions, each naming its
 * signer: one `adder` call with the additions (or with nothing, as a
 * refresh), then one `remover` call with the delistings when there are any.
 * The second is computed against the version the first produces, and the
 * contract accepts it because it repeats the publication without adding.
 */
export function buildUpdate({
  parsed,
  sourceHash: hash,
  current,
  currentVersion,
  recordedDate,
  recordedHash,
  recordedPending = 0,
  allowRollback = false,
  maxRemove = DEFAULT_MAX_REMOVE,
  abi = sanctionsListAbi(),
}) {
  if (!Number.isSafeInteger(maxRemove) || maxRemove < 0) throw new Error(`maxRemove must be a non-negative integer, got ${maxRemove}`);
  if (recordedDate === undefined || recordedHash === undefined) throw new Error('the recorded publication date and hash are required');
  const { add, remove } = diffSets(parsed.addresses, current);
  const order = checkPublicationOrder({
    recordedDate: Number(recordedDate),
    recordedHash,
    date: parsed.publicationDate,
    hash,
    noAdditions: add.length === 0,
    allowRollback,
  });
  if (remove.length > maxRemove) {
    throw new Error(
      `refusing to delist ${remove.length} addresses (limit ${maxRemove}). OFAC delistings are rare; check the source file, then raise --max-remove deliberately.`,
    );
  }
  const version = BigInt(currentVersion);
  // `delistingsLeft` is what the contract publishes as `pendingDelistings`:
  // the adder's call leaves the remover's delistings outstanding, and the
  // remover's call completes the publication (Codex #2543 r7).
  const call = (signer, expectedVersion, toAdd, toRemove, delistingsLeft) => ({
    signer,
    expectedVersion,
    add: toAdd,
    remove: toRemove,
    delistingsLeft,
    calldata: encodeFunctionData({
      abi,
      functionName: 'applyUpdate',
      args: [expectedVersion, toAdd, toRemove, hash, parsed.publicationDate, delistingsLeft],
    }),
  });
  const calls = [];
  // A NEW publication declares its own outstanding count. A REPEAT of the
  // recorded one cannot: the contract lowers the recorded count only by the
  // delistings applied, and requires the declaration to match (Codex #2543
  // r8), so mirror that rule here.
  const pending = Number(recordedPending);
  const left = (applied, declaredForNew) => (order === 'same-publication' ? Math.max(0, pending - applied) : declaredForNew);
  // A delisting-only update of a NEWER publication still goes to the remover
  // alone; otherwise the adder records the publication (and its additions).
  if (add.length > 0 || remove.length === 0) calls.push(call('adder', version, add, [], left(0, remove.length)));
  if (remove.length > 0) calls.push(call('remover', version + BigInt(calls.length), [], remove, left(remove.length, 0)));
  return {
    add,
    remove,
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
 * The current list, read as ONE snapshot. The block is resolved once — the
 * given number, or the `finalized` tag by default — to its hash, and every
 * read (version, publication, hash, count, each page) is pinned to that hash
 * with `requireCanonical`, so a reorg during the reads makes them fail
 * instead of mixing two forks at one height.
 */
async function readCurrentFromChain(rpc, list, blockNumberArg, abi) {
  const client = createPublicClient({ transport: http(rpc) });
  const block = blockNumberArg !== undefined ? await client.getBlock({ blockNumber: blockNumberArg }) : await client.getBlock({ blockTag: 'finalized' });
  const blockNumber = block.number;
  const read = (functionName, args = []) => callAtHash(client, block, { address: list, abi, functionName, args });
  const version = await read('listVersion');
  const recordedDate = Number(await read('sourcePublicationDate'));
  const recordedHash = await read('sourceHash');
  const recordedPending = Number(await read('pendingDelistings'));
  const count = await read('listedCount');
  const addrs = [];
  const PAGE = 200n;
  for (let off = 0n; off < count; off += PAGE) addrs.push(...(await read('listedPage', [off, PAGE])));
  if (BigInt(addrs.length) !== count) throw new Error(`read ${addrs.length} addresses, listedCount says ${count}`);
  return { version, recordedDate, recordedHash, recordedPending, addresses: normaliseAddresses(addrs, 'on-chain list'), blockNumber, blockHash: block.hash, blockTag: blockNumberArg !== undefined ? 'number' : 'finalized' };
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
  let bytes;
  let source;
  if (args.fetch) {
    const res = await fetch(OFAC_SDN_ADVANCED_URL);
    if (!res.ok) throw new Error(`OFAC download failed: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    source = OFAC_SDN_ADVANCED_URL;
    if (args['save-xml']) writeFileSync(args['save-xml'], bytes);
  } else if (args.xml) {
    bytes = readFileSync(args.xml);
    source = args.xml;
  } else throw new Error('give --xml <file> or --fetch');

  const parsed = parseSdnAdvanced(bytes.toString('utf8'));
  const hash = sourceHash(bytes);
  const abi = sanctionsListAbi();

  let current;
  if (args.rpc || args.list) {
    if (!args.rpc || !args.list) throw new Error('--rpc and --list go together');
    const block = args.block !== undefined ? parseUintArg('--block', args.block) : undefined;
    current = await readCurrentFromChain(args.rpc, getAddress(args.list), block, abi);
    current.source = { list: getAddress(args.list), atBlock: current.blockNumber.toString(), atBlockHash: current.blockHash, pinnedFrom: current.blockTag };
  } else if (args.current) {
    if (args['current-version'] === undefined || args['current-publication'] === undefined) {
      throw new Error('--current needs --current-version and --current-publication (YYYYMMDD, or 0 before the first update)');
    }
    const recordedDate = Number(parseUintArg('--current-publication', args['current-publication'], { max: 29991231n }));
    if (recordedDate !== 0 && !isPublicationDate(recordedDate)) throw new Error(`--current-publication ${recordedDate} is not YYYYMMDD`);
    let recordedHash = `0x${'0'.repeat(64)}`;
    if (recordedDate !== 0) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(args['current-source-hash'] ?? '')) throw new Error('--current-source-hash (0x + 64 hex) is required with a non-zero --current-publication');
      recordedHash = args['current-source-hash'];
    }
    current = {
      version: parseUintArg('--current-version', args['current-version'], { max: 2n ** 64n - 1n }),
      recordedDate,
      recordedHash,
      recordedPending: args['current-pending'] !== undefined ? Number(parseUintArg('--current-pending', args['current-pending'], { max: 2n ** 32n - 1n })) : 0,
      addresses: readList(args.current),
      source: { file: args.current },
    };
  } else throw new Error('give the current list: --rpc + --list, or --current + --current-version + --current-publication');

  const maxRemove = args['max-remove'] !== undefined ? Number(parseUintArg('--max-remove', args['max-remove'], { max: 1_000_000n })) : DEFAULT_MAX_REMOVE;
  const update = buildUpdate({
    parsed,
    sourceHash: hash,
    current: current.addresses,
    currentVersion: current.version,
    recordedDate: current.recordedDate,
    recordedHash: current.recordedHash,
    recordedPending: current.recordedPending,
    allowRollback: args['allow-rollback'] === true,
    maxRemove,
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
    console.error(`applyUpdate at version ${c.expectedVersion}: +${c.add.length} -${c.remove.length}, signed by the ${c.signer === 'remover' ? 'REMOVER (the multisig)' : 'adder'}.`);
  }
  if (current.blockHash) console.error(`Current list read at block ${current.blockNumber} (${current.blockHash}, ${current.blockTag}).`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`ofac-sanctions-diff: ${e.message}`);
    process.exit(1);
  });
}
