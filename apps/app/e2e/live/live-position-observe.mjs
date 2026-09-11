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
import {
  confirmationReady,
  forcedCloseCoverage,
  forcedCloseVerdict,
  reconcileEligibility,
  saysCheckRunning,
} from './forcedCloseCard.mjs';
import { requireSiteUrl } from './driver.mjs';
import { redactUrl } from './redact.mjs';
import { isDetailPath, visitProblemKinds, visitVerdict } from './visitVerdict.mjs';
import { walkOrderFor } from './walkOrder.mjs';
import {
  EXECUTION_REVERTED,
  REVERT_BYTES,
  blockNumberFromRpcPair,
  blockNumberFromWsFrame,
  callsTargetContract,
  chainIdFromRpcPair,
  CHAIN_ID_CONFLICT,
  classifyRpcFailure,
  codedError,
  isTransportFailure,
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

const SITE = requireSiteUrl();
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
 * The shipped "a check is running" sentence, READ FROM THE REPO's own
 * locale bundle rather than restated here.
 *
 * A hand-copied string is a second copy to drift, and it would drift
 * silently in the direction that matters: a reworded `copy.forcedClose.
 * unknown` would stop matching, the drive would report `checkRunning:
 * false` for every unresolved card, and nothing would look broken.
 * Sourcing it means a rename fails loudly at startup instead.
 */
const FORCED_CLOSE_COPY = (() => {
  const bundle = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/i18n/locales/en.json'),
      'utf8',
    ),
  );
  const fc = bundle?.copy?.forcedClose ?? {};
  // The SHARED receipt labels (round 54 P2). `ReviewReceipt` renders
  // every write flow's six rows from `copy.receipt`, so the headings
  // live there rather than under `forcedClose` — and taking them from
  // the same place the component does is what keeps this from becoming
  // a second copy to drift.
  const enCopy = bundle?.copy ?? {};
  const need = (value, key) => {
    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `copy.${key.includes('(label)') ? '' : 'forcedClose.'}${key} is missing from ` +
          'src/i18n/locales/en.json — the forced-close observation cannot judge ' +
          'the deployed card without it.',
      );
    }
    return value;
  };
  return {
    unknownCopy: need(fc.unknown, 'unknown'),
    // ROUND 7 P2 — the READY routes, so a card rendering one of them
    // while offering no usable action reads as the defect it is rather
    // than as the valid withheld-but-explained state.
    // `readyNeedsRoute` is DELIBERATELY ABSENT. It is a ready state that
    // correctly offers no control: the spec has the app state that the
    // position is closable and that the sale must be routed by whoever
    // submits it, and "offers no button it cannot honour" — presenting
    // an action certain to be refused is worse than presenting none.
    // Including it fired on a live position within a minute of the
    // check shipping, which is exactly the false FAIL that gets a check
    // switched off.
    readyCopy: [
      need(fc.readyInKind, 'readyInKind'),
      need(fc.readyInternalMatch, 'readyInternalMatch'),
      need(fc.readyRental, 'readyRental'),
    ],
    // ROUND 8 P2 — the states that must NOT offer an enabled control.
    // `readyNeedsRoute` belongs here rather than in `readyCopy`: it is
    // ready AND correctly unactionable, so an enabled button on it is
    // the defect the spec names — a fee paid for a certain refusal.
    withheldCopy: [
      need(fc.unknown, 'unknown'),
      need(fc.notYet, 'notYet'),
      need(fc.blockedPaused, 'blockedPaused'),
      need(fc.blockedSequencer, 'blockedSequencer'),
      need(fc.blockedNoConsent, 'blockedNoConsent'),
      need(fc.readyNeedsRoute, 'readyNeedsRoute'),
    ],
    // ROUND 11 P2 — every state this card can legitimately be in. A
    // card matching none of them has said SOMETHING without saying
    // anything the drive can recognise, which is reported as a gap in
    // the drive's vocabulary rather than as a product defect.
    // ROUND 12 P2 — READINESS BODIES ONLY, no auxiliary history.
    //
    // I had included the `lastOutcome` notes (`outcomeReverted` and its
    // siblings) and the submitted states. Those render BESIDE the
    // current body, and `ForcedCloseCard`'s own comment says outright
    // that such a note does not describe the CURRENT state — so a card
    // whose readiness body was broken or unrecognised still satisfied
    // recognition on the strength of a note about a previous attempt.
    // The check would have passed while the lender was told nothing
    // about where the position stands now.
    //
    // These nine are the states the body itself can be in. A watch-only
    // drive never submits, so a submitted/outcome body is not a state
    // this run can legitimately produce; if one appears, `blocked` is
    // the honest answer rather than a pass.
    recognisedCopy: [
      need(fc.unknown, 'unknown'),
      need(fc.notYet, 'notYet'),
      need(fc.blockedPaused, 'blockedPaused'),
      need(fc.blockedSequencer, 'blockedSequencer'),
      need(fc.blockedNoConsent, 'blockedNoConsent'),
      need(fc.readyInKind, 'readyInKind'),
      need(fc.readyInternalMatch, 'readyInternalMatch'),
      need(fc.readyRental, 'readyRental'),
      need(fc.readyNeedsRoute, 'readyNeedsRoute'),
    ],
    // ROUND 7 P2 — positive evidence that the RECEIPT rendered, not
    // merely that its shell opened.
    // ROUND 43 P2 — BOTH receipts. `ready-rental` renders
    // `rentalReceipt`, whose `youReceive` is an entirely different
    // sentence, so supplying only the ordinary lead reported a correct
    // rental confirmation as incomplete. `need` on both, so a missing
    // one is a loud startup failure rather than a silently narrower
    // check.
    receiptLeads: [
      need(fc.receipt?.youReceive, 'receipt.youReceive'),
      need(fc.rentalReceipt?.youReceive, 'rentalReceipt.youReceive'),
    ],
    // ROUND 53 P2 — THE WHOLE RECEIPT, per route, not just its lead.
    //
    // Six `.receipt-row` elements with non-blank leaves used to be the
    // entire completeness test, so six copies of one row — the fees and
    // loss disclosures gone — satisfied it, and satisfied the lead check
    // six times over. And accepting EITHER lead let a collateral card
    // render the rental receipt, or the reverse: a confirmation
    // describing a different transaction from the one it confirms.
    //
    // `need` on every value, so a copy key that moves is a loud startup
    // failure rather than a silently narrower check — the same rule the
    // leads above already follow.
    // ROUND 54 P2 — THE LABELS TOO, PAIRED WITH THEIR VALUES.
    //
    // Round 53 checked the value SET, so the six right values under the
    // six wrong headings — the loss disclosure filed under "Fees", the
    // fee disclosure under "You receive" — satisfied it: every value
    // present, all six distinct. A receipt whose every line is true and
    // whose every line is attached to the wrong question, certified as
    // scanned.
    //
    // Ordered, because the order is part of the contract:
    // `ReviewReceipt` states it outright — "Six fixed rows, same order
    // everywhere" — and renders from a fixed array. Pairing by index
    // therefore enforces both the pairing and the order with one rule.
    //
    // Labels come from the SHARED `copy.receipt`, which is where
    // `ReviewReceipt` takes them from, rather than being restated here.
    receiptRowLabels: [
      need(enCopy.receipt?.youReceive, 'receipt.youReceive (label)'),
      need(enCopy.receipt?.youLock, 'receipt.youLock (label)'),
      need(enCopy.receipt?.youMayOwe, 'receipt.youMayOwe (label)'),
      need(enCopy.receipt?.youCanLose, 'receipt.youCanLose (label)'),
      need(enCopy.receipt?.fees, 'receipt.fees (label)'),
      need(enCopy.receipt?.whenThisEnds, 'receipt.whenThisEnds (label)'),
    ],
    receiptRowSets: {
      standard: [
        need(fc.receipt?.youReceive, 'receipt.youReceive'),
        need(fc.receipt?.youLock, 'receipt.youLock'),
        need(fc.receipt?.youMayOwe, 'receipt.youMayOwe'),
        need(fc.receipt?.youCanLose, 'receipt.youCanLose'),
        need(fc.receipt?.fees, 'receipt.fees'),
        need(fc.receipt?.whenThisEnds, 'receipt.whenThisEnds'),
      ],
      rental: [
        need(fc.rentalReceipt?.youReceive, 'rentalReceipt.youReceive'),
        need(fc.rentalReceipt?.youLock, 'rentalReceipt.youLock'),
        need(fc.rentalReceipt?.youMayOwe, 'rentalReceipt.youMayOwe'),
        need(fc.rentalReceipt?.youCanLose, 'rentalReceipt.youCanLose'),
        need(fc.rentalReceipt?.fees, 'rentalReceipt.fees'),
        need(fc.rentalReceipt?.whenThisEnds, 'rentalReceipt.whenThisEnds'),
      ],
    },
    // Which readiness copy means the RENTAL route, so the verdict can
    // pick the receipt the card is supposed to be showing.
    rentalReadyCopy: need(fc.readyRental, 'readyRental'),
    // ROUND 64 P2 — which readiness copy names WHICH SETTLEMENT, so the
    // verdict can compare the route the card is painting against the
    // route the protocol would actually take. Named separately rather
    // than positionally inside `readyCopy`, because an index into that
    // array is exactly the kind of coupling that survives a reorder and
    // starts lying.
    internalMatchReadyCopy: need(fc.readyInternalMatch, 'readyInternalMatch'),
    inKindReadyCopy: need(fc.readyInKind, 'readyInKind'),
    // ROUND 65 P2 — the copies that assert the PROTOCOL REFUSES, as
    // distinct from the ones that assert the app does not yet know or
    // cannot drive a settlement.
    //
    // Deliberately NOT every withheld sentence. `unknown` asserts
    // nothing, and `readyNeedsRoute` is a claim about the app's ability
    // to route rather than about the protocol's answer — a close-out
    // that simulates with empty calldata does not make either of those
    // a false statement. Only these four say the close-out is refused,
    // and only they can be contradicted by the protocol accepting it.
    // ROUND 67 P2 — the two HEADINGS, so a heading contradicting the body
    // can be seen. `ForcedCloseCard` picks between them on `view.overdue`
    // alone.
    // The one body state that settles the deadline NEGATIVELY.
    notYetCopy: need(fc.notYet, 'notYet'),
    overdueTitleCopy: need(fc.title, 'title'),
    pendingTitleCopy: need(fc.titlePending, 'titlePending'),
    refusalStateCopy: [
      need(fc.notYet, 'notYet'),
      need(fc.blockedPaused, 'blockedPaused'),
      need(fc.blockedSequencer, 'blockedSequencer'),
      need(fc.blockedNoConsent, 'blockedNoConsent'),
    ],
  };
})();
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
/** `LOCK_EARLY_WITHDRAWAL_SALE` — kept in step with
 *  `src/data/loanSalePending.ts`, which is where the app's copy lives. */
const LOCK_EARLY_WITHDRAWAL_SALE = 2;

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

/**
 * The WEAKER question: did viem classify this as a contract revert at all?
 *
 * ROUND 84 P2 — and it exists because `isRevert` above is deliberately
 * strict about an AMBIGUOUS shape, which is right for some callers and
 * wrong for others.
 *
 * A bare `revert()` reported by a provider under an internal-error code
 * gives `raw === '0x'` and `code === -32603`: empty bytes fail the byte
 * test and the code is not 3, so `isRevert` says no. Its own comment
 * argues that honestly — empty `0x` is evidence of nothing, since a bare
 * revert produces it and so does a provider filling the field with
 * nothing on an outage. The ambiguity is real and the strictness stays.
 *
 * What differs is THE COST OF ANSWERING "no" at each call site:
 *
 *   - Where the revert branch yields an UNKNOWN — `saleLockedOn`'s two
 *     catches — a "no" throws, and since those run inside `discovery()`
 *     the whole run aborts. One position in an ambiguous state then stops
 *     every other position from being observed, over a reply the chain
 *     may well have given us. Those sites ask THIS predicate.
 *   - Where the revert branch ASSERTS something — `offsetLockedOn`
 *     returns "locked, skip the loan", `tokenOwnerOf` returns "the token
 *     does not exist" — a loosened test would let a dead backend make
 *     positions quietly vanish from the pool. There, aborting is the
 *     honest outcome for an ambiguous reply, and those sites keep
 *     `isRevert`.
 *
 * Round 75's rule is untouched either way: a programming error in this
 * drive, and a transport failure, carry no `ContractFunctionRevertedError`
 * anywhere in the chain, so both still throw from every one of the four.
 */
function answeredWithRevert(err) {
  return Boolean(err?.walk?.((e) => e instanceof ContractFunctionRevertedError));
}

/**
 * Does the LENDER position token carry the early-withdrawal SALE lock?
 *
 * ROUND 1 P2. `PositionDetails` renders the forced-close card behind
 * `!saleCompletionPending`, so a loan whose lender-position sale has
 * been ACCEPTED but not yet completed correctly has NO card — closing
 * out would terminalize the loan and strand the buyer's committed
 * funds. Reporting that as a missing-card defect is the false-positive
 * direction, which is the one that gets a check switched off.
 *
 * ONE READ, DELIBERATELY CONSERVATIVE. The app distinguishes a live
 * listing from an accepted sale by simulating `teardownStaleSaleListing`
 * — but this drive does not need that resolution, only the safe half of
 * it. The lock is stamped for the WHOLE listing lifecycle, so an
 * UNLOCKED token proves no accepted sale exists and an absent card is a
 * genuine defect. A locked one cannot rule it out, and the verdict
 * there is `blocked` with the reason stated. The cost is coverage on
 * sale-locked positions, which is announced; the alternative cost is a
 * false FAIL, which is silent trust damage.
 *
 * A revert is treated as LOCKED for the same reason `offsetLockedOn`
 * treats one as locked: a read that could not answer must not be turned
 * into a product finding.
 */
/**
 * ROUND 30 P2 — the simulating ACCOUNT is a parameter, not a module
 * global.
 *
 * This read used `observed`, the module-scoped authority, which is
 * declared far below it. That was harmless while every caller ran after
 * the declaration, and stopped being harmless the moment round 29 hoisted
 * an applicability probe ABOVE it to rank authorities: `observed` was
 * then in its temporal dead zone, the simulate threw a `ReferenceError`,
 * and the probe's own `catch` — written for transport failures — swallowed
 * it as "unreadable, still a candidate". So every locked position stayed
 * unclassified and the ordering fix did nothing.
 *
 * Two lessons, and the second is the one worth keeping. A catch that
 * cannot tell a dead endpoint from a programming error will report the
 * programming error as a chain condition, and this file has now been
 * caught doing exactly that. And a cross-authority probe had no business
 * simulating as `observed` even once that variable existed — the question
 * is whether THIS loan's lender has an accepted sale, so the account has
 * to be that loan's authority. Passing it explicitly fixes a latent
 * correctness bug as well as the crash.
 */
async function saleLockedOn(lenderTokenId, loanId, blockNumber, account) {
  if (lenderTokenId === undefined || lenderTokenId === null) return 'unknown';
  // A missing account is a WIRING error, not a chain condition, so it
  // throws rather than returning `'unknown'` — the latter reads as "the
  // chain could not answer" and is precisely the laundering this change
  // is about.
  if (!account) throw new TypeError('saleLockedOn: account is required');
  let locked;
  try {
    const lock = await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'positionLock',
      args: [lenderTokenId],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    locked = Number(lock) === LOCK_EARLY_WITHDRAWAL_SALE;
  } catch (err) {
    // `answeredWithRevert`, not `isRevert` — see its note. The revert
    // branch here yields an UNKNOWN, so the cost of refusing an ambiguous
    // bare revert is aborting the whole run rather than reading one
    // position as unestablished.
    if (!answeredWithRevert(err)) throw err;
    return 'unknown';
  }
  if (!locked) return false;

  // ROUND 8 P2 — THE LOCK IS LISTING-WIDE; THE UNMOUNT IS ACCEPTANCE-
  // SPECIFIC.
  //
  // `createLoanSaleOffer` stamps `positionLock` for the WHOLE listing
  // lifecycle, but `PositionDetails` unmounts the card only on
  // `saleHold.data === 'accepted'`. Treating the raw lock as the excuse
  // therefore forgave a genuinely missing card on an ordinary LIVE
  // listing — a regression labelled inapplicable. I had disclosed that
  // as a deliberate trade; it is too coarse, because the states differ
  // in exactly the way the verdict turns on.
  //
  // So classify, the way the app does: simulate `teardownStaleSaleListing`
  // and read the revert. `NoStaleSaleListing` on a LOCKED position means
  // an accepted sale awaiting completion — the one state that correctly
  // unmounts the card. `SaleListingLoanStillLive` is an ordinary live
  // listing, where the card must be present.
  try {
    await pub.simulateContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'teardownStaleSaleListing',
      args: [BigInt(loanId)],
      account,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    return false; // 'clearable' — a stale listing, not an accepted sale
  } catch (err) {
    const name = revertNameOf(err);
    if (name === 'NoStaleSaleListing') return true; // locked + no stale → accepted
    if (name === 'SaleListingLoanStillLive') return false; // live listing
    // ROUND 83 P2 — "I CANNOT NAME THIS REVERT" IS NOT "THIS WAS NOT A
    // REVERT", and this arm conflated them.
    //
    // `revertNameOf` reads `data.errorName`, which viem fills in only for
    // a custom error it could decode against the ABI. A BARE `revert()`
    // carries no data to name, and a custom error the deployment has but
    // this ABI does not carries a selector viem cannot resolve — both are
    // the EVM answering, and both returned `null` here and were rethrown.
    // `discovery()` then aborts the WHOLE run, so one locked position in
    // an undecodable state stops every other position from being observed
    // — an unread run reported as a failure of the drive, over a reply the
    // chain did give us.
    //
    // Decided by the same test the `positionLock` catch twenty lines above
    // uses for exactly this split, so the two catches in one function
    // answer the question the same way. Anything that is NOT a revert
    // still throws: a dead endpoint or a programming error in this drive
    // must stay loud, which is round 75's lesson and the reason this arm
    // existed at all.
    //
    // ROUND 84 P2 — and asked with `answeredWithRevert`, because
    // `isRevert` refuses the ambiguous shape this arm most needs to
    // admit: a bare `revert()` under an internal-error code carries empty
    // bytes and a code that is not 3, so the round-83 guard still
    // rethrew on the very case it was written for. The predicate's own
    // note carries the argument for why the two sites differ.
    if (!answeredWithRevert(err)) throw err;
    // ROUND 12 P2 — AN UNRECOGNISED REVERT IS `unknown`, NOT `true`.
    //
    // Returning `true` here read downstream as a SUBSTANTIATED accepted
    // sale: the verdict reported `inapplicable` with an accepted-sale
    // explanation that had never been established, and `inapplicable`
    // does not trip `forcedCloseCoverage` — so on a deployment carrying
    // another guard, a genuinely missing card could be suppressed while
    // the run printed a confident reason for it. I wrote "fail toward
    // blocked" and did, but toward the WRONG blocked: the one that says
    // nothing is wrong rather than the one that says nothing was
    // learned.
    return 'unknown';
  }
}

/**
 * The custom-error NAME from a viem simulate failure, or null when no name
 * could be decoded.
 *
 * `null` DOES NOT MEAN "not a revert", and the previous wording here said
 * it did — which is how a caller came to rethrow on one (round 83). viem
 * fills `data.errorName` only for a custom error it could resolve against
 * the ABI, so a bare `revert()` with no data, and a custom error this ABI
 * does not carry, both answer `null` while being the EVM answering. A
 * caller that needs "did the chain reply at all" asks `isRevert`.
 */
function revertNameOf(err) {
  const seen = new Set();
  let cur = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const name = cur?.data?.errorName;
    if (typeof name === 'string') return name;
    cur = cur.cause;
  }
  return null;
}

// `isTransportFailure` lives in `rpc-verdict.mjs` — a pure predicate with
// its own tests, for the reason this file has now learned four times: a
// branch that runs only inside a live drive is a branch nothing has
// executed, and the two most recent inert fixes were both in exactly that
// position. Round 31 wrote this classifier here and nothing could reach
// it; round 33 found it wrong and moved it out.

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
async function tokenOwnerOf(tokenId, blockNumber) {
  try {
    return await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'ownerOf',
      args: [tokenId],
      // Optional: every existing caller reads `latest`, and only the
      // forced-close snapshot pins a block (round 4 P2).
      ...(blockNumber === undefined ? {} : { blockNumber }),
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
  // ROUND 1 P2 — SAY WHAT THIS POOL CANNOT REACH.
  //
  // The candidate pool is the CHOOSER's, and it filters to ERC-20, so
  // an overdue NFT rental is never visited. The forced-close card has a
  // distinct `ready-rental` route the spec treats separately — ending a
  // rental moves nothing of the borrower's and makes prepaid rent
  // claimable — and none of it is exercised here. Widening the pool is
  // a second discovery path and is tracked separately; until then the
  // honest thing is for the run to state the gap rather than let a
  // green tally imply the rental surface was covered.
  if (ROLE === 'lender') {
    if (loans.some((l) => l.assetType !== ASSET_ERC20)) {
      console.log(
        '          NOTE: rentals are outside this pool, so the forced-close ' +
          "card's rental route is NOT covered by this run.",
      );
    }
    // ROUND 5 P2 — the SAME pool also drops a sanctions-flagged holder,
    // and that exclusion is right for the chooser (the card is
    // correctly suppressed there) while being wrong for forced close:
    // the spec deliberately keeps this card available to a flagged
    // lender, because closing out an already-defaulted loan is a
    // wind-down the protocol keeps open to every caller. A regression
    // hiding it in exactly that supported state is undetectable here.
    if (loans.some((l) => l.authoritySanctioned === true)) {
      console.log(
        '          NOTE: sanctions-flagged holders are outside this pool, so the ' +
          'forced-close card is NOT verified for the flagged lender the spec ' +
          'requires it to stay available to.',
      );
    }
  }
}

// Which Active positions can actually exercise the forced-close card.
// Resolved ONCE, over every eligible Active loan across all authorities,
// and consumed by both the authority choice below and the walk order
// further down — the two used to answer this question separately, or not
// at all. See the round-29 note in the sort.
const acceptedSale = new Set();
if (ROLE === 'lender') {
  // ROUND 52 P2 — THROUGH `discovery()`, so the one error this loop
  // deliberately rethrows exits BLOCKED rather than FAIL.
  //
  // The rethrow below is right and stays: a failure this file cannot
  // attribute to the chain must be loud rather than silently degrading
  // the ranking. But it happened OUTSIDE `discovery()`, so it became an
  // uncaught top-level rejection — which exits 1, which the batch reads
  // as a product regression. At this point no browser observation has
  // happened at all, so blaming the deployed page is the one thing the
  // exit contract forbids.
  //
  // A provider answering JSON-RPC `-32700` is enough to reach it:
  // `classifyRpcFailure` calls that a `client-fault`, `isTransportFailure`
  // therefore returns false, and the loop rethrows into nothing.
  //
  // Loud AND correctly classified: `discovery()` prints what failed and
  // exits 2.
  // ROUND 78 P2 — AND ONLY THE REQUESTED LENDER'S LOANS WHEN ONE WAS
  // NAMED, exactly as the close-out pre-pass below already does.
  //
  // Cross-authority accepted-sale data informs the AUTHORITY CHOICE. With
  // `OBSERVE_ADDRESS` set that choice is already made, and the walk that
  // follows only ever sees `mine` — so every probe against another
  // authority's loans is spent on a ranking nobody reads, sequentially,
  // before the browser launches. Unrelated latency, a rate limit, or one
  // non-revert failure could stall or BLOCK a perfectly valid observation
  // of the lender that was actually asked for.
  //
  // The parallel-site shape once more, and on my own round-76 fix: I
  // narrowed the pre-pass one loop below this and left this one.
  const requestedAuthority = process.env.OBSERVE_ADDRESS?.toLowerCase();
  const saleCandidates = eligible.filter(
    (x) =>
      x.status === STATUS_ACTIVE &&
      (!requestedAuthority || x.authority.toLowerCase() === requestedAuthority),
  );
  await discovery('ranking loans by accepted sale', async () => {
    for (const l of saleCandidates) {
      try {
        if ((await saleLockedOn(l.lenderTokenId, l.id, undefined, l.authority)) === true) {
          acceptedSale.add(l.id);
        }
      } catch (err) {
        // ROUND 30 P2 — a chain that could not answer, NOT a bug in this
        // file.
        //
        // This catch was written for transport failures and silently ate a
        // `ReferenceError` for a whole round: every locked position came
        // back "unreadable, still a candidate", so the ordering fix above
        // did nothing while reading as though it worked. A catch that
        // cannot tell a dead endpoint from a programming error will keep
        // reporting the programming error as a chain condition.
        //
        // The two are now separated, and by an ALLOWLIST: a failure is
        // swallowed only when the error chain positively names a transport
        // fault. Everything else — this drive being wrong about itself, in
        // any of the ways it can be — is rethrown so the run reports it
        // instead of quietly degrading. Round 31 corrected an earlier
        // denylist here that named two error classes and missed the rest.
        if (!isTransportFailure(err)) throw err;
        // Unreadable, so unknown, so still a candidate. Ranking a loan
        // down on a read that failed would be a decision made on no
        // evidence, in the direction that costs the run its coverage.
      }
    }
  });
}

// ROUND 74 P2 — CONFIRMATION CAPABILITY IS RESOLVED BEFORE THE AUTHORITY
// CHOICE, which is the fourth time this same lesson has been applied.
//
// The comment below already records it twice: ranking fixed inside the
// SELECTED authority's walk cannot recover a better candidate one
// authority away, because by then `mine` is fixed. My round-72 promotion
// of close-out-capable positions went in at exactly that level, so a
// lender with several non-defaultable Active loans still outranks a
// lender holding one the protocol would accept — and the capped walk
// cannot reach the latter, exiting 2 to claim the confirmation was never
// observable.
//
// Resolved ONCE here, across every authority, and the same answer feeds
// both the choice and the walk — the shape `acceptedSale` already uses.
//
// PAID FOR ONLY WHEN IT CAN CHANGE SOMETHING: more than one authority to
// choose between, or a single authority holding more eligible loans than
// the visit cap. Otherwise every candidate is visited whatever the order
// and a simulate per loan is pure cost.
//
// PROMOTES ON A POSITIVE ANSWER ONLY. `probeCloseOut` answers `undefined`
// when it could not ask, and ranking a candidate down on a failed read
// hands the run to a worse one on no evidence — the rule the
// accepted-sale resolution above states for itself.
//
// ORDERING ONLY. The protocol accepting a close-out is not the card
// offering one, and this probe is unpinned; no verdict reads it.
const acceptsCloseOut = new Set();
{
  const authorities = new Set(eligible.map((l) => l.authority.toLowerCase()));
  const perAuthority = new Map();
  for (const l of eligible) {
    const k = l.authority.toLowerCase();
    perAuthority.set(k, (perAuthority.get(k) ?? 0) + 1);
  }
  const capBinds = [...perAuthority.values()].some((n) => n > MAX_POSITIONS);
  // ROUND 76 P2 — AND ONLY THE REQUESTED LENDER WHEN ONE WAS NAMED.
  //
  // With `OBSERVE_ADDRESS` set there is no authority choice to inform, so
  // probing every authority's loans buys nothing and costs a sequential
  // simulate per eligible Active position across the whole chain —
  // unbounded by the visit cap, and enough to hit a rate limit or stall
  // the run before the browser even launches. The walk-order promotion
  // still needs answers for the loans that WILL be visited, so the
  // pre-pass narrows rather than disappears.
  const requested = process.env.OBSERVE_ADDRESS?.toLowerCase();
  const candidates = requested
    ? eligible.filter((l) => l.authority.toLowerCase() === requested)
    : eligible;
  // ROUND 76 P2 — INSIDE `discovery`, so a rethrow is BLOCKED and not a
  // product FAIL.
  //
  // Round 75 made these probes rethrow what is not a transport fault,
  // which was right — and left the rethrow escaping to the top level,
  // where an unhandled rejection exits 1. That code is reserved for a
  // regression in the deployed product, so the loud failure I added would
  // have blamed the app for this drive being wrong about itself. `exit 2`
  // is the honest outcome, and `discovery` is what produces it.
  if (ROLE === 'lender' && (authorities.size > 1 || capBinds)) {
    await discovery('probing which positions the protocol would close out', async () => {
      for (const l of candidates) {
        if (l.status !== STATUS_ACTIVE || acceptedSale.has(l.id)) continue;
        if ((await probeCloseOut(l.id, undefined, l.authority)) === true) {
          acceptsCloseOut.add(l.id);
        }
      }
    });
  }
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
  // ROUND 12 P2 — ON A LENDER RUN, AN AUTHORITY WITH AN ACTIVE LOAN
  // OUTRANKS ONE WITH MORE LOANS.
  //
  // Round 9 partitioned the SELECTED authority's loans so an Active
  // candidate could not be hidden behind the visit cap. It could not
  // help when the selection itself was wrong: this sort maximises the
  // combined Active-or-FallbackPending pool, so a lender with many
  // FallbackPending loans and no Active one is chosen over a lender who
  // has one — and the run then exits 2 for unavailable forced-close
  // coverage while an applicable target sat one authority away. Fixing
  // the ordering below the choice, and not the choice, is the same
  // half-measure twice.
  //
  // The forced-close assertion needs an Active position; the chooser
  // assertions apply to both statuses and are indifferent to which
  // authority is picked. So Active-bearing authorities come first, and
  // the loan count breaks ties within each group.
  // ROUND 29 P2 — AND "ACTIVE" IS STILL NOT "APPLICABLE", HERE TOO.
  //
  // Round 28 demoted accepted-sale positions inside the SELECTED
  // authority's walk. That is the third time this fix has been applied
  // one level below where the decision is actually made — the comment
  // directly above says so about round 9, and round 28 did it again.
  // This sort asks only whether an authority has ANY Active loan, so a
  // lender whose Active positions all carry an accepted sale outranks a
  // lender holding one applicable position, and the walk-level partition
  // cannot recover it: by then `mine` is fixed and the other authority's
  // loan is out of reach. The run visits three inapplicable positions
  // and exits 2 saying the assertion never ran.
  //
  // So applicability is resolved BEFORE the choice, once, and the same
  // answer feeds the walk below. Only a positively established accepted
  // sale counts against a loan — `'unknown'` and a thrown transport
  // error leave it applicable, because ranking an authority down on a
  // read that failed would hand the run to a worse candidate on no
  // evidence.
  //
  // The cost is one `positionLock` read per eligible Active loan across
  // all authorities rather than for one authority. `saleLockedOn`
  // returns false on that read alone for an unlocked position and only
  // simulates for a locked one, so the common case stays a single cheap
  // call.
  const applicableCount = (loans) =>
    loans.filter((l) => l.status === STATUS_ACTIVE && !acceptedSale.has(l.id)).length;
  const capableCount = (loans) => loans.filter((l) => acceptsCloseOut.has(l.id)).length;
  const [best] = [...byAuthority.entries()].sort((a, b) => {
    if (ROLE === 'lender') {
      // Ahead of mere applicability: a card that MOUNTS still need not
      // OFFER anything, and the confirmation can only be read on one that
      // does (round 74).
      const byCapable = (capableCount(b[1]) > 0 ? 1 : 0) - (capableCount(a[1]) > 0 ? 1 : 0);
      if (byCapable !== 0) return byCapable;
      const byApplicable =
        (applicableCount(b[1]) > 0 ? 1 : 0) - (applicableCount(a[1]) > 0 ? 1 : 0);
      if (byApplicable !== 0) return byApplicable;
    }
    return b[1].length - a[1].length;
  });
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
// app ships nine translated locales and detects from
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
// ROUND 78 P2 — THE CHAIN THE PAGE'S OWN TRAFFIC ALREADY DISCLOSED.
//
// `watchPageHead` parses a real `eth_chainId` reply for every endpoint it
// sees, and kept that evidence in its per-page closure. So an endpoint
// whose chain was ESTABLISHED from the page's own request could still be
// filed as unknown when the extra synthetic probe was refused or timed
// out — and round 77's gate would then downgrade a real inferred failure
// to BLOCKED on a chain it actually knew.
//
// Keyed by `res.url()`, the same string `pageRpcChain` uses, so the two
// reconcile without a second notion of what an endpoint is. A
// self-contradicting endpoint is deliberately NOT recorded: it has told
// us it cannot say which chain it serves, which is unknown rather than
// evidence.
const observedPageChain = new Map();
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
function notePageRpcEndpoint(url, calls, rawBody) {
  // ROUND 65 P2 — THE SAME TWO TESTS `markDiamond` USES, not one of them.
  //
  // `callsTargetContract` reads the `to` of the shapes it knows, and
  // viem batches contract reads through multicall3 — so on the COMMON
  // path the `to` is the aggregator and the Diamond appears only inside
  // the encoded calldata. `markDiamond` has carried both tests since the
  // day attribution-by-`to` marked nothing on a live run; this one kept
  // only the weaker half.
  //
  // The consequence is the dangerous direction. Such an endpoint is
  // admitted to the height set and its heads are trusted for absence
  // confirmation, while it is never chain-probed — so if it serves
  // another chain and does not volunteer `eth_chainId`, the wrong-chain
  // gate cannot downgrade the resulting missing-card FAIL and the drive
  // exits 1 against a product that did nothing wrong.
  //
  // Twelfth instance on this PR of one of several parallel sites being
  // left behind, and the second where the two sites are a few hundred
  // lines apart with the same job.
  const hex = String(DIAMOND).replace(/^0x/, '').toLowerCase();
  const mentionsDiamond =
    typeof rawBody === 'string' && rawBody.toLowerCase().includes(hex);
  if (pageRpcChain.has(url) || !(mentionsDiamond || callsTargetContract(calls, DIAMOND))) return;
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
    // The RAW body travels with the parsed calls: the Diamond can appear
    // only inside multicall3 calldata, which no parse of the JSON-RPC
    // envelope surfaces (round 65 P2).
    if (pageCalls) notePageRpcEndpoint(req.url(), pageCalls, req.postData());
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
 * The highest block THE PAGE has been seen to know about, per page.
 *
 * ROUND 14 P2 — "my client advanced" is not "my client caught up".
 *
 * Round 13 made the absence confirmation wait for a strictly newer head
 * than the snapshot pinned. That proves this observer moved; it proves
 * nothing about the INDEPENDENT provider the deployed bundle reads,
 * which can be two or more blocks ahead. A terminalization at N+2
 * correctly removes the card while this observer, confirming at N+1,
 * re-reads a still-eligible position and emits the same false
 * missing-card FAIL the gate exists to prevent — one block further
 * along, and just as wrong.
 *
 * The page is the only authority on its own head, and it discloses it:
 * its RPC traffic carries `eth_blockNumber` (the steady-state audit
 * counts them). This records the highest result seen, so the gate can
 * require the observer to reach what the page had already seen.
 *
 * OBSERVATIONAL AND FAIL-QUIET. It never blocks a request, never
 * rejects, and a body it cannot parse is skipped: a mis-sniffed
 * response must not turn into a finding about the app. The COST of
 * seeing nothing is handled where it matters — an absence with no
 * observed page head is reported as unconfirmed rather than as a
 * defect, so silence here is conservative rather than permissive.
 */
/**
 * ROUND 18 P2 — HEADS ARE SCOPED TO THE DEPLOYMENT ENDPOINT.
 *
 * The page deliberately talks to more than one network: `wagmi.ts`
 * registers an explicit chain-1 transport so ENS reverse lookups
 * resolve, and this file already reasons about that where it decides
 * which endpoint serves the deployment. Pooling every observed height
 * into one maximum mixes those chains, and heights are not comparable
 * across them.
 *
 * The failure is not symmetric, which is why neither direction can be
 * waved through:
 *
 *   TOO HIGH (a foreign chain further along) — the observer can never
 *     pass `pageHead`, so every absence downgrades to incomplete and the
 *     assertion this drive advertises can never fire. Silent, and it
 *     looks exactly like a healthy run.
 *   TOO LOW (a Diamond head skipped) — the gate is passed too easily
 *     and a false missing-card FAIL becomes reachable again.
 *
 * So heights are recorded PER ENDPOINT and resolved only against
 * endpoints positively known to carry Diamond calls. Attribution is by
 * positive evidence rather than by excluding known ENS URLs, for the
 * reason this file already gives about `callsTargetContract`: the ENS
 * endpoint comes from the deployed bundle's own env, this driver cannot
 * enumerate it, and an exclusion list would silently stop matching.
 *
 * Resolution is DEFERRED rather than decided at record time, which is
 * what makes it order-independent: a page can announce a head on an
 * endpoint before it issues its first Diamond call there, and dropping
 * that height would be the too-low failure above.
 */
const pageRpcHeads = new WeakMap(); // page -> Map<key, bigint>
// ROUND 84 P2 — the LOWEST head each endpoint announced, beside the
// highest. See `pageHeadFloorOf`: the bracket needs a block the card's own
// queries cannot predate, and the maximum is the one thing it certainly
// can.
const pageRpcHeadFloors = new WeakMap(); // page -> Map<key, bigint>
const pageDiamondKeys = new WeakMap(); // page -> Set<key>
/**
 * Response handlers that have STARTED but not finished parsing.
 *
 * ROUND 48 P2. `page.on('response', …)` takes an async listener and
 * Playwright does not await it, so a `latest`-block reply arriving just
 * before the scrape can still be inside `res.json()` when `pageHeadOf`
 * samples the map. The DOM already reflects block N; the map holds an
 * older height, or none.
 *
 * Both directions are wrong and neither is loud. Zero disables the
 * absence assertion, which reports an INCOMPLETE observation for a
 * reading that was simply taken too early. A stale non-zero bound is
 * worse: the confirming observer can settle below N and report a
 * missing card as a regression — a false FAIL invented out of a race.
 *
 * The fix is to wait for the parses already in flight, which is bounded
 * work: the set only ever holds responses that arrived before the
 * sample. `page -> Set<Promise>`, each entry removing itself on settle.
 */
const pageHeadPending = new WeakMap(); // page -> Set<Promise<void>>

function watchPageHead(page) {
  const heads = new Map();
  const diamond = new Set();
  // ROUND 19 P2 — AN EXCLUSION HAS TO OUTLIVE THE RESPONSE THAT PROVED
  // IT. Round 18's version returned early on a foreign chain id, which
  // skipped only THAT response: a later body from the same endpoint
  // carrying the Diamond address — an ENS reverse lookup does exactly
  // that — re-admitted it through the substring heuristic, and if the
  // ordering ran the other way the existing entry was never removed at
  // all. Once an endpoint has identified itself as a different chain,
  // that is settled for the rest of the run.
  const foreign = new Set();
  const pending = new Set();
  const floors = new Map();
  pageRpcHeads.set(page, heads);
  pageRpcHeadFloors.set(page, floors);
  pageDiamondKeys.set(page, diamond);
  pageHeadPending.set(page, pending);

  const recordHead = (key, seen) => {
    if (seen === null || seen === undefined) return;
    if (seen > (heads.get(key) ?? 0n)) heads.set(key, seen);
    // The floor is recorded in the same call as the ceiling, deliberately:
    // two passes over the same events is how one of them ends up missing
    // the WebSocket path, which is a live source of head announcements and
    // easy to forget because the HTTP one is what a reader looks at.
    const low = floors.get(key);
    if (low === undefined || seen < low) floors.set(key, seen);
  };
  // An endpoint counts as serving the deployment when the page ASKS IT
  // ABOUT THE DIAMOND. Two tests, because one is not enough:
  //
  //   - `callsTargetContract` reads the `to` of the shapes it knows.
  //   - the raw body carrying the Diamond address catches the case that
  //     one misses, and it is the COMMON one: viem batches contract
  //     reads through multicall3, so the `to` is the aggregator and the
  //     Diamond appears only inside the encoded calldata. Attribution by
  //     `to` alone marked nothing, which showed up immediately as
  //     `pageHead=unobserved` on the live run — the print earning its
  //     place on the first run after it was added.
  //
  // Still positive evidence rather than an exclusion list, for the
  // reason this file already gives: the ENS endpoint comes from the
  // deployed bundle's own env and cannot be enumerated here.
  const DIAMOND_HEX = String(DIAMOND).replace(/^0x/, '').toLowerCase();
  const markDiamond = (key, body, responseBody) => {
    try {
      // WHEN THE ENDPOINT SAYS WHICH CHAIN IT SPEAKS FOR, that settles
      // it in both directions — heights are chain-scoped, so this is the
      // fact actually needed rather than a proxy for it.
      //
      // MEASURED, not assumed: with the address evidence below switched
      // off, a live run reports `pageHead=unobserved`, so the deployed
      // page does not disclose `eth_chainId` on its deployment endpoint
      // within the observed window. Chain id therefore cannot be the
      // sole test, and the address evidence below is load-bearing rather
      // than a belt-and-braces extra.
      //
      // Its value is as the NEGATIVE discriminator, which is what the
      // address heuristic cannot do for itself: the app resolves ENS
      // names on a mainnet endpoint, and a reverse lookup carries an
      // address in its calldata exactly the way a batched Diamond read
      // does — so an endpoint that has identified itself as a different
      // chain is excluded before the heuristic can mistake it.
      if (responseBody !== undefined) {
        const id = chainIdFromRpcPair(body, responseBody);
        // ROUND 52 P2 — A CONTRADICTION IS EVIDENCE, and it excludes.
        //
        // One batch answering `eth_chainId` twice with different chains
        // used to be resolved by whichever reply came first, so the
        // endpoint could be admitted as deployment-serving on half of
        // its own answer and have its later heights trusted. An endpoint
        // that gives two answers has told us it can be relied on for
        // neither — which is precisely what round 51's permanent
        // exclusion is for, arriving by an earlier door.
        if (id === CHAIN_ID_CONFLICT) {
          foreign.add(key);
          diamond.delete(key);
          // ROUND 80 P2 — AND THE EXIT GATE HAS TO HEAR ABOUT IT.
          //
          // There are TWO ways this endpoint can contradict itself: one
          // batch answering `eth_chainId` twice with different chains,
          // which lands here, and two separate responses disagreeing,
          // which lands below. Round 79 recorded only the second, so a
          // same-response conflict marked the endpoint foreign in this
          // page-local set and told the shared map nothing — and if the
          // synthetic probe then answered the expected chain, the
          // reconciliation trusted it and an inferred missing surface
          // could be reported as a product regression on a provider that
          // had contradicted itself in a single reply.
          //
          // The parallel-site shape once more, and inside the fix for the
          // very question it belongs to: I split the conflict into two
          // paths and handled one.
          observedPageChain.set(key, CHAIN_ID_CONFLICT);
          return;
        }
        if (id !== null) {
          // Recorded for the unknown-chain gate, whichever chain it is.
          //
          // ROUND 79 P2 — AND A SECOND, DIFFERENT ANSWER IS A CONTRADICTION.
          //
          // `set` let a later reply overwrite an earlier one, so an
          // endpoint that answered two different chains across two
          // responses looked consistent to the gate — the same laundering
          // round 52 closed for a single batch, arriving by a slower
          // door. `CHAIN_ID_CONFLICT` is the value the gate already reads
          // as "this endpoint cannot say", so recording it here needs no
          // new vocabulary.
          const prior = observedPageChain.get(key);
          observedPageChain.set(
            key,
            prior !== undefined && prior !== id ? CHAIN_ID_CONFLICT : id,
          );
          if (id === CHAIN_ID) {
            // ROUND 51 P2 — AND THE EXCLUSION IS PERMANENT, so this
            // cannot re-admit.
            //
            // The `foreign.has(key)` return sits BELOW this line, so an
            // endpoint that had already identified itself as another
            // chain and then answered with the expected id was added
            // back to `diamond` on the way past. Round 19 wrote "once an
            // endpoint has identified itself as a different chain, that
            // is settled for the rest of the run" and then left one door
            // open — the door where the endpoint is inconsistent, which
            // is precisely the endpoint the rule exists for.
            //
            // An endpoint reporting two different chain ids has told us
            // it cannot be trusted to say which chain a height belongs
            // to. Trusting its heights again lets a wrong-chain bound
            // reach the absence gate, where a degraded page can be
            // blamed for omitting a card it was right to omit.
            if (!foreign.has(key)) diamond.add(key);
          } else {
            // A DIFFERENT chain is positive evidence the other way, and
            // it outranks the address heuristics below — an ENS endpoint
            // asked to reverse-resolve an address carries that address
            // in its calldata exactly as a batched Diamond read does.
            // Recorded permanently, and it also REVOKES any earlier
            // admission, since the heuristic may have run first.
            foreign.add(key);
            diamond.delete(key);
            return;
          }
        }
      }
      if (foreign.has(key)) return;
      if (typeof body === 'string' && body.toLowerCase().includes(DIAMOND_HEX)) {
        diamond.add(key);
        return;
      }
      if (callsTargetContract(rpcCallsFromBody(body), DIAMOND)) diamond.add(key);
    } catch {
      // Observational only.
    }
  };

  // ROUND 16 P2 — SOCKETS TOO, not only HTTP. `wagmi.ts` wraps the chain
  // reads in `fallback([webSocket, http])`, so on a healthy network the
  // page can learn a new block over a socket and never issue the
  // `eth_blockNumber` an HTTP-only listener depends on — its announced
  // head then lags its real one, and the gate compares against a bound
  // that stopped moving.
  //
  // A socket is its own endpoint: keyed by the socket object, and marked
  // as deployment-serving by what the PAGE sends over it.
  //
  // ⚠ INERT TODAY, AND THE COMMENT SAYING OTHERWISE WAS WRONG (round 19
  // P2). If the page makes ANY JSON-RPC call over a socket, this drive
  // exits 2 near the end — a blanket refusal to vouch for reads that
  // bypassed the allowlist, the response ledger and the chain probe,
  // all of which ride on an HTTP-only route. That exit happens BEFORE
  // any verdict or coverage is computed, so on precisely the runs where
  // socket heads would matter, nothing downstream ever reads them.
  //
  // The capture is kept rather than deleted because it is correct and
  // tested, and because the blocker is the thing expected to move: when
  // socket frames are classified well enough to lift it, this needs no
  // change. But it must not be described as shrinking the head race
  // today, which is what the previous comment and the coverage row both
  // claimed. Extending socket classification is out of scope here.
  //
  // The related worry — a socket carrying ONLY subscriptions would never
  // be marked — was checked rather than assumed: `wagmi.ts` builds
  // `fallback([webSocket(...), http(...)])`, and viem's fallback sends
  // EVERY request to the first working transport, so while the socket is
  // healthy the Diamond reads travel over it and it marks itself.
  //
  // Linking a socket to an HTTP endpoint by HOST was considered and
  // rejected: providers routinely serve several chains from one host on
  // different paths or keys, so host-matching would re-introduce exactly
  // the cross-chain pooling this scoping exists to remove.
  page.on('websocket', (ws) => {
    const key = ws;
    ws.on('framesent', ({ payload }) => markDiamond(key, payload));
    ws.on('framereceived', ({ payload }) => {
      try {
        recordHead(key, blockNumberFromWsFrame(payload));
      } catch {
        // Observational only, exactly as below.
      }
    });
  });
  // ROUND 48 P2 — REGISTERED BEFORE IT AWAITS ANYTHING.
  //
  // The listener is wrapped rather than having the tracking added inside
  // it, because the registration has to happen SYNCHRONOUSLY with the
  // event: anything after the first `await` is already too late to be
  // seen by a sample taken in between, which is the race itself.
  page.on('response', (res) => {
    const done = handleResponse(res).catch(() => {});
    pending.add(done);
    done.finally(() => pending.delete(done));
  });

  async function handleResponse(res) {
    try {
      const req = res.request();
      if (req.method().toUpperCase() !== 'POST') return;
      const body = req.postData();
      if (!body) return;
      const key = res.url();
      // One `res.json()` for both questions: a response body can only be
      // consumed once cheaply, and the chain-id evidence needs it.
      // ROUND 33 P2 — `eth_getBlockByNumber` IS A HEAD ANNOUNCEMENT too,
      // so both gates below have to admit it or the parser never sees the
      // body it was just taught to read. The cheap string test stays a
      // string test: `blockNumberFromRpcPair` is the one that decides
      // whether the block tag was actually `'latest'`, and duplicating
      // that judgement here would be a second rule to drift.
      const announcesHead =
        body.includes('eth_blockNumber') || body.includes('eth_getBlockByNumber');
      const parsed = body.includes('eth_chainId') || announcesHead
        ? await res.json().catch(() => undefined)
        : undefined;
      markDiamond(key, body, parsed);
      // Cheap reject before parsing — most POSTs are not this.
      if (!announcesHead) return;
      // The PARSE is a pure function in `rpc-verdict.mjs`, tested
      // there. Batches answered out of order, batches mixing methods
      // and error members where a result was expected are the cases
      // that matter, and a live chain will not reliably produce any of
      // them — inline here, none of them could be exercised.
      recordHead(key, blockNumberFromRpcPair(body, parsed));
    } catch {
      // Observational only. See the note above.
    }
  }
}

/**
 * The highest head the page announced ON AN ENDPOINT SERVING THE
 * DIAMOND, or 0n if none was observed.
 *
 * 0n also covers "heights were seen, but only on endpoints never proven
 * to serve the deployment" — which is the honest answer rather than a
 * conservative guess, and the gate treats it as not-ready.
 */
/**
 * Let the head readings already in flight finish before they are read.
 *
 * ROUND 48 P2, and see `pageHeadPending`. Awaiting a SNAPSHOT of the set
 * rather than the set itself: a parse that completes may start another
 * response's work, and looping until empty would make this unbounded on
 * a page that polls. Everything that arrived before the sample is what
 * the sample needs; anything arriving after it is, by definition, not
 * part of what the DOM was showing.
 */
async function settleHeadReads(page) {
  const pending = pageHeadPending.get(page);
  if (!pending || pending.size === 0) return;
  await Promise.allSettled([...pending]);
}

function pageHeadOf(page) {
  const heads = pageRpcHeads.get(page);
  const diamond = pageDiamondKeys.get(page);
  if (!heads || !diamond) return 0n;
  let best = 0n;
  for (const [key, seen] of heads) {
    if (!diamond.has(key)) continue;
    if (seen > best) best = seen;
  }
  return best;
}

/**
 * The LOWEST head an endpoint serving the Diamond announced on this page,
 * or 0n if none was observed.
 *
 * ROUND 84 P2 — because "the page reached block N" is not "the card read
 * block N", and the bracket was treating it as though it were.
 *
 * `pageHeadOf` returns the highest head seen ANYWHERE on the page, and the
 * app announces heads far more often than the card refetches: a block
 * watcher ticks every few seconds while the card's own queries poll on a
 * much slower cadence. So the pre-render end of the bracket was routinely
 * pinned to a block NEWER than the data the card was rendering. Around a
 * grace transition that is exactly wrong — the card can legitimately still
 * be showing the block-N `not yet` state while both simulations at N+1
 * answer `true`, and the verdict then reports the product for withholding
 * a close-out the protocol had only just started accepting. A false FAIL
 * on the one card this drive exists to judge, manufactured out of the
 * page's own polling cadence.
 *
 * This drive cannot tie a render to a block — nothing in the DOM says
 * which one a query consumed, and re-deriving the app's refetch interval
 * would be exactly the second copy of app config this file refuses to keep
 * elsewhere. What it CAN establish is a block the card's data cannot
 * predate: the first head the page was seen to reach. Bracketing from
 * there to the post-scrape head spans every block the card could possibly
 * have read, so when both ends agree the answer did not change anywhere in
 * that span and the disagreement with the card is real whichever block it
 * used. When they differ the observation is INCOMPLETE — which is the
 * outcome Codex asked for, reached by widening the window rather than by
 * abandoning the check.
 *
 * The cost is stated: a grace crossing inside the page's lifetime now
 * yields `incomplete` where the old bracket would have accused. That is
 * the honest answer, since in that window this drive genuinely cannot tell
 * a stale render from a wrong one.
 */
function pageHeadFloorOf(page) {
  const floors = pageRpcHeadFloors.get(page);
  const diamond = pageDiamondKeys.get(page);
  if (!floors || !diamond) return 0n;
  let low = 0n;
  for (const [key, seen] of floors) {
    if (!diamond.has(key)) continue;
    if (low === 0n || seen < low) low = seen;
  }
  return low;
}

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
  // ROUND 14 P2 — AND NEITHER MUST THE PAGE'S OWN VIEW OF THE CHAIN.
  //
  // The absence gate has to know whether THIS observer has caught up
  // with the provider whose DOM it is judging, and only the page can
  // answer that. Attached here, before the first navigation, for the
  // same reason the socket watcher is.
  watchPageHead(page);
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
  // FORCED-CLOSE CARD (#2069), judged on its own evidence.
  //
  // `lenderHoldsActive` is deliberately STRICTER than lender-card
  // eligibility, which admits FallbackPending: this card is gated on
  // `resolvedLoanStatus === Active`, so a FallbackPending position is
  // one where its absence is CORRECT. Feeding the looser predicate in
  // would manufacture a missing-card FAIL on exactly the positions the
  // product is right about — the same class of error `stillEligible`
  // exists to avoid for the lender card.
  const forcedClose =
    ROLE === 'lender' && loan ? await observeForcedClose(page, loan) : null;
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
    // The forced-close observation and its verdict, kept whole so the
    // reporter can print the reason rather than re-deriving it.
    forcedClose,
    forcedCloseVerdict: forcedClose
      ? forcedCloseVerdict(forcedClose, FORCED_CLOSE_COPY)
      : null,
    // Reported, not judged: evidence about whether the absence gate is
    // armed on this deployment (round 14).
    forcedClosePageHead: forcedClose ? (forcedClose.pageHead ?? null) : null,
    // The bracket's lower end, reported beside its upper one so the span
    // the protocol comparison was made over is visible (round 84).
    forcedCloseHeadFloor: forcedClose ? (forcedClose.headFloor ?? null) : null,
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
  // ROUND 1 P2 — CARRY THE FRESH READS BACK ONTO THE LOAN.
  //
  // This function re-reads status and authority and then threw both
  // away, returning only a reason string. Downstream predicates — the
  // forced-close one above all, which gates on `status === Active` —
  // then judged against values minutes old. An Active→FallbackPending
  // transition makes the page correctly drop the forced-close card
  // while the drive calls it a defect; the reverse hides a genuine
  // missing card. Writing them back costs nothing: the reads already
  // happened here.
  loan.status = Number(live.status);
  loan.authority = authorityNow;
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
 * already-Advanced one): `ModeContext` persists `app.mode`, so once
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
 * The FORCED-CLOSE card, observed on the same visit as the lender exit
 * chooser and judged separately from it.
 *
 * Separately on purpose. The two cards render on the same page for the
 * same role, and folding their verdicts together is the mistake this
 * file has already recorded twice: aggregating lets one card's missing
 * row hide a positively observed defect on the other. Each keeps its
 * own presence, its own reason and its own contribution to the exit
 * code.
 *
 * WAITS rather than reading once. Its readiness reads are chain reads
 * that can outrun a single instantaneous scrape, and a false "absent"
 * here would be reported as a FAIL — the one outcome that gets a check
 * switched off rather than fixed. `state: 'attached'` because the
 * question is whether the card mounted at all, which is what the
 * absence verdict is about; a mounted card scrolled out of view is
 * still an answer.
 */
/**
 * Would the protocol ACCEPT the close-out this card is offering?
 *
 * ROUND 57 P2 — SIMULATED, not enumerated, and the product's own code
 * makes the argument better than a comment here can. `ForcedCloseCard`
 * simulates `triggerDefault(loanId, [])` before submitting, and says why:
 * it asks the contract "would this work right now?" instead of
 * re-deriving the answer from a second copy of the branch rules, and it
 * "covers the gates this decision does not model".
 *
 * Round 55 read three views instead — `isLoanDefaultable`, `paused`,
 * `sequencerHealthy` — and I defended the enumeration on the grounds
 * that those are the views the app consults. They are not the whole
 * predicate: a liquid, non-collapsed ERC-20 loan with no internal match
 * needs a non-empty enabled adapter list, and all three of those reads
 * return the accepting combination while `triggerDefault(loanId, [])`
 * is guaranteed to revert. The enumeration was already incomplete when
 * I wrote that it might become so.
 *
 * THE EXACT CALL THE CARD OFFERS, from the observed lender's account,
 * so this answers the question the lender's click would ask and not a
 * proxy for it.
 *
 * Three outcomes, decided by the classifier this repo already has:
 *
 *   - resolves           the protocol would accept it
 *   - reverts            it would be refused — `classifyRpcFailure`
 *                        calls a revert `'answered'`, which is positive
 *                        evidence about the CONTRACT rather than the
 *                        endpoint
 *   - anything else      `undefined`: this drive could not ask, and a
 *                        drive that could not ask must neither accuse
 *                        nor vouch
 *
 * @param {bigint} loanId
 * @param {bigint} [blockNumber] simulate against this block when given
 * @returns {Promise<boolean|undefined>}
 */
async function probeCloseOut(loanId, blockNumber, account) {
  try {
    await pub.simulateContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'triggerDefault',
      args: [loanId, []],
      // ROUND 75 P2 — THE ACCOUNT IS A PARAMETER, not the module-scoped
      // `observed`.
      //
      // The round-74 pre-selection runs BEFORE `let observed` is
      // initialised, so reading it here threw a `ReferenceError` from
      // the temporal dead zone — which the catch below then classified
      // as a transport failure and returned as `undefined`. Every
      // candidate came back unknown, `acceptsCloseOut` stayed empty, and
      // the whole authority-and-walk prioritisation was INERT while
      // reading as though it worked.
      //
      // Passing the candidate's own authority is also the more correct
      // question: it simulates the close-out as the lender whose card it
      // is, which is what `saleLockedOn` already does with its
      // `authority` argument.
      account: account ?? observed,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    return true;
  } catch (err) {
    // A REVERT is the protocol answering. Anything else — a dead
    // endpoint, a rate limit — is a failure to determine, and
    // `classifyRpcFailure` is the one place that judgement lives.
    //
    // ROUND 75 P2 — AND THIS DRIVE BEING WRONG ABOUT ITSELF IS RETHROWN.
    //
    // The swallow above is what made the TDZ silent: a `ReferenceError`
    // is not a chain condition, and classifying it as one turned a
    // programming error into a permanent "could not ask". That is the
    // exact lesson `isTransportFailure` was written for in round 31 —
    // "a catch that cannot tell a dead endpoint from a programming error
    // will keep reporting the programming error as a chain condition" —
    // and this probe was not using it.
    if (classifyRpcFailure(err) === 'answered') return false;
    if (!isTransportFailure(err)) throw err;
    return undefined;
  }
}

/**
 * Would the protocol settle this close-out by INTERNAL MATCH?
 *
 * ROUND 64 P2 — because "the transaction would succeed" does not say
 * WHICH settlement the lender is about to get.
 *
 * `triggerDefault(loanId, [])` simulates cleanly on a defaultable loan
 * whether the contract dispatches an internal match or takes the in-kind
 * path, because the match is dispatched FIRST and succeeds. So a card
 * that has regressed to promising collateral in kind, on a loan with a
 * live match candidate, passes every check this drive had: the
 * simulation says yes, and the standard receipt deliberately covers both
 * outcomes so its six rows are satisfied too. The lender reads "you
 * receive the collateral" and is repaid the lent asset instead.
 *
 * THE CONTRACT'S OWN QUESTION, not a re-derivation. This is the same
 * view `decideForcedClose` consumes and the same one
 * `attemptInternalMatchAutoDispatch` consults, so it already folds in
 * the `internalMatchEnabled` config flag, the subject's status and the
 * matchable-collateral filter. Re-deriving any of that here would go
 * stale the moment one of them moved — the argument round 57 made for
 * simulating rather than re-deriving the grace ladder, at the next
 * branch down.
 *
 * Tri-state, exactly like `probeCloseOut`: `true` / `false` are the
 * chain answering, `undefined` is a failure to determine and asserts
 * nothing.
 */
async function probeInternalMatch(loanId, blockNumber) {
  try {
    const out = await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'hasInternalMatchCandidate',
      args: [loanId],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    // `(bool found, uint256 candidateId)`. Only the first is read: a
    // candidate id without `found` is not a candidate, and reading the
    // id for anything would be this drive re-deciding a question the
    // view already answered.
    const found = Array.isArray(out) ? out[0] : out?.found;
    return typeof found === 'boolean' ? found : undefined;
  } catch (err) {
    // UNDEFINED FOR EVERY WAY THE CHAIN CAN DECLINE, and deliberately not
    // a `classifyRpcFailure` branch that returns `false`. That helper
    // distinguishes "the contract answered with a revert" from "nothing
    // answered", which matters for a SIMULATION — a revert there is the
    // protocol saying no. This is a `view`: a revert from it is the view
    // declining to answer, not an answer of `false`.
    //
    // ROUND 76 P2 — AND THE ROUND-75 GUARD WAS PUT ABOVE THIS, WHICH
    // BROKE IT.
    //
    // I added `if (!isTransportFailure(err)) throw err` here to stop a
    // programming error being swallowed, and a view REVERT is not a
    // transport failure — so the guard threw on exactly the case the
    // paragraph beneath it says must return `undefined`. An older
    // deployment without `hasInternalMatchCandidate`, or a custom revert,
    // would have aborted the whole run instead of reporting the route as
    // unread. A guard that contradicts the comment directly below it.
    //
    // The order is now: every shape that is the CHAIN declining comes
    // first and answers `undefined`; only what is left — this drive being
    // wrong about itself — is rethrown. The decode names are enumerated
    // on the SAFE side, so a shape not listed is rethrown and loud rather
    // than quietly absorbed.
    if (classifyRpcFailure(err) === 'answered') return undefined;
    if (isTransportFailure(err)) return undefined;
    const decodeShaped = (e) => {
      for (let cur = e, hops = 0; cur && hops < 12; cur = cur.cause, hops += 1) {
        if (/ZeroData|DecodingData|AbiDecoding|ContractFunctionZeroData/.test(cur?.name ?? '')) {
          return true;
        }
      }
      return false;
    };
    if (decodeShaped(err)) return undefined;
    throw err;
  }
}

/**
 * The forced-close observation, with its chain facts read AT THE SCRAPE.
 *
 * ROUND 2 P2, and the second half of round 1's staleness fix. Writing
 * the fresh status back in `stillEligible` closed the
 * discovery→revalidation gap and left the one that follows it:
 * navigation, the settle wait, the readiness poll and the confirmation
 * scrape can together run for a minute or more, and a loan that leaves
 * Active inside that window makes the page CORRECTLY drop the card
 * while a pre-navigation `loan.status` still calls it a defect.
 *
 * So the status and the authority are re-read here, beside the DOM
 * observation they are judged against, rather than inherited from
 * whenever the loan was last revalidated.
 *
 * ROUND 2 P2 — AND THE READS GO THROUGH `discovery()`. `saleLockedOn`
 * rethrows anything that is not a revert, and this call sits outside
 * the navigation try-block: an RPC timeout or a rate-limit would have
 * escaped `visit()` and exited Node with 1, the code this drive
 * reserves for a PRODUCT REGRESSION. A prerequisite read that could not
 * answer is BLOCKED, never a finding about the app.
 */
async function observeForcedClose(page, loan) {
  // ROUND 55 P2 — BRACKET THE OBSERVATION, because the answer that
  // validates a render must not come from after it.
  //
  // Round 54 read defaultability only in the pinned snapshot, which is
  // taken AFTER the whole DOM observation — and that observation can
  // run for thirty seconds before its interaction timeouts. A grace
  // deadline crossing inside that window meant a card that exposed a
  // ready action while the protocol would still have refused it was
  // validated by a `true` read taken afterwards. The transient unsafe
  // state, which is exactly what this drive exists to catch, was
  // resolved away by the passage of time.
  //
  // So it is read BEFORE as well. The two together say whether the
  // window was quiet: both `true` is a clean pairing, and a
  // `false`-then-`true` crossing is reported as an INCOMPLETE
  // observation rather than guessed at in either direction — the card
  // may legitimately have started withheld and become ready, and this
  // drive cannot tell that from the defect without sampling every
  // render, which it does not.
  // ROUND 58 P2 — THE HEAD THE RENDER CAME FROM IS SAMPLED BEFORE THE
  // RENDER, not after it.
  //
  // Round 57 pinned the pre-render simulation to `pageHead` and left
  // `pageHead` where it was: sampled AFTER `readForcedCloseCard`
  // returns. That is the head the page had reached by the END of the
  // observation, and the observation opens the confirmation and waits
  // out interaction timeouts. Across a grace boundary a regressed card
  // can expose a ready action at block N, the page can announce N+1
  // while the drive is still inspecting, and both simulations then run
  // against accepting blocks — the unsafe render validated by a head it
  // never rendered at. The fix pinned the right axis and kept the wrong
  // sample.
  //
  // Sampled here, before anything is read from the DOM, so it is a head
  // the page had actually reached when the card under judgement was on
  // screen. `settleHeadReads` first, for round 48's reason: an in-flight
  // parse would otherwise make this zero or stale.
  //
  // The LATER sample below is kept and still feeds the absence gate,
  // where "has the page caught up" is the question and the newest head
  // is the right answer. Two samples, two different questions.
  await settleHeadReads(page);
  const headAtRender = pageHeadOf(page);
  // ROUND 84 P2 — AND THE PRE-RENDER END GOES TO THE FLOOR, not to the
  // newest head the page happened to have reached.
  //
  // Round 58 moved this sample ahead of the DOM read, which was right and
  // did not go far enough: `pageHeadOf` is the highest head seen ANYWHERE
  // on the page, and the app announces heads far more often than the card
  // refetches. The sample was therefore still routinely NEWER than the
  // data being judged — the same defect round 58 fixed, one cadence
  // further in.
  //
  // `pageHeadFloorOf` carries the full argument. In short: this drive
  // cannot tie a render to a block, so it brackets from a block the
  // card's data cannot predate to one it cannot postdate, and a
  // disagreement anywhere in that span makes the observation incomplete
  // rather than an accusation.
  const headFloor = pageHeadFloorOf(page);
  const headBefore = headFloor === 0n ? headAtRender : headFloor;
  // ROUND 57 P2 — THE OTHER END OF THE BRACKET, AT THE PAGE'S OWN HEAD.
  //
  // Round 55 took a pre-read on `OBSERVE_RPC` at wall-clock `latest`,
  // which is not the chain view the render came from. This file treats
  // the page's provider and `OBSERVE_RPC` as independent everywhere
  // else — the round-8 confirming re-read exists for exactly that — so
  // across a grace boundary the observer can be at N+1 while the page
  // and its DOM are still at N: both ends of the bracket answer `true`,
  // the window looks quiet, and a ready action rendered at a head where
  // the protocol still refused it is validated.
  //
  // `pageHead` is the head the PAGE was seen to reach, and it is
  // already recorded for the absence gate. Simulating against it asks
  // the question the render was answering.
  //
  // Where the page never disclosed a head, this falls back to an
  // unpinned probe — the round-55 bracket, which is weaker (wall-clock
  // ordering rather than a head) but no weaker than what it replaces.
  // Saying which one was used is left to the verdict, which reports an
  // unanswerable probe as an incomplete observation either way.
  // ROUND 76 P2 — the pre-render bracket reads take the same cover. They
  // run outside `visit()`'s navigation catch, so a rethrown programming
  // error here escaped as an unhandled rejection and exited 1 against the
  // product, and could skip the browser cleanup `discovery` performs.
  const defaultableBefore = await discovery(
    `simulating the close-out for loan ${loan.id} before the scrape`,
    () =>
      headBefore === 0n ? probeCloseOut(loan.id) : probeCloseOut(loan.id, headBefore),
  );
  // ROUND 64 P2 — AND WHICH SETTLEMENT, bracketed the same way and for
  // the same reason. A match candidate can appear or be consumed inside
  // the observation window, so one read cannot distinguish "the card is
  // promising the wrong settlement" from "the answer changed while we
  // watched". Both ends agreeing is what makes the comparison a finding;
  // a disagreement is reported as incomplete.
  const matchBefore = await discovery(
    `reading the settlement route for loan ${loan.id} before the scrape`,
    () =>
      headBefore === 0n
        ? probeInternalMatch(loan.id)
        : probeInternalMatch(loan.id, headBefore),
  );
  //
  // ROUND 59 P2 — AND THE PROBE ITSELF RUNS BEFORE THE OBSERVATION, not
  // only its PIN.
  //
  // Round 58 moved the head SAMPLE ahead of the DOM read and left the
  // probe where it was. For a pinned probe that is harmless — a
  // simulation at block N answers the same whenever it is run — but the
  // zero-head fallback is UNPINNED, so it was still executing after an
  // observation that can spend thirty seconds polling and more
  // inspecting the confirmation. A grace boundary crossed inside that
  // window and both ends answered `true`: the bracket read as quiet and
  // an unsafe render passed, which is the defect the bracket exists to
  // catch, surviving in the one branch the fix did not move.
  const card = await readForcedCloseCard(page);
  // BESIDE THE SCRAPE, not at confirmation time (round 14 P2). What
  // matters is the head the page had reached when it rendered — or
  // declined to render — the card being judged. Sampling it later would
  // let the page move on and set a bar this observer must clear for a
  // render it never looked at.
  //
  // ROUND 48 P2 — AND THE READINGS IN FLIGHT ARE LET FINISH FIRST.
  // Playwright does not await a response listener, so a `latest` reply
  // that arrived just before the scrape can still be inside `res.json()`
  // here. Sampling through that race reads a head the page has already
  // passed — zero, which reports an incomplete observation for a reading
  // taken too early, or a stale height, which lets the confirming
  // observer settle below the head the DOM was showing and call a
  // correctly absent card a regression.
  await settleHeadReads(page);
  const pageHead = pageHeadOf(page);
  // ROUND 4 P2 — ONE BLOCK FOR ALL THREE FACTS.
  //
  // `Promise.all` makes these concurrent; it does not pin them to a
  // common block, and each RPC resolves `latest` independently. A
  // `completeLoanSale` landing mid-flight can therefore produce a TORN
  // snapshot — `ownerOf` answering from before the sale while
  // `positionLock` answers from after it — yielding a held / Active /
  // unlocked combination that never existed on any single block. The
  // page, which was correct to omit the card while the accepted sale
  // was pending, would then be reported as missing it.
  //
  // Pinning to one block number makes the three facts a snapshot rather
  // than three samples. It also makes them consistent with each other
  // by construction, which no amount of re-reading can achieve.
  //
  // ROUND 54 P2 — AND A FOURTH FACT: whether the PROTOCOL agrees the
  // close-out can run at all.
  //
  // The pinned snapshot established Active status and ownership and
  // nothing about the grace deadline, so a regressed page rendering a
  // READY route with an enabled submit was certified by this drive —
  // certifying an action `triggerDefault` is guaranteed to refuse, after
  // charging the lender a network fee. The copy was being allowed to
  // substantiate itself.
  //
  // READ, never derived. `src/data/forcedClose.ts` states the rule for
  // the app and it binds this drive identically: `LibVaipakam.gracePeriod`
  // walks governance-configurable `graceBuckets`, and the ladder in the
  // code is only the fallback used when that array is empty — so a client
  // reproducing it is correct until the first deployment tunes the
  // buckets and silently wrong afterwards. `isLoanDefaultable(loanId)` is
  // the chain's own answer and the same view the app consults.
  //
  // In the pinned block with the others, so it cannot disagree with the
  // status it is judged beside.
  const [pinnedBlock, live, authorityNow, pinnedSale, pinnedDefaultable, pinnedMatch] =
    await discovery(
    `re-reading loan ${loan.id} beside the forced-close scrape`,
    async () => {
      // `cacheTime: 0` — the block this snapshot pins itself to must be
      // the chain's, not one viem answered from a 4-second cache filled
      // by an earlier visit (round 13 P2). The confirming read below
      // compares against it, and a comparison between two cached copies
      // of the same number establishes nothing.
      const blockNumber = await pub.getBlockNumber({ cacheTime: 0 });
      return Promise.all([
        blockNumber,
        pub.readContract({
          address: DIAMOND,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getLoanDetails',
          args: [loan.id],
          blockNumber,
        }),
        tokenOwnerOf(loan.lenderTokenId, blockNumber),
        saleLockedOn(loan.lenderTokenId, loan.id, blockNumber, loan.authority),
        // ROUND 57 P2 — THE EXACT CALL, simulated. Round 55's three
        // reads were not the whole predicate; see `probeCloseOut`.
        //
        // `undefined` when the simulation could not be run, so the
        // verdict can tell "the protocol says no" from "this drive
        // could not ask" — the distinction every other probe here
        // carries.
        probeCloseOut(loan.id, blockNumber),
        // ROUND 64 P2 — the settlement ROUTE, in the same pinned
        // snapshot as everything else it will be compared against.
        probeInternalMatch(loan.id, blockNumber),
      ]);
    },
  );
  const pinnedHoldsActive =
    Number(live.status) === STATUS_ACTIVE &&
    typeof authorityNow === 'string' &&
    authorityNow.toLowerCase() === String(observed).toLowerCase();

  // ROUND 7 P2 — CONFIRM A MISSING-CARD FAIL BEFORE REPORTING IT.
  //
  // Pinning the three reads to one block made them a consistent
  // snapshot; it did not make them CONTEMPORANEOUS WITH THE DOM. The
  // deployed bundle uses its own RPC, which can be a block ahead of
  // `OBSERVE_RPC`, so the page can already have seen a terminalizing
  // transaction that this observer has not — the card correctly absent
  // while the snapshot still reads held / Active / unlocked. That is a
  // false missing-card regression, and it is the one verdict here whose
  // cost is a wrongly accused product.
  //
  // Only the FAIL path pays for the re-read, and only when the card was
  // absent: if the position has left the eligible set by a later block,
  // the page was ahead of us and the observation is `blocked` instead.
  // A confirmation step on the accusing path, rather than a wider net.
  let later = null;
  if (pinnedHoldsActive && !card.mounted) {
    // ROUND 8 P2 — RECONFIRM EVERY FACT THE DOM COULD BE REFLECTING,
    // not only the status.
    //
    // The first version re-read `getLoanDetails` alone, so a lender
    // token TRANSFERRED at a block the page had seen and this observer
    // had not still produced a false missing-card FAIL: the loan is
    // still Active, and the stale ownership carried straight through
    // the confirmation. Ownership and the sale state can each explain
    // an absent card exactly as well as status can, so all three are
    // re-read at the confirming head.
    const confirmed = await discovery(
      `confirming loan ${loan.id} is still eligible before reporting a missing card`,
      async () => {
        // ROUND 13 P2 — A GENUINELY NEWER HEAD, OR NO CONFIRMATION.
        //
        // Two defects in one line. `getBlockNumber()` is served from
        // viem's cache (`cacheTime` defaults to `pollingInterval`, 4s,
        // and this client sets neither), so a call milliseconds after
        // the pinned one returned THE SAME BLOCK — the confirmation
        // re-read the identical state and could only ever agree with
        // itself, which let the false missing-card FAIL through
        // untouched. And even uncached, the chain need not have moved
        // yet, so the same reads at the same height prove nothing.
        //
        // So: poll uncached for a strictly greater head, briefly. If it
        // never arrives, the confirmation DID NOT HAPPEN, and the honest
        // report is that the absence could not be judged — not an
        // accusation resting on a re-read that never re-read anything.
        //
        // ROUND 14 P2 — AND A HEAD THIS OBSERVER HAS CAUGHT UP TO.
        //
        // "Strictly newer than the block I pinned" proves only that I
        // moved. The page reads an INDEPENDENT provider that can be two
        // or more blocks ahead, so a transition at N+2 correctly removes
        // the card while a confirmation at N+1 re-reads a still-eligible
        // position — the same false FAIL, one block further along.
        // `confirmationReady` requires both, and treats an unobserved
        // page head as not-ready rather than as satisfied.
        let head = await pub.getBlockNumber({ cacheTime: 0 });
        const until = Date.now() + 20_000;
        while (!confirmationReady(head, pinnedBlock, pageHead) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 1_000));
          head = await pub.getBlockNumber({ cacheTime: 0 });
        }
        if (!confirmationReady(head, pinnedBlock, pageHead)) {
          // NAME WHICH CONDITION FAILED (round 23 P2). The two causes
          // send an operator to different places: a stale OBSERVE_RPC,
          // or page-head instrumentation that saw nothing. Collapsing
          // them into one sentence about "never advanced" was false in
          // the second case and pointed at the wrong thing.
          return {
            unconfirmed: true,
            why:
              pageHead === 0n
                ? 'the card was absent, but this drive never observed the page announce a head on the deployment endpoint, so it could not be shown to have caught up'
                : head <= pinnedBlock
                  ? "the card was absent, but this observer's chain view never advanced past the block it scraped at, so a page reading ahead of it could not be ruled out"
                  : `the card was absent, and this observer reached ${head} but the page had already announced ${pageHead}, so it was still behind the view that rendered the page`,
          };
        }
        const [status, holder, sale] = await Promise.all([
          pub.readContract({
            address: DIAMOND,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getLoanDetails',
            args: [loan.id],
            blockNumber: head,
          }),
          tokenOwnerOf(loan.lenderTokenId, head),
          saleLockedOn(loan.lenderTokenId, loan.id, head, loan.authority),
        ]);
        return { status, holder, sale };
      },
    );
    // THE THREE FACTS, NOT A VERDICT. What they mean for eligibility is
    // decided by `reconcileEligibility`, which lives in the verdict
    // module because it is a pure function with three ordered cases and
    // no way to exercise it from a live chain — the same argument that
    // moved `visitVerdict` out of this file.
    //
    // It was a truthiness test here, and round 12's tri-state probe
    // walked straight into it: an unclassifiable `'unknown'` marked the
    // position ineligible, which reports "nothing is wrong" for a
    // missing card on the strength of a sale never established.
    later = confirmed.unconfirmed
      ? { unconfirmed: true, why: confirmed.why }
      : {
          active: Number(confirmed.status.status) === STATUS_ACTIVE,
          stillHeld:
            typeof confirmed.holder === 'string' &&
            confirmed.holder.toLowerCase() === String(observed).toLowerCase(),
          sale: confirmed.sale,
        };
  }

  const { lenderHoldsActive, saleLocked, absenceUnconfirmed, absenceUnconfirmedWhy } =
    reconcileEligibility(
    { lenderHoldsActive: pinnedHoldsActive, saleLocked: pinnedSale },
    later,
  );
  return {
    ...card,
    lenderHoldsActive,
    saleLocked,
    // ROUND 54 P2 — the PROTOCOL's own answer about whether this
    // close-out can run, read at the pinned block beside the status it
    // is judged with. `undefined` where the read could not answer.
    defaultable: pinnedDefaultable,
    // ROUND 55 P2 — and the SAME QUESTION asked BEFORE the DOM
    // observation, so an answer taken afterwards cannot validate a
    // render that preceded it. The verdict compares the two.
    defaultableBefore,
    // ROUND 64 P2 — WHICH SETTLEMENT the protocol would perform, both
    // ends of the same bracket. `triggerDefault` succeeding says the
    // close-out would run; it does not say whether the lender receives
    // the collateral or is repaid the lent asset, because the contract
    // dispatches an internal match FIRST and that path succeeds too.
    // The verdict compares these against the route the card is painting.
    internalMatch: pinnedMatch,
    internalMatchBefore: matchBefore,
    absenceUnconfirmed,
    // ROUND 24 P2 — and the REASON with it. Round 23 produced this
    // string and then dropped it here, so every diagnosis fell back to
    // the generic sentence and none of the specific ones ever reached an
    // operator. The pure reconciliation test could not see it: the
    // defect is in the projection BETWEEN the two, which is exactly the
    // seam a unit test on either side does not cover.
    absenceUnconfirmedWhy,
    // Carried out for the REPORT only — `forcedCloseVerdict` ignores it.
    pageHead: pageHead === 0n ? null : String(pageHead),
    // ROUND 84 P2 — the OTHER end of the bracket, reported for the same
    // reason: the run should say which span of blocks its protocol
    // comparison was made over, rather than leaving a reader to assume it
    // was a point read at the head. Also report-only.
    headFloor: headBefore === 0n ? null : String(headBefore),
  };
}

/**
 * The visibility predicate's SOURCE, so the mount wait can run the same
 * one the scrape runs (round 60 P2).
 *
 * Read out of this file rather than written a third time. `notClipped`,
 * `paintsText` and `visible` already exist twice — once for the card
 * scrape and once for the confirmation receipt, a duplication #2102
 * tracks — and adding a hand-written third copy for the wait would mean
 * three definitions that agree until they do not. That is precisely the
 * failure this fix is for: the wait was using Playwright's `:visible`,
 * which disagrees with these on opacity, clipping and filters.
 *
 * The same brace-matching `31-observer-visibility.spec.ts` uses to
 * extract them for its fixtures, for the same reason, and the CARD
 * copy (index 0) because that is the predicate the card scrape applies.
 */
const VISIBILITY_HELPER_SOURCES = (() => {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const block = (name) => {
    // `visible` is now a CONCISE arrow over the other three, so the
    // brace-matching below cannot find it by a `=> {` needle. Taken to
    // the end of its statement instead.
    if (name === 'visible') {
      const start = self.indexOf('const visible = (node) => shownBox(node) && paintsText(node);');
      if (start === -1) {
        throw new Error(
          'the visibility predicate `visible` could not be found in this file — ' +
            'the mount wait cannot use the same predicate as the scrape without it.',
        );
      }
      return self.slice(start, self.indexOf(';', start) + 1);
    }
    const needle = `const ${name} = (node) => {`;
    const start = self.indexOf(needle);
    if (start === -1) {
      throw new Error(
        `the visibility helper \`${name}\` could not be found in this file — ` +
          'the mount wait cannot use the same predicate as the scrape without it.',
      );
    }
    let depth = 0;
    let i = self.indexOf('{', start);
    for (; i < self.length; i += 1) {
      if (self[i] === '{') depth += 1;
      else if (self[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // The loop can also end by running out of file, and then `i` is
    // `self.length` and the slice is everything from the helper to EOF —
    // syntactically broken source that `new Function` rejects at the
    // first poll, inside a `catch` that reads the rejection as "the card
    // never mounted". Balance is therefore checked rather than assumed,
    // so an unparseable extraction fails HERE, by name, at import.
    if (depth !== 0) {
      throw new Error(
        `the visibility helper \`${name}\` could not be extracted from this file — ` +
          'its braces do not balance, so the mount wait has no predicate to run.',
      );
    }
    return self.slice(start, i + 2);
  };
  // ROUND 66 P2 — `shownBox` TOO, because `visible` now calls it.
  //
  // The split made `visible` a one-liner over the other two, so an
  // extraction that omitted `shownBox` would compile to a function
  // referencing an undefined name — and `new Function` throwing inside
  // the mount wait's `catch` is exactly the silent false-absence the
  // round-60 self-review added the balance check for. Ordered so each
  // name is defined before the one that uses it.
  return [block('notClipped'), block('paintsText'), block('shownBox'), block('visible')];
})();

/**
 * Returned when the DOM pass could not be RUN, as distinct from running
 * and finding no card (round 41 P2). A unique object so it can never be
 * confused with a value the page produced.
 */
const SCRAPE_FAILED = Symbol('forced-close scrape failed');

/**
 * The reading that establishes NOTHING — as distinct from one that
 * establishes an absence.
 *
 * `bodyPresent: undefined` is what the verdict reads as "nothing was
 * observed", and `mounted: true` keeps the absence rules from being
 * consulted at all, so a read that did not happen can never become a
 * missing-card FAIL. Extracted because three call sites were building
 * this same fourteen-field literal by hand and a field added to one of
 * them would silently not reach the others — the shape that has already
 * cost `visibleSubmits` twice on this PR.
 *
 * `overrides` is for the fields that genuinely differ: the accumulated
 * `seen*` / `*Peak` evidence at the mid-poll site, and `mounted: false`
 * for the attached-but-no-longer-visible case, which is a real
 * observation rather than a failed one.
 */
function nothingEstablished(overrides = {}) {
  return {
    mounted: true,
    attached: true,
    visibleCards: 0,
    text: null,
    bodyText: null,
    bodyPresent: undefined,
    bodyVisible: false,
    confirmText: null,
    confirmExpected: false,
    submitPresent: false,
    submitVisible: false,
    submitDisabled: true,
    visibleSubmits: 0,
    settled: false,
    ...overrides,
  };
}

async function readForcedCloseCard(page, timeoutMs = 30_000) {
  const cards = page.getByTestId('forced-close-card');
  // ROUND 3 P2 — VISIBLE, not merely ATTACHED.
  //
  // A CSS regression that leaves the card in the DOM under
  // `display: none` satisfies `attached`, and every text read still
  // succeeds against the DOM — so a ready, well-formed card would pass
  // while the lender sees neither the action nor its explanation, which
  // is the exact outcome the absence rule exists to catch. Playwright's
  // `visible` does not require the viewport, so an off-screen card is
  // still visible and nothing is weakened by asking for it.
  //
  // `attached` is still recorded, separately, so the failure can say
  // WHICH happened: a hidden card and an absent one are different
  // defects and a reader should not have to guess.
  // ROUND 23 P2 — WAIT FOR ANY VISIBLE MATCH, not for the first node.
  //
  // `.first()` waits on whichever element is first in the DOM. A hidden
  // forced-close node sitting before the real one therefore times the
  // wait out and produced `mounted: false, attached: true` — a reported
  // product failure while the lender is looking at a perfectly good
  // card. It also contradicted this file's own rule that a hidden
  // duplicate is not something the lender is being shown.
  //
  // Waiting on the locator's `visible` state without `.first()` is
  // satisfied by ANY match becoming visible, which is the question
  // actually being asked.
  // ROUND 51 P2 — ONE WAIT, ON THE QUESTION ACTUALLY BEING ASKED.
  //
  // Round 23 said "wait for ANY visible match, not for the first node"
  // and then implemented it as a SEQUENCE: the full 30 seconds on
  // `.first()`, and only once that timed out, five seconds on the
  // `:visible` locator. So the stated fix only began after half a minute
  // of watching the wrong element — and this page is live and mutable.
  // A visible card can state an amount it cannot know, or offer an
  // enabled action beside withheld copy, and then settle or disappear
  // inside that blind interval; none of its renders reach `seenTexts` or
  // `seenRenders`, and a lifecycle change then explains the whole visit
  // away as `inapplicable`.
  //
  // `[data-testid="forced-close-card"]:visible` is satisfied by ANY
  // match becoming visible, including the first one — so the two-stage
  // version had no case the single wait does not cover, and the fallback
  // was pure delay. Round 24's note survives because its lesson does:
  // `:visible` is the CSS pseudo-class Playwright supports; the earlier
  // `visible=true` was not a selector at all, the engine threw, `.catch`
  // swallowed it, and `mounted` stayed false while reading as if the fix
  // had worked.
  //
  // ROUND 60 P2 — AND THE WAIT ASKS THE DRIVE'S OWN QUESTION, not
  // Playwright's weaker one.
  //
  // `:visible` is a non-empty box plus a computed `visibility`. It does
  // not consider opacity, and since rounds 51 and 57 this drive also
  // rejects a clipped box and a filter-erased one. So a ghost card —
  // `opacity: 0`, or under `filter: opacity(0)` — attached before the
  // real card mounts satisfies `:visible`, the wait resolves
  // immediately, the in-page pass then finds nothing IT calls visible,
  // and the drive records an absence without ever waiting for the real
  // card that was going to appear well inside the timeout. On an
  // otherwise healthy loan that is a false missing-card FAIL.
  //
  // `31-observer-visibility.spec.ts` has asserted that these two
  // predicates disagree since round 33 — that disagreement is the whole
  // subject of one of its cases — and the mount gate was still using the
  // weaker one. Third time on this PR that Playwright's `:visible` and
  // this drive's `visible` have been mixed up (rounds 33 and 38 were the
  // others), and the first where the wait itself was the site.
  //
  // `waitForFunction` runs the SAME predicate the scrape uses, built
  // from the same helper sources, so there is one definition of visible
  // rather than two that agree until they do not.
  /** Set only when the wait failed for a reason that is not a timeout. */
  let mountFault = null;
  const mounted = await page
    .waitForFunction(
      // SPREAD, not a fixed arity. The first version of this destructured
      // exactly three names, so when round 66 split the predicate into
      // four the fourth was silently dropped and `return visible` threw
      // `ReferenceError` inside the wait's own catch — a false absence,
      // which is the precise failure the round-60 self-review added the
      // balance check to prevent, re-entered by the door it does not
      // cover. Joining whatever the array holds cannot go out of step
      // with it.
      (sources) => {
        const visible = new Function(`${sources.join('\n')}\nreturn visible;`)();
        return [...document.querySelectorAll('[data-testid="forced-close-card"]')].some(visible);
      },
      VISIBILITY_HELPER_SOURCES,
      { timeout: timeoutMs, polling: 250 },
    )
    .then(() => true)
    .catch((err) => {
      // SELF-REVIEW OF THE FIX ABOVE — a timeout and a failure to ASK
      // are not the same answer, and the previous line collapsed them.
      //
      // `waitForFunction` rejects for two unrelated reasons. A timeout
      // means the predicate ran, repeatedly, and kept saying no — that
      // is a real absence and `false` is the right answer. Anything else
      // means the question was never put: `new Function` rejecting a
      // malformed extraction, the execution context destroyed by a
      // navigation mid-poll, the page closing. Reading those as `false`
      // reports a card that was never looked for as a card that was not
      // there.
      //
      // That is round 41's defect exactly, and the comment warning about
      // it sits directly above this call — `.catch` swallowing an engine
      // throw and letting `mounted: false` stand for it. Round 60's fix
      // re-introduced it at the same site by giving the wait a new way
      // to throw, which is the shape this PR has now caught six times: a
      // fix leaving its own new state unhandled.
      if (err?.name !== 'TimeoutError') mountFault = err;
      return false;
    });
  // Nothing was established, so nothing is claimed. Reported as
  // INCOMPLETE through the same sentinel shape a failed scrape uses; the
  // cause is named separately so a reader need not guess which of the
  // two happened.
  if (mountFault) {
    return nothingEstablished({
      scrapeFailed: true,
      mountFault: String(mountFault?.message ?? mountFault),
    });
  }
  const attached = mounted ? true : (await cards.count()) > 0;
  // ROUND 19 P2 — HOW MANY CARDS, not just whether one is there.
  //
  // Every scrape and every click below is scoped to `.first()`, so a
  // second VISIBLE card was silently discarded — and the contracts this
  // drive asserts are about the whole surface, not about whichever
  // element happened to match first. A clean first card would let a
  // second one state an amount it cannot know, withhold its explanation,
  // or offer a control the first correctly withholds, while the run
  // still reported a pass.
  //
  // Counted VISIBLE rather than attached, for the same reason the wait
  // is: a duplicate hidden in the DOM is not something the lender is
  // being shown, and failing on it would be the false-positive
  // direction that gets checks switched off.
  //
  // ROUND 20 P2 — COUNTED IN EVERY SNAPSHOT, not once before the poll.
  //
  // The first version counted here and never again, while the readiness
  // loop below refreshed only the first card's contents. A duplicate
  // introduced by the SETTLED render — which is the render that matters,
  // since it is the one carrying ready copy and therefore the only one
  // that could state an amount — appeared after the only count was
  // taken. The count now comes from the same DOM pass as the text, so it
  // describes the render being judged rather than an earlier one.
  if (!mounted) {
    return {
      mounted: false,
      attached,
      visibleCards: 0,
      text: null,
      bodyText: null,
      bodyPresent: undefined,
      bodyVisible: false,
      confirmText: null,
      confirmExpected: false,
      submitPresent: false,
      submitVisible: false,
      submitDisabled: false,
      settled: false,
    };
  }
  // ROUND 1 P2 — ATTACHMENT IS NOT SETTLEMENT.
  //
  // The card mounts IMMEDIATELY in its `unknown` state and only later
  // renders ready/blocked copy, once its readiness RPCs answer. A
  // scrape taken on attachment therefore reads the transient text, and
  // an amount introduced into ready copy — the only copy that could
  // carry one — would never be scanned. Unlike the #1839 chooser this
  // card publishes no readiness attribute, so settlement is inferred
  // from the copy leaving the unresolved sentence.
  //
  // Inferring from prose is unsound as a general rule (this file says
  // so at length about the chooser), and it is used here only to RAISE
  // the bar: a card that never leaves `unknown` reports `settled:
  // false`, which the verdict turns into BLOCKED, not into a pass. So a
  // reworded sentence degrades to "we could not confirm it settled",
  // never to a false clean.
  //
  // ROUND 4/5 P2 — the BODY is captured with three states in mind: no
  // element (the heading-only shell, a defect), an element whose text
  // did not read (nothing observed), and an element read and blank (a
  // defect). Existence is not a successful read, and the two must not
  // collapse into one flag.
  //
  // ROUND 9 P2 — COPY AND CONTROL ARE READ IN ONE DOM EVALUATION.
  //
  // Two arms of the verdict now compare the rendered READINESS COPY
  // against the SUBMIT CONTROL — ready-without-action, and its inverse.
  // Reading them in separate round-trips lets a tip that changes
  // readiness mid-scrape pair copy from the old render with a control
  // from the new one, and that impossible pair produces a FALSE FAIL on
  // a page that was transitioning correctly. The two checks I added in
  // rounds 7 and 8 are precisely what made this matter.
  //
  // One `evaluate` takes the card text, the body text and the submit
  // control's presence and disabled state from a single synchronous
  // pass over the DOM, so they cannot disagree about which render they
  // came from.
  // PAGE-LEVEL, not element-level (round 20 P2). The subject is still
  // the first VISIBLE card, but the pass has to see all of them to count
  // them — and doing that in a second round-trip would reintroduce
  // exactly the split-render hazard round 9 closed, with the count
  // describing one render and the copy another.
  const readCard = () =>
    page
      .evaluate(() => {
        // ROUND 22 P2 — OPACITY IS NOT INHERITED, so asking the node
        // alone is not asking whether the lender can see it.
        //
        // An ancestor with `opacity: 0` makes everything under it
        // invisible while each descendant still computes `opacity: 1`
        // and keeps a non-zero rect — so a card, a body or a submit
        // control inside one read as visible. `display: none` and
        // `visibility: hidden` do not have this problem: the first
        // zeroes the rect and the second inherits.
        //
        // `checkVisibility` asks the browser the whole question, walking
        // the chain for exactly these properties. The manual walk is the
        // fallback for an engine without it, and it is a walk rather
        // than a single read for the reason above.
        // ROUND 28 P2 — A COLLAPSED CLIPPING ANCESTOR HIDES ITS
        // DESCENDANTS while each of them keeps its own layout box.
        //
        // `checkVisibility` answers about display, visibility, opacity
        // and content-visibility. It says nothing about OVERFLOW, so a
        // `height: 0; overflow: hidden` wrapper paints none of its
        // subtree while every element inside is laid out normally and
        // reports a full-size rect. Both halves of the test above
        // therefore pass for content clipped entirely out of view, and
        // `innerText` still yields all of its text.
        //
        // Only a COLLAPSED clipper counts, deliberately. Requiring an
        // element to lie inside every clipping ancestor's box would also
        // condemn content scrolled out of a scroll container, which the
        // lender can simply scroll back to — and a false FAIL is the
        // direction that gets a check switched off. A zero-area box on
        // something that clips is not scrolled-away content; it is
        // content that cannot be reached at all.
        //
        // Measured on the RECT rather than `clientHeight`, which is 0
        // for inline elements: `overflow` has no effect on a non-replaced
        // inline box, so keying on `clientHeight` would condemn anything
        // inside an ordinary `<span>`.
        const notClipped = (node) => {
          // ROUND 36 P2 — A CLIPPER DOES NOT HAVE TO BE EXACTLY ZERO to hide
          // everything inside it. `height: 0` was the only case rounds 28/29
          // rejected, so `height: 1px; overflow: hidden` walked straight
          // through: the ancestor is non-zero, every descendant keeps a
          // full-size rect and passes `checkVisibility`, and `innerText` yields
          // all of it — so the fee and loss rows of the receipt were recorded
          // as read while the lender could see a single pixel of them.
          //
          // A non-scrollable clipper now has to actually SHOW the element: at
          // least half of the element's extent must fall inside the clipper's
          // box on the clipped axis. Half rather than any overlap, because a
          // 1px clipper DOES overlap — that is exactly how it escaped — and
          // rather than full containment, which would condemn a row whose
          // descender is clipped by a pixel. Half a line is the point below
          // which a figure cannot be read at all.
          //
          // SCROLLABLE clippers stay exempt, which is rounds 28/29's deliberate
          // limit restated: content the lender can scroll to is reachable, and
          // condemning it is the false-FAIL direction that gets a check
          // switched off. `auto`/`scroll` WITH something to scroll is the test;
          // `hidden` and `clip` are not user-scrollable however much they hold.
          //
          // OUT-OF-FLOW ELEMENTS GET THE BENEFIT OF THE DOUBT, and only for the
          // intersection rule. Which clipper applies to an absolutely or fixed
          // positioned box is a containing-block question — a `position:
          // absolute` child of a `position: static` `overflow: hidden` ancestor
          // is NOT clipped by it — and answering it wrongly condemns content
          // the lender can see. The collapsed-clipper rule still applies to
          // them. Nothing on this card is out of flow; this is here so the
          // predicate stays honest if something ever is.
          const flow = getComputedStyle(node).position;
          const inFlow = flow === 'static' || flow === 'relative';
          // ROUND 65 P2 — WHICH ancestors clip an out-of-flow box, rather than
          // none of them.
          //
          // The exemption below was written to avoid a containing-block
          // question, and avoiding it cost the whole rule: `inFlow` is computed
          // once, so for any absolute or fixed node the walk skipped EVERY
          // ancestor intersection test. An absolutely positioned body, receipt
          // leaf or action inside a positioned `overflow: hidden` box — which IS
          // its containing block and definitively clips it — carried fully
          // clipped readiness copy or funds disclosures into a passing verdict.
          //
          // The question is answerable, and narrowly. An absolutely positioned
          // box is clipped by an `overflow` ancestor only from its CONTAINING
          // BLOCK upwards; ancestors between it and that block do not clip it.
          // So the walk skips until it reaches the containing block and applies
          // the rule from there — including to the containing block itself,
          // which clips its own padding box.
          //
          // Read from the properties that define it rather than guessed: for
          // `absolute`, the nearest ancestor that is positioned or that
          // establishes a containing block by `transform`, `filter`,
          // `perspective` or paint/layout `contain`; for `fixed`, only the
          // latter group, since a merely positioned ancestor does not capture a
          // fixed box. Anything this cannot decide leaves the ancestor skipped,
          // so the residual stays a missed defect rather than an invented one.
          const establishesCB = (cs) =>
            cs.transform !== 'none' ||
            cs.perspective !== 'none' ||
            cs.filter !== 'none' ||
            /\b(paint|layout|strict|content)\b/.test(cs.contain || '') ||
            /\btransform\b/.test(cs.willChange || '');
          let reachedCB = inFlow;
          const r = node.getBoundingClientRect();
          // TRUNCATED TEXT IS CONDEMNED, DELIBERATELY, and this note exists so
          // it is not "fixed" later as a false positive. `text-overflow:
          // ellipsis` with `white-space: nowrap` gives a line box wider than its
          // clipping box, so a heavily truncated line fails the ratio below.
          // That is the right answer HERE even though it would be wrong on a
          // chrome label: a fee value cut off mid-number, or an explanation cut
          // off mid-sentence, is exactly what this drive exists to catch, and a
          // reader seeing an ellipsis does not make the missing half readable.
          //
          // Checked rather than assumed — the only ellipsis rules in
          // `global.css` are `.connect-addr`/`.connect-label` and the two
          // `.select-menu-*` classes, which are the header wallet button and the
          // select menus. Nothing observed by this drive is truncated today.
          //
          // One Range per NODE, not per clipping ancestor: this predicate runs
          // for the card, the body, the control and every receipt leaf on every
          // poll tick, and rebuilding the range inside the walk was pure waste.
          const ownText = [...node.childNodes].some(
            (c) => c.nodeType === 3 && c.textContent.trim() !== '',
          );
          const boxes = (() => {
            if (!ownText) return [r];
            try {
              const range = document.createRange();
              range.selectNodeContents(node);
              const rects = [...range.getClientRects()].filter(
                (q) => q.width > 0 && q.height > 0,
              );
              // "No rects" must not read as "nothing is visible".
              return rects.length > 0 ? rects : [r];
            } catch {
              return [r];
            }
          })();
          // ROUND 44 P2 — STARTS AT THE NODE, not at its parent.
          //
          // A leaf that clips its OWN text was never examined: `height: 1px;
          // overflow: hidden` on the `dd` itself leaves a positive rect (so the
          // geometry test passes), `checkVisibility` positive, `paintsText`
          // satisfied — and the only box that would have caught it was the one
          // box this walk skipped. `innerText` then supplied the hidden
          // disclosure and the confirmation scan recorded it as read.
          //
          // Including the node costs nothing on a normal leaf: `overflow:
          // visible` skips the body of the loop, and a leaf sized to its own
          // content contains its own line boxes by definition.
          // ROUND 48 P2 — A CLIP PATH HIDES TEXT THAT EVERY OTHER TEST VOUCHES FOR.
          //
          // `clip-path: inset(50%)` — the modern visually-hidden idiom — leaves the
          // box laid out at full size, `checkVisibility` positive, the overflow walk
          // satisfied (there is no overflow) and `paintsText` satisfied (the colour
          // is opaque), while nothing is painted. `innerText` keeps yielding every
          // word, so the receipt's fee and loss rows could be recorded as read with
          // the lender seeing none of them. Same class as rounds 37, 43, 44 and 45:
          // a property that hides the CONTENT rather than the box.
          //
          // ONLY `inset()`, and only where the region is PROVABLY EMPTY. A circle,
          // an ellipse, a polygon, a `path()` or a `url()` reference can each be
          // empty too, and deciding that in general is a geometry problem this
          // predicate has no business attempting — getting it wrong condemns content
          // the lender can see, which is the error that gets a whole check switched
          // off. Anything it cannot read counts as painted, so the residual is a
          // missed defect and never an invented one.
          //
          // The legacy `clip: rect(...)` idiom needs nothing here: this codebase's
          // `.visually-hidden` pairs it with `width: 1px; height: 1px;
          // overflow: hidden`, which the half-extent rule below already rejects.
          const emptyClipRegion = (cs, box) => {
            const raw = (cs.clipPath || 'none').trim();
            const m = /^inset\(([^)]*)\)$/i.exec(raw);
            if (!m) return false;
            // `round <radii>` describes the corners, not the extent.
            const parts = m[1].split(/\s+round\s+/i)[0].trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0 || parts.length > 4) return false;
            const px = (t, extent) => {
              const v = String(t);
              if (v.endsWith('%')) {
                const n = Number(v.slice(0, -1));
                return Number.isFinite(n) ? (n / 100) * extent : null;
              }
              const n = Number(v.endsWith('px') ? v.slice(0, -2) : v);
              return Number.isFinite(n) ? n : null;
            };
            // CSS shorthand order, top/right/bottom/left with the usual fill-ins.
            const top = px(parts[0], box.height);
            const right = px(parts[1] ?? parts[0], box.width);
            const bottom = px(parts[2] ?? parts[0], box.height);
            const left = px(parts[3] ?? parts[1] ?? parts[0], box.width);
            if ([top, right, bottom, left].some((v) => v === null)) return false;
            // Judged only on an axis with extent to lose. A degenerate box is
            // someone else's finding, and calling it an empty clip would be
            // asserting something this has not established.
            return (
              (box.height > 0 && top + bottom >= box.height) ||
              (box.width > 0 && left + right >= box.width)
            );
          };
          for (let n = node; n; n = n.parentElement) {
            const cs = getComputedStyle(n);
            // An empty clip region on the node or on any ancestor hides
            // everything inside it, whatever the overflow rules say.
            //
            // The string test comes FIRST so the rect is not measured on
            // every ancestor of every node on every poll tick. `clip-path`
            // is `none` almost everywhere, and forcing a layout read to
            // discover that was a cost my own first version added silently.
            const clipPath = cs.clipPath;
            if (
              clipPath &&
              clipPath !== 'none' &&
              emptyClipRegion(cs, n.getBoundingClientRect())
            ) {
              return false;
            }
            const clipsY = cs.overflowY !== 'visible';
            const clipsX = cs.overflowX !== 'visible';
            if (!clipsY && !clipsX) continue;
            const box = n.getBoundingClientRect();
            if (clipsY && box.height === 0) return false;
            if (clipsX && box.width === 0) return false;
            // ROUND 45 P2 — the out-of-flow exemption is about ANCESTORS, never
            // about the node's own clipping box.
            //
            // I wrote it to avoid a containing-block question: whether a given
            // ancestor clips an absolutely positioned descendant depends on which
            // element is that descendant's containing block, and answering it
            // wrongly condemns content the lender can see. None of that
            // uncertainty applies to an element clipping ITS OWN text — every
            // element clips its own content, whatever its `position` is.
            //
            // Round 44 put `node` into this walk and this `continue` skipped it
            // right back out again for a positioned leaf, so `position: absolute;
            // height: 1px; overflow: hidden` still passed. The fix for the skipped
            // box, skipping the same box.
            // ROUND 65 P2 — skip only UP TO the containing block, then apply the
            // rule. `n !== node` keeps round 45's correction: an element always
            // clips its OWN text, whatever its `position`.
            if (!reachedCB && n !== node) {{
              if (flow === 'fixed' ? establishesCB(cs) : cs.position !== 'static' || establishesCB(cs)) {{
                reachedCB = true;
              }} else {{
                continue;
              }}
            }}
            const scrollsY =
              (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
              n.scrollHeight > n.clientHeight;
            const scrollsX =
              (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
              n.scrollWidth > n.clientWidth;
            // ROUND 43 P2 — PER LINE, not per element.
            //
            // The half-of-the-element rule reads a MULTI-LINE leaf as visible
            // whenever half of it survives — so a two-line value with its second
            // line entirely clipped passes at exactly 50%, `innerText` yields
            // both lines, and the run records a lender as having read a
            // disclosure whose second half is not on screen. On this surface the
            // clipped half is as likely as not to be the one carrying the
            // consequence.
            //
            // A Range over the node's own text yields one client rect per LINE
            // BOX, which is the unit a reader actually consumes. Every line must
            // clear the same half-visible bar the element used to clear as a
            // whole — so a descender trimmed by a pixel still passes (that line
            // is ~95% shown) while a line that is wholly outside does not.
            //
            // SCOPED TO NODES CARRYING THEIR OWN TEXT, and computed ONCE above
            // the ancestor walk rather than per ancestor.
            //
            // Both corrected after writing this. `selectNodeContents` on a
            // CONTAINER yields a rect per line of its whole subtree, so applying
            // the per-line rule to the card or the body would condemn the entire
            // surface whenever any single descendant line was mostly clipped —
            // and the resulting verdict says "card is in the DOM but not
            // visible", which is the wrong sentence about a card that is largely
            // on screen. The finding was about a multi-line `dt`/`dd`, and a
            // leaf's own text is exactly where "can this be read" is the
            // question being asked. Same scope `paintsText` uses, for the same
            // reason.
            //
            // Containers keep the element-rect rule they already had, and their
            // leaves are checked individually anyway — the receipt probe
            // requires every row AND both of its leaves to pass.
            for (const q of boxes) {
              if (clipsY && !scrollsY && q.height > 0) {
                const shown = Math.min(q.bottom, box.bottom) - Math.max(q.top, box.top);
                if (shown / q.height < 0.5) return false;
              }
              if (clipsX && !scrollsX && q.width > 0) {
                const shown = Math.min(q.right, box.right) - Math.max(q.left, box.left);
                if (shown / q.width < 0.5) return false;
              }
            }
          }
          return true;
        };
        const paintsText = (node) => {
          // ROUND 37 P2 — TEXT CAN BE HIDDEN BY ITS OWN COLOUR, and nothing else
          // in this predicate looks at colour. `color: transparent` leaves the
          // element laid out, `checkVisibility` positive, the rect non-zero and
          // the clipping walk satisfied, while `innerText` keeps yielding every
          // word — so the receipt's fee and loss values could be recorded as
          // read with nothing painted on screen. Same class as the opacity and
          // clipping holes before it: a property that hides the CONTENT rather
          // than the box.
          //
          // Only elements carrying their OWN text are judged. `color` inherits,
          // so testing a wrapper would condemn a whole card whose children set
          // their own colour — a false FAIL, on the very element the run exists
          // to vouch for. The leaves are where this matters anyway: the
          // receipt's `dt`/`dd` are exactly the nodes whose values get blanked.
          //
          // `-webkit-text-fill-color` is read first because it OVERRIDES `color`
          // for painting wherever it is set, which is how this is usually done
          // in a real stylesheet.
          //
          // Alpha ZERO only, never a contrast judgement. Deciding text is too
          // faint against its background needs the background, the stacking and
          // whatever image sits behind it, and getting that wrong condemns
          // legible copy — the direction this file keeps saying gets a check
          // switched off.
          const own = [...node.childNodes].some(
            (c) => c.nodeType === 3 && c.textContent.trim() !== '',
          );
          if (!own) return true;
          const cs = getComputedStyle(node);
          // ROUND 82 P2 — ASKED OF THE GLYPHS, not of the element's box.
          //
          // Round 81 closed `position: absolute; left: -9999px` with a
          // document-origin test on the element RECT, and the self-review
          // after it found `text-indent: -9999px` walking straight through:
          // the indent moves the LINE and leaves the box exactly where it
          // was, so every box-shaped test — geometry, clipping, the origin
          // test — says yes while the text sits far outside. That was
          // patched with a heuristic (a negative indent at least as wide as
          // the element), and the heuristic was wrong in BOTH directions:
          // too narrow for a short label in a wide container, too broad for
          // wrapped text whose later lines stay on screen, which the patch
          // recorded as a stated limit rather than fixing.
          //
          // The text nodes' own `Range` rectangles are where the glyphs
          // actually are, and `notClipped` has been reading them for its
          // clipping ratio since round 44. Asking the document-origin
          // question of THOSE answers `text-indent`, a negative
          // `margin-left` on an inline run, and anything else that parks
          // the line without moving the box — one rule where the previous
          // two rounds each added an arm per trick.
          //
          // ANY reachable rectangle counts as painted, so wrapped text
          // whose first line is indented out keeps the lines the lender can
          // still read. Text this cannot measure — no rects, or a `Range`
          // that throws — counts as painted too. Both are the direction
          // this file takes everywhere: the residual is a missed defect,
          // never an invented one.
          //
          // STATED LIMIT, and it is the price of that choice: the verdict
          // is per ELEMENT, not per line, so the words on an indented-out
          // FIRST line are still collected when a later line of the same
          // run is readable. Slicing a text node by line rectangle would
          // close it and would also start discarding copy on any line this
          // drive mismeasures, which is the false-FAIL direction. The
          // single-line label is what the pattern is actually used for and
          // is fully covered.
          //
          // OWN TEXT NODES ONLY, matching what the rest of this predicate
          // judges: `selectNodeContents(node)` would pull in a descendant's
          // glyphs and let a visible child vouch for an indented-out
          // parent.
          //
          // THIS ADDS NO NEW SCROLL EXPOSURE, which is why no scroll
          // exemption sits beside it: scrolling moves the box and its
          // glyphs together, and both drive call sites (`visible` and
          // `visibleTextOf`) run `shownBox` first, so a box carried before
          // the origin is condemned there first. What reaches here is text
          // that left its own box behind.
          //
          // That is NOT the same as saying a scrolled ancestor cannot
          // produce a false condemnation, and the stronger sentence stood
          // here until it was measured. It can: a row inside an INNER
          // scroll container near the top of the document, scrolled above
          // that container's own slit, has a negative rect while
          // `window.scrollY` is 0, so the document-origin test condemns
          // content the lender can scroll back to. Measured in a browser
          // rather than argued — `shownBox` returns false for it, and has
          // since round 81 added the box test; the glyph rule inherits the
          // question rather than introducing it. Nothing this drive reads
          // is inside such a container today (the page itself scrolls,
          // which `window.scrollY` accounts for), so it is a latent gap in
          // both copies rather than a live one, tracked separately instead
          // of being patched mid-review.
          const glyphs = [];
          for (const c of node.childNodes) {
            if (c.nodeType !== 3 || c.textContent.trim() === '') continue;
            try {
              const range = document.createRange();
              range.selectNodeContents(c);
              for (const q of range.getClientRects()) {
                if (q.width > 0 && q.height > 0) glyphs.push(q);
              }
            } catch {
              // Unmeasurable: leaves `glyphs` short, which reads as painted.
            }
          }
          if (
            glyphs.length > 0 &&
            glyphs.every(
              (q) => q.right + window.scrollX <= 0 || q.bottom + window.scrollY <= 0,
            )
          ) {
            return false;
          }
          const fill = cs.webkitTextFillColor || cs.color || '';
          // ROUND 38 P2 — EVERY COMPUTED COLOUR FORM, not just `rgb()`/`rgba()`.
          //
          // Chromium PRESERVES the functional notation for the modern colour
          // syntaxes, so `color(display-p3 0 0 0 / 0)` and `oklab(0 0 0 / 0)`
          // never matched the old `rgba?` probe — and the no-match branch
          // returns "painted", which fails OPEN on the one check that exists
          // to catch invisible funds copy. All six receipt leaves could pass
          // while `innerText` supplied their values.
          //
          // Parsed by SHAPE rather than by enumerating colour functions:
          // every CSS colour syntax carrying alpha spells it either after a
          // `/` (the modern forms, and space-separated `rgb()`) or as a fourth
          // comma-separated component (legacy `rgba()` / `hsla()`). Reading
          // the shape means a colour function added to CSS later needs no
          // change here — the enumeration mistake this file has now made
          // twice, with the transport allowlist and the currency signs.
          //
          // ANYTHING UNPARSEABLE COUNTS AS PAINTED. A form this cannot read
          // must not be condemned: a false FAIL on legible copy is the error
          // that gets the whole check switched off, so the residual is a
          // missed defect and never an invented one.
          const alphaOf = (value) => {
            const v = String(value).trim();
            if (v === 'transparent') return 0;
            const fn = /^[a-zA-Z-]+\(([^]*)\)$/.exec(v);
            if (!fn) return 1;
            const body = fn[1];
            const cut = body.lastIndexOf('/');
            let raw = null;
            if (cut >= 0) {
              raw = body.slice(cut + 1);
            } else {
              const parts = body.split(',');
              if (parts.length === 4) raw = parts[3];
            }
            if (raw === null) return 1;
            const t = raw.trim();
            const n = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
            return Number.isFinite(n) ? n : 1;
          };
          // ROUND 75 P2 — A ZERO-ALPHA FILL IS NOT THE ONLY WAY GLYPHS GET
          // PAINTED.
          //
          // `color: transparent` with a `text-shadow` is a real technique, and
          // the glyphs are plainly on screen: the shadow draws them.
          // Condemning that text erased the body, a receipt value or a control
          // label and accused a surface the lender can read — the false-FAIL
          // direction this helper already argues for two paragraphs up, where
          // an unparseable colour is deliberately counted as painted. The same
          // goes for a paint-order stroke, which outlines glyphs a transparent
          // fill would otherwise hide.
          //
          // DECLINED rather than adjudicated: no attempt is made to decide
          // whether the shadow is itself visible, offset clear of the glyphs,
          // or the colour of the background. Each of those is the contrast
          // judgement this file has already refused to make, and getting it
          // wrong puts the accusation back. The residual is a missed defect,
          // never an invented one.
          if (alphaOf(fill) !== 0) return true;
          const shadow = String(cs.textShadow ?? 'none').trim();
          if (shadow !== '' && shadow !== 'none') return true;
          const strokeWidth = String(cs.webkitTextStrokeWidth ?? '0px').trim();
          const strokeColor = String(cs.webkitTextStrokeColor ?? 'transparent').trim();
          if (parseFloat(strokeWidth) > 0 && alphaOf(strokeColor) !== 0) return true;
          return false;
        };
        const shownBox = (node) => {
          if (node === null) return false;
          // ROUND 23 P2 — SUPPLEMENTS the geometry test, never replaces
          // it. `checkVisibility` answers about display, visibility,
          // opacity and content-visibility; it does not establish that
          // the element occupies space, so `transform: scale(0)` or a
          // collapsed box still reads as visible through it alone.
          if (typeof node.checkVisibility === 'function') {
            if (
              !node.checkVisibility({
                opacityProperty: true,
                visibilityProperty: true,
                contentVisibilityAuto: true,
              })
            ) {
              return false;
            }
            // ROUND 29 P2 — AND THE CLIPPING TEST, on THIS path too.
            //
            // Round 28 added `notClipped` to the fallback's return and
            // not to this one, so on every engine that HAS
            // `checkVisibility` — which is to say the browser this drive
            // actually runs — the clipping fix did nothing at all for
            // the card, the body and the submit control. The receipt
            // helper was rewritten wholesale and did get it, which is
            // why the live run looked like it confirmed the change: the
            // canary I checked exercised the copy that worked.
            //
            // ROUND 51 P2 — AND THE SAME SPLIT BIT AGAIN, so the branch
            // no longer RETURNS. Round 29 fixed the symptom by copying
            // `notClipped` into this arm and left the shape that caused
            // it: an early return here meant everything below — the
            // ancestor walk included — ran only on an engine without
            // `checkVisibility`, which is to say never.
            //
            // That was free while the walk only tested `opacity`, since
            // `checkVisibility({opacityProperty: true})` already covers
            // it, and that is precisely why nobody noticed. It stops
            // being free the moment the walk carries something
            // `checkVisibility` does not know about — `filter` is that
            // thing, and the fix for it would have landed in dead code
            // in one of the two copies.
            //
            // Restructured to match the twin rather than patched inside
            // the branch, so the copies converge instead of diverging
            // further (#2102).
          } else {
            const cs = getComputedStyle(node);
            if (
              cs.display === 'none' ||
              cs.visibility === 'hidden' ||
              cs.visibility === 'collapse'
            ) {
              return false;
            }
          }
          // ROUND 51 P2 — A FILTER ERASES CONTENT THE SAME WAY OPACITY DOES,
          // and nothing above looks at it.
          //
          // `filter: opacity(0)` leaves the geometry, the computed `opacity`,
          // the text colour and `checkVisibility` all untouched while Chromium
          // paints nothing — so the explanation, or a fee and loss row, could be
          // vouched for from `innerText` with none of it on screen. Same class
          // as rounds 37, 43, 44, 45 and 48: a property that hides the CONTENT
          // rather than the box.
          //
          // Checked on the same ANCESTOR WALK as `opacity`, because a filter
          // applies to the element and everything inside it exactly as opacity
          // does — one walk, one rule, rather than a second traversal to drift.
          //
          // ONLY a zero `opacity()` component, and only where it is stated as a
          // number. `brightness(0)` paints black rather than nothing, a `url()`
          // reference is an arbitrary SVG filter, and deciding in general what a
          // filter chain renders is not something this predicate can do — so
          // anything else counts as painted. The residual is a missed defect,
          // never an invented one.
          const filterErases = (cs) => {
            const f = cs.filter;
            if (!f || f === 'none') return false;
            for (const m of String(f).matchAll(/opacity\(([^)]*)\)/gi)) {
              const t = m[1].trim();
              const v = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
              if (Number.isFinite(v) && v === 0) return true;
            }
            return false;
          };
          for (let n = node; n; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (Number(cs.opacity) === 0) return false;
            if (filterErases(cs)) return false;
          }
          // ROUND 81 P2 — AND TEXT PARKED OUTSIDE THE DOCUMENT IS NOT
          // PAINTED EITHER.
          //
          // `position: absolute; left: -9999px` is the older screen-reader
          // pattern, and it defeats every test above it: `checkVisibility`
          // is true, the rect has real width and height, opacity is 1 and
          // nothing clips it. So an off-screen readiness sentence or a fee
          // value could substantiate a card showing a sighted lender
          // nothing but filler — the exact substitution the painted-text
          // rule exists to stop, arriving by geometry instead of colour.
          //
          // BELOW THE FOLD IS NOT THIS. Content the lender can scroll to is
          // painted and must stay admitted, so the test is in DOCUMENT
          // coordinates and asks whether the box lies wholly before the
          // document's origin — left of it or above it — which no amount of
          // scrolling can reach. A box at y=4000 has positive document
          // coordinates and is unaffected.
          //
          // Deliberately narrow. Anything further — a box parked far to the
          // RIGHT, inside a horizontally scrollable ancestor, or an RTL
          // document's mirrored origin — is a reachability question this
          // cannot answer from one rect, and guessing would condemn copy
          // the lender can read. The residual is a missed defect, which is
          // the direction this file takes every time.
          const r = node.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          const docRight = r.right + window.scrollX;
          const docBottom = r.bottom + window.scrollY;
          if (docRight <= 0 || docBottom <= 0) return false;
          return notClipped(node);
        };
        // ROUND 66 P2 — TWO QUESTIONS, SEPARATED. `shownBox` above answers
        // whether the BOX is on screen: display, visibility, opacity, an
        // erasing filter, geometry and clipping, each of which hides
        // everything inside it. `paintsText` answers whether an element's
        // OWN text is painted, which affects only that element's own text
        // nodes — `color` inherits, and a descendant may repaint itself.
        //
        // `visible` is unchanged: it is both, and every existing caller
        // asking "can the lender read THIS element" still gets the same
        // answer. The split exists so `visibleTextOf` can stop discarding a
        // painted descendant because its container's own text is not.
        const visible = (node) => shownBox(node) && paintsText(node);
        const all = [...document.querySelectorAll('[data-testid="forced-close-card"]')];
        const shown = all.filter(visible);
        if (all.length === 0) return null;
        // ROUND 21 P2 — NO VISIBLE CARD IS AN ANSWER, not a reason to
        // read a hidden one.
        //
        // The fallback to the first ATTACHED card meant that a card
        // hidden during the readiness poll was still scraped, while
        // `mounted` stayed true from the earlier wait — so a settled,
        // well-formed, entirely invisible card reported a pass. The
        // lender sees no surface at all in that state, which is the
        // exact regression the absence rule exists to catch, arriving
        // through the one path that had a fallback in it.
        if (shown.length === 0) return { hiddenNow: true };
        const el = shown[0];
        const body = el.querySelector('[data-testid="forced-close-body"]');
        // ROUND 61 P2 — THE BODY'S TEXT, not the wrapper's presence.
        //
        // `visible(body)` alone cannot answer "can the lender read the
        // explanation", and `paintsText` says why in its own comment:
        // only elements carrying their OWN text are judged, because
        // `color` inherits and condemning a wrapper whose children set
        // their own colour would be a false FAIL. So a body that wraps
        // its sentence in a child — ordinary markup — is EXEMPT from the
        // colour test, the opacity/filter walk only climbs to ancestors,
        // and `notClipped` looks at the body and above. Erase the CHILD
        // and every one of them still passes, while `innerText` keeps
        // yielding the sentence: the heading-only surface round 21 added
        // `bodyVisible` to catch, reached one level down.
        //
        // ROUND 62 P2 — AND THE RECOGNISED SENTENCE ITSELF, not merely
        // some painted text somewhere in the body.
        //
        // Round 61 answered this with "at least one visible text leaf",
        // and stated its own residual: a body with two text leaves where
        // only one is erased still passed. That residual is the whole
        // defect, because the leaf the verdict MATCHES is the one that
        // governs the action — an erased explanation beside a visible
        // secondary note satisfied `some` while the lender read nothing
        // that justified the button.
        //
        // Binding the check to the recognised copy is strictly better
        // than both of round 61's candidates. `every` would have failed a
        // card for carrying a screen-reader-only span, which is correct,
        // accessible markup clipped by design — the false-FAIL direction.
        // `some` accepted an unrelated leaf. Reporting the VISIBLE TEXT
        // and recognising state from that is neither: an sr-only span
        // simply is not in the string, and an erased sentence is not in
        // it either.
        //
        // Collected by walking TEXT NODES and keeping those whose element
        // chain is visible, rather than by collecting "leaf elements": a
        // parent with its own text beside a child with more would be
        // counted twice by the latter, and the text is what the verdict
        // needs anyway.
        //
        // Joined with NOTHING and then whitespace-collapsed. A space
        // between every text node would split `<b>Loan</b>s` into
        // "Loan s", and this string is compared against shipped copy with
        // `includes`.
        //
        // Elements whose text is NEVER PAINTED (`script`, `style`,
        // `template`, `title`, `noscript`) are skipped, so this agrees
        // with the `innerText` that `bodyText` reports. Defence in depth
        // rather than a live defect — a body holding only a `<style>` has
        // no height and `visible` already rejects it on geometry, which
        // the fixture asserts.
        //
        // NAMED, so the fixture suite can extract and exercise it the way
        // it does `rowShown` — the rule is the thing under test and a copy
        // of it written into the test would prove nothing.
        const visibleTextOf = (root) => {
          if (root === null) return '';
          // THE ROOT'S OWN VISIBILITY FIRST — see the twin in the receipt
          // pass. The walk only judges elements it DESCENDS INTO, so a
          // text node directly under a hidden root would be collected as
          // painted. The two copies are asserted identical by
          // `31-observer-visibility.spec.ts`.
          if (!shownBox(root)) return '';
          const unpainted = /^(script|style|template|title|noscript)$/i;
          const parts = [];
          // ROUND 66 P2 — AN ELEMENT'S OWN TEXT AND ITS SUBTREE ARE JUDGED
          // SEPARATELY.
          //
          // `paintsText` gates only the element's OWN text nodes, because
          // `color` inherits and a descendant may repaint itself. Descent
          // is gated on `shownBox` alone: a container whose own text is
          // transparent still SHOWS a child that sets its own colour, and
          // gating descent on the full `visible` discarded that child — a
          // product FAIL on a card whose explanation is painted, which is
          // the direction this file refuses everywhere else.
          // ROUND 74 P2 — RENDERED LINE BOUNDARIES SURVIVE THE WALK.
          //
          // `innerText` inserts a newline between rendered blocks, and round 24
          // made that newline a CLAUSE BOUNDARY: `Wait 3 days` above `USDC is
          // returned later` is two rows, so the ticker is not near the duration.
          // Round 66 moved the scans onto this painted walk and joined every
          // text node with nothing, which silently deleted that boundary — so
          // correct copy on two lines read as one clause and the amount scanner
          // emitted an observed funds FAIL on an allowed grace duration. A false
          // FAIL on funds copy, introduced by the fix that made the reading
          // honest.
          //
          // A newline is emitted around a child that BREAKS THE LINE and never
          // around an inline one, which is what keeps round 66's other rule
          // intact: `<b>Loan</b>s` must not become `Loan s`. `inline-block` and
          // `contents` do not break, matching what `innerText` does; `<br>` does,
          // unless it is display:none.
          // ROUND 79 P2 — GEOMETRY DECIDES, not the child's `display` alone.
          //
          // A flex or grid ITEM is blockified, so `display` reads `block`
          // while the items sit side by side on one rendered row. Breaking
          // on that inserted a newline between, say, `Loan 100` and
          // `USDC principal` — and `monetaryAmountsIn` reads a newline as a
          // CLAUSE BOUNDARY, so the ticker stopped cancelling the identifier
          // exemption and a visible unsubstantiated amount got a clean
          // verdict. A false PASS on funds copy, from the fix that stopped a
          // false FAIL on it one round earlier.
          //
          // Rects answer the question the rule is actually asking — did the
          // lender see these on the same line? Two boxes whose vertical
          // ranges OVERLAP are on one line whatever their display says, and
          // a box below the previous one starts a new line whatever the
          // parent's formatting context is. That also covers a column flex,
          // a wrapped row and a multi-row grid, which a parent-display test
          // would each get wrong.
          //
          // `display` is still consulted FIRST, as the cheap negative: an
          // inline element never breaks, which is what keeps a bolded word
          // from becoming two. Zero-area boxes fall back to the display
          // rule, since a rect of nothing cannot place anything.
          const breaksLine = (el, prev) => {
            const d = getComputedStyle(el).display;
            if (d === 'contents' || d.startsWith('inline') || d.startsWith('ruby')) return false;
            if (!prev) return true;
            const a = el.getBoundingClientRect();
            const b = prev.getBoundingClientRect();
            if (a.height === 0 || b.height === 0) return true;
            return !(a.top < b.bottom && b.top < a.bottom);
          };
          // `prevBox` is the last element that actually laid a box down, so
          // adjacency is judged against what was rendered before this
          // child rather than against its parent.
          let prevBox = null;
          const walk = (node) => {
            const ownPainted = paintsText(node);
            for (const child of node.childNodes) {
              if (child.nodeType === 3) {
                // ROUND 79 P2 — SOURCE WHITESPACE IS NOT A RENDERED BREAK.
                //
                // A text node between two elements carries the markup's own
                // indentation, newlines included, and the normalisation
                // below deliberately preserves newlines — so the way the
                // HTML happened to be formatted leaked in as a clause
                // boundary. Collapsed here instead: a break comes from
                // layout, which is `breaksLine` and `<br>`, and never from
                // how the source was typed.
                if (ownPainted) parts.push(child.textContent.replace(/\s+/g, ' '));
              } else if (child.nodeType === 1) {
                if (unpainted.test(child.tagName)) continue;
                if (child.tagName === 'BR') {
                  if (getComputedStyle(child).display !== 'none') parts.push('\n');
                  continue;
                }
                if (!shownBox(child)) continue;
                const boundary = breaksLine(child, prevBox);
                if (boundary) parts.push('\n');
                prevBox = child;
                walk(child);
              }
            }
          };
          walk(root);
          // Horizontal whitespace collapses; the deliberate breaks do not.
          return parts
            .join('')
            .replace(/[^\S\n]+/g, ' ')
            .replace(/[^\S\n]*\n[\s]*/g, '\n')
            .trim();
        };
        const bodyVisibleText = visibleTextOf(body);
        // ROUND 26 P2 — EVERY SUBMIT CONTROL, not whichever is first.
        //
        // `querySelector` described control number one and nothing else.
        // A render that leaves two in one card — the same duplication
        // round 19 caught at CARD level, one level down — could put a
        // DISABLED control first and an ENABLED, clickable one after it:
        // the drive records "no action offered", classifies withheld
        // copy as correctly withheld, skips the confirmation entirely,
        // and passes a card that is inviting the lender to pay gas for a
        // transaction the protocol will refuse.
        //
        // Actionability is therefore derived from the VISIBLE controls
        // as a set: offered if any visible one is enabled, since that is
        // the one the lender can actually press. The count travels with
        // it so the verdict can report the duplication itself — a second
        // control is a finding, not a detail to resolve silently.
        const submits = [...el.querySelectorAll('[data-testid="forced-close-submit"]')];
        const shownSubmits = submits.filter(visible);
        // ROUND 18 P2 — VISIBILITY OF THE CONTROL, in the same pass.
        //
        // `disabled === false` on an element that exists says an action
        // is OFFERED, and a CSS regression that hides an enabled button
        // makes that false in both directions: on withheld copy it
        // manufactures a FAIL claiming the lender was offered a
        // fee-paying transaction, and on ready copy it lets the poll
        // settle on an action nobody can click, reported later as a
        // merely incomplete confirmation rather than as the missing
        // usable action it is.
        //
        // Same defect as round 3's on the card itself, one level down —
        // there `attached` was mistaken for `visible`, here existence
        // for actionability. Captured in this evaluate rather than by a
        // second round-trip so it cannot describe a different render
        // from the copy it is judged against (round 9 P2).
        //
        // Rect AND computed style: `offsetParent` is null for a
        // `position: fixed` element, which is visible. The same helper
        // decides which cards count as shown, above.
        return {
          visibleCards: shown.length,
          // ROUND 33 P2 — WHICH card this snapshot describes, so the
          // interaction can address the same one. See the note on
          // `card` below for why a `:visible` locator is not the same
          // element as `shown[0]`.
          chosenIndex: all.indexOf(el),
          text: el.innerText,
          bodyPresent: body !== null,
          // ROUND 21 P2 — the BODY's own visibility, separately. A CSS
          // regression that hides only the explanation leaves the
          // element present and `innerText` can still yield its DOM
          // text, so the verdict took a heading-only surface for an
          // explained one. Presence, text and visibility are three
          // different facts about the body and the verdict needs all
          // three.
          //
          // ROUNDS 61 + 62 P2 — and its PAINTED TEXT, see `visibleTextOf`.
          //
          // The `innerText`-non-empty guard is what keeps an EMPTY body
          // out of this arm: it has no text either way, and the verdict
          // has its own, more accurate arm for a body that rendered
          // nothing. Reporting it as invisible would name the wrong
          // defect. (It is already rejected on geometry today — a
          // zero-height box — so this is defence in depth, and the
          // fixture says which of the two is doing the work.)
          bodyVisible:
            shownBox(body) &&
            ((body?.innerText ?? '').trim() === '' || bodyVisibleText !== ''),
          // The text the lender can actually READ, which is what the
          // verdict recognises the card's state from. `bodyText` stays
          // the raw `innerText` beside it: the two differing IS the
          // finding, and collapsing them would hide it.
          bodyVisibleText,
          // The same for the WHOLE card, because state is also
          // recognised from the card's text where the body is absent or
          // says nothing — `saysCheckRunning` reads it. Leaving that one
          // site on raw `innerText` would have closed one instance of
          // this defect and left its sibling open, which is the shape
          // this PR has now been caught by eight times.
          visibleText: visibleTextOf(el),
          bodyText: body === null ? null : body.innerText,
          submitPresent: submits.length > 0,
          submitVisible: shownSubmits.length > 0,
          // Disabled only when EVERY visible control is — one enabled
          // control among several is an offered action, however many
          // disabled ones sit beside it. With none visible the old
          // meaning is kept: nothing pressable, so nothing offered.
          submitDisabled:
            shownSubmits.length > 0
              ? shownSubmits.every((b) => b.disabled === true)
              : true,
          visibleSubmits: shownSubmits.length,
          // ROUND 54 P2 — AND WHETHER THE LENDER CAN READ IT.
          //
          // Present, visible and enabled made `confirmExpected` true, so
          // a blank outer submit — or one whose label is painted in
          // nothing — was clicked by its test id, opened a healthy
          // confirmation, and passed. The confirmation's OWN action has
          // carried `labelled` since round 45 and `labelPainted` since
          // round 46; the control that opens it, which is the first
          // thing the lender sees, had neither.
          //
          // Judged over the VISIBLE set, matching every other submit
          // fact here: a hidden control is not something the lender is
          // being shown, and `some` rather than `every` because one
          // readable control among several is a readable offer.
          //
          // `labelPainted` reuses the button-label rule from the
          // confirmation: `visible` on the leaves that carry their own
          // text, `some` rather than `every`, so a visually-hidden long
          // form beside a short visible one stays correct.
          submitLabelled: shownSubmits.some((b) => (b.innerText ?? '').trim() !== ''),
          submitLabelPainted: shownSubmits.some((b) => {
            const leaves = [b, ...b.querySelectorAll('*')].filter((n) =>
              [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim() !== ''),
            );
            return leaves.length === 0 || leaves.some((n) => visible(n));
          }),
          // ROUND 38 P2 — WHICH control the snapshot judged, so the
          // CLICK addresses it. Round 33 fixed this for the card and
          // left the control on `:visible`, one level down: Playwright's
          // `:visible` ignores opacity while this pass rejects it, so an
          // opacity-zero DISABLED submit ahead of a real enabled one is
          // excluded here and selected there. The snapshot then records
          // one usable action, the click lands on the transparent
          // control and times out, `confirmText` stays null, and a
          // healthy card is reported incomplete — the exact shape round
          // 33 fixed, in the sibling it did not touch.
          //
          // Indexed within THIS card's submit list, which is what the
          // interaction locator is scoped to.
          chosenSubmitIndex: shownSubmits.length > 0 ? submits.indexOf(shownSubmits[0]) : -1,
        };
      })
      // ROUND 41 P2 — AN EVALUATOR THAT THREW IS NOT A CARD THAT IS GONE.
      //
      // This returned the SAME `null` the DOM pass returns when it finds
      // no card, so a helper throwing, a destroyed execution context, or
      // any browser-side failure was recorded as a vanished card. From
      // there it either accuses an eligible product of omitting the
      // surface, or — with an accepted sale on the pinned snapshot —
      // reports `inapplicable`. Both describe the page; neither is true.
      // Nothing was observed at all.
      //
      // The two are distinguished by a SENTINEL rather than by a second
      // `null`, so the caller has to handle it: `null` keeps its single
      // meaning — the callback ran and found nothing — and `scrapeFailed`
      // means the callback did not run to completion.
      .catch(() => SCRAPE_FAILED);

  let snap = await readCard();
  // The scrape itself failed. Reported as INCOMPLETE, never as a product
  // finding: `bodyPresent: undefined` is what the verdict reads as
  // "nothing was established", and `mounted` stays true so the absence
  // rules — which would otherwise turn this into a missing-card FAIL —
  // are not consulted at all.
  if (snap === SCRAPE_FAILED) {
    return nothingEstablished({ scrapeFailed: true });
  }
  // A card that is attached but no longer VISIBLE is reported the way an
  // invisible-but-attached card is at the top of this function: not a
  // pass, and named as what it is (round 21 P2).
  if (snap?.hiddenNow) {
    return nothingEstablished({ mounted: false });
  }
  // The evaluate is atomic, so a null means the card went between the
  // visibility wait and this pass — round 7's vanished case, detected by
  // the capture itself.
  //
  // ROUND 33 P2 — A VANISHED CARD IS UNMOUNTED AND UNATTACHED, and
  // saying otherwise sent an ordinary lifecycle race out as a product
  // accusation. This record claimed `mounted: true, attached: true` for a
  // pass in which `querySelectorAll` found NOTHING, so `forcedCloseVerdict`
  // took the mounted branch, hit `text: null`, and returned
  // blocked/incomplete before ever consulting eligibility — a run exiting
  // 2 because a loan went terminal, a token transferred, or a sale was
  // accepted while the drive was looking. All three of those are states
  // the eligibility reconciliation exists to classify, and it was never
  // reached; `observeForcedClose` only confirms at a later head when
  // `!card.mounted`, so this flag was also what suppressed the confirming
  // re-read itself.
  //
  // `attached` matters as much as `mounted` here and is the reason this
  // is two changes rather than one: with `mounted: false` alone, section
  // 3 reads `attached: true` and FAILS with "card is in the DOM but not
  // visible" — a confidently wrong sentence about a card that is not in
  // the DOM at all. The hidden-card case keeps `attached: true` because
  // there the nodes really are present; this one does not.
  //
  // What is NOT weakened: an absence on a still-eligible position still
  // FAILS at section 3, and still only after the later-block confirmation
  // this unlocks. The vanish is explained or it is a finding.
  if (snap === null) {
    return {
      mounted: false,
      attached: false,
      visibleCards: 0,
      bodyVisible: false,
      text: null,
      bodyText: null,
      bodyPresent: undefined,
      confirmText: null,
      confirmExpected: false,
      submitPresent: false,
      submitVisible: false,
      submitDisabled: true,
      visibleSubmits: 0,
      settled: false,
    };
  }

  // ROUND 10 P2 — THE POLL RE-READS EVERYTHING, AND A READY-BUT-DISABLED
  // RENDER IS NOT YET AN ANSWER.
  //
  // Two corrections to round 9's loop, which re-read only the text and
  // the control:
  //
  //   (a) `bodyPresent`/`bodyText` stayed from the UNRESOLVED render, so
  //       a regression that blanks the explanatory body only in a
  //       ready/blocked state passed — the heading kept the card text
  //       non-empty and the stale body looked fine. Every poll now
  //       re-snapshots the whole card, and the values returned come from
  //       the render that established settlement.
  //
  //   (b) `ready` in `useDiamondWrite` is `onSupportedChain &&
  //       Boolean(walletClient)`, and wagmi's `useWalletClient()`
  //       resolves ASYNCHRONOUSLY. So a card can legitimately render
  //       ready copy for a moment while its button is still disabled,
  //       waiting on the wallet client. Ending the poll on the copy
  //       alone captured that intermediate pair and handed it to the
  //       round-7 ready-without-action arm, which exits 1 — a false
  //       product accusation from a page that was about to be correct.
  //
  // So the wait ends when the card is settled AND not in that transient
  // pair. The FAIL now requires the combination to PERSIST to the
  // deadline rather than to have existed for an instant, which is the
  // same standard the rest of this drive applies: a defect is something
  // that stayed true while being looked at.
  const readyPending = (v) =>
    (v.submitDisabled || v.submitVisible === false) &&
    FORCED_CLOSE_COPY.readyCopy.some((sentence) => (v.text ?? '').includes(sentence));

  // ROUND 68 P2 — SETTLEMENT IS DECIDED ON THE PAINTED TEXT.
  //
  // A card that visibly paints legitimate ready or blocked copy while
  // retaining the `unknown` sentence in a transparent, clipped or
  // filter-erased descendant kept this poll unsettled to the deadline —
  // and the verdict then reported `blocked/incomplete` for a card the
  // lender could read perfectly well. The verdict has recognised state
  // from painted text since round 62; the poll that decides WHEN to stop
  // reading was still classifying the raw DOM, which is the same
  // parallel-site shape once more.
  //
  // `??` so a record predating the field falls back rather than treating
  // an absent value as empty text, which would settle every poll at once.
  let settled = !saysCheckRunning(
    snap.visibleText ?? snap.text ?? '',
    FORCED_CLOSE_COPY.unknownCopy,
  );
  // ROUND 31 P2 — EVERY RENDER THIS DRIVE READ, not just the last one.
  //
  // The poll below overwrites `snap` each tick, so only the FINAL text
  // ever reached the verdict. A card that briefly states an amount while
  // its readiness reads are outstanding — and then settles into ordinary
  // ready copy — was positively OBSERVED stating it, and the observation
  // was thrown away one second later.
  //
  // That matters more here than anywhere else in this file because the
  // amount rule is the one ABSOLUTE claim it makes: nothing on this
  // surface states a figure it cannot substantiate. "Not at the moment we
  // stopped looking" is a different and much weaker claim, and it is the
  // one the code was actually checking. A lender who happens to load the
  // page during that window sees the figure; the drive is supposed to be
  // the reason nobody has to find out that way.
  //
  // Accumulated rather than scanned in place so the poll keeps its
  // existing job — deciding when the card has settled — while the
  // verdict keeps its own, which is judging what was seen. Only the
  // texts are kept; the flags are deliberately still read from the
  // settled render, since a transiently disabled control is a legitimate
  // intermediate state (round 10) and must not be reported as a defect.
  const seenTexts = [];
  /** The same renders, painted text only (round 64 P2). */
  const seenVisibleTexts = [];
  // ROUND 50 P2 — THE COPY AND THE CONTROL, KEPT TOGETHER.
  //
  // The note above is about round 10's exemption, and that exemption is
  // narrower than the shape it was protecting. A transiently DISABLED
  // control is a legitimate intermediate state; a transiently ENABLED
  // one beside copy that says the safety check is still running is not —
  // the lender can press a fee-paying action the protocol has not
  // established is permitted, which is the more expensive direction and
  // the one the withheld-copy arm exists for.
  //
  // `seenTexts` kept the copy and the peaks kept the counts, and nothing
  // kept the PAIR, so an unsafe intermediate render settling into a
  // clean ready state passed: the verdict matched the final copy against
  // the final control and saw nothing wrong.
  //
  // Rendered facts, not a verdict: the drive observes and the module
  // judges. That keeps the copy list in one place and makes the rule
  // unit-testable, which a latch computed here would not be.
  const seenRenders = [];
  // ROUND 35 P2 — THE DUPLICATE COUNT IS EVIDENCE TOO, and it was being
  // overwritten by the same `snap = again` that superseded the text.
  //
  // Round 20 moved this count INTO each snapshot, because counting once
  // before the poll missed a duplicate introduced by the settled render.
  // That was right and is kept — but it left the mirror-image hole: a
  // duplicate present on an intermediate tick and gone by the time the
  // card settles was seen, counted, and then discarded, and the final
  // record passed with `visibleCards: 1`. `remember` only ever captured
  // `shown[0]`'s text, so the second card's content was never read at
  // all — the run had positively observed a surface it could not vouch
  // for and reported it clean.
  //
  // The peak travels BESIDE the settled count rather than replacing it,
  // deliberately. They are different facts — "what the lender is looking
  // at now" and "what this drive saw at any point" — and collapsing them
  // would make the failure unable to say which it was describing.
  //
  // There is no legitimate transient here to forgive: `PositionDetails`
  // renders exactly one `ForcedCloseCard` from one call site, with no
  // keyed list and no transition wrapper, so React reconciles the same
  // node in place. Two visible cards is a defect on any tick.
  let visibleCardsPeak = 0;
  let visibleSubmitsPeak = 0;
  let bodyHiddenSeen = false;
  const remember = (v) => {
    for (const part of [v?.text, v?.bodyText]) {
      if (typeof part === 'string' && part !== '') seenTexts.push(part);
    }
    // ROUND 64 P2 — AND THE PAINTED TEXT OF EVERY RENDER.
    //
    // The scans that classify readiness and accuse the card of stating
    // two states at once run over `parts`, which is built from these.
    // On raw text a recognised sentence erased in the DOM counts as a
    // state the lender was shown, so a card displaying exactly one
    // legitimate state is reported as having shown two — an accusation
    // assembled entirely from copy nobody can read, which is the
    // false-FAIL direction this file everywhere else refuses.
    //
    // Carried BESIDE the raw text rather than replacing it: `seenTexts`
    // answers "what was in this render" and these answer "what could be
    // read in it", and the pair is what lets a verdict say which it
    // means.
    for (const part of [v?.visibleText, v?.bodyVisibleText]) {
      if (typeof part === 'string' && part !== '') seenVisibleTexts.push(part);
    }
    if (v && (typeof v.text === 'string' || typeof v.bodyText === 'string')) {
      seenRenders.push({
        text: v.text,
        bodyText: v.bodyText,
        visibleText: v.visibleText,
        bodyVisibleText: v.bodyVisibleText,
        submitVisible: v.submitVisible,
        submitDisabled: v.submitDisabled,
        // ROUND 75 P2 — AND THE LABEL FACTS, which this projection
        // dropped. The snapshot had already computed them; keeping the
        // control's visibility and disabled state while discarding
        // whether it could be READ meant only the settled render reached
        // the label arms, so a render offering an enabled but blank or
        // unpainted control passed once a later render repaired it. The
        // same transient-control reasoning the unsafe-control arm has
        // carried since round 50 — a click is instantaneous.
        submitLabelled: v.submitLabelled,
        submitLabelPainted: v.submitLabelPainted,
      });
    }
    if (typeof v?.visibleCards === 'number' && v.visibleCards > visibleCardsPeak) {
      visibleCardsPeak = v.visibleCards;
    }
    // ROUND 39 P2 — AND THE CONTROL COUNT, for the same reason one line
    // up. Round 35 fixed the card peak and left its sibling on the
    // settled snapshot, so two visible submit controls on an
    // intermediate tick were counted and then overwritten by `snap =
    // again`. That is the more dangerous of the two duplicates — the
    // copy explains a single decision while the lender is briefly
    // offered it twice, and whichever is pressed, at most one can be the
    // action the copy describes. The drive read only the first, so the
    // second was never inspected at all.
    if (typeof v?.visibleSubmits === 'number' && v.visibleSubmits > visibleSubmitsPeak) {
      visibleSubmitsPeak = v.visibleSubmits;
    }
    // ROUND 41 P2 — AND A BODY THAT WAS PRESENT AND HIDDEN.
    //
    // `remember` kept the TEXTS and the two counts and dropped this, so
    // a card rendering its explanation invisibly — the
    // heading-without-a-reason state the absence rule exists for — was
    // positively observed and then discarded when the card vanished. If
    // an accepted sale explained the disappearance, the run reported
    // `inapplicable`: nothing to see about a lender shown an action with
    // no reason for it.
    //
    // A LATCH rather than a count, because unlike the peaks there is no
    // magnitude to carry — it either happened or it did not — and
    // because the settled render's own `bodyVisible` is judged
    // separately, on its own terms.
    if (v?.bodyPresent === true && v?.bodyVisible === false) bodyHiddenSeen = true;
  };
  remember(snap);
  const deadline = Date.now() + timeoutMs;
  while ((!settled || readyPending(snap)) && Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const again = await readCard();
    // Same sentinel, same treatment (round 41 P2): a scrape that threw
    // mid-poll says nothing about the page, so the loop stops on an
    // INCOMPLETE record rather than letting the last good snapshot stand
    // in for a read that did not happen.
    if (again === SCRAPE_FAILED) {
      return nothingEstablished({
        scrapeFailed: true,
        seenTexts,
        seenVisibleTexts,
        seenRenders,
        visibleCardsPeak,
        visibleSubmitsPeak,
        bodyHiddenSeen,
      });
    }
    remember(again);
    if (again?.hiddenNow) {
      // This literal was the drift the helper exists to stop: it alone
      // omitted `visibleSubmits`, while its three siblings set it to 0.
      // Folding it onto the shared shape supplies it.
      return nothingEstablished({
        mounted: false,
        // ROUND 33 P2 — see the note on the vanished return below. Every
        // exit from this loop carries what the loop saw.
        seenTexts,
        seenVisibleTexts,
        seenRenders,
        visibleCardsPeak,
        visibleSubmitsPeak,
        bodyHiddenSeen,
      });
    }
    // ROUND 13 P2 — A CARD THAT VANISHES MID-POLL IS THE VANISHED CASE,
    // not a reason to keep the last snapshot.
    //
    // `break` retained a `mounted: true` reading from a render the page
    // has since discarded — and the one it most likely retained is the
    // transient ready-but-disabled pair this loop exists to wait out,
    // because that pair is why the loop was still running. Downstream,
    // `mounted` stays true, so the absent-card confirmation is skipped,
    // and the drive accuses a page that had correctly removed a card it
    // no longer had grounds to show.
    //
    // The SAME shape the initial null returns, deliberately: one event,
    // one classification. Two spellings of the vanished card were how it
    // came to be handled two different ways.
    // ROUND 33 P2 — TWO CHANGES, AND THEY ONLY WORK TOGETHER.
    //
    // (1) `mounted`/`attached` now describe what the DOM pass actually
    //     found — nothing. See the matching note on the first-pass null
    //     above for why the old `true/true` turned an ordinary lifecycle
    //     race into a blocked/incomplete exit, and why `attached` has to
    //     move with `mounted` rather than after it.
    //
    // (2) `seenTexts` travels out with it. Both of this loop's early
    //     exits used to drop the accumulated renders on the floor, which
    //     is where the two findings meet: a card that stated a figure
    //     mid-poll and then vanished had the evidence discarded HERE, and
    //     if an accepted sale then explained the disappearance the
    //     verdict returned `inapplicable` — a run reporting nothing to
    //     see about an amount a lender was shown. Carrying the texts is
    //     also what makes (1) safe, since the verdict's amount scan now
    //     runs ahead of the mounted gate and has something to read.
    //
    // The flags are still deliberately NOT carried: a transiently
    // disabled control is a legitimate intermediate state (round 10) and
    // must not be reported from a render the page has discarded. Only
    // the texts are evidence of what was said.
    if (again === null) {
      return {
        mounted: false,
        attached: false,
        visibleCards: 0,
        text: null,
        bodyText: null,
        bodyPresent: undefined,
        bodyVisible: false,
        confirmText: null,
        confirmExpected: false,
        submitPresent: false,
        submitVisible: false,
        submitDisabled: true,
        settled: false,
        seenTexts,
        seenVisibleTexts,
        seenRenders,
        visibleCardsPeak,
        visibleSubmitsPeak,
        bodyHiddenSeen,
      };
    }
    snap = again;
    // Same rule per tick as at the top — both sites, because fixing one
    // of a pair is what this PR keeps being caught by.
    settled = !saysCheckRunning(
      snap.visibleText ?? snap.text ?? '',
      FORCED_CLOSE_COPY.unknownCopy,
    );
  }

  // ROUND 27 P2 — the field list is GONE, not lengthened.
  //
  // This hand-written destructure, and the matching object literal at the
  // end of this function, were a second copy of the DOM pass's field set
  // that had to be edited in lockstep with it. It has now silently
  // dropped a field TWICE: round 23 produced `absenceUnconfirmedWhy` and
  // this shape lost it, and last round I added `visibleSubmits`, wrote a
  // reply about that exact seam being uncovered, and dropped the new
  // field through it in the same commit.
  //
  // Fixing the instance a second time would have left the mechanism
  // intact for the third. A unit test cannot cover it either — the
  // verdict's tests pass constructed records straight to
  // `forcedCloseVerdict`, so they are satisfied by a field this
  // projection never forwards, which is exactly why both drops were
  // invisible to a green suite.
  //
  // So the projection no longer enumerates anything: the snapshot is
  // spread whole and only the values computed OUTSIDE the DOM pass are
  // layered on top. A field added to the evaluate now reaches the
  // verdict because there is no longer a list that can fail to mention
  // it. `snap.hiddenNow` cannot leak in — that case returns above.
  const text = snap.text;

  // ROUND 25 P2 — THE INTERACTION TARGETS THE CARD THE SCRAPE JUDGED.
  //
  // Round 23 taught the WAIT to accept any visible match, and round 24
  // made that fallback actually run — but both only produced a boolean.
  // `card` stayed `cards.first()`, so with a hidden node ahead of the
  // real one the drive read the visible card's copy and then clicked,
  // waited and scanned the HIDDEN one: the submit click times out,
  // `confirmText` stays null, and a perfectly healthy card is reported
  // BLOCKED. Two rounds of fixing which element we wait on, while every
  // later interaction went on addressing the wrong one.
  //
  // ROUND 33 P2 — AND `:visible` IS NOT THE SAME PREDICATE AS `visible`,
  // so round 25's fix left the two halves pointing at different cards
  // again, one refinement further in.
  //
  // Playwright's `:visible` means a non-empty bounding box and a computed
  // `visibility` that is not hidden. It says NOTHING about opacity —
  // deliberately, and it is documented that way. The in-page `visible`
  // predicate this drive judges with rejects ancestor opacity, because
  // round 22 established that a card under `opacity: 0` is a card the
  // lender cannot see. So an invisible-but-transparent card sitting ahead
  // of the real one is `shown`-rejected by the snapshot and `:visible`-
  // accepted by the locator: the copy, the submit state and the duplicate
  // count all describe the genuine card, while the click, the Back wait
  // and the receipt scan all land on the transparent one. The click times
  // out, `confirmText` stays null, and a healthy card is reported
  // incomplete — the exact failure round 25 fixed, reintroduced by the
  // narrower definition round 22 adopted for the scrape alone.
  //
  // Addressed by INDEX from the snapshot instead, so there is one
  // predicate deciding which card this is: `nth()` re-resolves at each
  // action the way `:visible` did, and the index comes from the pass that
  // chose `shown[0]`. The residual race is that the DOM order changes
  // between the final snapshot and the click, which is the same window
  // every other fact in that snapshot already lives in — and far narrower
  // than judging one card and clicking another by construction.
  //
  // Falls back to the first card only for a record that carries no index
  // at all — `indexOf` cannot miss, since `el` is drawn from `all`, so
  // this is defending against a stale shape rather than a real case.
  const card = cards.nth(
    Number.isInteger(snap.chosenIndex) && snap.chosenIndex >= 0 ? snap.chosenIndex : 0,
  );

  // ROUND 2 P2 — a submittable card whose confirmation could NOT be read
  // is `confirmExpected` with `confirmText === null`, which the verdict
  // turns into BLOCKED. Catching the interaction error and quietly
  // accepting its null result would let the run exit 0 having skipped
  // half the surface it advertises — the same silent-null shape as the
  // findings above it.
  // The submit facts come from the atomic capture (round 9 P2), so the
  // control this clicks is the one the verdict judged.
  // A hidden control cannot be clicked, so no confirmation is expected
  // from one — the verdict reports the missing usable action instead
  // (round 18 P2).
  const confirmExpected =
    snap.submitPresent && snap.submitVisible && !snap.submitDisabled;
  let confirmText = null;
  /** The same panel, with the unpainted parts left out (round 64 P2). */
  let confirmVisibleText = null;
  /** The confirmation's Back control: can the lender cancel? (round 65 P2) */
  let backAction;
  // ROUND 45 P2 — the confirmation's OWN action, observed and never
  // clicked. Declared here rather than inside the branch so the final
  // projection can carry it whether or not the panel opened.
  let confirmAction;
  // ROUND 50 P2 — the text of the receipt rows that WERE readable,
  // carried separately from `confirmText` so an amount on a visible row
  // is scanned even when another row is not.
  let confirmRowsText = null;
  // ROUND 53 P2 — visible text on the confirmation OUTSIDE the receipt
  // rows: a warning banner, a gas note, the confirm control's own label.
  let confirmOtherText = null;
  // ROUND 50 P2 — CAN THE OUTER SUBMIT ACTUALLY BE CLICKED?
  //
  // The real click below already fails when it cannot, and that `false`
  // was thrown away: the verdict saw only `confirmText === null` and
  // filed an otherwise eligible visit as `blocked/incomplete`. So a
  // deployed card that strands the lender BEFORE the confirmation — a
  // visible, enabled submit under an overlay or `pointer-events: none` —
  // was reported as a gap in this drive's reading rather than as the
  // product defect it is.
  //
  // Trialled first, exactly as the confirmation's own action is (round
  // 46), so the two controls are judged the same way and the signal is
  // separated from whatever else a real click can fail on — a detach
  // mid-click, a navigation. The trial dispatches nothing; the real
  // click still follows, because opening the panel is how the receipt
  // gets read.
  //
  // `undefined` where no trial was run, so a record that never reached
  // this path says nothing.
  let submitClickable;
  if (confirmExpected) {
    // ONE LOCATOR for the trial and the real click, so the two cannot
    // describe different controls — the mismatch round 38 found between
    // the judged card and the clicked one, and round 46 found again
    // inside the confirmation.
    const submit = card
      // ROUND 26 P2 — click the control the verdict judged actionable.
      // `getByTestId(...).first()` addresses the first in the DOM, which
      // on a duplicated render is the one that may be disabled; the
      // actionability above is derived from the VISIBLE set, so the
      // click has to be too or the two describe different buttons.
      // ROUND 38 P2 — BY INDEX, from the same pass that judged it.
      // `:visible` is a different predicate from the drive's own
      // `visible` (it does not consider opacity), so this used to be
      // free to address a control the snapshot had excluded.
      .locator('[data-testid="forced-close-submit"]')
      .nth(
        Number.isInteger(snap.chosenSubmitIndex) && snap.chosenSubmitIndex >= 0
          ? snap.chosenSubmitIndex
          : 0,
      );
    submitClickable = await submit
      .click({ trial: true, timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    const opened = await submit
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    // ROUND 53 P2 — A SUCCESSFUL REAL CLICK SETTLES IT.
    //
    // The trial is a three-second probe and the real click gets five
    // more immediately after, so a control that was covered or still
    // animating during the trial can be perfectly actionable by the
    // time the real click lands. `submitClickable` stayed latched at
    // `false`, and the verdict then reported that the lender cannot
    // reach the confirmation — while the very same observation had
    // opened it and scanned the whole receipt.
    //
    // The trial exists to catch a control that is UNREACHABLE. A click
    // that actually worked is stronger evidence than a probe that did
    // not, and refusing it would be reporting a defect the run itself
    // disproved. The trial's `false` is kept only when the real click
    // also failed — which is the case the finding is for.
    if (opened) submitClickable = true;
    if (opened) {
      // ROUND 4 P2 — CONFIRM THE CONFIRMATION RENDERED.
      //
      // The click can succeed while its handler fails to open the
      // panel, and the old read was scoped to the card — which is still
      // mounted and still has text. `confirmText` came back non-null,
      // the verdict recorded `confirmScanned=true`, and a regression
      // confined to the confirmation went completely unexercised while
      // reporting as covered.
      //
      // The Back control belongs to `ConfirmReceipt` and does not exist
      // on the card otherwise, so its appearance is the evidence that
      // the panel is up. No Back, no scan: `confirmText` stays null and
      // the verdict blocks.
      //
      // ROUND 70 P2 — THE PANEL IS DETECTED INDEPENDENTLY OF ITS BACK
      // CONTROL.
      //
      // Gating the whole scrape on Back meant a confirmation whose
      // receipt and fee-paying action render perfectly, but whose Back
      // button is missing, was never scanned at all: `confirmText`
      // stayed null and the verdict reported `blocked/incomplete`. The
      // directly observable defect — the lender has no way to decline
      // without leaving the page — was reported as a gap in the reading.
      //
      // Either marker proves the panel is up, and they fail
      // independently: Back is the control, the rows are the content.
      // Awaited together rather than raced, because a race is won by
      // whichever rejects first and would make a missing Back look like
      // a missing panel again.
      //
      // ROUND 73 P2 — AND THE FEE-PAYING ACTION IS A THIRD MARKER.
      //
      // Round 70 took the gate from one marker to two and stopped there,
      // which is this PR's recurring shape once more. A regressed panel
      // keeping its visible confirm button while losing BOTH the receipt
      // rows and Back answered false to both waits, so the whole scrape
      // was skipped and the run reported an unread observation — when
      // what was on screen is far worse than a gap: a lender looking at
      // a fee-paying action with no receipt explaining it and no way to
      // decline.
      //
      // `.cluster` is the confirm pair's own container, and inside this
      // card it comes only from `ConfirmReceipt` — the outer submit is
      // not rendered at all while the panel is open, so a cluster button
      // appearing after the click is the panel and nothing else.
      // SELF-REVIEW AFTER ROUND 76 — AND THIS LOCATOR IS ENGLISH-ONLY.
      //
      // Found by checking the shipped copy rather than reasoning about
      // it. Round 76's finding was that a CONFIRM label containing "back"
      // would be misread as the Back control; no shipped label does. What
      // the same check turned up is worse and the other way round: of the
      // ten locales that carry this panel, only English spells Back with
      // the ASCII letters `back`. `Zurück`, `Atrás`, `Retour`, `رجوع`,
      // `वापस`, `戻る`, `뒤로`, `பின் செல்லவும்` and `返回` all fail
      // `/back/i`.
      //
      // On a non-English render this locator would find nothing:
      // `backAction.present` reads false and the missing-Back arm reports
      // a lender with no way to decline, while the in-page filter keeps
      // BOTH buttons and the duplicate-action arm reports more than one
      // way to pay. Two false product FAILs from one unmatched regex.
      //
      // THAT CANNOT HAPPEN TODAY, and saying so is the point of this
      // note. The browser context pins `locale: 'en-US'`, so the whole
      // drive is English BY CONSTRUCTION — `FORCED_CLOSE_COPY` reads
      // `en.json` by name for the same reason, and the chooser, jump and
      // switch locators are hard-coded English regexes on the same
      // assumption. The exposure is latent behind that pin, not live.
      //
      // The marker is still the better identity: it removes a coupling to
      // COPY, which can change within English — round 76's actual point,
      // a confirm label containing the word "back". The label stays as
      // the fallback for builds deployed before the marker ships.
      const backMarked = await card
        .locator('[data-testid="confirm-receipt-back"]')
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      const back = backMarked
        ? card.locator('[data-testid="confirm-receipt-back"]').first()
        : card.getByRole('button', { name: /back/i }).first();
      const receiptRow = card
        .locator('[data-testid^="forced-close-receipt"], dl.receipt .receipt-row')
        .first();
      const clusterAction = card.locator('.cluster button').first();
      const [backUp, rowsUp, actionUp] = await Promise.all([
        back
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
        receiptRow
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
        clusterAction
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
      ]);
      const rendered = backUp || rowsUp || actionUp;
      if (rendered) {
        // ROUND 23 P2 — THE RECEIPT'S OWN ROWS, not the shell plus DOM
        // text.
        //
        // A visible Back button proves the panel opened; it says nothing
        // about the six-row funds receipt beside it. Hide only those
        // rows — `opacity: 0` on their container — and the Back control
        // still renders while `innerText` still yields their text, so
        // the drive recorded `confirmScanned=true` for a lender who was
        // shown a shell and two controls. That is the same node-property
        // mistake as the card and the body, on the surface where it
        // matters most, since this panel is where the no-amount promise
        // is most likely to be broken.
        //
        // The scan is scoped to what is actually rendered: if nothing of
        // the receipt is visible, `confirmText` stays null and the
        // verdict blocks rather than banking a clean reading.
        const receiptShown = await card
          .evaluate((el) => {
            // ROUND 28 P2 — the clipping rule, and a note about this
            // being the SECOND copy of this predicate.
            //
            // These two `visible` helpers live in separate `evaluate`
            // bodies, so neither can call the other, and they had
            // ALREADY drifted: the page-level copy carries an
            // ancestor-opacity walk for engines without
            // `checkVisibility` and this one never did. That is the same
            // hand-maintained-duplicate shape as the field list deleted
            // last round, and it is not fixed here — sharing a function
            // across evaluates means injecting source and running it
            // through `eval`/`new Function`, which a page CSP can refuse
            // outright, and a drive that dies on a CSP header is worse
            // than one with a duplicated predicate. Filed as a follow-up
            // rather than attempted mid-review.
            const notClipped = (node) => {
              // ROUND 36 P2 — A CLIPPER DOES NOT HAVE TO BE EXACTLY ZERO to hide
              // everything inside it. `height: 0` was the only case rounds 28/29
              // rejected, so `height: 1px; overflow: hidden` walked straight
              // through: the ancestor is non-zero, every descendant keeps a
              // full-size rect and passes `checkVisibility`, and `innerText` yields
              // all of it — so the fee and loss rows of the receipt were recorded
              // as read while the lender could see a single pixel of them.
              //
              // A non-scrollable clipper now has to actually SHOW the element: at
              // least half of the element's extent must fall inside the clipper's
              // box on the clipped axis. Half rather than any overlap, because a
              // 1px clipper DOES overlap — that is exactly how it escaped — and
              // rather than full containment, which would condemn a row whose
              // descender is clipped by a pixel. Half a line is the point below
              // which a figure cannot be read at all.
              //
              // SCROLLABLE clippers stay exempt, which is rounds 28/29's deliberate
              // limit restated: content the lender can scroll to is reachable, and
              // condemning it is the false-FAIL direction that gets a check
              // switched off. `auto`/`scroll` WITH something to scroll is the test;
              // `hidden` and `clip` are not user-scrollable however much they hold.
              //
              // OUT-OF-FLOW ELEMENTS GET THE BENEFIT OF THE DOUBT, and only for the
              // intersection rule. Which clipper applies to an absolutely or fixed
              // positioned box is a containing-block question — a `position:
              // absolute` child of a `position: static` `overflow: hidden` ancestor
              // is NOT clipped by it — and answering it wrongly condemns content
              // the lender can see. The collapsed-clipper rule still applies to
              // them. Nothing on this card is out of flow; this is here so the
              // predicate stays honest if something ever is.
              const flow = getComputedStyle(node).position;
              const inFlow = flow === 'static' || flow === 'relative';
              // ROUND 65 P2 — WHICH ancestors clip an out-of-flow box, rather than
              // none of them.
              //
              // The exemption below was written to avoid a containing-block
              // question, and avoiding it cost the whole rule: `inFlow` is computed
              // once, so for any absolute or fixed node the walk skipped EVERY
              // ancestor intersection test. An absolutely positioned body, receipt
              // leaf or action inside a positioned `overflow: hidden` box — which IS
              // its containing block and definitively clips it — carried fully
              // clipped readiness copy or funds disclosures into a passing verdict.
              //
              // The question is answerable, and narrowly. An absolutely positioned
              // box is clipped by an `overflow` ancestor only from its CONTAINING
              // BLOCK upwards; ancestors between it and that block do not clip it.
              // So the walk skips until it reaches the containing block and applies
              // the rule from there — including to the containing block itself,
              // which clips its own padding box.
              //
              // Read from the properties that define it rather than guessed: for
              // `absolute`, the nearest ancestor that is positioned or that
              // establishes a containing block by `transform`, `filter`,
              // `perspective` or paint/layout `contain`; for `fixed`, only the
              // latter group, since a merely positioned ancestor does not capture a
              // fixed box. Anything this cannot decide leaves the ancestor skipped,
              // so the residual stays a missed defect rather than an invented one.
              const establishesCB = (cs) =>
                cs.transform !== 'none' ||
                cs.perspective !== 'none' ||
                cs.filter !== 'none' ||
                /\b(paint|layout|strict|content)\b/.test(cs.contain || '') ||
                /\btransform\b/.test(cs.willChange || '');
              let reachedCB = inFlow;
              const r = node.getBoundingClientRect();
              // TRUNCATED TEXT IS CONDEMNED, DELIBERATELY, and this note exists so
              // it is not "fixed" later as a false positive. `text-overflow:
              // ellipsis` with `white-space: nowrap` gives a line box wider than its
              // clipping box, so a heavily truncated line fails the ratio below.
              // That is the right answer HERE even though it would be wrong on a
              // chrome label: a fee value cut off mid-number, or an explanation cut
              // off mid-sentence, is exactly what this drive exists to catch, and a
              // reader seeing an ellipsis does not make the missing half readable.
              //
              // Checked rather than assumed — the only ellipsis rules in
              // `global.css` are `.connect-addr`/`.connect-label` and the two
              // `.select-menu-*` classes, which are the header wallet button and the
              // select menus. Nothing observed by this drive is truncated today.
              //
              // One Range per NODE, not per clipping ancestor: this predicate runs
              // for the card, the body, the control and every receipt leaf on every
              // poll tick, and rebuilding the range inside the walk was pure waste.
              const ownText = [...node.childNodes].some(
                (c) => c.nodeType === 3 && c.textContent.trim() !== '',
              );
              const boxes = (() => {
                if (!ownText) return [r];
                try {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const rects = [...range.getClientRects()].filter(
                    (q) => q.width > 0 && q.height > 0,
                  );
                  // "No rects" must not read as "nothing is visible".
                  return rects.length > 0 ? rects : [r];
                } catch {
                  return [r];
                }
              })();
              // ROUND 44 P2 — STARTS AT THE NODE, not at its parent.
              //
              // A leaf that clips its OWN text was never examined: `height: 1px;
              // overflow: hidden` on the `dd` itself leaves a positive rect (so the
              // geometry test passes), `checkVisibility` positive, `paintsText`
              // satisfied — and the only box that would have caught it was the one
              // box this walk skipped. `innerText` then supplied the hidden
              // disclosure and the confirmation scan recorded it as read.
              //
              // Including the node costs nothing on a normal leaf: `overflow:
              // visible` skips the body of the loop, and a leaf sized to its own
              // content contains its own line boxes by definition.
              // ROUND 48 P2 — A CLIP PATH HIDES TEXT THAT EVERY OTHER TEST VOUCHES FOR.
              //
              // `clip-path: inset(50%)` — the modern visually-hidden idiom — leaves the
              // box laid out at full size, `checkVisibility` positive, the overflow walk
              // satisfied (there is no overflow) and `paintsText` satisfied (the colour
              // is opaque), while nothing is painted. `innerText` keeps yielding every
              // word, so the receipt's fee and loss rows could be recorded as read with
              // the lender seeing none of them. Same class as rounds 37, 43, 44 and 45:
              // a property that hides the CONTENT rather than the box.
              //
              // ONLY `inset()`, and only where the region is PROVABLY EMPTY. A circle,
              // an ellipse, a polygon, a `path()` or a `url()` reference can each be
              // empty too, and deciding that in general is a geometry problem this
              // predicate has no business attempting — getting it wrong condemns content
              // the lender can see, which is the error that gets a whole check switched
              // off. Anything it cannot read counts as painted, so the residual is a
              // missed defect and never an invented one.
              //
              // The legacy `clip: rect(...)` idiom needs nothing here: this codebase's
              // `.visually-hidden` pairs it with `width: 1px; height: 1px;
              // overflow: hidden`, which the half-extent rule below already rejects.
              const emptyClipRegion = (cs, box) => {
                const raw = (cs.clipPath || 'none').trim();
                const m = /^inset\(([^)]*)\)$/i.exec(raw);
                if (!m) return false;
                // `round <radii>` describes the corners, not the extent.
                const parts = m[1].split(/\s+round\s+/i)[0].trim().split(/\s+/).filter(Boolean);
                if (parts.length === 0 || parts.length > 4) return false;
                const px = (t, extent) => {
                  const v = String(t);
                  if (v.endsWith('%')) {
                    const n = Number(v.slice(0, -1));
                    return Number.isFinite(n) ? (n / 100) * extent : null;
                  }
                  const n = Number(v.endsWith('px') ? v.slice(0, -2) : v);
                  return Number.isFinite(n) ? n : null;
                };
                // CSS shorthand order, top/right/bottom/left with the usual fill-ins.
                const top = px(parts[0], box.height);
                const right = px(parts[1] ?? parts[0], box.width);
                const bottom = px(parts[2] ?? parts[0], box.height);
                const left = px(parts[3] ?? parts[1] ?? parts[0], box.width);
                if ([top, right, bottom, left].some((v) => v === null)) return false;
                // Judged only on an axis with extent to lose. A degenerate box is
                // someone else's finding, and calling it an empty clip would be
                // asserting something this has not established.
                return (
                  (box.height > 0 && top + bottom >= box.height) ||
                  (box.width > 0 && left + right >= box.width)
                );
              };
              for (let n = node; n; n = n.parentElement) {
                const cs = getComputedStyle(n);
                // An empty clip region on the node or on any ancestor hides
                // everything inside it, whatever the overflow rules say.
                //
                // The string test comes FIRST so the rect is not measured on
                // every ancestor of every node on every poll tick. `clip-path`
                // is `none` almost everywhere, and forcing a layout read to
                // discover that was a cost my own first version added silently.
                const clipPath = cs.clipPath;
                if (
                  clipPath &&
                  clipPath !== 'none' &&
                  emptyClipRegion(cs, n.getBoundingClientRect())
                ) {
                  return false;
                }
                const clipsY = cs.overflowY !== 'visible';
                const clipsX = cs.overflowX !== 'visible';
                if (!clipsY && !clipsX) continue;
                const box = n.getBoundingClientRect();
                if (clipsY && box.height === 0) return false;
                if (clipsX && box.width === 0) return false;
                // ROUND 45 P2 — the out-of-flow exemption is about ANCESTORS, never
                // about the node's own clipping box.
                //
                // I wrote it to avoid a containing-block question: whether a given
                // ancestor clips an absolutely positioned descendant depends on which
                // element is that descendant's containing block, and answering it
                // wrongly condemns content the lender can see. None of that
                // uncertainty applies to an element clipping ITS OWN text — every
                // element clips its own content, whatever its `position` is.
                //
                // Round 44 put `node` into this walk and this `continue` skipped it
                // right back out again for a positioned leaf, so `position: absolute;
                // height: 1px; overflow: hidden` still passed. The fix for the skipped
                // box, skipping the same box.
                // ROUND 65 P2 — skip only UP TO the containing block, then apply the
                // rule. `n !== node` keeps round 45's correction: an element always
                // clips its OWN text, whatever its `position`.
                if (!reachedCB && n !== node) {{
                  if (flow === 'fixed' ? establishesCB(cs) : cs.position !== 'static' || establishesCB(cs)) {{
                    reachedCB = true;
                  }} else {{
                    continue;
                  }}
                }}
                const scrollsY =
                  (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
                  n.scrollHeight > n.clientHeight;
                const scrollsX =
                  (cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
                  n.scrollWidth > n.clientWidth;
                // ROUND 43 P2 — PER LINE, not per element.
                //
                // The half-of-the-element rule reads a MULTI-LINE leaf as visible
                // whenever half of it survives — so a two-line value with its second
                // line entirely clipped passes at exactly 50%, `innerText` yields
                // both lines, and the run records a lender as having read a
                // disclosure whose second half is not on screen. On this surface the
                // clipped half is as likely as not to be the one carrying the
                // consequence.
                //
                // A Range over the node's own text yields one client rect per LINE
                // BOX, which is the unit a reader actually consumes. Every line must
                // clear the same half-visible bar the element used to clear as a
                // whole — so a descender trimmed by a pixel still passes (that line
                // is ~95% shown) while a line that is wholly outside does not.
                //
                // SCOPED TO NODES CARRYING THEIR OWN TEXT, and computed ONCE above
                // the ancestor walk rather than per ancestor.
                //
                // Both corrected after writing this. `selectNodeContents` on a
                // CONTAINER yields a rect per line of its whole subtree, so applying
                // the per-line rule to the card or the body would condemn the entire
                // surface whenever any single descendant line was mostly clipped —
                // and the resulting verdict says "card is in the DOM but not
                // visible", which is the wrong sentence about a card that is largely
                // on screen. The finding was about a multi-line `dt`/`dd`, and a
                // leaf's own text is exactly where "can this be read" is the
                // question being asked. Same scope `paintsText` uses, for the same
                // reason.
                //
                // Containers keep the element-rect rule they already had, and their
                // leaves are checked individually anyway — the receipt probe
                // requires every row AND both of its leaves to pass.
                for (const q of boxes) {
                  if (clipsY && !scrollsY && q.height > 0) {
                    const shown = Math.min(q.bottom, box.bottom) - Math.max(q.top, box.top);
                    if (shown / q.height < 0.5) return false;
                  }
                  if (clipsX && !scrollsX && q.width > 0) {
                    const shown = Math.min(q.right, box.right) - Math.max(q.left, box.left);
                    if (shown / q.width < 0.5) return false;
                  }
                }
              }
              return true;
            };
            const paintsText = (node) => {
              // ROUND 37 P2 — TEXT CAN BE HIDDEN BY ITS OWN COLOUR, and nothing else
              // in this predicate looks at colour. `color: transparent` leaves the
              // element laid out, `checkVisibility` positive, the rect non-zero and
              // the clipping walk satisfied, while `innerText` keeps yielding every
              // word — so the receipt's fee and loss values could be recorded as
              // read with nothing painted on screen. Same class as the opacity and
              // clipping holes before it: a property that hides the CONTENT rather
              // than the box.
              //
              // Only elements carrying their OWN text are judged. `color` inherits,
              // so testing a wrapper would condemn a whole card whose children set
              // their own colour — a false FAIL, on the very element the run exists
              // to vouch for. The leaves are where this matters anyway: the
              // receipt's `dt`/`dd` are exactly the nodes whose values get blanked.
              //
              // `-webkit-text-fill-color` is read first because it OVERRIDES `color`
              // for painting wherever it is set, which is how this is usually done
              // in a real stylesheet.
              //
              // Alpha ZERO only, never a contrast judgement. Deciding text is too
              // faint against its background needs the background, the stacking and
              // whatever image sits behind it, and getting that wrong condemns
              // legible copy — the direction this file keeps saying gets a check
              // switched off.
              const own = [...node.childNodes].some(
                (c) => c.nodeType === 3 && c.textContent.trim() !== '',
              );
              if (!own) return true;
              const cs = getComputedStyle(node);
              // Glyph rectangles rather than the element box — see the card
              // copy's round-82 note. `text-indent` and friends move the LINE
              // and leave the box in place, so the box-shaped tests all pass
              // while the text sits before the document origin. Own text
              // nodes only; any reachable rectangle, or none measurable at
              // all, counts as painted.
              const glyphs = [];
              for (const c of node.childNodes) {
                if (c.nodeType !== 3 || c.textContent.trim() === '') continue;
                try {
                  const range = document.createRange();
                  range.selectNodeContents(c);
                  for (const q of range.getClientRects()) {
                    if (q.width > 0 && q.height > 0) glyphs.push(q);
                  }
                } catch {
                  // Unmeasurable: leaves `glyphs` short, which reads as painted.
                }
              }
              if (
                glyphs.length > 0 &&
                glyphs.every(
                  (q) => q.right + window.scrollX <= 0 || q.bottom + window.scrollY <= 0,
                )
              ) {
                return false;
              }
              const fill = cs.webkitTextFillColor || cs.color || '';
              // ROUND 38 P2 — EVERY COMPUTED COLOUR FORM, not just `rgb()`/`rgba()`.
              //
              // Chromium PRESERVES the functional notation for the modern colour
              // syntaxes, so `color(display-p3 0 0 0 / 0)` and `oklab(0 0 0 / 0)`
              // never matched the old `rgba?` probe — and the no-match branch
              // returns "painted", which fails OPEN on the one check that exists
              // to catch invisible funds copy. All six receipt leaves could pass
              // while `innerText` supplied their values.
              //
              // Parsed by SHAPE rather than by enumerating colour functions:
              // every CSS colour syntax carrying alpha spells it either after a
              // `/` (the modern forms, and space-separated `rgb()`) or as a fourth
              // comma-separated component (legacy `rgba()` / `hsla()`). Reading
              // the shape means a colour function added to CSS later needs no
              // change here — the enumeration mistake this file has now made
              // twice, with the transport allowlist and the currency signs.
              //
              // ANYTHING UNPARSEABLE COUNTS AS PAINTED. A form this cannot read
              // must not be condemned: a false FAIL on legible copy is the error
              // that gets the whole check switched off, so the residual is a
              // missed defect and never an invented one.
              const alphaOf = (value) => {
                const v = String(value).trim();
                if (v === 'transparent') return 0;
                const fn = /^[a-zA-Z-]+\(([^]*)\)$/.exec(v);
                if (!fn) return 1;
                const body = fn[1];
                const cut = body.lastIndexOf('/');
                let raw = null;
                if (cut >= 0) {
                  raw = body.slice(cut + 1);
                } else {
                  const parts = body.split(',');
                  if (parts.length === 4) raw = parts[3];
                }
                if (raw === null) return 1;
                const t = raw.trim();
                const n = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
                return Number.isFinite(n) ? n : 1;
              };
              if (alphaOf(fill) !== 0) return true;
              const shadow = String(cs.textShadow ?? 'none').trim();
              if (shadow !== '' && shadow !== 'none') return true;
              const strokeWidth = String(cs.webkitTextStrokeWidth ?? '0px').trim();
              const strokeColor = String(cs.webkitTextStrokeColor ?? 'transparent').trim();
              if (parseFloat(strokeWidth) > 0 && alphaOf(strokeColor) !== 0) return true;
              return false;
            };
            const shownBox = (node) => {
              if (!node) return false;
              if (typeof node.checkVisibility === 'function') {
                if (
                  !node.checkVisibility({
                    opacityProperty: true,
                    visibilityProperty: true,
                    contentVisibilityAuto: true,
                  })
                ) {
                  return false;
                }
              }
              // ROUND 51 P2 — A FILTER ERASES CONTENT THE SAME WAY OPACITY DOES,
              // and nothing above looks at it.
              //
              // `filter: opacity(0)` leaves the geometry, the computed `opacity`,
              // the text colour and `checkVisibility` all untouched while Chromium
              // paints nothing — so the explanation, or a fee and loss row, could be
              // vouched for from `innerText` with none of it on screen. Same class
              // as rounds 37, 43, 44, 45 and 48: a property that hides the CONTENT
              // rather than the box.
              //
              // Checked on the same ANCESTOR WALK as `opacity`, because a filter
              // applies to the element and everything inside it exactly as opacity
              // does — one walk, one rule, rather than a second traversal to drift.
              //
              // ONLY a zero `opacity()` component, and only where it is stated as a
              // number. `brightness(0)` paints black rather than nothing, a `url()`
              // reference is an arbitrary SVG filter, and deciding in general what a
              // filter chain renders is not something this predicate can do — so
              // anything else counts as painted. The residual is a missed defect,
              // never an invented one.
              const filterErases = (cs) => {
                const f = cs.filter;
                if (!f || f === 'none') return false;
                for (const m of String(f).matchAll(/opacity\(([^)]*)\)/gi)) {
                  const t = m[1].trim();
                  const v = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
                  if (Number.isFinite(v) && v === 0) return true;
                }
                return false;
              };
              for (let n = node; n; n = n.parentElement) {
                const cs = getComputedStyle(n);
                if (Number(cs.opacity) === 0) return false;
                if (filterErases(cs)) return false;
              }
              const r = node.getBoundingClientRect();
              if (!(r.width > 0 && r.height > 0)) return false;
              const docRight = r.right + window.scrollX;
              const docBottom = r.bottom + window.scrollY;
              if (docRight <= 0 || docBottom <= 0) return false;
              return notClipped(node);
            };
            // ROUND 66 P2 — TWO QUESTIONS, SEPARATED. `shownBox` above answers
            // whether the BOX is on screen: display, visibility, opacity, an
            // erasing filter, geometry and clipping, each of which hides
            // everything inside it. `paintsText` answers whether an element's
            // OWN text is painted, which affects only that element's own text
            // nodes — `color` inherits, and a descendant may repaint itself.
            //
            // `visible` is unchanged: it is both, and every existing caller
            // asking "can the lender read THIS element" still gets the same
            // answer. The split exists so `visibleTextOf` can stop discarding a
            // painted descendant because its container's own text is not.
            const visible = (node) => shownBox(node) && paintsText(node);
            // ROUND 24 P2 — THE RECEIPT, not anything with text in it.
            //
            // My first version fell back to any `p`/`dd`/`dt`/`span` in
            // the card when no `forced-close-receipt*` id was found —
            // and `ReviewReceipt` renders none, so the fallback ran every
            // time and matched `forced-close-body`, a paragraph that is
            // not part of the receipt at all. The check was therefore
            // satisfied by the card's own explanation while the receipt
            // was hidden, which is precisely the state it was written to
            // catch.
            //
            // `ReviewReceipt` renders `<dl class="receipt">` with
            // `.receipt-row` children, so there is a real anchor and no
            // fallback is needed. If that markup ever changes this
            // returns false and the verdict blocks — the honest failure
            // rather than a silent pass.
            //
            // ROUND 25 P2 — THE ROWS, NOT THE WRAPPER THEY SIT IN.
            //
            // Last round I added `dl.receipt` itself to this list as a
            // second anchor, which quietly reintroduced the hole the
            // round before had closed. `opacity: 0` on the rows leaves
            // the `<dl>` laid out at full height with a non-zero rect,
            // so the wrapper answers "visible" for a receipt whose every
            // row is invisible — and `innerText` still yields the hidden
            // labels and figures, so the lead check passes too and the
            // run records `confirmScanned=true` against a receipt the
            // lender cannot see. This is the exact state the probe
            // exists to catch, and the wrapper is structurally incapable
            // of reporting it: it is not the thing being hidden.
            //
            // One anchor fewer is the point. A wrapper is not evidence
            // about its contents, and adding it as a fallback was the
            // same mistake as the `p`/`dd`/`span` fallback before it —
            // a claim about a case I had not looked at.
            // ROUND 45 P2 — THE CONFIRMATION'S OWN ACTION, located but
            // never clicked.
            //
            // The drive opened the panel, waited for Back, scanned the
            // six rows — and never looked at the button that would
            // actually send the transaction. A confirm control missing,
            // hidden, blank or permanently disabled strands the lender
            // one click short of the action while this run reports the
            // ACTIONABLE route as covered, which is the strongest claim
            // it makes.
            //
            // Located by STRUCTURE because `ConfirmReceipt` gives it no
            // testid: the panel renders exactly two buttons in one
            // cluster — Back and confirm — and the outer submit is not
            // rendered at all while the panel is open, so the confirm
            // action is the button beside Back.
            //
            // NOT CLICKED, which is the point of doing it this way: this
            // drive is watch-only and that button sends a fee-paying
            // transaction. Presence, visibility, a non-blank label and
            // `disabled === false` are all observable without touching
            // it.
            const panelButtons = [...el.querySelectorAll('button')];
            // ROUND 76 P2 — THE MARKER FIRST, THE LABEL ONLY AS A FALLBACK.
            //
            // Round 75 excluded every control whose label reads as Back,
            // which closed the two-Back hole and left identity coupled to
            // COPY: a confirm label containing the word — "Pay back and
            // close" — would be excluded as a Back control and the panel
            // reported as having no fee-paying action at all. That is a
            // false FAIL waiting on a copy change, and it is worse in the
            // nine translated bundles, where the heuristic does not even
            // apply.
            //
            // `ConfirmReceipt` now marks both controls, so identity comes
            // from the markup. The label heuristic stays as a FALLBACK
            // rather than being deleted: this drive runs against the
            // DEPLOYED build, which will not carry the markers until this
            // change ships, and a check that goes blind between merge and
            // deploy is worse than one with a known-imperfect fallback.
            // On a build carrying the markers the labels are never
            // consulted.
            const marked = el.querySelector('[data-testid="confirm-receipt-confirm"]') !== null;
            const isBack = (b) =>
              marked
                ? b?.dataset?.testid === 'confirm-receipt-back'
                : /back/i.test((b?.innerText ?? '').trim());
            const backButton = panelButtons.find(isBack);
            // ROUND 46 P2 — COUNTED, not just found. `find` took the
            // first non-Back button and a second fee-paying action
            // beside it went unexamined — the same rule the outer card
            // already applies to duplicate submit controls, one level
            // in, and the more dangerous level: these buttons send the
            // transaction rather than opening a panel.
            // ROUND 51 P2 — COUNTED VISIBLE, which is what the outer
            // card's duplicate rule has always done and this did not.
            //
            // A cluster holding one usable action beside a button hidden
            // by CSS — responsive variants rendered together is the
            // ordinary way that happens — counted 2 and produced "the
            // lender is given more than one way to pay for it". That is a
            // FALSE FAIL on a correct card, manufactured by the check
            // added to catch a real one, and the false direction is the
            // error this file says gets a whole check switched off.
            //
            // The same reasoning the card count already carries: a
            // duplicate hidden in the DOM is not something the lender is
            // being shown. Selecting from the filtered set too, so the
            // control judged and trialled is one the lender can reach.
            // ROUND 73 P2 — LOCATED WITHOUT BACK WHERE BACK IS GONE.
            //
            // Anchoring the cluster on Back's parent meant a panel that
            // had LOST its Back button reported no action present — so
            // the arm saying "no confirmation action was rendered beside
            // Back" fired on a panel whose fee-paying action was plainly
            // on screen. A true verdict reached through a false sentence,
            // which is the error the `present`/`visible` split above was
            // written to avoid, one level out.
            //
            // The fallback is the confirm pair's own container. Inside
            // this card `.cluster` comes only from `ConfirmReceipt`, and
            // the outer submit is not rendered while the panel is open,
            // so there is nothing else for it to pick up. Back's parent
            // stays the first choice, so a panel with Back behaves
            // exactly as before.
            const cluster = backButton?.parentElement ?? el.querySelector('.cluster');
            // ROUND 75 P2 — EVERY Back, not the one object identity.
            //
            // Excluding `backButton` alone meant a panel rendering TWO
            // visible Back controls and no confirm button recorded the
            // SECOND Back as its fee-paying action: visible, enabled,
            // labelled, and it passes a trial click, so the run reported
            // `confirmScanned` and could pass with no confirmation action
            // on the panel at all. The label is what identifies a Back
            // control, so the label is what has to exclude it — `find`
            // picking one of several is not a licence to treat the rest
            // as something else.
            const allActions = cluster
              ? [...cluster.querySelectorAll('button')].filter((b) => !isBack(b))
              : [];
            const clusterActions = allActions.filter(visible);
            const confirmButton = clusterActions[0];
            const confirmAction = {
              // SELF-REVIEW AFTER ROUND 56 — `present` READS THE
              // UNFILTERED SET, so the two messages stay distinct.
              //
              // Round 51 filtered the cluster by `visible` — correctly,
              // to stop a hidden responsive variant being counted as a
              // second fee-paying action — and computing `present` from
              // the filtered set made `visible` dead: it could only ever
              // be true when `present` was. A confirm button rendered
              // but HIDDEN then reported "no confirmation action was
              // rendered beside Back", which is a true verdict reached
              // through a false sentence, and round 45 gave those two
              // states separate messages deliberately.
              //
              // The count and the selection keep the filtered set, which
              // is what round 51's fix was actually about.
              present: allActions.length > 0,
              visible: confirmButton !== undefined && visible(confirmButton),
              enabled: confirmButton !== undefined && confirmButton.disabled === false,
              labelled:
                confirmButton !== undefined && (confirmButton.innerText ?? '').trim() !== '',
              count: clusterActions.length,
              // ROUND 46 P2 — the index among the CARD's buttons, so the
              // Playwright side can address this exact control for a
              // trial click without a testid and without mutating the
              // page. Same technique as `chosenIndex` and
              // `chosenSubmitIndex`.
              index:
                confirmButton === undefined
                  ? -1
                  : [...el.querySelectorAll('button')].indexOf(confirmButton),
              // AND ITS LABEL, so the Playwright side can CHECK that the
              // index still addresses this control before trialling it.
              //
              // An index is a snapshot of a DOM that the trial then
              // re-queries. If the panel re-rendered in between, `nth(i)`
              // can land on BACK — which is always clickable — and the
              // run would report a broken confirm control as usable. A
              // false pass on the fee-paying button is the exact failure
              // this probe exists to prevent, so the cheap identity check
              // is worth its line.
              label:
                confirmButton === undefined
                  ? null
                  : (confirmButton.innerText ?? '').trim(),
              // SELF-REVIEW AFTER ROUND 46 — IS THE LABEL ACTUALLY
              // PAINTED? `labelled` reads `innerText`, which yields every
              // word regardless of colour, and `visible(confirmButton)`
              // cannot help: `paintsText` deliberately EXEMPTS a node with
              // no own text, because `color` inherits and judging wrappers
              // would condemn whole cards. A button that wraps its label
              // in a span — which is how a button is usually written —
              // is exactly that node, so `color: transparent` on the span
              // left every signal green on a control reading as blank.
              //
              // That is round 37's finding, unfixed for this control. The
              // receipt was given `rowShown`, which descends to the `dt`
              // and `dd` for precisely this reason; the button beside it
              // never got the same treatment. One fix, two sites.
              //
              // `some`, NOT `every`. A visually-hidden span carrying the
              // long form of the label beside a short visible one is
              // ordinary accessible markup, and `every` would condemn it
              // — a false FAIL on a correct button, which is the error
              // this file says gets a check switched off. One painted,
              // readable text leaf is the claim `labelled` should be
              // making, and it is enough to make it.
              //
              // No text-bearing leaf at all yields `true`: an icon-only
              // button is a different defect, and `labelled` reports it.
              labelPainted:
                confirmButton === undefined
                  ? false
                  : (() => {
                      const leaves = [
                        confirmButton,
                        ...confirmButton.querySelectorAll('*'),
                      ].filter((n) =>
                        [...n.childNodes].some(
                          (c) => c.nodeType === 3 && c.textContent.trim() !== '',
                        ),
                      );
                      return leaves.length === 0 || leaves.some((n) => visible(n));
                    })(),
            };
            const rows = [
              ...el.querySelectorAll(
                '[data-testid^="forced-close-receipt"], dl.receipt .receipt-row',
              ),
            ];
            // ROUND 26 P2 — ALL SIX ROWS, not one of them.
            //
            // `some` banked the scan on a single visible row while the
            // other five were hidden, and the whole-card `innerText`
            // still yielded their text — so the amount scan and the
            // receipt-lead check both ran happily over disclosures the
            // lender could not see. The rows that go missing under a
            // partial-hide regression are exactly the ones that matter:
            // "You can lose" and "Fees". Passing a confirmation scan
            // over a hidden fee row is the fund-transparency failure
            // this probe exists to prevent, not a lesser version of it.
            //
            // Six is asserted rather than assumed: `ReviewReceipt`
            // hard-codes six rows in fixed order with no conditionals,
            // and `ReceiptData` makes all six fields required, so a
            // receipt showing fewer is either a product regression or a
            // markup change — and this drive cannot tell those apart
            // from outside. It reports neither: `false` here leaves
            // `confirmText` null and the verdict BLOCKS, which says
            // "the confirmation was not read" rather than inventing a
            // diagnosis. The generic block reason is a known limitation
            // and is not fixed here.
            // ROUND 27 P2 — THE LABEL AND THE VALUE, which is where this
            // stops.
            //
            // A `.receipt-row` is itself a wrapper: it holds a `dt` and a
            // `dd`, and hiding only the `dd`s leaves every row laid out
            // at full height on the strength of its labels. So the
            // lender would read six row headings — "Fees", "You can
            // lose" — with no figure beside any of them, while
            // `innerText` handed the hidden values to the amount scan
            // and this predicate reported six visible rows.
            //
            // That is the same wrapper-is-not-its-contents argument that
            // took the `<dl>`, then the rows, and it terminates here on
            // purpose rather than by exhaustion: `ReviewReceipt` renders
            // `<dt>{label}</dt><dd>{value}</dd>` with plain strings, so
            // `dt` and `dd` are the text-bearing LEAVES — there is no
            // further container beneath them to be fooled by. Checking
            // the leaves is the level at which the content actually
            // lives, and the recursion has a bottom.
            //
            // Emptiness needs no separate test: `visible` requires a
            // non-zero rect, and a `dd` with no content collapses to
            // zero height, so a blank value fails on geometry.
            // ROUND 40 P2 — A LEAF MUST CARRY TEXT, not merely occupy
            // space. `paintsText` deliberately passes a node with no own
            // text (colour inherits, so judging wrappers would condemn a
            // whole card) — and that exemption reaches the receipt's
            // LEAVES, which are the one place a node without text is
            // itself the defect.
            //
            // `.receipt-row dt` is `width: 118px; flex-shrink: 0` and a
            // flex item, so an EMPTY label keeps its full width and
            // stretches to the value's height: non-zero rect,
            // `checkVisibility` positive, clipping walk clean, paint
            // check exempt. Six rows of unlabelled figures would have
            // recorded `confirmScanned=true` — a lender shown amounts
            // with nothing saying which is the fee and which is the loss.
            //
            // Asserted HERE rather than inside `visible`, deliberately.
            // "Must contain text" is true of a receipt leaf and false of
            // the card, the body wrapper and the submit control, so
            // pushing it into the shared predicate would condemn nodes
            // that are correct.
            // A block body rather than a concise one, deliberately:
            // `31-observer-visibility.spec.ts` extracts these helpers
            // from this source by brace-matching, and a concise arrow is
            // invisible to it. Writing it the short way silently left the
            // spec unable to inject it — which the spec caught, because
            // it asserts it found exactly one.
            // ROUND 62 P2 — THE TEXT THE LENDER CAN ACTUALLY READ, which
            // is not what `innerText` reports.
            //
            // `hasText` asked `innerText` of the `dt`/`dd` WRAPPER, and
            // `visible` on a wrapper is deliberately lenient: `paintsText`
            // exempts an element with no own text, and the opacity, filter
            // and clip rules look at the element and its ANCESTORS. So
            // `<dt><span style="color: transparent">Fees</span></dt>` keeps
            // its geometry, passes `visible`, and `innerText` still yields
            // "Fees". All six rows could satisfy `rowsOk` with not one of
            // them painted — a funds receipt substantiated by text nobody
            // can see, on the panel that spends the lender's money.
            //
            // Same defect as round 61's body, at the site round 61 cited as
            // already doing it right. It was right about DESCENDING to the
            // `dt`/`dd`; it stopped one level short of their content.
            // Eighth instance on this PR of a fix applied to one of several
            // parallel sites, and the first where the earlier fix's own
            // comment named this site as the example to follow.
            //
            // Collected by walking TEXT NODES and keeping those whose
            // element chain is visible, rather than by collecting "leaf
            // elements": a parent with its own text beside a child with
            // more would be counted twice by the latter, and the text is
            // what the caller needs anyway.
            //
            // Joined with NOTHING and then whitespace-collapsed. A space
            // between every text node would split `<b>Loan</b>s` into
            // "Loan s", and this string is compared against shipped copy
            // with `includes`.
            const visibleTextOf = (root) => {
              if (root === null) return '';
              // THE ROOT'S OWN VISIBILITY FIRST. A text node directly
              // under a hidden root would otherwise be collected — the
              // walk only judges elements it DESCENDS INTO — so a body
              // erased at its own level still reported its sentence as
              // painted. Every caller happens to check the root already,
              // which is exactly why this would have gone unnoticed: the
              // helper's own answer was wrong while every use of it was
              // right. Found by self-review.
              if (!shownBox(root)) return '';
              const unpainted = /^(script|style|template|title|noscript)$/i;
              const parts = [];
              // ROUND 66 P2 — AN ELEMENT'S OWN TEXT AND ITS SUBTREE ARE JUDGED
              // SEPARATELY.
              //
              // `paintsText` gates only the element's OWN text nodes, because
              // `color` inherits and a descendant may repaint itself. Descent
              // is gated on `shownBox` alone: a container whose own text is
              // transparent still SHOWS a child that sets its own colour, and
              // gating descent on the full `visible` discarded that child — a
              // product FAIL on a card whose explanation is painted, which is
              // the direction this file refuses everywhere else.
              // ROUND 74 P2 — RENDERED LINE BOUNDARIES SURVIVE THE WALK.
              //
              // `innerText` inserts a newline between rendered blocks, and round 24
              // made that newline a CLAUSE BOUNDARY: `Wait 3 days` above `USDC is
              // returned later` is two rows, so the ticker is not near the duration.
              // Round 66 moved the scans onto this painted walk and joined every
              // text node with nothing, which silently deleted that boundary — so
              // correct copy on two lines read as one clause and the amount scanner
              // emitted an observed funds FAIL on an allowed grace duration. A false
              // FAIL on funds copy, introduced by the fix that made the reading
              // honest.
              //
              // A newline is emitted around a child that BREAKS THE LINE and never
              // around an inline one, which is what keeps round 66's other rule
              // intact: `<b>Loan</b>s` must not become `Loan s`. `inline-block` and
              // `contents` do not break, matching what `innerText` does; `<br>` does,
              // unless it is display:none.
              const breaksLine = (el, prev) => {
                const d = getComputedStyle(el).display;
                if (d === 'contents' || d.startsWith('inline') || d.startsWith('ruby')) return false;
                if (!prev) return true;
                const a = el.getBoundingClientRect();
                const b = prev.getBoundingClientRect();
                if (a.height === 0 || b.height === 0) return true;
                return !(a.top < b.bottom && b.top < a.bottom);
              };
              let prevBox = null;
              const walk = (node) => {
                const ownPainted = paintsText(node);
                for (const child of node.childNodes) {
                  if (child.nodeType === 3) {
                    if (ownPainted) parts.push(child.textContent.replace(/\s+/g, ' '));
                  } else if (child.nodeType === 1) {
                    if (unpainted.test(child.tagName)) continue;
                    if (child.tagName === 'BR') {
                      if (getComputedStyle(child).display !== 'none') parts.push('\n');
                      continue;
                    }
                    if (!shownBox(child)) continue;
                    const boundary = breaksLine(child, prevBox);
                    if (boundary) parts.push('\n');
                    prevBox = child;
                    walk(child);
                  }
                }
              };
              walk(root);
              // Horizontal whitespace collapses; the deliberate breaks do not.
              return parts
                .join('')
                .replace(/[^\S\n]+/g, ' ')
                .replace(/[^\S\n]*\n[\s]*/g, '\n')
                .trim();
            };
            const rowShown = (row) => {
              if (!visible(row)) return false;
              const dt = row.querySelector('dt');
              const dd = row.querySelector('dd');
              if (dt === null || dd === null) return false;
              if (!visible(dt) || !visible(dd)) return false;
              return visibleTextOf(dt) !== '' && visibleTextOf(dd) !== '';
            };
            // An OBJECT now, not a boolean: the caller needs the
            // confirm-action facts as well as whether the rows read.
            //
            // ROUND 50 P2 — AND THE TEXT OF THE ROWS THAT WERE READABLE.
            //
            // `rowsOk` is all-or-nothing by design, and the caller used
            // it to decide whether to take the card's text at all. So one
            // row missing, hidden or clipped threw away the text of the
            // five on screen, and an invented amount stated in one of
            // THOSE was reported as an incomplete reading rather than as
            // the product failure it is.
            //
            // Each readable row is carried SEPARATELY rather than joined:
            // round 35 established that joining renders lets one supply
            // context for another's digits, and the scanner's exemptions
            // are all context.
            const shown = rows.filter(rowShown);
            // ROUND 53 P2 — AND EVERYTHING ELSE ON THE PANEL THAT IS
            // VISIBLE, which round 50's fix left behind.
            //
            // Carrying only the readable ROWS still discarded every other
            // visible region of the confirmation whenever one row failed:
            // a warning banner, a gas note, the confirm control's own
            // label. `Confirm 100 USDC` beside five readable rows and one
            // hidden row was reported as an incomplete reading rather
            // than as the invented figure it is. Half the fix, again.
            //
            // Own-text nodes only, and each carried SEPARATELY: `visible`
            // is the drive's full predicate, and joining renders is what
            // round 35 forbids because every exemption in the scanner is
            // context.
            // ROUND 60 P2 — EXCLUDE THE ROWS ALREADY CARRIED, not every
            // row.
            //
            // Excluding membership in ANY receipt row dropped the
            // visible leaves of rows that failed `rowShown`. A row whose
            // LABEL is hidden or clipped while its value is on screen
            // stating `100 USDC` was therefore removed from `rowsText`
            // (the row failed) and from `otherText` (it is in a row) —
            // and `rowsOk` then made `confirmText` null, so the figure
            // reached no scan at all and the visit reported merely an
            // incomplete observation.
            //
            // `shown` is what is already carried, so it is what must be
            // excluded. Everything else visible on the panel, wherever
            // it sits, is scanned — which is what round 53's
            // whole-panel fix was for, one level finer.
            const inRow = (n) => shown.some((r) => r === n || r.contains(n));
            const otherText = [...el.querySelectorAll('*')]
              .filter(
                (n) =>
                  !inRow(n) &&
                  [...n.childNodes].some(
                    (c) => c.nodeType === 3 && c.textContent.trim() !== '',
                  ) &&
                  visible(n),
              )
              .map((n) => visibleTextOf(n))
              .filter((t) => t.trim() !== '');
            return {
              rowsOk: rows.length === 6 && shown.length === rows.length,
              confirmAction,
              // SEPARATE from `otherText`, deliberately: the amount scan
              // wants both, and the row-identity check (round 53) wants
              // the rows alone. Merging them would make "six rows" mean
              // "six of anything on the panel".
              //
              // ROUND 63 P2 — THE PAINTED TEXT, not `innerText`, and the
              // previous round computed it and threw it away.
              //
              // `rowShown` used `visibleTextOf` as a BOOLEAN and this
              // projection then recorded the row's raw `innerText`. A row
              // carrying painted filler beside an erased label or value
              // therefore passed the readability test AND supplied the
              // expected disclosure from text nobody can see — all six
              // pairs satisfied, `confirmScanned=true`, while the lender
              // reads filler instead of what the receipt must disclose.
              //
              // Ninth instance on this PR of a fix reaching one of
              // several parallel sites, and a new variant of it: the
              // right value was computed at the right moment and
              // discarded one line later.
              // ROUND 68 P2 — WAS THE PANEL STILL THERE in this same pass?
              //
              // `ForcedCloseCard` legitimately removes the whole
              // `ConfirmReceipt` when readiness changes after the panel
              // opened — paused, sequencer-blocked, otherwise withheld —
              // while keeping the outer card mounted. This evaluate then
              // finds no actions and reports `present: false`, which the
              // hoisted structural arm reads as "the confirmation opened
              // but no action was rendered beside Back": a product FAIL
              // invented out of a legitimate cross-render change, since
              // no atomic snapshot ever saw an open panel missing its
              // action.
              //
              // Recorded IN THIS PASS rather than inferred afterwards,
              // which is the whole point — the fault and its excuse have
              // to come from one DOM read or the comparison is between
              // two different moments (round 9's rule).
              //
              // ROUND 69 P2 — DERIVED FROM THE PANEL, not from its rows.
              //
              // `rows.length > 0` conflated "the panel is gone" with
              // "the panel is there and broken". A confirmation still
              // visibly open on its Back button, with both the receipt
              // rows and the action removed, reported `panelPresent:
              // false` — and the guard above then read a directly
              // observed broken funds confirmation as an explained
              // removal, downgrading it to incomplete. My own round-68
              // fix, over-reaching by one case.
              //
              // The Back control is the panel: it is what this pass
              // already located to anchor the action cluster, it is
              // rendered for every confirmation state, and it survives
              // exactly the regression that removes everything else.
              // Rows are CONTENT, and content going missing is the
              // defect rather than the excuse for it.
              //
              // ROUND 70 P2 — EITHER MARKER. Back-only conflated "no Back
              // control" with "no panel", which is round 69's own
              // correction by the opposite door: the rows are the other
              // half of the evidence and they fail independently.
              panelPresent:
                (backButton !== undefined && visible(backButton)) || rows.length > 0,
              rowsText: shown.map((r) => visibleTextOf(r)).filter((t) => t.trim() !== ''),
              otherText,
              // ROUND 64 P2 — the WHOLE panel's painted text, carried
              // beside the raw `confirmText` rather than replacing it.
              //
              // `confirmText` has one other job — it is what
              // `confirmScanned` is derived from and what says the
              // receipt was COMPLETELY covered — so swapping it would
              // change two meanings to fix one. This is the scanned
              // text; that stays the coverage fact.
              panelText: visibleTextOf(el),
            };
          })
          .catch(() => null);
        confirmText = receiptShown?.rowsOk
          ? await card.innerText({ timeout: 2_000 }).catch(() => null)
          : null;
        confirmVisibleText = receiptShown?.rowsOk ? (receiptShown.panelText ?? null) : null;
        confirmAction = receiptShown?.confirmAction;
        if (confirmAction) confirmAction.panelPresent = receiptShown?.panelPresent;
        // ROUND 50 P2 — kept whatever `rowsOk` decided, so a figure on a
        // row the lender COULD see is scanned even when a different row
        // was unreadable.
        confirmRowsText = receiptShown?.rowsText ?? null;
        // ROUND 53 P2 — the panel's OTHER visible text, carried beside
        // the rows rather than inside them: the amount scan wants both,
        // the row-identity check wants the rows alone.
        confirmOtherText = receiptShown?.otherText ?? null;
        // ROUND 46 P2 — CAN IT ACTUALLY RECEIVE A CLICK?
        //
        // Geometrically visible, natively enabled and labelled is not
        // the same as actionable: an element covering it, or
        // `pointer-events: none`, leaves every one of those true while
        // the lender cannot activate it — and the run reports the route
        // as covered.
        //
        // Playwright's `trial: true` runs the full actionability suite
        // (visible, stable, receives events, enabled) and returns
        // WITHOUT dispatching the click. That is what makes it usable
        // here at all: this drive is watch-only and the real click sends
        // a fee-paying transaction.
        //
        // AND IT IS TRIALLED ONLY IF THE INDEX STILL ADDRESSES IT. The
        // index came from a snapshot; the trial re-queries the DOM. A
        // re-render in between can leave `nth(i)` on BACK, which is
        // always clickable — so a broken confirm control would be
        // reported as usable. The label is re-read and compared first.
        //
        // THREE OUTCOMES, ALL THREE WRITTEN (round 47 P2). `true` and
        // `false` are the trial's verdict; `null` is "this run did not
        // test it", which happens when the re-read label does not match
        // the control the snapshot described.
        //
        // Writing `null` rather than leaving the field absent is the
        // whole point. Absent has to keep meaning "a record predating
        // this field", so that an older observation is not accused of a
        // gap it could not have filled — but that made the CURRENT
        // untested case indistinguishable from it, and the verdict then
        // passed a lender run that had never established the fee-paying
        // action was usable. The drive knows which case it is in, so it
        // says so, and the verdict reports an untested confirmation as
        // an incomplete observation rather than as a success.
        //
        // Assigned on every path below, unconditionally, for the reason
        // this file keeps relearning: a field written at some exits and
        // not others is how `visibleSubmits` went missing twice.
        // Either marker proves the panel, matching the detection gate
        // above rather than inventing a second notion of "still open".
        const panelStillUp = async () => {
          const [rows, action] = await Promise.all([
            card
              .locator('[data-testid^="forced-close-receipt"], dl.receipt .receipt-row')
              .count()
              .catch(() => 0),
            card.locator('.cluster button').count().catch(() => 0),
          ]);
          return rows > 0 || action > 0;
        };

        if (confirmAction) {
          if (confirmAction.index >= 0) {
            const target = card.locator('button').nth(confirmAction.index);
            const labelNow = await target
              .innerText({ timeout: 2_000 })
              .then((t) => t.trim())
              .catch(() => null);
            // ROUND 76 P2 — AND A WITHDRAWN PANEL IS NOT AN UNUSABLE
            // CONTROL, here as well as on Back.
            //
            // The label re-read protects the identity of the control; it
            // does not survive the panel going away DURING the trial,
            // which `ForcedCloseCard` is explicitly allowed to do when
            // readiness changes. The detached locator then rejects and
            // this recorded `false` — an unusable fee-paying action, from
            // a render that never existed. Round 75 fixed exactly this on
            // the Back control and left its sibling, which is this PR's
            // most frequent finding once more.
            if (labelNow === null || labelNow !== confirmAction.label) {
              confirmAction.clickable = null;
            } else {
              const trialled = await target
                .click({ trial: true, timeout: 3_000 })
                .then(() => true)
                .catch(() => false);
              confirmAction.clickable = trialled ? true : (await panelStillUp()) ? false : null;
            }
          } else {
            // No control to trial. The verdict FAILS this above on
            // `present`, so this is unreachable on the passing path —
            // written anyway so the field's meaning does not depend on
            // which arm ran.
            confirmAction.clickable = null;
          }
        }
        // ROUND 65 P2 — AND WHETHER THE LENDER CAN CANCEL.
        //
        // This click's failure was swallowed whole and recorded nothing,
        // so a Back control that is permanently covered or carries
        // `pointer-events: none` left the receipt and the confirm action
        // scanning clean — and the verdict passed a confirmation the
        // lender cannot back out of without leaving the page. On a
        // pre-signature panel that is the one control whose whole job is
        // to let them not spend money.
        //
        // TRIALLED, not inferred from the real click. The real click is
        // needed anyway to restore the page, but its failure is
        // ambiguous: a panel that closed on its own re-render fails it
        // exactly as an unreachable control does. `trial: true` runs the
        // full actionability suite — visible, stable, receives events,
        // enabled — without dispatching, and is taken while the panel is
        // demonstrably still open.
        //
        // THREE OUTCOMES, ALL WRITTEN, the same discipline
        // `confirmAction.clickable` carries since round 47: `true` /
        // `false` are the trial's verdict and `null` is "this run did not
        // establish it". `undefined` has to keep meaning "a record
        // predating this field", so the current run must never produce
        // it.
        // ROUND 75 P2 — AND THE PANEL HAS TO STILL BE THERE.
        //
        // `confirmAction` comes from the receipt evaluation; these two
        // facts were taken in a LATER pass. `ForcedCloseCard` is
        // explicitly allowed to withdraw the whole confirmation when
        // readiness changes, so a panel that closed in between recorded
        // `confirmAction.present: true` beside `backAction.present:
        // false` — and the missing-Back arm reported a lender trapped on
        // a panel, from two facts no single render ever showed together.
        // The same race turns a trial rejection into "the control is
        // unusable" when what actually happened is that it went away with
        // everything else.
        //
        // So absence and a failed trial are only believed while the panel
        // is demonstrably still up. Otherwise they are `null` — this run
        // did not establish it — which is the third outcome the
        // `confirmAction` trial has carried since round 47, for the same
        // reason.
        //
        const backCount = await back.count().catch(() => 0);
        backAction = {
          present: backCount > 0 ? true : (await panelStillUp()) ? false : null,
          clickable: null,
        };
        if (backAction.present) {
          const trialled = await back
            .click({ trial: true, timeout: 3_000 })
            .then(() => true)
            .catch(() => false);
          backAction.clickable = trialled ? true : (await panelStillUp()) ? false : null;
          // ROUND 68 P2 — AND IS IT PAINTED?
          //
          // Playwright's actionability suite does not consider ancestor
          // opacity — `31-observer-visibility.spec.ts` exists because
          // this drive's predicate and Playwright's disagree on exactly
          // that — so a Back button under `opacity: 0`, or with
          // transparent label text, still accepts a trial click and the
          // confirmation passed with no cancel control the lender can
          // SEE. The two fee-paying controls have carried painted
          // evidence since rounds 46 and 54; the one control that exists
          // to stop a payment had none.
          //
          // `visible` for the button itself and the leaf rule for its
          // label, mirroring `submitLabelPainted` exactly rather than
          // inventing a second way to ask the same question.
          backAction.painted = await back
            .evaluate((el, [clipSrc, paintSrc, boxSrc, visSrc]) => {
              const scope = new Function(
                `${clipSrc}\n${paintSrc}\n${boxSrc}\n${visSrc}\nreturn { visible, paintsText };`,
              )();
              if (!scope.visible(el)) return false;
              const leaves = [el, ...el.querySelectorAll('*')].filter((n) =>
                [...n.childNodes].some(
                  (c) => c.nodeType === 3 && c.textContent.trim() !== '',
                ),
              );
              return leaves.length === 0 || leaves.some((n) => scope.visible(n));
            }, VISIBILITY_HELPER_SOURCES)
            .catch(() => null);
        }
        // Leave the page as it was found. Failing to close it is not a
        // finding and must not fail the drive.
        await back.click({ timeout: 3_000 }).catch(() => {});
      }
    }
  }
  return {
    // Everything the DOM pass observed, whatever it observed — see the
    // note above the spread's twin at the top of this block.
    ...snap,
    mounted: true,
    attached: true,
    confirmText,
    confirmVisibleText,
    confirmAction,
    // ROUND 65 P2 — the CANCEL control, judged like the confirm one.
    backAction,
    confirmExpected,
    // ROUND 50 P2 — whether the OUTER submit could take a click. Carried
    // so an unreachable control is reported as the defect it is rather
    // than as an unread confirmation.
    submitClickable,
    confirmRowsText,
    confirmOtherText,
    settled,
    // Every render read during the readiness wait, including the ones
    // the poll superseded (round 31 P2).
    seenTexts,
    seenVisibleTexts,
    seenRenders,
    // ROUND 35 P2 — travels with `seenTexts`, and for the same reason:
    // both are things this drive SAW, and the settled snapshot is not a
    // record of what it saw.
    visibleCardsPeak,
    visibleSubmitsPeak,
    bodyHiddenSeen,
  };
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
     *  This is called once before the probe, once per poll iteration
     *  and once after, so on the page it exists for — the one where
     *  the scrape saw no card — it could spend minutes and the 1s poll
     *  cadence never happened. The 45s deadline the drive advertises
     *  was being blown by the code that reports on it.
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
      // `app.mode`, so once any page in this shared browser context
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
// WHICH CANDIDATES GO FIRST — the three bands, their history and the
// reasoning are in `walkOrder.mjs`, where they are a pure function with
// tests rather than three comment blocks around one expression. This file
// supplies the ANSWERS and does the asking.
//
// Round 74 added no band. It moved WHERE the answers are resolved, which
// is this file's business and not that module's — so the two are counted
// differently on purpose, and neither is a stale copy of the other.
//
// BOTH answers are resolved once, above the authority choice, so the walk
// consumes exactly what the choice did rather than asking again against a
// different candidate set. Round 74 moved `acceptsCloseOut` up there for
// the reason `acceptedSale` was moved before it: a ranking applied only
// to the selected authority's loans cannot recover a better candidate one
// authority away.
const readyFirst = walkOrderFor({
  loans: mine,
  role: ROLE,
  activeStatus: STATUS_ACTIVE,
  acceptedSale,
  acceptsCloseOut,
});
if (acceptsCloseOut.size > 0) {
  // ROUND 79 P2 — SAY WHAT THIS RUN ACTUALLY DID.
  //
  // The message claimed the probe ran "across every authority" and
  // decided "which lender is observed". Once `OBSERVE_ADDRESS` narrows
  // the pre-pass (round 78) both claims are false in that mode: the
  // lender was fixed by the override before any probing, and only that
  // lender's loans were probed. A run report that overstates what it
  // covered is the same defect as a verdict that does, one layer out.
  const scoped = process.env.OBSERVE_ADDRESS !== undefined;
  console.log(
    `\nresolved close-out capability on ${acceptsCloseOut.size} position(s)` +
      (scoped
        ? ` held by the requested lender` +
          `\n  → the lender was fixed by OBSERVE_ADDRESS, so this decides the visit ORDER only.`
        : ` across every authority` +
          `\n  → this decides both which lender is observed and, within that lender, the visit order.`) +
      `\n  → ${mine.length} eligible loan(s) here against a cap of ${MAX_POSITIONS}, so the order decides ` +
      `whether the confirmation can be scanned at all.` +
      `\n  → ordering only: the protocol accepting is not the card offering it, and no verdict reads this.`,
  );
}

// Scoped to the OBSERVED authority's own loans. `acceptedSale` is now
// resolved across every authority so the choice above can use it, and
// naming its whole contents here would report positions this walk was
// never going to visit as though they had been passed over in it.
const demoted = mine.filter((l) => acceptedSale.has(l.id)).map((l) => l.id);
if (demoted.length > 0) {
  console.log(
    `\ndeprioritised ${demoted.length} Active position(s) with an accepted sale ` +
      `awaiting completion: ${demoted.join(', ')}` +
      `\n  → the card is correctly unmounted there, so they cannot exercise it.`,
  );
}
for (const l of readyFirst) {
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
          (v.advancedJumps ? '' : `\n      sell-now row: ${v.sellNowText ?? '-'}\n      listing row: ${v.listText ?? '-'}`) +
          // Printed on EVERY lender detail visit, including a blocked
          // one. A verdict that only appears when it fails leaves the
          // reader unable to tell "checked and fine" from "never
          // looked" — which is the distinction this whole drive is
          // built around.
          (v.forcedCloseVerdict
            ? `\n      forced-close: ${v.forcedCloseVerdict.verdict}` +
              ` (${v.forcedCloseVerdict.why})` +
              (v.forcedCloseVerdict.verdict === 'pass'
                ? ` checkRunning=${v.forcedCloseVerdict.checkRunning}` +
                  // Whether the pre-sign confirmation was opened and
                  // scanned. Printed because the no-amount claim covers
                  // that panel too, and a reader has no other way to
                  // tell a card-only scan from a full one.
                  ` confirmScanned=${v.forcedCloseVerdict.confirmScanned}` +
                  // ROUND 27 — the CONTROL COUNT, printed on every pass.
                  //
                  // Not decoration. This field has now been dropped in
                  // the projection between the DOM pass and the verdict
                  // twice, and both times a green unit suite and a clean
                  // live run said nothing, because the verdict's tests
                  // feed it constructed records and the drive never
                  // showed what it actually carried. The spread above
                  // stops the drop; this makes the carriage OBSERVABLE,
                  // so a future silent regression to `undefined` is
                  // visible in the run output instead of waiting for a
                  // reviewer to read the projection.
                  ` submits=${v.forcedCloseVerdict.visibleSubmits}` +
                  // ROUND 36, SELF-REVIEW — and the CARD PEAK beside it.
                  //
                  // `visibleCardsPeak` is carried by hand at three exits
                  // rather than through the snapshot spread, which is
                  // precisely the arrangement that lost `visibleSubmits`
                  // twice. Printing it is the remedy round 27 settled
                  // on: the carriage becomes observable in the run
                  // output instead of resting on a reviewer having read
                  // all three sites.
                  ` peak=${v.forcedCloseVerdict.visibleCardsPeak}` +
                  // ROUND 39 — and the CONTROL peak beside the card one.
                  // Both are carried by hand at three exits rather than
                  // through the snapshot spread, so both need round 27's
                  // remedy: a regression to `undefined` at any one of
                  // those sites shows in the output instead of passing
                  // confidently. I claimed on the review thread that this
                  // was printed before it was; it is now.
                  ` submitPeak=${v.forcedCloseVerdict.visibleSubmitsPeak}` +
                  // SELF-REVIEW AFTER ROUND 46 — and WHETHER THE TRIAL
                  // CLICK RAN, since round 47 left exactly one value
                  // here that should never be seen. An untested action
                  // is BLOCKED, so a pass can only carry `yes`; an
                  // `unrecorded` on a current run means the assignment
                  // went missing, which is round 27's remedy for a field
                  // carried by hand — print it rather than pass
                  // confidently.
                  // SELF-REVIEW AFTER ROUND 50 — and HOW MANY RENDERS
                  // the unsafe-render arm actually had to judge. An
                  // empty `seenRenders` scans nothing and passes exactly
                  // like a clean scan, which is round 27's lesson about
                  // `visibleSubmits` in a new place.
                  ` renders=${v.forcedCloseVerdict.rendersJudged}` +
                  ` confirmClickable=${
                    v.forcedCloseVerdict.confirmClickable === undefined
                      ? 'unrecorded'
                      : v.forcedCloseVerdict.confirmClickable
                        ? 'yes'
                        : 'no'
                  }` +
                  // ROUND 64 P2 — and whether the settlement-route check
                  // could fire at all. A route the drive could not read
                  // makes that arm silent, and a silent arm passes
                  // exactly like a satisfied one.
                  ` route=${v.forcedCloseVerdict.routeKnown ? 'checked' : 'unread'}`
                : '') +
              // ROUND 14 — WHETHER THE ABSENCE GATE COULD HAVE FIRED.
              //
              // The gate now requires this observer to have caught up
              // with the head the PAGE was seen to know, and an
              // unobserved page head is deliberately not-ready — so a
              // deployment whose RPC traffic this drive cannot read
              // would report every absence as incomplete and never
              // FAIL. That is the safe direction, but it must not be
              // SILENT: printed on every visit so a reader can tell a
              // gate that is armed from one that structurally cannot
              // fire.
              ` heads=${v.forcedCloseHeadFloor ?? 'unobserved'}..${v.forcedClosePageHead ?? 'unobserved'}`
            : '')
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
// ROUND 38 P2 — A FUNDS DEFECT ALREADY SEEN OUTRANKS EVERY
// INFRASTRUCTURE BLOCKER BELOW IT.
//
// `failures` is consulted at the very end, after the route, WebSocket
// and wrong-chain gates have each had a chance to exit 2. So a card
// POSITIVELY OBSERVED stating an amount it cannot know — the one
// absolute claim this drive makes — was reported as BLOCKED whenever any
// unrelated request failed, or whenever the deployment happens to use
// WebSocket RPC at all. The batch reads that as "nothing was learned",
// and the finding disappears into a re-run.
//
// This is the SAME rule `forcedCloseVerdict` applies five times inside a
// single visit — a definite observation outranks an uncertain one — and
// it was missing from the one place that decides what the run actually
// reports. Those blockers are all statements about what could NOT be
// established; none of them unsees a rendered card.
//
// Scoped to forced-close FAILs rather than to `failures` as a whole,
// deliberately. The other verdicts in `problems` include absence
// findings, and an absence is exactly the kind of conclusion a
// transport failure or an unobservable socket read legitimately
// undermines. What is carried past them is content that was READ.
//
// ROUND 39 P2 — `failKind === 'observed'`, AND THE ROUND-38 VERSION OF
// THIS FILTER DID THE OPPOSITE OF WHAT ITS OWN COMMENT PROMISED.
//
// The paragraph above says absence findings must stay behind these gates
// because a transport failure legitimately explains a missing surface.
// The filter was `verdict === 'fail'`, which includes the two ABSENCE
// arms — so a route failure or a wrong-chain page endpoint could remove
// the card, the observer's own chain would still report the position
// eligible, and the run would exit 1 accusing the product before the
// gate that explains it ever ran. The principle was stated correctly and
// implemented backwards in the same commit.
//
// The verdict now says which kind each failure is, rather than this
// filter guessing from the `why` string. Every arm is tagged
// explicitly — not defaulted — so a fail added later has to state
// whether it was READ or INFERRED instead of inheriting whichever
// default happened to be there.
// ROUND 79 P2 — AND THE PROMOTION COVERS EVERY DEFECT THE SURFACE ITSELF
// SHOWED, not only the forced-close card's.
//
// Round 78 tagged each problem `observed` or `absence`, and used the tags
// only at the unknown-chain gate. So a dead Advanced anchor or a
// mis-ordered row — read off a page that rendered — was still swallowed
// by the route, WebSocket, wrong-chain and allowlist blockers as "nothing
// was learned", which is round 38's finding surviving in every guard it
// was not applied to.
//
// NOT EVERY `observed` TAG IS PROMOTED, and the line is deliberate rather
// than convenient. `kind` answers "could an unknown CHAIN explain this";
// `blockable` answers the harder "could a blocked REQUEST explain this",
// and both are now stated at the problem's own site. Those differ:
//
//   promoted   a dead jump anchor, a mis-ordered row, and the card's own
//              observed findings — DOM facts about a page that rendered.
//              Both are structurally immune to a missing read rather than
//              merely unlikely to be caused by one, which is what makes
//              the promotion safe and is worth stating since the gate
//              rests on it: `waitFirst` is reported as `null` and never
//              `false` when a row it needs is absent, so a blocked read
//              cannot manufacture an ordering defect; and an
//              `advancedAnchors` entry exists only because its jump
//              BUTTON rendered, and the button and its target section
//              come from the same component, so missing data removes the
//              entry rather than breaking the link.
//   not        a hooks-order crash, an uncaught page error, a nav failure
//              or a non-2xx. Every one of those is a plausible CONSEQUENCE
//              of the drive's own allowlist refusing a request, and round
//              69 added the allowlist gate precisely because this drive
//              can break the page it is judging. Promoting them would
//              blame the product for the harness.
//
// So the residual is a real defect reported as BLOCKED on a run that also
// had a transport failure — loud, re-runnable, and the direction this
// file chooses every time.
//
// SELF-REVIEW — READ OFF THE TAG, NOT THE MESSAGE. The first version of
// this filter was a regex over the `why` string, written thirty lines
// below the paragraph above that says the verdict must state its own kind
// "rather than this filter guessing from the `why` string", and that
// every arm must tag itself "instead of inheriting whichever default
// happened to be there". A reworded message would have silently dropped
// out of the promotion, and a new arm would have defaulted to unpromoted
// with nothing to notice it.
const observedNow = visited.flatMap((v) =>
  visitProblemKinds(v, ROLE)
    .filter((pr) => pr.blockable === false)
    .map((pr) => ({ path: v.path, why: pr.why })),
);
if (observedNow.length) {
  console.log(
    `\n${observedNow.length} defect(s) were READ off a page that rendered.` +
      ` Reported ahead of any infrastructure blocker, for the reason the` +
      ` forced-close findings are: a blocked request does not reorder` +
      ` static markup or rebind a control to another anchor.`,
  );
  observedNow.forEach(({ path, why }) => console.log(`  ${path}: ${why}`));
  process.exit(1);
}
// ROUND 82 P3 — THE FORCED-CLOSE EXIT USED TO BE WRITTEN TWICE HERE, and
// the second copy was unreachable.
//
// An observed forced-close failure already arrives through the block
// above: `visitProblemList` reads the card's own `failKind` and pushes it
// with `blockable: false`, which is exactly what `observedNow` selects,
// so the process had always exited before the duplicate could run. The
// only shapes that reach neither are a nav failure and a non-detail path
// — and `observeForcedClose` runs only for a detail path with a loan, and
// a nav failure returns before the card is ever scraped, so no such
// record carries a verdict at all.
//
// Two implementations of one exit policy, with two different operator
// messages, is the drift this file has been caught on repeatedly; the
// dead copy is the one a future change would have edited. The shared path
// keeps the ordering argument and prints the same evidence, prefixed
// `forced-close card:` by the producer.
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
// ROUND 77 P2 — AND AN UNANSWERABLE PROBE IS NOT AN ACCEPTABLE ONE.
//
// `served === null` means the synthetic `eth_chainId` was refused, timed
// out or came back unreadable — not that the endpoint serves the right
// chain. Treating it as acceptable let the whole point of this gate
// escape in the case it was written for: with a deterministic deploy
// putting a Diamond at the same address on two networks, ordinary reads
// and heads still answer, so a missing card or a route disagreement
// against `OBSERVE_RPC` passed every infrastructure gate and exited 1 as
// a product regression while the page's chain had never been
// established.
//
// Same three-way discipline as everything else here: answered-and-wrong,
// answered-and-right, and could-not-ask are three outcomes, and the
// third asserts nothing.
const pageChainUnknown = [];
for (const [url, probe] of pageRpcChain) {
  // ROUND 79 P2 — TWO SOURCES THAT DISAGREE ESTABLISH NOTHING.
  //
  // Round 78 preferred the synthetic probe and fell back to the page's
  // own traffic, which quietly discarded a CONTRADICTION: a synthetic
  // reply of the expected chain beside captured traffic reporting another
  // one was accepted, and an inferred missing-surface finding could then
  // exit 1 against the product on an endpoint that had contradicted
  // itself. Round 52 settled this for one batch — an endpoint giving two
  // answers can be relied on for neither — and the rule does not weaken
  // because the two answers arrived through different doors.
  //
  // So: agree, or one source alone, establishes the chain. Disagreement,
  // and a self-contradicting capture, are UNKNOWN — which the gate below
  // already treats as a reason to withhold an inference rather than to
  // accuse the page.
  const synthetic = await probe;
  const captured = observedPageChain.get(url);
  const conflicted =
    captured === CHAIN_ID_CONFLICT ||
    (synthetic !== null && captured !== undefined && synthetic !== captured);
  const served = conflicted ? null : (synthetic ?? captured ?? null);
  if (served === null) {
    pageChainUnknown.push(redact(url).slice(0, 120));
  } else if (served !== CHAIN_ID) {
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
// ROUND 69 P2 — THIS DRIVE'S OWN ALLOWLIST COMES BEFORE BLAMING THE APP.
//
// The route handler deliberately aborts a read method it does not
// allowlist, which can make the card or the chooser appear absent. The
// forced-close filter above already defers the resulting INFERRED
// failure for exactly that reason — and then the generic exit below ran
// first anyway, so the drive exited 1 against the product when its own
// allowlist had stopped the page loading.
//
// Placed AFTER the observed-findings exit and BEFORE this one, which is
// the whole ranking: content that was READ outranks any blocker, and a
// blocker outranks a conclusion INFERRED from an absence the blocker
// could have caused.
if (allowlistTooNarrow.length || httpGaps.length) {
  console.log(
    `\n  → ranked ahead of the inferred failures below: this drive's own` +
      ` request allowlist stopped the page loading, so anything missing` +
      ` says nothing about the app.`,
  );
  process.exit(2);
}
// ROUND 77 P2 — AND AN UNESTABLISHED PAGE CHAIN OUTRANKS AN INFERENCE.
//
// Placed exactly where the allowlist gate is and for the same reason: a
// conclusion INFERRED from an absence must not outrank a precondition
// this run never established. If the page's own endpoint would not say
// which chain it serves, "the card is missing" and "the route disagrees"
// are both explained by a deployment on another network — and that is
// the case this gate exists for, since a deterministic deploy answers
// ordinary reads at the same address either way.
//
// GATED ON EVERY REMAINING FAILURE BEING ONE THE CHAIN COULD EXPLAIN
// (round 78 P2), which is NOT the same as `failures` being non-zero.
//
// I wrote that "the observed findings have already exited above, so
// whatever remains in `failures` is inferred", and it was false:
// the exits above extract only SOME of them — at the time, a forced-close
// filter that has since been folded into the shared path. A hooks-order crash,
// an uncaught page error, a dead Advanced anchor and a mis-ordered row
// are all READ, all counted here, and none of them is explained by a
// page built against another network — so this gate would have
// downgraded a directly observed defect to "nothing was learned". That
// is the exact swallow the whole exit ordering exists to prevent, added
// by the fix that was meant to strengthen it.
//
// `visitProblemKinds` tags each problem at the one site that decides
// them. An unanswerable probe on an otherwise clean run is still not
// worth exiting 2 over, so this needs at least one absence-shaped
// failure AND no observed one.
const remaining = visited.flatMap((v) => visitProblemKinds(v, ROLE));
const observedRemaining = remaining.filter((p) => p.kind === 'observed');
const absenceRemaining = remaining.filter((p) => p.kind === 'absence');
if (pageChainUnknown.length && absenceRemaining.length && !observedRemaining.length) {
  console.log(
    `\nBLOCKED: ${pageChainUnknown.length} of the page's own RPC endpoint(s)` +
      ` would not say which chain they serve, so this run cannot tell a` +
      ` product regression from a site built against another network.`,
  );
  pageChainUnknown.slice(0, 6).forEach((u) => console.log(`  unanswered → ${u}`));
  console.log(
    `  → ranked ahead of the inferred failures below, exactly as the` +
      ` allowlist gap is: a missing surface says nothing about the app` +
      ` until the page's chain is known. Re-run, or point the probe at an` +
      ` endpoint that answers eth_chainId.`,
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
// Every candidate moved out from under us: the list route alone proves
// nothing about the chooser, so this run verified nothing.
if (!visited.some((v) => /^\/positions\/\d+$/.test(v.path))) {
  console.log(
    '\nBLOCKED: no position detail page was observed — nothing verified.',
  );
  process.exit(2);
}
// ROUND 1 P2 — AN ADVERTISED ASSERTION THAT NEVER RAN IS NOT A CLEAN
// RUN. Every visited position can legitimately produce `blocked` (all
// FallbackPending, all sale-locked, none held), and a reporter that
// consumes only `fail` then prints "routes clean" and exits 0 over a
// check that never once executed. Ranked after `failures` and after the
// Advanced BLOCKED arm, for the same reason those are ordered as they
// are: a real regression is still reported as one.
const fcGap = forcedCloseCoverage(visited, ROLE);
if (fcGap) {
  console.log(`\nBLOCKED: ${fcGap}.`);
  process.exit(2);
}
process.exit(0);
