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
 *      Malformed EVM-looking values (e.g. a truncated `0x…`) are reported for
 *      a human, never guessed at.
 *   3. Reads the CURRENT list: from the deployed contract at ONE pinned block
 *      (`--rpc` + `--list`; version, count and every page read at that block),
 *      or from a file (`--current` + `--current-version`).
 *   4. Prints the add / remove sets, the source SHA-256 and publication id
 *      (`DateOfIssue`), and the ready `applyUpdate` calldata (which carries the
 *      list version it was computed against, so it cannot apply to any other
 *      state).
 *
 * WHAT IT REFUSES, AND WHY:
 *   - A file in which it finds NO EVM address, no `DateOfIssue`, or no
 *     digital-currency feature types. A parser that silently finds nothing
 *     would emit a diff that delists everyone.
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
const EVM_ISH_RE = /^0x[0-9a-fA-F]*$/;

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

/**
 * Parse SDN Advanced XML text into its EVM addresses and publication id.
 * PURE; throws on any shape that would make an empty or partial answer look
 * like a real one.
 */
export function parseSdnAdvanced(xml) {
  if (!/<Sanctions\b[^>]*ofac\.treas\.gov/.test(xml)) {
    throw new Error('not an OFAC SDN Advanced XML document (no <Sanctions> root in the OFAC namespace)');
  }
  const doi = xml.match(/<DateOfIssue\b[^>]*>\s*<Year>(\d{4})<\/Year>\s*<Month>(\d{1,2})<\/Month>\s*<Day>(\d{1,2})<\/Day>/);
  if (!doi) throw new Error('no <DateOfIssue> — cannot identify the publication');
  const publicationId = `${doi[1]}-${doi[2].padStart(2, '0')}-${doi[3].padStart(2, '0')}`;

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
        } else if (EVM_ISH_RE.test(raw)) {
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
  return { publicationId, addresses: entries.map((e) => e.address), entries, excludedFalse: excluded, malformed, nonEvmByAsset };
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
 * The `applyUpdate` call. Refuses a removal set above `maxRemove`.
 */
export function buildUpdate({ parsed, sourceHash: hash, current, currentVersion, maxRemove = DEFAULT_MAX_REMOVE, abi = sanctionsListAbi() }) {
  const { add, remove } = diffSets(parsed.addresses, current);
  if (remove.length > maxRemove) {
    throw new Error(
      `refusing to delist ${remove.length} addresses (limit ${maxRemove}). OFAC delistings are rare; check the source file, then raise --max-remove deliberately.`,
    );
  }
  const version = BigInt(currentVersion);
  return {
    add,
    remove,
    calldata: encodeFunctionData({ abi, functionName: 'applyUpdate', args: [version, add, remove, hash, parsed.publicationId] }),
  };
}

// ── I/O (not exercised by the unit test) ─────────────────────────────

function parseArgs(argv) {
  const flags = new Set(['--fetch', '--help']);
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

async function readCurrentFromChain(rpc, list, blockArg, abi) {
  const client = createPublicClient({ transport: http(rpc) });
  const blockNumber = blockArg !== undefined ? BigInt(blockArg) : await client.getBlockNumber();
  const read = (functionName, args = []) => client.readContract({ address: list, abi, functionName, args, blockNumber });
  const version = await read('listVersion');
  const count = await read('listedCount');
  const addrs = [];
  const PAGE = 200n;
  for (let off = 0n; off < count; off += PAGE) addrs.push(...(await read('listedPage', [off, PAGE])));
  if (BigInt(addrs.length) !== count) throw new Error(`read ${addrs.length} addresses, listedCount says ${count}`);
  return { version, addresses: normaliseAddresses(addrs, 'on-chain list'), blockNumber };
}

async function readChainalysisFromChain(rpc, oracle, fromBlock, toBlockArg, chunk) {
  const client = createPublicClient({ transport: http(rpc) });
  const name = await client.readContract({ address: oracle, abi: parseAbi(['function name() pure returns (string)']), functionName: 'name' });
  if (!/chainalysis/i.test(name)) throw new Error(`${oracle} names itself "${name}", not Chainalysis's oracle — refusing`);
  const toBlock = toBlockArg !== undefined ? BigInt(toBlockArg) : await client.getBlockNumber();
  const logs = [];
  for (let start = BigInt(fromBlock); start <= toBlock; start += chunk) {
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
    current = await readCurrentFromChain(args.rpc, getAddress(args.list), args.block, abi);
    current.source = { list: getAddress(args.list), atBlock: current.blockNumber.toString() };
  } else if (args.current) {
    if (args['current-version'] === undefined) throw new Error('--current needs --current-version (the list version it reflects)');
    current = { version: BigInt(args['current-version']), addresses: readList(args.current), source: { file: args.current } };
  } else throw new Error('give the current list: --rpc + --list, or --current + --current-version');

  const maxRemove = args['max-remove'] !== undefined ? Number(args['max-remove']) : DEFAULT_MAX_REMOVE;
  const update = buildUpdate({ parsed, sourceHash: hash, current: current.addresses, currentVersion: current.version, maxRemove, abi });

  let chainalysis;
  if (args['chainalysis-list']) {
    chainalysis = { source: { file: args['chainalysis-list'] }, addresses: readList(args['chainalysis-list']) };
  } else if (args['chainalysis-rpc'] || args['chainalysis-oracle']) {
    if (!args['chainalysis-rpc'] || !args['chainalysis-oracle'] || args['chainalysis-from-block'] === undefined) {
      throw new Error('--chainalysis-rpc, --chainalysis-oracle and --chainalysis-from-block go together');
    }
    const oracle = getAddress(args['chainalysis-oracle']);
    const r = await readChainalysisFromChain(args['chainalysis-rpc'], oracle, args['chainalysis-from-block'], args['chainalysis-to-block'], BigInt(args['log-chunk'] ?? 10000));
    chainalysis = { source: { oracle, fromBlock: args['chainalysis-from-block'], toBlock: r.toBlock.toString(), logCount: r.logCount }, addresses: r.addresses };
  }

  const report = {
    source: { from: source, sha256: hash, publicationId: parsed.publicationId, evmAddressCount: parsed.addresses.length },
    excludedFalseReliability: parsed.excludedFalse,
    malformedEvmLikeValues: parsed.malformed,
    nonEvmAddressesByAsset: parsed.nonEvmByAsset,
    current: { ...current.source, version: current.version.toString(), count: current.addresses.length },
    update: {
      expectedVersion: current.version.toString(),
      add: update.add,
      remove: update.remove,
      sourceHash: hash,
      sourcePublicationId: parsed.publicationId,
      calldata: update.calldata,
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
