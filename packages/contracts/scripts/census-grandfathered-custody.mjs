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
 * EVIDENCE, THEN ONE JUDGE (#2095 root arrest). This file READS: each
 * deployment's reads go into an evidence ledger — every value tagged with its
 * source, nothing derived — which is frozen and handed to
 * `census-verdict.mjs`, whose one pure function derives every published
 * figure (each class's status, proof chain, count, total, the disagreement
 * flags, the aggregates, the provenance attribution). No read here is gated on
 * a verdict and no site here can write one. Each ledger is published beside
 * the artifact (its `.ledgers.json` sidecar, named by content address — see
 * `artifactTexts`), so `--rejudge` re-derives the verdicts offline against the
 * checkout's rule and era table; a rerun is owed only when that table names a
 * slot the reads never covered, or a record changed after they were taken.
 *
 * Usage:
 *   node packages/contracts/scripts/census-grandfathered-custody.mjs \
 *     [--chain base-sepolia|all] [--rpc URL] [--out DIR] [--block N]
 *     [--proof-standard provenance|routed] [--corroborate]
 *     [--rejudge [--rejudge-from PATH] [--rejudge-allow-coverage-gaps]]
 *   `--help` lists every flag (`CLI_FLAGS`, the one list the command line is
 *   checked against); an unknown flag, a value flag with no value, or a
 *   companion flag without the mode it modifies exits 2 before anything is
 *   read.
 *
 * RPC resolution order: `--rpc`, then `CENSUS_RPC_<SLUG_WITH_UNDERSCORES>`,
 * then `CENSUS_RPC_URL`, then the public default for known testnets.
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { readManifest, regenerateEntries, withManifestLock, writeSnapshotGuarded, livePublicationsInProgress, sameEntry } from './archive-manifest.mjs';
import { loadSlots, loadEras } from './storage-slots.mjs';
import { commitsAround, deployedAtIso, interpolateTimestamp, CANDIDATES_FILE } from './storage-layout-eras.mjs';
import { prepareStorageRead, readCountersByStorage, scanRowsByStorage, requireHexData, DIAMOND_CUT_SELECTOR, MAX_STORAGE_LOAN_SCAN, CLASSES, LIABILITY_CLASS_FIELDS } from './census-storage-read.mjs';
import { verdictFromEvidence, reportVerdict, isVerdict } from './census-verdict.mjs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, toFunctionSelector, parseAbiItem, encodeFunctionData, decodeFunctionResult, decodeErrorResult, keccak256 } from 'viem';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { resolve as resolvePath } from 'node:path';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';

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

/**
 * Every flag the census reads — the ONE list the command line is checked
 * against and `--help` prints. Without it a flag the census does not know was
 * silently ignored, so a typo of an offline mode (`--re-judge` for
 * `--rejudge`) started a full archive-RPC census that rewrites the canonical
 * artifact. `value` names the argument a flag takes (null: a switch).
 * `requires` names the mode a companion flag modifies: given without that mode
 * it modifies nothing, and the run would fall through to the default — a full
 * archive-RPC census — so the command line refuses it, naming both. Reading a
 * flag that is not listed here throws (`arg`, `hasFlag`), so the list and the
 * reads cannot drift apart.
 */
export const CLI_FLAGS = Object.freeze({
  '--chain': { value: 'SLUG|all', help: "census one chain's deployments — a partial run, written to its own file — or every chain (default: all)" },
  '--rpc': { value: 'URL', help: "the chain's endpoint (else CENSUS_RPC_<SLUG>, then CENSUS_RPC_URL, then the public default)" },
  '--out': { value: 'DIR', help: 'where the artifact and its ledger sidecar are written (default: docs/DesignsAndPlans/census)' },
  '--block': { value: 'N', help: "read at this block rather than the endpoint's finalized head (never above it)" },
  '--proof-standard': { value: 'provenance|routed', help: "the proof standard (default: provenance; --rejudge keeps the artifact's unless this is given)" },
  '--corroborate': { value: null, help: 'also reconstruct live intent commits from the event lifecycle, as an independent second source' },
  '--rejudge': { value: null, help: 're-derive every verdict of the committed artifact from its recorded ledgers and republish through the same guards (no RPC when re-judging the artifact it replaces; a --rejudge-from pair above that snapshot walks ancestry through the chain endpoint, and an unverified walk refuses it)' },
  '--rejudge-from': { value: 'PATH', requires: '--rejudge', help: 'the artifact to re-derive (default: the one the run would replace)' },
  '--rejudge-allow-coverage-gaps': { value: null, requires: '--rejudge', help: 'publish even where the reads do not cover the era table (a rerun owed), those classes indeterminate as judged; a changed inventory is never overridden' },
  '--acknowledge-identity-change': { value: 'SLUG|LABEL[,...]', help: 'identity changes the regression guard records instead of refusing' },
  '--write-archive-manifest': { value: null, help: 'regenerate the archive manifest and exit (no census)' },
  '--force-archive-manifest-rewrite': { value: null, requires: '--write-archive-manifest', help: 'allow dropping entries, or writing an empty inventory' },
  '--acknowledge-manifest-displacement': { value: 'SLUG|STAMP[,...]', requires: '--write-archive-manifest', help: 'archived labels that now name a different Diamond, acknowledged by key' },
  '--ancestry-walk-max': { value: 'N', help: 'the longest block range the ancestry walk fetches (default: 250000)' },
  '--ancestry-batch': { value: 'N', help: 'blocks per batched ancestry request, the starting size (default: 25)' },
  '--ancestry-batch-pause-ms': { value: 'MS', help: 'pause between ancestry batches, the starting pause (default: 100)' },
  '--ancestry-concurrency': { value: 'N', help: 'batched ancestry requests in flight (default: 3)' },
  '--help': { value: null, help: 'print this list and exit, reading nothing' },
});

function listedFlag(flag, wantsValue) {
  const spec = CLI_FLAGS[flag];
  if (!spec || Boolean(spec.value) !== wantsValue) throw new Error(`census: ${flag} is read as a ${wantsValue ? 'value flag' : 'switch'} but CLI_FLAGS ${spec ? 'lists it otherwise' : 'does not list it'} — the command line would refuse or ignore it`);
}
/** The value given for a listed value flag, or `fallback`. */
function arg(flag, fallback = undefined) {
  listedFlag(flag, true);
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
/** Whether a listed switch was given. */
function hasFlag(flag) {
  listedFlag(flag, false);
  return process.argv.includes(flag);
}

/**
 * The command line checked against `CLI_FLAGS`, before anything is read:
 * `{ help, problems }`. A problem is an unknown flag or argument, a value
 * flag with no value (`arg` would fall back to its default — `--chain` with
 * nothing after it censuses every chain), a flag given twice (`arg` reads
 * only the first), or a companion flag without the mode its `requires` names
 * (the run would ignore it and census every endpoint instead). Pure.
 */
export function parseCliFlags(argv) {
  const problems = [];
  const seen = new Set();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const spec = CLI_FLAGS[token];
    if (!spec) {
      problems.push(token.startsWith('-') ? `unknown flag ${token}` : `unexpected argument ${JSON.stringify(token)}`);
      continue;
    }
    if (seen.has(token)) problems.push(`${token} is given more than once — only the first would be read`);
    seen.add(token);
    if (token === '--help') help = true;
    if (spec.value) {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) problems.push(`${token} needs a value (${spec.value})`);
      else i += 1;
    }
  }
  for (const flag of seen) {
    const mode = CLI_FLAGS[flag].requires;
    if (mode && !seen.has(mode)) problems.push(`${flag} is given without ${mode} — it only modifies ${mode}, and without it the run would be a full archive-RPC census`);
  }
  return { help, problems };
}

/** The `--help` text: every flag `CLI_FLAGS` lists, with its argument and what it does. */
export function usage() {
  const spelled = Object.entries(CLI_FLAGS).map(([flag, s]) => [s.value ? `${flag} ${s.value}` : flag, s.requires ? `with ${s.requires}: ${s.help}` : s.help]);
  const width = Math.max(...spelled.map(([f]) => f.length)) + 2;
  return `usage: node packages/contracts/scripts/census-grandfathered-custody.mjs [flags]\n\n${spelled.map(([f, help]) => `  ${f.padEnd(width)}${help}`).join('\n')}\n`;
}

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
    // #2095 r17 P1 — the marker is AUTHENTICATED, not inferred from shape alone:
    // the first log must carry the constructor's exact shape (empty cut, zero
    // initializer, empty calldata) AND sit in the transaction that created the
    // Diamond (its receipt names the Diamond as the created contract) or, for a
    // factory-created Diamond, in the first block the Diamond has code (none at
    // the block before). A later initializer-only cut has the empty shape but
    // a non-zero initializer, and a truncated history's first surviving cut is
    // never the creation.
    let constructorCutSeen = false;
    let constructorCutEvidence = null;
    if (ordered.length) {
      const first = ordered[0];
      const shapeOk = (first.args?._diamondCut ?? []).length === 0 && String(first.args?._init ?? ZERO_ADDRESS).toLowerCase() === ZERO_ADDRESS && (first.args?._calldata ?? '0x') === '0x';
      if (shapeOk) {
        try {
          const receipt = first.transactionHash ? await client.getTransactionReceipt({ hash: first.transactionHash }) : null;
          if (receipt?.contractAddress && receipt.contractAddress.toLowerCase() === diamond.toLowerCase()) { constructorCutSeen = true; constructorCutEvidence = `creation transaction ${first.transactionHash}`; }
          else {
            const n = BigInt(first.blockNumber);
            const before = n > 0n ? requireHexData(await client.request({ method: 'eth_getCode', params: [diamond, `0x${(n - 1n).toString(16)}`] }), 'eth_getCode before') : '0x';
            const at = requireHexData(await client.request({ method: 'eth_getCode', params: [diamond, `0x${n.toString(16)}`] }), 'eth_getCode at');
            if (before === '0x' && at !== '0x') { constructorCutSeen = true; constructorCutEvidence = `the Diamond has no code at block ${n - 1n} and code at block ${n} (factory creation)`; }
            else constructorCutEvidence = `the first surviving cut at block ${n} is not the creation (code already present before it)`;
          }
        } catch (err) {
          constructorCutEvidence = `the creation could not be verified: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 120)}`;
        }
      } else constructorCutEvidence = 'the first surviving cut does not have the constructor\'s shape (empty cut, zero initializer, empty calldata)';
    }
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
    return { addresses: [...blocksOf.keys()], initializers: [...initializers], blocksOf, cuts: logs.length, constructorCutSeen, constructorCutEvidence, verdict: logs.length ? 'read' : 'empty (proves nothing — a pruned endpoint returns empty)' };
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
/** The candidates file as it stands, or null when there is none. */
function readCandidatesText() {
  try {
    return readFileSync(CANDIDATES_FILE, 'utf8');
  } catch {
    return null;
  }
}
/**
 * The ONE merge of candidate commits into
 * `contracts/deployments/facet-build-candidates.json` — the census's request
 * to the era tool: "build these, I saw facets cut at these moments that no
 * catalogued build explains". Pure over the file's current text: returns the
 * next text and how many commits it adds. Deterministic content (sorted, no
 * timestamp), so a re-run that asks nothing new reproduces the file byte for
 * byte. The era tool reads it; `--check` fails until every entry is
 * catalogued.
 */
function mergeBuildCandidates(currentText, candidates) {
  let current = { candidates: [] };
  if (currentText !== null) {
    // present but unreadable: refuse rather than overwrite committed candidates as if there were none (#2095 r16 P2)
    try { current = JSON.parse(currentText); } catch (err) { throw new Error(`${CANDIDATES_FILE} is present but malformed (${err.message}); refusing to overwrite it — restore it from version control`); }
    if (!current || !Array.isArray(current.candidates)) throw new Error(`${CANDIDATES_FILE} carries no candidates[]; refusing to overwrite it`);
  }
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
  return { text: JSON.stringify(next, null, 2) + '\n', added };
}
/**
 * How many commits a publication would add to the candidates file — read
 * BEFORE anything is published, so the report can say so and a malformed file
 * refuses the publication before any file is touched. Writes nothing.
 */
function plannedBuildCandidates(candidates) {
  return candidates.length ? mergeBuildCandidates(readCandidatesText(), candidates).added : 0;
}
/**
 * Write the request, AFTER the artifact it was made from is published. The
 * candidates file is owner-gated and turns the era tool's `--check` red until
 * every entry is catalogued, so a publication the ancestry, inventory or
 * regression guard refuses must leave it exactly as it was: the request then
 * describes an artifact that was never kept (root-arrest review r1 P3). Merged
 * against the file as it stands at that moment, and written only when the
 * text changes.
 */
function recordBuildCandidates(candidates) {
  if (!candidates.length) return 0;
  const currentText = readCandidatesText();
  const { text, added } = mergeBuildCandidates(currentText, candidates);
  if (currentText !== text) writeFileSync(CANDIDATES_FILE, text);
  CANDIDATES_WRITTEN += added;
  return added;
}

/**
 * #2095 r9 P1 — the READS layout provenance needs: every facet that may have
 * written to this Diamond, with its code hash at the census block, the loupe
 * as it stands, the cut history, and the timestamp of every block a cut
 * happened in. The facet set is the union of the loupe's current facets,
 * every local record naming this Diamond, and the cut history (refutation-
 * only). Empty code never wrote (EIP-6780).
 *
 * Nothing is ATTRIBUTED here (#2095 root arrest, S3-4): attribution is a
 * function of these reads AND the era table, and the judge holds the table.
 * A collector-side attribution was frozen into the artifact, so every table
 * regeneration forced an archive-node rerun to restate what the reads already
 * answered; recorded raw, the verdict is re-derivable offline (`--rejudge`).
 *
 * S3-3 — three gates stay HERE, as read short-circuits: a contract with no
 * code or that is not a Diamond has no facets of this protocol to read, and
 * without the era table the reads have nothing to be judged against (were they
 * taken, every facet would come out unattributed and the build-candidate
 * request would ask the era tool to catalogue the whole population).
 */
async function collectProvenance(ledger, { client, censusBlock, atBlock, diamond, slug, deployBlock, readFacets, who, manifestEntry = null, scopeSelectors }) {
  const skip = ledger.flags.codeAbsent
    ? 'no-code'
    : ledger.flags.notADiamond
      ? 'not-a-diamond'
      : !STORAGE_READ.ok
        ? `storage read unavailable: ${STORAGE_READ.reason}`
        : null;
  if (skip) {
    ledger.provenance = { read: false, reason: skip };
    return;
  }
  const recorded = recordedFacetAddresses(slug, diamond, manifestEntry);
  let loupe = null;
  let list = null;
  let cutFacetHost = null;
  let loupeReadFailed = false;
  let loupeError = null;
  if (readFacets) {
    try {
      list = await readFacets();
      loupe = list.map((f) => `${f.facetAddress ?? f[0]}`.toLowerCase());
      // the facet hosting diamondCut was installed by the constructor's storage write, never by a cut
      cutFacetHost = hostOfSelector(list, DIAMOND_CUT_SELECTOR);
    } catch (err) {
      list = null;
      loupe = null;
      loupeReadFailed = true;
      loupeError = String(err?.shortMessage ?? err?.message ?? err).slice(0, 200);
    }
  }
  // #2095 r24/r25 P1 — which facet answers each scope getter, keyed by the
  // selector the loupe answered for; the judge tests whether they read one layout
  ledger.hostOf = Object.fromEntries(Object.values(scopeSelectors).map((selector) => [selector, hostOfSelector(list, selector)]));
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
  // The timestamp of EVERY block a cut happened in — the moments the build-
  // candidate request is made of. Read for all of them, not only for the
  // facets this run's table leaves unattributed: which facets those are is the
  // judge's answer, and a `--rejudge` against another table must be able to ask
  // about any of them. A cut block below the endpoint's pruning floor has no
  // readable header: it is ESTIMATED from the census block and the record's
  // deployedAt where both exist, and recorded as unreadable either way. A
  // timestamp only ever feeds the candidate request, never a verdict.
  const blockIso = new Map();
  const unreadableBlocks = [];
  let censusIso = null;
  const censusTimestamp = async () => {
    if (censusIso === null) {
      try { const b = await withReplicaRetry(atBlock, () => client.getBlock({ blockHash: censusBlock.hash }), { client }); censusIso = new Date(Number(b.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch { censusIso = false; }
    }
    return censusIso || null;
  };
  const anchor0 = recorded.deployedAt.length && deployBlock > 0n ? { b0: deployBlock, t0: recorded.deployedAt[0].iso } : null;
  const byNumber = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const cutBlocks = [...new Set([...cut.blocksOf.values()].flatMap((s) => [...s]))].sort(byNumber);
  for (const n of cutBlocks) {
    try {
      const b = await withReplicaRetry(atBlock, () => client.getBlock({ blockNumber: n }), { client });
      blockIso.set(n, { iso: new Date(Number(b.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), estimated: false });
    } catch (err) {
      const t1 = anchor0 ? await censusTimestamp() : null;
      const est = anchor0 && t1 ? interpolateTimestamp({ block: n, b0: anchor0.b0, t0: anchor0.t0, b1: atBlock, t1 }) : null;
      blockIso.set(n, est ? { iso: est, estimated: true } : null);
      unreadableBlocks.push({ block: String(n), reason: String(err?.shortMessage ?? err?.message ?? err).split('\n')[0].slice(0, 160), ...(est ? { estimatedTimestamp: est } : {}) });
    }
  }
  ledger.cutHistory = {
    verdict: cut.verdict,
    cuts: cut.cuts,
    constructorCutSeen: cut.constructorCutSeen,
    constructorCutEvidence: cut.constructorCutEvidence ?? null,
    addresses: cut.addresses,
    initializers: cut.initializers,
    blocksOf: Object.fromEntries([...cut.blocksOf].map(([a, s]) => [a, [...s].sort(byNumber).map(String)])),
    blockTimestamps: Object.fromEntries(cutBlocks.map((n) => [String(n), blockIso.get(n)])),
    unreadableBlocks,
    ...(cut.reason ? { reason: cut.reason } : {}),
  };
  ledger.provenance = {
    read: true,
    facets,
    loupe,
    loupeReadFailed,
    ...(loupeError ? { loupeError } : {}),
    cutFacetHost,
    recorded: { records: recorded.records, facets: recorded.facets.map((f) => f.address), deployedAt: recorded.deployedAt },
  };
  process.stderr.write(`census: ${who} — layout provenance read: ${facets.length} facet address(es) (${recorded.records.length} record(s), loupe ${loupe ? loupe.length : loupeReadFailed ? 'read failed' : 'unrouted'}, cut history ${cut.verdict.split(' ')[0]}, ${cutBlocks.length} cut block(s), ${unreadableBlocks.length} unreadable)\n`);
}

/** The facet the loupe says answers `selector`, lower-cased; null with no loupe list or no host. */
function hostOfSelector(list, selector) {
  const want = String(selector).toLowerCase();
  const f = (list ?? []).find((x) => (x.functionSelectors ?? x[1] ?? []).some((s) => String(s).toLowerCase() === want));
  return f ? `${f.facetAddress ?? f[0]}`.toLowerCase() : null;
}

/**
 * S3-3/S3-4 — the census's request to the era tool, made from what the JUDGE
 * found unattributed: the commits around every moment an unattributed facet
 * was cut, and around the deployedAt of every record naming it. It reads only
 * the verdict and its ledger, so a `--rejudge` asks exactly what a live run
 * would, and a run whose provenance was never read (no table, no Diamond)
 * asks nothing — the case that once wrote the whole population as candidates
 * and reddened the era tool's `--check`. A duplicate record's reads are the
 * original's, which already asked.
 */
export function proposeBuildCandidates(results) {
  const candidates = new Map();
  const propose = (c, reason) => { if (!candidates.has(c.commit)) candidates.set(c.commit, new Set()); candidates.get(c.commit).add(reason); };
  const around = new Map();
  const commitsAt = (iso) => { if (!around.has(iso)) around.set(iso, commitsAround(iso)); return around.get(iso); };
  const shifted = (iso, hours) => new Date(Date.parse(iso) + hours * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const v of results) {
    const ledger = v.ledger;
    if (v.duplicateOfDeployment || !ledger?.provenance?.read || !ledger.cutHistory) continue;
    const who = `${v.chainSlug} (${v.deployment})`;
    const sourcesOf = new Map(ledger.provenance.facets.map((f) => [String(f.address).toLowerCase(), f.sources]));
    for (const u of v.scanned?.provenance?.unattributed ?? []) {
      const address = String(u?.address ?? u).toLowerCase();
      for (const n of ledger.cutHistory.blocksOf?.[address] ?? []) {
        const t = ledger.cutHistory.blockTimestamps?.[n];
        if (!t) continue;
        // an estimate may be hours off: widen to the commits around ±6 h as well
        const moments = t.estimated ? [t.iso, shifted(t.iso, -6), shifted(t.iso, 6)] : [t.iso];
        for (const iso of moments) for (const c of commitsAt(iso)) propose(c, `${c.relation} ${who}'s cut at block ${n} (${t.estimated ? 'estimated ' : ''}${iso})`);
      }
      for (const rec of ledger.provenance.recorded?.deployedAt ?? []) {
        if (!(sourcesOf.get(address) ?? []).includes(rec.record)) continue;
        for (const c of commitsAt(rec.iso)) propose(c, `${c.relation} ${who}'s ${rec.record} deployedAt ${rec.iso}`);
      }
    }
  }
  return [...candidates.entries()].map(([commit, reasons]) => ({ commit, reasons: [...reasons] }));
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
 * What `readRouted` answers for a selector this Diamond does not route (#2095
 * r26). A sentinel rather than `null` or a throw: `null` is a value some reads
 * could legitimately return, and a throw is what used to take a whole
 * deployment's evidence down with one unrouted getter.
 */
export const UNROUTED = Symbol('selector-not-routed-on-this-diamond');
/**
 * The routing boundary (#2095 r26). Cuts are per selector, so EVERY payload
 * read has to be gated by ITS OWN selector's routing. Four rounds running
 * found the read whose gate nobody had made — the pagination selector (r23),
 * `facetAddress` (r24), the two custody getters (r25), then `getLoanDetails`
 * and `facets` (r26) — and each was fixed where it was found, which is what
 * made the next one possible: a hand-made boolean per call site is a rule you
 * can forget, once per site.
 *
 * So the per-site boolean goes. Routing is resolved ONCE per selector here and
 * remembered, every gate reads that one answer, and `readRouted` answers
 * `UNROUTED` rather than throwing — an unrouted selector leaves the class that
 * needed it indeterminate; it does not abort the deployment and take every
 * other class's evidence with it. A new read cannot be added without saying
 * what it does when its selector is not there.
 *
 * A probe that FAILS (rate limit, transport, a pruned replica) is not
 * remembered: the entry is dropped so the next caller probes again. Only an
 * answer — routed or not — is cached, because only an answer is a fact about
 * the Diamond. Exported for the test.
 */
export function makeRoutingBoundary(probeRouting, read) {
  const memo = new Map();
  const selectorRouted = (fn, abiList, probeArgs) => {
    if (!memo.has(fn)) {
      memo.set(
        fn,
        Promise.resolve()
          .then(() => probeRouting(fn, abiList, probeArgs))
          .catch((err) => { memo.delete(fn); throw err; }),
      );
    }
    return memo.get(fn);
  };
  const readRouted = async (fn, abiList, args = [], probeArgs = args) =>
    (await selectorRouted(fn, abiList, probeArgs)) ? read(fn, args) : UNROUTED;
  return { selectorRouted, readRouted };
}
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
const WANT_CORROBORATION = hasFlag('--corroborate');

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
  const force = hasFlag('--force-archive-manifest-rewrite');
  const displaceKeys = (arg('--acknowledge-manifest-displacement', '') || '').split(',').map((k) => k.trim()).filter(Boolean);
  return regenerateEntries(ARCHIVE_MANIFEST, () => localArchivedDiamonds(), { allowDrop: force, allowEmpty: force, allowDisplace: displaceKeys }).manifest;
}

/** The facet population a deployment record names, as one sorted key — an input of the verdict (#2095 r14/r20 P1: layout provenance is per record). */
function recordFacetsKey(d) {
  const list = d.manifestEntry?.facets ?? Object.values(d.addresses.facets ?? {});
  return [...new Set(list.filter((v) => typeof v === 'string').map((v) => v.toLowerCase()))].sort().join(',');
}
/** The VPFI token a record names (what scopes a row where the token getter is unrouted, Codex #2070 r16 P1), lower-cased; 'none' without one. */
function recordScopeToken(d) {
  const token = d.addresses.vpfiToken ?? d.addresses.vpfiMirror;
  return token ? String(token).toLowerCase() : 'none';
}
const recordDeployedAt = (d) => deployedAtIso(d.manifestEntry?.deployedAt ?? d.addresses.deployedAt) ?? 'null';

/**
 * ONE record's complete inventory identity: every field of the record a
 * verdict rests on — the Diamond and chain, the scoping token, the deploy
 * block the no-code evidence was read against (Codex #2070 r18 P1), the
 * deploy time and the facet population (#2095 r14 P1). The one key three
 * checks compare: publication against the inventory re-taken under the
 * manifest lock (Codex #2070 r17/r19/r20 P1), the ledger at collection
 * (`identity.inventoryKey`), and `--rejudge` against the record as it stands
 * NOW — reads taken for a record corrected since describe a record that no
 * longer exists, and re-judging them would re-certify its label.
 */
export function inventoryKeyOf(d) {
  return [d.slug, d.label, String(d.addresses.diamond ?? '').toLowerCase(), recordScopeToken(d), d.addresses.chainId ?? 'null', d.addresses.deployBlock ?? 'null', recordDeployedAt(d), recordFacetsKey(d)].join('|');
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
 * Whether a committed result names a chain and a height — the two keys every
 * reader of a committed artifact (the height floor, the replacement target,
 * the regression guard) is keyed on. A schema-2 result keeps its identity
 * FLAT (C7); one that lacks it would read here as "no result", silently
 * emptying the floor, the ancestry evidence and the identity comparison all at
 * once (S1-R7/S3-1), so it is refused instead. An older result without the
 * keys is skipped, as it always was.
 */
function readableResult(r, where) {
  // schema 2 is where identity became flat; every later schema keeps it so
  if (Number(r?.schema) >= 2 && (!r.chainSlug || r.atBlock == null)) {
    throw new Error(`${where}: a schema ${r.schema} census result has no flat chainSlug/atBlock — its identity is nested or missing, and reading past it would drop that deployment from every committed-artifact check`);
  }
  return Boolean(r?.chainSlug) && r?.atBlock != null;
}
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
    if (!readableResult(r, targetPath)) continue;
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
    if (!readableResult(r, canonicalPath)) continue;
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

/**
 * #2095 root arrest — the census of ONE deployment is two steps with one
 * seam: collect the evidence (`collectEvidence`, every read, nothing derived),
 * then judge it (`verdictFromEvidence`, the only code that can write a class
 * status, a proof chain, a count, a total or an aggregate). Twenty-eight review
 * rounds found a verdict written early and a later pass that forgot to
 * withdraw it; with no verdict anywhere before the judge, there is no earlier
 * verdict to forget. This is the census's only exit, and `publish` refuses
 * anything the judge did not derive.
 */
export async function censusDeployment(dep, reuse = null) {
  // `reuse`: an earlier record's ledger for the same Diamond, re-judged under
  // this record's label (S1-R1) — the verdict is derived again, never copied.
  // Frozen at the hand-off: the evidence cannot grow under the derivation.
  const ledger = deepFreeze(reuse ? relabel(reuse, dep) : await collectEvidence(dep));
  return publish(verdictFromEvidence(ledger, { proofStandard: PROOF_STANDARD, storageRead: STORAGE_READ }));
}

/**
 * Every result the census records passes through here (S1-R1/S3-2): only an
 * object the judge itself returned carries its private brand, so a spread copy
 * of a verdict, or a result assembled by hand, is refused rather than written
 * as if it had been derived.
 */
export function publish(verdict) {
  if (!isVerdict(verdict)) {
    throw new Error('census: refusing to publish a result verdictFromEvidence() did not return — a copied or hand-built verdict states figures no derivation produced');
  }
  return verdict;
}

/** The evidence-ledger schema this collector writes and `--rejudge` requires. */
const LEDGER_SCHEMA = 2;
/** Every selector whose routing the ledger records: 'routed' | 'unrouted' | 'not-probed'. */
const SURFACES = ['getProtocolStats', 'getAllLoansPaginated', 'getBorrowerLifRebate', 'getFallbackSnapshot', 'getLoanDetails', 'getIntentCommit', 'getVPFIToken', 'commitSwapToRepayIntent', 'facets', 'facetAddress', 'facetAddresses'];

/**
 * A fresh evidence ledger for one deployment. It holds READS ONLY — each value
 * tagged with where it came from — so the verdict is re-derivable offline
 * against the checkout's rule and era table. There is deliberately no
 * `classes` key and no status anywhere: a collector site has nowhere to write
 * a verdict, which is what makes "the judge is the only writer" structural
 * rather than a convention.
 */
function newLedger(dep) {
  const { slug, label } = dep;
  return {
    schema: LEDGER_SCHEMA,
    // `inventoryKey`: the record these reads are taken FOR, so `--rejudge` can
    // tell reads of the record as it stands from reads of one corrected since
    identity: { chainSlug: slug, deployment: label, chainId: null, diamond: null, atBlock: null, atBlockHash: null, blockTag: null, rpcHost: null, sourceRecord: sourceRecordFor(slug, label), inventoryKey: inventoryKeyOf(dep) },
    flags: { codeAbsent: false, codeAbsentReason: null, notADiamond: false, loupeRouted: false, custodySurfaceUnrouted: false },
    scope: { vpfiToken: null, source: null },
    backing: null,
    range: { storage: null, storageUnavailable: null, routed: null },
    surfaces: Object.fromEntries(SURFACES.map((s) => [s, 'not-probed'])),
    hostOf: {},
    idsAskedOfGetter: {},
    observations: [],
    corroboration: null,
    cutHistory: null,
    provenance: null,
  };
}

/** Record one row observation. Once the ledger is frozen this throws: the evidence a verdict was derived from cannot grow under it. */
export function observe(ledger, observation) {
  ledger.observations.push(observation);
}

/** Freeze a ledger all the way down — the judge receives evidence no later step can amend (a shallow freeze would still let `observations` grow). */
export function deepFreeze(node) {
  if (node && typeof node === 'object') {
    Object.freeze(node);
    for (const v of Object.values(node)) deepFreeze(v);
  }
  return node;
}

/**
 * A committed ledger made ready to judge: a private copy, frozen all the way
 * down, as every ledger the judge receives is. STRUCTURAL only. The artifact
 * holds each bigint as its decimal string, and that needs no inverse here: the
 * judge reads every integer through one normalisation (`big` in
 * census-verdict.mjs) that takes a bigint and its decimal string alike — a
 * second, numeric revival here was a duplicate of that rule, and one that
 * threw an unnamed SyntaxError on a malformed value the judge would have filed
 * indeterminate by name. The copy keeps the freeze off the parsed artifact
 * the caller still holds. `--rejudge` and the artifact self-verification (T-E)
 * both judge through this, so they re-derive the same input.
 */
export function reviveLedger(json) {
  return deepFreeze(structuredClone(json));
}

/**
 * The same reads under another record's label — a config-only archive that
 * names the SAME Diamond as an earlier record. The verdict is RE-DERIVED from
 * the relabelled ledger, never copied (S1-R1): a copied verdict is unbranded
 * and `publish` refuses it.
 */
function relabel(ledger, dep) {
  return {
    ...ledger,
    identity: { ...ledger.identity, deployment: dep.label, duplicateOfDeployment: ledger.identity.deployment, sourceRecord: sourceRecordFor(dep.slug, dep.label), inventoryKey: inventoryKeyOf(dep) },
  };
}

/** A loan-id list as the ledger records it: `'1..N'` when it is exactly the ids 1..N in order, else the ids themselves. */
function idRangeOf(ids) {
  return ids.length && ids.every((id, i) => BigInt(id) === BigInt(i + 1)) ? `1..${ids.length}` : ids.map((id) => BigInt(id));
}

/**
 * Collect every read of one deployment into its ledger. A read that fails
 * leaves the ledger as far as it got on the error (§3.3), so the failure row
 * shows what WAS read — evidence of the failure, never judged.
 */
export async function collectEvidence(dep) {
  const ledger = newLedger(dep);
  try {
    await readDeployment(dep, ledger);
  } catch (err) {
    if (err && typeof err === 'object') err.partialLedger = ledger;
    throw err;
  }
  return ledger;
}

/**
 * Every read of one deployment, in order: the block identity, the code, the
 * Diamond's routing and scope, the one storage read, the routed reads over the
 * storage range, and the provenance reads; then the cross-replica identity
 * check once, after the last read (r13 P2: a proof-capable ledger must not
 * leave a replica at another block unchecked).
 */
async function readDeployment(dep, ledger) {
  const { slug, label, addresses } = dep;
  const who = `${slug} (${label})`;
  const diamond = addresses.diamond;
  const rpc = rpcFor(slug);
  if (!diamond) throw new Error(`${who}: addresses.json carries no diamond address`);
  if (!rpc) throw new Error(`${who}: no RPC — pass --rpc or set CENSUS_RPC_${slug.toUpperCase().replace(/-/g, '_')}`);
  const abi = {
    claim: pick(loadAbi('ClaimFacet'), ['getBorrowerLifRebate', 'getFallbackSnapshot']),
    loanView: pick(loadAbi('LoanFacet'), ['getLoanDetails']),
    vpfiView: pick(loadAbi('VPFITokenFacet'), ['getVPFIToken']),
    metrics: pick(loadAbi('MetricsFacet'), ['getProtocolStats', 'getAllLoansPaginated']),
    // The error entry must travel with the function: `getIntentCommit` REVERTS
    // `IntentNoCommit` when no commit is live, and that revert is the proof of
    // absence. Without the error in the ABI viem cannot name it, and an absent
    // commit would be indistinguishable from a genuine failure.
    intentView: pick(loadAbi('SwapToRepayIntentFacet'), ['getIntentCommit', 'IntentNoCommit']),
    // The PRODUCER, for the routing-history REFUTATION: an unrouted getter says
    // nothing about whether this selector was ever callable.
    intentProducer: pick(loadAbi('SwapToRepayIntentFacet'), ['commitSwapToRepayIntent']),
    // `facets()` gives the Diamond's CURRENT routed surface, which is what makes
    // the cut history checkable for continuity — see {refuteProducerNeverRouted}.
    loupe: pick(loadAbi('DiamondLoupeFacet'), ['facetAddress', 'facetAddresses', 'facets']),
    intentEvents: pick(loadAbi('SwapToRepayIntentFacet'), [
      'SwapToRepayIntentCommitted',
      'SwapToRepayIntentFilled',
      'SwapToRepayIntentCancelled',
      'SwapToRepayIntentForceCancelled',
    ]),
  };
  const selectorOf = (list, name) => toFunctionSelector(list.find((e) => e.name === name));
  const scopeSelectors = {
    fallback: selectorOf(abi.claim, 'getFallbackSnapshot'),
    loan: selectorOf(abi.loanView, 'getLoanDetails'),
    token: selectorOf(abi.vpfiView, 'getVPFIToken'),
    intent: selectorOf(abi.intentView, 'getIntentCommit'),
  };

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
  Object.assign(ledger.identity, { chainId: Number(chainId), diamond, atBlock: atBlock.toString(), atBlockHash: censusBlock.hash, blockTag: censusBlock.tag, rpcHost: rpcHostOf(rpc) });

  const read = (functionName, args = []) =>
    withReplicaRetry(
      atBlock,
      () =>
        callAtHash(client, censusBlock, {
          address: diamond,
          abi: [...abi.claim, ...abi.metrics, ...abi.intentView, ...abi.intentProducer, ...abi.loupe, ...abi.loanView, ...abi.vpfiView], // the producer too: it is probed directly where the loupe is unrouted (#2095 r24 P1)
          functionName,
          args,
        }),
      { client },
    );

  // Codex #2070 r7 P1 — a census block that PREDATES the recorded deployment
  // describes nothing about this Diamond's storage (a finalized head behind a
  // fresh deploy, or an operator `--block` older than it). Refused outright.
  const deployBlockKnown = addresses.deployBlock !== null && addresses.deployBlock !== undefined;
  if (deployBlockKnown && atBlock < BigInt(addresses.deployBlock)) {
    throw new Error(
      `${who}: census block ${atBlock} PREDATES the recorded deployBlock ${addresses.deployBlock} — the Diamond did not exist ` +
        `at that height, so nothing read there describes its storage. Use a later block.`,
    );
  }
  const code = await withReplicaRetry(atBlock, () => codeAtHash(client, censusBlock, diamond), { client });
  // Codex #2070 r17 → r30 — an empty read is NEVER a proof, and needs no
  // creation evidence to say so. Every deployment in this inventory postdates
  // Cancun on its chain (EIP-6780: SELFDESTRUCT deletes an account only inside
  // the transaction that created it), so a contract that once lived at an
  // address still has its code at every later block. No code at the
  // hash-pinned, finalized census block therefore means no persistent contract
  // EVER lived at the recorded address on this chain: the artifact names no
  // Diamond, and the deployment's real Diamond — if the deploy happened at all
  // — is uncensused. That is a COVERAGE gap, undetermined until the operator
  // corrects the artifact from the broadcast record. Recorded as a flag; there
  // is nothing further at this address to read.
  ledger.flags.codeAbsent = !code || code === '0x';
  if (ledger.flags.codeAbsent) {
    ledger.flags.codeAbsentReason = `the address has no code at the census block; on a post-Cancun chain (EIP-6780) no persistent contract ever lived here, so the artifact names no Diamond and the real deployment, if any, is uncensused — undetermined until the artifact is corrected from the broadcast record${deployBlockKnown ? ` (recorded deployBlock ${addresses.deployBlock})` : ' (the artifact records no deployBlock either)'}`;
    ledger.range.storageUnavailable = 'not read: the recorded address has no code';
  }
  const { readFacets } = ledger.flags.codeAbsent ? { readFacets: null } : await readDiamond({ dep, who, client, censusBlock, atBlock, diamond, read, abi }, ledger);
  await collectProvenance(ledger, { client, censusBlock, atBlock, diamond, slug, deployBlock: BigInt(addresses.deployBlock ?? 0), readFacets, who, manifestEntry: dep.manifestEntry ?? null, scopeSelectors });
  await assertBlockIdentity(client, censusBlock, who);
}

/**
 * The reads of a contract that has code. Nothing here decides anything about
 * a class: a read gate exists only where the read is impossible or
 * meaningless (a non-Diamond answers nothing of this protocol; an unrouted
 * selector cannot be called), and every gate records the routing answer it
 * acted on in `ledger.surfaces`, so the judge sees why a read is absent.
 */
async function readDiamond({ dep, who, client, censusBlock, atBlock, diamond, read, abi }, ledger) {
  const { addresses } = dep;
  const { claim, loanView, vpfiView, metrics, intentView, intentProducer, loupe, intentEvents } = abi;
  // A Diamond whose loupe does not answer may still route custody views, so
  // when the loupe is silent every custody view is probed DIRECTLY: the
  // contract is a bare shell (custody surface unrouted) only when ALL of them
  // answer with the Diamond fallback's own FunctionDoesNotExist, and NOT a
  // Vaipakam Diamond when they revert in any other shape. Only a REVERT counts;
  // an RPC failure must never be read as absence.
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
  let loupeRouted = true;
  try {
    await read('facetAddresses');
  } catch (err) {
    rethrowUnlessRevert(err);
    loupeRouted = false;
  }
  ledger.flags.loupeRouted = loupeRouted;
  ledger.surfaces.facetAddresses = loupeRouted ? 'routed' : 'unrouted';
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
    // `FunctionDoesNotExist` on every custody selector proves those selectors
    // unrouted NOW, not that they never wrote rows: facets can be cut in, write
    // loan-keyed rows and be cut out with storage intact (Codex #2070 r6 P1),
    // and a Diamond whose getters are all unrouted can still route a WRITER
    // (#2095 r7 P1). Recorded, never a proof.
    ledger.flags.custodySurfaceUnrouted = !anyAnswered && allUnroutedOnDiamond;
    ledger.flags.notADiamond = !anyAnswered && !allUnroutedOnDiamond;
  }
  const { notADiamond } = ledger.flags;

  // The routing boundary (#2095 r26): every gate and every payload read below
  // asks it, and it records each selector's answer in the ledger exactly once.
  // A selector is routed when the Diamond answers it with anything but its own
  // FunctionDoesNotExist — a return, a validation revert, IntentNoCommit. Used
  // wherever the loupe cannot be asked (#2095 r23 P2): cuts are per selector.
  const zeroArgsFor = (item) => (item?.inputs ?? []).map(function z(i) {
    if (i.type === 'tuple') return Object.fromEntries((i.components ?? []).map((c) => [c.name, z(c)]));
    if (/\[\]$/.test(i.type)) return [];
    if (/^tuple\[\d+\]$/.test(i.type)) return [];
    if (/^u?int/.test(i.type)) return 0n;
    if (i.type === 'address') return ZERO_ADDRESS;
    if (i.type === 'bool') return false;
    if (/^bytes\d+$/.test(i.type)) return `0x${'00'.repeat(Number(i.type.slice(5)))}`;
    if (i.type === 'bytes') return '0x';
    if (i.type === 'string') return '';
    return 0n;
  });
  const selectorRoutedDirect = async (fn, args) => {
    try { await read(fn, args); return true; } catch (err) {
      if (isUnroutedOnDiamond(err)) return false;
      rethrowUnlessRevert(err);
      return true; // any other revert is the facet answering
    }
  };
  // facetAddress(bytes4) is its own selector (#2095 r24/r25 P2): cuts are per
  // selector, so a Diamond may route facetAddresses() and not facetAddress()
  let facetAddressRouted = false;
  if (loupeRouted) {
    try { await read('facetAddress', [toFunctionSelector(metrics.find((e) => e.name === 'getProtocolStats'))]); facetAddressRouted = true; } catch (err) { if (!isUnroutedOnDiamond(err)) rethrowUnlessRevert(err); }
    ledger.surfaces.facetAddress = facetAddressRouted ? 'routed' : 'unrouted';
  }
  const routedByLoupeOrProbe = async (fn, abiList, args) => {
    const item = abiList.find((e) => e.name === fn);
    const routed = facetAddressRouted ? (await read('facetAddress', [toFunctionSelector(item)])) !== ZERO_ADDRESS : await selectorRoutedDirect(fn, args ?? zeroArgsFor(item));
    ledger.surfaces[fn] = routed ? 'routed' : 'unrouted';
    return routed;
  };
  const { selectorRouted, readRouted } = makeRoutingBoundary(routedByLoupeOrProbe, read);
  // The loupe enumeration the provenance reads use, through the same boundary;
  // an unrouted facets() is a failed loupe read there, recorded with its reason.
  const readFacetsThroughBoundary = async () => {
    const list = await readRouted('facets', loupe, []);
    if (list === UNROUTED) throw new Error('facets() is not routed on this Diamond (facetAddresses() is — cuts are per selector)');
    return list;
  };

  // VPFI SCOPE — the token is resolved ON-CHAIN first (`getVPFIToken`, the
  // Diamond's own answer) and from the artifact ONLY when that selector is
  // CONFIRMED unrouted or answers no token (Codex r8 P1: `setVPFIToken` permits
  // rotations, so the artifact can lag the live token; a swallowed failure
  // that fell back to it would read the OLD token). Every operational failure
  // propagates. A non-Diamond reverts EMPTY here too and has no token to
  // resolve, so it is not asked; a bare shell is asked like any Diamond and
  // records the getter unrouted (C5: a shell is a ledger whose surfaces all
  // answer unrouted, not a separate path). Where the token came from is
  // recorded, because only an on-chain token can scope a row (Codex #2070 r22
  // P1) — the judge decides what that permits.
  if (!notADiamond) {
    const onChain = await readRouted('getVPFIToken', vpfiView, []);
    if (onChain !== UNROUTED && onChain && onChain !== ZERO_ADDRESS) ledger.scope = { vpfiToken: onChain, source: 'on-chain' };
  }
  if (!ledger.scope.vpfiToken && (addresses.vpfiToken || addresses.vpfiMirror)) {
    ledger.scope = { vpfiToken: addresses.vpfiToken ?? addresses.vpfiMirror, source: 'artifact' };
  }
  // VPFI BACKING — recorded, never a proof (Codex #2070 r6 P1: a zero balance
  // proves rows UNBACKED, not absent; zero VPFI with live rows is the WORST
  // case for slice 0). The figure the shortfall is computed against.
  if (ledger.scope.vpfiToken) {
    const token = ledger.scope.vpfiToken;
    const balance = await withReplicaRetry(atBlock, () => callAtHash(client, censusBlock, { address: token, abi: [ERC20_BALANCE_OF], functionName: 'balanceOf', args: [diamond] }), { client });
    ledger.backing = { token, balance };
  }
  if (notADiamond) {
    // Its rows, if any, are not this protocol's, and every read below would
    // decode another contract's storage as ours: nothing further is read.
    ledger.range.storageUnavailable = 'not read: the contract at the recorded address is not a Vaipakam Diamond';
    return { readFacets: null };
  }

  // ── The ONE storage read (C4–C6) ───────────────────────────────────────
  // The loan counter's slot never moved, so storage gives the loan-id range
  // (1..nextLoanId) whatever the Diamond routes; every class is then read at
  // every era's slot over that range, HEAD's slot included (#2095 r4 P1: a
  // routed getter reads the layout of the facet that was cut, not necessarily
  // HEAD's, so its rows are reconciled, never assumed covered). Raw readings
  // only: the HEAD/earlier split, aliasing and every bound are the judge's.
  let rangeIds = [];
  if (STORAGE_READ.ok) {
    const readSlot = (slot) => withReplicaRetry(atBlock, () => storageAtHash(client, censusBlock, diamond, slot), { client });
    const counters = await readCountersByStorage({ readSlot, eraSlots: STORAGE_READ.eraSlots });
    const cap = BigInt(MAX_STORAGE_LOAN_SCAN);
    const n = counters.nextLoanId > cap ? cap : counters.nextLoanId;
    rangeIds = Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));
    const scan = await scanRowsByStorage({ readSlot, loanIds: rangeIds, eraSlots: STORAGE_READ.eraSlots, classes: CLASSES });
    // A counter reading is what was READ: the slot and its value. Which eras a
    // slot stands for is the era table's answer, and the judge maps it from
    // the table it is handed — a copy taken here would be a second slot→era
    // mapping, frozen at read time, that an offline re-judgement against a
    // regenerated table would have to disagree with.
    const raw = (list) => list.map(({ slot, value }) => ({ slot, value }));
    ledger.range.storage = {
      nextLoanId: counters.nextLoanId,
      truncatedAt: counters.nextLoanId > n ? Number(n) : null,
      counters: { totalLoansEverCreated: raw(counters.totalLoansEverCreated), intentLiveCommitCount: raw(counters.intentLiveCommitCount) },
      read: { ...structuredClone(STORAGE_READ.evidence), slotsRead: counters.slotsRead + scan.slotsRead, loansScanned: scan.loansScanned, slotsScanned: { ...counters.slotsScanned, ...scan.slotsScanned } },
    };
    for (const cls of CLASSES) {
      for (const r of scan.rows[cls]) {
        // the amount storage reads for the class (an intent row's orderHash is
        // not an amount — that row's amount is unread, hence null)
        const amount = r[LIABILITY_CLASS_FIELDS[cls]];
        const extra = cls === 'fallbackSnapshotCustody' ? { active: r.active } : cls === 'liveIntentCommits' ? { orderHash: r.orderHash } : null;
        observe(ledger, { class: cls, loanId: r.loanId, amount: amount === undefined ? null : BigInt(amount), assetAddr: null, source: 'storage', slot: r.mappingSlot, ...(extra ? { extra } : {}) });
      }
    }
    process.stderr.write(`census: ${who} — storage read: nextLoanId=${counters.nextLoanId}, ${scan.loansScanned} id(s) × ${Object.values(scan.slotsScanned).reduce((a, s) => a + s.length, 0)} era slot(s), ${ledger.range.storage.read.slotsRead} slot(s), ${ledger.observations.length} row candidate(s)${ledger.range.storage.truncatedAt !== null ? `; TRUNCATED at ${MAX_STORAGE_LOAN_SCAN}` : ''}\n`);
  } else {
    ledger.range.storageUnavailable = STORAGE_READ.reason;
  }

  // ── The routed range witness (S1-R9: the ONLY reads `enumerable` gates) ──
  // Enumeration needs BOTH the stats and the pagination selector (#2095 r23
  // P2). What it returns is a WITNESS of the storage range, never the range:
  // a partially refreshed metrics facet may skip an older loan (#2095 r17 P1).
  const statsRouted = await selectorRouted('getProtocolStats', metrics, []);
  const pageRouted = statsRouted && await selectorRouted('getAllLoansPaginated', metrics, [0n, 1n]);
  if (statsRouted && !pageRouted) process.stderr.write(`census: ${who} — getProtocolStats routed but getAllLoansPaginated is not; no routed range witness\n`);
  if (statsRouted && pageRouted) {
    const stats = await read('getProtocolStats');
    const totalLoansEverCreated = stats[3];
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
    // The routed surface contradicting ITSELF is not a witness of anything
    // (design §5615): the deployment is a recorded failure, its partial ledger
    // attached.
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
    ledger.range.routed = { totalLoansEverCreated, enumeratedIds: idRangeOf(loanIds), reportedTotal };
  }

  // ── The intent surface ────────────────────────────────────────────────
  // Codex #2070 P1 — an unrouted GETTER is not proof of absence: the PRODUCER
  // (`commitSwapToRepayIntent`) has its own selector, and a facet cut in, used
  // and cut out leaves rows no getter can see (the storage read above reads
  // them). With the loupe unrouted both are probed directly (#2095 r23 P2).
  const intentSurfaceRouted = await selectorRouted('getIntentCommit', intentView, [1n]);
  const producerRouted = await selectorRouted('commitSwapToRepayIntent', intentProducer);
  if (!intentSurfaceRouted) {
    // REFUTATION ONLY (Codex #2070 r5 P1): the cut history can show the
    // producer WAS routed, or that the history is incomplete; an omitted
    // Add/Remove pair is invisible to any test over eth_getLogs, so it never
    // certifies. Without facets() there is no continuity yardstick (#2095
    // r24/r26 P2), and that is an UNREADABLE history, not a thrown failure.
    const producerSelector = toFunctionSelector(intentProducer.find((e) => e.name === 'commitSwapToRepayIntent'));
    const unreadableSurface = (why) =>
      producerRouted
        ? { refuted: true, verdict: 'refuted', reason: 'the intent producer answers a direct probe now — rows may exist' }
        : { refuted: false, verdict: 'unreadable', reason: why };
    const cutHistory = loupeRouted
      ? await (async () => {
          const facetList = await readRouted('facets', loupe, []);
          if (facetList === UNROUTED) return unreadableSurface('the current surface cannot be enumerated (facets() is not routed), so the routing history has no continuity yardstick');
          const routedSelectors = facetList.flatMap((f) => f.functionSelectors ?? f[1] ?? []);
          return refuteProducerNeverRouted({ client, diamond, fromBlock: BigInt(addresses.deployBlock ?? 0), toBlock: atBlock, producerSelector, producerRouted, routedSelectors });
        })()
      : unreadableSurface('the loupe is unrouted, so the current surface cannot be enumerated and the routing history has no continuity yardstick');
    ledger.refutations = { cutHistory };
  }

  // ── The custody getters, over the STORAGE range (C6, S1-R9) ─────────────
  // Each is probed whatever the metrics surface says (cuts are per selector,
  // #2095 r25 P2) and, where routed, asked for EVERY id in 1..nextLoanId — so
  // a HEAD-slot row a stale metrics facet cannot enumerate is still asked of
  // the getter, and reconciled by the judge. Getters are plain mapping reads
  // on any id; vehicle loans included.
  const rebateGetterRouted = await selectorRouted('getBorrowerLifRebate', claim, [1n]);
  const snapshotGetterRouted = await selectorRouted('getFallbackSnapshot', claim, [1n]);
  // C6 coverage is RECORDED, not restated: each getter's entry is the ids that
  // getter actually answered in this loop, so a loop over anything but the
  // storage range (the routed enumeration, a subset) leaves the record short
  // and the judge's getter-coverage names it. Writing the range here instead
  // would discharge coverage by a copy of the range whatever the loop asked.
  const askedOf = { getBorrowerLifRebate: [], getFallbackSnapshot: [], getIntentCommit: [] };
  for (const id of rangeIds) {
    const loanId = id.toString();
    if (rebateGetterRouted) {
      const [rebateAmount, vpfiHeld] = await read('getBorrowerLifRebate', [id]);
      askedOf.getBorrowerLifRebate.push(id);
      if (vpfiHeld > 0n) observe(ledger, { class: 'vpfiHeldCustody', loanId, amount: vpfiHeld, assetAddr: null, source: 'routed-getter' });
      if (rebateAmount > 0n) observe(ledger, { class: 'rebateRows', loanId, amount: rebateAmount, assetAddr: null, source: 'routed-getter' });
    }
    if (snapshotGetterRouted) {
      const [lenderCollateral, treasuryCollateral, borrowerCollateral, lenderPrincipalDue, treasuryPrincipalDue, active] = await read('getFallbackSnapshot', [id]);
      askedOf.getFallbackSnapshot.push(id);
      const custody = lenderCollateral + treasuryCollateral + borrowerCollateral;
      if (active || custody > 0n) {
        // The snapshot carries amounts, not the asset — the LOAN names it, and
        // `getLoanDetails` is its own selector (#2095 r26 P2): unrouted, the
        // row keeps its amount with no asset, and the judge files it unknown.
        const loan = await readRouted('getLoanDetails', loanView, [id]);
        const asset = loan === UNROUTED ? null : `${loan.collateralAsset ?? loan[0]?.collateralAsset ?? ''}` || null;
        observe(ledger, { class: 'fallbackSnapshotCustody', loanId, amount: custody, assetAddr: asset, assetSource: 'getLoanDetails', source: 'routed-getter', extra: { active, lenderPrincipalDue, treasuryPrincipalDue } });
      }
    }
    // Class 3 — live intent commit, read from state. The view reverts
    // `IntentNoCommit` exactly when `commit.orderHash == 0`, and both teardown
    // paths delete the struct — so that revert IS the absence of a row. Any
    // other revert is a real failure and must not be read as "no commit".
    if (intentSurfaceRouted) {
      try {
        const order = await read('getIntentCommit', [id]);
        observe(ledger, { class: 'liveIntentCommits', loanId, amount: order.makerAmount, assetAddr: `${order.makerAsset}`, assetSource: 'getIntentCommit.makerAsset', source: 'routed-getter', extra: { maker: order.maker, deadline: order.deadline } });
      } catch (err) {
        if (!isNoCommitRevert(err)) throw err;
      }
      askedOf.getIntentCommit.push(id); // answered: a commit, or IntentNoCommit
    }
  }
  for (const [getter, routed] of [['getBorrowerLifRebate', rebateGetterRouted], ['getFallbackSnapshot', snapshotGetterRouted], ['getIntentCommit', intentSurfaceRouted]]) {
    if (routed) ledger.idsAskedOfGetter[getter] = askedOf[getter].length ? idRangeOf(askedOf[getter]) : '';
  }

  // OPTIONAL corroboration (`--corroborate`) — an independent reconstruction
  // of class 3 from the event lifecycle, pairing commit → teardown by
  // `(loanId, orderHash)`. Recorded raw; the judge compares it with every
  // intent the view observed (S1-R4). Its failure is a note, never a verdict:
  // a pruned node cannot refute live state. With no id in range there is no
  // loan a commit could key, so the walk from deploy to head is skipped.
  if (WANT_CORROBORATION && rangeIds.length && intentSurfaceRouted) {
    try {
      const logs = await getLogsChunked(client, { address: diamond, events: intentEvents, fromBlock: BigInt(addresses.deployBlock ?? 0), toBlock: atBlock });
      const live = new Map(); // `${loanId}:${orderHash}` -> makerAmount
      for (const log of logs) {
        const { loanId, orderHash, makerAmount } = log.args ?? {};
        if (loanId === undefined || orderHash === undefined) continue;
        const key = `${loanId}:${orderHash}`;
        if (log.eventName === 'SwapToRepayIntentCommitted') live.set(key, makerAmount ?? 0n);
        else live.delete(key); // Filled / Cancelled / ForceCancelled all tear the commit down
      }
      ledger.corroboration = { source: 'event-lifecycle', logsSeen: logs.length, liveLoanIdsFromLogs: [...live.keys()].map((k) => k.split(':')[0]).sort() };
    } catch (err) {
      ledger.corroboration = {
        source: 'event-lifecycle',
        unavailable: `${classifyRpcError(err)}: ${(err?.details ?? err?.shortMessage ?? err?.message ?? '').toString().split('\n')[0].slice(0, 180)}`,
      };
    }
  }
  return { readFacets: loupeRouted ? readFacetsThroughBoundary : null };
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
    if (!readableResult(r, 'the committed snapshot')) continue;
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
  if (hasFlag('--write-archive-manifest')) {
    const m = writeArchiveManifest();
    process.stdout.write(`archive manifest written: ${ARCHIVE_MANIFEST} (${m.entries.length} archived deployments)\n`);
    return;
  }
  const which = arg('--chain', 'all');
  const everything = deployedDiamonds();
  const deployments = which === 'all' ? everything : everything.filter((d) => d.slug === which);
  if (which !== 'all' && deployments.length === 0) throw new Error(`no deployment directory for chain '${which}'`);
  const outDir = arg('--out', join(REPO, 'docs/DesignsAndPlans/census'));
  // The snapshot this run will replace (r24 P2): the canonical for a full run,
  // the chain's partial file for a --chain run. Its heights join the floor,
  // and ancestry is proven against ITS blocks.
  const targetPath = which === 'all' ? join(outDir, 'grandfathered-custody-census.json') : join(outDir, `grandfathered-custody-census.partial-${which}.json`);
  if (hasFlag('--rejudge')) return rejudge({ everything, deployments, outDir, sourcePath: arg('--rejudge-from', targetPath) });

  loadPriorCommittedHeights(join(outDir, 'grandfathered-custody-census.json'));
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
  // asked for — but the chain is not read twice: the later entry re-judges the
  // earlier LEDGER under its own label and says whose reads they are.
  const byAddress = new Map(); // reuse key -> the frozen ledger it was read into
  // Codex #2070 r8 P1 — a chain reads at ONE block identity, full stop. When a
  // later deployment forces the `safe` downgrade, every result already
  // collected for that chain was read at the OLD finalized height, and a row
  // created on one of those Diamonds between the two heights would be absent
  // from every result while present at the report's effective state. The
  // downgrade DISCARDS that chain's results and reruns the whole chain at
  // `safe` — the queue is a worklist so a slug can be re-queued.
  const queue = [...deployments];
  while (queue.length) {
    const dep = queue.shift();
    const who = `${dep.slug} (${dep.label})`;
    // Codex #2070 r16 P1 — reads are reused across artifacts naming the same
    // Diamond ONLY when their scoping metadata is identical. Where the token
    // getter is unrouted the artifact's VPFI token is what scopes rows, so two
    // config snapshots straddling a token rotation would file a live row as
    // non-VPFI under the first token and copy that to the second. Same Diamond,
    // different artifact token ⇒ its own scan.
    // #2095 r20 P1 — layout provenance is per record: two records of one
    // Diamond differ in the facets they name (the in-place-refresh case) and in
    // their deploy time, so reads are reused only when those match too
    const addrKey = [dep.slug, String(dep.addresses.diamond || '').toLowerCase(), recordScopeToken(dep), recordDeployedAt(dep), recordFacetsKey(dep)].join('|');
    const prior = byAddress.get(addrKey);
    process.stderr.write(prior
      ? `census: ${who} — same Diamond, scoping metadata AND facet population as "${prior.identity.deployment}"; re-judging those reads under this label\n`
      : `census: ${who} …\n`);
    try {
      const verdict = await censusDeployment(dep, prior ?? null);
      // the census's ONE results.push: only a branded verdict reaches the artifact
      results.push(publish(verdict));
      if (!prior) byAddress.set(addrKey, verdict.ledger);
    } catch (err) {
      // A lagging replica that outlasted the rotated retries: cap the chain's
      // height at that replica's head (still finalized) and restart the chain
      // there, before the generic pruned → safe downgrade is even considered.
      const laggingHead = laggingReplicaHeight(err);
      const cappedAt =
        laggingHead !== null
          ? await capChainAtLaggingHead(createPublicClient({ transport: http(rpcFor(dep.slug), { fetchFn: fetchViaNodeAgents }) }), dep.slug, who, laggingHead).catch(() => null)
          : null;
      const restartReason = cappedAt
        ? `state reads kept landing on a replica at ${laggingHead}; re-resolving ${dep.slug} at that height (${cappedAt.tag})`
        : classifyRpcError(err) === 'pruned' && downgradeChainToSafe(dep.slug)
          ? `finalized state pruned by the endpoint; re-resolving ${dep.slug} at 'safe'`
          : null;
      if (restartReason) {
        // Restart THIS CHAIN from scratch at the new block. Codex #2070 r12 P2 —
        // a restart re-reads EVERY deployment on the chain, so a failure
        // recorded for one of them at the old height is stale too: left in
        // place it would report a recovered chain as failed.
        const dropped = results.filter((r) => r.chainSlug === dep.slug).length;
        for (let i = results.length - 1; i >= 0; i--) if (results[i].chainSlug === dep.slug) results.splice(i, 1);
        for (const k of [...byAddress.keys()]) if (k.startsWith(`${dep.slug}|`)) byAddress.delete(k);
        const staleFailures = failures.filter((f) => f.chainSlug === dep.slug).length;
        for (let i = failures.length - 1; i >= 0; i--) if (failures[i].chainSlug === dep.slug) failures.splice(i, 1);
        const chainDeps = deployments.filter((d) => d.slug === dep.slug);
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].slug === dep.slug) queue.splice(i, 1);
        queue.unshift(...chainDeps);
        process.stderr.write(`census: ${who} — ${restartReason} and RESTARTING the chain (discarding ${dropped} result(s) and ${staleFailures} recorded failure(s))\n`);
        continue;
      }
      // §3.3 — what WAS read rides with the failure: evidence of how far the
      // census got, never judged (a failure is outside the per-class model)
      failures.push({ chainSlug: dep.slug, deployment: dep.label, error: err.message, partialLedger: err.partialLedger ?? null });
      process.stderr.write(`census: ${who} FAILED — ${err.message}\n`);
    }
  }
  return reportAndPublish({ results, failures, everything, outDir, proofStandard: PROOF_STANDARD });
}

/**
 * `--rejudge` (S3-4) — re-derive every verdict of the committed artifact from
 * the evidence ledger it carries, with the checkout's rule and era table, and
 * republish through the SAME guarded publication a live run uses. No RPC when
 * the source is the artifact it replaces: the results keep their blocks, so
 * the ancestry check is the equal-height case. A `--rejudge-from` pair whose
 * blocks sit above that snapshot (the pair a size refusal saved) makes the
 * ancestry check walk the chain through its endpoint, and an unverified walk
 * refuses it.
 *
 * A rule change or a regenerated era table therefore no longer costs an
 * archive-node rerun — except where the reads cannot answer the table it is
 * judged with: the table names a slot the original reads never covered, or
 * the reads took no storage read on a Diamond with code because the table was
 * unusable at collection, so their coverage cannot be computed at all. The
 * judge fails `era-coverage` by name and marks the rerun owed
 * (`scanned.eraCoverage.rerunOwed`), and this stops (exit 2) WITHOUT
 * publishing; `--rejudge-allow-coverage-gaps` publishes anyway, with those
 * classes indeterminate as the judge states them.
 *
 * It stops the same way when the reads no longer describe the INVENTORY: a
 * record corrected since the run (its Diamond, chain, deploy block, token,
 * deploy time or facet list), removed, or added. Each ledger names the record
 * it was read for (`identity.inventoryKey`); re-judging reads of a record that
 * has since changed would re-certify its label against a Diamond or a facet
 * population the inventory no longer names. The publication's own inventory
 * re-check cannot see this — it compares two snapshots that are both taken
 * after the reads.
 *
 * The source is the artifact the run would replace, or `--rejudge-from PATH`:
 * the pair a publication refused for size saved (see `refuseOversized`).
 */
export async function rejudge({ everything, deployments, outDir, sourcePath }) {
  let artifact;
  try {
    artifact = loadCensusArtifact(sourcePath);
  } catch (err) {
    throw new Error(`--rejudge: ${sourcePath} cannot be re-derived — ${err.message}`);
  }
  const schema = Number(artifact?.schema ?? 1);
  if (!(schema >= LEDGER_SCHEMA)) {
    throw new Error(
      `--rejudge: ${sourcePath} is schema ${schema}, which predates the evidence ledger (schema ${LEDGER_SCHEMA}) — its results record verdicts, ` +
        `not the reads they came from, so there is nothing to re-derive; a full census run is owed`,
    );
  }
  // without a table every class would come out unread: that is a broken
  // checkout, not a verdict, and it must not replace the committed one
  if (!STORAGE_READ.ok) throw new Error(`--rejudge: the era table cannot be used (${STORAGE_READ.reason}); fix the checkout's tables before re-judging`);
  const ledgerless = (artifact.results ?? []).filter((r) => !r?.ledger).map((r) => `${r?.chainSlug}/${r?.deployment}`);
  if (ledgerless.length) throw new Error(`--rejudge: ${sourcePath} has result(s) without an evidence ledger (${ledgerless.join(', ')}); refusing to republish verdicts it cannot re-derive`);
  const drift = rejudgeInventoryDrift({ results: artifact.results, failures: artifact.chainsFailed ?? [], records: deployments });
  if (drift.length) {
    process.stderr.write(
      `census --rejudge: the committed reads no longer describe the deployment inventory — a rerun is owed, nothing was published:\n` +
        drift.map((d) => `  ${d}\n`).join(''),
    );
    process.exitCode = 2;
    return;
  }
  // the standard the operator names, else the one the artifact was judged under
  const proofStandard = arg('--proof-standard') !== undefined ? PROOF_STANDARD : (artifact.proofStandard ?? PROOF_STANDARD);
  const results = artifact.results.map((r) => publish(verdictFromEvidence(reviveLedger(r.ledger), { proofStandard, storageRead: STORAGE_READ })));
  // The judge decides when a rerun is owed (`scanned.eraCoverage.rerunOwed`):
  // the era table names a slot the reads never covered, or no storage read was
  // taken on a Diamond with code because the table was unusable at collection,
  // so coverage cannot be computed at all. This only collects its answers. A
  // no-code or non-Diamond address has nothing more to read, and owes nothing.
  const gaps = results.filter((v) => v.scanned?.eraCoverage?.rerunOwed).map((v) => `${v.chainSlug} [${v.deployment}]: ${v.scanned.eraCoverage.rerunOwedBecause}`);
  if (gaps.length && !hasFlag('--rejudge-allow-coverage-gaps')) {
    process.stderr.write(
      `census --rejudge: the committed reads do not cover what the era table names — a rerun is owed, nothing was published:\n` +
        gaps.map((g) => `  ${g}\n`).join('') +
        `(pass --rejudge-allow-coverage-gaps to publish those classes indeterminate)\n`,
    );
    process.exitCode = 2;
    return;
  }
  return reportAndPublish({ results, failures: artifact.chainsFailed ?? [], everything, outDir, proofStandard, rejudgedFrom: artifact.generatedAt ?? null });
}

/**
 * Every way committed reads no longer describe the records `--rejudge` would
 * publish them for: a result whose record was corrected or removed since its
 * reads were taken (by `inventoryKeyOf`, the key its ledger recorded at
 * collection), a result whose ledger names no record, and a record of the
 * re-judged scope the run never read. Pure; one line per drift, empty when
 * the reads still describe every record.
 */
export function rejudgeInventoryDrift({ results, failures = [], records }) {
  const now = new Map(records.map((d) => [`${d.slug}|${d.label}`, inventoryKeyOf(d)]));
  const out = [];
  const read = new Set(failures.map((f) => `${f?.chainSlug}|${f?.deployment}`));
  for (const r of results ?? []) {
    const id = r?.ledger?.identity ?? {};
    const k = `${id.chainSlug}|${id.deployment}`;
    read.add(k);
    if (typeof id.inventoryKey !== 'string') out.push(`${k}: its ledger names no inventory record, so whether its reads describe the record as it stands cannot be checked`);
    else if (!now.has(k)) out.push(`${k}: the record is no longer in the inventory`);
    else if (now.get(k) !== id.inventoryKey) out.push(`${k}: the record was corrected after its reads were taken (read for ${id.inventoryKey}; now ${now.get(k)})`);
  }
  for (const k of now.keys()) if (!read.has(k)) out.push(`${k}: in the inventory, but the committed run never read it`);
  return out;
}

/**
 * The cron-slot gate's scan cap (`MAX_SCAN_BYTES`, .github/scripts/check-cron-slots.mjs):
 * a tracked text file above it fails that gate. Every census file is checked
 * against it on the bytes about to be written, never on an estimate: the
 * schema-2 artifact with its ledgers inline measured 2.11 MB at the committed
 * population in review, with the verdict shape it was first measured with
 * (past the cap), which is why they moved to a sidecar; with today's shape the
 * same census inline is about 1.72 MB (see `artifactTexts`). T-E reads the
 * gate's own constant and requires this one to equal it.
 */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

/** On disk a bigint is its decimal string; the judge reads either alike, so nothing converts it back. */
const bigintAsDecimal = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
const sha256Of = (text) => createHash('sha256').update(text).digest('hex');
/**
 * A ledger's content address: the sha256 of its compact JSON. Parsing that
 * JSON and writing it compactly again reproduces it byte for byte (bigints are
 * decimal strings by then; key order survives the round trip), so a reader
 * re-derives the address from what it parsed, and an edited ledger cannot keep it.
 */
const ledgerAddressOf = (ledger) => sha256Of(JSON.stringify(ledger, bigintAsDecimal));
/** The ledger sidecar beside an artifact: `x.json` → `x.ledgers.json`. */
const ledgersPathOf = (artifactPath) => artifactPath.replace(/\.json$/, '.ledgers.json');

/**
 * The one place a census becomes text: two files. The verdicts stay in the
 * artifact, indented, where a diff reads them. Every evidence ledger — each
 * result's, and each failure's partial ledger — goes to the sidecar, one
 * compact line per ledger keyed by its content address, and the artifact names
 * each by that address. Measured at run 31's committed scale (2,330 facets
 * over twenty deployments) by T-E's committed-scale cell, which runs this
 * writer on every test run: the artifact is about 0.42 MB and the sidecar
 * about 0.84 MB, each under the cap with room for the inventory to grow; the
 * same census inline is about 1.72 MB in one file (2.11 MB with the verdict
 * shape it was first measured with). Returns `{ [path]: text }` for both.
 */
export function artifactTexts(report, outFile) {
  const ledgers = new Map();
  const addressOf = (ledger) => {
    if (ledger === null || ledger === undefined) return null;
    const text = JSON.stringify(ledger, bigintAsDecimal);
    const address = sha256Of(text);
    ledgers.set(address, text); // one line per distinct ledger
    return address;
  };
  const results = report.results.map(({ ledger, ...verdict }) => ({ ...verdict, ledgerSha256: addressOf(ledger) }));
  const chainsFailed = (report.chainsFailed ?? []).map(({ partialLedger, ...failure }) => ({ ...failure, partialLedgerSha256: addressOf(partialLedger) }));
  const lines = [...ledgers].map(([address, text]) => `    ${JSON.stringify(address)}: ${text}`);
  const purpose = `The evidence ledgers of ${basename(outFile)}, one per line, each keyed by the sha256 of its compact JSON — the address the artifact names it by. Written with the artifact by census-grandfathered-custody.mjs; never hand-edit.`;
  return {
    [outFile]: `${JSON.stringify({ ...report, chainsFailed, results }, bigintAsDecimal, 2)}\n`,
    [ledgersPathOf(outFile)]: `{\n  "schema": ${LEDGER_SCHEMA},\n  "purpose": ${JSON.stringify(purpose)},\n  "ledgers": {${lines.length ? `\n${lines.join(',\n')}\n  ` : ''}}\n}\n`,
  };
}

/**
 * Read a census artifact with every evidence ledger joined back in from its
 * sidecar — the one reader of the published pair (`--rejudge`, and the
 * artifact self-verification, read through it). Each join is content-checked:
 * a ledger must hash to the address its row names, so an edit to either file,
 * or a pair assembled from two runs, is refused rather than re-judged. An
 * artifact that names no ledger by address is returned as read (run 31's
 * predates the ledger).
 */
export function loadCensusArtifact(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const named = [...(report.results ?? []).map((row) => [row, 'ledger']), ...(report.chainsFailed ?? []).map((row) => [row, 'partialLedger'])]
    .filter(([row, key]) => row !== null && typeof row === 'object' && Object.hasOwn(row, `${key}Sha256`));
  if (!named.length) return report;
  const file = report.ledgers?.file;
  if (typeof file !== 'string' || basename(file) !== file) throw new Error(`${path} names its ledgers by address but no sidecar beside it (ledgers.file ${JSON.stringify(file ?? null)})`);
  const sidecarPath = join(dirname(path), file);
  let held;
  try {
    held = JSON.parse(readFileSync(sidecarPath, 'utf8')).ledgers;
  } catch (err) {
    throw new Error(`${sidecarPath}, the ledger sidecar ${path} names, cannot be read (${err.message})`);
  }
  if (held === null || typeof held !== 'object') throw new Error(`${sidecarPath} carries no ledgers map`);
  for (const [row, key] of named) {
    const address = row[`${key}Sha256`];
    delete row[`${key}Sha256`];
    if (address === null) { row[key] = null; continue; }
    const ledger = typeof address === 'string' && /^[0-9a-f]{64}$/.test(address) && Object.hasOwn(held, address) ? held[address] : undefined;
    if (ledger === undefined || ledgerAddressOf(ledger) !== address) {
      throw new Error(
        `${sidecarPath} does not hold the ledger ${path} names for ${row.chainSlug}/${row.deployment} (${address})` +
          `${ledger === undefined ? '' : ' — the one under that address was edited after it was written'}; restore the pair from one commit`,
      );
    }
    row[key] = ledger;
  }
  return report;
}

/**
 * Refuse a publication any of whose files would cross the cron-slot cap —
 * committed, it would fail that gate. The reads are not lost with it: the
 * pair is saved to a temporary directory, from which `--rejudge
 * --rejudge-from` can republish it once the census fits again, re-reading no
 * Diamond. It is not a guaranteed offline path: the ancestry evidence this run
 * gathered is not saved, so wherever the saved results sit above the snapshot
 * they would replace (a live run's usual case), publication first walks that
 * chain's block ancestry again through its endpoint (`ensureAncestryFor`), and
 * the regression guard refuses it if the walk cannot verify the descent —
 * a re-run of the census is the path then.
 */
function refuseOversized(texts, outFile) {
  const over = Object.entries(texts).filter(([, text]) => Buffer.byteLength(text) > MAX_ARTIFACT_BYTES);
  if (!over.length) return;
  const kept = mkdtempSync(join(tmpdir(), 'census-oversized-'));
  for (const [p, text] of Object.entries(texts)) writeFileSync(join(kept, basename(p)), text);
  throw new Error(
    `refusing to publish ${outFile}: ${over.map(([p, text]) => `${basename(p)} would be ${Buffer.byteLength(text)} bytes`).join('; ')}, above the ` +
      `${MAX_ARTIFACT_BYTES}-byte cap the cron-slot gate reads tracked files at. Nothing was published. This run's results and ledgers are saved in ` +
      `${kept}. Once the census fits, --rejudge --rejudge-from ${join(kept, basename(outFile))} republishes them without re-reading any Diamond — ` +
      `but this run's ancestry evidence is not saved: where they sit above the snapshot they would replace, publication walks that chain's block ` +
      `ancestry again through its endpoint, and the regression guard refuses it if the walk cannot verify the descent; re-run the census then`,
  );
}

/**
 * The report a run publishes, built from its verdicts — pure. The aggregates
 * are the judge's (`reportVerdict`); everything else here is bookkeeping about
 * which deployments the run covered. Shared by a live run, `--rejudge` and the
 * committed-scale size test, so the bytes the size cap is checked on in that
 * test are assembled exactly as a publication assembles them.
 *
 * A partial run names its OWN file: the canonical artifact is the programme's
 * evidence for every deployed chain, and a single-chain follow-up overwriting
 * it would destroy that evidence to publish a narrower claim.
 */
export function censusReport({ results, failures, allDeployed, proofStandard, eraTableIdentity, rejudgedFrom = null, buildCandidates = null, generatedAt = new Date().toISOString() }) {
  const covered = new Set(results.map((r) => `${r.chainSlug}|${r.deployment}`));
  const aggregates = reportVerdict(results, { allDeployed, failures, proofStandard });
  const fileName =
    aggregates.scope === 'all-deployed-chains'
      ? 'grandfathered-custody-census.json'
      : `grandfathered-custody-census.partial-${[...new Set(results.map((r) => r.chainSlug))].join('-') || 'none'}.json`;
  const report = {
    generatedAt,
    purpose: '#1566 grandfathered-custody census — decides whether slices 0-3 are live work or a certified no-op',
    schema: LEDGER_SCHEMA,
    proofStandard,
    verdictRule: aggregates.verdictRule,
    eraTableIdentity,
    ledgers: { file: basename(ledgersPathOf(fileName)) },
    ...(rejudgedFrom ? { rejudgedFrom } : {}),
    scope: aggregates.scope,
    allClassesEmpty: aggregates.allClassesEmpty,
    deploymentsDeployed: allDeployed,
    deploymentsCensused: results.length,
    chainsFailed: failures,
    deploymentsNotCensused: allDeployed.filter((k) => !covered.has(k)),
    indeterminateClasses: aggregates.indeterminateClasses,
    results,
    migrationRetirable: aggregates.migrationRetirable,
    migrationRetirableReason: aggregates.migrationRetirableReason,
    ...(buildCandidates ? { buildCandidates } : {}),
  };
  return { fileName, report };
}

/**
 * The report phase, shared by a live run and `--rejudge`: the report is built
 * from the published verdicts (`censusReport`), and the artifact is written
 * through the same guarded publication either way.
 */
async function reportAndPublish({ results, failures, everything, outDir, proofStandard, rejudgedFrom = null }) {
  const allDeployed = everything.map((d) => `${d.slug}|${d.label}`);
  const candidates = proposeBuildCandidates(results);
  const { fileName, report } = censusReport({
    results,
    failures,
    allDeployed,
    proofStandard,
    eraTableIdentity: STORAGE_READ.evidence?.eraTableIdentity ?? null,
    rejudgedFrom,
    buildCandidates: candidates.length ? { proposed: candidates.length, newInFile: plannedBuildCandidates(candidates), file: 'contracts/deployments/facet-build-candidates.json' } : null,
  });
  const outFile = join(outDir, fileName);
  const indeterminate = report.indeterminateClasses ?? [];
  mkdirSync(outDir, { recursive: true });
  // the size is checked on the bytes, before anything is locked or written
  refuseOversized(artifactTexts(report, outFile), outFile);
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
    // (#2095 r14 P1: the facet population and deploy time are in the key — a
    // record corrected on either while this run was reading would otherwise
    // pass on an identical key)
    const scannedInv = new Set(everything.map(inventoryKeyOf)); // the FULL snapshot taken at start — a --chain run scans a subset of it
    const generationAtStart = LIVE_GENERATION_SEEN;
    const nowInv = new Set(deployedDiamondsUnderLock().map(inventoryKeyOf));
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
    writeSnapshotGuarded(outFile, () => {
      // produced AFTER the regression check, which may record identityChanges,
      // so the size is checked again on exactly the bytes written
      const texts = artifactTexts(report, outFile);
      refuseOversized(texts, outFile);
      // The sidecar is replaced inside the artifact's lock, after the
      // artifact's regression check (its only regression: the artifact names
      // every ledger by content address) and before the artifact is renamed
      // in. A fault between the two renames leaves the old artifact naming
      // ledgers the new sidecar no longer holds — which the loader refuses by
      // name, never re-judges.
      writeSnapshotGuarded(ledgersPathOf(outFile), texts[ledgersPathOf(outFile)], { regressedBy: () => null });
      return texts[outFile];
    }, {
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
    // Reached only once every publication guard has passed and the artifact
    // is renamed in (each refusal above throws): the build-candidate request
    // describes an artifact that was kept, never one that was refused.
    recordBuildCandidates(candidates);
  });

  for (const r of results) {
    const c = r.classes;
    process.stdout.write(
      // #2095 r27 — a withdrawn shortfall is SAID, not left blank: silence
      // here reads exactly like the "no shortfall" a zero would report.
      `${r.chainSlug} [${r.deployment}] (chainId ${r.chainId}, block ${r.atBlock}, backing ${r.diamondVpfiBacking ?? '?'} VPFI wei${r.backingShortfall && r.backingShortfall !== '0' ? `, SHORTFALL ${r.backingShortfall}` : r.backingShortfallUnavailable ? ', SHORTFALL unknown' : ''}): ` +
        `loans=${r.scanned?.loanIdsEnumerated ?? '?'} ` +
        `vpfiHeld=${c.vpfiHeldCustody.count} rebate=${c.rebateRows.count} ` +
        `fallback=${c.fallbackSnapshotCustody.count} liveIntents=${c.liveIntentCommits.count}\n`,
    );
  }
  process.stdout.write(`\nartifact: ${outFile}\n`);
  if (indeterminate.length) {
    process.stdout.write('\nINDETERMINATE (not evidence of absence):\n');
    // the report's index names the failed obligations; their detail is on the class in the artifact
    for (const i of indeterminate) process.stdout.write(`  ${i.chainSlug} [${i.deployment}]/${i.class}: ${i.obligations.join(', ')}\n`);
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
    'regenerate the era table (node scripts/storage-layout-eras.mjs --reuse contracts/deployments/storage-slot-eras.json) so they are catalogued, then re-judge with --rejudge ' +
    '(no RPC when re-judging the artifact it replaces; a rerun is owed only where it reports an era-coverage gap)\n',
  );

  // A partial run has not established the programme's claim, so it must not
  // exit 0 as though it had.
  if (failures.length || indeterminate.length || report.allClassesEmpty === null) {
    process.exitCode = 1;
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  // The command line is checked BEFORE main(): an unknown flag must stop the
  // run before the inventory is read or any endpoint is called.
  const cli = parseCliFlags(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(usage());
  } else if (cli.problems.length) {
    process.stderr.write(`census: ${cli.problems.join('; ')} — nothing was read or written\n\n${usage()}`);
    process.exitCode = 2;
  } else {
    main().catch((err) => {
      process.stderr.write(`census: ${err.stack || err.message}\n`);
      process.exitCode = 1;
    });
  }
}
