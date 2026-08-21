/**
 * WATCH-ONLY live observation of the borrower position page (#1505 /
 * #1511 post-deploy review).
 *
 * Why this exists separately from `driver.mjs`: every other live driver
 * needs `TESTNET_WALLETS_FILE` because it signs. The read-side half of a
 * live review — does the deployed build render the real chain's state
 * for a real position without crashing — needs no key at all, and
 * requiring one meant that half went unrun whenever the funded-wallet
 * secret was unavailable. That is precisely the review that would have
 * caught the defect this drive was written for.
 *
 * It injects a WATCH-ONLY EIP-1193 provider over an address it does not
 * hold: account reads answer with that address, every other RPC forwards
 * to the chain, and every signing / sending method throws. There is no
 * private key in the process, so the guarantee is structural rather than
 * a flag that could be passed wrong — this drive CANNOT move funds or
 * touch state belonging to the observed address.
 *
 * What it checks, against the live Base Sepolia Diamond:
 *   1. `/positions` and each observed `/positions/<id>` render with NO
 *      uncaught error — in particular no hooks-order crash, the #1511
 *      defect (a `useCallback` below the page's early returns) that
 *      survived fourteen review rounds, typecheck, the production build
 *      and a green preview deploy because none of those can see it.
 *   2. The chooser for the observed ROLE renders on a real active loan:
 *      the #1505 "Ways to repay or exit early" card naming the handover
 *      and offset paths, or — with OBSERVE_ROLE=lender — the #1839 "Your
 *      options as the lender" card naming all three of its options with
 *      the wait row FIRST, which is the one ordering claim it makes.
 *   3. Whether the #1511 listing-hold card is present, and if so which
 *      state it reports — informational, since a hold only exists while
 *      some lender actually has a sale listing standing.
 *
 * Page traffic is served from THIS process via node fetch, the same shim
 * `driver.mjs` uses: the sandbox egress gateway resets Chromium's own
 * TLS handshakes.
 *
 * Usage (no secrets needed):
 *
 *   node live-position-observe.mjs                  # auto-discovers a borrower
 *   OBSERVE_ROLE=lender node live-position-observe.mjs   # the lender card
 *   OBSERVE_ADDRESS=0x… node live-position-observe.mjs
 *   SITE_URL=https://<preview>.workers.dev node live-position-observe.mjs
 *   LIVE_PROXY_SETUP=./my-egress-shim.mjs node live-position-observe.mjs
 *
 * Exit codes — a batch run must never read a drive that verified nothing
 * as a pass:
 *   0  observed and clean
 *   1  a REGRESSION, judged against a page we actually observed: a route
 *      crashed or returned non-2xx, the chooser (or one of its two new
 *      paths) is missing from an eligible loan, or the PAGE tried to sign
 *      / send / POST something a read-only surface should never ask for
 *   2  BLOCKED — could not observe, or could not trust what it observed.
 *      No eligible loans; the requested address holds none; a discovery
 *      or setup step failed (unreachable RPC, browser launch); every
 *      candidate's chain state moved before it could be visited; a
 *      misconfigured OBSERVE_MAX_POSITIONS would assert nothing; or our
 *      own allowlist refused a read the app needed, which may have left a
 *      degraded page. Nothing trustworthy was verified, so this is
 *      deliberately not 0: `run-live-batch.mjs` would otherwise print
 *      PASS for a drive that made no trustworthy assertions at all.
 *
 * The 1-vs-2 line is the important one: exit 1 must always mean "the app
 * did something wrong", never "the harness could not look properly".
 */
// Sandbox egress shim (proxy CA + undici dispatcher) — optional, and the
// SAME knob `driver.mjs` and `live-desk-i18n-capture.mjs` honour. Without
// it this drive documented a setting it never read, so in a sandbox whose
// gateway resets TLS every routed page request and every viem read failed
// with no indication the shim had been ignored (#1529 review round 11).
if (process.env.LIVE_PROXY_SETUP) {
  await import(process.env.LIVE_PROXY_SETUP);
}
// Capture AFTER the shim, exactly as driver.mjs does: node's built-in
// fetch is what both the page-route pump and viem's http transport ride.
const ufetch = globalThis.fetch;
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  numberToHex,
} from 'viem';
import { redactUrl } from './redact.mjs';
import {
  EXECUTION_REVERTED,
  REVERT_BYTES,
  callsTargetContract,
  classifyRpcFailure,
  codedError,
  recordRpcResponse,
  rpcCallsFromBody,
  rpcRequestCalls,
  summariseRpcLedger,
} from './rpc-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The SAME contracts source the app ships with, read from disk exactly
// as live-signed-book.mjs / live-rate-desk.mjs do, so this driver cannot
// drift from the app's own address/ABI source. (Reading the files beats
// importing the package here: the barrel is TS re-exporting JSON, which
// plain node refuses without import attributes.)
const CONTRACTS_SRC = path.resolve(HERE, '../../../../packages/contracts/src');

function loadDiamondAbi() {
  const dir = path.join(CONTRACTS_SRC, 'abis');
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(parsed)) out.push(...parsed);
  }
  return out;
}

const SITE = process.env.SITE_URL ?? 'https://alpha02.vaipakam.com';
const CHAIN_ID = Number(process.env.OBSERVE_CHAIN_ID ?? 84532);
const RPC = process.env.OBSERVE_RPC ?? 'https://sepolia.base.org';
// A limit of 0 (or a typo) would visit no detail route at all: the
// `/positions` list can pass on its own, and the run would exit 0 having
// asserted nothing about the chooser — the exact no-verification-passes
// outcome the exit contract exists to prevent (#1529 review round 7).
const MAX_POSITIONS_RAW = process.env.OBSERVE_MAX_POSITIONS ?? '3';
const MAX_POSITIONS = Number(MAX_POSITIONS_RAW);
if (!Number.isInteger(MAX_POSITIONS) || MAX_POSITIONS < 1) {
  console.error(
    `\nBLOCKED: OBSERVE_MAX_POSITIONS must be a positive integer,` +
      ` got "${MAX_POSITIONS_RAW}". A limit below 1 would assert nothing.`,
  );
  process.exit(2);
}

/**
 * WHICH chooser to observe. Both are awareness cards on the SAME page,
 * gated on which side of the loan the connected wallet holds, so one
 * harness covers both and the only differences are the eligibility
 * predicate and the string asserted.
 *
 *   borrower  (default) — the #1505 "Ways to repay or exit early" card
 *   lender              — the #1839 "Your options as the lender" card
 *
 * Defaulting to `borrower` keeps every existing invocation, including
 * `run-live-batch.mjs`, doing exactly what it did before.
 */
const ROLE = process.env.OBSERVE_ROLE ?? 'borrower';
if (ROLE !== 'borrower' && ROLE !== 'lender') {
  console.error(
    `\nBLOCKED: OBSERVE_ROLE must be "borrower" or "lender", got "${ROLE}".` +
      ` An unrecognised role would assert nothing.`,
  );
  process.exit(2);
}
/** The card this run is here to see, and the copy that identifies it. */
const CHOOSER = ROLE === 'lender'
  ? { what: 'lender exit chooser (#1839)', title: /Your options as the lender/i }
  : { what: 'repay/exit chooser (#1505)', title: /Ways to repay or exit early/i };

// A mistyped OBSERVE_CHAIN_ID, or one this repo has no deployment for,
// is a SETUP precondition — the same category as an absent wallet file
// or an unreachable RPC. Throwing here exits 1, and the batch runner
// then prints a product FAIL for a configuration mistake that stopped
// the drive from observing anything at all, which is exactly the
// mislabelling the three-verdict contract exists to prevent (#1529
// review round 12).
let deployment;
try {
  deployment = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
  )[String(CHAIN_ID)];
} catch (err) {
  console.error(
    `\nBLOCKED: cannot read the deployments artifact.\n  ${err.message}`,
  );
  process.exit(2);
}
if (!deployment?.diamond) {
  const known = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
  );
  console.error(
    `\nBLOCKED: no deployment for chain ${CHAIN_ID} in deployments.json.` +
      `\n  known chains: ${Object.keys(known).join(', ')}` +
      `\n  → set OBSERVE_CHAIN_ID to one of those, or re-export` +
      ` deployments (contracts/script/exportFrontendDeployments.sh).`,
  );
  process.exit(2);
}
const DIAMOND = deployment.diamond;
const DIAMOND_ABI_VIEM = loadDiamondAbi();

/**
 * ALLOWLIST, deliberately — not a list of banned writes.
 *
 * A denylist cannot carry a safety property: it has to enumerate every
 * way to send, and the set keeps growing (`wallet_sendCalls`,
 * `eth_sendUserOperation`, provider-specific sends, app-specific JSON-RPC
 * mutations). One that is merely forgotten is forwarded (#1529 review).
 * So this names the read and connection methods the drive actually needs
 * and refuses everything else, which makes an omission a false REFUSAL —
 * visible in the report and easy to fix — rather than a silent send.
 *
 * Every refusal is recorded, printed AND ends the run non-zero. Printing
 * alone was not enough: the app can catch a refused read and render a
 * degraded page that still contains the chooser, so the drive would have
 * reported clean while observing something less than the real surface
 * (#1529 review round 5). See the exit-code contract at the top.
 */
const ALLOWED_RPC = new Set([
  // Reads. eth_call and eth_estimateGas change no state.
  'eth_accounts',
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'net_version',
  'web3_clientVersion',
  // Subscriptions (WebSocket reads).
  'eth_subscribe',
  'eth_unsubscribe',
  // Connection handshake — answered locally, never forwarded.
  'eth_requestAccounts',
  'wallet_getPermissions',
  'wallet_requestPermissions',
  'wallet_switchEthereumChain',
]);

/** Severity classification ONLY — never a permission decision. What is
 *  permitted is decided solely by ALLOWED_RPC, so a write method nobody
 *  anticipated is still refused; it would merely be reported as an
 *  allowlist gap rather than a violation. */
const WRITE_SHAPED = /^(eth_send|eth_sign|personal_sign|wallet_send)/;

const pub = createPublicClient({ transport: http(RPC) });

/** Origin of the configured RPC, or null if `OBSERVE_RPC` is unparseable.
 *  Declared before `redactUrl` because that is where it is load-bearing. */
const RPC_ORIGIN = (() => {
  try {
    return new URL(RPC).origin;
  } catch {
    return null;
  }
})();

/**
 * A URL safe to PRINT. `OBSERVE_RPC` is routinely an authenticated
 * provider endpoint — Alchemy and Infura carry the key as a path
 * segment, Blast and Chainstack as a hyphenated UUID, others via basic
 * auth or a query parameter — and the live-review workflow says to paste
 * a drive's output into the PR thread. Printing the URL verbatim
 * therefore publishes the credential and hands over the account's quota
 * (#1529 review round 19; the key-shape bypasses, round 20).
 *
 * Implementation and rationale live in `redact.mjs`, where they are
 * unit-tested — see `redact.test.mjs`.
 */
const redact = (raw) => redactUrl(raw, RPC_ORIGIN);

/** The RPC's identity for logs: origin only. Which provider is being
 *  used is all an operator needs from a status line, and it cannot leak
 *  a key held in the path, the query or basic auth. */
const rpcLabel = RPC_ORIGIN ?? '(invalid OBSERVE_RPC)';

// ---------------------------------------------------------------- chain
console.log(`site      ${SITE}`);
console.log(`chain     ${CHAIN_ID} via ${rpcLabel}`);
console.log(`diamond   ${DIAMOND}`);

/**
 * Discovery and setup failures are BLOCKED, never FAIL.
 *
 * Exit 1 is reserved for assertions against pages we successfully
 * observed. An unreachable or flaky RPC during discovery means we never
 * got as far as observing anything — but an uncaught top-level rejection
 * exits 1 regardless, so the batch would report a product regression for
 * a network blip (#1529 review round 7).
 */
/**
 * Set as soon as the browser exists, so a BLOCKED exit taken after the
 * launch does not leave a Chromium process behind. `discovery()` is the
 * only route to that exit, which is why the cleanup lives there rather
 * than at each call site.
 */
let liveBrowser = null;

async function discovery(what, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `\nBLOCKED: ${what} failed, so nothing could be observed.` +
        `\n  ${String(err).split('\n')[0].slice(0, 200)}`,
    );
    try {
      await liveBrowser?.close();
    } catch {
      /* exiting anyway — a close failure must not mask the real cause */
    }
    process.exit(2);
  }
}

// The RPC has to BE the chain we say we are reviewing. The injected
// provider answers `eth_chainId` locally from CHAIN_ID, so nothing else
// checks OUR client: an OBSERVE_RPC pointed at a different supported
// network is consistent end to end. With a Diamond at the same address
// there (deterministic deploys make that ordinary, not exotic), the drive
// exits 0 having reviewed a chain nobody asked about, and the report names
// the one they did (#1529 review round 17).
//
// This covers the discovery client ONLY. The page's own reads go to the
// RPC the deployed bundle was BUILT with, not to this one — `pageRpcChain`
// probes those separately and the verdict block asserts them too.
const servedChainId = await discovery('reading the RPC chain id', () =>
  pub.getChainId(),
);
if (servedChainId !== CHAIN_ID) {
  console.error(
    `\nBLOCKED: OBSERVE_RPC serves chain ${servedChainId}, not the` +
      ` requested ${CHAIN_ID}.` +
      `\n  → point OBSERVE_RPC at chain ${CHAIN_ID}, or set` +
      ` OBSERVE_CHAIN_ID to ${servedChainId}.`,
  );
  process.exit(2);
}

// One height for the whole discovery walk — see the pagination note.
const snapshotBlock = await discovery('reading the chain head', () =>
  pub.getBlockNumber(),
);
const activeCount = await discovery('reading the active-loan count', () =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getActiveLoansCount',
    blockNumber: snapshotBlock,
  }),
);
console.log(`active    ${activeCount} loan(s) on chain`);
if (activeCount === 0n) {
  console.log('\nBLOCKED: no active loans on chain — nothing to observe, nothing verified.');
  process.exit(2);
}

// Walk the WHOLE set, a page at a time. The underlying list is a
// swap-and-pop array, so it is not ordered by eligibility — a first-page
// cap would miss the only eligible loan (or the requested address's) on a
// busy chain and then report BLOCKED, claiming none exists (#1529 review).
// PINNED to one block. The list is swap-and-pop, so a loan settling
// between page reads moves the former LAST id down into an offset already
// fetched — and the walk, continuing from the next offset against a stale
// count, never sees it. If that moved loan was the only eligible one the
// drive would report BLOCKED with an observable position still on chain
// (#1529 review round 9). Reading every page at a fixed height makes the
// walk a consistent snapshot instead of a moving target.
const PAGE = 25n;
const ids = [];
for (let offset = 0n; offset < activeCount; offset += PAGE) {
  const remaining = activeCount - offset;
  const page = await discovery(`reading active loans from offset ${offset}`, () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getActiveLoansPaginated',
      args: [offset, remaining < PAGE ? remaining : PAGE],
      blockNumber: snapshotBlock,
    }),
  );
  if (page.length === 0) break;
  ids.push(...page);
}
console.log(`fetched   ${ids.length} loan id(s) across ${Math.ceil(Number(activeCount) / 25)} page(s)`);

// LoanStatus.Active — `getActiveLoansPaginated` also returns
// FallbackPending (4), and AssetType.ERC20 — an NFT-rental row is not a
// lending position. The chooser renders for neither, so a candidate that
// is either would be a FALSE "chooser MISSING" rather than a finding
// (#1529 review).
const STATUS_ACTIVE = 0;
/**
 * LoanStatus.FallbackPending. The lender card mounts on it DELIBERATELY
 * (`PositionDetails.tsx`: `row.status === 'active' || 'fallback_pending'`,
 * and the live-status exclusion admits it too) — round 10 of #1839 added
 * copy telling a lender that a fallback-settling loan blocks both sales
 * and that waiting still applies, and a strict Active gate made that copy
 * reachable only while the indexer lagged.
 *
 * So an Active-only drive races out a candidate whose card is rendering
 * a state the card was specifically built to explain — and if those are
 * the only lender positions on chain, reports BLOCKED on a working
 * surface (Codex #1853 r1).
 */
const STATUS_FALLBACK_PENDING = 4;
const ASSET_ERC20 = 0;
/** The statuses the LENDER card mounts on; the borrower card takes Active only. */
const lenderStatusOk = (st) => st === STATUS_ACTIVE || st === STATUS_FALLBACK_PENDING;

/**
 * The page's own sanctions gate, mirrored: `!(sanctions.ready &&
 * sanctions.flagged)` suppresses the lender card entirely for a flagged
 * wallet. That is CORRECT behaviour, so a flagged authority left in the
 * pool buys a 45-second wait and then a fabricated "chooser MISSING"
 * product regression (Codex #1853 r1).
 *
 * Fails OPEN on a read error, exactly as `useSanctionsCheck` does —
 * mirroring the app matters more here than picking a safer default,
 * because the point is to predict what the page will do. On the retail
 * deploy the oracle is commonly unset, in which case the contract
 * returns false for every address and this costs one cheap read.
 */
async function sanctionedAuthority(addr) {
  try {
    return await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isSanctionedAddress',
      args: [addr],
    });
  } catch {
    return false;
  }
}
/** LibERC721.LockReason.PrecloseOffset — mirrors data/offsetPending.ts. */
const LOCK_PRECLOSE_OFFSET = 1;

/**
 * The chooser's render gate has FOUR conditions, not two
 * (`PositionDetails.tsx`): active, not a rental, no live preclose-offset
 * lock, and grace not verifiably over. The last two are just as capable
 * of hiding it CORRECTLY, so a drive that checks only the first two calls
 * valid deployed behaviour a regression (#1529 review round 6).
 *
 * Both follow the app's own reads: the offset lock from
 * `positionLock(borrowerTokenId)`, the grace deadline from
 * `getGraceBuckets` matched on the loan's duration and falling back to
 * the compile-time schedule when the chain publishes no buckets.
 *
 * That fallback is load-bearing, not defensive: Base Sepolia publishes
 * an EMPTY bucket set today. A first draft returned zero grace there,
 * which made every matured loan read as past-grace and skipped all eight
 * loans on the chain — the drive reported BLOCKED while the pages it
 * would have checked were rendering perfectly well. Mirror the app's
 * `readGraceSecondsLive` branch for branch; do not simplify it.
 */
/** Mirrors `lib/grace.defaultGraceSeconds`, which in turn mirrors
 *  LibVaipakam.gracePeriod's compile-time schedule. Used when the chain
 *  publishes NO buckets — which is the case on Base Sepolia today, so
 *  this is the live path, not a corner. Treating an empty set as zero
 *  grace makes every matured loan look past-grace the instant it
 *  matures, which is how a first draft of this drive managed to skip
 *  every loan on the chain. */
function defaultGraceSeconds(durationDays) {
  if (durationDays < 7n) return 3_600n;
  if (durationDays < 30n) return 86_400n;
  if (durationDays < 90n) return 3n * 86_400n;
  if (durationDays < 180n) return 7n * 86_400n;
  if (durationDays < 365n) return 14n * 86_400n;
  return 30n * 86_400n;
}

let graceBucketsCache;
/** Drop the memo so the next {@link graceSecondsFor} re-reads the chain.
 *
 *  The cache is right for a discovery sweep — one schedule, one pass over
 *  the loan set. It is wrong at revalidation, whose entire contract is
 *  "is this still true RIGHT NOW": every other input there is re-read
 *  live, and an admin `setGraceBuckets` between discovery and the visit
 *  would leave this one input minutes stale. The page reads the new
 *  schedule on load, so a shortened window has the chooser correctly
 *  hidden while the driver still demands it and exits 1 — a config change
 *  reported as a product regression (#1529 review round 17). */
function invalidateGraceBuckets() {
  graceBucketsCache = undefined;
}
async function graceSecondsFor(durationDays) {
  graceBucketsCache ??= await discovery('reading the grace buckets', () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getGraceBuckets',
    }),
  );
  const buckets = graceBucketsCache;
  if (buckets.length > 0) {
    for (const b of buckets) {
      if (b.maxDurationDays === 0n) return b.graceSeconds; // catch-all
      if (durationDays < b.maxDurationDays) return b.graceSeconds;
    }
    // Malformed set — the contract falls back to the last entry.
    return buckets[buckets.length - 1].graceSeconds;
  }
  return defaultGraceSeconds(durationDays);
}

/**
 * A revert is the chain ANSWERING; a transport failure is the absence of
 * an answer. The two must not collapse into the same value.
 *
 * Both chain-read helpers below used to catch everything and return a
 * domain verdict, which meant an unreachable RPC was indistinguishable
 * from a burned token or a locked position. `discovery()` never saw the
 * rejection, so the candidate was filed as "raced out" and the drive
 * could exit 0 — reporting a clean live review it had not performed
 * (#1529 review round 14). Only a revert is an answer; everything else
 * propagates to `discovery()` and reads BLOCKED.
 *
 * The error CLASS alone cannot decide this, which is the trap round 15
 * caught. viem's `getContractError` wraps BOTH an EVM revert and a plain
 * JSON-RPC internal error in `ContractFunctionRevertedError`:
 *
 *   [EXECUTION_REVERTED_ERROR_CODE, InternalRpcError.code].includes(code)
 *     && (data || details || message || shortMessage)
 *
 * `InternalRpcError.code` is -32603 — the generic code a provider returns
 * for an upstream outage or an overloaded backend. So an `instanceof`
 * test calls a dead backend a revert, and the drive is right back to
 * reporting a locked position or a burned token for a chain that never
 * answered.
 *
 * Verified against both a live revert and a -32603 responder:
 *
 *   REAL REVERT  isRevertClass=true  code=3       raw=0x7e273289…
 *   RPC -32603   isRevertClass=true  code=-32603  raw=undefined
 *
 * Hence POSITIVE evidence is required, in either of the two forms a
 * genuine revert can take:
 *
 *   - returned revert BYTES, which are conclusive whatever code the
 *     provider labelled them with — some return real reverts under
 *     -32603; and
 *   - failing that, the EVM's own `execution reverted` code 3, which
 *     covers a bare `revert()` that returns no data at all.
 *
 * A -32603 carrying neither is a transport failure and propagates. The
 * asymmetry is deliberate: misjudging a revert as a failure costs one
 * false BLOCKED, which is loud and harmless, while misjudging a failure
 * as a revert costs a false PASS on a review that never happened.
 *
 * `raw` must be VALIDATED, not merely present — the round-16 trap. viem
 * copies `error.data` through verbatim, and providers put arbitrary
 * diagnostics there on an outage. Observed against fake responders:
 *
 *   -32603 data="upstream timeout"  ->  raw = "upstream timeout"
 *   -32603 data="0x"                ->  raw = "0x"
 *
 * An existence check accepts both and we are back to calling a dead
 * backend a revert. Real revert bytes are `0x` followed by a non-empty,
 * even-length run of hex. An empty `0x` is not evidence either way — a
 * bare revert produces it, but so does a provider filling the field with
 * nothing — so it falls through to the code-3 test, which answers that
 * case correctly.
 */
// `EXECUTION_REVERTED` / `REVERT_BYTES` come from `rpc-verdict.mjs`, so
// the two places that ask "did the EVM answer" cannot drift apart.
//
// This one stays a two-way predicate on purpose. It judges OUR OWN
// discovery reads, where the app-vs-infrastructure distinction
// `classifyRpcFailure` draws has no meaning: a malformed request here
// would be a defect in THIS driver, and "the drive could not observe" is
// the honest verdict for that too. Only page traffic can implicate the
// product.
function isRevert(err) {
  const reverted = err?.walk?.((e) => e instanceof ContractFunctionRevertedError);
  if (!reverted) return false;
  if (typeof reverted.raw === 'string' && REVERT_BYTES.test(reverted.raw)) return true;
  return codedError(err)?.code === EXECUTION_REVERTED;
}

async function offsetLockedOn(borrowerTokenId) {
  try {
    const lock = await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'positionLock',
      args: [borrowerTokenId],
    });
    return Number(lock) === LOCK_PRECLOSE_OFFSET;
  } catch (err) {
    if (!isRevert(err)) throw err; // no answer — BLOCKED, not a skip
    // Reverted — assume locked and skip the loan. Skipping costs one
    // observation; a false regression costs trust in the whole drive.
    return true;
  }
}

/**
 * Who may act on the borrower side. NOT `loan.borrower`: role and action
 * authority travel with the borrower POSITION NFT, and `PositionDetails`
 * decides the role from `ownerOf(borrowerTokenId)` — so once a position
 * has been transferred, the stored address is history and the page
 * correctly classifies it as a viewer. Grouping by the stored address
 * would inject exactly such a wallet and then report the resulting
 * absent chooser as a regression (#1529 review).
 *
 * Falls back to the stored address only when the token read reverts —
 * i.e. the token is gone — which the eligibility filter then drops
 * anyway. A transport failure is NOT that: see `isRevert`.
 */
async function borrowerAuthorityOf(loan) {
  return tokenOwnerOf(loan.borrowerTokenId);
}

/**
 * The LENDER-side authority, resolved the same way and for the same
 * reason: `PositionDetails` decides who sees the lender card from
 * `ownerOf(lenderTokenId)`, never from `loan.lender`. Those diverge the
 * moment a position is sold or transferred — which is precisely the
 * population this card was built for — so keying a drive on `loan.lender`
 * would observe the wrong wallet on exactly the interesting loans.
 */
async function lenderAuthorityOf(loan) {
  return tokenOwnerOf(loan.lenderTokenId);
}

/** Shared: a revert means burned/never-minted; anything else is BLOCKED. */
async function tokenOwnerOf(tokenId) {
  try {
    return await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'ownerOf',
      args: [tokenId],
    });
  } catch (err) {
    if (!isRevert(err)) throw err; // no answer — BLOCKED, not "burned"
    return null;
  }
}

// Chain time, not the local clock — the grace comparison the app makes is
// chain-anchored, and a skewed sandbox clock would misclassify loans near
// the boundary.
const chainNow = await discovery('reading chain time', () =>
  pub.getBlock({ blockTag: 'latest' }).then((b) => b.timestamp),
);

const loans = [];
for (const id of ids) {
  const d = await discovery(`reading loan ${id}`, () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getLoanDetails',
      args: [id],
    }),
  );
  const loan = {
    id,
    borrower: d.borrower,
    lender: d.lender,
    status: Number(d.status),
    assetType: Number(d.assetType),
    borrowerTokenId: d.borrowerTokenId,
    lenderTokenId: d.lenderTokenId,
    startTime: d.startTime,
    durationDays: d.durationDays,
  };
  // Wrapped, because these two now propagate transport failures rather
  // than swallowing them: unwrapped, such a rejection would reach the top
  // level and exit 1 as a product regression — the round-7 bug, reached
  // by a new route.
  loan.authority = await discovery(
    `reading the ${ROLE} authority for loan ${id}`,
    () => (ROLE === 'lender' ? lenderAuthorityOf(loan) : borrowerAuthorityOf(loan)),
  );
  // Only worth the extra reads on loans that clear the cheap gates, and
  // ONLY for the borrower card: the offset lock and the grace deadline
  // are gates on the borrower chooser. The lender card is deliberately
  // insensitive to both — a borrower's pending offset does not hide a
  // lender's options (it explains one of them), and past maturity the
  // lender card stays up saying the sale rows are closed, because
  // waiting still applies. Reading them for a lender run would be two
  // wasted RPCs per loan and, worse, would tempt a future edit to gate
  // on them.
  // Only for loans that clear the cheap gates, and only for the lender
  // run — the borrower chooser has no sanctions gate.
  if (ROLE === 'lender' && lenderStatusOk(loan.status) && loan.authority) {
    loan.authoritySanctioned = await discovery(
      `reading the sanctions status of ${loan.authority}`,
      () => sanctionedAuthority(loan.authority),
    );
  }
  if (
    ROLE === 'borrower' &&
    loan.status === STATUS_ACTIVE &&
    loan.assetType === ASSET_ERC20 &&
    loan.authority
  ) {
    loan.offsetLocked = await discovery(`reading the offset lock for loan ${id}`, () =>
      offsetLockedOn(loan.borrowerTokenId),
    );
    const grace = await graceSecondsFor(loan.durationDays);
    const graceDeadline = loan.startTime + loan.durationDays * 86_400n + grace;
    loan.graceOver = chainNow > graceDeadline;
  }
  loans.push(loan);
}

/**
 * Exactly the predicate `PositionDetails` gates the chosen card on — and
 * the two cards do NOT share one.
 *
 * The borrower chooser has four conditions (active, not a rental, no live
 * preclose-offset lock, grace not verifiably over). The lender card has
 * two: an active non-rental loan whose lender token resolves to the
 * connected wallet. It deliberately survives states that hide the
 * borrower's card, because its FIRST row is "wait", which stays true when
 * every exit is shut — past maturity it keeps rendering and says the sale
 * rows are closed rather than vanishing.
 *
 * Using the borrower's four gates for a lender run would silently narrow
 * the candidate pool to loans where BOTH cards happen to render, and then
 * report BLOCKED on a chain where the lender card is rendering perfectly
 * well on loans it had discarded.
 */
const eligible = loans.filter((l) =>
  ROLE === 'lender'
    ? lenderStatusOk(l.status) &&
      l.assetType === ASSET_ERC20 &&
      l.authority !== null &&
      l.authoritySanctioned === false
    : l.status === STATUS_ACTIVE &&
      l.assetType === ASSET_ERC20 &&
      l.authority !== null &&
      l.offsetLocked === false &&
      l.graceOver === false,
);
const dropped = loans.length - eligible.length;
if (dropped > 0) {
  // Never silently narrow the candidate set — say what was set aside, and
  // why, so a shrinking pool is legible rather than mysterious.
  const why = (l) =>
    (ROLE === 'lender' ? !lenderStatusOk(l.status) : l.status !== STATUS_ACTIVE)
      ? 'not active'
      : l.assetType !== ASSET_ERC20
        ? 'NFT rental'
        : l.authority === null
          ? `${ROLE} token burned`
          : l.authoritySanctioned
            ? 'holder sanctions-flagged (card correctly suppressed)'
            : l.offsetLocked
              ? 'offset in progress'
              : 'past grace';
  console.log(
    `skipping  ${dropped} loan(s) the chooser does not render for: ` +
      loans
        .filter((l) => !eligible.includes(l))
        .map((l) => `${l.id} (${why(l)})`)
        .join(', '),
  );
}

// The observed address: whichever authority on the CHOSEN side holds the
// most eligible loans, so one session covers as many position pages as
// possible.
let observed = process.env.OBSERVE_ADDRESS;
if (!observed) {
  const byAuthority = new Map();
  for (const l of eligible) {
    const k = l.authority.toLowerCase();
    byAuthority.set(k, [...(byAuthority.get(k) ?? []), l]);
  }
  const [best] = [...byAuthority.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!best) {
    console.log(
      `\nBLOCKED: no ${ROLE}-eligible loans on chain — nothing verified.`,
    );
    process.exit(2);
  }
  observed = best[1][0].authority;
}
const mine = eligible.filter((l) => l.authority.toLowerCase() === observed.toLowerCase());
console.log(
  `observing ${observed} (watch-only, no key) — ${mine.length} eligible loan(s) as ${ROLE}`,
);
console.log(`asserting ${CHOOSER.what}`);
for (const l of mine) {
  // Compared against the ORIGINATING party on the chosen side, so
  // "transferred" means what it says for either card. Reported because a
  // moved position is the population the lender card was built for, and a
  // run that covered only never-transferred loans has not exercised the
  // interesting half.
  const origin = ROLE === 'lender' ? l.lender : l.borrower;
  const moved = l.authority.toLowerCase() !== origin.toLowerCase();
  console.log(`  loan ${l.id}${moved ? ` (position transferred from ${origin})` : ''}`);
}
if (mine.length === 0) {
  console.error(
    `\nBLOCKED: ${observed} holds no eligible ${ROLE} position — nothing verified.`,
  );
  process.exit(2);
}

// -------------------------------------------------------------- browser
const browser = await discovery('launching the browser', () =>
  chromium.launch({
    headless: process.env.OBSERVE_HEADED !== '1',
    args: ['--no-sandbox'],
    ...(process.env.LIVE_CHROMIUM_PATH ? { executablePath: process.env.LIVE_CHROMIUM_PATH } : {}),
  }),
);
liveBrowser = browser;

// Everything from here to the first navigation is SETUP, and a setup
// failure is the same verdict as a failed discovery read: the browser
// disconnected, the machine ran out of file descriptors, the context
// could not be built — no page was ever observed, so there is nothing to
// call a product defect. Left bare, these rejections reach the top level
// and Node exits 1, which `run-live-batch.mjs` reports as a FAIL from a
// driver that promises to distinguish the two (#1529 review round 21).
//
// Codex reported `newContext`; the other three are the same shape and
// were still bare.
const ctx = await discovery('creating the browser context', () =>
  browser.newContext({ viewport: { width: 1280, height: 1000 } }),
);

/** Every refusal, with why — a too-narrow allowlist must be visible. */
const refusedRpc = [];
const blockedHttp = [];

/**
 * The chain each RPC endpoint carrying the page's DEPLOYMENT reads
 * actually serves, probed once per endpoint.
 *
 * The `OBSERVE_RPC` check near the top of this file is not enough on its
 * own. It validates OUR client; the page's wagmi reads are neither
 * forwarded to it nor rewritten to it — the route handler fetches each
 * original `req.url()`, which is whatever RPC the deployed bundle was
 * built with. So a site pointed at the wrong chain passes that check, and
 * the surface it then fails to render gets blamed on the product; with
 * deterministic deploys putting a Diamond at the same address on both
 * chains it can even pass outright (#1529 review round 24).
 *
 * DEPLOYMENT reads specifically, because the page talks to two networks by
 * design: an explicit chain-1 transport backs ENS reverse lookups, and a
 * connected page fires one per counterparty. Round 24's version probed
 * every endpoint the page touched, so that ENS endpoint answered `1`,
 * mismatched CHAIN_ID and exited 2 — a healthy site reported as built for
 * the wrong network, on essentially every connected run (#1529 review
 * round 25). `callsTargetContract` picks out the endpoints carrying calls
 * addressed to the Diamond, which is what makes an endpoint the one under
 * review; see its note for why that is positive evidence rather than an
 * exclusion list.
 *
 * The residual, stated rather than papered over: a site built for another
 * chain whose Diamond ALSO sits at a different address there is not
 * attributed by this rule, so it is not chain-checked. That is the case
 * round 24 could not see either — the one it did fix, and the one that can
 * pass outright, is the deterministic-deploy shape where the address
 * matches.
 *
 * Fired in the background on first sighting so the probes overlap the
 * drive rather than serialising the route handler, and awaited once at
 * verdict time. `null` means "could not tell" — an endpoint may refuse a
 * synthetic probe — and only a DEFINITE mismatch is allowed to block,
 * keeping this loud-but-true rather than one more flaky exit.
 *
 * @type {Map<string, Promise<number|null>>}
 */
const pageRpcChain = new Map();
/**
 * A probe that never answers must not become a probe that never returns.
 * This promise is awaited unconditionally at verdict time, and
 * `run-live-batch.mjs` spawns the driver with no timeout of its own, so an
 * endpoint that serves the page normally but stalls on a synthetic POST —
 * or on its response body — would hold the whole live-review batch instead
 * of producing a verdict (#1529 review round 25). An expired probe settles
 * as `null`, the same "could not tell" every other unanswerable probe
 * produces.
 */
const CHAIN_PROBE_TIMEOUT_MS = 15_000;
function notePageRpcEndpoint(url, calls) {
  if (pageRpcChain.has(url) || !callsTargetContract(calls, DIAMOND)) return;
  pageRpcChain.set(
    url,
    (async () => {
      try {
        const r = await ufetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(CHAIN_PROBE_TIMEOUT_MS),
        });
        if (!r.ok) return null;
        const hex = (await r.json())?.result;
        return typeof hex === 'string' ? Number(BigInt(hex)) : null;
      } catch {
        // Unreachable, non-JSON, or timed out — none of them evidence of a
        // wrong chain.
        return null;
      }
    })(),
  );
}

/**
 * JSON-RPC the page sent over a WEBSOCKET, which this driver cannot judge.
 *
 * `ctx.route` intercepts HTTP only. When a deploy sets `VITE_*_WSS_URL`,
 * `wagmi.ts` wraps `webSocket(c.wsUrl)` ahead of the HTTP transport, and
 * every read that goes that way misses the allowlist, the response ledger
 * and the chain probe alike — the page can be served a wrong-chain or
 * half-answered result and this run would still exit 0 (#1529 review
 * round 25).
 *
 * Instrumenting WS frames with the full three-way classifier is a much
 * larger change to the thing under test; refusing to VOUCH for a run whose
 * RPC we could not see is the same move the allowlist makes, and it is the
 * honest one. So this records the bypass and the verdict block turns it
 * into BLOCKED.
 *
 * Gated on frames that are actually JSON-RPC REQUESTS, via the same shared
 * predicate the HTTP gate uses, for two reasons: a WalletConnect relay
 * socket carries plenty of traffic that says nothing about chain reads,
 * and a socket the sandbox resets before a single frame flows has bypassed
 * nothing — viem's `fallback` simply dropped to HTTP, where every check
 * above applies.
 *
 * @type {Set<string>}
 */
const wsRpcMethods = new Set();
function watchWebSockets(page) {
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => {
      for (const c of rpcCallsFromBody(payload) ?? []) wsRpcMethods.add(String(c.method));
    });
  });
}
/**
 * Page traffic this process could not fetch at all — the site, the RPC
 * endpoint or the sandbox proxy being briefly unreachable.
 *
 * Recorded rather than merely aborted, because of what the abort turns
 * into downstream: aborting the MAIN DOCUMENT surfaces as a navigation
 * error, and aborting an RPC call surfaces as a page that renders
 * without its chooser. Both then increment `failures` and exit 1 — the
 * verdict this driver reserves for an app regression it actually
 * observed. A flaky egress would be reported as a broken product
 * (#1529 review round 16).
 */
const routeFailures = [];
/**
 * Requests the PAGE sent that a reachable provider rejected as malformed.
 *
 * The opposite verdict to `routeFailures` despite arriving down the same
 * code path: the endpoint answered, so this is the app asking for
 * something invalid — a defect, judged as one (#1529 review round 21).
 */
const malformedRpc = [];

/**
 * Every per-call outcome the routed shim observed, in attempt order.
 *
 * Not the two buckets above, because one HTTP attempt cannot settle the
 * question: viem retries a failed read (`retryCount: 3`) and `wagmi.ts`
 * wraps these transports in `fallback([...])`, so a transient 429 the
 * page recovered from is indistinguishable, at this layer, from a dead
 * endpoint. `summariseRpcLedger` reconciles the attempts once the run is
 * over and fills the buckets then (#1529 review round 23).
 */
const rpcLedger = [];

// Page traffic through this process (Chromium TLS is reset by the
// sandbox gateway). Mutating non-RPC requests are refused: this drive
// advertises itself as read-only and a page regression must not be able
// to POST to a backend while we scrape.
const routeHandler = async (route) => {
  const req = route.request();
  const method = req.method().toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    // Default-deny: a mutating request rides through only when it is
    // JSON-RPC whose EVERY method is on the allowlist. Anything else —
    // a non-RPC POST, or RPC naming a method we did not sanction — is
    // refused and named.
    let why = `${method} (non-RPC mutating request)`;
    let badMethod = null;
    let allowed = false;
    const body = req.postData();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        // Validate the ENVELOPE before applying the allowlist. A body that
        // is JSON but not a well-formed JSON-RPC request is a defect in the
        // page, and `badMethod` stays null so it reports as one — an empty
        // batch used to satisfy the allowlist vacuously and ride through,
        // and a member with a non-string `method` used to be filed as a gap
        // in our own allowlist (#1529 review round 24).
        const calls = rpcRequestCalls(parsed);
        if (!calls) {
          why = `${method} (malformed json-rpc request)`;
        } else {
          const denied = calls
            .filter((c) => !ALLOWED_RPC.has(c.method))
            .map((c) => String(c.method));
          allowed = denied.length === 0;
          if (denied.length) {
            // A batch is judged by its WORST member, not its first. The
            // route already refuses the whole batch either way, but the
            // METHOD recorded here drives the verdict — and `find` kept
            // only the first, so a batch whose unallowlisted read
            // preceded an `eth_sendTransaction` was filed as an
            // allowlist gap (exit 2) and the page's attempted write, the
            // one thing this driver calls a product FAIL, never reached
            // the report (#1529 review round 17).
            badMethod = denied.find((m) => WRITE_SHAPED.test(m)) ?? denied[0];
            why = `json-rpc ${denied.join(', ')} (not allowlisted)`;
          }
        }
      } catch {
        /* not JSON — refuse with the default reason */
      }
    }
    if (!allowed) {
      // Keep the METHOD, not just a sentence: the exit-code decision
      // below applies the same write-vs-allowlist-gap split the injected
      // provider uses. Labelling every refused POST a mutation reported a
      // harness omission (e.g. an unlisted `eth_getProof`) as a product
      // FAIL (#1529 review round 7).
      // Redacted at the SOURCE, not at the print site. Round 19 justified
      // this as defence against a FUTURE report line; in fact the
      // READ-ONLY VIOLATION block below already prints these URLs, so it
      // is load-bearing right now.
      blockedHttp.push({ why, method: badMethod, url: redact(req.url()).slice(0, 120) });
      await route.abort('accessdenied').catch(() => {});
      return;
    }
  }
  try {
    const resp = await ufetch(req.url(), {
      method: req.method(),
      headers: Object.fromEntries(
        Object.entries(await req.allHeaders()).filter(
          ([k]) =>
            !k.startsWith(':') &&
            !['host', 'content-length', 'accept-encoding'].includes(k.toLowerCase()),
        ),
      ),
      body: req.postDataBuffer() ?? undefined,
      redirect: 'follow',
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)) {
        headers[k] = v;
      }
    });
    await route.fulfill({ status: resp.status, headers, body: buf });
    // A resolved fetch is not the same as an answered call. The provider
    // can hand back a JSON-RPC error, or a 429, over a perfectly healthy
    // HTTP response — and passing that on without a verdict is how a
    // rate-limited required read became a "missing chooser" product FAIL,
    // and a rate-limited optional read an exit-0 pass on a page that was
    // never fully served (#1529 review round 22).
    //
    // AFTER the fulfill, deliberately. The page gets the real response
    // whatever we go on to conclude about it: this is observation, and a
    // fault in our own judgement must not be able to turn a request the
    // provider answered into an aborted one. Should this throw, the catch
    // below files it as BLOCKED and the abort no-ops on an already-served
    // route — the harmless direction.
    // Which endpoints is the PAGE actually talking to, and which of those
    // serve the deployment it is being reviewed against? Only knowable
    // from its own traffic — see `pageRpcChain`.
    const pageCalls = rpcCallsFromBody(req.postData());
    if (pageCalls) notePageRpcEndpoint(req.url(), pageCalls);
    recordRpcResponse(
      {
        status: resp.status,
        body: buf,
        requestBody: req.postData(),
        // Redact BEFORE truncating, as the catch path does below.
        url: redact(req.url()).slice(0, 160),
      },
      rpcLedger,
    );
  } catch (err) {
    // The abort is still the only option — there is no response to serve
    // — but it must not pass silently: see `routeFailures`.
    routeFailures.push({
      // Redact BEFORE truncating — slicing first can cut a URL mid-way
      // and leave `redact` unable to parse what it is handed.
      url: redact(req.url()).slice(0, 160),
      why: String(err).split('\n')[0].slice(0, 160),
    });
    await route.abort('failed').catch(() => {});
  }
};

const watchRequestHandler = async (_src, { method, params = [] }) => {
  try {
    if (!ALLOWED_RPC.has(method)) {
      refusedRpc.push(method);
      // 4100 "unauthorized" is what a watch-only account produces —
      // not 4001, which would read as the user simply declining.
      return { error: { code: 4100, message: `watch-only session: ${method} unavailable` } };
    }
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { result: [observed] };
      case 'eth_chainId':
        return { result: numberToHex(CHAIN_ID) };
      case 'net_version':
        return { result: String(CHAIN_ID) };
      case 'wallet_switchEthereumChain':
        // Single-chain session: accept the chain we are on, refuse others
        // rather than pretend to switch.
        if (Number(params[0].chainId) === CHAIN_ID) return { result: null };
        return { error: { code: 4902, message: 'watch-only session: single chain' } };
      case 'wallet_requestPermissions':
        return { result: [{ parentCapability: 'eth_accounts' }] };
      default: {
        const result = await pub.request({ method, params });
        return { result: result === undefined ? null : result };
      }
    }
  } catch (e) {
    // The page's OWN reads come through here, and they do not travel the
    // routed-fetch path — `pub.request` goes straight out on node fetch.
    // So the round-16 rule (an egress failure must never be reported as a
    // broken product) had a second door it did not cover: an `eth_call`
    // the app made through the wallet, failing on transport, reaches the
    // page as a plain provider error. The app handles it, renders without
    // the chooser, and the drive calls that a product FAIL — or worse,
    // the app swallows an optional read and the drive exits 0 on a page
    // that was never fully served (#1529 review round 18).
    //
    // Told apart by POSITIVE evidence that the EVM answered — the same
    // shape as `isRevert` above, and for the same reason. Round 18's
    // version of this tested `code !== -32603`, which is a DENYLIST: it
    // has to enumerate every operational code a provider might return,
    // and the ones it missed are waved through as answers. Measured:
    //
    //   revert            RpcRequestError            code=3       ANSWER
    //   revert as -32000  InvalidInputRpcError       code=-32000  ANSWER (bytes)
    //   rate limited      LimitExceededRpcError      code=-32005  no answer
    //   unavailable       ResourceUnavailableRpcError code=-32002 no answer
    //   internal          InternalRpcError           code=-32603  no answer
    //   internal + diag   InternalRpcError           data="upstream timeout"
    //                                                             no answer
    //   unreachable / 503 HttpRequestError           code=absent  no answer
    //
    // That is exactly the argument `ALLOWED_RPC` above is built on, and
    // it applies here too: an allowlist turns an omission into a false
    // BLOCKED, which is loud and harmless, where a denylist turns one
    // into a false FAIL blamed on the app (#1529 review round 19).
    //
    // The split is THREE-way, not two, and `classifyRpcFailure` owns it —
    // extracted to `rpc-verdict.mjs` with its own tests, because round 19
    // verified this predicate with a throwaway script and three bypasses
    // shipped anyway.
    //
    // The third outcome is round 21's: a provider answering `-32602`
    // RECEIVED the page's request and rejected it as malformed. That is a
    // working endpoint reporting an app defect, and filing it as "could
    // not fetch" exited 2 — an infrastructure verdict for a bad request
    // the PAGE generated, hiding exactly the regression class this drive
    // exists to catch. It is a product FAIL.
    const verdict = classifyRpcFailure(e);
    const why = String(e.shortMessage ?? e.message ?? e).split('\n')[0].slice(0, 160);
    // Origin only — never the full RPC URL, which routinely carries the
    // provider key.
    const where = `wallet ${method} → ${rpcLabel}`;
    if (verdict === 'unreachable') {
      routeFailures.push({ url: where, why });
    } else if (verdict === 'client-fault') {
      malformedRpc.push({ url: where, why });
    }
    return { error: { code: e.code ?? -32603, message: e.shortMessage ?? e.message ?? 'error' } };
  }
};

const initScript = () => {
  if (window.ethereum?.__vaipakamWatch) return;
  const listeners = {};
  const provider = {
    __vaipakamWatch: true,
    isMetaMask: true,
    request: async (payload) => {
      const r = await window.__watchRequest(payload);
      if (r.error) {
        const err = new Error(r.error.message);
        err.code = r.error.code;
        throw err;
      }
      return r.result;
    },
    on: (ev, fn) => ((listeners[ev] ??= []).push(fn), provider),
    removeListener: (ev, fn) => ((listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)), provider),
    emit: (ev, arg) => (listeners[ev] ?? []).forEach((f) => f(arg)),
  };
  window.ethereum = provider;
  const info = {
    uuid: '7a3f4b1e-9d2c-4f6a-8e5b-vaipakamwatch0',
    name: 'Vaipakam Watch-Only',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjNzc3Ii8+PC9zdmc+',
    rdns: 'com.vaipakam.watchonly',
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};

// The three registrations, each through the same BLOCKED wrapper as the
// context creation above. They are hoisted to named handlers purely so
// the wrapping is a one-line change per site rather than a re-indent of
// three large bodies — the behaviour of each handler is untouched.
await discovery('installing the request router', () =>
  ctx.route('**/*', routeHandler),
);
await discovery('exposing the wallet binding', () =>
  ctx.exposeBinding('__watchRequest', watchRequestHandler),
);
await discovery('installing the provider init script', () =>
  ctx.addInitScript(initScript),
);

/**
 * Load a route and report everything that went wrong on it.
 *
 * `expectChooser` makes the settle CONDITIONAL rather than a fixed sleep.
 * A fixed wait is wrong in both directions against a live chain: too
 * short and a slow RPC round-trip reads as "the chooser is missing",
 * failing the drive for a defect that isn't there; too long and every
 * run pays for the worst case. Waiting for the thing being asserted
 * resolves as soon as it appears, and only spends the full timeout in
 * the case where the answer is genuinely negative — where spending it is
 * exactly right, because that is the claim the drive would be making.
 */
async function visit(path, { expectChooser = false } = {}) {
  const page = await ctx.newPage();
  // Before anything navigates: a socket opened during the first paint must
  // not be missed — see `wsRpcMethods`.
  watchWebSockets(page);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).replace(/\s+/g, ' ').slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
  });
  let http = null;
  try {
    const resp = await page.goto(SITE + path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    http = resp?.status() ?? null;
    if (expectChooser) {
      // The chain reads behind this page are real RPC round-trips, so
      // wait for the assertion's own subject. A timeout here is NOT an
      // error to propagate — absence is a legitimate observation, and
      // the reporting below is what decides whether it is a failure.
      await page
        .locator('section.card')
        .filter({ hasText: CHOOSER.title })
        .first()
        .waitFor({ state: 'visible', timeout: 45_000 })
        .catch(() => {});
    }
    // Short settle regardless: lets the cards below the chooser (the
    // hold card among them) finish their own reads before we scrape.
    await page.waitForTimeout(4_000);
  } catch (e) {
    await page.close();
    return { path, nav: String(e).replace(/\s+/g, ' ').slice(0, 180), pageErrors, consoleErrors };
  }
  const text = await page.evaluate(() => document.body.innerText);
  const hooks = pageErrors.some((e) =>
    /Rendered (more|fewer) hooks|Rules of Hooks|change in the order of Hooks/i.test(e),
  );
  const holdCard = await page.getByTestId('sale-listing-hold-card').count();
  const freeHeld = await page.getByTestId('free-held-options').count();
  const out = {
    path,
    http,
    pageErrors,
    consoleErrors,
    hooks,
    text,
    chooser: CHOOSER.title.test(text),
    handover: /hand the loan to another borrower/i.test(text),
    offset: /exit by becoming a lender/i.test(text),
    // Lender-card shape. `waitFirst` is the one ORDERING claim the card
    // makes and the only one observable from rendered text: the wait row
    // must precede both sale rows, because a lender's position already
    // pays and the no-forfeiture option is meant to lead. It is checked
    // by index rather than by presence — all three strings can be on the
    // page in the wrong order, which is exactly the regression a
    // presence check would wave through.
    ...(ROLE === 'lender' ? lenderShapeOf(text) : {}),
    holdCard: holdCard > 0,
    freeHeld: freeHeld > 0,
    connected: !/Connect wallet/i.test(text.slice(0, 400)),
  };
  await page.close();
  return out;
}

/**
 * Discovery happens up front, but each detail page can take the better
 * part of a minute — so by the time a candidate is visited, minutes may
 * have passed. In that window a loan can gain an offset lock, cross its
 * grace deadline, or have its borrower NFT transferred, and the page will
 * correctly evaluate the NEWER state and hide the chooser while this
 * drive still holds a stale candidate. Reporting that as a regression
 * would be a race in the harness, not a defect in the app (#1529 review
 * round 7).
 *
 * So the volatile gates are re-read immediately before each visit. A
 * candidate that has changed is SKIPPED, not failed — nothing was
 * observed about it either way.
 */
async function stillEligible(loan) {
  // These reads are as much "could not inspect" as the discovery ones, so
  // they go through the same wrapper: an RPC failure here must not escape
  // and exit 1 as a product regression (#1529 review round 8).
  const [lockedNow, authorityNow, now, live] = await discovery(
    `re-reading loan ${loan.id} before visiting it`,
    () =>
      Promise.all([
        // Not read for a lender run — the lender card is not gated on the
        // borrower's offset lock. Resolved to `false` so the shared
        // destructuring below keeps one shape.
        ROLE === 'lender' ? Promise.resolve(false) : offsetLockedOn(loan.borrowerTokenId),
        ROLE === 'lender' ? lenderAuthorityOf(loan) : borrowerAuthorityOf(loan),
        pub.getBlock({ blockTag: 'latest' }).then((b) => b.timestamp),
        pub.readContract({
          address: DIAMOND,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getLoanDetails',
          args: [loan.id],
        }),
      ]),
  );
  // STATUS too, not just the volatile gates: a loan repaid, liquidated or
  // defaulted between discovery and the visit correctly loses its
  // chooser, and the minutes-old status would call that a regression.
  if (
    ROLE === 'lender'
      ? !lenderStatusOk(Number(live.status))
      : Number(live.status) !== STATUS_ACTIVE
  ) {
    return 'no longer active';
  }
  if (lockedNow) return 'offset started since discovery';
  if (authorityNow === null) return `${ROLE} token burned since discovery`;
  if (authorityNow.toLowerCase() !== observed.toLowerCase()) {
    return 'position transferred since discovery';
  }
  // The grace re-check below is a BORROWER gate. Applying it to a lender
  // run would skip a page whose card is correctly still rendering — and,
  // if it were the only candidate, report BLOCKED on a working surface.
  //
  // Sanctions IS re-read here, because unlike grace it can change in
  // either direction between discovery and the visit, and a flag that
  // landed in that window correctly suppresses the card.
  if (ROLE === 'lender') {
    const flaggedNow = await discovery(
      `re-reading the sanctions status of ${observed}`,
      () => sanctionedAuthority(authorityNow),
    );
    return flaggedNow ? 'holder sanctions-flagged since discovery' : null;
  }
  // The LIVE term, not the discovered one. `extendLoanInPlace` rewrites
  // startTime and durationDays while the loan stays Active, so a stale
  // term would judge an extended loan against its old deadline and skip a
  // page that is correctly still chooser-eligible — and, if it was the
  // only candidate, report BLOCKED (#1529 review round 10). The grace
  // bucket follows the live duration too, since the bucket is chosen BY
  // duration — and the SCHEDULE is re-read here as well, not just the
  // term. A memo from discovery is exactly the stale input this function
  // exists to rule out.
  invalidateGraceBuckets();
  const grace = await graceSecondsFor(live.durationDays);
  if (now > live.startTime + live.durationDays * 86_400n + grace) {
    return 'crossed its grace deadline since discovery';
  }
  return null;
}

/**
 * The lender card's observable shape, scraped from rendered text.
 *
 * Three claims, and only the third needs explaining:
 *
 *  - `waitRow` / `sellNowRow` / `listRow` — the three options are named.
 *  - `blurb` — the card's own framing line, which is what distinguishes
 *    "the card rendered" from "the words happen to appear elsewhere on a
 *    long page". The title alone is a weaker signal than it looks.
 *  - `waitFirst` — the wait row PRECEDES both sale rows. This is the one
 *    ordering claim the card makes, and the reason it exists: a lender's
 *    position already pays them, so the option that forfeits no interest
 *    leads, which is the inversion from the borrower chooser. Checked by
 *    index because all three rows can be present in the wrong order — a
 *    presence check passes on exactly the regression worth catching.
 *
 * `waitFirst` is reported as `null`, never `false`, when a row it needs
 * is absent: with no sell-now row there is no order to be wrong about,
 * and returning `false` would file a missing row twice — once honestly
 * and once as a fabricated ordering defect.
 */
function lenderShapeOf(text) {
  const at = (re) => {
    const m = re.exec(text);
    return m ? m.index : -1;
  };
  const wait = at(/Wait for the loan to run its course/i);
  const sellNow = at(/Sell your position now/i);
  const list = at(/List your position for sale/i);
  // ALL THREE indices, not "wait plus whichever sale row happens to be
  // there" (Codex #1853 r1). With one sale row missing, the earlier
  // version still judged the order against the survivor — so if THAT row
  // preceded the wait row, the report emitted the legitimate missing-row
  // failure AND a second ordering failure, for an order that could not
  // be observed. Double-counting one defect is exactly what the `null`
  // arm was introduced to prevent, and it had a hole in it.
  const allPresent = wait >= 0 && sellNow >= 0 && list >= 0;
  return {
    lenderBlurb: /You don.t have to do anything with this position/i.test(text),
    waitRow: wait >= 0,
    sellNowRow: sellNow >= 0,
    listRow: list >= 0,
    waitFirst: allPresent ? wait < sellNow && wait < list : null,
  };
}

// ---------------------------------------------------------------- drive
const visited = [];
const racedOut = [];
visited.push(await visit('/positions'));
// Walk candidates until MAX_POSITIONS pages have actually been OBSERVED,
// not merely attempted. A pre-slice let a raced-out candidate consume the
// quota, so the drive silently verified fewer pages than asked for — and
// if every sliced row raced out it reported BLOCKED while eligible
// candidates sat untried behind the slice (#1529 review round 9).
let observedDetails = 0;
for (const l of mine) {
  if (observedDetails >= MAX_POSITIONS) break;
  const changed = await stillEligible(l);
  if (changed) {
    racedOut.push(`${l.id} (${changed})`);
    continue;
  }
  visited.push(await visit(`/positions/${l.id}`, { expectChooser: true }));
  observedDetails += 1;
}
await browser.close();

if (racedOut.length) {
  console.log(
    `\nskipped mid-run, chain state moved: ${racedOut.join(', ')}` +
      `\n  → not a failure; nothing was observed about these.`,
  );
}

// --------------------------------------------------------------- report
let failures = 0;
console.log('');
for (const v of visited) {
  const detail = /^\/positions\/\d+$/.test(v.path);
  const problems = [];
  if (v.nav) problems.push(`nav: ${v.nav}`);
  // A 404/500 does not throw and does not fire `pageerror`: page.goto
  // resolves and the status is merely recorded. Unchecked, a route that
  // never loaded counted toward "routes clean" (#1529 review).
  if (!v.nav && (v.http === null || v.http === undefined || v.http < 200 || v.http >= 300)) {
    problems.push(`navigation returned ${v.http ?? 'no response'}`);
  }
  if (v.hooks) problems.push('HOOKS-ORDER CRASH');
  if (v.pageErrors?.length) problems.push(`${v.pageErrors.length} uncaught error(s)`);
  // A position DETAIL page for an eligible loan must show the chooser
  // AND both newly-exposed paths. Printing handover/offset without
  // failing on them let the drive pass while missing one of the two
  // #1505 surfaces it claims to validate (#1529 review).
  if (detail && !v.nav) {
    if (!v.chooser) problems.push(`${ROLE} chooser MISSING on an eligible loan`);
    else if (ROLE === 'lender') {
      // The card is an AWARENESS surface, so what makes it correct is
      // that every option is NAMED — an unavailable row explains itself
      // rather than vanishing, precisely because a missing row reads as
      // "no such option". A row absent altogether is therefore a
      // regression even on a loan where that exit is shut.
      if (!v.lenderBlurb) problems.push('lender card title without its own blurb');
      if (!v.waitRow) problems.push('wait row MISSING from the lender card');
      if (!v.sellNowRow) problems.push('sell-now row MISSING from the lender card');
      if (!v.listRow) problems.push('listing row MISSING from the lender card');
      // `null` = not enough rows rendered to have an order; the missing
      // row is already reported above and must not be double-counted.
      if (v.waitFirst === false) problems.push('wait row is NOT first on the lender card');
    } else {
      if (!v.handover) problems.push('handover path MISSING from the chooser');
      if (!v.offset) problems.push('offset path MISSING from the chooser');
    }
  }

  const verdict = problems.length ? 'FAIL' : 'ok';
  if (problems.length) failures++;
  console.log(`${verdict.padEnd(5)} ${v.path.padEnd(16)} http=${v.http ?? '-'} connected=${v.connected ?? '-'}`);
  if (detail && !v.nav) {
    console.log(
      ROLE === 'lender'
        ? `      card=${v.chooser} blurb=${v.lenderBlurb} wait=${v.waitRow}` +
          ` sellNow=${v.sellNowRow} list=${v.listRow} waitFirst=${v.waitFirst}`
        : `      chooser=${v.chooser} handover=${v.handover} offset=${v.offset}` +
        ` holdCard=${v.holdCard} freeHeldBtn=${v.freeHeld}`,
    );
  }
  problems.forEach((p) => console.log(`      ! ${p}`));
  (v.pageErrors ?? []).forEach((e) => console.log(`      E ${e}`));
  // Console noise is reported but never fails the drive: production CSP
  // refuses the analytics beacon, and the sandbox proxy resets page
  // WebSockets. Neither is an app defect.
  (v.consoleErrors ?? []).slice(0, 4).forEach((e) => console.log(`      c ${e}`));
}

// Settle the routed-fetch attempts now that no more will arrive. Until
// this point `rpcLedger` holds ATTEMPTS, not verdicts — a read viem
// retried successfully, or reached through the fallback transport, must
// not be reported as a failure just because its first try was refused
// (#1529 review round 23). Merged into the same two buckets the wallet
// path and the catch path already fill, so the report and the exit
// contract below are unchanged.
{
  const settled = summariseRpcLedger(rpcLedger);
  malformedRpc.push(...settled.malformed);
  routeFailures.push(...settled.unreachable);
}

// A refusal is never just informational. Printing it while the exit code
// says PASS is precisely the silent-pass shape the BLOCKED verdict exists
// to prevent: the app can catch a refused read, render a degraded page
// that still happens to contain the chooser, and the drive would report
// clean (#1529 review round 5). Zero refusals is the established
// expectation from a real run, so any refusal at all ends the run
// non-zero — as a REGRESSION when the page tried to mutate, and as
// BLOCKED when it is our own allowlist that is too narrow, because those
// have different remedies.
const pageTriedToWrite = [...new Set(refusedRpc)].filter((m) => WRITE_SHAPED.test(m));
const allowlistTooNarrow = [...new Set(refusedRpc)].filter((m) => !WRITE_SHAPED.test(m));

if (pageTriedToWrite.length) {
  console.log(
    `\nREAD-ONLY VIOLATION — the page asked to sign or send:` +
      ` ${pageTriedToWrite.join(', ')}` +
      `\n  → refused, so nothing was sent, but a read-only surface should` +
      ` never have asked. This is a finding, not a harness gap.`,
  );
}
if (allowlistTooNarrow.length) {
  console.log(
    `\nALLOWLIST TOO NARROW — refused non-write method(s):` +
      ` ${allowlistTooNarrow.join(', ')}` +
      `\n  → the page may have rendered with less than it asked for, so` +
      ` this run's observations are not trustworthy. Add these to` +
      ` ALLOWED_RPC and re-run.`,
  );
}
// Same split as the provider path: a refused WRITE is a finding about the
// page; a refused non-write is our allowlist being too narrow.
const httpWrites = blockedHttp.filter((b) => b.method === null || WRITE_SHAPED.test(b.method));
const httpGaps = blockedHttp.filter((b) => b.method !== null && !WRITE_SHAPED.test(b.method));
if (httpWrites.length) {
  console.log(`\nREAD-ONLY VIOLATION — mutating HTTP refused: ${httpWrites.length}`);
  httpWrites.slice(0, 8).forEach((b) => console.log(`  ${b.why} → ${b.url}`));
}
if (httpGaps.length) {
  console.log(
    `\nALLOWLIST TOO NARROW — refused non-write RPC over HTTP:` +
      ` ${[...new Set(httpGaps.map((b) => b.method))].join(', ')}` +
      `\n  → the page may have rendered with less than it asked for.` +
      ` Add these to ALLOWED_RPC and re-run.`,
  );
}

// BORROWER runs only (Codex #1853 r1). `SaleListingHoldCard` is gated on
// `role === 'borrower'`, so on a lender run it can never render — and the
// "no lender sale listing standing right now" gloss then draws a
// conclusion about CHAIN STATE from a card that was never eligible to
// appear. A lender with a live listing of their own would have been told
// no listing existed, by a line whose whole purpose is to distinguish
// "not observed" from "not there".
//
// Reporting nothing beats reporting a confident falsehood; the lender
// side of listing state belongs to its own surface, not to this one.
if (ROLE === 'borrower') {
  const holds = visited.filter((v) => v.holdCard);
  console.log(
    `\nlisting-hold card observed on ${holds.length} of ${visited.filter((v) => /\d$/.test(v.path)).length} position page(s)` +
      (holds.length ? '' : ' — no lender sale listing standing right now, so the hold state is not reachable to observe'),
  );
}

console.log(`\n${visited.length - failures}/${visited.length} routes clean`);

// A page-initiated write attempt is a regression in the app; a
// too-narrow allowlist means this run simply cannot be trusted. Neither
// may exit 0.
//
// Order matters here. A write attempt is a finding about the APP and
// stands whatever the network did, so it is judged first. Everything
// else that counted as a failure — a navigation error, a missing
// chooser — is only meaningful if the page actually received what it
// asked for, so unreachable page traffic downgrades those to BLOCKED
// rather than reporting a flaky egress as a broken product.
if (pageTriedToWrite.length || httpWrites.length) process.exit(1);
// Judged with the write attempts, and ahead of `routeFailures`, for the
// same reason they are: this is a finding about the APP that a reachable
// provider positively established. Ordering it after the BLOCKED check
// would let one unrelated flaky request bury a malformed-request defect
// under "re-run" (#1529 review round 21).
if (malformedRpc.length) {
  console.log(
    `\n${malformedRpc.length} page request(s) were rejected as malformed by` +
      ` a reachable provider — the app asked for something invalid.`,
  );
  malformedRpc.slice(0, 6).forEach((r) => console.log(`  ${r.why} → ${r.url}`));
  process.exit(1);
}
if (routeFailures.length) {
  console.log(
    `\nBLOCKED: ${routeFailures.length} page request(s) could not be` +
      ` fetched by this process, so the pages were not served what they` +
      ` asked for.`,
  );
  routeFailures.slice(0, 6).forEach((r) => console.log(`  ${r.why} → ${r.url}`));
  console.log(
    `  → the site, the RPC endpoint or the egress proxy was unreachable.` +
      ` Nothing observed here can be trusted; re-run.`,
  );
  process.exit(2);
}
// Ahead of `failures` for the same reason the chain check below is: RPC
// this driver could not see is not a product observation. Every guarantee
// in this file — the allowlist, the response ledger, the chain probe —
// rides on `ctx.route`, which is HTTP-only, so a page reading over a
// WebSocket has been judged on whatever it happened to ALSO fetch over
// HTTP. Refusing to vouch beats a green run that verified less than it
// claims (#1529 review round 25).
if (wsRpcMethods.size) {
  console.log(
    `\nBLOCKED: the page made JSON-RPC calls over a WebSocket, which this` +
      ` drive does not observe: ${[...wsRpcMethods].sort().join(', ')}`,
  );
  console.log(
    `  → those reads bypassed the method allowlist, the response ledger and` +
      ` the chain check, so this run cannot vouch for what the page was` +
      ` served. Re-run against a build with no VITE_*_WSS_URL configured,` +
      ` or extend this driver to classify WebSocket frames.`,
  );
  process.exit(2);
}
// Ahead of `failures`, because a wrong chain EXPLAINS a missing surface:
// judged after it, a site built against another network would report as a
// broken chooser (exit 1) instead of the deployment fault it is. See
// `pageRpcChain` for why the OBSERVE_RPC check above cannot cover this.
const pageChainWrong = [];
for (const [url, probe] of pageRpcChain) {
  const served = await probe;
  if (served !== null && served !== CHAIN_ID) {
    pageChainWrong.push({ url: redact(url).slice(0, 120), served });
  }
}
if (pageChainWrong.length) {
  console.log(
    `\nBLOCKED: the page's own RPC endpoint(s) serve a different chain than` +
      ` the requested ${CHAIN_ID}.`,
  );
  pageChainWrong.forEach((p) => console.log(`  chain ${p.served} → ${p.url}`));
  console.log(
    `  → the deployed site is built against the wrong network, so anything` +
      ` missing here says nothing about the app. Fix the site's RPC config` +
      ` or point this drive at chain ${pageChainWrong[0].served}.`,
  );
  process.exit(2);
}
if (failures) process.exit(1);
if (allowlistTooNarrow.length || httpGaps.length) process.exit(2);
// Every candidate moved out from under us: the list route alone proves
// nothing about the chooser, so this run verified nothing.
if (!visited.some((v) => /^\/positions\/\d+$/.test(v.path))) {
  console.log(
    '\nBLOCKED: no position detail page was observed — nothing verified.',
  );
  process.exit(2);
}
process.exit(0);
