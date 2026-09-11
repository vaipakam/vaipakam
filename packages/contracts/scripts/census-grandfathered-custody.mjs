#!/usr/bin/env node
/**
 * #1566 — GRANDFATHERED-CUSTODY CENSUS (read-only).
 *
 * Slices 0–3 of `Vpfi1566CanonicalDeliveredBoundDesign.md` exist only to move
 * four GRANDFATHERED custody classes out of commingled Diamond custody. The
 * path that creates `vpfiHeld` was retired by #1352, and the FunctionalSpecs
 * state that a platform deployed fresh has no such loans — so how much of that
 * migration is real work is an EMPIRICAL question with a cheap answer.
 *
 * The owner ratified (2026-09-07) that this census runs BEFORE any migration
 * machinery is written. Its output decides scope:
 *
 *   - every class empty on every deployment      → nothing to move AT THE
 *     CENSUS BLOCK. That retires the MIGRATION half of slices 0–3 (and slice
 *     0's shortfall disposition) ONLY when no qualifying row can be written
 *     after that block and before the isolation lands — i.e. the scan follows
 *     a producer freeze that has finalized, or isolation is already deployed
 *     (Codex #2070 r13/r14). A row written in that window would sit in shared
 *     custody with no migration path once the movers are gone, so the report
 *     carries `migrationRetirable` (false while any deployment may have a
 *     live producer) and names the re-run that would earn it. It never
 *     retires slices 2–3's prospective producer/consumer isolation;
 *   - any class non-empty                        → that slice is live work, and
 *     the figures here are what carry the owner the shortfall question.
 *
 * WHY A COMMITTED SCRIPT RATHER THAN A ONE-OFF QUERY: "the set was empty" is a
 * claim a later reader must be able to RE-RUN, not trust. The artifact records
 * the chain, the Diamond, the block, and the full loan-id range scanned, so the
 * same census can be reproduced against the same state.
 *
 * THE UNIT IS A DEPLOYMENT, NOT A CHAIN. A `--fresh` redeploy archives the
 * off-chain artifact under `.archive/<stamp>/` but cannot wipe on-chain storage,
 * so every retained Diamond — live plus archived — is censused, each against
 * its own Diamond, VPFI token and deploy block. The global verdict needs all
 * of them; a `--chain` run is partial and writes its own file.
 *
 * EVERY ROW IS FILTERED TO THE DEPLOYMENT'S VPFI. The four classes are VPFI
 * custody specifically (the shared VPFI balance is the design's premise), so a
 * fallback snapshot or intent commit in another collateral is out of scope —
 * recorded as excluded, never silently dropped. No VPFI token in the artifact
 * ⇒ the deployment cannot be scoped ⇒ indeterminate.
 *
 * WHAT IT READS, AND WHY THAT WAY:
 *   - classes 1 & 4 (`vpfiHeld` custody, rebate rows) — `getBorrowerLifRebate`
 *     (VPFI by construction — these ARE VPFI amounts)
 *   - class 2 (fallback snapshot custody)             — `getFallbackSnapshot`,
 *     scoped by the loan's `collateralAsset` from `getLoanDetails`
 *   - class 3 (live VPFI intent commits)              — `getIntentCommit`, the
 *     facet's own view, scoped by `makerAsset`. This reads LIVE STATE, which
 *     is precisely what the class is defined as; the view reverts
 *     `IntentNoCommit` exactly when no commit is live, and that revert is the
 *     proof of absence. It is history-INDEPENDENT, which matters: public nodes
 *     prune, and an earlier revision reconstructed the class from the event
 *     lifecycle and was left unable to answer on a pruned endpoint.
 *     Hand-computed storage slots were never an option — they fail SILENTLY
 *     as zero, manufacturing the exact "empty" answer this census exists to
 *     establish.
 *
 *     WHERE THE GETTER IS UNROUTED, class 3 is INDETERMINATE. A zero VPFI
 *     balance does NOT settle it (an earlier revision of this header said it
 *     did): a payout can spend the backing while the row survives, so zero
 *     VPFI proves the rows UNBACKED, not absent — it is recorded as backing
 *     against the rows' total instead. The only proof of an absent row is a
 *     state read of the ROW: a routed getter, or a calibrated storage slot
 *     proven against a routed getter on a live row first. The DiamondCut
 *     history is scanned too, but it can only REFUTE: no continuity test over
 *     eth_getLogs can rule out an omitted Add/Remove pair whose net routing
 *     change is zero, and a commit written inside that interval may still be
 *     live. Its passing is not evidence.
 *
 *     The event-lifecycle reconstruction is retained behind `--corroborate`
 *     as an INDEPENDENT second source. It pairs commit → teardown by
 *     `(loanId, orderHash)`; a disagreement with the view is reported loudly.
 *
 * Every ABI here comes from the compiled artifacts in `../src/abis` — nothing
 * is hand-typed, so a signature change surfaces as a decode error rather than a
 * wrong number.
 *
 * SCANNING NOTHING IS A HARD ERROR. A census that quietly reads zero loans
 * would report "empty" for every class and look like the good outcome.
 *
 * Usage:
 *   node packages/contracts/scripts/census-grandfathered-custody.mjs \
 *     [--chain base-sepolia|all] [--rpc URL] [--out DIR] [--block N]
 *
 * RPC resolution order: `--rpc`, then `CENSUS_RPC_<SLUG_WITH_UNDERSCORES>`,
 * then `CENSUS_RPC_URL`, then the public default for known testnets.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { readManifest, regenerateEntries, withManifestLock, writeSnapshotGuarded, livePublicationsInProgress, sameEntry } from './archive-manifest.mjs';
import { loadSlots, loadEras } from './storage-slots.mjs';
import { commitsAround, deployedAtIso, interpolateTimestamp, CANDIDATES_FILE } from './storage-layout-eras.mjs';
import { prepareStorageRead, readCountersByStorage, scanRowsByStorage, intentVerdictFromStorage, mergeHistoricalRows, markAliasedRows, splitByHeadSlot, getterAgreement, downgradeWithoutEraRead, attributeCounters, attributeFacetCode, downgradeProvenClasses, downgradeStorageOnlyProofs, STORAGE_ONLY_PROOFS, requireHexData, cutHistoryCompleteness, DIAMOND_CUT_SELECTOR, MAX_STORAGE_LOAN_SCAN } from './census-storage-read.mjs';

/** Sum a row field as a decimal string. A function declaration, so it is hoisted above every branch that returns early (#2095 r1 P2). */
function sum(rows, field) {
  return rows.reduce((a, r) => a + BigInt(r[field]), 0n).toString();
}

/**
 * #1566 design §7/§7a — the ERA-COMPLETE storage read, prepared once from the
 * two compiler-generated tables. `ok: false` carries the reason and every
 * cell that would have needed it stays indeterminate with that reason
 * recorded; the read is never attempted on a half-validated table.
 */
const STORAGE_READ = (() => {
  try {
    return prepareStorageRead({ slots: loadSlots(), eras: loadEras() });
  } catch (err) {
    return { ok: false, reason: `slot tables unreadable: ${String(err.message).split('\n')[0]}` };
  }
})();
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, toFunctionSelector, parseAbiItem, encodeFunctionData, decodeFunctionResult, decodeErrorResult, keccak256 } from 'viem';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { resolve as resolvePath } from 'node:path';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';

/**
 * EIP-2535's cut event — the COMPLETE routing history of a Diamond. Declared
 * here rather than loaded because the exported ABI bundle carries the loupe
 * but not the cut facet, and this is the standard's own signature.
 */
const DIAMOND_CUT_EVENT = parseAbiItem(
  'event DiamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)',
);
/** Standard ERC-20 balance read — the bundle exports no plain ERC-20 ABI. */
const ERC20_BALANCE_OF = parseAbiItem('function balanceOf(address account) view returns (uint256)');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const DEPLOYMENTS = join(REPO, 'contracts/deployments');
const ABIS = join(HERE, '../src/abis');

const PUBLIC_RPC = {
  'base-sepolia': 'https://sepolia.base.org',
  // op-sepolia: publicnode, not the official `sepolia.optimism.io`. On
  // 2026-09-09 the official endpoint's load balancer served a `finalized` tag
  // 1.46 M blocks (~34 days) stale on most requests and the fresh one on a
  // minority, with `safe` below its own `finalized` — the monotonic-height
  // guard refused it 7/7 times. publicnode served consistent finality and every
  // state read at it. publicnode PRUNES receipts (the first lesson this file
  // learned, on this very chain), so the cut-history reading comes back
  // `unreadable` here — which costs nothing now that reading is refutation-only
  // and class 3 on this chain is indeterminate without a routed getter either
  // way. State certifies; logs never did. Override with CENSUS_RPC_OP_SEPOLIA.
  'op-sepolia': 'https://optimism-sepolia-rpc.publicnode.com',
  // arb-sepolia: Tenderly's public gateway, not the official
  // `sepolia-rollup.arbitrum.io`. On 2026-09-09 the official endpoint's
  // replicas were dispersed by ~35k blocks: its finality tag answered
  // consistently but STATE reads at that height kept landing on replicas
  // that had not reached it (12/12 HTTP/1.1, 10/12 HTTP/2 in a direct
  // experiment), and the lagging heads sat below the committed floor, so
  // neither connection rotation nor the lagging-head cap could find a
  // servable height — three full runs lost arb-sepolia that way. Tenderly
  // answered the same finalized height as the official endpoint (307055614),
  // served state there, at the floor and 200k blocks back, answered log
  // ranges, and censused all four deployments at FINALIZED (no safe
  // downgrade) with zero rotations. The official endpoint remains the
  // documented alternative via CENSUS_RPC_ARB_SEPOLIA.
  'arb-sepolia': 'https://arbitrum-sepolia.gateway.tenderly.co',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
  'bnb-testnet': 'https://bsc-testnet-rpc.publicnode.com',
};

/** Chains that are local-only fixtures rather than deployed state. */
const NOT_A_DEPLOYMENT = new Set(['anvil']);

const PAGE = 200n;
/**
 * Log-scan tuning. Spans here are large because the ranges are: the intent
 * scan runs from the deploy block to head, which on a fast testnet is tens of
 * millions of blocks (arb-sepolia was ~23.6M at the time of writing). A 10k
 * span walked sequentially is thousands of round trips; a wider span with
 * bounded concurrency turns that into tens. Each window still halves on a
 * provider range error, so a stricter endpoint degrades rather than fails.
 */
const DEFAULT_LOG_SPAN = 50_000n;
const LOG_CONCURRENCY = Number(process.env.CENSUS_LOG_CONCURRENCY ?? 3);
const RATE_LIMIT_RETRIES = 6;

/**
 * Provider failures are not interchangeable, and treating them as one kind is
 * how a census lies. Three behaviours:
 *   - `range`      — the window is too wide. Halve and retry; harmless.
 *   - `rate`       — we are asking too fast. Back off and retry; harmless.
 *   - `pruned`     — the node no longer HAS the history. No amount of retrying
 *                    produces the answer, and reporting "no logs found" here
 *                    would assert emptiness from a node that cannot see.
 */
function classifyRpcError(err) {
  const m = `${err?.details ?? ''} ${err?.shortMessage ?? ''} ${err?.message ?? ''}`.toLowerCase();
  if (/pruned|history has been pruned|missing trie node|state not available|not available on this node|metadata is not found|historical state .* is not available/.test(m)) {
    return 'pruned';
  }
  if (/rate limit|429|requests per second|too many requests|capacity/.test(m)) return 'rate';
  if (/range|too large|exceed|more than|limit/.test(m)) return 'range';
  return 'unknown';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Codex #2070 r28 P1 — every STATE read is pinned by BLOCK HASH (EIP-1898),
 * never by number. A number names a height; two replicas on competing forks
 * serve two different blocks at it, so a snapshot of number-pinned reads can
 * mix forks while an identity check that happens to land on the "right"
 * replica passes. A hash names one block: a replica that lacks it errors
 * (`block not found` / `header not found`, which withReplicaRetry rotates
 * away), and `requireCanonical` makes one that holds it on a side fork refuse
 * as well. Every census endpoint honours the block-object form for eth_call,
 * eth_getCode and eth_getStorageAt (probed 2026-09-09). viem's `call` action
 * has no blockHash parameter, so the request goes through the raw transport,
 * and a revert is decoded here the way readContract would decode it so the
 * census's detectors (IntentNoCommit, FunctionDoesNotExist, "returned no
 * data") keep matching on the same fields.
 */
export function blockRef(block) {
  const hash = String(block?.hash ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(`blockRef: a state read must be pinned to the census block's HASH, got ${JSON.stringify(block?.hash)}`);
  return { blockHash: hash, requireCanonical: true };
}
/**
 * Shape a raw-transport revert the way viem's readContract shapes one, so the
 * census's detectors keep matching on the same fields. Two cases, and BOTH
 * must carry the revert data: an error the ABI knows is decoded to its name
 * (`IntentNoCommit()`), and one it does not — the Diamond fallback's own
 * `FunctionDoesNotExist(bytes4)` is not in any facet ABI — is reported by its
 * SIGNATURE, exactly as viem does ("reverted with the following signature:
 * 0xa9ad62f8…"). The first cut of this helper returned null for the unknown
 * case and let the raw error through, whose `details` is just "execution
 * reverted": the selector detector then missed, and three bare Diamond shells
 * classified as "not a Vaipakam Diamond" (caught comparing a post-merge
 * partial run with run 26; never published). Exported for the test.
 */
/**
 * The Diamond FALLBACK's own "no facet for this selector" error,
 * `VaipakamDiamond.FunctionDoesNotExist()` — no arguments, so the revert data
 * is EXACTLY the four-byte selector 0xa9ad62f8. Only that exact payload proves
 * a selector unrouted on a Vaipakam Diamond (#2088 r2 P2): a contract that
 * answers the selector followed by anything else is some other contract
 * talking and stays `notADiamond`. Reads the raw `data` that
 * {revertErrorLikeViem} attaches, never the message text, so nothing that
 * merely MENTIONS the selector counts. Exported for the test.
 */
export const FUNCTION_DOES_NOT_EXIST_SELECTOR = '0xa9ad62f8';
export function isFunctionDoesNotExistRevert(err) {
  const data = typeof err?.data === 'string' ? err.data.toLowerCase() : null;
  if (data === FUNCTION_DOES_NOT_EXIST_SELECTOR) return true;
  // decoded by name (only if some ABI carried the error): still requires the exact four-byte payload
  return /^FunctionDoesNotExist$/.test(`${err?.errorName ?? ''}`) && data === FUNCTION_DOES_NOT_EXIST_SELECTOR;
}
/**
 * viem's own gate, and no wider: JSON-RPC code 3 (`ExecutionRevertedError.code`,
 * EIP-1474 "execution error"), its node message
 * `/execution reverted|gas required exceeds allowance/`, or — the form
 * viem's getContractError also accepts (#2088 r4 P2) — an INTERNAL error
 * (-32603, `InternalRpcError.code`) that carries revert DATA: some nodes
 * report an eth_call revert that way with only "Internal error" as text. A
 * bare "revert" in a provider's text — a -32602 that cannot serve a
 * "reverted" block, say — is NOT an execution revert and must surface as the
 * provider failure it is, whatever hex `data` rides along (r1/r3 P2); and an
 * internal error WITHOUT data is a provider failure too.
 */
const EXECUTION_REVERT_NODE_MESSAGE = /execution reverted|gas required exceeds allowance/i;
const INTERNAL_RPC_ERROR_CODE = -32603;
export function revertDataOf(err) {
  const pick = (v) => (typeof v === 'string' && /^0x[0-9a-f]{8,}$/i.test(v) ? v.toLowerCase() : null);
  return pick(err?.data) ?? pick(err?.cause?.data) ?? pick(err?.data?.data);
}
export function isExecutionRevert(err) {
  const codes = [err?.code, err?.cause?.code, err?.cause?.cause?.code];
  if (codes.some((c) => c === 3)) return true;
  if (codes.some((c) => c === INTERNAL_RPC_ERROR_CODE) && revertDataOf(err) !== null) return true;
  return EXECUTION_REVERT_NODE_MESSAGE.test(`${err?.details ?? ''} ${err?.shortMessage ?? ''} ${err?.message ?? ''} ${err?.cause?.message ?? ''}`);
}
export function revertErrorLikeViem(err, abi, functionName) {
  if (!isExecutionRevert(err)) return null;
  const lower = revertDataOf(err);
  if (!lower) return null;
  let e;
  try {
    const d = decodeErrorResult({ abi, data: lower });
    const sig = `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
    e = new Error(`The contract function "${functionName}" reverted with the following reason:\n${sig}`);
    e.metaMessages = [`Error: ${sig}`];
    e.errorName = d.errorName;
  } catch {
    e = new Error(
      `The contract function "${functionName}" reverted with the following signature:\n${lower.slice(0, 10)}\nUnable to decode signature "${lower.slice(0, 10)}" as it was not found on the provided ABI.\nRaw revert data: ${lower}`,
    );
    e.metaMessages = [`Signature: ${lower.slice(0, 10)}`];
    e.signature = lower.slice(0, 10);
  }
  e.shortMessage = `The contract function "${functionName}" reverted.`;
  e.details = err?.details ?? err?.message;
  e.data = lower;
  e.cause = err;
  return e;
}
async function callAtHash(client, block, { address, abi, functionName, args = [] }) {
  const data = encodeFunctionData({ abi, functionName, args });
  let raw;
  try {
    raw = await client.request({ method: 'eth_call', params: [{ to: address, data }, blockRef(block)] });
  } catch (err) {
    throw revertErrorLikeViem(err, abi, functionName) ?? err;
  }
  requireHexData(raw, `eth_call ${functionName}`);
  if (raw === '0x') {
    const e = new Error(`The contract function "${functionName}" returned no data ("0x").`);
    e.shortMessage = e.message;
    throw e;
  }
  return decodeFunctionResult({ abi, functionName, data: raw });
}
async function codeAtHash(client, block, address) {
  return client.request({ method: 'eth_getCode', params: [address, blockRef(block)] });
}
/** A raw storage slot at the census block, hash-pinned like every other state read (design §7 question 4). */
async function storageAtHash(client, block, address, slot) {
  return BigInt(requireHexData(await client.request({ method: 'eth_getStorageAt', params: [address, slot, blockRef(block)] }), `eth_getStorageAt ${slot.slice(0, 12)}`));
}
/** keccak256 of an account's runtime code at the census block (hash-pinned) — the key into each era's bytecode catalogue. */
async function codeHashAtHash(client, block, address) {
  return keccak256(requireHexData(await client.request({ method: 'eth_getCode', params: [address, blockRef(block)] }), `eth_getCode ${address}`));
}

/**
 * #2095 r9 P1 — the facet addresses every LOCAL record of a Diamond names:
 * the live artifact, every `.archive/<stamp>/addresses.json` and every
 * sidecar of the same slug whose `diamond` is this one. An archived record of
 * a Diamond later refreshed in place is the only record of the facets that
 * wrote BEFORE the refresh. `.archive/` is gitignored, so on a checkout
 * without it the recorded sources are fewer — that is reported, never assumed.
 */
function recordedFacetAddresses(slug, diamond, manifest = null) {
  const out = new Map();
  const add = (a, src) => {
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) return;
    const k = a.toLowerCase();
    if (!out.has(k)) out.set(k, new Set());
    out.get(k).add(src);
  };
  const records = [];
  const consider = (file, src) => {
    let a;
    try { a = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
    if (`${a.diamond ?? ''}`.toLowerCase() !== diamond.toLowerCase()) return;
    for (const v of Object.values(a.facets ?? {})) add(v, src);
    records.push(src);
    const iso = deployedAtIso(a.deployedAt);
    if (iso) deployedAt.push({ record: src, iso });
  };
  const deployedAt = [];
  // the COMMITTED manifest's facet set for this record (#2095 r10 P1) — what a
  // clean checkout has; the local .archive/ record, when present, adds nothing
  // beyond it but is read too
  if (manifest?.facets?.length) { for (const a of manifest.facets) add(a, `manifest:${manifest.stamp}`); records.push(`manifest:${manifest.stamp}`); const iso = deployedAtIso(manifest.deployedAt); if (iso) deployedAt.push({ record: `manifest:${manifest.stamp}`, iso }); }
  consider(join(DEPLOYMENTS, slug, 'addresses.json'), 'record:live');
  const archiveDir = join(DEPLOYMENTS, slug, '.archive');
  if (existsSync(archiveDir)) for (const stamp of readdirSync(archiveDir).sort()) consider(join(archiveDir, stamp, 'addresses.json'), `record:${stamp}`);
  for (const f of sidecarsOf(slug)) consider(join(DEPLOYMENTS, slug, f), `record:${f}`);
  return { facets: [...out.entries()].map(([address, sources]) => ({ address, sources: [...sources] })), records, deployedAt };
}

/** The source record beside a deployment's artifact, as EVIDENCE only: a `(dirty)` stamp says the tree had uncommitted changes, not which files. */
function sourceRecordFor(slug, label) {
  const dir = label === 'live' ? join(DEPLOYMENTS, slug) : label.startsWith('archived ') ? join(DEPLOYMENTS, slug, '.archive', label.slice('archived '.length)) : null;
  const file = dir ? join(dir, 'deployment_source.json') : null;
  if (!file) return { recorded: false };
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const m = /^([0-9a-f]{40})(\s*\(dirty\))?/.exec(`${d.monorepoCommit ?? ''}`);
    return { recorded: true, commit: m?.[1] ?? null, dirty: Boolean(m?.[2]), deployedAt: d.deployedAt ?? null };
  } catch {
    return { recorded: false };
  }
}

/**
 * Every facet address the cut history ever ADDED or REPLACED in — a
 * REFUTATION-ONLY source: a pruned endpoint returns an empty history, which
 * proves nothing (the lesson of #2070 r5), so an empty or unreadable history
 * widens nothing and is reported as such.
 */
async function facetsFromCutHistory(client, diamond, fromBlock, toBlock) {
  try {
    const logs = await getLogsChunked(client, { address: diamond, events: [DIAMOND_CUT_EVENT], fromBlock, toBlock });
    const blocksOf = new Map();
    // the constructor's own DiamondCut carries an EMPTY cut array; it is the
    // first log of a complete history (#2095 r13 P1)
    const ordered = [...logs].sort((a, b) => (BigInt(a.blockNumber ?? 0) === BigInt(b.blockNumber ?? 0) ? Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0) : BigInt(a.blockNumber ?? 0) < BigInt(b.blockNumber ?? 0) ? -1 : 1));
    const constructorCutSeen = ordered.length > 0 && (ordered[0].args?._diamondCut ?? []).length === 0;
    // #2095 r15 P1 — a cut's non-zero `_init` was DELEGATECALLED in the
    // Diamond's context and could write any slot: it is a writer like a facet
    // and joins the population under its own source tag
    const initializers = new Set();
    const noteBlock = (k, log) => { if (!blocksOf.has(k)) blocksOf.set(k, new Set()); if (log.blockNumber !== undefined && log.blockNumber !== null) blocksOf.get(k).add(BigInt(log.blockNumber)); };
    for (const log of logs) {
      for (const cut of log.args?._diamondCut ?? []) {
        if (Number(cut.action) === 2 || typeof cut.facetAddress !== 'string') continue;
        noteBlock(cut.facetAddress.toLowerCase(), log);
      }
      const init = typeof log.args?._init === 'string' ? log.args._init.toLowerCase() : null;
      if (init && init !== ZERO_ADDRESS) { initializers.add(init); noteBlock(init, log); }
    }
    return { addresses: [...blocksOf.keys()], initializers: [...initializers], blocksOf, cuts: logs.length, constructorCutSeen, verdict: logs.length ? 'read' : 'empty (proves nothing — a pruned endpoint returns empty)' };
  } catch (err) {
    return { addresses: [], initializers: [], blocksOf: new Map(), cuts: 0, constructorCutSeen: false, verdict: 'unreadable', reason: String(err?.shortMessage ?? err?.message ?? err).slice(0, 200) };
  }
}

/**
 * The PROOF STANDARD (#2095 r9/r10 — decision put to the owner on #1566):
 *   provenance (default) — a routed read certifies only when every facet that
 *     ever wrote is attributed to a catalogued layout AND the facet
 *     population is exhaustive (a complete cut history);
 *   routed — the programme's ratified standard: a routed-getter enumeration
 *     is a sound proof; provenance and population are recorded, never gating.
 * Recorded on the artifact and on every result.
 */
const PROOF_STANDARD = (() => { const v = arg('--proof-standard', 'provenance'); if (!['provenance', 'routed'].includes(v)) throw new Error(`--proof-standard must be provenance or routed, got ${v}`); return v; })();

/** Candidates written this run, for the closing report. */
let CANDIDATES_WRITTEN = 0;
/**
 * Merge candidate commits into `contracts/deployments/facet-build-candidates.json`
 * — the census's request to the era tool: "build these, I saw facets cut at
 * these moments that no catalogued build explains". Deterministic content
 * (sorted, no timestamp), written only when it changes, so a re-run does not
 * churn the file. The era tool reads it; `--check` fails until every entry
 * is catalogued.
 */
function recordBuildCandidates(candidates) {
  if (!candidates.length) return 0;
  let current = { candidates: [] };
  let currentText = null;
  try { currentText = readFileSync(CANDIDATES_FILE, 'utf8'); current = JSON.parse(currentText); } catch { current = { candidates: [] }; currentText = null; }
  const canon = (r) => String(r).replace(/'s cut of 0x[0-9a-fA-F]{40} at block/, "'s cut at block");
  const byCommit = new Map((current.candidates ?? []).map((c) => [c.commit, new Set((c.reasons ?? []).map(canon))]));
  let added = 0;
  for (const c of candidates) {
    if (!byCommit.has(c.commit)) { byCommit.set(c.commit, new Set()); added += 1; }
    for (const r of c.reasons) byCommit.get(c.commit).add(canon(r));
  }
  const next = {
    purpose: 'Commits the custody census asks the era tool to build (#1566 §7a, #2095 r9): a facet on chain carried code no catalogued build produced, and these are the commits around the moment it was cut or deployed. Regenerate the era table (storage-layout-eras.mjs) to catalogue them, then re-run the census. Written by census-grandfathered-custody.mjs; never hand-edit.',
    candidates: [...byCommit.entries()].map(([commit, reasons]) => ({ commit, reasons: [...reasons].sort() })).sort((x, y) => x.commit.localeCompare(y.commit)),
  };
  const text = JSON.stringify(next, null, 2) + '\n';
  if (currentText !== text) writeFileSync(CANDIDATES_FILE, text);
  CANDIDATES_WRITTEN += added;
  return added;
}

/**
 * #2095 r9 P1 — attribute every facet that may have written to this Diamond
 * to the layout era it was compiled against, and refuse every proof when one
 * cannot be. A routed getter and the era-complete read together cover every
 * COMMITTED layout; a facet built from a tree whose dirt reached the storage
 * library, or from an unmerged branch, carries a layout the walk never saw —
 * and its code hash is in no era's catalogue. The facet set is the union of
 * the loupe's current facets, every local record naming this Diamond, and
 * the cut history (refutation-only). Empty code never wrote (EIP-6780).
 */
async function applyLayoutProvenance(result, { client, censusBlock, atBlock, diamond, slug, label, deployBlock, readFacets, who, manifestEntry = null }) {
  result.scanned.sourceRecord = sourceRecordFor(slug, label);
  result.proofStandard = PROOF_STANDARD;
  if (result.scanned.notADiamond) {
    result.scanned.layoutProvenance = { verdict: 'not-a-diamond', reason: 'the record names no Vaipakam Diamond; there are no facets of this protocol to attribute' };
    return result;
  }
  if (!STORAGE_READ.ok) {
    result.scanned.layoutProvenance = { verdict: 'not-checked', reason: STORAGE_READ.reason };
    return result;
  }
  const recorded = recordedFacetAddresses(slug, diamond, manifestEntry);
  let loupe = null;
  let cutFacetHost = null;
  if (result.scanned.loupeRouted && readFacets) {
    try {
      const list = await readFacets();
      loupe = list.map((f) => `${f.facetAddress ?? f[0]}`.toLowerCase());
      // the facet hosting diamondCut was installed by the constructor's storage write, never by a cut
      cutFacetHost = list.find((f) => (f.functionSelectors ?? f[1] ?? []).some((x) => String(x).toLowerCase() === DIAMOND_CUT_SELECTOR))?.facetAddress?.toLowerCase() ?? null;
    } catch (err) {
      loupe = null;
      result.scanned.layoutProvenanceLoupeError = String(err?.shortMessage ?? err?.message ?? err).slice(0, 200);
    }
  }
  const cut = await facetsFromCutHistory(client, diamond, deployBlock, atBlock);
  const all = new Map();
  const add = (a, src) => { const k = a.toLowerCase(); if (!all.has(k)) all.set(k, new Set()); all.get(k).add(src); };
  for (const f of recorded.facets) for (const src of f.sources) add(f.address, src);
  for (const a of loupe ?? []) add(a, 'loupe');
  for (const a of cut.addresses) add(a, cut.initializers.includes(a) ? 'cut-history:initializer' : 'cut-history');
  const facets = [];
  for (const [address, sources] of all) {
    const codeHash = await withReplicaRetry(atBlock, () => codeHashAtHash(client, censusBlock, address), { client });
    facets.push({ address, sources: [...sources], codeHash });
  }
  const attribution = attributeFacetCode({ facets, eras: STORAGE_READ.eras });
  // an initializer whose code is gone (or was never there) CANNOT be
  // attributed: unlike a facet that never had code, it was delegatecalled,
  // so "no code now" is not "never wrote" — it is unreadable, and refuses
  for (const n of [...attribution.noCode]) {
    if (n.sources.includes('cut-history:initializer')) {
      attribution.noCode = attribution.noCode.filter((x) => x !== n);
      attribution.unattributed.push({ address: n.address, codeHash: null, sources: n.sources, note: 'initializer delegatecalled by a cut, its code unreadable at the census block' });
    }
  }
  if (attribution.unattributed.length) attribution.verdict = 'unattributed';
  const population = cutHistoryCompleteness({ verdict: cut.verdict.split(' ')[0], cuts: cut.cuts, constructorCutSeen: cut.constructorCutSeen, addresses: cut.addresses, loupe, cutFacetHost });
  // For every unattributed facet: the commits around the moments it was cut
  // (block timestamps, hash-pinned by number under the census block) and
  // around the deployedAt of every record that names it — the era tool builds
  // them, and the next run attributes against them.
  // A cut block below the endpoint's pruning floor has no readable header:
  // that moment yields no candidate (recorded), the record's deployedAt
  // still does, and the verdict is unaffected — an unattributed facet
  // already refuses every proof. A candidate is help for the next run, never
  // a reason to fail this one.
  const blockIso = new Map();
  const unreadableBlocks = [];
  // anchors for an ESTIMATE when a header is unreadable: the census block's own
  // timestamp and the record's deployedAt at its deployBlock (when both exist)
  let censusIso = null;
  const censusTimestamp = async () => {
    if (censusIso === null) {
      try { const b = await withReplicaRetry(atBlock, () => client.getBlock({ blockHash: censusBlock.hash }), { client }); censusIso = new Date(Number(b.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch { censusIso = false; }
    }
    return censusIso || null;
  };
  const anchor0 = recorded.deployedAt.length && deployBlock > 0n ? { b0: deployBlock, t0: recorded.deployedAt[0].iso } : null;
  const isoOfBlock = async (n) => {
    if (!blockIso.has(n)) {
      try {
        const b = await withReplicaRetry(atBlock, () => client.getBlock({ blockNumber: n }), { client });
        blockIso.set(n, { iso: new Date(Number(b.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), estimated: false });
      } catch (err) {
        const t1 = anchor0 ? await censusTimestamp() : null;
        const est = anchor0 && t1 ? interpolateTimestamp({ block: n, b0: anchor0.b0, t0: anchor0.t0, b1: atBlock, t1 }) : null;
        blockIso.set(n, est ? { iso: est, estimated: true } : null);
        unreadableBlocks.push({ block: String(n), reason: String(err?.shortMessage ?? err?.message ?? err).split('\n')[0].slice(0, 160), estimatedTimestamp: est ?? undefined });
      }
    }
    return blockIso.get(n);
  };
  const candidates = new Map();
  const propose = (c, reason) => { if (!candidates.has(c.commit)) candidates.set(c.commit, new Set()); candidates.get(c.commit).add(reason); };
  for (const u of attribution.unattributed) {
    u.cutBlocks = [...(cut.blocksOf.get(u.address) ?? [])].map(String);
    u.candidates = [];
    for (const n of cut.blocksOf.get(u.address) ?? []) {
      const t = await isoOfBlock(n);
      if (!t) continue;
      // an estimate may be hours off: widen to the commits around ±6 h as well
      const moments = t.estimated ? [t.iso, new Date(Date.parse(t.iso) - 6 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'), new Date(Date.parse(t.iso) + 6 * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z')] : [t.iso];
      for (const iso of moments) for (const c of commitsAround(iso)) { propose(c, `${c.relation} ${who}'s cut at block ${n} (${t.estimated ? 'estimated ' : ''}${iso})`); u.candidates.push(c.commit.slice(0, 9)); }
    }
    for (const rec of recorded.deployedAt) if (u.sources.includes(rec.record)) for (const c of commitsAround(rec.iso)) { propose(c, `${c.relation} ${who}'s ${rec.record} deployedAt ${rec.iso}`); u.candidates.push(c.commit.slice(0, 9)); }
    u.candidates = [...new Set(u.candidates)];
  }
  const candidateList = [...candidates.entries()].map(([commit, reasons]) => ({ commit, reasons: [...reasons] }));
  const newCandidates = recordBuildCandidates(candidateList);
  result.scanned.layoutProvenance = {
    verdict: facets.length ? attribution.verdict : 'no-facet-known',
    standard: PROOF_STANDARD,
    populationComplete: population.complete,
    populationIncompleteBecause: population.complete ? undefined : population.reasons,
    facetsChecked: facets.length,
    attributed: attribution.attributed.map((a) => ({ address: a.address, name: a.name, eras: a.eras.map((e) => e.date), sources: a.sources })),
    unattributed: attribution.unattributed,
    noCode: attribution.noCode,
    sources: { records: recorded.records, loupe: loupe ? loupe.length : 'unrouted', cutHistory: cut.verdict, cuts: cut.cuts, initializers: cut.initializers.length, cutHistoryError: cut.reason },
    buildCandidates: candidateList.length ? { proposed: candidateList.length, newInFile: newCandidates, file: 'contracts/deployments/facet-build-candidates.json' } : undefined,
    cutBlocksUnreadable: unreadableBlocks.length ? unreadableBlocks : undefined,
    residual: 'a facet cut in and replaced with no local record and no readable cut history is not seen here; the cut history can only refute',
  };
  process.stderr.write(`census: ${who} — layout provenance: ${facets.length} facet address(es) (${recorded.records.length} record(s), loupe ${loupe ? loupe.length : 'unrouted'}, cut history ${cut.verdict.split(' ')[0]}): ${attribution.attributed.length} attributed, ${attribution.unattributed.length} unattributed, ${attribution.noCode.length} without code${candidateList.length ? `; ${candidateList.length} build candidate(s) proposed (${newCandidates} new in the candidates file)` : ''}\n`);
  const refusals = [];
  if (attribution.unattributed.length) refusals.push(`${attribution.unattributed.length} facet(s) of this Diamond carry code no layout era's build produced (${attribution.unattributed.slice(0, 4).map((u) => `${u.address} via ${u.sources.join('+')}`).join('; ')}${attribution.unattributed.length > 4 ? '; …' : ''}) — compiled from sources the walk never saw (a dirty tree, an unmerged branch), so the era-complete read cannot claim to cover their layout`);
  if (!population.complete) refusals.push(`the facet population is not exhaustive — ${population.reasons.join('; ')} — so a writer cut in and out between the records could be missing from the set`);
  result.scanned.layoutProvenance.unattributedSeenOnlyInRecords = attribution.unattributed.filter((u) => u.sources.every((x) => /^(record|manifest):/.test(x))).length;
  if (refusals.length) {
    // What the classes say under the ROUTED standard is kept beside the
    // provenance verdict either way, so the owner can see exactly what the
    // rule withdraws (or would withdraw) and decide on it (#1566).
    result.scanned.layoutProvenance.withoutProvenanceRule = Object.fromEntries(Object.entries(result.classes).map(([k, v]) => [k, v.status]));
    const why = `${refusals.join('; and ')}; refusing to certify under the provenance standard`;
    result.scanned.layoutProvenance.provenanceRefusal = why;
    if (PROOF_STANDARD === 'provenance') {
      result.provenBy = undefined;
      result.classes = downgradeProvenClasses(result.classes, why);
      result.scanned.layoutProvenanceContradiction = why;
    } else {
      // the routed exception covers a routed-getter proof only (#2095 r13 P1):
      // a class proven by the storage read alone still needs every writer's
      // layout in the era table, which is what the refusal denies
      result.scanned.layoutProvenance.wouldRefuseUnderProvenanceStandard = true;
      result.classes = downgradeStorageOnlyProofs(result.classes, `${why} — a storage-only proof keeps no exception under the routed standard`);
      if (STORAGE_ONLY_PROOFS.has(result.provenBy)) result.provenBy = undefined;
    }
  }
  return result;
}
/**
 * r28 P1 — the hash the census pins must be what EVERY replica serves at that
 * height: the sampler refused conflicting hashes only among samples that
 * shared a height, so with A at 100/A100 and B at 101/B101 it chose A100
 * without asking what B holds at 100. Pure, so the rule is pinned by test;
 * `sampleHashesAt` feeds it fresh-connection reads.
 */
export function assertSampledHashesAgree(hashes, expected, number, who) {
  const distinct = [...new Set(hashes.map((h) => String(h).toLowerCase()))];
  const exp = String(expected).toLowerCase();
  if (distinct.length === 1 && distinct[0] === exp) return hashes.length;
  throw new Error(
    `${who}: replicas disagree on the block HASH at height ${number} — pinned ${exp}, sampled ${distinct.join(' vs ')} — ` +
      `the endpoint serves conflicting forks, or the chain reorganized under the census; refusing to certify a mixed snapshot`,
  );
}
async function sampleHashesAt(client, number, who) {
  const hashes = [];
  for (let i = 0; i < FINALITY_SAMPLES; i++) {
    try {
      const b = await client.getBlock({ blockNumber: number });
      if (b?.hash) hashes.push(b.hash);
    } catch {
      // a replica that lacks the block contributes no sample
    }
    if (i < FINALITY_SAMPLES - 1) rotateConnections(`sampling the hash at ${number} ${i + 2}/${FINALITY_SAMPLES}`, true);
  }
  if (!hashes.length) throw new Error(`${who}: no sampled replica served block ${number}`);
  return hashes;
}
/**
 * Re-read the census block and confirm it still carries the hash pinned when
 * the chain's identity was resolved (Codex #2070 P1; applied before EVERY
 * return that can emit a proven verdict per r13 P2 — the early returns for
 * a bounded deployment used to skip it, so a no-code read served by a replica
 * at a different block could have been certified under the recorded hash).
 * On a finalized block this can only fail catastrophically, which is exactly
 * why it is worth asserting. r28: SAMPLED over fresh connections, so one
 * replica that happens to agree cannot vouch for the set — and with every
 * state read now hash-pinned, this is the cross-replica guard, not the proof.
 */
async function assertBlockIdentity(client, censusBlock, who) {
  assertSampledHashesAgree(await sampleHashesAt(client, censusBlock.number, who), censusBlock.hash, censusBlock.number, who);
}

/**
 * A public RPC is often a load balancer over replicas that are not equally
 * synced. Arbitrum Sepolia's official endpoint answers `metadata is not found,
 * <N>` where N is the REPLICA'S OWN HEAD — and when N is BELOW the block we
 * asked for, the replica is simply behind: the state exists, this replica has
 * not reached it yet, and the next request may land on one that has. That is
 * a transient, not pruning, and reading it as pruning (as an earlier revision
 * did) certified nothing while failing deployments a live sibling had just
 * read at the very same height.
 *
 * A reported height AT OR ABOVE the requested block is the opposite case —
 * genuinely pruned old state — and is not retried. Persistence past the retry
 * budget is surfaced as the pruned error it then is.
 */
// Eight attempts ≈ 100 s of backoff. Five (≈12 s) was not enough: on one run a
// 37-loan archive hit lagging replicas for longer than that while a sibling
// read at the same height had just succeeded — the lag is real but bounded.
const LAGGING_REPLICA_RETRIES = 8;
function laggingReplicaHeight(err) {
  if (typeof err?.laggingHead === 'bigint') return err.laggingHead; // learned by withReplicaRetry from a hash-pinned read (r28)
  const m = /metadata is not found,\s*(\d+)/i.exec(`${err?.details ?? ''} ${err?.message ?? ''}`);
  return m ? BigInt(m[1]) : null;
}
/** A hash-pinned read on a replica that does not hold that block (r28). */
function replicaLacksBlock(err) {
  return /block not found|header not found|unknown block|hash not found|could not find block|not found: hash|not currently canonical|not canonical/i.test(`${err?.details ?? ''} ${err?.shortMessage ?? ''} ${err?.message ?? ''}`);
}
async function withReplicaRetry(requestedBlock, fn, { client } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      let h = laggingReplicaHeight(err);
      const lacks = h === null && replicaLacksBlock(err);
      // r28 — a hash-pinned read carries no height in its error, so ask the
      // same connection pool (hence, very likely, the same replica) for its
      // head: below the requested block it is the lagging head the cap needs;
      // at or above it the replica holds the height on a COMPETING FORK, which
      // is rotated away but never capped at.
      if (lacks && client) {
        try {
          const head = await client.getBlockNumber();
          if (requestedBlock !== undefined && head < requestedBlock) {
            h = head;
            err.laggingHead = head;
          } else {
            err.forkedReplicaHead = head;
          }
        } catch {
          // its head is simply unknown; still rotate
        }
      }
      const lagging = (h !== null && requestedBlock !== undefined && h < requestedBlock) || lacks;
      if (!lagging || i >= LAGGING_REPLICA_RETRIES) throw err;
      // A retry on the SAME keep-alive connection lands on the SAME lagging
      // replica (runs 18 and 21 lost arb-sepolia this way while fresh
      // connections read fine); rotate the connection pool so the retry is
      // balanced anew.
      rotateConnections(`${h !== null ? `lagging replica at ${h} < ${requestedBlock}` : `replica lacks the pinned block ${requestedBlock}${err.forkedReplicaHead !== undefined ? ` (its head ${err.forkedReplicaHead} is not below it — a competing fork)` : ''}`}, attempt ${i + 1}/${LAGGING_REPLICA_RETRIES}`);
      await sleep(400 * 2 ** i); // 0.4s, 0.8s, 1.6s, 3.2s, 6.4s — a different replica usually answers within this
    }
  }
}

/**
 * The RPC transport's fetch, built on Node's own http(s) agents so the
 * connection POOL can be rotated (Codex #2070 / runs 18 & 21). Node's global
 * fetch keeps connections alive indefinitely under continuous load, and a
 * load-balanced public endpoint then keeps routing this process to whichever
 * replica it first landed on — including one hours behind head — while every
 * retry reuses that same connection. `undici`'s dispatcher is not resolvable
 * from this package, so the adapter uses `node:https` directly and returns a
 * real `Response`, which is all viem's RPC layer reads (`ok`, `status`,
 * `statusText`, `headers.get`, `json()`, `text()`).
 */
let connectionAgents = { https: new HttpsAgent({ keepAlive: true, maxSockets: 8 }), http: new HttpAgent({ keepAlive: true, maxSockets: 8 }) };
let connectionRotations = 0;
function rotateConnections(reason, quiet = false) {
  connectionAgents.https.destroy();
  connectionAgents.http.destroy();
  connectionAgents = { https: new HttpsAgent({ keepAlive: true, maxSockets: 8 }), http: new HttpAgent({ keepAlive: true, maxSockets: 8 }) };
  connectionRotations += 1;
  if (!quiet) process.stderr.write(`census: rotating RPC connections (${reason}) — rotation ${connectionRotations}\n`);
}
function fetchViaNodeAgents(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(String(url));
    const isHttps = u.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;
    const req = doRequest(
      u,
      // A User-Agent is sent on purpose: Cloudflare-fronted public endpoints
      // reject the empty/default signature with a 403 "error code: 1010".
      { method: init.method ?? 'POST', headers: { 'user-agent': 'vaipakam-census/1', ...(init.headers ?? {}) }, agent: isHttps ? connectionAgents.https : connectionAgents.http, signal: init.signal },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const headers = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
          const status = res.statusCode ?? 0;
          const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers }));
        });
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/**
 * True only for the `IntentNoCommit` revert — the facet's own signal that no
 * commit is live for that loan. Every other revert propagates: a census must
 * never read an unexpected failure as an absent row.
 */
function isNoCommitRevert(err) {
  const named = err?.cause?.data?.errorName ?? err?.data?.errorName;
  if (named) return named === 'IntentNoCommit';
  return /IntentNoCommit/.test(`${err?.metaMessages?.join(' ') ?? ''} ${err?.shortMessage ?? ''} ${err?.message ?? ''}`);
}
const WANT_CORROBORATION = process.argv.includes('--corroborate');

function loadAbi(name) {
  const raw = JSON.parse(readFileSync(join(ABIS, `${name}.json`), 'utf8'));
  return Array.isArray(raw) ? raw : raw.abi;
}

function pick(abi, names) {
  const want = new Set(names);
  const got = abi.filter((e) => want.has(e.name));
  const missing = names.filter((n) => !got.some((e) => e.name === n));
  if (missing.length) {
    throw new Error(
      `ABI is missing ${missing.join(', ')} — the exported artifact and this census have drifted; ` +
        `re-run contracts/script/exportFrontendAbis.sh`,
    );
  }
  return got;
}

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** The endpoint HOST that served a result — provenance for a reader comparing runs (never the full URL: it may carry a key). */
function rpcHostOf(rpc) {
  try {
    return new URL(rpc).host;
  } catch {
    return 'unknown';
  }
}

function rpcFor(slug) {
  const fromFlag = arg('--rpc');
  if (fromFlag) return fromFlag;
  const env = `CENSUS_RPC_${slug.toUpperCase().replace(/-/g, '_')}`;
  return process.env[env] || process.env.CENSUS_RPC_URL || PUBLIC_RPC[slug] || null;
}

function deployedChains() {
  return readdirSync(DEPLOYMENTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NOT_A_DEPLOYMENT.has(d.name))
    .map((d) => d.name)
    .filter((slug) => existsSync(join(DEPLOYMENTS, slug, 'addresses.json')))
    .sort();
}

/**
 * Every retained Diamond on a chain — the LIVE one plus each one archived by a
 * `--fresh` redeploy under `.archive/<timestamp>/`.
 *
 * Codex #2070 r5 P1 — a `--fresh` archives OFF-chain artifacts; it cannot wipe
 * ON-chain storage. The redeploy guard permits orphaning prior state on
 * purpose (ReleaseNotes-2026-05-11 §"pre-archive orphan-state guard"), so an
 * archived Diamond can still hold a rebate row, a fallback snapshot, or a live
 * intent. A census that reads one address per chain certifies those away
 * without ever looking at them. The unit of this census is therefore a
 * DEPLOYMENT, not a chain.
 */
/**
 * Codex #2070 r6 P1 — `.gitignore` excludes `contracts/deployments/*\/.archive/`,
 * so in a clean checkout the local archive directories DO NOT EXIST. A census
 * that enumerated them would silently see only the live artifacts, compare its
 * coverage against that same reduced set, and overwrite the 19-deployment
 * artifact with a "complete" 5-deployment one. The inventory therefore lives in
 * a COMMITTED manifest; the local `.archive` tree is used only to detect that
 * the manifest is stale, never as the source of truth.
 */
const ARCHIVE_MANIFEST = join(DEPLOYMENTS, 'archive-manifest.json');

/** Every chain directory that has a local `.archive/`, live artifact or not. */
/** `addresses.prior-rehearsal.<unix-ts>.json` — the quick-loop deploy's (deploy-chain.sh --fresh) retired artifact; gitignored like .archive/. */
const SIDECAR_RE = /^addresses\.prior-rehearsal\.(\d+)\.json$/;
function sidecarsOf(slug) {
  const dir = join(DEPLOYMENTS, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => SIDECAR_RE.test(f)).sort();
}
function chainsWithLocalArchives() {
  return readdirSync(DEPLOYMENTS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NOT_A_DEPLOYMENT.has(d.name))
    .map((d) => d.name)
    .filter((slug) => existsSync(join(DEPLOYMENTS, slug, '.archive')) || sidecarsOf(slug).length > 0)
    .sort();
}

function localArchivedDiamonds() {
  const out = [];
  // Codex #2070 r9 P1 — NOT `deployedChains()`: a chain whose `--fresh` aborted
  // after archiving (no new top-level artifact yet), or one retired on purpose,
  // has no live artifact — and its local archives must still be reconciled
  // against the manifest, or the staleness check is blind exactly where the
  // inventory is most likely to be short.
  const push = (slug, stamp, a) => {
    if (!a.diamond) return; // an archive entry without a Diamond has nothing on-chain to census
    // the facet set and deploy time travel with the entry (#2095 r10 P1): a clean checkout has no .archive/ to read them from
    const facets = [...new Set(Object.values(a.facets ?? {}).filter((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)).map((v) => v.toLowerCase()))].sort();
    out.push({ slug, stamp, chainId: a.chainId ?? null, diamond: a.diamond, deployBlock: a.deployBlock ?? null, vpfiToken: a.vpfiToken ?? a.vpfiMirror ?? null, deployedAt: a.deployedAt ?? null, facets });
  };
  for (const slug of chainsWithLocalArchives()) {
    const archiveDir = join(DEPLOYMENTS, slug, '.archive');
    if (existsSync(archiveDir)) {
      for (const stamp of readdirSync(archiveDir).sort()) {
        const f = join(archiveDir, stamp, 'addresses.json');
        if (existsSync(f)) push(slug, stamp, JSON.parse(readFileSync(f, 'utf8')));
      }
    }
    // Codex #2070 r25 P1 — the quick-loop deploy (deploy-chain.sh --fresh)
    // retires the prior artifact to a gitignored SIDECAR rather than .archive/,
    // and never recorded it; the retired Diamond vanished from the census
    // population. Sidecars are archived deployments and are collected under
    // the stamp `prior-rehearsal-<ts>` — the same stamp deploy-chain.sh now
    // appends before it moves the file.
    for (const f of sidecarsOf(slug)) {
      const ts = SIDECAR_RE.exec(f)[1];
      push(slug, `prior-rehearsal-${ts}`, JSON.parse(readFileSync(join(DEPLOYMENTS, slug, f), 'utf8')));
    }
  }
  return out;
}

function readArchiveManifest() {
  return readManifest(ARCHIVE_MANIFEST);
}

function writeArchiveManifest() {
  // Codex #2070 r7 P1 (never silently DROP a committed entry — from a clean
  // checkout `.archive/` is absent and an unguarded rewrite would have emptied
  // the fourteen-entry inventory) and r13 P1 (collect INSIDE the lock — a
  // list gathered before the lock overwrote an append that won it in
  // between) both live in archive-manifest.mjs now, so every regeneration path
  // has both. This function only states the policy: dropping and writing an
  // empty inventory need the explicit override, and the dropped entries are
  // named either way.
  // Codex #2070 r18 P2 — a displacement (an archived label now naming a
  // different Diamond, the scheduled correction of the non-Diamond archive
  // being exactly this) is acknowledged BY KEY, never by the blanket force:
  //   --write-archive-manifest --acknowledge-manifest-displacement <slug|stamp>[,...]
  const force = process.argv.includes('--force-archive-manifest-rewrite');
  const displaceKeys = (arg('--acknowledge-manifest-displacement', '') || '').split(',').map((k) => k.trim()).filter(Boolean);
  return regenerateEntries(ARCHIVE_MANIFEST, () => localArchivedDiamonds(), { allowDrop: force, allowEmpty: force, allowDisplace: displaceKeys }).manifest;
}

function deployedDiamonds() {
  // Codex #2070 r14 P1 — the inventory is ONE snapshot taken under the
  // manifest lock, not three reads with windows between them. A `--fresh`
  // running concurrently appends its retiring Diamond to the manifest (under
  // this same lock) and only THEN moves the live artifact; so with the manifest
  // read first, inside the lock, and the live artifacts read before the lock
  // is released, a retiring Diamond is on at least one side of the snapshot:
  // append not yet done ⇒ the artifact is still live; append done ⇒ it is in
  // the manifest we read. An unlocked sequence could miss it on both sides and
  // the coverage check — computed from the same reduced list — would agree.
  return withManifestLock(ARCHIVE_MANIFEST, deployedDiamondsUnderLock);
}

/** The manifest's live-artifact generation as read under the lock by the most recent `deployedDiamondsUnderLock()`. */
let LIVE_GENERATION_SEEN = null;
function deployedDiamondsUnderLock() {
  const out = [];
  const manifest = readArchiveManifest();
  LIVE_GENERATION_SEEN = manifest ? Number(manifest.liveGeneration) || 0 : 0;
  // Codex #2070 r24 P1 — a deploy marks its live publication BEFORE it
  // broadcasts and clears it AFTER the artifact lands; while the marker is
  // set the live artifact may be rewritten at any moment outside this lock,
  // so no inventory taken now can be trusted. Refuse, at start and at
  // publication alike (both call this under the lock).
  const publishing = livePublicationsInProgress(manifest);
  if (publishing.length) {
    throw new Error(
      `a deployment is publishing a live artifact right now (${publishing.map((x) => `${x.slug} since ${x.startedAt}, pid ${x.pid}`).join('; ')}); ` +
        `the inventory cannot be trusted until it ends — re-run after it completes (a crashed deploy is cleared with archive-manifest.mjs live-end <manifest> <slug>)`,
    );
  }
  if (!manifest) {
    throw new Error(
      `${ARCHIVE_MANIFEST} is missing. The archived-deployment inventory must be committed, because .archive/ is gitignored ` +
        `and a clean checkout would otherwise census only the live artifacts. Run with --write-archive-manifest on a checkout ` +
        `that has the .archive/ directories, review the diff, and commit it.`,
    );
  }
  // Staleness, on CONTENT and not only on keys (Codex #2070 r10 P2): a local
  // archived artifact corrected in place — the scheduled correction of the
  // archive that names a non-Diamond is exactly this — keeps its directory
  // stamp, so a `slug|stamp` comparison would pass while the manifest still
  // carried the stale address, and the census would scan the stale record
  // instead of the corrected one. Every field the census reads from an entry
  // is compared; any difference is a refusal.
  const byKey = new Map(manifest.entries.map((e) => [`${e.slug}|${e.stamp}`, e]));
  const norm = (v) => (v === null || v === undefined ? null : `${v}`.toLowerCase());
  const local = localArchivedDiamonds();
  const missing = local.filter((e) => !byKey.has(`${e.slug}|${e.stamp}`));
  const changed = local.filter((e) => {
    const m = byKey.get(`${e.slug}|${e.stamp}`);
    return m && !sameEntry(m, e);
  });
  if (missing.length || changed.length) {
    throw new Error(
      `archive manifest is STALE — ` +
        (missing.length ? `local .archive entries not in it: ${missing.map((e) => `${e.slug}/${e.stamp}`).join(', ')}. ` : '') +
        (changed.length ? `entries whose local artifact DIFFERS from the manifest record: ${changed.map((e) => `${e.slug}/${e.stamp}`).join(', ')}. ` : '') +
        `Regenerate with --write-archive-manifest and commit.`,
    );
  }
  // The inventory is the UNION of chains with a live artifact and chains the
  // manifest knows (Codex #2070 r9 P1). A manifest-only chain — its `--fresh`
  // aborted between archiving and writing the new artifact, or it was retired
  // — contributes its archived Diamonds with no live entry; their custody is
  // as real as anyone's. Making archived coverage conditional on a live
  // artifact let the coverage check agree with an incomplete population.
  const liveSlugs = deployedChains();
  const manifestSlugs = [...new Set(manifest.entries.map((e) => e.slug))];
  const allSlugs = [...new Set([...liveSlugs, ...manifestSlugs])].sort();
  for (const slug of allSlugs) {
    if (liveSlugs.includes(slug)) {
      const live = JSON.parse(readFileSync(join(DEPLOYMENTS, slug, 'addresses.json'), 'utf8'));
      out.push({ slug, label: 'live', addresses: live });
    }
    for (const e of manifest.entries.filter((x) => x.slug === slug)) {
      out.push({
        slug,
        label: `archived ${e.stamp}`,
        addresses: { chainId: e.chainId, diamond: e.diamond, deployBlock: e.deployBlock, vpfiToken: e.vpfiToken },
        manifestEntry: { stamp: e.stamp, facets: e.facets ?? [], deployedAt: e.deployedAt ?? null },
      });
    }
  }
  return out;
}

/**
 * Fetch logs in bounded spans, halving on provider range/size errors.
 * Public RPCs cap `eth_getLogs` ranges, and a silently truncated scan would
 * under-count live commits — i.e. produce a false "empty".
 */
async function fetchRange(client, address, events, fromBlock, toBlock) {
  let span = toBlock - fromBlock + 1n;
  const out = [];
  let cursor = fromBlock;
  let rateRetries = 0;
  while (cursor <= toBlock) {
    const end = cursor + span - 1n > toBlock ? toBlock : cursor + span - 1n;
    try {
      out.push(...(await client.getLogs({ address, events, fromBlock: cursor, toBlock: end })));
      cursor = end + 1n;
      rateRetries = 0;
    } catch (err) {
      const kind = classifyRpcError(err);
      if (kind === 'pruned') throw err; // unanswerable by this endpoint — surface it
      if (kind === 'rate') {
        if (rateRetries >= RATE_LIMIT_RETRIES) throw err;
        await sleep(500 * 2 ** rateRetries++); // 0.5s, 1s, 2s … 16s
        continue;
      }
      if (span === 1n) throw err; // a single block the provider still refuses is a real failure
      span = span / 2n > 0n ? span / 2n : 1n;
    }
  }
  return out;
}

/**
 * Fetch logs over a wide range with bounded concurrency, halving any span the
 * provider refuses. Two correctness notes:
 *
 *  - Public RPCs cap `eth_getLogs`, and a silently truncated scan would
 *    under-count live commits — i.e. produce a false "empty". Every refusal
 *    therefore narrows and retries rather than being swallowed.
 *  - Results are re-sorted by `(blockNumber, logIndex)` before the caller
 *    folds them. The commit → teardown fold is ORDER-DEPENDENT, and neither
 *    concurrent completion nor per-chunk provider ordering can be assumed to
 *    deliver chain order.
 */
async function getLogsChunked(client, { address, events, fromBlock, toBlock }) {
  const windows = [];
  for (let c = fromBlock; c <= toBlock; c += DEFAULT_LOG_SPAN) {
    const end = c + DEFAULT_LOG_SPAN - 1n > toBlock ? toBlock : c + DEFAULT_LOG_SPAN - 1n;
    windows.push([c, end]);
  }

  const out = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(LOG_CONCURRENCY, windows.length || 1) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= windows.length) return;
      const [from, to] = windows[i];
      out.push(...(await fetchRange(client, address, events, from, to)));
    }
  });
  await Promise.all(workers);

  out.sort((x, y) =>
    x.blockNumber === y.blockNumber
      ? Number(x.logIndex) - Number(y.logIndex)
      : x.blockNumber < y.blockNumber
        ? -1
        : 1,
  );
  return out;
}

/**
 * Resolve the block this census reads at, as a (number, hash) IDENTITY.
 *
 * Prefers `finalized`, then `safe`. Both are reorg-proof by construction, which
 * is the property a certification artifact needs — a `latest` head can be
 * replaced after the run, leaving an artifact that names a height nobody can
 * reproduce. If the endpoint offers neither tag we REFUSE rather than fall back
 * to the head: silently certifying against a reorg-able block is precisely the
 * comfortable answer this census must not give.
 */
const CENSUS_BLOCK_BY_CHAIN = new Map();
/** Chains whose `finalized` state the endpoint could not serve; they read at `safe`. */
const CHAIN_DOWNGRADED_TO_SAFE = new Set();
/** One block identity per CHAIN: every deployment on it reads the same state. */
async function censusBlockFor(client, slug, who) {
  if (!CENSUS_BLOCK_BY_CHAIN.has(slug)) {
    const tags = CHAIN_DOWNGRADED_TO_SAFE.has(slug) ? ['safe'] : ['finalized', 'safe'];
    CENSUS_BLOCK_BY_CHAIN.set(slug, await resolveCensusBlock(client, who, tags, slug));
  }
  return CENSUS_BLOCK_BY_CHAIN.get(slug);
}
/**
 * The height each chain was censused at in the COMMITTED canonical artifact.
 * A certification must never move BACKWARDS across committed runs: a later run
 * reading an older height would "un-see" state the earlier run already saw,
 * and a row created between the two heights would be absent from the newer
 * artifact while present at the older one's state. Loaded once, in main().
 */
const PRIOR_COMMITTED_HEIGHT = new Map();
/** The committed artifact's block HASH at that height, per chain (for ancestry). */
const PRIOR_COMMITTED_HASH = new Map();
/**
 * Ancestry evidence gathered when a chain's census block is resolved (Codex
 * #2070 r23 P1): the hash THIS run's endpoint reports at the committed
 * height. A higher height is progress only if the committed block is an
 * ancestor of it; a block 101 whose ancestor at 100 differs from the committed
 * block 100 is a fork (or an inconsistent endpoint) and must not replace it.
 * Fetched here because the replacement guard runs synchronously under a lock.
 */
const ANCESTRY_SEEN = new Map();
/**
 * The snapshot this run will REPLACE — the canonical artifact for a full run,
 * the chain's partial file for a `--chain` run (Codex #2070 r24 P2: the
 * guard compares against that file, so ancestry must be proven against ITS
 * block, while the canonical artifact's heights remain the monotonic floor).
 */
const TARGET_HEIGHT = new Map();
const TARGET_HASH = new Map();
function loadTargetSnapshot(targetPath) {
  TARGET_HEIGHT.clear();
  TARGET_HASH.clear();
  if (!existsSync(targetPath)) return;
  let t;
  try {
    t = JSON.parse(readFileSync(targetPath, 'utf8'));
  } catch (err) {
    throw new Error(`${targetPath} exists but cannot be parsed (${err.message}); it is the snapshot this run would replace — restore or remove it deliberately`);
  }
  for (const r of t.results ?? []) {
    if (!r?.chainSlug || r?.atBlock == null) continue;
    const h = BigInt(r.atBlock);
    if (!TARGET_HEIGHT.has(r.chainSlug) || h > TARGET_HEIGHT.get(r.chainSlug)) {
      TARGET_HEIGHT.set(r.chainSlug, h);
      TARGET_HASH.set(r.chainSlug, r.atBlockHash ? String(r.atBlockHash).toLowerCase() : null);
    }
  }
}
/** Longest numbered range the ancestry walk will fetch; beyond it ancestry is unverifiable and a higher snapshot is refused. */
const ANCESTRY_WALK_MAX = BigInt(arg('--ancestry-walk-max', '250000'));
/**
 * Blocks per batched request in the walk — the STARTING size; the walk is
 * ADAPTIVE: every rate-limit answer halves the batch (down to single reads)
 * and doubles the pause, every clean batch keeps them. Measured 2026-09-09
 * with a user agent set: sepolia.base.org accepts 25/req, Tenderly's
 * arb-sepolia gateway 10/req (25 → 429), publicnode 100/req; single reads run
 * at ~2/s everywhere, so batching is what makes a long walk feasible.
 */
const ANCESTRY_BATCH = Number(arg('--ancestry-batch', '25'));
const ANCESTRY_BATCH_PAUSE_MS = Number(arg('--ancestry-batch-pause-ms', '100'));
const ANCESTRY_RATE_HITS_MAX = 40;
/** Batched requests in flight at once during the walk (links are checked in order afterwards); failures shrink the batch, never the concurrency. */
const ANCESTRY_CONCURRENCY = Math.max(1, Number(arg('--ancestry-concurrency', '3')));
/** After this many clean batches the pause halves back toward its base and the batch grows by one toward the last refused size. */
const ANCESTRY_GROW_AFTER = 20;
/**
 * Prove that `committed` is an ancestor of `proposed` by a PARENT-HASH LINK
 * WALK (Codex #2070 r24 P1): fetch every block in [committed.height,
 * proposed.height] by number, in batches, and require the chain of links —
 * the first block's hash is the committed hash, the last block's hash is the
 * proposed hash, and every block's `parentHash` is the previous block's hash.
 * A replica serving a different fork for any height breaks a link. An
 * independent lookup of "which hash do you serve at height N" proved nothing
 * about the relationship, which is what an earlier revision relied on.
 */
export async function verifyAncestryByWalk(rpc, committed, proposed, who) {
  if (committed.height === proposed.number) {
    return committed.hash === String(proposed.hash).toLowerCase()
      ? { verified: true, method: 'same-height', span: 1 }
      : { verified: false, reason: `same height ${committed.height} but a different hash (${committed.hash} vs ${proposed.hash})` };
  }
  if (committed.height > proposed.number) return { verified: false, reason: 'the committed block is higher than the proposed one' };
  const span = proposed.number - committed.height + 1n;
  if (span > ANCESTRY_WALK_MAX) {
    return { verified: false, reason: `the ${span}-block range from ${committed.height} to ${proposed.number} exceeds --ancestry-walk-max ${ANCESTRY_WALK_MAX}; raise it deliberately to walk it` };
  }
  let batchSize = Math.max(1, ANCESTRY_BATCH);
  let pauseMs = ANCESTRY_BATCH_PAUSE_MS;
  let rateHits = 0;
  let refusedAt = Infinity; // the smallest batch size the endpoint has refused; growth stays below it
  let cleanStreak = 0;
  const batcherFor = (n) => createPublicClient({ transport: http(rpc, { fetchFn: fetchViaNodeAgents, batch: { batchSize: n, wait: 0 } }) });
  let batcher = batcherFor(batchSize);
  let prevHash = null;
  let fetched = 0n;
  const started = Date.now();
  for (let from = committed.height; from <= proposed.number; ) {
    const size = BigInt(batchSize);
    // Up to ANCESTRY_CONCURRENCY consecutive batches in flight; the link check
    // below runs over the concatenated blocks in order, so concurrency never
    // weakens the proof — it only changes how many requests are outstanding.
    const ranges = [];
    let cursor = from;
    for (let k = 0; k < ANCESTRY_CONCURRENCY && cursor <= proposed.number; k++) {
      const end = cursor + size - 1n > proposed.number ? proposed.number : cursor + size - 1n;
      const numbers = [];
      for (let n = cursor; n <= end; n++) numbers.push(n);
      ranges.push({ numbers, end });
      cursor = end + 1n;
    }
    const to = ranges[ranges.length - 1].end;
    let blocks;
    try {
      const groups = await Promise.all(ranges.map((r) => withReplicaRetry(r.end, () => Promise.all(r.numbers.map((n) => batcher.getBlock({ blockNumber: n }))))));
      blocks = groups.flat();
    } catch (err) {
      // ANY failure of a batched request shrinks the batch (an endpoint that
      // rejects an oversized batch answers with a single error object, which
      // viem's batch decoder reports as an unknown "reading 'error'" failure
      // rather than a rate limit — Tenderly at 25/req); only a failure at
      // single reads propagates, since nothing is left to shrink.
      if (batchSize === 1 && classifyRpcError(err) !== 'rate') throw err;
      rateHits += 1;
      if (rateHits > ANCESTRY_RATE_HITS_MAX) throw err;
      refusedAt = Math.min(refusedAt, batchSize);
      cleanStreak = 0;
      batchSize = Math.max(1, Math.floor(batchSize / 2));
      pauseMs = Math.min(pauseMs * 2 || 200, 8_000);
      batcher = batcherFor(batchSize);
      process.stderr.write(`census: ${who} — batched read refused (${classifyRpcError(err)}) during the ancestry walk; batch → ${batchSize}, pause → ${pauseMs} ms (${rateHits}/${ANCESTRY_RATE_HITS_MAX})\n`);
      await sleep(pauseMs);
      continue; // retry the same range at the smaller size
    }
    from = to + 1n;
    // Grow back after a clean streak: the pause halves toward its base and the
    // batch grows by one, staying below the smallest size the endpoint refused.
    cleanStreak += 1;
    if (cleanStreak >= ANCESTRY_GROW_AFTER) {
      cleanStreak = 0;
      pauseMs = Math.max(ANCESTRY_BATCH_PAUSE_MS, Math.floor(pauseMs / 2));
      if (batchSize + 1 < refusedAt) {
        batchSize += 1;
        batcher = batcherFor(batchSize);
      }
    }
    if (pauseMs > 0 && to < proposed.number) await sleep(pauseMs);
    for (const b of blocks) {
      const h = String(b.hash).toLowerCase();
      const parent = String(b.parentHash).toLowerCase();
      if (b.number === committed.height && h !== committed.hash) {
        return { verified: false, reason: `this run's endpoint has ${h} at the committed height ${committed.height}, not the committed ${committed.hash}` };
      }
      if (prevHash !== null && parent !== prevHash) {
        return { verified: false, reason: `parent-hash link broken at ${b.number}: parentHash ${parent} ≠ previous block hash ${prevHash} — a fork or an inconsistent endpoint` };
      }
      prevHash = h;
      fetched += 1n;
    }
  }
  if (prevHash !== String(proposed.hash).toLowerCase()) {
    return { verified: false, reason: `the walk ended at ${prevHash}, not at the proposed block ${proposed.hash}` };
  }
  process.stderr.write(`census: ${who} — ancestry verified by parent-hash link walk over ${fetched} block(s) in ${Math.round((Date.now() - started) / 1000)}s\n`);
  return { verified: true, method: 'parent-hash-link-walk', span: fetched };
}
function loadPriorCommittedHeights(canonicalPath) {
  PRIOR_COMMITTED_HEIGHT.clear();
  PRIOR_COMMITTED_HASH.clear();
  if (!existsSync(canonicalPath)) return;
  let prior;
  try {
    prior = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  } catch (err) {
    // Codex #2070 r13 P2 — an unreadable prior is NOT "no prior". Treating it
    // as absent silently disabled the height floor, and the next automatic
    // run could then accept a stale finality tag below the last valid census
    // height and overwrite the evidence. Abort; the recovery is the committed
    // copy, and a truncated file here is exactly the case the atomic artifact
    // write below now prevents.
    throw new Error(
      `${canonicalPath} exists but cannot be parsed (${err.message}). The committed-height floor needs it; ` +
        `restore it from version control (git checkout -- <path>) rather than running without a floor.`,
    );
  }
  if (!Array.isArray(prior?.results)) {
    throw new Error(`${canonicalPath} parses but carries no results[] — not a census artifact; restore it from version control.`);
  }
  for (const r of prior.results ?? []) {
    if (!r?.chainSlug || r?.atBlock == null) continue;
    const h = BigInt(r.atBlock);
    const cur = PRIOR_COMMITTED_HEIGHT.get(r.chainSlug);
    if (cur === undefined || h > cur) {
      PRIOR_COMMITTED_HEIGHT.set(r.chainSlug, h);
      PRIOR_COMMITTED_HASH.set(r.chainSlug, r.atBlockHash ? String(r.atBlockHash).toLowerCase() : null);
    }
  }
}
// A finality tag can be served STALE without any error: on run 15 the official
// op-sepolia endpoint answered `finalized` with a height 1.46 MILLION blocks
// (~34 days) below the one it had served 90 minutes earlier — its `safe` tag
// sat below its own `finalized`, which the protocol forbids — and the census
// would have committed a snapshot a month older than the one it replaced,
// labelled as current finality. The finality read is one RPC, so a stale
// replica is retried; persistence past the budget is a recorded failure.
const STALE_FINALITY_RETRIES = 6;
/** Fresh-connection samples of a finality tag per resolution; the LOWEST height wins (see resolveCensusBlock). */
const FINALITY_SAMPLES = 6;
/**
 * Pick the census block from finality-tag samples: the LOWEST height, and only
 * if every sample at any one height agrees on the hash (Codex #2070 r23 P1 —
 * two replicas answering the same height with different hashes are on
 * different forks, and every later state read is pinned by NUMBER only, so a
 * read could come from the other fork while the end-of-run identity check
 * happened to land on the chosen one). Pure; exported for tests.
 */
export function pickFinalitySample(samples, who = 'finality') {
  const byHeight = new Map();
  for (const x of samples) {
    const k = x.number.toString();
    const set = byHeight.get(k) ?? new Set();
    set.add(String(x.hash).toLowerCase());
    byHeight.set(k, set);
  }
  const conflicts = [...byHeight].filter(([, hs]) => hs.size > 1);
  if (conflicts.length) {
    throw new Error(
      `${who}: replicas disagree on the block HASH at the same height (${conflicts.map(([h, hs]) => `${h}: ${[...hs].join(' vs ')}`).join('; ')}) — ` +
        `the endpoint serves conflicting forks and no state read pinned by number can be attributed to one of them; use a consistent endpoint`,
    );
  }
  const lowest = samples.reduce((a, b) => (b.number < a.number ? b : a));
  const heights = [...byHeight.keys()].sort();
  return { number: lowest.number, hash: lowest.hash, heights };
}
/**
 * Arbitrum Sepolia's public RPC keeps a MOVING state window, and its
 * `finalized` tag lags far enough behind head that the finalized block can
 * fall out of that window between two calls — one deployment reads fine and
 * the next gets `metadata is not found` at the very same height. `safe` is
 * still a finality tag (reorg-resistant by the chain's own definition), so the
 * principled degradation is to re-resolve THAT chain at `safe` and retry the
 * deployment once. Never `latest`: that is the reorg-able head this census
 * refuses to certify against.
 */
function downgradeChainToSafe(slug) {
  if (CHAIN_DOWNGRADED_TO_SAFE.has(slug)) return false; // already downgraded; do not loop
  CHAIN_DOWNGRADED_TO_SAFE.add(slug);
  CENSUS_BLOCK_BY_CHAIN.delete(slug);
  return true;
}
/**
 * Cap a chain's census height at a LAGGING REPLICA'S OWN HEAD (2026-09-09,
 * arb-sepolia). The finality tag was consistent across every sampled replica,
 * but STATE reads at that height kept landing on replicas whose own head was
 * tens of thousands of blocks lower — `metadata is not found, <head>` on all
 * eight rotated retries, three runs in a row. That head is BELOW the chain's
 * finalized block, so a block at that height is itself finalized and
 * reorg-proof; reading there is sound, and it is servable by the replicas
 * that were failing. So on a lagging failure that survived the retry budget,
 * the chain is re-resolved AT that head (hash fetched by number) — but only
 * once a parent-hash walk from the resolved block proves that head is its
 * ANCESTOR (r27: a lower height on a competing fork is not finalized) — still
 * subject to the committed-height floor, and RESTARTED — the same discard-
 * and-requeue the `safe` downgrade uses, so one block identity per chain
 * holds. Bounded to `MAX_HEAD_CAPS_PER_CHAIN` so the run cannot chase ever-
 * lower stragglers; past that it is a recorded failure.
 */
const MAX_HEAD_CAPS_PER_CHAIN = 2;
const CHAIN_HEAD_CAPS = new Map();
async function capChainAtLaggingHead(client, slug, who, head) {
  const caps = CHAIN_HEAD_CAPS.get(slug) ?? 0;
  if (caps >= MAX_HEAD_CAPS_PER_CHAIN) return null;
  const current = CENSUS_BLOCK_BY_CHAIN.get(slug);
  if (!current || head >= current.number) return null; // not actually lower than what we read at
  const floor = PRIOR_COMMITTED_HEIGHT.get(slug);
  if (floor !== undefined && head < floor) {
    process.stderr.write(`census: ${who} — lagging replica head ${head} is BELOW the committed floor ${floor}; cannot cap there\n`);
    return null;
  }
  const b = await withReplicaRetry(head, () => client.getBlock({ blockNumber: head }));
  if (!b?.hash) return null;
  // Codex #2070 r27 P1 — a lower height is finalized only when it is an
  // ANCESTOR of the finalized block this run resolved: a lagging replica can
  // sit numerically below it on a competing fork. The committed-floor walk
  // that follows proves descent from the LAST census, not membership in THIS
  // run's finalized chain, so first walk the parent hashes from the resolved
  // block down to the head just fetched; the cap stands only if the link
  // closes on that exact block.
  const capped = { height: b.number, hash: String(b.hash).toLowerCase() };
  let descent;
  try {
    descent = await verifyAncestryByWalk(rpcFor(slug), capped, { number: current.number, hash: current.hash }, `${who} (cap descent)`);
  } catch (err) {
    descent = { verified: false, reason: `the descent walk failed: ${classifyRpcError(err)} — ${err.message?.split('\n')[0]}` };
  }
  if (!descent.verified) {
    process.stderr.write(`census: ${who} — lagging replica head ${head} (${capped.hash}) is NOT a proven ancestor of the resolved block ${current.number} (${current.hash}): ${descent.reason}; cannot cap there\n`);
    return null;
  }
  CHAIN_HEAD_CAPS.set(slug, caps + 1);
  CENSUS_BLOCK_BY_CHAIN.set(slug, { number: b.number, hash: b.hash, tag: `${current.tag} → capped at lagging replica head ${head} (proven ancestor of ${current.number} by a ${descent.span}-block parent-hash walk; cap ${caps + 1}/${MAX_HEAD_CAPS_PER_CHAIN})` });
  // Codex #2070 r25 P1 — the census block moved; evidence gathered for the
  // original block proves nothing about this one. Walk to the capped block.
  await gatherAncestry(slug, who, CENSUS_BLOCK_BY_CHAIN.get(slug));
  return CENSUS_BLOCK_BY_CHAIN.get(slug);
}

async function resolveCensusBlock(client, who, tags = ['finalized', 'safe'], chainSlug = null) {
  // Resolve finality FIRST, unconditionally. Codex #2070 r4 P1 — `--block`
  // used to bypass this entirely, so an operator could pass the current head,
  // receive a globally empty verdict, and lose the named state to a reorg
  // after the end-of-run hash check had already passed. An explicit block is
  // accepted only at or below the chain's own finality mark; there is no way
  // to name a reorg-able height and still get a certification out.
  const prior = chainSlug ? PRIOR_COMMITTED_HEIGHT.get(chainSlug) : undefined;
  let finality = null;
  for (let attempt = 0; ; attempt++) {
    finality = null;
    for (const blockTag of tags) {
      // A public endpoint is a load balancer over replicas that can be
      // DISPERSED by tens of thousands of blocks (arb-sepolia, 2026-09-09:
      // at the height one replica called finalized, 12/12 fresh HTTP/1.1 and
      // 10/12 HTTP/2 reads landed on replicas that had not reached it).
      // Resolving the tag once takes whichever replica answers — often the
      // freshest — and every later read then fails on the rest. So the tag is
      // SAMPLED over several fresh connections and the LOWEST height wins: a
      // lagging replica's finalized block is still a finalized block (the tag
      // is monotonic), so the minimum is reorg-proof AND servable by every
      // replica sampled. The committed-height floor below still applies.
      const samples = [];
      for (let i = 0; i < FINALITY_SAMPLES; i++) {
        try {
          const b = await client.getBlock({ blockTag });
          if (b?.number != null && b?.hash) samples.push({ number: b.number, hash: b.hash });
        } catch {
          // Not every chain/RPC implements both tags; a sample that fails is simply absent.
        }
        if (i < FINALITY_SAMPLES - 1) rotateConnections(`sampling ${blockTag} ${i + 2}/${FINALITY_SAMPLES}`, true);
      }
      if (samples.length) {
        const picked = pickFinalitySample(samples, `${who} ${blockTag}`);
        // r28 P1 — the lowest height was chosen from replicas that may sit on
        // different forks; what they serve AT that height decides whether it
        // can be pinned at all.
        assertSampledHashesAgree(await sampleHashesAt(client, picked.number, `${who} ${blockTag}`), picked.hash, picked.number, `${who} ${blockTag}`);
        finality = {
          number: picked.number,
          hash: picked.hash,
          tag:
            (tags.length === 1 && blockTag === 'safe' ? 'safe (finalized state pruned by endpoint)' : blockTag) +
            (picked.heights.length > 1 ? ` (lowest of ${samples.length} samples: ${picked.heights.join(', ')})` : ''),
        };
        break;
      }
    }
    if (!finality) {
      throw new Error(
        `${who}: the endpoint exposes neither a 'finalized' nor a 'safe' block, so no height can be shown to be ` +
          `reorg-proof here — not even one passed with --block. Use an endpoint that reports finality.`,
      );
    }
    // Two sanity bounds on the tag the endpoint served, both cheap, both about
    // the ENDPOINT rather than the chain: a finality height above the head is
    // nonsense, and one below the committed artifact's height for this chain
    // is a stale replica (see STALE_FINALITY_RETRIES). Either is retried, then
    // refused — never certified at silently.
    let latest = null;
    try {
      latest = (await client.getBlock({ blockTag: 'latest' }))?.number ?? null;
    } catch {
      latest = null;
    }
    const aboveHead = latest !== null && finality.number > latest;
    const behindPrior = prior !== undefined && finality.number < prior;
    if (!aboveHead && !behindPrior) break;
    const why = aboveHead
      ? `${finality.tag} ${finality.number} is ABOVE the endpoint's own head ${latest}`
      : `${finality.tag} ${finality.number} is BELOW the committed artifact's height ${prior} for this chain`;
    if (attempt >= STALE_FINALITY_RETRIES) {
      throw new Error(
        `${who}: the endpoint's finality tag is not trustworthy — ${why} after ${attempt + 1} attempts. ` +
          `A certification height must never move backwards across committed runs (a stale replica served this). ` +
          `Use a different endpoint for this chain (--rpc / CENSUS_RPC_<CHAIN>) or wait for the replicas to catch up.`,
      );
    }
    process.stderr.write(`census: ${who} — ${why}; retrying the finality read (${attempt + 1}/${STALE_FINALITY_RETRIES})\n`);
    rotateConnections(`stale finality tag, attempt ${attempt + 1}/${STALE_FINALITY_RETRIES}`);
    await sleep(1_000 * 2 ** attempt);
  }

  const forced = arg('--block');
  const chosen = forced ? null : finality;
  if (!forced) {
    await gatherAncestry(chainSlug, who, chosen);
    return finality;
  }

  const requested = BigInt(forced);
  // An explicit --block is the operator's deliberate choice (bounded by
  // finality above); the monotonic floor applies to the automatic path only,
  // so a deliberate historical re-read stays possible.
  if (requested > finality.number) {
    throw new Error(
      `${who}: --block ${requested} is ABOVE the endpoint's ${finality.tag} block ${finality.number}. ` +
        `A height that can still be reorganized cannot certify custody away; pass ${finality.number} or lower.`,
    );
  }
  const b = await client.getBlock({ blockNumber: requested });
  const explicit = { number: b.number, hash: b.hash, tag: `explicit (<= ${finality.tag} ${finality.number})` };
  await gatherAncestry(chainSlug, who, explicit);
  return explicit;
}
/**
 * Ancestry evidence for the replacement guard, gathered when a chain's census
 * block is chosen: the TARGET snapshot's block (the file this run replaces)
 * must be an ancestor of the chosen block, proven by the link walk. Unproven
 * ⇒ the guard refuses a higher snapshot with the reason recorded here.
 */
async function gatherAncestry(chainSlug, who, chosen) {
  if (!chainSlug || !chosen) return;
  const th = TARGET_HEIGHT.get(chainSlug);
  const thash = TARGET_HASH.get(chainSlug);
  if (th === undefined || !thash) {
    ANCESTRY_SEEN.delete(chainSlug);
    return;
  }
  const proposed = { number: chosen.number, hash: String(chosen.hash).toLowerCase() };
  try {
    const v = await verifyAncestryByWalk(rpcFor(chainSlug), { height: th, hash: thash }, chosen, who);
    ANCESTRY_SEEN.set(chainSlug, { height: th, hash: thash, proposed, ...v });
  } catch (err) {
    const reason = `the ancestry walk failed: ${classifyRpcError(err)} — ${err.message?.split('\n')[0]}`;
    process.stderr.write(`census: ${who} — ${reason}\n`);
    ANCESTRY_SEEN.set(chainSlug, { height: th, hash: thash, proposed, verified: false, reason });
  }
}
/**
 * Before publication (Codex #2070 r25 P1/P2): the snapshot actually being
 * replaced is the OUTPUT FILE, which for a full run that lost a chain is a
 * partial file the start-of-run load never saw; and a chain's census block can
 * have moved after its evidence was gathered (the lagging-head cap). So the
 * evidence is re-validated against the output file's blocks and the FINAL
 * block each chain was read at, and any chain whose evidence is missing or
 * bound to a different proposed block is walked again now.
 */
async function ensureAncestryFor(outFile, results, who = 'publication') {
  const savedH = new Map(TARGET_HEIGHT);
  const savedHash = new Map(TARGET_HASH);
  try {
    loadTargetSnapshot(outFile);
  } catch (err) {
    throw new Error(`${outFile} is the snapshot this run would replace, and it cannot be read: ${err.message}`);
  }
  const finalBlock = new Map();
  for (const r of results) {
    const h = BigInt(r.atBlock);
    if (!finalBlock.has(r.chainSlug) || h > finalBlock.get(r.chainSlug).number) finalBlock.set(r.chainSlug, { number: h, hash: String(r.atBlockHash).toLowerCase() });
  }
  for (const [slug, chosen] of finalBlock) {
    const th = TARGET_HEIGHT.get(slug);
    const thash = TARGET_HASH.get(slug);
    if (th === undefined || !thash || th >= chosen.number) {
      ANCESTRY_SEEN.delete(slug); // nothing to prove (no target, or equal/lower height — the height/hash rules decide)
      continue;
    }
    const seen = ANCESTRY_SEEN.get(slug);
    const bound = seen && seen.height === th && seen.hash === thash && seen.proposed && seen.proposed.number === chosen.number && seen.proposed.hash === chosen.hash;
    if (bound && seen.verified === true) continue;
    process.stderr.write(`census: ${slug} — ancestry evidence ${seen ? 'is bound to a different block' : 'is missing'} for the snapshot being replaced (${th} → ${chosen.number}); walking now\n`);
    await gatherAncestry(slug, `${slug} (${who})`, chosen);
  }
  // the monotonic floor keeps the higher of canonical and target; leave TARGET_* describing the output file
  void savedH; void savedHash;
}


/**
 * Read the Diamond's `DiamondCut` history for the intent PRODUCER, as a
 * REFUTATION-ONLY reading: it can show that the producer WAS routed at some
 * point (so rows may exist that an unrouted getter cannot see), and it can
 * show that the returned history is incomplete. It can NEVER show that the
 * producer was never routed.
 *
 * An earlier revision called this a proof ("a producer selector absent from
 * every cut was never callable") and returned `proven: true`. That was
 * withdrawn (Codex #2070 r5 P1) and the positive shape itself retired (r12
 * P2): an endpoint that omits an `Add`/`Remove` PAIR leaves the CURRENT
 * surface fully accounted for, so no continuity test over `eth_getLogs` can
 * detect the omission — and a nested `proven: true` beside an outer
 * `indeterminate` verdict is contradictory metadata a consumer may treat as
 * authoritative. The result therefore carries a `verdict` and a `refuted`
 * flag and no `proven` field at all:
 *
 *   - `refuted`      — the producer is routed now, or an `Add` for it appears in
 *                      the history: rows MAY exist; the class is indeterminate.
 *   - `unreadable`   — the history was not read in full (zero cuts, an `Add`
 *                      missing for a currently-routed selector, an RPC error).
 *   - `not-refuted`  — nothing in the returned history routes the producer and
 *                      the history accounts for the whole current surface.
 *                      This is the STRONGEST reading available and it is still
 *                      not a proof of absence; the class stays indeterminate
 *                      pending a state read (a calibrated storage slot proven
 *                      against a routed getter, or routing the getter).
 *
 * @returns {{refuted: boolean, verdict: 'refuted'|'unreadable'|'not-refuted', reason: string, cutsScanned?: number}}
 */
async function refuteProducerNeverRouted({
  client,
  diamond,
  fromBlock,
  toBlock,
  producerSelector,
  producerRouted,
  routedSelectors,
}) {
  // The producer answering right now settles it without any history at all.
  if (producerRouted) {
    return {
      refuted: true,
      verdict: 'refuted',
      reason:
        'the intent PRODUCER is routed on this Diamond while its getter is not — commits may exist and cannot be read',
    };
  }
  try {
    const logs = await getLogsChunked(client, {
      address: diamond,
      events: [DIAMOND_CUT_EVENT],
      fromBlock,
      toBlock,
    });
    const everRouted = logs.some((log) =>
      (log.args?._diamondCut ?? []).some((cut) =>
        (cut.functionSelectors ?? []).some(
          (sel) => sel.toLowerCase() === producerSelector.toLowerCase(),
        ),
      ),
    );
    if (everRouted) {
      return {
        refuted: true,
        verdict: 'refuted',
        reason:
          'the intent producer WAS routed at some point in this Diamond\'s cut history — rows may have been written before the facet was removed',
        cutsScanned: logs.length,
      };
    }
    // A Diamond that EXISTS has taken at least one cut — its deploy cuts every
    // facet in. So zero cuts does not mean "never routed"; it means the scan
    // did not see the history at all (a pruned endpoint, a range that misses
    // the deploy, a stale `deployBlock` in the artifact). Reading that as proof
    // is the precise failure this census is built to refuse: an empty scan
    // manufacturing the comfortable answer.
    //
    // This guard is not hypothetical. It fired on op-sepolia and sepolia, whose
    // recorded `deployBlock` yields no logs at all — and the endpoints prune
    // state, so the true creation block cannot be recovered by bisection there
    // either. Those chains are INDETERMINATE until read from an archive node.
    if (logs.length === 0) {
      return {
        refuted: false,
        verdict: 'unreadable',
        reason:
          'the cut-history scan returned ZERO DiamondCut events, but every Diamond emits at least one at deploy — ' +
          'the history was not actually read (pruned endpoint, or a deployBlock that does not match this address), ' +
          'so absence is not established. Re-run against an archive endpoint.',
        cutsScanned: 0,
      };
    }

    // Codex #2070 r3 P1 — a NON-ZERO cut count is still not a complete history.
    // An endpoint that omits the earliest receipts but serves later ones passes
    // the zero check while hiding exactly the deploy-era cuts most likely to
    // carry the producer: added in an omitted early cut, removed in a returned
    // later one, leaving a live commit this census would certify absent.
    //
    // Continuity test that needs no extra trust: if the history is complete,
    // every selector the Diamond CURRENTLY routes must have been ADDED by some
    // cut in it. Any routed selector the history cannot account for proves the
    // scan is missing cuts, and the answer is `indeterminate`.
    //
    // Codex #2070 r4 P1 — ONLY an `Add` introduces a selector. A `Replace`
    // requires an existing route, so it can never be the cut that brought a
    // selector in; and `RefreshAllFacetsInPlace` emits a `Replace` for EVERY
    // routed selector, so a single later full-facet refresh would "explain" the
    // whole surface while the deployment cut — and an early add/remove of the
    // producer — stayed omitted. Counting `Replace` made the test pass on
    // exactly the partial history it exists to reject. Requiring an `Add` per
    // routed selector is the deployment-cut requirement made precise: the deploy
    // is where the routed surface was added, and no later cut can substitute.
    const FACET_CUT_ACTION_ADD = 0; // EIP-2535 FacetCutAction { Add, Replace, Remove }
    const addedSelectors = new Set();
    for (const log of logs) {
      for (const cut of log.args?._diamondCut ?? []) {
        if (Number(cut.action) !== FACET_CUT_ACTION_ADD) continue;
        for (const sel of cut.functionSelectors ?? []) addedSelectors.add(sel.toLowerCase());
      }
    }
    const unexplained = routedSelectors.filter((sel) => !addedSelectors.has(sel.toLowerCase()));
    if (unexplained.length !== 0) {
      return {
        refuted: false,
        verdict: 'unreadable',
        reason:
          `the cut history carries no ADD for ${unexplained.length} of the ${routedSelectors.length} selectors the ` +
          'Diamond currently routes, so it is INCOMPLETE — the endpoint omitted the cut(s) that introduced them ' +
          '(a later Replace-only refresh cannot substitute for the deployment cut). The producer could have been ' +
          'added in an omitted cut and removed in a returned one. Re-run against an archive endpoint.',
        cutsScanned: logs.length,
        routedSelectors: routedSelectors.length,
        unexplainedSelectors: unexplained.length,
      };
    }
    // Codex #2070 r12 P2 — this is the strongest reading the history can give
    // and it is NOT a proof. An omitted Add/Remove pair for the producer would
    // leave every check above satisfied. Say so in the result itself, so the
    // artifact can never carry a reusable positive proof.
    return {
      refuted: false,
      verdict: 'not-refuted',
      reason:
        'no DiamondCut in the RETURNED history routes the intent producer, and that history carries an ADD for every ' +
        'selector the Diamond currently routes — but an omitted Add/Remove pair is invisible to this test, so this ' +
        'is NOT a proof of absence; the class stays indeterminate pending a state read of the rows',
      cutsScanned: logs.length,
      routedSelectors: routedSelectors.length,
    };
  } catch (err) {
    return {
      refuted: false,
      verdict: 'unreadable',
      reason: `the cut history could not be read in full (${classifyRpcError(err)}), so absence cannot be established`,
    };
  }
}

async function censusDeployment(dep) {
  const { slug, label, addresses } = dep;
  const who = `${slug} (${label})`;
  const diamond = addresses.diamond;
  const rpc = rpcFor(slug);
  if (!diamond) throw new Error(`${who}: addresses.json carries no diamond address`);
  if (!rpc) throw new Error(`${who}: no RPC — pass --rpc or set CENSUS_RPC_${slug.toUpperCase().replace(/-/g, '_')}`);
  const claim = pick(loadAbi('ClaimFacet'), ['getBorrowerLifRebate', 'getFallbackSnapshot']);
  const loanView = pick(loadAbi('LoanFacet'), ['getLoanDetails']);
  const vpfiView = pick(loadAbi('VPFITokenFacet'), ['getVPFIToken']);
  const metrics = pick(loadAbi('MetricsFacet'), ['getProtocolStats', 'getAllLoansPaginated']);
  // The error entry must travel with the function: `getIntentCommit` REVERTS
  // `IntentNoCommit` when no commit is live, and that revert is the proof of
  // absence. Without the error in the ABI viem cannot name it, and an absent
  // commit would be indistinguishable from a genuine failure.
  const intentView = pick(loadAbi('SwapToRepayIntentFacet'), ['getIntentCommit', 'IntentNoCommit']);
  // The PRODUCER, for the routing-history REFUTATION: an unrouted getter says
  // nothing about whether this selector was ever callable.
  const intentProducer = pick(loadAbi('SwapToRepayIntentFacet'), ['commitSwapToRepayIntent']);
  // `facets()` gives the Diamond's CURRENT routed surface, which is what makes
  // the cut history checkable for continuity — see {refuteProducerNeverRouted}.
  const loupe = pick(loadAbi('DiamondLoupeFacet'), ['facetAddress', 'facetAddresses', 'facets']);
  const intentEvents = pick(loadAbi('SwapToRepayIntentFacet'), [
    'SwapToRepayIntentCommitted',
    'SwapToRepayIntentFilled',
    'SwapToRepayIntentCancelled',
    'SwapToRepayIntentForceCancelled',
  ]);

  const client = createPublicClient({ transport: http(rpc, { fetchFn: fetchViaNodeAgents }) });
  const chainId = await client.getChainId();
  if (addresses.chainId && Number(addresses.chainId) !== Number(chainId)) {
    throw new Error(
      `${who}: RPC reports chainId ${chainId} but the deployment artifact says ${addresses.chainId} — wrong endpoint`,
    );
  }
  // Codex #2070 P1 — pin to a block IDENTITY, not a height. A height does not
  // name the state that was read: during a reorg two `eth_call`s at the same
  // height can resolve against different blocks, and a later reproduction can
  // resolve that height to a replacement. Since this artifact is used to
  // certify custody migrations away, prefer a FINALIZED block (reorg-proof by
  // construction) and record its hash so the run is reproducible and its
  // integrity is checkable after the fact.
  const censusBlock = await censusBlockFor(client, slug, who);
  const atBlock = censusBlock.number;

  const read = (functionName, args = []) =>
    withReplicaRetry(
      atBlock,
      () =>
        callAtHash(client, censusBlock, {
          address: diamond,
          abi: [...claim, ...metrics, ...intentView, ...loupe, ...loanView, ...vpfiView],
          functionName,
          args,
        }),
      { client },
    );

  // ── Three history-free bounds, taken BEFORE any enumeration ──────────────
  // Each is a STATE read an endpoint cannot misreport by omission, and each
  // on its own proves every class empty. Enumeration then only refines counts.
  //
  // (1) No code at the address ⇒ nothing on-chain to census — BUT ONLY at a
  //     block at or after the deployment. Codex #2070 r7 P1: a finalized/safe
  //     head that still predates a freshly deployed Diamond, or an operator
  //     `--block` older than the deploy, reads `0x` at an address that simply
  //     did not exist YET, and "no code" would certify every class empty
  //     without ever reading the deployment's storage. A census block that
  //     predates the deployment is refused outright. (Since r30 an empty read
  //     is never a proof at all — see below — but a read that predates the
  //     deployment describes nothing and is still refused.)
  const deployBlockKnown = addresses.deployBlock !== null && addresses.deployBlock !== undefined;
  if (deployBlockKnown && atBlock < BigInt(addresses.deployBlock)) {
    throw new Error(
      `${who}: census block ${atBlock} PREDATES the recorded deployBlock ${addresses.deployBlock} — the Diamond did not exist ` +
        `at that height, so nothing read there describes its storage. Use a later block.`,
    );
  }
  const code = await withReplicaRetry(atBlock, () => codeAtHash(client, censusBlock, diamond), { client });
  const codeAbsent = !code || code === '0x';
  // Codex #2070 r17 → r30 — an empty read is NEVER a proof, and needs no
  // creation evidence to say so. Every deployment in this inventory postdates
  // Cancun on its chain (EIP-6780: SELFDESTRUCT deletes an account only inside
  // the transaction that created it), so a contract that once lived at an
  // address still has its code at every later block. No code at the
  // hash-pinned, finalized census block therefore means no persistent contract
  // EVER lived at the recorded address on this chain: the artifact names no
  // Diamond, and the deployment's real Diamond — if the deploy happened at all
  // — is uncensused. That is a COVERAGE gap, undetermined until the operator
  // corrects the artifact from the broadcast record, exactly like an address
  // that holds a non-Diamond. Rows at THIS address are indeed impossible
  // (storage cannot outlive code, and a CREATE-derived address never carries
  // an EIP-7702 delegation), but the census certifies deployments, not
  // addresses. The r17 rule certified "no code here WITH code at the deploy
  // block" as proven; that pair cannot occur on one post-Cancun chain, so any
  // read producing it came from two histories — rounds 29 and 30 were spent
  // binding it before that was seen — and the rule is retired, not bound.
  const codeAbsentUnexplained = codeAbsent;
  const codeAbsentReason = `the address has no code at the census block; on a post-Cancun chain (EIP-6780) no persistent contract ever lived here, so the artifact names no Diamond and the real deployment, if any, is uncensused — undetermined until the artifact is corrected from the broadcast record${deployBlockKnown ? ` (recorded deployBlock ${addresses.deployBlock})` : ' (the artifact records no deployBlock either)'}`;
  // (2) No CUSTODY SURFACE routed ⇒ no facet can have written a custody row.
  //     "The loupe is unrouted" is NOT sufficient on its own: a Diamond whose
  //     facets were cut without a loupe still answers its custody views, and
  //     those facets may have written rows. So when the loupe does not answer,
  //     every custody view is probed DIRECTLY, and `noFacets` holds only when
  //     ALL of them revert too — the signature of a bare shell whose
  //     diamondCut never ran (three base-sepolia archives, 178 bytes each).
  //     Only a REVERT counts; an RPC failure must never be read as absence.
  // CodeQL (js/regex/missing-regexp-anchor): the end anchor belongs to the
  // bare-`0x` case ONLY — a revert with empty return data — so it is written
  // as its own test rather than as an alternative whose precedence a reader
  // has to work out.
  const isRevert = (err) => {
    const m = `${err?.shortMessage ?? ''} ${err?.message ?? ''}`;
    return /revert|FunctionDoesNotExist|returned no data/i.test(m) || /0x$/.test(m.trimEnd());
  };
  // The Diamond FALLBACK's own "no facet for this selector" error. Only THIS
  // shape proves a selector is unrouted on a Vaipakam Diamond. An EMPTY revert
  // is a different contract talking — a bare shell answers 0xa9ad62f8 on every
  // selector, whereas one base-sepolia archive (18 KB of code at the recorded
  // address) reverts empty on everything and is simply not a Diamond.
  const isUnroutedOnDiamond = isFunctionDoesNotExistRevert;
  const rethrowUnlessRevert = (err) => {
    const kind = classifyRpcError(err);
    if (kind === 'pruned' || kind === 'rate' || !isRevert(err)) throw err;
  };
  let noFacets = false;
  let notADiamond = false;
  let loupeRouted = true;
  // Code is present from here on: an empty read returned above.
  try {
    await read('facetAddresses');
  } catch (err) {
    rethrowUnlessRevert(err);
    loupeRouted = false;
  }
  if (!loupeRouted) {
    const custodyProbes = [
      ['getProtocolStats', []],
      ['getBorrowerLifRebate', [1n]],
      ['getFallbackSnapshot', [1n]],
      ['getIntentCommit', [1n]],
    ];
    let anyAnswered = false;
    let allUnroutedOnDiamond = true;
    for (const [fn, args] of custodyProbes) {
      try {
        await read(fn, args);
        anyAnswered = true;
      } catch (err) {
        // `IntentNoCommit` is the intent view ANSWERING (no commit for loan 1),
        // so it counts as a routed surface, not as absence of one.
        if (isNoCommitRevert(err)) { anyAnswered = true; continue; }
        rethrowUnlessRevert(err);
        if (!isUnroutedOnDiamond(err)) allUnroutedOnDiamond = false;
      }
      if (anyAnswered) break;
    }
    // Proven facet-less ONLY when the Diamond fallback itself said so on
    // every custody selector. Reverts of any other shape mean the contract
    // at this address is not a Vaipakam Diamond — undetermined, not empty.
    noFacets = !anyAnswered && allUnroutedOnDiamond;
    notADiamond = !anyAnswered && !allUnroutedOnDiamond;
  }
  // (3) VPFI BACKING — recorded, never a proof (Codex #2070 r6 P1: a zero
  //     balance proves rows UNBACKED, not absent). The token is resolved
  //     ON-CHAIN first (`getVPFIToken`) — the Diamond's own answer — and from
  //     the artifact ONLY when that selector is CONFIRMED unrouted. Codex r8
  //     P1: `setVPFIToken` permits rotations, so the artifact can lag the live
  //     token; a swallowed rate-limit / transport / decode failure that fell
  //     back to the artifact would read the OLD token's balance and file rows
  //     denominated in the live VPFI as non-VPFI — a false proven-zero. So
  //     every operational failure propagates; only a confirmed absence of the
  //     selector reaches the artifact.
  let vpfiToken = null;
  let vpfiTokenSource = 'unresolvable';
  // `notADiamond` is already known here (the custody-surface probes run first).
  // A contract that is not a Vaipakam Diamond reverts EMPTY on this call too,
  // and an empty revert is — correctly — not "unrouted", so the propagation
  // rule would fail the deployment before its own indeterminate verdict could
  // be recorded. It has no token to resolve; skip the read.
  if (!noFacets && !notADiamond) {
    const vpfiSelector = toFunctionSelector(vpfiView.find((e) => e.name === 'getVPFIToken'));
    let vpfiGetterRouted;
    if (loupeRouted) {
      vpfiGetterRouted = (await read('facetAddress', [vpfiSelector])) !== ZERO_ADDRESS;
    } else {
      // No loupe: the only admissible evidence of absence is the Diamond
      // fallback's own FunctionDoesNotExist on the call itself.
      try {
        const onChain = await read('getVPFIToken');
        vpfiGetterRouted = true;
        if (onChain && onChain !== ZERO_ADDRESS) { vpfiToken = onChain; vpfiTokenSource = 'on-chain getVPFIToken()'; }
      } catch (err) {
        if (!isUnroutedOnDiamond(err)) throw err; // rate limit, transport, decode, pruned: never fall back
        vpfiGetterRouted = false;
      }
    }
    if (loupeRouted && vpfiGetterRouted) {
      const onChain = await read('getVPFIToken'); // any failure here propagates
      if (onChain && onChain !== ZERO_ADDRESS) { vpfiToken = onChain; vpfiTokenSource = 'on-chain getVPFIToken()'; }
    }
  }
  if (!vpfiToken && (addresses.vpfiToken || addresses.vpfiMirror)) {
    vpfiToken = addresses.vpfiToken ?? addresses.vpfiMirror;
    vpfiTokenSource = 'deployment artifact';
  }
  // Codex #2070 r22 P1 — an artifact token is NOT an authoritative scope.
  // `setVPFIToken` permits rotations; if the Diamond rotated A → B and the
  // getter was later cut out, the artifact still says A, and a live fallback
  // or intent row denominated in B would be filed as non-VPFI and the class
  // certified empty. Confirming the getter is unrouted NOW says nothing about
  // whether the token ever changed, and a rotation-event history can only
  // refute. So the artifact token is used to READ and file rows (so a reader
  // can see what it would have scoped), never to CERTIFY: classes 2 and 3 —
  // the scope-dependent ones — stay indeterminate unless the scope came from
  // the chain itself or the no-loans bound settles them.
  const vpfiScopeAuthoritative = vpfiTokenSource === 'on-chain getVPFIToken()';
  const scopeNotAuthoritativeReason =
    'the VPFI token getter is unrouted, so the effective token cannot be read; the artifact token may predate a rotation via setVPFIToken, ' +
    'and a row denominated in the live token would be filed as non-VPFI — undetermined pending routing of the getter or a calibrated read of the token slot';
  const diamondVpfiBalance = vpfiToken
    ? await withReplicaRetry(atBlock, () => callAtHash(client, censusBlock, { address: vpfiToken, abi: [ERC20_BALANCE_OF], functionName: 'balanceOf', args: [diamond] }), { client })
    : null;
  // Codex #2070 r6 P1 ×2 — TWO of the earlier bounds were NOT proofs of
  // absence and are withdrawn as such:
  //   • a ZERO VPFI BALANCE proves the rows are UNBACKED, not absent. The
  //     design's own §0 (pre-migration solvency reconciliation) is the
  //     counterexample: reward payouts may already have spent the backing
  //     while the row — the entitlement — survives. Zero VPFI with live rows
  //     is the WORST case for slice 0, not a no-op. The balance is therefore
  //     recorded as `diamondVpfiBacking` and compared against row totals to
  //     produce the shortfall figure that reconciliation needs — never used to
  //     certify emptiness.
  //   • `FunctionDoesNotExist` on every custody selector proves those
  //     selectors are unrouted NOW, not that they never wrote rows: facets can
  //     be cut in, write loan-keyed rows, and be cut out with storage intact.
  //     Recorded as `custodySurfaceUnrouted`; not a proof. And the probes are
  //     GETTERS (#2095 r7 P1): a Diamond whose loupe and getters are all
  //     unrouted can still route a writer — RiskFacet, DefaultedFacet, the
  //     intent producer — so this says nothing about whether producers are
  //     live. Without a loupe the writer surface cannot be enumerated, so a
  //     bare shell is treated as able to write until it is known not to.
  // What remains sound: where the counter is routed, zero loans ever created
  // (every class is loan-keyed). An empty-code read is a coverage gap, not a
  // proof (r30).
  const custodySurfaceUnrouted = noFacets;
  if (codeAbsentUnexplained) {
    // No code: the artifact names no contract on this chain; cannot certify.
    await assertBlockIdentity(client, censusBlock, who); // before EVERY proven-capable return (r13 P2)
    return {
      chainSlug: slug,
      deployment: label,
      chainId: Number(chainId),
      diamond,
      vpfiToken: null,
      vpfiTokenSource: 'unresolvable',
      vpfiScopeAuthoritative: false,
      provenBy: undefined,
      diamondVpfiBacking: null,
      vpfiRowsTotal: null,
      backingShortfall: null,
      atBlock: atBlock.toString(),
      atBlockHash: censusBlock.hash,
      blockTag: censusBlock.tag,
      rpcHost: rpcHostOf(rpc),
      scanned: { loanIdsEnumerated: 0, totalLoansEverCreated: 'n/a', loanIdRange: 'none', enumerable: false, noCode: false, codeAbsentUnexplained: true, custodySurfaceUnrouted: false, notADiamond: false, loupeRouted: false, intentSurfaceRouted: false, intentProducerRouted: false, intentCorroboration: null, producersMayBeLive: true },
      classes: Object.fromEntries(['vpfiHeldCustody', 'rebateRows', 'fallbackSnapshotCustody', 'liveIntentCommits'].map((k) => [k, {
        status: 'indeterminate',
        indeterminateReason: codeAbsentReason,
        count: 0, total: '0', rows: [],
      }])),
    };
  }

  // Enumeration needs the metrics surface. Where it is unrouted and no bound
  // has already proven emptiness, the deployment is INDETERMINATE — a result,
  // not a thrown failure, so it stays inside coverage and blocks the verdict.
  const statsSelector = toFunctionSelector(metrics.find((e) => e.name === 'getProtocolStats'));
  let enumerable = false;
  if (!notADiamond) {
    if (loupeRouted) enumerable = (await read('facetAddress', [statsSelector])) !== ZERO_ADDRESS;
    else {
      try { await read('getProtocolStats'); enumerable = true; } catch (err) { rethrowUnlessRevert(err); }
    }
  }
  if (!enumerable) {
    // #1566 §7a — a Diamond that routes no loan enumeration can still be READ:
    // the loan counter's slot never moved, so zero there (with the other
    // counters zero at every era slot) is the storage twin of the routed
    // zero-loans proof; a non-zero counter gives the id range, and every class
    // is then scanned at every era's slot. A non-Diamond is never read.
    let storage = null;
    if (!notADiamond && STORAGE_READ.ok) {
      const readSlot = (slot) => withReplicaRetry(atBlock, () => storageAtHash(client, censusBlock, diamond, slot), { client });
      // #2095 r6 P2 — an earlier era's counter slot may be a current field's slot
      // today (a list length, tierTableVersion): such a reading is that field, not
      // a counter, and is set aside before the range and the verdict are judged
      const attributed = attributeCounters(await readCountersByStorage({ readSlot, eraSlots: STORAGE_READ.eraSlots }), STORAGE_READ.headSlots, STORAGE_READ.occupied);
      const counters = attributed.counters;
      // #2095 r2 P1 — the corroborating counters can CONTRADICT the range: a lifetime
      // counter above nextLoanId, or any counter non-zero while nextLoanId is zero,
      // means rows the id range cannot reach; nothing is certified then.
      const contradiction = counters.totalLoansEverCreated.filter((x) => x.value > counters.nextLoanId).map((x) => `totalLoansEverCreated=${x.value} at ${x.slot} (${x.eras.map((e) => e.date).join(',')}) > nextLoanId=${counters.nextLoanId}`)
        .concat(counters.nextLoanId === 0n ? counters.intentLiveCommitCount.filter((x) => x.value > 0n).map((x) => `intentLiveCommitCount=${x.value} at ${x.slot} with nextLoanId=0`) : []);
      if (contradiction.length) {
        storage = { kind: 'counter-contradiction', counters, scan: null, truncated: false, contradiction, aliased: attributed.aliased };
      } else if (counters.allZero) {
        storage = { kind: 'no-loans-ever-created-by-storage', counters, scan: null, truncated: false, aliased: attributed.aliased };
      } else {
        const cap = BigInt(MAX_STORAGE_LOAN_SCAN);
        const n = counters.nextLoanId > cap ? cap : counters.nextLoanId;
        const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));
        const scan = await scanRowsByStorage({ readSlot, loanIds: ids, eraSlots: STORAGE_READ.eraSlots });
        storage = { kind: 'storage-read-calibrated', counters, scan, truncated: counters.nextLoanId > n, aliased: attributed.aliased };
      }
      process.stderr.write(`census: ${who} — storage read (${storage.kind}): nextLoanId=${counters.nextLoanId}${storage.scan ? `, ${storage.scan.loansScanned} id(s) scanned over ${storage.scan.slotsRead} slot(s)` : ''}${attributed.aliased.length ? `, ${attributed.aliased.length} aliased reading(s) ignored` : ''}\n`);
    }
    const status = 'indeterminate';
    const reason = notADiamond
        ? 'the contract at the recorded address is NOT a Vaipakam Diamond (every custody selector reverts without the Diamond fallback\'s FunctionDoesNotExist signature) — it cannot be scoped, and its rows, if any, are not this protocol\'s; undetermined until the artifact is corrected'
        : STORAGE_READ.ok
          ? storage?.kind === 'counter-contradiction'
            ? `the storage counters contradict the loan-id range (${storage.contradiction.join('; ')}) — rows the range cannot reach may exist; refusing to certify`
            : storage?.truncated
              ? `the storage read found nextLoanId=${storage.counters.nextLoanId}, above the ${MAX_STORAGE_LOAN_SCAN}-id scan cap — undetermined until scanned in full`
              : undefined
          : `${custodySurfaceUnrouted ? 'every custody selector is UNROUTED on this Diamond today' : 'this Diamond routes no loan-enumeration surface'}, and the calibrated storage read is unavailable: ${STORAGE_READ.reason}`;
    const storageEvidence = storage
      ? {
          ...STORAGE_READ.evidence,
          kind: storage.kind,
          counters: {
            nextLoanId: storage.counters.nextLoanId.toString(),
            totalLoansEverCreated: storage.counters.totalLoansEverCreated.map((x) => ({ slot: x.slot, value: x.value.toString(), eras: x.eras })),
            intentLiveCommitCount: storage.counters.intentLiveCommitCount.map((x) => ({ slot: x.slot, value: x.value.toString(), eras: x.eras })),
          },
          slotsRead: storage.counters.slotsRead + (storage.scan?.slotsRead ?? 0),
          loansScanned: storage.scan?.loansScanned ?? 0,
          truncated: storage.truncated,
          aliasedCountersIgnored: storage.aliased,
        }
      : undefined;
    // one verdict per class from the storage read; the routed-path conventions apply:
    // a rebate/held row is VPFI by definition, a fallback/intent row's asset is unreadable here
    const cls = (name, extra = {}) => {
      if (!storage || storage.kind === 'counter-contradiction') return { status, indeterminateReason: reason, provenBy: undefined, count: 0, total: '0', rows: [], counterContradiction: storage?.kind === 'counter-contradiction' || undefined, ...extra };
      if (storage.kind === 'no-loans-ever-created-by-storage') return { status: 'proven', provenBy: storage.kind, count: 0, total: '0', rows: [], ...extra };
      // #2095 r9 P2 — a scan cut off at the cap still READ its prefix: what it
      // found there is reported with its exact totals; only the verdict is withheld
      if (storage.truncated) {
        const v = clsFromScan(name, extra);
        return { ...v, status: 'indeterminate', provenBy: undefined, indeterminateReason: v.indeterminateReason ? `${reason}; ${v.indeterminateReason}` : reason, scannedPrefix: `1..${storage.scan.loansScanned}` };
      }
      return clsFromScan(name, extra);
    };
    const clsFromScan = (name, extra) => {
      const rows = storage.scan.rows[name];
      if (name === 'liveIntentCommits') {
        // the storage row carries no amount (only the orderHash is read), and the live counter can contradict an empty scan
        const v = intentVerdictFromStorage({ rows, liveCommitCounts: storage.counters.intentLiveCommitCount.map((x) => ({ slot: x.slot, value: x.value.toString(), eras: x.eras })) });
        return v.status === 'proven'
          ? { status: 'proven', provenBy: storage.kind, count: 0, total: '0', rows: [], ...extra }
          : { status: 'indeterminate', indeterminateReason: v.reason, provenBy: undefined, count: rows.length, total: null, totalUnavailable: 'an intent row\'s amount is not read from storage', rows: [], unknownAssetRows: rows, counterContradiction: v.contradiction ?? false, ...extra };
      }
      if (rows.length && name === 'fallbackSnapshotCustody') {
        return { status: 'indeterminate', indeterminateReason: `${rows.length} row(s) exist at era slots for this class; their asset cannot be read without the getter, so they are not provably VPFI or non-VPFI`, provenBy: undefined, count: rows.length, total: sum(rows, 'collateralTotal'), rows: [], unknownAssetRows: rows, ...extra };
      }
      return { status: 'proven', provenBy: storage.kind, count: rows.length, total: name === 'vpfiHeldCustody' ? sum(rows, 'vpfiHeld') : name === 'rebateRows' ? sum(rows, 'rebateAmount') : '0', rows, ...extra };
    };
    await assertBlockIdentity(client, censusBlock, who); // before EVERY proven-capable return (r13 P2)
    const classes = {
      vpfiHeldCustody: cls('vpfiHeldCustody'),
      rebateRows: cls('rebateRows'),
      fallbackSnapshotCustody: cls('fallbackSnapshotCustody', { nonVpfiRowsExcluded: [] }),
      liveIntentCommits: cls('liveIntentCommits', { nonVpfiRowsExcluded: [] }),
    };
    const everyClassProven = Object.values(classes).every((c) => c.status === 'proven');
    const shellResult = {
      chainSlug: slug,
      deployment: label,
      chainId: Number(chainId),
      diamond,
      vpfiToken,
      vpfiTokenSource,
      vpfiScopeAuthoritative: vpfiTokenSource === 'on-chain getVPFIToken()',
      provenBy: everyClassProven ? storage.kind : undefined,
      diamondVpfiBacking: diamondVpfiBalance === null ? null : diamondVpfiBalance.toString(),
      // #2095 r14 P1 — a held or rebate row the storage scan found is a VPFI
      // liability by construction (proven class or not): it reaches the
      // reconciliation figures, and the shortfall follows from it
      ...(() => {
        const rows = BigInt(sum(classes.vpfiHeldCustody.rows ?? [], 'vpfiHeld')) + BigInt(sum(classes.rebateRows.rows ?? [], 'rebateAmount'));
        return { vpfiRowsTotal: rows.toString(), backingShortfall: diamondVpfiBalance === null ? null : (rows > diamondVpfiBalance ? rows - diamondVpfiBalance : 0n).toString() };
      })(),
      atBlock: atBlock.toString(),
      atBlockHash: censusBlock.hash,
      blockTag: censusBlock.tag,
      rpcHost: rpcHostOf(rpc),
      // producers may still be live where custody selectors route (the prior indeterminate return said so too; #2095 r2 P1)
      scanned: { loanIdsEnumerated: storage?.scan?.loansScanned ?? 0, totalLoansEverCreated: storage ? storage.counters.totalLoansEverCreated.map((x) => x.value.toString()).join('|') : 'n/a', loanIdRange: storage?.scan?.loansScanned ? `1..${storage.scan.loansScanned}` : 'none', enumerable: false, noCode: false, custodySurfaceUnrouted, notADiamond, loupeRouted, producersMayBeLive: !notADiamond, storageRead: storageEvidence, storageReadUnavailable: STORAGE_READ.ok ? undefined : STORAGE_READ.reason },
      classes,
    };
    return applyLayoutProvenance(shellResult, { client, censusBlock, atBlock, diamond, slug, label, deployBlock: BigInt(addresses.deployBlock ?? 0), readFacets: loupeRouted ? () => read('facets') : null, who, manifestEntry: dep.manifestEntry ?? null });
  }

  const stats = await read('getProtocolStats');
  const totalLoansEverCreated = stats[3];

  // How much VPFI does this Diamond HOLD, at the census block? Recorded as
  // BACKING — an upper bound on what the rows of every class could pay out —
  // and NEVER as an absence proof. An earlier revision of this comment said a
  // zero balance "settles class 3 even where its getter is unrouted"; that
  // was withdrawn (Codex #2070 r6 P1, the comment caught in r12 P2): a payout
  // can spend the backing while the row survives, so a zero balance proves
  // the rows would be UNBACKED, not that they are absent — zero balance with
  // live rows is the WORST case, not the settled one. The implementation
  // below records `diamondVpfiBacking` / `backingShortfall` and leaves an
  // unrouted class 3 indeterminate. (`diamondVpfiBalance` was read above,
  // before enumeration.)

  // ── Enumerate every loan id ever created ──────────────────────────────
  const loanIds = [];
  let offset = 0n;
  let reportedTotal = 0n;
  for (;;) {
    const [ids, total] = await read('getAllLoansPaginated', [offset, PAGE]);
    reportedTotal = total;
    loanIds.push(...ids);
    if (ids.length === 0 || BigInt(loanIds.length) >= total) break;
    offset += PAGE;
  }

  if (totalLoansEverCreated > 0n && loanIds.length === 0) {
    throw new Error(
      `${who}: the chain reports ${totalLoansEverCreated} loans ever created but enumeration returned NONE — ` +
        `refusing to report an empty census from a scan that read nothing`,
    );
  }
  if (BigInt(loanIds.length) !== reportedTotal) {
    throw new Error(
      `${who}: enumerated ${loanIds.length} loan ids but pagination reports ${reportedTotal} — incomplete scan`,
    );
  }

  // (4) NO LOAN EVER CREATED ⇒ every class is empty. All four classes are
  //     per-loan rows (`borrowerLifRebate[loanId]`, `fallbackSnapshot[loanId]`,
  //     `intentCommits[loanId]`), and loan ids exist only by creation — so a
  //     Diamond whose loan counter is zero cannot hold a row in any of them.
  //     This bound needs no VPFI token and no asset scoping, which is exactly
  //     what settles a `--fresh` snapshot whose artifact names no token and
  //     whose Diamond never minted a loan. Sound only when BOTH the counter
  //     and the enumeration agree on zero (the enumeration guard above has
  //     already refused a non-zero counter with an empty scan).
  const noLoansEver = totalLoansEverCreated === 0n && loanIds.length === 0;
  const provenByEnumerable = noLoansEver ? 'no-loans-ever-created' : null; // may be withdrawn below by an earlier-era counter (r3 P1)

  // ── Classes 1 & 4 — vpfiHeld custody and rebate rows ──────────────────
  // ── Class 2 — fallback snapshot custody ───────────────────────────────
  // Is the intent surface even ROUTED on this Diamond? Ask the loupe directly
  // rather than inferring it from a `FunctionDoesNotExist` revert.
  //
  // Codex #2070 P1 — an unrouted GETTER is NOT proof of absence, and an earlier
  // revision of this comment claimed it was. Diamond routing is mutable and the
  // PRODUCER (`commitSwapToRepayIntent`) has its own selector: a facet that was
  // cut in, wrote `intentCommits`, and was later cut out leaves rows behind that
  // an unrouted getter cannot see. "The getter does not answer" and "no commit
  // was ever created" are different claims.
  //
  // Nor is the Diamond's routing HISTORY a proof (Codex #2070 r5 P1; this
  // comment still called it "a complete proof" until r13 P2). `DiamondCut` is
  // emitted by every cut, but an endpoint that omits an Add/Remove PAIR leaves
  // the current surface fully accounted for, so the scan can only REFUTE
  // absence (the producer seen routed) or report itself unreadable — see
  // {refuteProducerNeverRouted}. With the getter unrouted the class is
  // INDETERMINATE pending a state read of the rows, which blocks the empty
  // verdict instead of passing as a zero.
  const intentSelector = toFunctionSelector(intentView.find((e) => e.name === 'getIntentCommit'));
  const intentHost = await read('facetAddress', [intentSelector]);
  const intentSurfaceRouted = intentHost && intentHost !== ZERO_ADDRESS;

  const producerSelector = toFunctionSelector(
    intentProducer.find((e) => e.name === 'commitSwapToRepayIntent'),
  );
  const producerHost = await read('facetAddress', [producerSelector]);
  const producerRouted = producerHost && producerHost !== ZERO_ADDRESS;

  // Only needed when the getter is unrouted; when it IS routed we read live
  // state directly, which subsumes the history question entirely.
  // #1566 §7a — with the intent getter unrouted and loans enumerable, the rows
  // are read at EVERY era's slot; the live-commit counter at every era slot is
  // recorded as corroboration and is never sufficient alone.
  let intentStorage = null;
  if (!intentSurfaceRouted && !provenByEnumerable && STORAGE_READ.ok) {
    const readSlot = (slot) => withReplicaRetry(atBlock, () => storageAtHash(client, censusBlock, diamond, slot), { client });
    const scan = await scanRowsByStorage({ readSlot, loanIds, eraSlots: STORAGE_READ.eraSlots, classes: ['liveIntentCommits'] });
    // #2095 r6 P2 — the same attribution rule as every other counter read
    const { counters, aliased } = attributeCounters(await readCountersByStorage({ readSlot, eraSlots: STORAGE_READ.eraSlots }), STORAGE_READ.headSlots, STORAGE_READ.occupied);
    intentStorage = { rows: scan.rows.liveIntentCommits, slotsRead: scan.slotsRead + counters.slotsRead, loansScanned: scan.loansScanned, liveCommitCounts: counters.intentLiveCommitCount.map((x) => ({ slot: x.slot, value: x.value.toString(), eras: x.eras })), aliasedCountersIgnored: aliased };
    intentStorage.verdict = intentVerdictFromStorage(intentStorage);
    process.stderr.write(`census: ${who} — intent rows read from storage at ${STORAGE_READ.eraSlots.intentCommits.length} era slot(s) for ${loanIds.length} loan(s): ${intentStorage.rows.length} row(s)\n`);
  }
  // #2095 r3 P1 — a routed getter reads TODAY's layout only. Every class is
  // therefore also read at every EARLIER era's slot over the id range the
  // era-stable loan counter gives (1..nextLoanId, not today's pagination),
  // and the era counters are read too: a non-zero counter at an earlier era
  // slot contradicts a routed zero-loans proof. Nothing here replaces a
  // routed getter; it reads what no getter can see.
  let historical = null;
  if (STORAGE_READ.ok) {
    const readSlot = (slot) => withReplicaRetry(atBlock, () => storageAtHash(client, censusBlock, diamond, slot), { client });
    const { counters, unexplained: earlierCounters, aliased } = attributeCounters(await readCountersByStorage({ readSlot, eraSlots: STORAGE_READ.eraSlots }), STORAGE_READ.headSlots, STORAGE_READ.occupied);
    const headSlots = STORAGE_READ.headSlots;
    const cap = BigInt(MAX_STORAGE_LOAN_SCAN);
    const n = counters.nextLoanId > cap ? cap : counters.nextLoanId;
    const ids = Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));
    // EVERY era slot, HEAD's included (#2095 r4 P1): a routed getter reads the
    // layout of the facet that was cut, not necessarily HEAD's, so HEAD-slot
    // rows are reconciled against the getter rather than assumed covered by
    // it. The intent class is left out where intentStorage already read it
    // at every era (r4 P2).
    const scanClasses = intentStorage ? ['vpfiHeldCustody', 'rebateRows', 'fallbackSnapshotCustody'] : undefined;
    const scan = await scanRowsByStorage({ readSlot, loanIds: ids, eraSlots: STORAGE_READ.eraSlots, classes: scanClasses });
    // an earlier-era slot may be a CURRENT field's slot today: attributeCounters set those readings aside above
    const split = splitByHeadSlot(scan.rows, headSlots);
    for (const k of Object.keys(split.earlier)) split.earlier[k] = markAliasedRows(split.earlier[k], STORAGE_READ.occupied);
    // HEAD-slot rows are reconciled against the routed getters AFTER the
    // enumeration below has filled the routed row sets (see the post-merge block).
    // #2095 r11 P1 — the HEAD-slot readings are the counters TODAY and are
    // judged too: a live-commit counter above zero with no intent row found,
    // or a lifetime counter above the id range, contradicts a routed proof
    const headOf = (list, f) => list.find((x) => x.slot === headSlots[f]);
    historical = {
      headCounters: {
        totalLoansEverCreated: headOf(counters.totalLoansEverCreated, 'totalLoansEverCreated')?.value?.toString() ?? null,
        intentLiveCommitCount: headOf(counters.intentLiveCommitCount, 'intentLiveCommitCount')?.value?.toString() ?? null,
      },
      rows: split.earlier,
      headRows: split.head,
      aliasedCountersIgnored: aliased,
      slotsRead: scan.slotsRead + counters.slotsRead,
      loansScanned: ids.length,
      truncated: counters.nextLoanId > n,
      nextLoanIdFromStorage: counters.nextLoanId.toString(),
      earlierEraCounters: earlierCounters,
      erasPerField: scan.erasPerField,
    };
    const found = Object.values(split.earlier).reduce((a, r) => a + r.length, 0);
    const atHead = Object.values(split.head).reduce((a, r) => a + r.length, 0);
    process.stderr.write(`census: ${who} — era-complete storage read: ${ids.length} id(s) × ${Object.values(scan.erasPerField).reduce((a, b) => a + b, 0)} era slot set(s), ${scan.slotsRead} slot(s), ${found} earlier-era row(s), ${atHead} HEAD-slot row(s) to reconcile${earlierCounters.length ? `, ${earlierCounters.length} unexplained non-zero earlier-era counter(s)` : ''}${aliased.length ? `, ${aliased.length} aliased reading(s) ignored` : ''}\n`);
  }
  let intentAbsenceProof = null;
  if (!intentSurfaceRouted) {
    // PROOF: the VPFI balance bound (above). REFUTATION ONLY: the cut history.
    // Codex #2070 r5 P1 — an endpoint that returns the deployment cut but
    // omits a later Add/Remove PAIR for the producer leaves every continuity
    // test satisfied (net routing change zero) while a commit written inside
    // that interval may still be live. No test over eth_getLogs can rule that
    // out, so the cut scan can DOWNGRADE (producer seen routed ⇒ cannot be
    // empty by this route) but never certify. Certification comes only from
    // a state read the endpoint cannot misreport by omission.
    // The Diamond's CURRENT routed surface — the yardstick the cut history has
    // to explain for its continuity to be established.
    const facetList = await read('facets');
    const routedSelectors = facetList.flatMap((f) => f.functionSelectors ?? f[1] ?? []);
    const cutHistory = await refuteProducerNeverRouted({
      client,
      diamond,
      fromBlock: BigInt(addresses.deployBlock ?? 0),
      toBlock: atBlock,
      producerSelector,
      producerRouted,
      routedSelectors,
    });
    // Codex #2070 r6 P1 — a zero balance does NOT prove the intent rows are
    // absent (a payout may have spent the backing while the row survives), and
    // cut history can only refute. With the getter unrouted there is NO sound
    // certification available to this script: the class is INDETERMINATE
    // pending a CALIBRATED storage read of `intentCommits[loanId].orderHash`
    // (slot derived from the Storage layout and proven against a routed getter
    // on a live commit before it is trusted) — or routing the getter.
    intentAbsenceProof = {
      proven: false,
      reason:
        (cutHistory.refuted
          ? 'the intent getter is unrouted and the cut history REFUTES absence (the producer was routed) — rows may exist that cannot be read; '
          : 'the intent getter is unrouted; a zero VPFI balance proves the rows would be UNBACKED, not that they are absent, and cut history can only refute — ') +
        'undetermined pending a calibrated storage read of intentCommits[loanId] or routing of the getter',
      diamondVpfiBacking: diamondVpfiBalance === null ? null : diamondVpfiBalance.toString(),
      // Refutation-only: `{refuted, verdict, reason}`, never `proven` (r12 P2).
      cutHistoryRefutation: cutHistory,
    };
  }

  const vpfiHeldRows = [];
  const rebateRows = [];
  const fallbackRows = [];
  // Rows whose asset is NOT this deployment's VPFI. Recorded, never silently
  // dropped: they are outside #1566's scope, but a reader must be able to see
  // what the filter removed.
  const nonVpfiFallbackRows = [];
  const nonVpfiIntentRows = [];
  // Rows whose asset could not be COMPARED because no VPFI token resolved.
  // Unknown ≠ excluded: these keep their class indeterminate.
  const unknownAssetFallbackRows = [];
  const unknownAssetIntentRows = [];
  const intentRows = [];
  for (const id of loanIds) {
    const [rebateAmount, vpfiHeld] = await read('getBorrowerLifRebate', [id]);
    if (vpfiHeld > 0n) vpfiHeldRows.push({ loanId: id.toString(), vpfiHeld: vpfiHeld.toString() });
    if (rebateAmount > 0n) rebateRows.push({ loanId: id.toString(), rebateAmount: rebateAmount.toString() });

    const snap = await read('getFallbackSnapshot', [id]);
    const [lenderCollateral, treasuryCollateral, borrowerCollateral, lenderPrincipalDue, treasuryPrincipalDue, active] =
      snap;
    const custody = lenderCollateral + treasuryCollateral + borrowerCollateral;
    if (active || custody > 0n) {
      // The snapshot carries amounts, not the asset — the LOAN names it.
      const loan = await read('getLoanDetails', [id]);
      const asset = (loan.collateralAsset ?? loan[0]?.collateralAsset ?? '').toString();
      if (!vpfiToken) {
        // Codex #2070 r7 P2 — with no resolvable VPFI token the asset is UNKNOWN,
        // not proven non-VPFI. Recorded separately; the class stays indeterminate.
        unknownAssetFallbackRows.push({ loanId: id.toString(), asset, collateralTotal: custody.toString() });
        continue;
      }
      if (asset.toLowerCase() !== vpfiToken.toLowerCase()) {
        nonVpfiFallbackRows.push({ loanId: id.toString(), asset, collateralTotal: custody.toString() });
        continue;
      }
      fallbackRows.push({
        loanId: id.toString(),
        active,
        collateralTotal: custody.toString(),
        lenderPrincipalDue: lenderPrincipalDue.toString(),
        treasuryPrincipalDue: treasuryPrincipalDue.toString(),
      });
    }

    // Class 3 — live intent commit, read from state. The view reverts
    // `IntentNoCommit` exactly when `commit.orderHash == 0`, and both teardown
    // paths delete the struct — so that revert IS the proof of absence. Any
    // other revert is a real failure and must not be read as "no commit".
    if (!intentSurfaceRouted) continue;
    try {
      const order = await read('getIntentCommit', [id]);
      if (!vpfiToken) {
        unknownAssetIntentRows.push({ loanId: id.toString(), asset: `${order.makerAsset}`, custodialCollateral: order.makerAmount.toString() });
        continue;
      }
      if (`${order.makerAsset}`.toLowerCase() !== vpfiToken.toLowerCase()) {
        nonVpfiIntentRows.push({ loanId: id.toString(), asset: `${order.makerAsset}`, custodialCollateral: order.makerAmount.toString() });
        continue;
      }
      intentRows.push({
        loanId: id.toString(),
        maker: order.maker,
        makerAsset: order.makerAsset,
        custodialCollateral: order.makerAmount.toString(),
        deadline: order.deadline.toString(),
      });
    } catch (err) {
      if (!isNoCommitRevert(err)) throw err;
    }
  }

  // ── Class 3 — live VPFI intent commits, from the event lifecycle ──────
  // A commit is keyed by loanId and can only be created against a live loan,
  // so a chain that has never created a loan cannot hold one. Short-circuiting
  // there is sound AND material: the log scan walks every block since deploy,
  // which on fast testnets is millions of blocks of provably empty range.
  const deployBlock = BigInt(addresses.deployBlock ?? 0);
  const skippedLogScan = loanIds.length === 0;
  // OPTIONAL corroboration — an independent reconstruction of class 3 from the
  // event lifecycle. The view above is authoritative; this exists to catch a
  // disagreement between live state and history, and its failure is a NOTE
  // rather than a verdict, because a pruned node cannot refute live state.
  let corroboration = null;
  if (WANT_CORROBORATION && !skippedLogScan && intentSurfaceRouted) {
    try {
      const logs = await getLogsChunked(client, {
        address: diamond,
        events: intentEvents,
        fromBlock: deployBlock,
        toBlock: atBlock,
      });
      const live = new Map(); // `${loanId}:${orderHash}` -> makerAmount
      for (const log of logs) {
        const { loanId, orderHash, makerAmount } = log.args ?? {};
        if (loanId === undefined || orderHash === undefined) continue;
        const key = `${loanId}:${orderHash}`;
        if (log.eventName === 'SwapToRepayIntentCommitted') live.set(key, makerAmount ?? 0n);
        else live.delete(key); // Filled / Cancelled / ForceCancelled all tear the commit down
      }
      const fromLogs = [...live.keys()].map((k) => k.split(':')[0]).sort();
      // Codex #2070 r6 P2 — the view saw every live intent, VPFI or not; the
      // VPFI filter is a SCOPE decision, not an observation, so agreement is
      // tested against everything the view observed.
      const fromView = [...intentRows, ...nonVpfiIntentRows].map((r) => r.loanId).sort();
      corroboration = {
        source: 'event-lifecycle',
        logsSeen: logs.length,
        liveLoanIdsFromLogs: fromLogs,
        agreesWithView: JSON.stringify(fromLogs) === JSON.stringify(fromView),
      };
      // Codex #2070 P1 — a DISAGREEMENT is the one outcome this corroboration
      // exists to catch, so it must not be recorded as a note beside an
      // otherwise-certified verdict. History contradicting live state means the
      // primary absence proof is no longer trustworthy, and the honest answer
      // is that class 3 is undetermined — which blocks the empty verdict.
      if (!corroboration.agreesWithView) {
        corroboration.contradictsPrimaryProof = true;
      }
    } catch (err) {
      corroboration = {
        source: 'event-lifecycle',
        unavailable: `${classifyRpcError(err)}: ${(err?.details ?? err?.shortMessage ?? err?.message ?? '')
          .toString()
          .split('\n')[0]
          .slice(0, 180)}`,
      };
    }
  }

  await assertBlockIdentity(client, censusBlock, who);


  const result = {
    chainSlug: slug,
    deployment: label,
    chainId: Number(chainId),
    diamond,
    vpfiToken,
    vpfiTokenSource,
    vpfiScopeAuthoritative,
    provenBy: provenByEnumerable ?? undefined,
    // BACKING, not a proof: what the Diamond holds, against what its rows claim.
    // Rows total > backing is exactly the shortfall slice 0 must reconcile.
    diamondVpfiBacking: diamondVpfiBalance === null ? null : diamondVpfiBalance.toString(),
    vpfiRowsTotal: (BigInt(sum(vpfiHeldRows, 'vpfiHeld')) + BigInt(sum(rebateRows, 'rebateAmount')) + BigInt(sum(fallbackRows, 'collateralTotal')) + BigInt(sum(intentRows, 'custodialCollateral'))).toString(),
    backingShortfall:
      diamondVpfiBalance === null
        ? null
        : (() => {
            const rows = BigInt(sum(vpfiHeldRows, 'vpfiHeld')) + BigInt(sum(rebateRows, 'rebateAmount')) + BigInt(sum(fallbackRows, 'collateralTotal')) + BigInt(sum(intentRows, 'custodialCollateral'));
            return (rows > diamondVpfiBalance ? rows - diamondVpfiBalance : 0n).toString();
          })(),
    atBlock: atBlock.toString(),
    // The block IDENTITY, not just its height — a height alone is not
    // reproducible across a reorg.
    atBlockHash: censusBlock.hash,
    blockTag: censusBlock.tag,
    rpcHost: rpcHostOf(rpc),
    scanned: {
      loanIdsEnumerated: loanIds.length,
      totalLoansEverCreated: totalLoansEverCreated.toString(),
      loanIdRange: loanIds.length ? `${loanIds[0]}..${loanIds[loanIds.length - 1]}` : 'none',
      enumerable: true,
      noCode: false,
      custodySurfaceUnrouted: false,
      loupeRouted,
      // r3 P1 — what no routed getter can see: every class at every earlier era slot over 1..nextLoanId
      earlierEraRead: historical ? { ...STORAGE_READ.evidence, headCounters: historical.headCounters, slotsRead: historical.slotsRead, loansScanned: historical.loansScanned, truncated: historical.truncated, nextLoanIdFromStorage: historical.nextLoanIdFromStorage, erasPerField: historical.erasPerField, rowsFound: Object.fromEntries(Object.entries(historical.rows).map(([k, v]) => [k, v.length])), headSlotRows: Object.fromEntries(Object.entries(historical.headRows).map(([k, v]) => [k, v.length])), earlierEraCounters: historical.earlierEraCounters, aliasedCountersIgnored: historical.aliasedCountersIgnored } : undefined,
      intentSource: intentSurfaceRouted
        ? 'getIntentCommit view (live state, history-independent)'
        : intentStorage
          ? `getter unrouted — intentCommits rows read from storage at every layout era's slot (${STORAGE_READ.eraSlots.intentCommits.length} era slot(s)), hash-pinned`
          : `getter unrouted — intentCommits storage NOT read: ${STORAGE_READ.ok ? 'the no-loans bound already settles the class' : STORAGE_READ.reason}`,
      storageRead: intentStorage ? { ...STORAGE_READ.evidence, kind: 'storage-read-calibrated', aliasedCountersIgnored: intentStorage.aliasedCountersIgnored, slotsRead: intentStorage.slotsRead, loansScanned: intentStorage.loansScanned, liveCommitCounts: intentStorage.liveCommitCounts } : undefined,
      storageReadUnavailable: STORAGE_READ.ok ? undefined : STORAGE_READ.reason,
      intentSurfaceRouted,
      intentProducerRouted: producerRouted,
      intentCorroboration: corroboration,
      // Codex #2070 r13 P1 — the fallback producers (RiskFacet / DefaultedFacet
      // full-collateral fallback) and the intent producer can write a
      // qualifying row the moment after this read; a census cannot see a
      // freeze, so a Diamond whose custody surface is routed is assumed live.
      // The report's `migrationRetirable` is derived from this, conservatively.
      producersMayBeLive: true,
    },
    classes: {
      // Classes 1 & 4 are VPFI by construction (`vpfiHeld` / `rebateAmount`
      // ARE VPFI amounts), so they need no asset filter — but they are still
      // VPFI custody, so a missing token address leaves them unscoped too.
      vpfiHeldCustody: {
        status: vpfiToken || provenByEnumerable ? 'proven' : 'indeterminate',
        provenBy: provenByEnumerable ?? undefined,
        indeterminateReason: vpfiToken || provenByEnumerable ? undefined : 'VPFI token unresolvable (neither on-chain nor in the artifact); VPFI custody cannot be scoped',
        count: vpfiHeldRows.length,
        total: sum(vpfiHeldRows, 'vpfiHeld'),
        rows: vpfiHeldRows,
      },
      rebateRows: {
        status: vpfiToken || provenByEnumerable ? 'proven' : 'indeterminate',
        provenBy: provenByEnumerable ?? undefined,
        indeterminateReason: vpfiToken || provenByEnumerable ? undefined : 'VPFI token unresolvable (neither on-chain nor in the artifact); VPFI custody cannot be scoped',
        count: rebateRows.length,
        total: sum(rebateRows, 'rebateAmount'),
        rows: rebateRows,
      },
      fallbackSnapshotCustody: {
        status: provenByEnumerable || (vpfiToken && vpfiScopeAuthoritative) ? 'proven' : 'indeterminate',
        provenBy: provenByEnumerable ?? undefined,
        indeterminateReason: provenByEnumerable || (vpfiToken && vpfiScopeAuthoritative)
          ? undefined
          : vpfiToken
            ? scopeNotAuthoritativeReason
            : 'VPFI token unresolvable (neither on-chain nor in the artifact); VPFI custody cannot be scoped',
        count: fallbackRows.length,
        total: sum(fallbackRows, 'collateralTotal'),
        rows: fallbackRows,
        nonVpfiRowsExcluded: nonVpfiFallbackRows,
        unknownAssetRows: unknownAssetFallbackRows,
      },
      // Class 3 earns `proven` in exactly two ways: the no-loans bound, or the
      // getter was routed and live state was read. With the getter UNROUTED
      // there is no sound certification in this script (r6 P1): the cut
      // history can only refute and `intentAbsenceProof.proven` is always
      // false on that branch — the class is `indeterminate`, which blocks the
      // empty verdict rather than passing as a zero.
      liveIntentCommits: {
        // Class 3 is loan-keyed too, so the no-loans bound settles it as well.
        status:
          provenByEnumerable && !corroboration?.contradictsPrimaryProof
            ? 'proven'
            : intentSurfaceRouted
              ? corroboration?.contradictsPrimaryProof || !vpfiToken || !vpfiScopeAuthoritative
                ? 'indeterminate'
                : 'proven'
              : intentStorage
                ? intentStorage.verdict.status
                : intentAbsenceProof?.proven
                  ? 'proven'
                  : 'indeterminate',
        provenBy: provenByEnumerable ?? (intentStorage?.verdict.status === 'proven' ? 'storage-read-calibrated' : undefined),
        unknownAssetRows: intentSurfaceRouted ? unknownAssetIntentRows : intentStorage ? intentStorage.rows : unknownAssetIntentRows,
        // Codex #2070 r8 P2 — every field below derives from ONE verdict. When
        // the no-loans bound proves the class, no indeterminate reason and no
        // failed absence proof may ride along, or a consumer reads "proven"
        // beside text saying "undetermined".
        indeterminateReason:
          provenByEnumerable && !corroboration?.contradictsPrimaryProof
            ? undefined
            : intentSurfaceRouted
              ? corroboration?.contradictsPrimaryProof
                ? 'the event-lifecycle reconstruction disagrees with the live-state view'
                : !vpfiToken
                  ? 'the intent getter answered but no VPFI token resolved, so every returned intent has an UNKNOWN asset — not provably non-VPFI'
                  : !vpfiScopeAuthoritative
                    ? scopeNotAuthoritativeReason
                    : undefined
              : intentStorage
                ? intentStorage.verdict.reason
                : intentAbsenceProof?.reason,
        absenceProof:
          provenByEnumerable && !corroboration?.contradictsPrimaryProof ? undefined : intentSurfaceRouted || intentStorage ? undefined : intentAbsenceProof,
        // on the storage path the candidates ARE the count (#2095 r2 P2); their amount is not read from storage
        count: intentSurfaceRouted ? intentRows.length : intentStorage ? intentStorage.rows.length : intentRows.length,
        total: intentSurfaceRouted || !intentStorage ? sum(intentRows, 'custodialCollateral') : intentStorage.rows.length ? null : '0',
        totalUnavailable: !intentSurfaceRouted && intentStorage?.rows.length ? "an intent row's amount is not read from storage" : undefined,
        rows: intentRows,
        nonVpfiRowsExcluded: nonVpfiIntentRows,
      },
    },
  };
  // #2095 r3 P1 — merge what the earlier-era read found into every class, and
  // withdraw the routed zero-loans proof when an earlier era's counter says
  // loans were created under a layout today's counter does not read.
  if (historical) {
    for (const name of Object.keys(result.classes)) result.classes[name] = mergeHistoricalRows(result.classes[name], historical, name);
    // r4 P1 — the routed getter and the HEAD-slot storage read must agree per loan id, both ways
    historical.agreement = getterAgreement({
      headRows: historical.headRows,
      routed: {
        vpfiHeldCustody: vpfiHeldRows,
        rebateRows,
        fallbackSnapshotCustody: [...fallbackRows, ...nonVpfiFallbackRows, ...unknownAssetFallbackRows],
        liveIntentCommits: [...intentRows, ...nonVpfiIntentRows, ...unknownAssetIntentRows],
      },
    });
    const disagreements = Object.values(historical.agreement).reduce((a, r) => a + r.length, 0);
    result.scanned.earlierEraRead.getterDisagreements = Object.fromEntries(Object.entries(historical.agreement).map(([k, v]) => [k, v.length]));
    if (disagreements) process.stderr.write(`census: ${who} — ${disagreements} getter/HEAD-slot disagreement(s)\n`);
    for (const [name, mism] of Object.entries(historical.agreement)) {
      if (!mism.length) continue;
      const c = result.classes[name];
      result.classes[name] = { ...c, status: 'indeterminate', provenBy: undefined, getterDisagreements: mism, indeterminateReason: `the routed getter and the storage read at HEAD's slot disagree for ${mism.length} loan id(s) (${mism.slice(0, 3).map((x) => `#${x.loanId}: storage ${x.storage}, getter ${x.getter}`).join('; ')}${mism.length > 3 ? '; …' : ''}) — the cut getter reads a layout other than HEAD's; refusing to certify` };
    }
    // r4 P1 — an unexplained non-zero earlier-era LIVE-COMMIT counter contradicts the intent class on every path
    const oldIntent = historical.earlierEraCounters.filter((c) => c.which === 'intentLiveCommitCount');
    if (oldIntent.length && result.classes.liveIntentCommits.status === 'proven') {
      result.classes.liveIntentCommits = { ...result.classes.liveIntentCommits, status: 'indeterminate', provenBy: undefined, counterContradiction: true, indeterminateReason: `intentLiveCommitCount is non-zero at an earlier era's slot no current field occupies (${oldIntent.map((c) => `${c.value} at ${c.slot} (${c.eras.map((e) => e.date).join(',')})`).join('; ')}) — a commit was written under an earlier layout that neither the getter nor the row scan matched; refusing to certify` };
    }
    // r4 P1 — the liability figures must include what the earlier-era read merged
    const rowsTotal = ['vpfiHeldCustody', 'rebateRows', 'fallbackSnapshotCustody', 'liveIntentCommits'].reduce((acc, name) => {
      const field = { vpfiHeldCustody: 'vpfiHeld', rebateRows: 'rebateAmount', fallbackSnapshotCustody: 'collateralTotal', liveIntentCommits: 'custodialCollateral' }[name];
      return acc + (result.classes[name].rows ?? []).reduce((a, r) => a + (r[field] !== undefined ? BigInt(r[field]) : 0n), 0n);
    }, 0n);
    result.vpfiRowsTotal = rowsTotal.toString();
    result.backingShortfall = diamondVpfiBalance === null ? null : (rowsTotal > diamondVpfiBalance ? rowsTotal - diamondVpfiBalance : 0n).toString();
    if (historical.earlierEraCounters.length && provenByEnumerable) {
      const why = `the routed loan counter reads zero, but an earlier layout era's counter is non-zero (${historical.earlierEraCounters.map((c) => `${c.which}=${c.value} at ${c.slot} (${c.eras.map((e) => e.date).join(',')})`).join('; ')}) — loans were created under an earlier layout; the zero-loans proof is withdrawn`;
      result.provenBy = undefined;
      for (const name of Object.keys(result.classes)) {
        const c = result.classes[name];
        if (c.provenBy === 'no-loans-ever-created') result.classes[name] = { ...c, status: 'indeterminate', provenBy: undefined, indeterminateReason: why };
      }
      result.scanned.earlierEraCounterContradiction = why;
    }
    // #2095 r11 P1 — HEAD's own counters, judged like the earlier eras': the
    // lifetime counter above the id range refuses every proof; a live-commit
    // counter above zero with no intent row found contradicts the intent class
    const hc = historical.headCounters ?? {};
    if (hc.totalLoansEverCreated !== null && hc.totalLoansEverCreated !== undefined && BigInt(hc.totalLoansEverCreated) > BigInt(historical.nextLoanIdFromStorage)) {
      const why = `totalLoansEverCreated at HEAD's slot (${hc.totalLoansEverCreated}) is ABOVE the loan-id range (nextLoanId=${historical.nextLoanIdFromStorage}) — rows the range cannot reach may exist; refusing to certify`;
      result.provenBy = undefined;
      result.classes = downgradeProvenClasses(result.classes, why);
      result.scanned.headCounterContradiction = why;
    }
    // #2095 r12 P2 — the counter is protocol-wide: an intent the getter filed
    // as non-VPFI or unknown-asset is a live commit it counts, so every
    // candidate of every scope is accounted before the counter contradicts
    const intentCandidatesFound = intentRows.length + nonVpfiIntentRows.length + unknownAssetIntentRows.length + (intentStorage?.rows.length ?? 0) + ((historical.rows?.liveIntentCommits ?? []).length);
    if (hc.intentLiveCommitCount !== null && hc.intentLiveCommitCount !== undefined && BigInt(hc.intentLiveCommitCount) > BigInt(intentCandidatesFound) && result.classes.liveIntentCommits.status === 'proven') {
      const why = `intentLiveCommitCount at HEAD's slot reads ${hc.intentLiveCommitCount} while only ${intentCandidatesFound} live intent candidate(s) of any scope were found by the routed getter or at any era slot — the protocol's own counter says a commit exists that no read reached; refusing to certify`;
      result.classes.liveIntentCommits = { ...result.classes.liveIntentCommits, status: 'indeterminate', provenBy: undefined, counterContradiction: true, indeterminateReason: why };
      result.scanned.headCounterContradiction = `${result.scanned.headCounterContradiction ? `${result.scanned.headCounterContradiction}; ` : ''}${why}`;
    }
    // #2095 r9 — a stale lifetime counter ABOVE the storage id range (the same
    // rule the shell path applies) means loans the range cannot reach
    const over = historical.earlierEraCounters.filter((c) => c.which === 'totalLoansEverCreated' && BigInt(c.value) > BigInt(historical.nextLoanIdFromStorage));
    if (over.length) {
      const why = `an earlier layout era's totalLoansEverCreated is ABOVE the loan-id range (${over.map((c) => `${c.value} at ${c.slot}${c.atMappingHead ? ` (now the head of ${c.atMappingHead}, which holds nothing)` : ''}`).join('; ')} > nextLoanId=${historical.nextLoanIdFromStorage}) — rows the range cannot reach may exist; refusing to certify`;
      result.provenBy = undefined;
      result.classes = downgradeProvenClasses(result.classes, why);
      result.scanned.earlierEraCounterContradiction = why;
    }
    if (historical.truncated) {
      const why = `the earlier-era scan was truncated at ${MAX_STORAGE_LOAN_SCAN} ids (nextLoanId=${historical.nextLoanIdFromStorage}); rows beyond it were not read`;
      for (const name of Object.keys(result.classes)) {
        const c = result.classes[name];
        result.classes[name] = { ...c, status: 'indeterminate', provenBy: undefined, indeterminateReason: c.indeterminateReason ? `${c.indeterminateReason}; ${why}` : why };
      }
    }
  } else {
    // #2095 r5 P1 — no era-complete read, no getter-derived proof: the routed
    // getters alone cannot exclude a row written under another era's layout
    result.scanned.earlierEraReadUnavailable = STORAGE_READ.reason;
    result.provenBy = undefined;
    result.classes = downgradeWithoutEraRead(result.classes, STORAGE_READ.reason);
  }
  return applyLayoutProvenance(result, { client, censusBlock, atBlock, diamond, slug, label, deployBlock, readFacets: loupeRouted ? () => read('facets') : null, who, manifestEntry: dep.manifestEntry ?? null });
}

/**
 * Decide whether THIS run's snapshot may replace the committed one. Pure;
 * exported for tests. Returns `{ reason, identityChanges, fresh }`: a
 * non-null `reason` refuses the replacement. Rules, in order (each from a
 * Codex #2070 round): no chain may regress in height (r14); equal height
 * must carry the same hash (r22); a HIGHER height must descend from the
 * committed block — the committed block's hash must be what this run's
 * endpoint reports at that height (r23); no covered identity
 * (`slug|label|diamond|scope`) may be dropped except by an acknowledged,
 * recorded change (r15–r17), and acknowledged changes are carried forward.
 */
export function snapshotRegression({ current, results, ancestry, acknowledged, now }) {
  const lc = (v) => (v == null ? null : String(v).toLowerCase());
  const mine = new Map();
  const mineHash = new Map();
  for (const r of results) {
    const h = BigInt(r.atBlock);
    if (!mine.has(r.chainSlug) || h > mine.get(r.chainSlug)) {
      mine.set(r.chainSlug, h);
      mineHash.set(r.chainSlug, lc(r.atBlockHash));
    }
  }
  const theirs = new Map();
  const theirsHash = new Map();
  for (const r of current.results ?? []) {
    if (!r?.chainSlug || r?.atBlock == null) continue;
    const h = BigInt(r.atBlock);
    if (!theirs.has(r.chainSlug) || h > theirs.get(r.chainSlug)) {
      theirs.set(r.chainSlug, h);
      theirsHash.set(r.chainSlug, lc(r.atBlockHash));
    }
  }
  const regressed = [...mine].filter(([slug, h]) => theirs.has(slug) && theirs.get(slug) > h);
  if (regressed.length) {
    return {
      reason:
        `a newer census is already committed there (${regressed.map(([slug, h]) => `${slug}: committed ${theirs.get(slug)} > this run ${h}`).join('; ')}); ` +
        `this run resolved an older finality height and would un-see state the committed one saw`,
      identityChanges: [],
      fresh: 0,
    };
  }
  const hashConflicts = [...mine]
    .filter(([slug, h]) => theirs.get(slug) === h && theirsHash.get(slug) && mineHash.get(slug) && theirsHash.get(slug) !== mineHash.get(slug))
    .map(([slug, h]) => `${slug}@${h}: committed ${theirsHash.get(slug)} ≠ this run ${mineHash.get(slug)}`);
  if (hashConflicts.length) {
    return {
      reason:
        `the committed census read a DIFFERENT block hash at the same height (${hashConflicts.join('; ')}); the two snapshots describe ` +
        `different chain states — an inconsistent endpoint or a reorg — and neither may silently replace the other; re-run against a consistent endpoint`,
      identityChanges: [],
      fresh: 0,
    };
  }
  const notDescended = [...mine]
    .filter(([slug, h]) => theirs.has(slug) && theirs.get(slug) < h)
    .map(([slug]) => {
      const seen = ancestry?.get?.(slug);
      const committedH = theirs.get(slug);
      const committedHash = theirsHash.get(slug);
      if (!committedHash) return null; // a committed result without a hash cannot be verified either way; height rules already applied
      if (!seen || seen.height !== committedH || lc(seen.hash) !== committedHash) return `${slug}: the committed block ${committedH} could not be verified as an ancestor (no ancestry evidence gathered for that block by this run)`;
      if (!seen.proposed || seen.proposed.number !== mine.get(slug) || lc(seen.proposed.hash) !== mineHash.get(slug)) return `${slug}: the ancestry evidence is bound to a different proposed block (${seen.proposed?.number ?? '?'} ${seen.proposed?.hash ?? ''}) than this run's ${mine.get(slug)} ${mineHash.get(slug)} — the census block moved after the walk`;
      if (seen.verified !== true) return `${slug}: the committed block ${committedH} (${committedHash}) is NOT proven an ancestor of this run's block — ${seen.reason ?? 'the parent-hash walk did not verify'}`;
      return null;
    })
    .filter(Boolean);
  if (notDescended.length) {
    return {
      reason:
        `a higher snapshot is progress only if it descends from the committed one (${notDescended.join('; ')}); a fork or an inconsistent ` +
        `endpoint would otherwise overwrite custody recorded on the prior branch — re-run against a consistent endpoint`,
      identityChanges: [],
      fresh: 0,
    };
  }
  const scopeOf = (v) => (v ? String(v).toLowerCase() : 'none');
  const identity = (r) => `${r.chainSlug}|${r.deployment}|${lc(r.diamond) ?? ''}|${scopeOf(r.vpfiToken)}`;
  const mineIds = new Set(results.map(identity));
  const changed = (current.results ?? [])
    .filter((r) => r?.chainSlug && r?.deployment && !mineIds.has(identity(r)))
    .map((r) => ({ chainSlug: r.chainSlug, deployment: r.deployment, previous: { diamond: r.diamond ?? null, vpfiToken: r.vpfiToken ?? null } }));
  const unacknowledged = changed.filter((m) => !acknowledged.has(`${m.chainSlug}|${m.deployment}`));
  if (unacknowledged.length) {
    return {
      reason:
        `the committed census covers ${unacknowledged.length} deployment identit(y/ies) this run does not ` +
        `(${unacknowledged.map((m) => `${m.chainSlug}|${m.deployment}|${m.previous.diamond}|${scopeOf(m.previous.vpfiToken)}`).join(', ')}); a snapshot may never ` +
        `drop a deployment the committed one covers, and a changed Diamond or scoping token under the same label is an identity change — ` +
        `re-run against the current inventory, or acknowledge a deliberate change with --acknowledge-identity-change <slug|label>`,
      identityChanges: [],
      fresh: 0,
    };
  }
  const carried = [...(current.identityChanges ?? []), ...((current.displacedDiamonds ?? []).map((d) => ({
    chainSlug: d.chainSlug, deployment: d.deployment, previous: { diamond: d.previousDiamond ?? null, vpfiToken: null },
    replacedBy: { diamond: d.replacedBy ?? null, vpfiToken: null }, acknowledgedBy: d.acknowledgedBy ?? 'legacy displacedDiamonds',
  })))];
  const fresh = changed.map((m) => {
    const cur = results.find((r) => r.chainSlug === m.chainSlug && r.deployment === m.deployment);
    return { ...m, replacedBy: { diamond: cur?.diamond ?? null, vpfiToken: cur?.vpfiToken ?? null }, acknowledgedBy: '--acknowledge-identity-change', acknowledgedAt: now };
  });
  const seen = new Set();
  const all = [...carried, ...fresh].filter((c) => {
    const k = `${c.chainSlug}|${c.deployment}|${c.previous?.diamond ?? ''}|${scopeOf(c.previous?.vpfiToken)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { reason: null, identityChanges: all, fresh: fresh.length };
}

async function main() {
  if (process.argv.includes('--write-archive-manifest')) {
    const m = writeArchiveManifest();
    process.stdout.write(`archive manifest written: ${ARCHIVE_MANIFEST} (${m.entries.length} archived deployments)\n`);
    return;
  }
  const which = arg('--chain', 'all');
  const everything = deployedDiamonds();
  const deployments = which === 'all' ? everything : everything.filter((d) => d.slug === which);
  if (which !== 'all' && deployments.length === 0) throw new Error(`no deployment directory for chain '${which}'`);
  const outDir = arg('--out', join(REPO, 'docs/DesignsAndPlans/census'));
  loadPriorCommittedHeights(join(outDir, 'grandfathered-custody-census.json'));
  // The snapshot this run will replace (r24 P2): the canonical for a full run,
  // the chain's partial file for a --chain run. Its heights join the floor,
  // and ancestry is proven against ITS blocks.
  const targetPath = which === 'all' ? join(outDir, 'grandfathered-custody-census.json') : join(outDir, `grandfathered-custody-census.partial-${which}.json`);
  loadTargetSnapshot(targetPath);
  for (const [slug, h] of TARGET_HEIGHT) {
    if (!PRIOR_COMMITTED_HEIGHT.has(slug) || h > PRIOR_COMMITTED_HEIGHT.get(slug)) {
      PRIOR_COMMITTED_HEIGHT.set(slug, h);
      PRIOR_COMMITTED_HASH.set(slug, TARGET_HASH.get(slug));
    }
  }
  if (PRIOR_COMMITTED_HEIGHT.size) {
    process.stderr.write(
      `census: committed heights this run must not fall below — ${[...PRIOR_COMMITTED_HEIGHT].map(([k, v]) => `${k}:${v}`).join(', ')}\n`,
    );
  }

  const results = [];
  const failures = [];
  // An archive can name the SAME Diamond as the live artifact (a config-only
  // snapshot). Coverage stays per-ARTIFACT — that is what the archive finding
  // asked for — but the chain is not read twice: the later entry reuses the
  // earlier result under its own label and says whose it is.
  const byAddress = new Map(); // `${slug}|${diamond.toLowerCase()}` -> result
  // Codex #2070 r8 P1 — a chain reads at ONE block identity, full stop. When a
  // later deployment forces the `safe` downgrade, every result already
  // collected for that chain was read at the OLD finalized height, and a row
  // created on one of those Diamonds between the two heights would be absent
  // from every result while present at the report's effective state. An
  // earlier revision recorded the split as "an honest exception"; it was a
  // hole. The downgrade now DISCARDS that chain's results and reruns the
  // whole chain at `safe` — the queue is a worklist so a slug can be re-queued.
  const queue = [...deployments];
  while (queue.length) {
    const dep = queue.shift();
    const who = `${dep.slug} (${dep.label})`;
    // Codex #2070 r16 P1 — a result is reused across artifacts naming the
    // same Diamond ONLY when their scoping metadata is identical. Where the
    // token getter is unrouted the artifact's VPFI token is what scopes rows,
    // so two config snapshots straddling a token rotation would file a live
    // row as non-VPFI under the first token and copy that verdict to the
    // second. Same Diamond, different artifact token ⇒ its own scan.
    const scopeToken = (dep.addresses.vpfiToken ?? dep.addresses.vpfiMirror ?? 'none').toString().toLowerCase();
    const addrKey = `${dep.slug}|${(dep.addresses.diamond || '').toLowerCase()}|${scopeToken}`;
    if (byAddress.has(addrKey)) {
      const prior = byAddress.get(addrKey);
      results.push({ ...prior, deployment: dep.label, duplicateOfDeployment: prior.deployment });
      process.stderr.write(`census: ${who} — same Diamond AND scoping metadata as "${prior.deployment}"; reusing that result\n`);
      continue;
    }
    process.stderr.write(`census: ${who} …\n`);
    try {
      const r = await censusDeployment(dep);
      results.push(r);
      byAddress.set(addrKey, r);
    } catch (err) {
      // A lagging replica that outlasted the rotated retries: cap the chain's
      // height at that replica's head (still finalized) and restart the chain
      // there, before the generic pruned → safe downgrade is even considered.
      const laggingHead = laggingReplicaHeight(err);
      const cappedAt =
        laggingHead !== null
          ? await capChainAtLaggingHead(createPublicClient({ transport: http(rpcFor(dep.slug), { fetchFn: fetchViaNodeAgents }) }), dep.slug, who, laggingHead).catch(() => null)
          : null;
      if (cappedAt) {
        const dropped = results.filter((r) => r.chainSlug === dep.slug).length;
        for (let i = results.length - 1; i >= 0; i--) if (results[i].chainSlug === dep.slug) results.splice(i, 1);
        for (const k of [...byAddress.keys()]) if (k.startsWith(`${dep.slug}|`)) byAddress.delete(k);
        const staleFailures = failures.filter((f) => f.chainSlug === dep.slug).length;
        for (let i = failures.length - 1; i >= 0; i--) if (failures[i].chainSlug === dep.slug) failures.splice(i, 1);
        const chainDeps = deployments.filter((d) => d.slug === dep.slug);
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].slug === dep.slug) queue.splice(i, 1);
        queue.unshift(...chainDeps);
        process.stderr.write(
          `census: ${who} — state reads kept landing on a replica at ${laggingHead}; re-resolving ${dep.slug} at that height (${cappedAt.tag}) and RESTARTING the chain ` +
            `(discarding ${dropped} result(s) and ${staleFailures} recorded failure(s))\n`,
        );
        continue;
      }
      if (classifyRpcError(err) === 'pruned' && downgradeChainToSafe(dep.slug)) {
        // Restart THIS CHAIN from scratch at `safe`.
        const dropped = results.filter((r) => r.chainSlug === dep.slug).length;
        for (let i = results.length - 1; i >= 0; i--) if (results[i].chainSlug === dep.slug) results.splice(i, 1);
        for (const k of [...byAddress.keys()]) if (k.startsWith(`${dep.slug}|`)) byAddress.delete(k);
        // Codex #2070 r12 P2 — a restart re-reads EVERY deployment on the
        // chain, so a failure recorded for one of them at the old height is
        // stale too: left in place it would report a recovered chain as
        // failed, force `allClassesEmpty` false and fail the run.
        const staleFailures = failures.filter((f) => f.chainSlug === dep.slug).length;
        for (let i = failures.length - 1; i >= 0; i--) if (failures[i].chainSlug === dep.slug) failures.splice(i, 1);
        const chainDeps = deployments.filter((d) => d.slug === dep.slug);
        // Remove any still-queued entries for this slug, then re-queue the whole chain in order.
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].slug === dep.slug) queue.splice(i, 1);
        queue.unshift(...chainDeps);
        process.stderr.write(
          `census: ${who} — finalized state pruned by the endpoint; re-resolving ${dep.slug} at 'safe' and RESTARTING the chain ` +
            `(discarding ${dropped} result(s) and ${staleFailures} recorded failure(s) from the finalized height)\n`,
        );
        continue;
      }
      failures.push({ chainSlug: dep.slug, deployment: dep.label, error: err.message });
      process.stderr.write(`census: ${who} FAILED — ${err.message}\n`);
    }
  }

  // "Empty" is only claimable where every class was actually ESTABLISHED. An
  // indeterminate class is not evidence of absence, so it blocks the verdict
  // rather than passing as a zero.
  const allProven = results.every((r) => Object.values(r.classes).every((c) => c.status === 'proven'));
  const empty = allProven && results.every((r) => Object.values(r.classes).every((c) => c.count === 0));
  const indeterminate = results.flatMap((r) =>
    Object.entries(r.classes)
      .filter(([, c]) => c.status !== 'proven')
      .map(([name, c]) => ({ chainSlug: r.chainSlug, deployment: r.deployment, class: name, reason: c.indeterminateReason })),
  );
  // Codex #2070 r3 P1 — `allClassesEmpty` is a claim about EVERY deployed
  // chain, so only a run that actually covered every deployed chain may assert
  // it. A `--chain <slug>` run (the documented mode for the outstanding
  // op-sepolia archive re-run) proves nothing about the chains it skipped, and
  // must never replace five-chain evidence with a one-chain positive.
  // Coverage is per DEPLOYMENT: a chain with archived Diamonds is covered only
  // when every one of them was censused.
  const allDeployed = everything.map((d) => `${d.slug}|${d.label}`);
  const covered = new Set(results.map((r) => `${r.chainSlug}|${r.deployment}`));
  const coversEveryDeployedChain =
    allDeployed.length > 0 && allDeployed.every((k) => covered.has(k));
  const report = {
    generatedAt: new Date().toISOString(),
    purpose: '#1566 grandfathered-custody census — decides whether slices 0-3 are live work or a certified no-op',
    scope: coversEveryDeployedChain ? 'all-deployed-chains' : 'partial',
    // `null`, not `false`: a partial run did not establish the global claim
    // either way, and a `false` here would read as "something was found".
    allClassesEmpty: coversEveryDeployedChain
      ? failures.length === 0 && results.length > 0 && empty
      : null,
    deploymentsDeployed: allDeployed,
    deploymentsCensused: results.length,
    chainsFailed: failures,
    deploymentsNotCensused: allDeployed.filter((k) => !covered.has(k)),
    indeterminateClasses: indeterminate,
    results,
  };
  // Codex #2070 r13 P1 — "every class is empty at block X" retires the
  // MIGRATION half only if no qualifying row can be written AFTER X and before
  // the prospective isolation lands: a row written in that window sits in
  // shared custody with no migration path once the movers are dropped. The
  // design records the two conditions (a producer freeze that finalized before
  // the scan, or isolation already deployed); this run can see neither, so the
  // verdict says what it establishes and what it does not.
  const liveProducerDeployments = results.filter((r) => r.scanned?.producersMayBeLive).map((r) => `${r.chainSlug}/${r.deployment}`);
  report.proofStandard = PROOF_STANDARD;
  report.migrationRetirable = report.allClassesEmpty === true && liveProducerDeployments.length === 0;
  report.migrationRetirableReason =
    report.allClassesEmpty !== true
      ? 'the population is not established empty'
      : liveProducerDeployments.length
        ? `empty at the census block, but producers may be live on ${liveProducerDeployments.length} deployment(s) ` +
          `(${liveProducerDeployments.join(', ')}); a row written after the census block and before isolation lands would ` +
          `have no migration path — re-run after a producer freeze that has finalized, or after isolation is deployed`
        : 'empty at the census block and no deployment has a live producer';

  mkdirSync(outDir, { recursive: true });
  // A partial run writes to its OWN file. The canonical artifact is the
  // programme's evidence for every deployed chain; a single-chain follow-up
  // overwriting it would destroy that evidence to publish a narrower claim.
  const outFile = join(
    outDir,
    coversEveryDeployedChain
      ? 'grandfathered-custody-census.json'
      : `grandfathered-custody-census.partial-${[...new Set(results.map((r) => r.chainSlug))].join('-') || 'none'}.json`,
  );
  // Codex #2070 r13 P2 — temp + rename, so an interrupted run can never leave
  // a truncated artifact behind; r14 P1 — and under the artifact's lock, with
  // the file as it stands re-read immediately before the rename and the
  // replacement REFUSED if any chain's committed height exceeds this run's.
  // The floor loaded at start (`loadPriorCommittedHeights`) is not enough on
  // its own: two runs can both load it, and the slower one — which resolved an
  // earlier finality height — could otherwise rename an older, emptier
  // snapshot over a newer one that had seen a fresh row.
  // The text is PRODUCED after the comparison so an acknowledged displacement
  // the comparison recorded is in the bytes written (r16).
  // Codex #2070 r25 — ancestry is re-validated against the file ACTUALLY being
  // replaced and the FINAL block of every chain (a full run that lost a chain
  // publishes a partial the start-of-run load never saw; a cap moves a chain's
  // block after its evidence was gathered). Async, so it runs BEFORE the locks.
  await ensureAncestryFor(outFile, results);
  // Codex #2070 r18 P1 — the manifest lock is held from the inventory
  // re-check THROUGH the rename (manifest lock outside, artifact lock inside;
  // every path takes them in that order), so no --fresh can commit between
  // the comparison and the publication.
  withManifestLock(ARCHIVE_MANIFEST, () => {
    // Codex #2070 r17 P1, placed where it always runs in r19 P1 — the
    // inventory this run scanned was a snapshot taken at its START; a --fresh
    // that began after that snapshot and finished before this write leaves
    // the manifest and live artifacts describing a population this run never
    // scanned. Re-take the inventory under the manifest lock NOW and refuse
    // the write if it differs at all. This runs UNCONDITIONALLY, before the
    // guarded write — an earlier revision had it inside the regression
    // callback, which the guarded write only invokes when a prior file
    // exists, so the very first artifact in a directory skipped it. The
    // COMPLETE record is compared (r18 P1), not only the protected identity:
    // a concurrent regeneration may correct `deployBlock` — a permitted
    // correction — and this run's no-code creation evidence was read at the
    // OLD block.
    const scopeOfInv = (v) => (v ? String(v).toLowerCase() : 'none');
    // #2095 r14 P1 — the facet population and deploy time are inputs of the
    // verdict now: a record corrected on either while this run was reading
    // would otherwise pass the revalidation on an identical key
    const facetsOfInv = (d) => {
      const list = d.manifestEntry?.facets ?? Object.values(d.addresses.facets ?? {});
      return [...new Set(list.filter((v) => typeof v === 'string').map((v) => v.toLowerCase()))].sort().join(',');
    };
    const inventoryKey = (d) =>
      `${d.slug}|${d.label}|${String(d.addresses.diamond ?? '').toLowerCase()}|${scopeOfInv(d.addresses.vpfiToken ?? d.addresses.vpfiMirror)}|` +
      `${d.addresses.chainId ?? 'null'}|${d.addresses.deployBlock ?? 'null'}|${deployedAtIso(d.manifestEntry?.deployedAt ?? d.addresses.deployedAt) ?? 'null'}|${facetsOfInv(d)}`;
    const scannedInv = new Set(everything.map(inventoryKey)); // the FULL snapshot taken at start — a --chain run scans a subset of it
    const generationAtStart = LIVE_GENERATION_SEEN;
    const nowInv = new Set(deployedDiamondsUnderLock().map(inventoryKey));
    // Codex #2070 r20 P1 — the deploy scripts write the live artifact through
    // forge, outside any lock, then bump `liveGeneration` under the lock; a
    // changed counter means a Diamond went live during this run even if its
    // artifact is otherwise identical to a record we hold.
    if (LIVE_GENERATION_SEEN !== generationAtStart) {
      throw new Error(
        `refusing to publish ${outFile}: a live artifact was published while this run was scanning (liveGeneration ${generationAtStart} → ${LIVE_GENERATION_SEEN}); ` +
          `this run's population is stale — re-run`,
      );
    }
    const added = [...nowInv].filter((k) => !scannedInv.has(k));
    const removed = [...scannedInv].filter((k) => !nowInv.has(k));
    if (added.length || removed.length) {
      throw new Error(
        `refusing to publish ${outFile}: the deployment inventory changed while this run was scanning (added: ${added.join(', ') || 'none'}; ` +
          `removed: ${removed.join(', ') || 'none'}); this run's population is stale and its verdict would not describe the inventory as it stands — re-run`,
      );
    }
    process.stderr.write(`census: inventory re-validated at publication under the manifest lock — ${nowInv.size} deployment record(s) unchanged since the start snapshot (liveGeneration ${LIVE_GENERATION_SEEN})\n`);
    return writeSnapshotGuarded(outFile, () => `${JSON.stringify(report, null, 2)}\n`, {
      regressedBy: (current) => {
        const verdict = snapshotRegression({
          current,
          results,
          ancestry: ANCESTRY_SEEN,
          acknowledged: new Set((arg('--acknowledge-identity-change', '') || '').split(',').map((a) => a.trim()).filter(Boolean)),
          now: new Date().toISOString(),
        });
        if (verdict.reason) return verdict.reason;
        if (verdict.identityChanges.length) report.identityChanges = verdict.identityChanges;
        if (verdict.fresh) process.stderr.write(`census: ${verdict.fresh} identity change(s) on explicit acknowledgement — recorded under identityChanges (${verdict.identityChanges.length} on record)\n`);
        return null;
      },
    });
  });

  for (const r of results) {
    const c = r.classes;
    process.stdout.write(
      `${r.chainSlug} [${r.deployment}] (chainId ${r.chainId}, block ${r.atBlock}, backing ${r.diamondVpfiBacking ?? '?'} VPFI wei${r.backingShortfall && r.backingShortfall !== '0' ? `, SHORTFALL ${r.backingShortfall}` : ''}): ` +
        `loans=${r.scanned.loanIdsEnumerated} ` +
        `vpfiHeld=${c.vpfiHeldCustody.count} rebate=${c.rebateRows.count} ` +
        `fallback=${c.fallbackSnapshotCustody.count} liveIntents=${c.liveIntentCommits.count}\n`,
    );
  }
  process.stdout.write(`\nartifact: ${outFile}\n`);
  if (indeterminate.length) {
    process.stdout.write('\nINDETERMINATE (not evidence of absence):\n');
    for (const i of indeterminate) process.stdout.write(`  ${i.chainSlug} [${i.deployment}]/${i.class}: ${i.reason}\n`);
  }
  process.stdout.write(
    report.allClassesEmpty
      // Codex #2070 P1 — this line used to say the slices were "a certified
      // no-op" outright. An empty population retires the MIGRATION only: the
      // fallback and intent producers are live and can create a qualifying row
      // the moment after this read-only scan, so the prospective
      // producer/consumer isolation in slices 2-3 still ships.
      ? 'RESULT: every grandfathered class is PROVEN EMPTY on every censused chain AT THE CENSUS BLOCK.\n' +
        (report.migrationRetirable
          ? '        No deployment has a live producer, so the MIGRATION half of slices 0-3 is a certified no-op\n' +
            '        (nothing to move, no shortfall disposition).\n'
          : '        The MIGRATION half of slices 0-3 is NOT yet retirable: ' + report.migrationRetirableReason + '.\n') +
        '        The prospective custody isolation in slices 2-3 is NOT retired by any census result.\n'
      : report.allClassesEmpty === null
        ? `RESULT: PARTIAL RUN — covered ${results.length} of ${report.deploymentsDeployed.length} deployments (live + archived) ` +
          `(missing: ${report.deploymentsNotCensused.join(', ') || 'none'}).\n` +
          '        No global verdict is claimable from this run, and the canonical artifact was NOT overwritten.\n' +
          `        Written to: ${outFile}\n`
        : 'RESULT: not established — a class is non-empty, indeterminate, or a chain failed. See the artifact.\n',
  );
  if (CANDIDATES_WRITTEN) process.stderr.write(
    `census: ${CANDIDATES_WRITTEN} new facet-build candidate commit(s) written to contracts/deployments/facet-build-candidates.json — ` +
    'regenerate the era table (node scripts/storage-layout-eras.mjs --reuse contracts/deployments/storage-slot-eras.json) so they are catalogued, then re-run\n',
  );

  // A partial run has not established the programme's claim, so it must not
  // exit 0 as though it had.
  if (failures.length || indeterminate.length || report.allClassesEmpty === null) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`census: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
