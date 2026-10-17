#!/usr/bin/env node
/**
 * #2443 — OFAC SDN → `SanctionsList` DIFF TOOL (offline; signs nothing, sends
 * nothing).
 *
 * The mainnet sanctions source is Vaipakam's own on-chain `SanctionsList`
 * (OR-composed with RedStone's oracle where deployed). Its updater applies
 * ONE update per OFAC publication. This tool computes that update:
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
 *      (`--rpc` + `--list`; version, publication, hash, count and every page
 *      read at that block), or from a file (`--current` + `--current-version`
 *      + `--current-publication` [+ `--current-source-hash`]).
 *   4. Prints the add / remove sets, the source SHA-256 and publication date
 *      (`DateOfIssue` as `YYYYMMDD`), and the ready `applyUpdate` calldata
 *      (which carries the list version it was computed against, so it cannot
 *      apply to any other state).
 *
 * WHAT IT REFUSES, AND WHY:
 *   - An INCOMPLETE document (Codex #2543 r1). Before anything is extracted,
 *     the whole input is scanned as XML structure: every tag must be
 *     terminated, every element closed in order, exactly one root
 *     (`<Sanctions>`) must close at the end, and nothing but whitespace,
 *     comments or processing instructions may follow it. A truncated download
 *     fails that check wherever it was cut. This is a structural
 *     well-formedness check, not a full XML 1.0 validator: entity, attribute
 *     and character-class rules would need a parser dependency, and they are
 *     not what a truncated or spliced file breaks. A DOCTYPE is refused
 *     outright (OFAC's file has none, and an internal subset needs a grammar).
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
 *     --current current.json --current-version 3
 *   … [--chainalysis-rpc "$RPC" --chainalysis-oracle 0x40C5… \
 *      --chainalysis-from-block 14356508 [--log-chunk 10000]]
 *   … [--chainalysis-list chainalysis.json]
 *
 * Where the updater runs and who signs on mainnet is an OPEN owner question
 * (#2443); this tool deliberately stops at calldata.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, http, getAddress, encodeFunctionData, parseAbi, parseAbiItem } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OFAC_SDN_ADVANCED_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML';
export const DEFAULT_MAX_REMOVE = 10;

const DCA_PREFIX = 'Digital Currency Address - ';
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_PREFIX_RE = /^0x/i;

/** The compiled `SanctionsList` ABI — never hand-typed. */
export function sanctionsListAbi() {
  return JSON.parse(readFileSync(join(HERE, '..', 'src', 'abis', 'SanctionsList.json'), 'utf8'));
}

/** SHA-256 of the exact source bytes, as `0x`-prefixed hex (bytes32). */
export function sourceHash(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Text of every `<Tag ID="n" …>text</Tag>` in the document, by ID. */
function referenceValues(xml, tag) {
  const out = new Map();
  const re = new RegExp(`<${tag}\\b[^>]*\\bID="(\\d+)"[^>]*>([^<]*)</${tag}>`, 'g');
  for (const m of xml.matchAll(re)) out.set(m[1], m[2].trim());
  return out;
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

/**
 * Throws unless `xml` is a COMPLETE document: every tag terminated, every
 * element closed in order, one root named `rootName` closed at the end, and
 * only whitespace, comments or processing instructions outside it. The scan
 * covers the whole input. See the header for what this does and does not
 * check, and why.
 */
export function assertCompleteXml(xml, rootName = 'Sanctions') {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack = [];
  let root = null;
  let rootClosed = false;
  const outside = (from, to) => {
    if (/\S/.test(xml.slice(from, to))) throw new Error(`incomplete XML: content outside the root element at offset ${from}`);
  };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (stack.length === 0) outside(i, lt === -1 ? n : lt);
    if (lt === -1) break;
    const closer = (token, from) => {
      const e = xml.indexOf(token, from);
      if (e === -1) throw new Error(`incomplete XML: unterminated construct at offset ${lt}`);
      return e + token.length;
    };
    if (xml.startsWith('<!--', lt)) {
      i = closer('-->', lt + 4);
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw new Error(`incomplete XML: CDATA outside the root at offset ${lt}`);
      i = closer(']]>', lt + 9);
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      i = closer('?>', lt + 2);
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new Error(`refusing a DOCTYPE or markup declaration at offset ${lt}`);
    const gt = tagEnd(xml, lt);
    if (gt === -1) throw new Error(`incomplete XML: unterminated tag at offset ${lt}`);
    const body = xml.slice(lt + 1, gt);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open === undefined || open !== name) {
        throw new Error(`malformed XML: </${name}> at offset ${lt} closes ${open === undefined ? 'nothing' : `<${open}>`}`);
      }
      if (stack.length === 0) rootClosed = true;
    } else {
      const m = body.match(NAME_RE);
      if (!m) throw new Error(`malformed XML: bad tag at offset ${lt}`);
      if (rootClosed || (stack.length === 0 && root !== null)) throw new Error(`malformed XML: second root element <${m[0]}> at offset ${lt}`);
      if (root === null) root = m[0];
      if (body.endsWith('/')) {
        if (stack.length === 0) rootClosed = true;
      } else stack.push(m[0]);
    }
    i = gt + 1;
  }
  if (root === null) throw new Error('incomplete XML: no root element');
  if (stack.length) throw new Error(`incomplete XML: ${stack.length} element(s) never closed, innermost <${stack[stack.length - 1]}> — the file is truncated`);
  if (root !== rootName) throw new Error(`unexpected root element <${root}> (want <${rootName}>)`);
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
 * a newer date passes; the same date passes only as a refresh (identical
 * hash, empty diff); anything else is refused unless `allowRollback`, in
 * which case the owner must authorize it on-chain first.
 */
export function checkPublicationOrder({ recordedDate, recordedHash, date, hash, diffEmpty, allowRollback = false }) {
  if (date > recordedDate) return 'newer';
  if (date === recordedDate && hash.toLowerCase() === String(recordedHash).toLowerCase() && diffEmpty) return 'refresh';
  if (allowRollback) return 'rollback';
  if (date === recordedDate && hash.toLowerCase() === String(recordedHash).toLowerCase()) {
    throw new Error(`the list already records this exact file (${date}) yet differs from it — investigate before updating`);
  }
  throw new Error(
    `publication ${date} (${hash}) is not newer than the recorded ${recordedDate} (${recordedHash}); a rollback or a same-day reissue needs --allow-rollback and the owner's authorizePublicationRollback`,
  );
}

/**
 * Parse SDN Advanced XML text into its EVM addresses and publication id.
 * PURE; throws on any shape that would make an empty or partial answer look
 * like a real one.
 */
export function parseSdnAdvanced(xml) {
  assertCompleteXml(xml);
  if (!/<Sanctions\b[^>]*ofac\.treas\.gov/.test(xml)) {
    throw new Error('not an OFAC SDN Advanced XML document (no <Sanctions> root in the OFAC namespace)');
  }
  const doi = xml.match(/<DateOfIssue\b[^>]*>\s*<Year>(\d{4})<\/Year>\s*<Month>(\d{1,2})<\/Month>\s*<Day>(\d{1,2})<\/Day>/);
  if (!doi) throw new Error('no <DateOfIssue> — cannot identify the publication');
  const publicationId = `${doi[1]}-${doi[2].padStart(2, '0')}-${doi[3].padStart(2, '0')}`;
  const publicationDate = Number(publicationId.replaceAll('-', ''));
  if (!isPublicationDate(publicationDate)) throw new Error(`<DateOfIssue> ${publicationId} is not a valid date`);

  const featureTypes = referenceValues(xml, 'FeatureType');
  const dcaTypes = new Map([...featureTypes].filter(([, n]) => n.startsWith(DCA_PREFIX)).map(([id, n]) => [id, n.slice(DCA_PREFIX.length)]));
  if (dcaTypes.size === 0) throw new Error('no "Digital Currency Address - *" feature types — the file format may have changed');
  const reliability = referenceValues(xml, 'Reliability');
  const falseIds = new Set([...reliability].filter(([, n]) => n === 'False').map(([id]) => id));

  const byAddress = new Map(); // lowercase -> { address, assets:Set }
  const excludedFalse = [];
  const malformed = [];
  const nonEvmByAsset = {};
  // The lookahead skips a self-closing `<Feature … />`, which would otherwise
  // swallow the NEXT feature's body and file its address under this type.
  const featureRe = /<Feature\b(?![^>]*\/>)[^>]*\bFeatureTypeID="(\d+)"[^>]*>([\s\S]*?)<\/Feature>/g;
  for (const f of xml.matchAll(featureRe)) {
    const asset = dcaTypes.get(f[1]);
    if (asset === undefined) continue;
    const versionRe = /<FeatureVersion\b(?![^>]*\/>)([^>]*)>([\s\S]*?)<\/FeatureVersion>/g;
    for (const v of f[2].matchAll(versionRe)) {
      const rel = (v[1].match(/\bReliabilityID="(\d+)"/) ?? [])[1];
      for (const d of v[2].matchAll(/<VersionDetail\b[^>]*>([^<]*)<\/VersionDetail>/g)) {
        const raw = d[1].trim();
        if (EVM_RE.test(raw)) {
          const address = getAddress(raw.toLowerCase());
          if (rel !== undefined && falseIds.has(rel)) {
            excludedFalse.push({ address, asset });
            continue;
          }
          const key = address.toLowerCase();
          if (!byAddress.has(key)) byAddress.set(key, { address, assets: new Set() });
          byAddress.get(key).assets.add(asset);
        } else if (HEX_PREFIX_RE.test(raw)) {
          malformed.push({ value: raw, asset });
        } else {
          nonEvmByAsset[asset] = (nonEvmByAsset[asset] ?? 0) + 1;
        }
      }
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
 */
export function buildUpdate({
  parsed,
  sourceHash: hash,
  current,
  currentVersion,
  recordedDate,
  recordedHash,
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
    diffEmpty: add.length + remove.length === 0,
    allowRollback,
  });
  if (remove.length > maxRemove) {
    throw new Error(
      `refusing to delist ${remove.length} addresses (limit ${maxRemove}). OFAC delistings are rare; check the source file, then raise --max-remove deliberately.`,
    );
  }
  const version = BigInt(currentVersion);
  return {
    add,
    remove,
    order,
    authorizeCalldata:
      order === 'rollback'
        ? encodeFunctionData({ abi, functionName: 'authorizePublicationRollback', args: [parsed.publicationDate, hash] })
        : null,
    calldata: encodeFunctionData({ abi, functionName: 'applyUpdate', args: [version, add, remove, hash, parsed.publicationDate] }),
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

async function readCurrentFromChain(rpc, list, block, abi) {
  const client = createPublicClient({ transport: http(rpc) });
  const blockNumber = block ?? (await client.getBlockNumber());
  const read = (functionName, args = []) => client.readContract({ address: list, abi, functionName, args, blockNumber });
  const version = await read('listVersion');
  const recordedDate = Number(await read('sourcePublicationDate'));
  const recordedHash = await read('sourceHash');
  const count = await read('listedCount');
  const addrs = [];
  const PAGE = 200n;
  for (let off = 0n; off < count; off += PAGE) addrs.push(...(await read('listedPage', [off, PAGE])));
  if (BigInt(addrs.length) !== count) throw new Error(`read ${addrs.length} addresses, listedCount says ${count}`);
  return { version, recordedDate, recordedHash, addresses: normaliseAddresses(addrs, 'on-chain list'), blockNumber };
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
    current.source = { list: getAddress(args.list), atBlock: current.blockNumber.toString() };
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
      calldata: update.calldata,
      ...(update.authorizeCalldata
        ? { ownerMustFirstCall: { function: 'authorizePublicationRollback', args: [parsed.publicationDate, hash], calldata: update.authorizeCalldata } }
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
  if (update.order === 'rollback') {
    console.error(`ROLLBACK: the owner must first call authorizePublicationRollback(${parsed.publicationDate}, ${hash}); see ownerMustFirstCall.`);
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
