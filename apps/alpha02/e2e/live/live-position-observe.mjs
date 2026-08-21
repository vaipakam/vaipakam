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
 *   2. The chooser for the observed ROLE renders on a real loan — Active
 *      for a borrower run, Active OR FallbackPending for a lender one,
 *      since the lender card mounts on both so its fallback explanation
 *      stays visible:
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
import {
  excursionExplains,
  jumpabilityMoved,
  missingSwitchVerdict,
  snapshotCardEligible,
  snapshotJumpable,
} from './jumpability.mjs';
import { redactUrl } from './redact.mjs';
import { isDetailPath, visitVerdict } from './visitVerdict.mjs';
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
 * Does NOT fail open, and the first version did — mirroring
 * `useSanctionsCheck`'s own `catch { return false }` (Codex #1853 r2).
 * That mirroring was wrong, for a reason worth keeping: the app fails
 * open on ITS OWN read over ITS OWN transport, where "I could not tell"
 * correctly means "do not block the user". This drive reads over a
 * DIFFERENT endpoint (`OBSERVE_RPC`), so its failure says nothing about
 * what the page will see. If our read fails while the page's succeeds
 * and reports the holder flagged, fail-open admits a candidate whose
 * card is correctly suppressed — and the visit then burns the 45-second
 * chooser timeout and files a product regression for an infrastructure
 * discrepancy. Exactly the failure the sanctions check was added to
 * prevent, re-entered through the error path.
 *
 * So the error propagates to `discovery()`, which is the harness's whole
 * 1-vs-2 contract: an unanswered read is "could not look properly"
 * (exit 2), never an eligibility verdict.
 *
 * On the retail deploy the oracle is commonly unset, in which case the
 * contract ANSWERS false for every address — an answer, not a failure —
 * and this costs one cheap read per candidate.
 */
/** One verdict per authority for the whole discovery pass. */
const sanctionsCache = new Map();
async function sanctionedAuthority(addr) {
  // Cached per normalised address (Codex #1853 r7). Without it, an
  // authority holding several eligible positions was read once PER LOAN
  // — so a later duplicate call failing transiently could block a run
  // whose answer was already in hand, and a mid-sweep oracle change
  // could classify two loans of one holder inconsistently. Safe to
  // cache for the sweep because `stillEligible` re-reads it immediately
  // before each visit, which is where freshness actually matters.
  //
  // A REJECTION IS EVICTED rather than cached. Storing the promise is
  // what makes the dedup work, but it also means a first-call failure
  // would be replayed to every later loan of that holder — turning one
  // transient blip into a permanent verdict for the run, which is a
  // worse version of the problem this cache exists to fix. On rejection
  // the entry is dropped so a later loan re-attempts; the rejection
  // still propagates to `discovery()` for the caller that hit it.
  const key = addr.toLowerCase();
  if (!sanctionsCache.has(key)) {
    const inflight = sanctionedAuthorityUncached(addr);
    inflight.catch(() => sanctionsCache.delete(key));
    sanctionsCache.set(key, inflight);
  }
  return sanctionsCache.get(key);
}
async function sanctionedAuthorityUncached(addr) {
  return pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'isSanctionedAddress',
    args: [addr],
  });
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
// Role-gated for the same reason the revalidation-time block read is
// (Codex #1853 r5): `chainNow` feeds the borrower grace comparison only,
// so on a lender run this is an unrelated read whose failure exits 2
// before any candidate can be observed. Fifth site of one rule — I fixed
// the revalidation copy in r4 and did not look for the other one, which
// is the same not-checking-the-sibling shape this PR keeps producing.
const chainNow =
  ROLE === 'lender'
    ? 0n
    : await discovery('reading chain time', () =>
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
  // CHEAP GATES FIRST for the lender run (Codex #1853 r4). `discovery()`
  // ends the whole drive on a read failure, and `assetType`/`status` are
  // already in hand from `getLoanDetails` — so resolving the authority
  // for a loan the predicate will discard anyway lets an irrelevant
  // `ownerOf` failure deny the review to every observable position.
  // Same rule the sanctions read gained in r3, applied one line earlier:
  // a read whose answer cannot change any verdict must not be able to
  // end the run.
  //
  // The borrower branch keeps reading unconditionally: it uses the
  // authority in its own skip-reason reporting for ineligible loans,
  // and changing that is outside this PR.
  loan.authority =
    ROLE === 'lender' && !(lenderStatusOk(loan.status) && loan.assetType === ASSET_ERC20)
      ? null
      : await discovery(
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
  // The ERC-20 gate belongs HERE, not only in the predicate below (Codex
  // #1853 r3). `discovery()` terminates the whole drive on a read
  // failure, so a transient failure on a read taken for a loan the
  // predicate always discards — an NFT rental — reports BLOCKED and
  // denies the review to every eligible ERC-20 position on the chain.
  // A read whose answer cannot change any verdict must not be able to
  // end the run.
  if (
    ROLE === 'lender' &&
    lenderStatusOk(loan.status) &&
    loan.assetType === ASSET_ERC20 &&
    loan.authority
  ) {
    // With an explicit OBSERVE_ADDRESS, another holder's sanctions
    // status cannot change whether any of THEIR positions is observable
    // (Codex #1853 r5) — and this read can end the run, so paying it for
    // an irrelevant authority lets an unrelated address block a targeted
    // one. Same rule as the ERC-20 and cheap-gate skips, applied to the
    // narrowing that happens later.
    const wanted = process.env.OBSERVE_ADDRESS;
    loan.authoritySanctioned =
      wanted && wanted.toLowerCase() !== loan.authority.toLowerCase()
        ? false
        : await discovery(
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
          ? // For a lender run the authority is deliberately left unread
            // when the cheap gates already fail, so `null` there means
            // "not looked up", not "burned" — and the two earlier arms
            // have already named the real reason.
            `${ROLE} token burned`
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
// `locale` is PINNED (Codex #1853 r3). Every copy assertion in this drive
// — both chooser titles and all of `lenderShapeOf` — is English, while
// alpha02 ships nine translated locales and detects from
// `navigator.languages`. On a host whose Chromium defaults to one of
// them, the app would correctly load that bundle and every string check
// would miss, so the drive would wait out the 45-second chooser timeout
// and file a product regression whose only cause is the harness's
// assumption about its own machine.
//
// Pinning beats asserting locale-independent structure here: the card
// has no test ids, and the thing worth checking IS the copy — that each
// option is named, and in which order. A structural assertion would pass
// on a card rendering the wrong sentences.
const ctx = await discovery('creating the browser context', () =>
  browser.newContext({
    viewport: { width: 1280, height: 1000 },
    locale: 'en-US',
  }),
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
async function visit(path, { expectChooser = false, loan = null } = {}) {
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
  const lenderCardText =
    ROLE === 'lender' && loan ? await readLenderCardText(page) : null;
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
    // The CARD's own text, not the page's (a bounded-block scrape ran
    // past the card's end and reported the page footer as a row's
    // reason). Falls back to the full body when the card is absent, so
    // the `card=false` verdict is still computed from something.
    ...(ROLE === 'lender' && loan ? lenderShapeOf(lenderCardText ?? text) : {}),
    // WHAT THE SCRAPE ACTUALLY SAW (Codex #1853 r16). The
    // suppression below needs to know whether the card was on the
    // page AT THIS MOMENT — not whether a chain read taken later,
    // inside `lenderAdvancedOf`, can explain an absence. Those are
    // different facts, and round 15 used the second as proof of the
    // first: a card that rendered here WITH A ROW MISSING, on a loan
    // that then went terminal before the snapshot, had its genuine
    // regression suppressed as a pre-render race.
    cardAbsentAtScrape: ROLE === 'lender' && loan ? lenderCardText === null : false,
    // DETAIL PAGES ONLY, gated on `loan` (self-inflicted, caught by
    // running it). The lender card exists only on `/positions/<id>`, and
    // on the LIST route the card locator matches nothing — but a
    // Playwright locator AUTO-WAITS before rejecting, so every poll took
    // the full locator timeout, the stability loop never got a second
    // sample inside its deadline, and the list route reported BLOCKED.
    //
    // `.catch(() => '')` looked like it made the read safe. It makes the
    // FAILURE safe; it does nothing about the 30 seconds spent reaching
    // it — which is the same "handled the error, ignored the cost"
    // shape as the r3 rental read that could end the run.
    ...(ROLE === 'lender' && loan
      ? await lenderAdvancedOf(page, loan, lenderCardText === null)
      : {}),
    // Spread AFTER the shape scrape on purpose: where the probe observed
    // the card the scrape had missed, its later reading replaces the
    // earlier absence (Codex #1853 r17). Order is the mechanism here, so
    // moving this line above `lenderShapeOf` silently restores the bug.

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
        // Chain time feeds the BORROWER grace check only, and the lender
        // branch returns before reaching it — so on a lender run this is
        // a read whose failure could reject the shared Promise.all and
        // report BLOCKED while every read that actually decides the
        // verdict succeeded (Codex #1853 r4). Third instance of the same
        // rule in two rounds.
        ROLE === 'lender'
          ? Promise.resolve(0n)
          : pub.getBlock({ blockTag: 'latest' }).then((b) => b.timestamp),
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
    // UNCACHED, deliberately (Codex #1853 r8). The discovery cache is
    // keyed per authority for the whole sweep, so calling the cached
    // helper here returns the fulfilled promise from discovery and this
    // "re-read" reads nothing. That defeats the exact justification I
    // gave for the cache one round earlier — that freshness is enforced
    // where it matters, immediately before the visit — so the cache made
    // its own safety argument false.
    //
    // The failure it causes is the expensive direction: an authority
    // flagged between discovery and the visit has its card correctly
    // suppressed by the page, and the drive would wait out the chooser
    // timeout and report a product FAIL.
    const flaggedNow = await discovery(
      `re-reading the sanctions status of ${observed}`,
      () => sanctionedAuthorityUncached(authorityNow),
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
  // The sentence each sale row shows INSTEAD of being available, when it
  // is unavailable. Purely informational and never a FAIL — an
  // unavailable row is correct behaviour on most chains — but without it
  // "no jumpable row" is a dead end for whoever reads the report, and
  // WHICH reason is showing is the single most useful fact about a live
  // deployment's sale surface. Sliced from the row's own text so a
  // reworded string degrades to a shorter excerpt rather than to a lie.
  //
  // Taken from the END of the row's block, not its start: the card
  // renders title → description → cost lines → unavailability sentence,
  // so the first lines after a title are the description (which the
  // first version of this captured and reported as if it were the
  // reason). The block is bounded by the next row's title, or by the
  // card's switch note / the end of the text.
  const bounds = [sellNow, list, at(/These tools live in the Advanced view/i), text.length]
    // (`text` here is the card's own innerText — see the call site.)
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const reasonAfter = (i) => {
    if (i < 0) return null;
    const end = bounds.find((b) => b > i) ?? text.length;
    const lines = text
      .slice(i, end)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Last line of the block. On an AVAILABLE row that is the cost line
    // or the jump label, which is why this is reported only when no jump
    // rendered — the caller decides, so this stays a plain observation
    // rather than a guess about which line means what.
    return lines.length > 1 ? lines[lines.length - 1].slice(0, 160) : null;
  };
  return {
    sellNowText: reasonAfter(sellNow),
    listText: reasonAfter(list),
    lenderBlurb: /You don.t have to do anything with this position/i.test(text),
    waitRow: wait >= 0,
    sellNowRow: sellNow >= 0,
    listRow: list >= 0,
    waitFirst: allPresent ? wait < sellNow && wait < list : null,
  };
}

/**
 * The Advanced half of the review, and it needs NO WALLET FILE.
 *
 * I first recorded this as owed pending `TESTNET_WALLETS_FILE`, which
 * was wrong (Codex #1853 r4): the drive already runs a CONNECTED
 * session through its watch-only provider, `onSwitchToAdvanced` only
 * calls `setMode('advanced')`, and each row's jump handler only calls
 * `scrollIntoView`. Nothing here signs or sends, so filing it as a
 * signing-limited gap fenced off coverage the keyless driver could
 * always have taken. Recording that because a wrongly-stated limit is
 * more expensive than an unstated one — it stops anyone looking again.
 *
 * What it asserts, and deliberately no more:
 *
 *  - the switch control is offered in Basic mode;
 *  - after clicking it, the card's jump buttons appear (they render only
 *    when `isAdvanced`), and
 *  - every jump target a button points at EXISTS in the document.
 *
 * That last one is the real check. `jump()` resolves its target with
 * `getElementById(...)?.scrollIntoView()` — optional-chained — so a row
 * offering a jump to an anchor that never mounted is silently inert:
 * the lender clicks and nothing at all happens. The card's own
 * prerequisite gate exists to prevent exactly that, and this is the
 * observation that would catch it failing.
 *
 * Returns `advancedJumps: null` when the switch is not offered, which is
 * a legitimate state (every sale row unavailable), not a failure.
 */
/**
 * Did the inputs that make a SALE ROW JUMPABLE move during the probe?
 *
 * NOT `stillEligible` (Codex #1853 r9). Round 8 reused that, and it
 * detects none of the three changes it was called to detect: its lender
 * branch accepts Active AND FallbackPending by design, skips chain time
 * entirely, and never reads the lender token's lock. So the fix was a
 * no-op for its stated purpose — a re-read that cannot observe the race
 * it exists to observe.
 *
 * The two functions answer genuinely different questions, which is why
 * one cannot serve for the other:
 *
 *   stillEligible  — may the CARD still mount? Deliberately loose:
 *                    FallbackPending keeps it mounted, past maturity
 *                    keeps it mounted, because the wait row stays true.
 *   this           — can a SALE ROW still be jumped to? Strict: both
 *                    sale entry points require exactly Active, refuse
 *                    past maturity, and refuse a locked position.
 *
 * Deliberately a SUBSET, and says so: it covers the three races named in
 * review, not every input `buildLenderExitRows` consults. A full model
 * would be a shadow copy of that module living in a test harness, which
 * is the defect class this whole PR chain is about. Anything it does not
 * cover still reports as the no-op-switch FAIL, which is the honest
 * failure for "we could not explain this".
 */
async function jumpabilitySnapshot(loan) {
  return discovery(`reading loan ${loan.id} jumpability inputs`, async () => {
    const [live, now, lock, holder, flagged] = await Promise.all([
      pub.readContract({
        address: DIAMOND,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getLoanDetails',
        args: [loan.id],
      }),
      pub.getBlock({ blockTag: 'latest' }).then((b) => b.timestamp),
      positionLockOf(loan.lenderTokenId),
      lenderAuthorityOf(loan),
      sanctionedAuthorityUncached(observed),
    ]);
    return {
      active: Number(live.status) === STATUS_ACTIVE,
      // Recorded SEPARATELY from `active` so the pure module can reason
      // about the CARD's mount gate without importing chain constants
      // (Codex #1853 r15). The card deliberately stays mounted on a
      // fallback-settling loan — its wait row is still true — so "not
      // Active" and "not mountable" are different questions and the
      // suppression below turns on the second, not the first.
      fallbackPending: Number(live.status) === STATUS_FALLBACK_PENDING,
      // `>=`, matching the page and the contracts: AT the boundary
      // second both jumps are correctly gone (Codex #1853 r10).
      matured: now >= live.startTime + live.durationDays * 86_400n,
      locked: lock !== 0,
      holder: holder === null ? null : holder.toLowerCase(),
      flagged: Boolean(flagged),
    };
  });
}

/**
 * Raw lock reason on any position token; 0 = unlocked.
 *
 * A REVERT IS NOT A LOCK, and this read does not swallow one (Codex
 * #1853 r18). The version this replaces returned a `-1` sentinel that
 * `jumpabilitySnapshot` turned into `locked: true`, "the same direction
 * `offsetLockedOn` takes" — and that reasoning was the bug, because the
 * two calls are not the same kind of call.
 *
 *   `offsetLockedOn` is a candidate FILTER. Assuming a lock there drops
 *   one loan from the pool; the cost is an observation not made, which
 *   is loud and harmless.
 *
 *   This one is a VERDICT INPUT. Assuming a lock here makes
 *   `snapshotJumpable` return false, which routes a genuine no-op switch
 *   into the already-unjumpable BLOCKED arm and lets the drive exit 0
 *   with the anchor audit never run. The cost is a suppressed finding,
 *   which is silent.
 *
 * A revert proves only that the prerequisite could not be read — on a
 * deployment missing the selector, every position reads as locked and
 * the whole Advanced assertion quietly stops asserting. So it propagates
 * to `discovery()` and reads BLOCKED, which is the honest verdict for
 * "we could not look".
 */
async function positionLockOf(tokenId) {
  return Number(
    await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'positionLock',
      args: [tokenId],
    }),
  );
}

/**
 * Wait until the sale rows have SETTLED — a jump exists, or they have
 * stopped saying "still reading". Shared by both entry paths into
 * Advanced (Codex #1853 r7 for the post-click path, r9 for the
 * already-Advanced one): `ModeContext` persists `alpha02.mode`, so once
 * any page in this browser context switches, every later detail page
 * renders in Advanced from the start — and hits the identical loading
 * interval at first render, with neither switch nor jumps present.
 */
async function waitForSaleRows(card, jumpsOf, page, swOf, late, watch, selfOf) {
  // THE SAMPLER IS REQUIRED, and this guard is the whole of #1868.
  //
  // It used to be read as `selfOf?.()`, so a caller that simply forgot
  // the argument got `undefined` on every poll, `missingSwitchVerdict`
  // answered `unknown`, and the wait fell back to inferring jumpability
  // from whatever was rendered — the pre-#1855 behaviour this drive was
  // rewritten to end. That is a correct fallback for a DEPLOYMENT that
  // publishes no attributes and a silent downgrade for a CALLER that
  // forgot one, and from inside this function the two are identical.
  //
  // Both existing call sites pass it. The failure this prevents is the
  // third one, added later by someone who has not read this comment:
  // they get a crash on the first run instead of a green review that
  // stopped checking the thing it advertises.
  //
  // A LEGACY BUNDLE NEEDS NO SPECIAL SAMPLER, which is worth stating
  // because #1868 asked for one and it turned out to be unnecessary.
  // `chooserSelfVerdict` already answers `null` when the attributes are
  // absent, so a drive against a pre-#1855 build passes the ordinary
  // sampler and gets the ordinary fallback. The legacy path was never
  // reached by OMITTING the argument on purpose — only by accident.
  if (typeof selfOf !== 'function') {
    throw new TypeError(
      'waitForSaleRows: the readiness sampler is required. Pass ' +
        '`() => chooserSelfVerdict(page)` — it returns null by itself ' +
        'on a bundle that publishes no data-chooser-* attributes, which ' +
        'is the legacy fallback.',
    );
  }
  // TEXT STABILITY IS NOT READINESS, and round 11's version of this was
  // unsound (Codex #1853 r12). Pending copy is STATIC — "still reading
  // the details a sale needs" does not change while the read is in
  // flight — so three identical samples meant "the loading message has
  // not changed", never "the read finished". A read slower than three
  // seconds settled falsely, which is the same silent false PASS r11
  // claimed to eliminate. I described that change as closing a class.
  // It closed the enumeration and left the hole.
  //
  // There IS a positive readiness signal now (#1855 shipped), and it is
  // polled below — `selfOf` reads the card's own
  // `data-chooser-ready` / `data-chooser-jumpable`, so a card that has
  // settled ends the wait immediately instead of paying the deadline.
  // The arms below remain the fallback for a bundle that publishes
  // nothing, which is why the deadline still exists at all:
  //
  //   - a jump appears                  → settled, audit it
  //   - the switch appears              → settled, click it
  //   - the explicit FAILED sentence    → definite non-ready, BLOCKED
  //   - deadline with none of the above → no jumpable row
  //
  // The failed sentence stays copy-matched deliberately, and the
  // asymmetry is the point: it is a DEFINITE answer ("this could not be
  // loaded"), where the checking sentences are merely the absence of
  // one. Matching on a definite answer degrades to a longer wait if the
  // copy changes; matching on absence degrades to a false pass. Round 11
  // dropped this arm entirely when it removed the enumeration, so a
  // persistent failure became "settled".
  //
  // That cost — the full deadline on a page that genuinely has no
  // jumpable row, which is most of a past-due chain — is what the
  // readiness poll removes (Codex #1853 r29). Consuming the attributes
  // only AFTER this function returned left the 45 seconds per position
  // exactly where they were, so the hook #1855 added to delete the
  // wait was being read too late to delete anything.
  const FAILED = /one of the details a sale needs couldn.t be loaded/i;
  // THE PENDING SENTENCE, and matching it here is sound where matching
  // it for READINESS was not (Codex #1853 r19).
  //
  // Round 12's rule stands: a pending sentence is the ABSENCE of an
  // answer, so concluding "settled" from its disappearance degrades to
  // a false pass if the copy changes. This is the opposite direction.
  // It is read only AT the deadline, and only to RAISE the verdict from
  // "no jumpable row" to BLOCKED — so a reworded string degrades to the
  // behaviour this file already had, never to a new false pass.
  const PENDING = /still reading the details a sale needs/i;
  const deadline = Date.now() + 45_000;
  let lastVerdict = 'unknown';
  for (;;) {
    // INSIDE THE POLL (Codex #1853 r19). The probe's eager capture runs
    // before this loop and the wrapper's runs after the probe returns,
    // which leaves the whole polling window uncovered: a card that
    // mounts here and is unmounted by an ownership or status refresh
    // before the probe finishes was positively observed and then
    // forgotten, and the run reported a missing chooser. A recorder
    // advertised as sticky has to be offered every observation, not the
    // two at the ends.
    await late?.capture();
    // A REVERSIBLE STATUS TRANSITION LEAVES NO TRACE EITHER (Codex
    // #1853 r24). An Active loan can enter FallbackPending after the
    // pre-state snapshot and cure back before the post-state read: the
    // two chain samples agree, and the DOM check cannot help because
    // FallbackPending deliberately KEEPS the card mounted while
    // removing every jump. The probe then sees a switch, no jumps, and
    // nothing moved — the no-op-switch product FAIL, on a page that
    // behaved correctly throughout.
    //
    // Ownership round trips were caught by watching the DOM; this one
    // is only visible on chain, so it is sampled here — sparsely, and
    // the limit is stated rather than papered over: this observes the
    // status at a few points inside the window, not continuously, so a
    // transition that opens and closes between two samples is still
    // invisible. #1855's readiness attribute is what removes the guess
    // entirely.
    await watch?.();
    // THE CARD'S OWN ANSWER, ASKED FIRST (Codex #1853 r29, reordered
    // r31). Every other arm here reasons from an absence and cannot
    // conclude before the deadline; this one is a positive statement,
    // so the moment it is recognised the wait is over — which is why
    // the common past-due page no longer costs 45 seconds.
    //
    // Asked BEFORE the controls are counted, because a control being
    // on screen is not evidence that it should be. A background
    // refetch leaves the card publishing `pending` while its cached
    // switch and jump buttons are still rendered, and the previous
    // order returned on those without ever asking — so the audit
    // clicked controls the in-flight read was about to withdraw and
    // the run exited 0. Same shape as everything else on this PR: the
    // strict treatment was on the zero-jump path and the successful
    // path took the cached answer.
    //
    // Two non-answers, treated differently and deliberately.
    // `unknown` is an older bundle publishing nothing, so the controls
    // in front of us are the only evidence there is and we use them.
    // `blocked-pending` is the card saying it is still deciding, so we
    // keep waiting — and it is reported only if the clock runs out
    // (r30: returning on it made a merely slow page report a failure).
    // BRACKETED, because these are three separate round trips (Codex
    // #1853 r33). The verdict and the two counts cannot be taken at the
    // same instant, so a card that starts a background refetch between
    // them yields a stale `ready` beside a current count — exactly the
    // pending-readiness false pass this ordering exists to prevent,
    // reconstructed out of two individually correct reads.
    //
    // Reading readiness again AFTER the counts and requiring the two to
    // agree makes the whole observation one that held across the
    // window, rather than three that were each true at a different
    // moment. A disagreement is not an error: it is the card moving
    // while we looked, so the loop simply goes round again with the
    // later verdict.
    //
    // The alternative — one `evaluate` returning attributes and control
    // counts together — is genuinely atomic but restates "which button
    // is a jump" in a second place, and a duplicated selector is the
    // defect class this file is named for. Agreement across a bracket
    // costs one extra read and keeps the locators single-source.
    const beforeVerdict = missingSwitchVerdict(await selfOf());
    const jumps = await jumpsOf().count();
    const switchThere = swOf ? (await swOf().count()) > 0 : false;
    const afterVerdict = missingSwitchVerdict(await selfOf());
    lastVerdict = afterVerdict;
    if (beforeVerdict !== afterVerdict) {
      // The deadline is checked HERE too. A bare `continue` would skip
      // the one below, so a card oscillating between verdicts would
      // loop past 45 seconds forever — the unbounded-wait class this
      // file has already been bitten by, reintroduced through the exit
      // rather than through an API.
      if (Date.now() > deadline) {
        return {
          // REPORT THE SWITCH WE ACTUALLY SAW (Codex #1853 r37). Every
          // return in this loop used to hardcode `false` here, which was
          // inert while the value went unread — and stopped being inert
          // last round, when `readinessBlock`'s consumption was hoisted
          // out of the `!switchThere` branch. A card that oscillates
          // while its switch is plainly rendered was then filed under
          // the missing-switch route.
          //
          // `switchThere` is the count taken in THIS iteration, between
          // the two verdict reads; it is the observation, not an
          // assumption about it.
          jumps: 0, switchThere, toolsFailed: false, timedOut: true,
          settled: 'blocked-unstable',
        };
      }
      await page.waitForTimeout(1_000);
      continue;
    }
    // CONTROLS PRESENT AND SETTLED IS THE HEALTHY CASE, and it is
    // checked before any verdict is applied to their absence (Codex
    // #1853 r32). Round 31 moved the readiness read ahead of this
    // count and let its verdict return first — which turned
    // `ready`/`yes` into the missing-switch contradiction on a page
    // that has no switch because it is ALREADY in Advanced, jump
    // buttons rendered and working. `ModeContext` persists the mode,
    // so every position after the first arrives that way: the default
    // three-position run would have reported a product regression on
    // pages 2 and 3 and never audited them.
    //
    // `ready`/`yes` is a contradiction only when there is nothing on
    // screen to reach the row with. With jumps present it is the card
    // agreeing with itself.
    // ACCEPTED ONLY WHEN THE CARD AGREES (Codex #1853 r34). Excluding
    // just `blocked-pending` let every other non-agreeing verdict
    // through: a card reporting `ready`/`no` while a stale jump button
    // is still rendered passed both bracket reads as
    // `claims-unjumpable`, the
    // audit ran on that button, and the review exited 0 on a card
    // contradicting its own verdict. `blocked-failed` and
    // `blocked-malformed` took the same route.
    //
    // Only two verdicts justify acting on what is rendered:
    // `claims-jumpable`, which is `ready`/`yes` — the card saying a row
    // IS jumpable, so buttons are consistent with it — and `unknown`, a
    // legacy bundle where the controls are the only evidence there is.
    //
    // (The paragraph that stood here apologised for the old name: `fail`
    // meant CONTRADICTION with nothing rendered and AGREEMENT with
    // controls present, and the reader had to hold the inversion. #1869
    // renamed the outcome to what the card SAID, which is the same in
    // both places; whether saying it is a failure is this caller's
    // judgement to make and now reads as one.)
    const agrees = readinessAgreesWithControls(lastVerdict);
    if ((jumps > 0 || switchThere) && agrees) {
      return { jumps, switchThere, toolsFailed: false, timedOut: false };
    }
    // Rendered controls the card does not stand behind.
    // `claims-unjumpable` is the stable disagreement — both bracket reads said no row is jumpable
    // while a jump control was on screen — and gets its own reason
    // rather than borrowing one that would misdescribe it.
    // SETTLED disagreements only (Codex #1853 r35). Round 34's version
    // returned on `blocked-pending` here too, so a card mid-refetch
    // still showing its controls exited on the first poll and the
    // caller announced a deadline that was never reached. That is
    // round 30's defect verbatim, reintroduced through the branch
    // added to fix a different one — pending is not a disagreement,
    // it is the card not having answered yet.
    if ((jumps > 0 || switchThere) && lastVerdict !== 'blocked-pending') {
      return {
        jumps: 0,
        // KEPT, not zeroed. The r35 P3 was about `advancedOffered`
        // being hardcoded on the post-click path; the same information
        // is discarded here if this reports no switch when one was on
        // screen. Applying the finding to its sibling rather than
        // waiting to be told about it.
        switchThere,
        toolsFailed: false,
        timedOut: false,
        settled: lastVerdict === 'claims-unjumpable' ? 'blocked-contradiction' : lastVerdict,
      };
    }
    // Nothing rendered (or the card says not to trust what is). Now the
    // verdict about an ABSENCE is the right question to ask.
    if (
      jumps === 0 &&
      !switchThere &&
      lastVerdict !== 'unknown' &&
      lastVerdict !== 'blocked-pending'
    ) {
      return {
        jumps: 0, switchThere: false, toolsFailed: false, timedOut: false,
        settled: lastVerdict,
      };
    }
    // Same auto-wait trap as the recorder above (Codex #1853 r22):
    // this ran every iteration, and on an absent card each one blocked
    // for the default timeout instead of the 1s the loop intends.
    const text = (await readLenderCardText(page, card)) ?? '';
    if (FAILED.test(text)) {
      return { jumps: 0, switchThere, toolsFailed: true, timedOut: false };
    }
    if (Date.now() > deadline) {
      // A DEADLINE IS NOT AN ANSWER WHILE THE ROWS SAY THEY ARE STILL
      // READING (Codex #1853 r19). `timedOut` was returned here and
      // inspected by neither caller, so 45 seconds of a page whose
      // prerequisite query is genuinely stuck — the driver's own chain
      // reads succeeding the whole time — read as "no jumpable row" and
      // exited 0 with no mode switch and no anchor audited.
      //
      // The distinction is what the rows themselves report at the
      // moment the clock runs out. A settled unavailability reason is
      // an answer, and "no jumpable row" is the honest verdict for it.
      // The checking sentence is not an answer, and outlasting the
      // deadline makes it a failure to observe, not an observation.
      return {
        jumps: 0,
        switchThere,
        toolsFailed: false,
        timedOut: true,
        stillPending: PENDING.test(text),
        // Carried so the caller can say WHY the clock ran out when the
        // card itself was still reporting `pending`.
        settled: lastVerdict === 'blocked-pending' ? 'blocked-pending' : undefined,
      };
    }
    await page.waitForTimeout(1_000);
  }
}

/**
 * The lender card, as ONE locator every consumer shares.
 *
 * Both the probe and the late rescrape need it, and a second copy of
 * this filter is a second statement of "which card is the lender's" —
 * the defect class this PR chain is about, in the file that keeps being
 * reviewed for it.
 */
function lenderCardOf(page) {
  return page.locator('section.card').filter({ hasText: CHOOSER.title }).first();
}

/**
 * The card's OWN answer to the question this probe keeps guessing at.
 *
 * `LenderExitOptionsCard` publishes `data-chooser-ready` (has the
 * jumpability question settled) and `data-chooser-jumpable` (what it
 * settled to) — the whole point of #1855, and shipped in `5bd8077`.
 * Until this read existed the drive inferred both from an ABSENCE:
 * no switch on the page, so presumably no jumpable row. That inference
 * cannot tell a still-loading card from a genuinely unjumpable one,
 * and — the case that makes it a P1 rather than a slow path — it
 * cannot tell either of them from a Basic-mode regression that drops
 * the switch while the card itself says `ready` / `yes` (Codex #1853
 * r28). That contradiction is a product defect the card is TELLING us
 * about, and the drive was reporting it as an ordinary unavailable
 * row and exiting 0.
 *
 * Returns `null` when the attributes are absent — an older bundle, or
 * no card — so callers fall back to their previous behaviour rather
 * than inventing a verdict from a missing element.
 */
async function chooserSelfVerdict(page) {
  // ONE BOUNDED DOM READ, not two auto-waiting locator calls (Codex
  // #1853 r30). `getAttribute` auto-waits for the element, and this
  // context sets no default timeout — so a card unmounted between the
  // `count()` and the read (an ownership or status refresh, which is
  // precisely what the surrounding window watches for) blocked the
  // poll indefinitely and sailed past the 45-second deadline it lives
  // inside. Polling every tick turned a rare hang into a repeated
  // exposure. The same auto-wait trap this file already fixed twice,
  // on a third API.
  //
  // `evaluate` returns whatever is in the DOM at that instant and
  // never waits for anything, so an absent card is `null` in one
  // round trip rather than a stall.
  return await page
    .evaluate(() => {
      const el = document.querySelector('[data-testid="lender-exit-card"]');
      if (!el) return null;
      const ready = el.getAttribute('data-chooser-ready');
      const jumpable = el.getAttribute('data-chooser-jumpable');
      return ready === null && jumpable === null ? null : { ready, jumpable };
    })
    // A READ THAT FAILED IS NOT A CARD THAT SAID NOTHING (#1873).
    //
    // This used to be `.catch(() => null)`, and `null` is the legacy
    // answer: it means "this bundle publishes no attributes, so accept
    // the rendered controls as the only evidence there is". An
    // `evaluate` that threw — the page navigated, the context closed,
    // the frame detached — knows nothing about the bundle, and turning
    // it into a positive instruction to trust the DOM is the
    // silent-pass shape the whole three-verdict contract exists to
    // prevent. "Could not look" is BLOCKED.
    //
    // NOT reused as `{ ready: 'failed' }`, which would map to the
    // existing `blocked-failed` and cost nothing to write. That verdict's
    // reason says `data-chooser-ready="failed"` — a statement about what
    // the CARD published — and the card published nothing here; our own
    // read fell over. One message serving two different findings is a
    // defect this file has already been reviewed for.
    .catch(() => ({ readFailed: true }));
}

/**
 * The card's text, or `null`, WITHOUT paying an auto-wait for absence.
 *
 * `innerText()` auto-waits: on a card that is not there it blocks for
 * Playwright's default 30 seconds before the `.catch` runs. Round 22
 * fixed that at the two sites the finding named and left the initial
 * scrape — which runs after the separate 45s chooser wait and before
 * the probe's own 45s window, so an absent-card visit could still pass
 * two minutes (Codex #1853 r23).
 *
 * That is the NINTH time on this PR that a rule was applied to the
 * sites a finding named rather than to every site it governs, and the
 * eighth was the same rule one round earlier. So this is a function
 * rather than a pattern: a `count()` guard somebody has to remember is
 * a rule, and a rule is what keeps being forgotten.
 *
 * `count()` does not auto-wait, so absence is free; the bounded
 * `timeout` covers a card that unmounts between the two calls.
 */
async function readLenderCardText(page, card) {
  const target = card ?? lenderCardOf(page);
  if ((await target.count()) === 0) return null;
  return await target.innerText({ timeout: 2_000 }).catch(() => null);
}

/**
 * The scrape can be too EARLY as well as too late (Codex #1853 r17).
 *
 * If the ownership, status or sanctions reads outrun the initial card
 * scrape, the visit records `chooser: false` and an empty row shape —
 * and then this probe goes on to observe the card, click its switch and
 * audit its anchors successfully. The reporter was still reading the
 * earlier cached absence, so a healthy late-rendering page was filed as
 * `lender chooser MISSING` along with every row, on the same visit that
 * had just interacted with that card.
 *
 * Every previous fix here treated the scrape as authoritative and the
 * probe as the thing needing qualification. This is the same fact from
 * the other end: a later positive observation is BETTER evidence than an
 * earlier absence, because the card cannot un-render into having been
 * there.
 *
 * MEMOIZED, AND MERGED AT ONE EXIT (Codex #1853 r18). Round 17 spread
 * the rescrape into the two returns that carry an anchor audit and left
 * every other settled return without it — so a card that mounted late
 * and legitimately had no jumpable row (a past-maturity position, which
 * is most of the live chain) kept the scrape's `chooser: false` and was
 * filed as `lender chooser MISSING` by the very probe that had just read
 * its text. Two consumers of one question, a distinction drawn in one
 * and not its siblings, for the seventh time on this PR.
 *
 * Sticky because it must not be re-derived at the exit: a card observed
 * mid-probe and unmounted by the time the probe returns is still a card
 * that was there, and re-reading at the end would throw that evidence
 * away — reintroducing the same bug in a narrower window.
 */
function lateScrapeRecorder(page, cardAbsentAtScrape) {
  let seen = null;
  return {
    /** Record the card if it is on the page right now. Idempotent.
     *
     *  COUNT BEFORE TEXT, and it is not a micro-optimisation (Codex
     *  #1853 r22). `innerText()` AUTO-WAITS — on an absent card it
     *  blocks for Playwright's default 30s before the `.catch` runs.
     *  On the page this exists for — the one where the scrape saw no
     *  card — that is minutes spent inside a routine the drive treats
     *  as free. The 45s deadline the drive advertises was being blown
     *  by the code that reports on it.
     *
     *  CALLED TWICE, not per poll, and the previous wording here said
     *  per poll. That is worth correcting rather than tidying: it is
     *  the sentence somebody reads before deciding whether the sale-row
     *  wait can return early on an absent card, and it makes the wait
     *  look like the window in which a late mount is captured. It is
     *  not. Capture happens once at the probe's start and once after it
     *  returns, so what the wait actually contributes is ELAPSED TIME
     *  before that second capture — which is still load-bearing for a
     *  card that mounts late, just by a different mechanism than this
     *  comment claimed.
     *
     *  `count()` does not auto-wait, so absence costs nothing; the
     *  bounded `timeout` covers a card that unmounts between the two
     *  calls. */
    async capture() {
      if (!cardAbsentAtScrape || seen) return;
      const text = await readLenderCardText(page);
      if (text !== null) seen = { chooser: true, cardRescraped: true, ...lenderShapeOf(text) };
    },
    /** Did the recorder ever observe the card? Distinct from `value`,
     *  which a caller spreads — this is the fact the vanish check needs
     *  (Codex #1853 r22). */
    get recorded() {
      return seen !== null;
    },
    /** What was recorded, or nothing — never a fabricated absence. */
    get value() {
      return seen ?? {};
    },
  };
}

/**
 * Watches for a REVERSIBLE status transition inside the probe window.
 *
 * The third axis on which a round trip hides (Codex #1853 r24).
 * Ownership round trips are caught by the DOM — the card unmounts.
 * A FallbackPending excursion is not: the card deliberately stays up
 * to explain it, while `buildLenderExitRows` removes both jumps. So
 * before and after agree, the card never disappears, and the honest
 * behaviour reads as a no-op-switch FAIL.
 *
 * SPARSE ON PURPOSE, and the limit is stated rather than hidden: one
 * chain read every `EVERY` poll ticks, so a transition that opens
 * and closes between two samples is still invisible. That is a real
 * gap and it is smaller than the one it replaces; #1855's readiness
 * attribute removes the guess rather than narrowing it.
 *
 * Cheap by construction — a no-op when there is no loan to read, and
 * it stops sampling once it has seen something, since one
 * observation is all the verdict needs.
 *
 * HOISTED TO THE WRAPPER (Codex #1853 r27), for the same reason
 * `before` was in r21: the excursion explains a zero-jump outcome on
 * EVERY route, and while it lived inside the probe only the two
 * returns that remembered to ask were covered.
 */
function statusWatcher(loan, before) {
  const EVERY = 8;
  let tick = 0;
  let seen = null;
  return {
    async sample() {
      if (!loan || seen) return;
      // A TRANSITION, not a state (Codex #1853 r25). Without the
      // baseline test the first sample of an ALREADY-unjumpable
      // position records an "excursion" that never happened — and
      // because the verdict consults this before its
      // already-unjumpable arm, the run would report the wrong one
      // of the two, which is the confidently-wrong diagnosis round
      // 22 was about, reintroduced by round 24's fix.
      if (snapshotJumpable(before, observed) !== true) return;
      if (tick++ % EVERY !== 0) return;
      const mid = await jumpabilitySnapshot(loan);
      if (mid && snapshotJumpable(mid, observed) === false) {
        // `jumpabilityMoved` is the authority on WHAT moved; the
        // fallback only covers an input it does not model, and is
        // reachable only because the baseline above was jumpable.
        seen = jumpabilityMoved(before, mid) ?? 'the position stopped being sellable mid-probe';
      }
    },
    get excursion() {
      return seen;
    },
  };
}

/**
 * The single merge point for the Advanced probe.
 *
 * The probe's own verdict wins on every key it sets; the late rescrape
 * only fills in the card-shape keys the initial scrape missed, and the
 * two sets do not overlap.
 */
async function lenderAdvancedOf(page, loan, cardAbsentAtScrape = false) {
  const late = lateScrapeRecorder(page, cardAbsentAtScrape);
  // HOISTED OUT OF THE PROBE (Codex #1853 r21) so the wrapper can apply
  // the stale-owner verdict to EVERY exit. Its ordering constraint is
  // unchanged and in fact strengthened: it still predates the first
  // observation of the switch, which is what r13 required.
  const before = loan ? await jumpabilitySnapshot(loan) : null;
  // ONE watcher across the whole probe, so an excursion seen before the
  // click still explains a zero-jump result after it.
  const watch = statusWatcher(loan, before);
  const result = await lenderAdvancedProbe(page, loan, cardAbsentAtScrape, late, before, watch);
  // Last chance, for a card that mounted after the probe's own capture.
  await late.capture();
  // A SUCCESSFUL AUDIT OF SOMEBODY ELSE'S CARD IS STILL NOT A PASS
  // (Codex #1853 r21). Round 20 put this test on the zero-jump routes,
  // where the finding had surfaced — but a stale card keeps its switch
  // AND its jump buttons until the page's 60-second ownership refresh,
  // so the anchors resolve, the audit succeeds and the run exits 0
  // having reviewed a position the observed wallet does not hold. That
  // is the same defect the round-20 fix was about, on the one route
  // where the outcome looks like success.
  //
  // Applied HERE rather than at the two audit returns, because "here"
  // is every return there will ever be. `advancedBlocked` results are
  // left alone: they already carry a reason, and overwriting it with
  // this one would lose the more specific finding.
  if (!result.advancedBlocked && snapshotCardEligible(before, observed) === false) {
    // NAME THE FIELD THAT FAILED (Codex #1853 r22). `snapshotCardEligible`
    // is false for three different reasons, and this sentence asserted
    // the rarest of them: a terminal loan and a sanctions-flagged
    // holder both land here with the token still held by the observed
    // wallet, and the reader was sent to investigate an ownership
    // transfer that never happened. A diagnosis is worth less than
    // nothing when it is confidently wrong about where to look.
    const why = !before
      ? 'the pre-state could not be read'
      : before.holder === null
        ? 'the lender token was already burned'
        : observed && before.holder !== String(observed).toLowerCase()
          ? 'the observed wallet did not hold the position — the page can keep the ' +
            'card mounted, switch and jumps included, for up to 60s after ownership moves'
          : before.flagged
            ? 'the holder was sanctions-flagged, which correctly suppresses the card'
            : 'the loan was already terminal';
    return {
      ...late.value,
      ...result,
      advancedJumps: null,
      advancedBlocked: true,
      // A LATE CAPTURE DEFEATS THE SUPPRESSION (Codex #1853 r26).
      // This flag exists to discard observations of a card that was
      // correctly absent — but the sticky recorder may since have
      // observed that card WITH A ROW MISSING, and `late.value`
      // replaces the scrape's absence in the merged result. Suppressing
      // on the original absence then throws away a positively observed
      // shape failure, which is the direction round 16 established must
      // never happen.
      advancedPreRaced: cardAbsentAtScrape && !late.recorded,
      advancedWhy: `the card was audited on a state it should not have rendered for: ${why}`,
    };
  }
  // A SAMPLED EXCURSION EXPLAINS EVERY ZERO-JUMP EXIT (Codex #1853
  // r27), and applying it here is what makes that true. Round 24 put
  // the check on the two returns where the race had been seen, and the
  // route that ends "no jumpable row" — the switch never appeared, the
  // deadline passed — walked straight past it: the page can keep its
  // cached unavailable rows after the loan has already cured, so both
  // end-samples read Active, the card is still mounted, and the run
  // exits clean having RECORDED the exact race the watcher exists to
  // catch.
  //
  // BLOCKED, not FAIL. A transition inside the window means the
  // observation is ambiguous rather than wrong, which is the same
  // verdict the other excursion routes reach.
  //
  // The precedence and the which-results-qualify test live in
  // `excursionExplains` so they are exercised rather than asserted —
  // this driver's own r13 lesson, on a rule with the same history.
  // A SUCCESSFUL AUDIT OF CONTROLS THAT SHOULD NOT EXIST IS NOT A PASS
  // (Codex #1853 r31). The wrapper already applies `snapshotCardEligible`
  // to every exit — but that test is deliberately LOOSE, because the
  // card legitimately stays mounted past maturity, under a position
  // lock, and on FallbackPending. In all three the card is entitled to
  // be there and the JUMPS are not, so a page still showing cached
  // buttons from an earlier render gets audited, passes, and exits 0.
  //
  // The strict `snapshotJumpable` test existed for exactly this and was
  // applied only where there were no jumps to audit. That is the shape
  // this PR keeps producing: rigour on the failing path, the cached
  // answer taken on the successful one. Positive jumps are now held to
  // the same pre-state as their absence.
  //
  // BLOCKED, not FAIL: the card rendering stale controls after a chain
  // transition is a refresh-interval artefact, not a product defect —
  // the same reading the zero-jump side gives it.
  if (
    !result.advancedBlocked &&
    typeof result.advancedJumps === 'number' &&
    result.advancedJumps > 0 &&
    snapshotJumpable(before, observed) === false
  ) {
    return {
      ...late.value,
      ...result,
      advancedJumps: null,
      advancedBlocked: true,
      advancedWhy:
        'the anchors audited cleanly, but the chain says this position was ' +
        'already unjumpable when first read — past maturity, locked, or ' +
        'settling a fallback — so the buttons were a stale render and the ' +
        'audit proved nothing about a live one',
    };
  }
  if (excursionExplains(result, watch.excursion)) {
    return {
      ...late.value,
      ...result,
      advancedJumps: null,
      advancedBlocked: true,
      advancedRaced: true,
      advancedWhy: `the position was briefly unsellable during the probe: ${watch.excursion}`,
    };
  }
  return { ...late.value, ...result };
}

/**
 * The BLOCKED result a readiness verdict implies, or null.
 *
 * One mapping, because there are two paths that end in "no jumps" —
 * the switch never appeared, and the switch was clicked and revealed
 * nothing — and only the first consumed the card's verdict (Codex
 * #1853 r34). The post-click path called the no-op-switch judgement
 * directly, so an unstable, failed or malformed readiness answer
 * became a product FAIL there whenever the chain snapshots still
 * looked jumpable.
 *
 * That is this PR's own recurring defect once more: a rule written at
 * the site a finding pointed to and not at its sibling. It is a
 * function now rather than a switch in one branch, so the next path
 * that ends in zero jumps has to go through it.
 *
 * `unknown` and `claims-unjumpable` return null deliberately: the
 * first is a legacy bundle with nothing to say, the second is the card
 * settling on "no row is jumpable", which is the honest absence and
 * not a block.
 */
function readinessAgreesWithControls(verdict) {
  // The allowlist, in ONE place (Codex #1853 r35). Round 34 wrote it
  // inside the poll and left the pre-switch branch on its own
  // `blocked-pending`-only test, so a card offering a switch beside a
  // stable `ready`/`no`, a failed read or an unreadable contract was
  // still clicked. Same rule, two sites, one updated — the defect this
  // PR is about, on the fix for that defect.
  //
  // `claims-jumpable` is `ready`/`yes`: the card saying a row IS
  // jumpable, which agrees with controls being on screen. `unknown` is a legacy bundle
  // publishing nothing, where the controls are the only evidence there
  // is. Nothing else licenses acting on a rendered control.
  return verdict === 'claims-jumpable' || verdict === 'unknown';
}

function readinessBlock(settled, offered = false) {
  const why = {
    'blocked-pending':
      'the lender card had not settled its jumpability question by the ' +
      'deadline (data-chooser-ready="pending")',
    'blocked-unstable':
      'the lender card kept changing its readiness answer for the whole 45s ' +
      'window, so no reading of it and its controls was ever taken at one moment',
    'blocked-failed':
      'a read the lender card needs stopped without answering ' +
      '(data-chooser-ready="failed"), so the absence of jumps is unexplained ' +
      'rather than correct',
    'blocked-malformed':
      'the lender card published a readiness contract this drive cannot read ' +
      '— a partial or unrecognised data-chooser-ready/jumpable pair — so its ' +
      'controls cannot be judged either way',
    'blocked-contradiction':
      'the lender card rendered jump controls while its own verdict said no ' +
      'row is jumpable; the two come from one computation in one render, so ' +
      'they disagreeing means the controls cannot be trusted as live',
    // OUR failure, not the card's (#1873), and worded so a reader is not
    // sent looking at the page for a fault that is on this side of it.
    'blocked-unreadable':
      "this drive's own read of the lender card's readiness attributes threw " +
      '— the page navigated, the context closed, or the frame detached — so ' +
      'nothing was learned about what the card was reporting',
  }[settled];
  if (!why) return null;
  return {
    // Carried by the caller (Codex #1853 r35). The post-click path
    // reaches here only after the switch was offered AND clicked, so
    // hardcoding `false` filed those failures under the missing-switch
    // route and hid which branch actually failed.
    advancedOffered: offered,
    advancedJumps: null,
    advancedBlocked: true,
    advancedWhy: why,
  };
}

async function lenderAdvancedProbe(page, loan, cardAbsentAtScrape, late, before, watch) {
  const SWITCH = /Show these tools \(switches to Advanced view\)/i;
  // SCOPED TO THE LENDER CARD (Codex #1853 r5). The borrower chooser
  // uses the IDENTICAL labels — `copy.earlyRepay.switchToAdvanced` and
  // `.jump` are the same strings as the lender card's — so on a dual
  // holder, who renders BOTH cards, a page-global query could click the
  // borrower's switch and count the borrower's jump buttons as the
  // lender's. That is the exact population I argued to KEEP in the pool
  // one round earlier, so the probe would have mis-measured precisely
  // the case I defended.
  const card = lenderCardOf(page);
  const sw = card.getByRole('button', { name: SWITCH });
  // Snapshot BEFORE anything observes the switch (Codex #1853 r13).
  // Round 12 took it after `sw.count()` had already decided, so a loan
  // that went FallbackPending WHILE the snapshot was running recorded
  // `active: false` in BOTH reads — no change, and the healthy race
  // reported as a product FAIL. The pre-state has to predate the
  // decisive observation, not merely the click.
  //
  // Paid on every detail page, including ones that never offer a
  // switch. That is the cost of the ordering being load-bearing; five
  // reads is the wrong thing to economise on here. Taken by the WRAPPER
  // and passed in (Codex #1853 r21), so the stale-owner verdict can be
  // applied to every exit rather than to the routes that surfaced it.

  const jumpsOf = () => card.getByRole('button', { name: /Go to this option/i });
  const cardPresent = async () => (await card.count()) > 0;
  // EAGER, and before any branch decides anything (Codex #1853 r18).
  // Taken here rather than per-return so no route can be the one that
  // forgets: if the card is already on the page, its shape is banked now
  // and every exit carries it.
  await late.capture();


  /**
   * Did the card VANISH between being scraped and now?
   *
   * A reversible transition leaves no trace in a before/after: the
   * position transfers away, the page's 60-second ownership poll
   * unmounts the card, and it transfers back — two identical chain
   * samples, and a card that demonstrably went missing between them.
   * Only the DOM can see that round trip (Codex #1853 r17/r20).
   *
   * SCOPED TO THE UNEXPLAINED-OUTCOME ROUTES on purpose (Codex #1853
   * r21). Its sibling test — "the pre-state says the card was never
   * this wallet's" — moved to the wrapper, because that one must reach
   * a SUCCESSFUL audit too. This one must not: an audit that completed
   * against a rendered card produced real observations, and a card
   * disappearing afterwards does not retract them.
   *
   * The two were briefly bundled together, which is how the difference
   * became visible: one belongs on every exit, the other only where
   * nothing was learned.
   */
  const vanishedCardVerdict = async (offered) => {
    // EITHER OBSERVATION COUNTS (Codex #1853 r22). The condition was
    // `!cardAbsentAtScrape`, which asks whether the INITIAL scrape saw
    // the card — and on a slow-mounting page the initial scrape is
    // exactly the one that missed it while the sticky recorder caught
    // it a moment later and the probe went on to click its switch.
    // With the check disabled on that route, a transfer away and back
    // left two agreeing snapshots and no DOM evidence, and the healthy
    // race was reported as a no-op-switch product FAIL.
    //
    // The question is "was this card ever observed", and the recorder
    // is an observer. It was added to make a late card count; not
    // consulting it here left it counting for the report and not for
    // the reasoning.
    const everObserved = !cardAbsentAtScrape || late.recorded;
    if (everObserved && !(await cardPresent())) {
      return {
        advancedOffered: offered,
        advancedJumps: null,
        advancedBlocked: true,
        advancedRaced: true,
        advancedWhy:
          'the lender card was scraped and then vanished during the probe — ' +
          'a transition reversed inside the window, so no audit was possible',
      };
    }
    return null;
  };

  /**
   * The one verdict for "the card ended up with no jump button".
   *
   * Every route into that outcome routes through here (Codex #1853
   * r14): the post-click settle, the anchor audit after a click, and the
   * anchor audit on a page already in Advanced. Three call sites reached
   * it before and only one revalidated — which is this PR's own recurring
   * defect, a distinction drawn in one consumer of a question and not in
   * its siblings.
   *
   * Three outcomes, in order of what they establish:
   *
   *   1. THE CHAIN MOVED under the probe → BLOCKED. The card withdrew
   *      its rows for a real reason and is behaving correctly.
   *   2. THE PRE-STATE WAS ALREADY UNJUMPABLE → BLOCKED, ambiguity
   *      named. `PositionDetails` refreshes the live status only every
   *      30 seconds, so the switch can still be rendered from an earlier
   *      Active read after the chain has moved. Snapshotting earlier
   *      cannot fix that — the page rendered before the drive looked at
   *      all — so a stale render and a genuine Basic-mode regression are
   *      indistinguishable from outside the card. Reporting either as
   *      the other is a lie; #1855's test hook is what would separate
   *      them.
   *   3. THE PRE-STATE WAS JUMPABLE and nothing moved → FAIL. Only here
   *      has the card genuinely contradicted itself.
   */
  const noJumpVerdict = async (offered = true) => {
    const moved = loan ? jumpabilityMoved(before, await jumpabilitySnapshot(loan)) : null;
    if (moved) {
      return {
        advancedOffered: offered,
        advancedJumps: null,
        advancedBlocked: true,
        // A FLAG, not a phrase the reporter greps for (Codex #1853 r14
        // adjacent). The suppression below used to test
        // `/chain state moved/` against our own `advancedWhy`, so
        // rewording this sentence would silently switch the suppression
        // off and start reporting healthy races as product regressions —
        // the copy-matching fragility this drive keeps being reviewed for,
        // in the drive's own reporter.
        advancedRaced: true,
        advancedWhy: `chain state moved during the probe: ${moved}`,
      };
    }
    // Ahead of the already-unjumpable arm: "this card was never yours"
    // and "this card had nothing to offer" are different findings, and
    // the first is the more decisive (Codex #1853 r20).
    const stale = await vanishedCardVerdict(offered);
    if (stale) return stale;
    // The excursion arm that used to sit here has moved to the
    // wrapper's single exit (Codex #1853 r27) — it applies to every
    // return, including the ones that never reach this verdict.
    if (snapshotJumpable(before, observed) === false) {
      return {
        advancedOffered: offered,
        advancedJumps: null,
        advancedBlocked: true,
        advancedWhy:
          'no jump on a position that was already unjumpable when first read — ' +
          'the page refreshes status every 30s, so a stale render and a regression ' +
          'are indistinguishable from here (#1855)',
      };
    }
    return {
      advancedOffered: offered,
      advancedJumps: 0,
      advancedAnchorsOk: false,
      // The reason has to match which control was actually on the page
      // (Codex #1853 r16). A later detail page inherits Advanced mode
      // from `ModeContext`, so it reaches this verdict with NO switch
      // ever rendered — and the reporter prints this string as the FAIL
      // diagnosis, sending the reader to investigate a Basic-mode control
      // that was never there. Same defect as the anchor sentence one
      // round ago: one message serving two different findings.
      advancedWhy: offered
        ? 'switch offered but no jump rendered after it settled'
        : 'already in Advanced, and no jump rendered after the rows settled',
    };
  };
  try {
    // A CACHED SWITCH IS NOT AN ACTIONABLE ONE (Codex #1853 r32). This
    // branch decided whether to wait at all, so a Basic-mode card
    // mid-refetch — publishing `pending` while its previous switch is
    // still rendered — skipped the wait entirely and went straight to
    // the click, and the reordered readiness check inside the wait
    // never ran. Consulting the card here routes that page into the
    // wait, where `pending` keeps polling until the read settles; if
    // the switch is still there afterwards, the code below falls
    // through to the click exactly as before.
    const preSwitchVerdict = missingSwitchVerdict(await chooserSelfVerdict(page));
    if ((await sw.count()) === 0 || !readinessAgreesWithControls(preSwitchVerdict)) {
      // NO SWITCH means one of two different things, and the first
      // version of this probe reported them identically. The card
      // renders the switch only when it is in Basic mode AND some row
      // is jumpable, so its absence is either "already in Advanced"
      // (jumps present, anchors still worth checking) or "no row is
      // jumpable" (nothing to check, and legitimately so).
      //
      // WAIT FIRST (Codex #1853 r9). `ModeContext` persists
      // `alpha02.mode`, so once any page in this shared browser context
      // switches to Advanced, every LATER detail page renders in
      // Advanced from the start — and hits the same loading interval at
      // first render, where a slow `loanLive` leaves neither switch nor
      // jumps. Round 7 fixed that wait for the post-click path only, so
      // page 2 onward could be labelled `no jumpable row` and exit 0
      // without ever auditing a row that became jumpable a second later.
      const settled = await waitForSaleRows(
        card, jumpsOf, page, () => sw, late, () => watch.sample(),
        () => chooserSelfVerdict(page),
      );
      if (settled.jumps === 0) {
        // AN OBSERVATION OUTRANKS A LATER TRANSITION (Codex #1853
        // r30). The card said `ready`/`yes` and rendered no switch —
        // a contradiction that existed at the moment it was read, so
        // nothing that happens afterwards can retract it. Consumed
        // here, ahead of the disappearance and post-state checks,
        // because those explain an ORDINARY absence and would
        // otherwise convert a positively observed product failure into
        // BLOCKED whenever the loan moved or the card unmounted right
        // after the bad render.
        //
        // This is the same asymmetry this probe already applies to the
        // card scrape: a transition detected during the probe cannot
        // invalidate an observation the probe made before it. I wrote
        // that rule and then ordered this verdict behind the checks it
        // governs.
        if (settled.settled === 'claims-jumpable') {
          return {
            advancedOffered: false,
            advancedJumps: 0,
            advancedAnchorsOk: false,
            advancedFailed: true,
            advancedWhy:
              'the lender card reports a settled jumpable row ' +
              '(data-chooser-ready="ready", data-chooser-jumpable="yes") ' +
              'and rendered no switch to reach it',
          };
        }
        if (settled.toolsFailed) {
          return {
            // SAME CARRY AS `readinessBlock` (Codex #1853 r37). These
            // two returns sit either side of the block consumption and
            // describe the same kind of outcome — the drive stopped
            // before the switch could be used — so hardcoding `false`
            // here would keep filing them under "no switch was offered"
            // for the exact cases the round-37 fix is about.
            advancedOffered: settled.switchThere === true,
            advancedJumps: null,
            advancedBlocked: true,
            advancedWhy: 'a prerequisite read failed — sale tools unavailable',
          };
        }
        // CONSUMED ON BOTH PATHS (Codex #1853 r36). This sat inside the
        // `!settled.switchThere` branch, so preserving `switchThere` on
        // the disagreement return — last round's fix, made so the
        // report could say a switch had been offered — routed those
        // results straight past their only consumer and into the click.
        // The allowlist added in round 35 was bypassed by the change
        // made in round 35.
        //
        // A verdict that blocks does so whether or not a switch is on
        // screen; the switch is what the verdict is ABOUT. Gating the
        // consumption on it was always backwards, and only became
        // reachable once the observation stopped being discarded.
        const blocked = readinessBlock(settled.settled, settled.switchThere === true);
        if (blocked) return blocked;
        // STILL SAYING "READING" AT THE DEADLINE IS NOT AN ANSWER
        // (Codex #1853 r19). `timedOut` was computed and then inspected
        // by neither caller, so a page whose prerequisite query is
        // genuinely stuck — while this driver's own chain reads keep
        // succeeding — spent 45 seconds and reported `no jumpable row`.
        // The rows had not settled; the clock had.
        //
        // A settled unavailability reason at the deadline still means
        // "no jumpable row", which is why this turns on what the rows
        // SAY rather than on the timeout alone.
        if (settled.stillPending) {
          return {
            advancedOffered: settled.switchThere === true,
            advancedJumps: null,
            advancedBlocked: true,
            advancedWhy:
              'the sale rows were still reading their prerequisites when the ' +
              '45s deadline expired — the page never settled, so nothing was observed',
          };
        }
        // A full deadline with neither jump nor switch IS the conclusive
        // "no jumpable row" — that is what the wait now means.
        // RE-CHECK THE SWITCH (Codex #1853 r10). On a Basic page still
        // loading at first render there is no switch AND no jumps, so we
        // land here — but once `saleTools` becomes ready the switch
        // APPEARS, while Basic mode still has zero jump buttons by
        // design. Returning `no jumpable row` on the first look meant a
        // healthy, genuinely jumpable page exited 0 without ever
        // switching modes or auditing an anchor.
        //
        // The absence of a switch is only meaningful once the reads it
        // depends on have settled, which is exactly what we just waited
        // for.
        if (!settled.switchThere) {
          // NO SWITCH is the ordinary, correct outcome on a position
          // with nothing to jump to — every past-due lender position on
          // the live chain lands here — so it must NOT be routed through
          // `noJumpVerdict`, which would BLOCK all of them.
          //
          // But it is also where a page that never mounted the CARD ends
          // up (Codex #1853 r15). `stillEligible` is re-read immediately
          // before the visit, and the loan can still go terminal, be
          // transferred away, or have its holder flagged during
          // navigation and the 45s wait — after which the card correctly
          // never renders. The shape scrape upstream then sees no card
          // and the reporter files `chooser MISSING` as a product
          // regression, because nothing had marked the route as raced.
          //
          // Re-read the chain and ask the CARD's own mount question,
          // which is much looser than jumpability: past maturity and
          // FallbackPending both keep it mounted. Only a genuinely
          // unmountable pre-state suppresses the shape assertions.
          const cardGoneNow = !(await cardPresent());
          if (cardGoneNow) {
            const pre = snapshotCardEligible(before, observed);
            // BOTH conditions, and the first is the one round 15 lacked
            // (Codex #1853 r16). `cardAbsentAtScrape` is what the shape
            // scrape actually saw; `pre` is a chain read taken later that
            // can merely EXPLAIN an absence. Requiring both means a card
            // that did render — with a row missing — keeps its finding no
            // matter what the chain did afterwards, because the
            // observation was real when it was made.
            if (cardAbsentAtScrape && pre === false) {
              return {
                advancedOffered: false,
                advancedJumps: null,
                advancedBlocked: true,
                // A DIFFERENT flag from `advancedRaced`, and the
                // difference is which observations it may discard. This
                // transition predates the shape scrape, so those
                // observations are of a correctly-absent card and must
                // be suppressed. `advancedRaced` marks a transition
                // DURING the probe, which cannot have affected a scrape
                // that already happened — see the reporter.
                advancedPreRaced: true,
                advancedWhy:
                  'the lender card could not be mounted when the probe read the chain — ' +
                  'the position went terminal, left this wallet, or its holder was flagged ' +
                  'before the page rendered',
              };
            }
            // THE WAIT IS ALSO A WINDOW (Codex #1853 r16). `before` can
            // be perfectly jumpable and the card still unmount during the
            // 45 seconds `waitForSaleRows` spends polling — the loan goes
            // terminal, the position is sold, the holder is flagged. The
            // pre-state test above cannot see that by construction, so
            // the route returned `no jumpable row` and exited 0 with the
            // Advanced audit never performed and nothing marking it.
            //
            // Re-read AFTER the wait and ask the same mount question of
            // the post-state.
            const postGone = loan ? await jumpabilitySnapshot(loan) : null;
            if (snapshotCardEligible(postGone, observed) === false) {
              const moved = jumpabilityMoved(before, postGone);
              return {
                advancedOffered: false,
                advancedJumps: null,
                advancedBlocked: true,
                // NOT `advancedPreRaced`: this transition happened after
                // the scrape, so whatever the scrape saw still stands and
                // must not be suppressed. It only explains why no audit
                // was possible.
                advancedRaced: true,
                advancedWhy:
                  'the lender card unmounted while the probe waited' +
                  (moved ? `: ${moved}` : ' — the position is no longer one this card renders for'),
              };
            }
            // A REVERSIBLE TRANSITION LEAVES NO TRACE IN A BEFORE/AFTER
            // (Codex #1853 r17). The position can transfer away, the
            // page's 60s ownership poll can unmount the card, and the
            // position can transfer back — leaving `before` and `post`
            // identical and `snapshotCardEligible(post)` true, while the
            // card demonstrably went missing in between. No comparison
            // of two chain samples can see a round trip that closed
            // between them; only the DOM observation can, and we have
            // just made it.
            //
            // So a card that WAS scraped and is now gone is BLOCKED on
            // that evidence alone, regardless of what the chain says.
            if (!cardAbsentAtScrape) {
              return {
                advancedOffered: false,
                advancedJumps: null,
                advancedBlocked: true,
                advancedRaced: true,
                advancedWhy:
                  'the lender card was scraped and then vanished during the wait — ' +
                  'the chain reads either side agree, so a transition reversed inside ' +
                  'the window and no audit was possible',
              };
            }
          }
          // STILL RE-READ WHEN THE CARD STAYED MOUNTED (Codex #1853 r17).
          // The card deliberately survives FallbackPending, maturity and
          // a position lock — `PositionDetails` keeps it up so the wait
          // row can explain them — while `buildLenderExitRows` removes
          // BOTH jumps for exactly those states. So a during-wait
          // transition of that kind leaves the card present and the jumps
          // gone, and gating this re-read on the card's absence skipped
          // precisely the case where the card is designed to stay.
          //
          // Guarding on `cardPresent()` was a proxy for "did something
          // change", and it was the wrong proxy: the card's presence is
          // not what the sale rows depend on.
          if (loan && snapshotJumpable(before, observed) === true) {
            const post = await jumpabilitySnapshot(loan);
            if (snapshotJumpable(post, observed) === false) {
              const moved = jumpabilityMoved(before, post);
              return {
                advancedOffered: false,
                advancedJumps: null,
                advancedBlocked: true,
                advancedRaced: true,
                advancedWhy:
                  'the position stopped being sellable while the probe waited' +
                  (moved ? `: ${moved}` : ''),
              };
            }
          }
          // A STALE MOUNTED CARD IS NOT A CLEAN REVIEW (Codex #1853
          // r20). Everything above turns on the card being GONE; a card
          // the wallet no longer holds stays up for its refresh
          // interval, and with a settled reason for having no jump —
          // past maturity, which is most of this chain — the wait ends
          // with it still present and this returned exit 0 on a review
          // of somebody else's position.
          const stale = await vanishedCardVerdict(false);
          if (stale) return stale;
          // ASK THE CARD instead of inferring from its silence (Codex
          // #1853 r28). Everything above this line reasons about an
          // ABSENCE — no switch, so presumably nothing to switch to —
          // and #1855 shipped the attributes that end that guess.
          // Reading them is the difference between "the review found
          // nothing to do" and "the card says it has a jumpable row
          // and is not offering the switch", which is a Basic-mode
          // regression the drive was reporting as a clean run.
          // The wait already asked, every tick — re-reading here would
          // reach the same answer one poll later and would keep the
          // deadline that reading it early exists to remove (Codex
          // #1853 r29). `settled.settled` is absent only when the wait
          // ended for another reason, and `missingSwitchVerdict`
          // answers `unknown` for that, which is the pre-#1855 path.
          return { advancedOffered: false, advancedJumps: null, advancedWhy: 'no jumpable row' };
        }
        // It appeared while we waited: fall through to the click path.
      } else {
        const audit = await anchorAudit(page, card);
        if (audit.advancedJumps === 0) return await noJumpVerdict(false);
        return { advancedOffered: false, advancedWhy: 'already in Advanced', ...audit };
      }
    }
    // THE PRE-CONDITION OF THE ASSERTION, finally checked (Codex #1853
    // r25). The whole claim this branch makes is "the switch REVEALED
    // the jumps" — and it never established the half that makes that a
    // claim at all: that they were absent beforehand. A regression
    // leaking the Advanced jump buttons into Basic while leaving the
    // switch rendered produced a clean run, because the probe clicked,
    // found buttons, audited their anchors and passed.
    //
    // A FAIL rather than BLOCKED: the switch is on the page, which
    // means the card believes it is in Basic mode, and Basic mode
    // showing the Advanced controls is a product defect observed
    // directly rather than an ambiguity.
    const jumpsBeforeSwitch = await jumpsOf().count();
    if (jumpsBeforeSwitch > 0) {
      return {
        advancedOffered: true,
        advancedJumps: jumpsBeforeSwitch,
        advancedAnchorsOk: false,
        // SAYS IT IS A FAILURE rather than hoping the reporter infers
        // one (Codex #1853 r27). This record has a positive
        // `advancedJumps` and no `advancedAnchors`, which matches
        // neither of the reporter's two failure shapes — so round 25's
        // guard detected the leak and then exited 0. See
        // `advancedFailed` at the reporter for why this is a flag.
        advancedFailed: true,
        advancedWhy:
          `the Basic-mode switch was offered alongside ${jumpsBeforeSwitch} jump ` +
          'button(s) that should only exist in Advanced — the mode transition ' +
          'this run asserts had already happened, or never applied',
      };
    }
    await sw.first().click({ timeout: 10_000 });
    // WAIT FOR READINESS, not a fixed sleep (Codex #1853 r7). Switching
    // starts the Advanced-only `loanLive` read, and while it is in
    // flight the card sets `saleTools` to CHECKING — which removes every
    // jump button by design. So the six-second sleep the previous
    // version used meant a healthy-but-slow RPC produced zero jumps and
    // hit the FAIL branch round 5 had just introduced: my own fix
    // created a path that reports a product regression for an RPC taking
    // slightly longer than a hard-coded guess.
    //
    // Poll for a settled state instead: either a jump exists, or the
    // sale rows have stopped saying "still reading".
    // The sampler is passed here too (Codex #1853 r32): the post-click
    // wait had none, so cached jump buttons on a still-`pending` card
    // were audited and accepted — the same hole this round closed on
    // the pre-switch side, in the branch that actually does the audit.
    const post = await waitForSaleRows(
      card, jumpsOf, page, null, late, () => watch.sample(),
      () => chooserSelfVerdict(page),
    );
    const jumps = post.jumps;
    if (jumps === 0) {
      // THE SAME MAPPING THE OTHER ZERO-JUMP PATH USES (Codex #1853
      // r34). This branch went straight to the no-op-switch judgement,
      // so an unstable, failed or malformed readiness answer became a
      // product FAIL here whenever the chain snapshots still looked
      // jumpable — the verdict was computed, carried back, and thrown
      // away at the one site that most needed it.
      const blockedPost = readinessBlock(post.settled, true);
      if (blockedPost) return blockedPost;
      if (post.toolsFailed) {
        // A definite non-ready answer, not a no-op switch: the card is
        // correctly reporting that a prerequisite could not be loaded,
        // so the anchor audit could not run and nothing was learned.
        return {
          advancedOffered: true,
          advancedJumps: null,
          advancedBlocked: true,
          advancedWhy: 'a prerequisite read failed after the switch — sale tools unavailable',
        };
      }
      // Same rule after the click, and stated in both arms rather than
      // in the one the finding named — this file has produced seven
      // findings of the form "fixed in one consumer, not its sibling".
      if (post.stillPending) {
        return {
          advancedOffered: true,
          advancedJumps: null,
          advancedBlocked: true,
          advancedWhy:
            'the sale rows were still reading their prerequisites 45s after the ' +
            'switch — the page never settled, so no anchor could be audited',
        };
      }
      return await noJumpVerdict();
    }
    // ZERO JUMPS HERE TOO (Codex #1853 r14). A jump counted by
    // `waitForSaleRows` can be gone by the time `anchorAudit` scrapes the
    // rows, and `[].every(...)` is `true` — so this used to return
    // `advancedJumps: 0` with `advancedAnchorsOk: true` and no
    // revalidation at all, skipping the very branch a zero belongs in.
    // Both entries into the audit route a zero through the same verdict.
    const audit = await anchorAudit(page, card);
    if (audit.advancedJumps === 0) return await noJumpVerdict();
    return { advancedOffered: true, ...audit };
  } catch (e) {
    // "Could not look" is exit 2, NOT a clean observation (Codex #1853
    // r6). Reporting it and returning was half right: it is correctly
    // not a product FAIL — a switch that is disabled or covered, or an
    // evaluate that throws, says nothing about the app — but the
    // reporter only rejects `advancedAnchorsOk === false`, so the route
    // stayed `ok` and the run could exit 0 with the Advanced assertion
    // never completed.
    //
    // That is the SAME defect round 5 fixed for the offered-switch arm,
    // in the other arm of the same function, twelve lines away. I fixed
    // the branch the finding named and did not look at its sibling —
    // for the sixth time on this PR, and this is the closest sibling
    // yet.
    //
    // `advancedBlocked` is what the reporter turns into exit 2.
    return {
      advancedOffered: true,
      advancedJumps: null,
      advancedBlocked: true,
      advancedWhy: String(e).slice(0, 120),
    };
  }
}

/**
 * EACH jump button matched to ITS OWN anchor (Codex #1853 r5).
 *
 * The first version compared a COUNT — `jumps <= earlyExitPresent +
 * loanSalePresent` — which does not establish the invariant it claimed.
 * One listing jump with only `early-exit-card` mounted gives `1 <= 1`
 * and passes, while the button points at an anchor that is not there.
 * An aggregate cannot express "this button's target exists"; only a
 * per-button check can.
 *
 * The row a button belongs to is read from its own `.item-row` title,
 * and mapped to the target `lenderExitRows` gives that row.
 */
async function anchorAudit(page, card) {
  const rows = await card.locator('.item-row').evaluateAll((els) =>
    els.map((el) => ({
      title: el.querySelector('.row-title')?.textContent?.trim() ?? '',
      hasJump: Boolean(el.querySelector('button')),
    })),
  );
  const targetFor = (title) =>
    /Sell your position now/i.test(title)
      ? 'early-exit-card'
      : /List your position for sale/i.test(title)
        ? 'loan-sale-card'
        : null;
  const jumping = rows.filter((r) => r.hasJump);

  // INVOKE THE BUTTON, do not infer from its title (Codex #1853 r25).
  //
  // Every earlier version of this asked whether the element a row's
  // TITLE maps to exists. That is not the claim the drive advertises,
  // and it is satisfied by the failure it exists to catch: with both
  // anchors mounted — the normal case — Sell and List can scroll to
  // each other's, a handler can be dropped, a binding can be swapped
  // for a no-op, and every `present` check still passes. The audit
  // established that two elements exist.
  //
  // Twenty-five rounds of review went into the verdicts AROUND this
  // check while its central claim was never tested. That ordering is
  // the lesson: hardening the interpretation of a result does nothing
  // if the result was never produced.
  //
  // So the buttons are clicked and the navigation is MEASURED. The
  // handler is `getElementById(target)?.scrollIntoView(...)`, so
  // recording that call names the element actually reached — and an
  // absent anchor records nothing at all, which is the dead-button
  // case detected as an observation rather than as an inference.
  //
  // Watch-only, exactly as before: a jump handler scrolls and does not
  // submit, sign or mutate anything. That is what makes clicking
  // admissible in a drive that holds no key.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    if (w.__vpkJumpRecorder) return;
    w.__vpkJumpRecorder = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(...args) {
      w.__vpkJumpRecorder.push(this.id || '(element has no id)');
      return original.apply(this, args);
    };
  });

  // ITERATE THE BUTTONS, not the rows (Codex #1853 r26). `hasJump` is
  // a boolean, so `jumping` holds one entry per ROW — and the loop
  // indexed `buttons` by that. With one button per row the two align
  // and the audit is right; with two in a row, which is exactly the
  // regression this check exists to catch, the second is never clicked
  // and every later index is paired with the wrong row's expectation.
  // A count taken from the wrong collection, in the function whose job
  // is to exercise every rendered button.
  //
  // Each button's expectation now comes from its OWN enclosing row,
  // read out of the DOM rather than matched by position.
  const buttons = card.getByRole('button', { name: /Go to this option/i });
  const buttonCount = await buttons.count();
  const checks = [];
  for (let i = 0; i < buttonCount; i++) {
    const owningTitle = await buttons
      .nth(i)
      .evaluate((el) => el.closest('.item-row')?.querySelector('.row-title')?.textContent?.trim() ?? '')
      .catch(() => '');
    const target = targetFor(owningTitle);
    await page.evaluate(() => {
      /** @type {any} */ (window).__vpkJumpRecorder.length = 0;
    });
    let reached;
    try {
      await buttons.nth(i).click({ timeout: 5_000 });
      // The handler is synchronous; one frame is enough for the call to
      // have been recorded, and `smooth` behaviour does not delay it.
      await page.waitForTimeout(150);
      reached = await page.evaluate(
        () => /** @type {any} */ (window).__vpkJumpRecorder[0] ?? null,
      );
    } catch {
      // A button that cannot be clicked says nothing about the app —
      // it is covered, disabled or gone. `undefined` separates that
      // from `null`, which is a click that navigated NOWHERE.
      reached = undefined;
    }
    checks.push({
      title: owningTitle.slice(0, 40),
      target,
      reached,
      // `present` keeps its name and its meaning for the reporter: did
      // this button do what its row promises. It is now measured
      // rather than assumed, and stays `null` for a row this drive
      // cannot map, which is still the harness's gap and not the
      // app's.
      present: target === null ? null : reached === undefined ? null : reached === target,
    });
  }
  return {
    // COUNTED FROM THE BUTTONS for the same reason the loop iterates
    // them: a row with two would have reported one (Codex #1853 r26).
    advancedJumps: buttonCount,
    // An unmapped jumping row is NOT a pass (Codex #1853 r13). Treating
    // `target === null` as satisfied meant a new jumpable row, or either
    // title reworded past these regexes, would exit 0 with
    // `advancedAnchorsOk: true` having audited no anchor at all — the
    // drive's advertised every-button check, silently asserting nothing.
    //
    // It is still not a product FAIL: the mapping gap is the harness's,
    // not the app's. It is BLOCKED — could not look — which is the same
    // verdict every other "we cannot interpret this" outcome takes.
    //
    // EMPTY IS NOT OK (Codex #1853 r14). `[].every(...)` is `true`, so a
    // jump that vanished between `waitForSaleRows` counting it and this
    // function scraping the rows — the loan matured, transferred, locked
    // or left Active in that window — left `checks` empty and passed
    // vacuously, recording `advancedJumps: 0` with no `advancedBlocked`
    // and skipping the zero-jump revalidation entirely. Round 13
    // replaced one vacuous pass (`target === null` counted as satisfied)
    // with another, in the same expression. The caller now routes a zero
    // count through the moved/no-op logic instead, which is where a
    // zero-jump outcome has always belonged.
    advancedAnchorsOk: checks.length > 0 && checks.every((c) => c.present === true),
    advancedUnmapped: checks.filter((c) => c.target === null).map((c) => c.title),
    // A MAPPED button we could not CLICK is a third outcome, and
    // without naming it the instrumentation would have opened a hole
    // where the presence check had none: `present` is null there, so it
    // is neither a dead anchor nor an unmapped row, and it would have
    // passed between the reporter's two arms in silence. Covered,
    // disabled or vanished — all "could not look", all BLOCKED.
    advancedUnexercised: checks
      .filter((c) => c.target !== null && c.reached === undefined)
      .map((c) => c.title),
    advancedAnchors: checks,
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
  visited.push(await visit(`/positions/${l.id}`, { expectChooser: true, loan: l }));
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
  const detail = isDetailPath(v.path);
  // WHICH OBSERVATIONS BECOME VERDICTS NOW LIVES IN A TESTED MODULE
  // (#1861). This block decided the exit code inline, with no export,
  // so nothing could call it with a constructed record — and every
  // defect found in it (an anchor failure suppressed in aggregate,
  // #1853 r18; one message serving two findings, r16; a suppression
  // keyed on this driver's own prose, r14) was found by reading rather
  // than by running, because the live chain never presents the states
  // the rules describe.
  //
  // The ranking stays HERE, where it has always been: `problems`
  // outranks `blocked` at the exit below, and the module deliberately
  // returns both for every visit rather than choosing between them.
  const { problems } = visitVerdict(v, ROLE);
  const verdict = problems.length ? 'FAIL' : 'ok';
  if (problems.length) failures++;
  console.log(`${verdict.padEnd(5)} ${v.path.padEnd(16)} http=${v.http ?? '-'} connected=${v.connected ?? '-'}`);
  if (detail && !v.nav) {
    console.log(
      ROLE === 'lender'
        ? // `(late)` marks a card the initial scrape missed and the probe
          // then observed. Printed because the flag existed with nothing
          // reading it, and a reader looking at `card=true` deserves to
          // know which observation it came from — the whole point of the
          // rescrape is that the two disagreed.
          `      card=${v.chooser}${v.cardRescraped ? ' (late)' : ''} blurb=${v.lenderBlurb} wait=${v.waitRow}` +
          ` sellNow=${v.sellNowRow} list=${v.listRow} waitFirst=${v.waitFirst}` +
          `\n      advanced: offered=${v.advancedOffered} jumps=${v.advancedJumps}` +
          ` anchorsOk=${v.advancedAnchorsOk ?? '-'}` +
          (Array.isArray(v.advancedAnchors) && v.advancedAnchors.length
            ? ` [${v.advancedAnchors
                // An unmapped row printed as `null=null` told the reader
                // nothing; its TITLE is the only useful fact about it,
                // and on a run that exits 1 for a dead anchor beside it
                // this line is where the mapping gap is still visible —
                // the BLOCKED summary below is not reached.
                .map((a) =>
                  a.target
                    ? `${a.target}${a.reached === a.target ? ' ok' : ` → ${a.reached ?? 'nowhere'}`}`
                    : `unmapped:"${a.title}"`,
                )
                .join(', ')}]`
            : '') +
          (v.advancedWhy ? ` (${v.advancedWhy})` : '') +
          (v.advancedJumps ? '' : `\n      sell-now row: ${v.sellNowText ?? '-'}\n      listing row: ${v.listText ?? '-'}`)
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
// The Advanced probe could not be run to completion on some page: the
// switch was there but unclickable, or the page evaluate threw. Not a
// product FAIL — nothing was learned about the app either way — but not
// a clean run either, because the assertion this drive advertises did
// not execute (Codex #1853 r6). Ranked AFTER `failures` so a real
// regression is still reported as one.
// THE SAME MODULE THAT DECIDES `problems` DECIDES THIS (#1861). The two
// verdicts were computed in different places from overlapping fields,
// which is how a page could carry both and have one quietly erase the
// other (#1853 r18). `visitVerdict` returns both for every visit; the
// ranking is here, and only here.
const advBlocked = visited
  .map((v) => ({ v, why: visitVerdict(v, ROLE).blocked }))
  .filter(({ why }) => why !== null);
if (advBlocked.length) {
  console.log(
    `\nBLOCKED: the Advanced probe could not complete on ${advBlocked.length}` +
      ` page(s) — the jump-anchor assertion did not run.`,
  );
  advBlocked.forEach(({ v, why }) => console.log(`  ${v.path}: ${why}`));
  process.exit(2);
}
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
