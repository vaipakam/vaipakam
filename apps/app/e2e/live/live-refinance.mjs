// #2380 / #2401 post-deploy live review — a REAL refinance of a loan
// backed by ILLIQUID collateral, driven end to end through the deployed
// app against the live Base Sepolia Diamond.
//
// Why this drive exists. Before #2401, refinancing a loan whose collateral
// is illiquid — both parties having consented to that at origination —
// reverted `IlliquidLoanNoRiskMath` in RefinanceFacet's post-rollover risk
// gate, so the lender's accept could never land. The fork spec
// (`tests/29-refinance-completion.spec.ts`) proves the flow on Anvil with
// a LIQUID collateral; this drive proves the illiquid case on the real
// chain, on the real loan that exposed the bug (loan 22), through the same
// UI the spec drives:
//
//   1. The BORROWER (Advanced mode) opens `/positions/<loan>`, fills the
//      "Refinance this loan" form, reviews, consents and posts. The form
//      may ask for up to three wallet steps (guardrail caps, payoff
//      approval, createOffer); each is allowed through the write gate
//      below only if it is one of exactly those.
//   2. The request is pinned ON CHAIN from the createOffer receipt's own
//      `OfferCreated` event — never from "newest offer" alone — and must
//      target this loan, take the carry-over path, and carry the terms
//      typed into the form.
//   3. A DIFFERENT lender (role `lender`) finds the request in the Offer
//      Book, presses its "Fund this request" CTA and accepts it through
//      the guided review ("Fund this borrower"). If the indexer has not
//      listed the request yet, the lender opens that CTA's own target
//      (`/lend?offer=<id>`) instead, and the drive records it: the accept
//      still runs through the app's review and signing. There is NO
//      scripted fallback: if the deployed UI cannot accept the request,
//      that is the finding, and the drive stops.
//   4. The outcome is asserted on chain, pinned at or after the accept's
//      block: the old loan Repaid; the replacement Active, same borrower,
//      the accepting lender, the same collateral identity and amount,
//      still Illiquid, consent from both still recorded, same principal;
//      and the borrower's collateral-token WALLET balance unchanged across
//      the whole flow (carry-over re-tags the lien, it never re-pledges).
//
// WRITE DISCIPLINE — two rules, applied to every write (#2422 r2):
//
//   (A) ONE COMPLETE EXPECTED OBJECT PER SIGNING REQUEST. Every
//       eth_sendTransaction and eth_signTypedData request is compared,
//       field by field over the WHOLE decoded payload, against an expected
//       object built BEFORE signing from the loan and the typed terms
//       (refinanceExpected.mjs; the comparator is expectedPayload.mjs). A
//       field the expected object does not name is itself a mismatch, so
//       nothing is hand-picked and a new or regressed field is refused by
//       construction.
//   (A') ONE ORDERED WRITE PLAN (#2422 r3). Those expected objects are the
//       steps of ONE plan for the whole drive, declared before the first
//       write (refinancePlanSteps → writePlan.mjs), in the app's order:
//         b-caps? → b-approve-reset? → b-approve-set? → b-create →
//         l-sign → l-approve-reset? → l-approve-set? → l-accept
//       (`?` = optional: the form skips caps that already cover the terms,
//       and `ensureAllowance` sends a reset to 0 only for a leftover
//       non-zero allowance and no approve at all when it already suffices).
//       A request is allowed only if it matches the NEXT unconsumed step;
//       a match consumes it before the provider is called, so a duplicate,
//       an out-of-order request, a step the plan lacks, or anything after
//       the plan is complete is refused, and the refusal latches the plan.
//       The steps: caps; bounded principal approvals; the 26-field
//       createOffer; the 34-field AcceptTerms (Full VPFI tariff OFF); and
//       acceptOffer carrying EXACTLY the signed terms and signature. No
//       Permit2 path: a borrower-request accept never uses one. The app's
//       approval UNWIND after a failed post is not in the plan, so it is
//       refused too — by then the drive has halted, and the report names
//       any approval left standing.
//   (B) HALT BEFORE THE NEXT WRITE. Any failed assertion or disclosure
//       check, at any phase, sets a halt; the gate then refuses every
//       further write, and every UI step that leads to one (a consent tick,
//       a submit) checks the halt first and stops. A review that fails to
//       disclose the illiquid collateral is therefore never consented to.
//
// THE PLAN IS CLOSED UNTIL ARMED (#2422 r7; in the plan itself since r8).
// Each role is armed only IMMEDIATELY BEFORE ITS CONFIRMED SUBMIT — the
// borrower once the position card, posture banner and review figures have
// passed, the lender once the request is pinned and the lender's review
// has passed — and the plan is closed again when that submit settles. A
// request while closed (or from the unarmed role) is refused, latches the
// plan and halts: an approve(Diamond, 0) the position page fires while it
// loads can never consume the plan's reset step.
// An approval RESET must be followed by its SET (`requires` in the plan).
//
// THE VERDICT IS AN OUTCOME MANIFEST (#2422 r8, outcomeManifest.mjs), not
// "all checks passed": every claim this drive VERIFIES, with the on-chain
// reads that substantiate it — a claim prints as verified only when every
// check it declares ran and passed — and every claim it does NOT verify,
// with the reason and where it is covered. Among the verified claims, read
// at the block before the accept and at the accept block: the exact
// settlement (the old lender's claim and vault, both wallets, the vaults,
// and the principal token's Transfer logs in the accept receipt, all
// against the contract's own payoff view and fee config), and the collateral
// lien moving intact from the old loan to the replacement.
//
// THE SETTLEMENT MODEL IS BOUNDED, NOT EXTENDED (#2422 r9). It covers the
// default fee posture only — an undiscounted borrower LIF (effective
// discount 0 and no Full opt-in: Diamond state only, never the principal's
// liquidity, which reads oracle and pool state no isolation covers — r11)
// and an exiting holder with no yield-fee entitlement — and those PREMISES
// are read at the
// pinned preflight block: when one fails, the settlement claim is stated NOT
// VERIFIED in the pre-write summary, before anything is written. After the
// write, a premise that no longer holds at the block before the accept (or a
// discount event in the receipt, or a payoff step) makes it UNDETERMINED —
// a third outcome, never a FAIL. So does TRANSACTION SCOPE: a block-diff
// read (claimable, wallet, vault, lien) is attributed to the accept only
// when the accept block's receipts show no other transaction touching the
// Diamond or a participant; otherwise, or when they cannot be read, those
// checks are UNDETERMINED with the reason. Receipt-scoped checks (the
// transfer legs, collateral leaving the vault) judge regardless.
//
// TWO RULES, applied everywhere rather than per call site (#2422 r10):
//   RULE 1 — OBSERVATION vs CHAIN (`observeConfig`, observation.mjs). Every
//     check that compares something RENDERED with chain config (the posture
//     banner and the standing card's posture; the fee rates and grace window
//     on both reviews) reads that config before and after the observation
//     and compares both with the preflight's. A difference is a state race:
//     BLOCKED before any write, UNDETERMINED after one — never a FAIL. A
//     stable config is what the observation is judged against.
//   RULE 2 — WRITE OUTCOME vs CHAIN (`scopeOf`, `txIsolation`). Every
//     assertion about what one of this run's transactions did is read from
//     its receipt, or from state across its block only when the block's
//     receipts show no other transaction touching the Diamond (the position
//     NFTs included) or a participant's wallet or vault. The same isolation
//     guards receipt-model checks whose inputs are state at the block
//     before. Otherwise: UNDETERMINED, with the reason. Every post-write
//     read is PINNED to the transaction's block or the block before (r11);
//     "latest" only where the claim is about now (an observation, a nonce
//     reconciliation, the failure ledger). The old lender's payout owner is
//     derived as the contract derives it: the stored lender AFTER the
//     accept's consolidation to the NFT holder, cross-checked against that
//     holder. The risk-terms epoch is watched config too, re-read just
//     before the lender is armed.
// A claim needed before the NEXT write that cannot be established after a
// write (a racing lender review, an unisolated createOffer block) stops the
// drive as STOPPED, UNDETERMINED (exit 3) — not a FAIL.
//
// TWO ROOT RULES (#2422 r14), each with a completeness test:
//   ROOT A — ONE POST-WRITE FAILURE CLASSIFIER (postWriteFailure.mjs). The
//     post-write try has one catch, and it settles every stop through
//     `classifyPostWriteFailure`: if a transaction of ours MINED (the accept
//     first), the full receipt-based outcome verifier runs anyway and the
//     page's failure is its own failed check; otherwise every premise is
//     re-read — the whole watched snapshot, every participant's sanctions
//     screening included, the request state, the loan posture — and a moved
//     premise is a race naming what moved (an external fill through
//     `externalFillVerdict`); only when nothing moved is it a product FAIL.
//     The request must still be open when the lender is armed.
//   ROOT B — THE REPLACEMENT THROUGH A DECLARED MAPPING
//     (replacementMapping.mjs): every Loan field of the replacement is
//     checked as a signed term, a carried value, a reviewed config value or
//     an accept-block value — or declared unchecked with its reason, listed
//     under NOT VERIFIED.
//
// THE REVIEW IS CHECKED BEFORE CONSENT (#2422 r7, reviewTerms.mjs). Before
// each consent tick, the receipt rows are read by their en.json labels and
// parsed against the en.json templates that produced them, and every
// figure is compared with the chain at display precision: the lender's
// principal, full-term interest at the ceiling rate, collateral, yield fee,
// length and grace window against the request and the live fee config;
// the borrower's payoff, late-fee headroom, wallet top-up, LIF and treasury
// rates and the request's lifetime against the app's own formulas. A
// mismatch or an unparseable row halts before consent.
//
// THE GATE LIVES IN THE WALLET (#2422 r4). Rules A and B are enforced by
// `launch({ signingGate, pinnedChainId: 84532 })`: driver.mjs runs every
// request the page makes of the injected wallet through walletGate.mjs
// INSIDE the wallet's own handler — the code that holds the key — so no
// page-side wrapper exists to be skipped by init-script order, and the
// wallet is pinned to Base Sepolia: a switch or add to another chain is
// refused, and nothing signs while the active chain is another one.
//
// SENDS ARE RECORDED BEFORE THE PROVIDER IS AWAITED. An allowed
// transaction is logged when the gate allows it; a broadcast whose RPC
// then fails never returns a hash but stays on record as "outcome unknown",
// is reconciled against the role's latest/pending nonces in the report, and
// makes the run FAIL. Once the gate has allowed anything, no exit is
// BLOCKED and nothing reports "nothing written".
//
// PRE-WRITE SCREENING (#2422 r3, r4). Before any write, pinned to one
// block: the borrower role must also HOLD the borrower position NFT
// (ownerOf), the accepting lender must not hold the lender position NFT (a
// self-refinance is not this scenario), and both wallets are screened
// TRI-STATE: an unset oracle is reported as "unset, screened nobody"; a set
// oracle is asked directly (ISanctionsList.isSanctioned, the call the
// Diamond makes without its fail-open try/catch) — not flagged by it and by
// the Diamond is clean, flagged is BLOCKED, a failed oracle call is BLOCKED
// as "oracle unavailable". Principal amounts print with the principal
// token's own decimals().
//
// APPROVALS COVER THE PULL (#2422 r4). The borrower's payoff approval must
// lie between the payoff the app itself computes for the request's last
// fillable moment (loanLive.ts `refinanceApprovalOf`, mirrored in
// refinanceExpected.mjs — it reproduces loan 22's real approval to the wei)
// and the payoff at the grace end; the lender's must be exactly the
// principal. Time-stamped fields (request expiry, caps window, accept
// deadline) are judged against the CHAIN time read when each submit flow
// starts, not the local clock (see `afterAnchor`).
//
// AFTER ANY FAILED RUN the drive works out what may be standing FROM THE
// WRITE PLAN, not from what the page confirmed (#2422 r5): a consumed
// createOffer step yields the request id from its own receipt even if the
// page never said "request is live" (a missing or pending receipt, or a
// send with no hash, is stated with its explorer lookup). It then re-reads
// the chain through the TOUCHED-STATE LEDGER (#2422 r6, touchedState.mjs):
// every piece of state a plan step can change — the borrower's and the
// lender's allowance to the Diamond, the loan's auto-refinance caps, the
// open refinance requests on the loan, the replacement loan (identified
// from our accept's receipt and by a state scan for the loan carrying this
// run's request — so a matcher fill is found too — with both position
// holders and its terms), the loan's status — is snapshotted
// at the pinned preflight block, re-read after the failure, and printed
// with baseline, now, whether a consumed step of THIS run touches it, and a
// remedy that RESTORES THE BASELINE (never a blanket zero; a change this
// run did not make gets no remedy; an irreversible one says so). It sends
// nothing itself.
//
// ALSO BLOCKED BEFORE ANY WRITE: either asset paused (isAssetPaused, the
// read RefinanceFlow makes — an operator's posture, stated as such), an
// unreadable ledger baseline (#2422 r6); and (#2422 r5) a rate outside the form's
// 0 < bps ≤ 10,000, a length under 1 day or above the live
// maxOfferDurationDays, and a page that does not render English (both
// profiles are seeded with `vaipakam:language` = en, and `<html lang>` is
// asserted, because every disclosure is matched against en.json).
// WALLET-LEVEL REFUSALS — a chain switch or a wrong-chain signature the
// wallet refused before the drive's gate was even asked — are collected
// from both sessions, halt the drive, and fail the run.
//
// MATURITY MARGIN. The loan must be at least two hours from maturity at
// preflight. Past maturity the payoff grows by the late fee, so a run that
// crossed the due date would sign a different deal from the one it
// reserved for and reviewed — refinancing in the grace window is a
// separate scenario, not this one. Two hours is over three times this
// drive's own worst case (about 35 minutes).
//
// Verdicts (the three-verdict contract in run-live-batch.mjs):
//   0 PASS     — every assertion held, and every claim the outcome manifest
//                declares verifiable ran and passed (a deferred claim is
//                printed under NOT VERIFIED, with its reason).
//   1 FAIL     — an assertion failed, a manifest claim failed or never ran,
//                a write was refused by the gate, a
//                transaction reverted, or the UI could not complete a
//                step it should have.
//   2 BLOCKED  — a precondition did not hold BEFORE anything was written
//                (no REFI_LOAN_ID, site build mismatch, chain facts differ,
//                balances short, an open request already exists,
//                credentials missing, or either browser session could not
//                be set up — both are set up before the first write).
// Once the first transaction has been sent, nothing exits BLOCKED: the
// drive has changed chain state and its report must be read.
//   3 UNDETERMINED — the drive stopped on a race after a write (RULE 1/2),
//                or every check that could judge held but some post-write
//                claim could not be substantiated either way (#2422 r9 — a
//                fee posture outside the model by the accept, another
//                transaction in the accept block touching a diffed state,
//                unreadable receipts). Printed "OUTCOME: COMPLETED, N
//                CLAIM(S) UNDETERMINED" with each claim and its reason.
//                Deliberately NOT exit 0: an exit code is read without the
//                line beside it, and 0 would certify claims nobody
//                established. Not 1 (nothing was observed wrong) and not 2
//                (chain state has changed). This is a fourth code outside the
//                batch's three-verdict contract, which is safe only because
//                the driver is MANUAL_ONLY: were it ever batched, the runner
//                classifies any code other than 0 and 2 as FAIL — the
//                conservative reading, never a PASS.
//
// ONE-SHOT BY NATURE, SO MANUAL-ONLY. A successful run closes the loan it
// drives, so there is no loan this drive could default to that stays
// drivable: REFI_LOAN_ID is REQUIRED (an Active, illiquid-collateral,
// both-parties-consented loan whose stored borrower is the `borrower`
// role and whose lender is not the `lender` role). For the same reason it
// is listed in `MANUAL_ONLY_DRIVERS` (verdictContract.mjs): the batch
// runner skips it, and says so, instead of running a drive that would
// BLOCK on every batch after its loan closed. Loan 22 — the loan that
// exposed #2380, refinanced by this drive into loan 23 on 2026-10-05 — keeps
// its pinned facts below, so `REFI_LOAN_ID=22` now exits BLOCKED at "loan
// is Active" without writing anything.
//
// Run (from apps/app/e2e/live/):
//   SITE_URL=https://app.vaipakam.com REFI_LOAN_ID=<loan id> \
//   BASE_SEPOLIA_RPC=<an RPC URL; may carry a key — it is never printed> \
//   node live-refinance.mjs
// In a sandbox whose Playwright browser build differs from the installed
// one, add LIVE_CHROMIUM_PATH=<chrome binary> (honoured by driver.mjs);
// where Node's fetch must ride an HTTPS proxy, NODE_USE_ENV_PROXY=1.
// Optional: REFI_RATE_PCT (default 12), REFI_DAYS (default 30),
// WORKERS_DEV_URL (the build-parity reference, default the vaipakam-app
// production workers.dev host), REFI_PREFLIGHT_ONLY=1 (check every
// precondition, then exit 0 without launching a browser or writing
// anything), TESTNET_WALLETS_FILE (see README).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  parseAbi,
  toHex,
} from 'viem';
import {
  addressOf,
  blocked,
  blockedSync,
  CHAINS,
  clientsFor,
  ensureConnected,
  launch,
  precondition,
  requireSigningRole,
  requireSiteUrl,
  SITE,
} from './driver.mjs';
import { redactUrl } from './redact.mjs';
import {
  borrowerReserve,
  decodeTxForComparison,
  graceSecondsFrom,
  refinancePayoffAt,
  refinancePlanSteps,
  REQUEST_WINDOW_SEC,
} from './refinanceExpected.mjs';
import { createWritePlan } from './writePlan.mjs';
import { formatLedgerRow, ledgerRows, runTouchedSteps } from './touchedState.mjs';
import { compareBorrowerReceipt, compareLenderReceipt } from './reviewTerms.mjs';
import { expectedPostureFrom, postureCopyFrom } from './refinancePosture.mjs';
import { createManifest, runVerdict } from './outcomeManifest.mjs';
import { configChanges, observationVerdict, observeAgainstChain } from './observation.mjs';
import { readWatchedConfig } from './watchedConfig.mjs';
import { postureMisses } from './supportedPosture.mjs';
import { causeKindOf, classifyPostWriteFailure } from './postWriteFailure.mjs';
import { evaluateReplacement, UNCHECKED_FIELDS } from './replacementMapping.mjs';
import {
  balanceDeltaMismatches,
  checkRoleNonces,
  collateralMovedOut,
  expectedPrincipalTransfers,
  expectedSettlement,
  expectedStoredExpiry,
  externalFillVerdict,
  lienMismatches,
  payoutOwnerOf,
  requestStateOf,
  scanForReplacement,
  scopeReason,
  settlementBlocker,
  settlementPremises,
  transferMismatches,
  txIsolation,
} from './refinanceOutcome.mjs';

// ---------------------------------------------------------------------
// Output hygiene FIRST — before anything can print. The chain RPC URL may
// carry a provider key, and viem embeds the request URL in its error
// messages. Every console line (the shared `blocked()` included) is
// scrubbed here, so the key cannot reach a transcript whatever path an
// error takes. Fail-closed: the configured RPC string is replaced
// wholesale, and any other `/v2/<segment>`-style key path is masked too.
// ---------------------------------------------------------------------
const RPC_URL = CHAINS[84532].rpc;
let RPC_ORIGIN = null;
try {
  RPC_ORIGIN = new URL(RPC_URL).origin;
} catch {
  /* unparseable — scrub() still replaces the raw string */
}
function scrub(s) {
  let out = String(s);
  if (RPC_URL) out = out.split(RPC_URL).join(redactUrl(RPC_URL, RPC_ORIGIN));
  return out.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => {
    if (RPC_ORIGIN && u.startsWith(RPC_ORIGIN)) return `${RPC_ORIGIN}/***`;
    // The block explorer's paths are public addresses and hashes, and they
    // ARE the remedy a failure report points at — masking them as
    // "secret-shaped" hex would leave the operator nothing to look up.
    if (u.startsWith('https://sepolia.basescan.org/')) return u;
    return redactUrl(u);
  });
}
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...args) =>
    orig(...args.map((a) => (typeof a === 'string' ? scrub(a) : a)));
}

requireSiteUrl();
requireSigningRole('borrower');
requireSigningRole('lender');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '../../../..');
const CHAIN_ID = 84532;
// REQUIRED — see the header. No default: every loan this drive succeeds on
// stops being drivable, so a default is a BLOCKED waiting to happen.
const LOAN_ID_RAW = process.env.REFI_LOAN_ID;
if (!LOAN_ID_RAW || !/^\d+$/.test(LOAN_ID_RAW.trim())) {
  blockedSync(
    `REFI_LOAN_ID is required (got ${JSON.stringify(LOAN_ID_RAW ?? null)}) — the loan to ` +
      'refinance: Active, illiquid collateral, consent from both, stored borrower = the ' +
      '`borrower` role. There is no default because a successful run closes the loan.',
  );
}
const LOAN_ID = BigInt(LOAN_ID_RAW.trim());
const RATE_PCT = process.env.REFI_RATE_PCT ?? '12';
const DAYS = process.env.REFI_DAYS ?? '30';
if (!/^\d+(\.\d{1,2})?$/.test(RATE_PCT) || !/^\d+$/.test(DAYS)) {
  blockedSync(`REFI_RATE_PCT / REFI_DAYS are not numbers: ${RATE_PCT} / ${DAYS}`);
}
const RATE_BPS = BigInt(Math.round(Number(RATE_PCT) * 100));
const DAYS_N = BigInt(DAYS);
// The form's own rules (#2422 r5 P2), checked BEFORE anything launches so
// an input the form would refuse can never become a half-driven run:
// RefinanceFlow accepts a rate only when 0 < bps ≤ MAX_INTEREST_BPS
// (10,000 = 100% a year), and a length of at least one day — its upper
// bound, the LIVE maxOfferDurationDays, is checked against the chain in the
// pinned preflight below.
if (RATE_BPS <= 0n || RATE_BPS > 10_000n) {
  blockedSync(`REFI_RATE_PCT must be above 0 and at most 100 (the form's 10,000 bps cap); got ${RATE_PCT}`);
}
if (DAYS_N < 1n) blockedSync(`REFI_DAYS must be at least 1; got ${DAYS}`);
const WORKERS_DEV_URL =
  process.env.WORKERS_DEV_URL ?? 'https://vaipakam-app.dawn-fire-139e.workers.dev';
/** See the maturity precondition for why two hours. */
const MIN_TO_MATURITY_SEC = 2n * 3_600n;

/** Facts read from chain when this drive was written — re-verified, not
 *  trusted. Only for loan 22 (now Repaid, so `REFI_LOAN_ID=22` blocks);
 *  any other REFI_LOAN_ID gets the generic invariants alone. */
const LOAN22_FACTS = {
  principal: 5_000_000_000_000_000n, // 0.005 WETH
  principalAsset: '0x4200000000000000000000000000000000000006',
  collateralAsset: '0xF2c65Cd941FE681B575Adc8DFc155Bf612675037',
  collateralAmount: 100n * 10n ** 18n,
  prepayAsset: '0x4200000000000000000000000000000000000006',
  interestRateBps: 1000n,
  durationDays: 29n,
  useFullTermInterest: true,
  lender: '0x648897f2c549956eFfF626D57fBc3E39761e6792',
};

const LOAN_STATUS = { ACTIVE: 0, REPAID: 1 };
/** The oracle interface the Diamond itself calls (contracts/src/interfaces/
 *  ISanctionsList.sol) — so the drive asks the oracle exactly what the
 *  Diamond asks it, without the Diamond's fail-open try/catch. */
const SANCTIONS_LIST_ABI = parseAbi(['function isSanctioned(address addr) view returns (bool)']);
const LIQUIDITY_ILLIQUID = 1;

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ---------------------------------------------------------------------
// Chain access — the same RPC the injected wallet sends through.
// ---------------------------------------------------------------------
const DIAMOND = readDiamond();
const DIAMOND_ABI = readDiamondAbi();
const { pub } = clientsFor(CHAIN_ID);
const BORROWER = addressOf('borrower');
const LENDER = addressOf('lender');

function readDiamond() {
  const file = path.join(REPO, 'packages/contracts/src/deployments.json');
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8'))[String(CHAIN_ID)]?.diamond;
  } catch (err) {
    blockedSync(`cannot read the deployments bundle\n  path: ${file}\n  ${err.message}`);
  }
  if (typeof d !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(d)) {
    blockedSync(`deployments bundle ${CHAIN_ID}.diamond is not an address: ${JSON.stringify(d)}`);
  }
  return d;
}
function readDiamondAbi() {
  const file = path.join(REPO, 'packages/contracts/src/diamondAbi.json');
  try {
    const abi = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(abi)) throw new Error('not an ABI array');
    return abi;
  } catch (err) {
    blockedSync(`cannot read the combined Diamond ABI\n  path: ${file}\n  ${err.message}`);
  }
}

const read = (functionName, args = [], blockNumber) =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI,
    functionName,
    args,
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  });
const loanOf = async (id, blockNumber) => {
  const l = await read('getLoanDetails', [id], blockNumber);
  return { ...l, status: Number(l.status), collateralLiquidity: Number(l.collateralLiquidity) };
};
const tokenBalance = (token, owner, blockNumber) =>
  pub.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  });

/**
 * The reads behind `settlementPremises` (refinanceOutcome.mjs), at one
 * block: the principal's accept-time liquidity input, the borrower's
 * effective (consent-gated, clamped) discount, the request's Full opt-in
 * (`requestId` null ⇒ before the request exists: not Full), and the exiting
 * position holder's yield-fee eligibility inputs. Returns the raw reads and
 * the verdict.
 */
async function readSettlementPremises(blockNumber, { holder, requestId }) {
  // Diamond state only (#2422 r11): no liquidity read — that is external
  // oracle and pool state no block-isolation check can cover.
  const [[, borrowerEffBps], holderConsent, entitlement, creatorFull] = await Promise.all([
    read('getEffectiveDiscount', [BORROWER], blockNumber),
    read('getVPFIDiscountConsent', [holder], blockNumber),
    read('getFeeEntitlement', [LOAN_ID], blockNumber),
    requestId === null ? false : read('getOfferDetails', [requestId], blockNumber).then((o) => o.creatorFull),
  ]);
  const inputs = {
    borrowerEffBps: Number(borrowerEffBps),
    requestCreatorFull: creatorFull,
    holderConsent,
    lenderMode: Number(entitlement.lenderMode),
  };
  return { holder, inputs, ...settlementPremises(inputs) };
}
/**
 * Every receipt in block `blockNumber` (#2422 r9) — `eth_getBlockReceipts`,
 * or, where the provider lacks it, one `eth_getTransactionReceipt` per
 * transaction the block lists. Either way the count must equal the block's
 * own transaction count; anything less is `receipts: null` with the reason,
 * which the caller reports as UNDETERMINED. Never a partial list.
 */
async function blockReceiptsOf(blockNumber) {
  let block;
  try {
    block = await pub.getBlock({ blockNumber });
  } catch (e) {
    return { receipts: null, error: `the block could not be read (${String(e.shortMessage ?? e.message).slice(0, 100)})` };
  }
  const want = block.transactions.length;
  let firstErr = null;
  try {
    const r = await pub.request({ method: 'eth_getBlockReceipts', params: [toHex(blockNumber)] });
    if (Array.isArray(r) && r.length === want) return { receipts: r, via: 'eth_getBlockReceipts' };
    firstErr = `eth_getBlockReceipts returned ${Array.isArray(r) ? r.length : typeof r} of ${want}`;
  } catch (e) {
    firstErr = `eth_getBlockReceipts failed (${String(e.shortMessage ?? e.message).slice(0, 80)})`;
  }
  try {
    const receipts = [];
    for (let i = 0; i < want; i += 10) {
      receipts.push(
        ...(await Promise.all(block.transactions.slice(i, i + 10).map((hash) => pub.getTransactionReceipt({ hash })))),
      );
    }
    return { receipts, via: `per-transaction receipts (${firstErr})` };
  } catch (e) {
    return {
      receipts: null,
      error: `${firstErr}; per-transaction receipts failed too (${String(e.shortMessage ?? e.message).slice(0, 80)})`,
    };
  }
}

/**
 * RULE 2 (#2422 r10): the scope of one of this run's transactions — whether
 * a state difference across its block can be attributed to it. Reads the
 * block's receipts (`blockReceiptsOf`) and runs `txIsolation`, setting aside
 * this run's own other plan transactions by name. Returns `{ reason }`: null
 * when isolated, else the sentence every scoped check records as
 * UNDETERMINED.
 */
async function scopeOf(receipt, what, watched) {
  const blockRead = await blockReceiptsOf(receipt.blockNumber);
  const own = planSteps()
    .filter((st) => st.kind === 'tx' && st.record.hash && !eq(st.record.hash, receipt.transactionHash))
    .map((st) => st.record.hash);
  const scope = txIsolation({ receipt, receipts: blockRead.receipts, diamond: DIAMOND, watched, own });
  const reason = scopeReason(scope, { what, block: receipt.blockNumber, error: blockRead.error });
  console.log(
    `info  ${what} block ${receipt.blockNumber}: ${blockRead.receipts ? `${blockRead.receipts.length} receipts via ${blockRead.via}` : 'receipts UNREADABLE'}` +
      (scope.own.length ? `; set aside as this run's own plan transactions: ${scope.own.join(', ')}` : '') +
      `; ${reason ? `NOT isolated — ${reason}` : 'no other transaction touched the Diamond or a participant'}`,
  );
  return { reason };
}
/** A check whose evidence is state read across a scoped transaction's block:
 *  judged when the scope is isolated, UNDETERMINED (with the reason) when
 *  not. Receipt-log checks use plain `check`. */
function scopedCheck(sc, label, ok, observed, at) {
  if (!sc.reason) return check(label, ok, observed, at);
  const [claim, key] = at.split('.');
  MANIFEST.undetermined(claim, key, sc.reason);
  console.log(`UNDET ${label} — observed ${observed}; ${sc.reason}`);
  return null;
}

/** `read` in the shape watchedConfig.mjs takes. */
const diamondRead = (fn, args, blockNumber) => read(fn, args, blockNumber);
/** The loan's assets, which the per-asset pause entries are read for. */
const watchedContextOf = (l, oldHolder) => ({
  principalAsset: l.principalAsset,
  collateralAsset: l.collateralAsset,
  // Every participant whose sanctions screening the snapshot carries (r14).
  participants: { borrower: BORROWER, lender: LENDER, 'old lender': l.lender, 'old lender position holder': oldHolder },
  readOracle: (oracle, who, blockNumber) =>
    pub.readContract({
      address: oracle,
      abi: SANCTIONS_LIST_ABI,
      functionName: 'isSanctioned',
      args: [who],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    }),
});
/**
 * THE WATCHED-CONFIG SNAPSHOT at a block (undefined ⇒ latest) — every
 * mutable governance value this drive reads, as defined ONCE in
 * watchedConfig.mjs (#2422 r12). Rule 1 races every observation against the
 * whole of it.
 */
const readObservedConfig = (blockNumber) =>
  readWatchedConfig(diamondRead, watchedContextOf(EXPECT_LOAN, pre.lenderPositionHolder), blockNumber);

/**
 * RULE 1 for every observation of the browser against chain config
 * (#2422 r10, observation.mjs): read the config before and after `observe`,
 * against the preflight baseline. A stable reading returns `{ config,
 * observed }` to judge against. A race (or an unreadable config) before any
 * write exits BLOCKED here; after a write it returns `{ undetermined: why,
 * observed }` — the caller records UNDETERMINED, never a FAIL.
 */
async function observeConfig(what, observe) {
  const result = await observeAgainstChain({ baseline: OBSERVED_BASELINE, readConfig: () => readObservedConfig(), observe });
  const v = observationVerdict(result, { wrote: anythingAllowed(), what });
  if (v.action === 'judge') return { config: v.config, observed: result.observed };
  if (v.action === 'blocked') await blockedByRace(`${v.why}; rerun once it is stable`);
  console.log(`UNDET ${what}: ${v.why}`);
  return { undetermined: v.why, observed: result.observed };
}
/** Set from the preflight: the config every observation is raced against. */
let OBSERVED_BASELINE = null;


/**
 * EVERY offer id `who` has created, as of `blockNumber`, walking the
 * paginated view to its reported `total` (Codex #2422 r1 P2). A single
 * capped page would silently miss an open request past the cap — the one
 * the open-request precheck exists to find — and would make the
 * post-request baseline delta blind to a new id past it. A walk that does
 * not end at exactly `total` ids throws, so a short read is never mistaken
 * for a complete one.
 */
const OFFER_PAGE = 200n;
async function allOfferIdsOf(who, blockNumber) {
  const ids = [];
  let total = null;
  for (let offset = 0n; total === null || offset < total; offset += OFFER_PAGE) {
    const [page, t] = await read('getUserOffersPaginated', [who, offset, OFFER_PAGE], blockNumber);
    if (total !== null && t !== total) throw new Error(`offer total moved mid-walk (${total} → ${t}) at a pinned block`);
    total = t;
    ids.push(...page);
    if (page.length === 0) break;
  }
  if (BigInt(ids.length) !== total) {
    throw new Error(`offer walk for ${who} returned ${ids.length} ids, view reports ${total}`);
  }
  return ids;
}

/**
 * Every Diamond-emitted log in `receipt`, decoded against the Diamond ABI.
 * A Diamond log that does NOT decode is counted rather than dropped
 * (#2422 r6): an event-count assertion over a partial view would pass on
 * evidence it never saw, so callers fail when `undecodable` is non-zero.
 */
function diamondEvents(receipt) {
  const events = [];
  let undecodable = 0;
  for (const l of receipt.logs) {
    if (!eq(l.address, DIAMOND)) continue;
    try {
      events.push(decodeEventLog({ abi: DIAMOND_ABI, data: l.data, topics: l.topics }));
    } catch {
      undecodable += 1;
    }
  }
  return { events, undecodable };
}

// ---------------------------------------------------------------------
// Bookkeeping for the report.
// ---------------------------------------------------------------------
const checks = []; // { label, ok, observed }
const findings = []; // UI observations worth recording
const refusals = []; // write-gate refusals — each one fails the drive
/**
 * The drive's ONE ordered write plan (writePlan.mjs), built before the
 * first write; null until then. Every allowed signing request is a CONSUMED
 * step of it, and the step's record carries what came back: `hash` or
 * `signature`, and `outcome` — 'awaiting provider' from the moment the step
 * is consumed (BEFORE the provider is called, #2422 r2 P1), then 'hash
 * returned' / 'signed' / 'provider rejected: …'. A consumed transaction step
 * without a hash is reconciled against the role's nonces in `report()`.
 */
let PLAN = null;
const planSteps = () => (PLAN ? PLAN.steps() : []);
/** Consumed steps of `kind`, flattened for the report and the flow. */
const consumedSteps = (kind, role) =>
  planSteps()
    .filter((st) => st.kind === kind && st.status === 'consumed' && (!role || st.role === role))
    .map((st) => ({
      id: st.id,
      role: st.role,
      purpose: st.purpose,
      hash: st.record.hash ?? null,
      signature: st.record.signature ?? null,
      outcome: st.record.outcome ?? 'awaiting provider',
    }));
const sendsOf = (role) => consumedSteps('tx', role);
const hashedSends = (role) => sendsOf(role).filter((t) => t.hash);
const anythingAllowed = () => planSteps().some((st) => st.status === 'consumed');

// ---------------------------------------------------------------------
// RULE B — one "halt before the next write" rule (#2422 r2).
//
// ANY failed assertion or disclosure check, at any phase, sets HALT. Once it
// is set the write gate refuses every further signing request, and every UI
// step that leads to a write (ticking a consent box, pressing a submit)
// calls `beforeWriteStep` first and stops there. So a failure observed
// before a write can never be followed by that write — whichever path the
// failure took to get recorded — and nothing after it silently continues.
// ---------------------------------------------------------------------
let HALT = null;
function halt(why) {
  if (HALT) return;
  HALT = why;
  console.log(`HALT  ${why} — the write gate now refuses every further write`);
}
// ---------------------------------------------------------------------
// THE OUTCOME MANIFEST (#2422 r8, outcomeManifest.mjs) — what this drive's
// verdict claims, declared before anything runs. Each VERIFIED claim names
// the checks it consists of and the read behind each; it prints as verified
// only when every one of them ran and passed. Each NOT VERIFIED claim says
// why this drive does not check it and where it is covered. The verdict
// prints this manifest instead of a bare "all checks passed".
// ---------------------------------------------------------------------
const MANIFEST = createManifest({
  verifiable: [
    {
      id: 'uiFlow',
      claim: 'the refinance ran end to end through the deployed app’s own UI, in English, with no scripted write',
      checks: {
        borrower: '<html lang> on /positions/<loan>, and the "Refinance this loan" card rendered for the stored borrower',
        lender: '<html lang> on /offers, and the guided review opened as "You’re funding borrow request #<id>"',
        lenderDone: 'the lender page reported "Loan opened"',
      },
    },
    {
      id: 'borrowerReview',
      claim: 'before consent, the borrower’s review showed the chain’s auto-match posture and the figures the chain implies',
      checks: {
        posture: 'the posture banner and the standing request card vs paused / getAutoRefinanceEnabled / getMasterFlags at the pinned block',
        receipt: 'the review rows (payoff, late-fee headroom, wallet top-up, LIF and treasury rates, request lifetime, carry-over copy) vs getLoanDetails at chain head, getLoanInitiationFeeBps and getFeesConfig',
      },
    },
    {
      id: 'request',
      claim: `the request the borrower posted is on chain with exactly the reviewed terms, refinancing loan ${LOAN_ID} by carry-over`,
      checks: {
        receipt: 'the createOffer receipt: success, every Diamond log decodes, one OfferCreated, the page names the same id',
        terms: 'getOfferDetails(request) at the createOffer block: target loan, carry-over, creator, 0..ceiling rate band, length, amount, assets, collateral, consent, no Full opt-in, expiry — judged only if the create block is isolated (RULE 2)',
        onlyOffer: 'getUserOffersPaginated(borrower) walked to its total at the block before the createOffer and at its block: the request is the only new offer — scoped likewise',
      },
    },
    {
      id: 'offerBook',
      claim: 'the request was discoverable in the Offer Book, tagged illiquid, with a "Fund this request" CTA to the guided accept',
      checks: {
        cta: 'the Offer Book row’s CTA href',
        illiquidTag: 'the Offer Book row text vs copy.offers.illiquidCollateralTag',
      },
    },
    {
      id: 'lenderReview',
      claim: 'before consent, the lender’s review disclosed the illiquid collateral and showed the request’s terms as the chain holds them',
      checks: {
        illiquidWarning: 'the review text vs copy.match.illiquidWarning',
        receipt: 'the review rows (principal, ceiling-rate interest, collateral, yield fee, length, grace) vs getOfferDetails(request), getFeesConfig and the grace window',
      },
    },
    {
      id: 'oldLoanClosed',
      claim: `loan ${LOAN_ID} is closed as Repaid`,
      checks: {
        event: 'LoanRefinanced.oldLoanNewStatus in the accept receipt',
        status: `getLoanDetails(${LOAN_ID}).status pinned to the accept block — judged only if the accept's block is isolated (RULE 2)`,
      },
    },
    {
      id: 'replacement',
      claim: 'the accept opened ONE replacement loan: Active, from this request, the same borrower, the accepting lender, the same principal and collateral (still illiquid, consent from both), the requested rate and length',
      checks: {
        events: 'the accept receipt: success, every Diamond log decodes, one OfferAccepted(request), LoanRefinanced(old → new, newLender, borrower)',
        loan: 'getLoanDetails(replacement) at the accept block, EVERY field through the declared mapping (replacementMapping.mjs: signed term / carried / reviewed config / accept block; the unchecked ones listed under NOT VERIFIED) — scoped (RULE 2)',
        positionNfts: 'ownerOf(borrowerTokenId / lenderTokenId) at the accept block (scoped)',
        requestAccepted: 'getOfferDetails(request).accepted at the accept block (scoped)',
        lenderIndex: 'getUserActiveLoans(lender) at the accept block (scoped)',
        feeStamps: 'getLoanDetails(replacement).treasuryFeeBpsAtInit / loanInitiationFeeBpsAtInit at the accept block vs the watched-config snapshot the reviews were judged against (scoped)',
      },
    },
    {
      id: 'collateralCarryOver',
      claim: 'the collateral carried over without leaving custody: neither the borrower’s wallet nor the borrower’s vault released it, and the lien moved intact from the old loan to the replacement',
      checks: {
        postNoCollateralOut: 'the createOffer receipt\u2019s collateral-token logs: nothing out of the borrower\u2019s wallet or vault',
        postBalances: 'balanceOf(collateral) of the borrower\u2019s wallet and vault at the block before the createOffer and at its block (scoped, RULE 2)',
        walletAtAccept: 'balanceOf(collateral, borrower) at the block before the accept vs the accept block (a block diff: only if no other transaction in the block touched it)',
        vaultAtAccept: 'balanceOf(collateral, getUserVaultAddress(borrower)) at the same two blocks (a block diff, likewise scoped)',
        noCollateralOut: 'the accept receipt’s collateral-token logs: no Transfer (ERC-20/721) or TransferSingle/Batch (ERC-1155) out of the borrower’s vault',
        liens: 'getLoanCollateralLien(old) at the block before the accept and at the accept block; getLoanCollateralLien(replacement) at the accept block (block diff, scoped)',
      },
    },
    {
      id: 'settlement',
      claim: 'the accept settled exactly what the contract’s own views prescribe: the old lender’s claim and vault got the payoff less the treasury share, the treasury got its interest share and LIF cut, the borrower got the new principal less the LIF and paid the payoff, the accepting lender paid the principal and got the matcher cut',
      checks: {
        payoffView: 'calculateRepaymentAmount(old) at the block before the accept vs the app’s payoff formula for that block',
        oldLenderClaim: 'getClaimable(old, lender) at the block before the accept and at the accept block (a block diff: only if no other transaction in the block touched the Diamond or a participant)',
        transfers: 'the principal token’s Transfer logs in the accept receipt — attributable to this transaction alone, the treasury’s legs included — vs the legs derived from those views (whose inputs are state at the block before, so judged only if the accept\u2019s block is isolated)',
        wallets: 'balanceOf(principal) of the borrower and the accepting lender at the block before the accept and at the accept block (block diff, scoped)',
        vaults: 'balanceOf(principal) of the PAYOUT OWNER’s vault (the old loan’s stored lender at the accept block, after the contract’s consolidation to the NFT holder; cross-checked against ownerOf at the block before), the borrower’s and the lender’s vaults (getUserVaultAddress) at the same two blocks (block diff, scoped)',
      },
    },
    {
      id: 'writeDiscipline',
      claim: 'every signature and transaction was the next step of the declared write plan, exactly, and the chain shows nothing the gate did not allow',
      checks: {
        borrowerNonces: 'the borrower’s latest / pending nonce vs its consumed plan transactions, all with a hash — recorded only if that read succeeds',
        lenderNonces: 'the lender’s latest / pending nonce vs its consumed plan transactions, all with a hash — recorded only if that read succeeds',
        noRefusals: 'the gate’s and the wallets’ refusal logs, and the plan’s latch',
      },
    },
  ],
  notVerified: [
    // ROOT B (#2422 r14): the replacement's fields the declared mapping
    // leaves unchecked, each with its reason — so nothing is left unstated.
    {
      id: 'replacementUncheckedFields',
      claim: `the replacement loan's ${UNCHECKED_FIELDS.map((u) => u.field).join(', ')}`,
      reason: UNCHECKED_FIELDS.map((u) => `${u.field}: ${u.why}`).join('; '),
      coveredBy: null,
    },
    {
      id: 'graceWindow',
      claim: 'a refinance accepted inside the old loan’s grace window settles with the late fee',
      reason: 'excluded by this drive’s precondition (at least two hours before maturity)',
      coveredBy:
        'contracts/test/RefinanceFacetTest.t.sol testRefinanceLoan_graceWindow_succeeds (admission and completion); the fee amount via PrecloseFacetTest.testPreclosedDirect_graceWindow_chargesLateFee',
    },
    {
      id: 'yieldDiscount',
      claim: 'an exiting lender’s yield-fee discount (VPFI-paid or as a direct reduction) is applied on refinance',
      reason:
        'outside the settlement model, which covers the default fee posture only: an eligible holder at preflight states the settlement claim NOT VERIFIED before any write; one that becomes eligible by the accept makes it UNDETERMINED',
      coveredBy: 'contracts/test/FeeEntitlementFacetTest.t.sol test_1955_refinance_discountKeysOnHolder_notStoredLender',
    },
    {
      id: 'borrowerLifDiscount',
      claim: 'a borrower’s hold-tier (or Full-tariff) discount on the initiation fee is applied on refinance',
      reason: 'outside the settlement model, likewise: a discount the preflight reads can apply states settlement NOT VERIFIED before any write',
      coveredBy: 'contracts/test/VPFIDiscountFacetTest.t.sol testAcceptOfferWithVPFIDiscountApplied',
    },
    {
      id: 'liquidCollateral',
      claim: 'refinancing a loan with LIQUID collateral (the replacement’s HF / LTV gates)',
      reason: 'this drive refinances an illiquid-collateral loan only',
      coveredBy: 'apps/app/e2e/tests/29-refinance-completion.spec.ts (CI-Anvil)',
    },
    {
      id: 'oldLenderPayout',
      claim: 'the exiting lender can claim the settled payoff out of the protocol',
      reason: 'this drive verifies the claim is recorded and funded in the vault; claiming it is a write outside its plan',
      coveredBy: null,
    },
    {
      id: 'indexerAfter',
      claim: 'after the accept, the indexer and the app’s lists show the request filled and the replacement among both parties’ positions',
      reason: 'every outcome is asserted on chain; the Offer Book is used only to find the request',
      coveredBy: null,
    },
    {
      id: 'rewards',
      claim: 'VPFI reward accounting for the closed loan and the replacement',
      reason: 'no reward state is read',
      coveredBy: null,
    },
    {
      id: 'allowanceAfter',
      claim: 'no payoff allowance to the Diamond is left standing once the refinance completes',
      reason:
        'not asserted — the app approves the payoff at the request’s last fillable moment (late-fee headroom included), so an accept before that leaves the difference approved; loan 22’s run left 0.0000764 WETH',
      coveredBy: null,
    },
  ],
});

/**
 * One check: printed, recorded, and — when it fails — a halt (rule B).
 * `at` ('claim.check') files the result in the outcome manifest under the
 * claim it substantiates; the manifest refuses an undeclared one.
 */
function check(label, ok, observed, at) {
  const pass = Boolean(ok);
  checks.push({ label, ok: pass, observed });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${observed !== undefined ? `  — observed: ${observed}` : ''}`);
  if (at) {
    const [claim, key] = at.split('.');
    MANIFEST.record(claim, key, pass, `${label}${observed !== undefined ? ` — ${observed}` : ''}`);
  }
  if (!pass) halt(`check failed: ${label}`);
  return pass;
}
function note(s) {
  findings.push(s);
  console.log(`note  ${s}`);
}
/** Stop the flow: an unexpected state. FAIL once anything was written. */
class Stop extends Error {}
function stop(why) {
  halt(why);
  throw new Stop(why);
}
/**
 * Stop the flow because a claim it must establish before the NEXT write
 * could not be established — a state race or an unisolated block after a
 * write (#2422 r10). Nothing was observed wrong, so the run ends
 * UNDETERMINED (exit 3), not FAIL — unless something else failed too.
 */
class RaceStop extends Stop {}
let RACE_STOP = null;
function raceStop(why) {
  RACE_STOP = why;
  halt(why);
  throw new RaceStop(why);
}
/** Call before any UI action that can lead to a signing request. */
function beforeWriteStep(step) {
  noteWalletRefusals();
  if (HALT) throw new Stop(`not ${step}: the drive halted earlier — ${HALT}`);
}
/** A wallet-level refusal means the page asked the wallet for something it
 *  must never do (another chain, a signature on the wrong chain): halt. */
function noteWalletRefusals() {
  const w = walletRefusals();
  if (w.length) halt(`the wallet refused ${w.length} request(s) itself: ${w[0].role} — ${w[0].reason}`);
}

async function pollUntil(label, fn, { timeoutMs = 120_000, everyMs = 3_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > until) {
      console.log(
        `poll timed out: ${label}${lastErr ? ` (last error: ${String(lastErr.shortMessage ?? lastErr).slice(0, 160)})` : ''}`,
      );
      return null;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// ---------------------------------------------------------------------
// THE WRITE GATE — rule A over ONE ordered write plan (#2422 r2, r3).
//
// Rule A: every signing request is compared, over its WHOLE decoded
// payload, against one complete expected object built before signing from
// the loan and the typed terms (refinanceExpected.mjs): for a transaction,
// the full request with its calldata decoded to `{ functionName, args }`;
// for a typed-data signature, the signer plus the whole typed data. Any
// difference, and any field the expected object does not name, refuses.
//
// The ORDER (r3): those expected objects are steps of one plan for the
// whole drive (`buildPlan`, below the preconditions), and a request is
// allowed only if it matches the NEXT unconsumed step — passing over only
// steps declared optional. A match consumes the step before the provider
// is called, so an identical repeat (a stale page re-sending createOffer,
// a second accept) is refused by construction, as is anything out of
// order, any step the plan does not contain, and anything after the plan
// is complete. A refusal latches the plan AND halts the drive (rule B).
// ---------------------------------------------------------------------
const ROLE_ADDRESS = { borrower: BORROWER, lender: LENDER };
/**
 * Each session's wallet-level refusal log (`blockedRequests` from launch()),
 * kept by reference so it survives the session's close (#2422 r5 P2). It
 * holds the refusals `walletGateDecision` makes BEFORE the drive's gate is
 * consulted — a switch to another chain, a signing request on the wrong
 * active chain — as well as the gate's own. Any entry fails the run, even
 * if the page recovered from it, and stops further writes.
 */
const walletLogs = { borrower: [], lender: [] };
const walletRefusals = () =>
  ['borrower', 'lender'].flatMap((role) => (walletLogs[role] ?? []).map((r) => ({ role, ...r })));
/** Each role's `latest` nonce before anything could be written. */
let BASELINE_NONCES = null;
/** Set once the preconditions read the loan; the gate decodes approvals on
 *  its principal asset only after that. */
let EXPECT_LOAN = null;

function abiFor(to) {
  if (eq(to, DIAMOND)) return DIAMOND_ABI;
  if (EXPECT_LOAN && eq(to, EXPECT_LOAN.principalAsset)) return erc20Abi;
  return null;
}

/**
 * Judge one signing request against the plan. Synchronous: the decision
 * and the consumption of the step happen in one turn.
 *
 * WHICH ROLE MAY SIGN is the plan's own state (#2422 r7, moved into
 * writePlan.mjs in r8): the plan is CLOSED until a role is armed, and each
 * role is armed only immediately before its confirmed submit — after the
 * page, card and review checks have passed — and closed again once that
 * submit has settled. A request from a closed or unarmed role is refused by
 * `PLAN.offer`, latches the plan, and halts the drive.
 */
function judge(role, method, params) {
  noteWalletRefusals();
  if (HALT) return { ok: false, why: `halted — ${HALT}` };
  if (!PLAN) return { ok: false, why: 'no write plan has been built' };
  let kind;
  let actual;
  if (method === 'eth_sendTransaction') {
    kind = 'tx';
    actual = decodeTxForComparison(params?.[0] ?? {}, abiFor);
  } else if (method === 'eth_signTypedData_v4') {
    kind = 'typed';
    try {
      actual = { signer: params?.[0], typedData: JSON.parse(params?.[1]) };
    } catch {
      return { ok: false, why: 'unparseable typed data' };
    }
  } else {
    return { ok: false, why: `unexpected wallet method ${method}` };
  }
  const r = PLAN.offer(role, kind, actual);
  if (!r.ok) return r;
  PLAN.record(r.index, { outcome: 'awaiting provider', ...(kind === 'typed' ? { params } : {}) });
  return { ok: true, index: r.index, kind, purpose: r.step.purpose, stepId: r.step.id };
}

/**
 * The signing gate for one role, handed to `launch({ signingGate,
 * pinnedChainId })` (#2422 r4). driver.mjs calls it from INSIDE the
 * injected wallet's request handler — the code that holds the key — for
 * every signing or sending method, after it has already refused any chain
 * other than Base Sepolia (walletGate.mjs). There is no page-side wrapper:
 * nothing depends on init-script order, and the page cannot switch the
 * wallet to another chain to have Base Sepolia calldata broadcast there.
 *
 * Allowing consumes the plan step synchronously, before the wallet signs or
 * broadcasts; `onResult` / `onError` then attach what came back. A send the
 * provider rejects after broadcasting therefore stays on record as consumed
 * with an unknown outcome, and is reconciled by nonce in the report.
 */
function signingGateFor(role) {
  return async (method, params) => {
    const v = judge(role, method, params);
    if (!v.ok) {
      refusals.push(`${role}: ${method} — ${v.why}`);
      console.log(`GATE  refused ${role} ${method}: ${v.why}`);
      halt(`the ${role} page asked to sign something the plan does not allow next (${method})`);
      return { ok: false, why: v.why };
    }
    console.log(`GATE  allowed ${role}: step ${v.stepId} — ${v.purpose}`);
    const st = () => planSteps()[v.index];
    return {
      ok: true,
      onResult: (result) => {
        if (v.kind === 'tx') {
          PLAN.record(v.index, { hash: result, outcome: 'hash returned' });
          console.log(`TX    ${role} sent ${st().purpose}: ${result}`);
        } else {
          PLAN.record(v.index, { signature: result, outcome: 'signed' });
          console.log(`SIG   ${role} signed ${st().purpose}`);
        }
      },
      onError: (err) => {
        const outcome = `provider rejected: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 160)}`;
        PLAN.record(v.index, { outcome });
        console.log(`${v.kind === 'tx' ? 'TX  ' : 'SIG '}  ${role} ${st().purpose} — ${outcome}`);
      },
    };
  };
}

/** Advanced mode AND English before the first paint (#2422 r5 P2). The
 *  refinance form is an Advanced surface, and every disclosure this drive
 *  judges is matched against the ENGLISH catalogue — a persistent profile
 *  carrying another language would make those checks false negatives. The
 *  key is the shared i18n factory's (`packages/i18n` LANGUAGE_STORAGE_KEY).
 *  Storage only; nothing here touches the wallet. The language actually
 *  rendered is asserted after load (`assertEnglish`). */
async function seedProfile(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('app.mode', 'advanced');
      localStorage.setItem('vaipakam:language', 'en');
    } catch {
      /* storage blocked — the English assertion will say so */
    }
  });
}

// ---------------------------------------------------------------------
// The review screens' TERMS, compared with the chain before consent
// (#2422 r7). See reviewTerms.mjs for how rows are read and matched.
// ---------------------------------------------------------------------
/** The receipt rows inside `scope`, as { label, value } text. */
async function receiptRows(scope) {
  return scope.locator('dl.receipt .receipt-row').evaluateAll((rows) =>
    rows.map((r) => ({
      label: r.querySelector('dt')?.textContent ?? '',
      value: r.querySelector('dd')?.textContent ?? '',
    })),
  );
}

/** The lender's funding review vs the request on chain and the live fee
 *  config at the pinned block (see `compareLenderReceipt`). */
function lenderReviewMismatches(rows, req, config) {
  return compareLenderReceipt(rows, {
    en: EN.copy,
    req,
    principal: { decimals: PDEC, symbol: pre.principalSymbol },
    collateral: { decimals: Number(pre.collateralDecimals), symbol: pre.collateralSymbol },
    // RULE 1 (#2422 r10): the config read AROUND the observation.
    treasuryFeeBps: config.treasuryFeeBps,
    graceSeconds: graceSecondsFrom(config.graceBuckets, req.durationDays),
  });
}

/**
 * The borrower's refinance review vs the chain at the moment of comparison,
 * with the app's own payoff formulas (see `compareBorrowerReceipt`). A
 * whole-day boundary crossed between the page's read and this one would
 * show as a mismatch and halt — the safe direction.
 */
async function borrowerReviewMismatches(rows, config) {
  const t = await chainNow();
  const payoffNow = refinancePayoffAt(loan, t);
  // RULE 1 (#2422 r10): the fee rates and grace buckets read AROUND the
  // observation, not the preflight's.
  const lif = (loan.principal * BigInt(config.lifBps)) / 10_000n;
  const graceEnd = loanDue + graceSecondsFrom(config.graceBuckets, loan.durationDays);
  const expiresAt = t + REQUEST_WINDOW_SEC;
  const lastFillable = expiresAt - 1n < graceEnd ? expiresAt - 1n : graceEnd;
  const dateOpts = { day: 'numeric', month: 'short', year: 'numeric' };
  return compareBorrowerReceipt(rows, {
    en: EN.copy,
    principal: { decimals: PDEC, symbol: pre.principalSymbol },
    payoffNow,
    headroom: refinancePayoffAt(loan, lastFillable) - payoffNow,
    topUp: payoffNow - loan.principal + lif,
    lifBps: config.lifBps,
    treasuryFeeBps: config.treasuryFeeBps,
    clamped: graceEnd + 1n < expiresAt,
    // formatDate renders with the browser's zone; accept that and UTC.
    graceEndDates: [
      new Date(Number(graceEnd) * 1000).toLocaleDateString('en', dateOpts),
      new Date(Number(graceEnd) * 1000).toLocaleDateString('en', { ...dateOpts, timeZone: 'UTC' }),
    ],
    requestWindowDays: REQUEST_WINDOW_SEC / 86_400n,
  });
}

/** The page's rendered language, once i18n has set it (polled). */
async function renderedLang(page) {
  const lang = await pollUntil(
    'the page sets <html lang>',
    async () => (await page.evaluate(() => document.documentElement.lang || '')) || null,
    { timeoutMs: 30_000, everyMs: 1_000 },
  );
  return lang ?? '';
}
const isEnglish = (lang) => /^en(-|$)/i.test(lang);

// ---------------------------------------------------------------------
// After a failure: the TOUCHED-STATE LEDGER — REPORT ONLY (#2422 r6).
// ---------------------------------------------------------------------
const EXPLORER = 'https://sepolia.basescan.org';

/** A refinance request's state at `head`. */
async function requestStateAt(id, head) {
  const [offer, cancelled, block] = await Promise.all([
    read('getOfferDetails', [id], head),
    read('isOfferCancelled', [id], head),
    pub.getBlock({ blockNumber: head }),
  ]);
  return requestStateOf({ offer, cancelled, blockTs: block.timestamp });
}

/** Every OPEN refinance request on the loan at `head`, as sorted ids —
 *  the same scan the preflight's "no open request" condition makes. */
async function openRequestsAt(head) {
  const ids = await allOfferIdsOf(BORROWER, head);
  const open = [];
  for (const id of ids) {
    const o = await read('getOfferDetails', [id], head);
    if (o.refinanceTargetLoanId !== LOAN_ID || eq(o.creator, '0x0000000000000000000000000000000000000000')) continue;
    if ((await requestStateAt(id, head)) === 'open') open.push(String(id));
  }
  return open.sort();
}

const allowanceAt = (owner, head) =>
  pub.readContract({
    address: loan.principalAsset,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, DIAMOND],
    blockNumber: head,
  });

/**
 * Every piece of on-chain state a write-plan step can change, with the
 * steps that touch it, how to read and print it, and how to RESTORE IT TO
 * THE BASELINE (never a blanket zero: a grant that predates the run is put
 * back, not erased). The preflight snapshots each at the pinned block;
 * `touchedState.mjs` decides, after a failure, what each row says.
 */
const LEDGER = [
  {
    key: 'borrowerAllowance',
    label: 'borrower allowance (principal token → Diamond)',
    // The approvals set it; the accept's payoff pull spends it.
    // ... and so does ANY fill of this run's request — ours, another
    // lender's, or the order matcher's (#2422 r10, `runTouchedSteps`).
    touchedBy: ['b-approve-reset', 'b-approve-set', 'l-accept', 'b-request-filled'],
    read: (head) => allowanceAt(BORROWER, head),
    format: (v) => `${fmtP(v)} (raw ${v})`,
    restore: (b) =>
      `from the borrower, approve(${DIAMOND}, ${b}) on ${loan.principalAsset} — the pre-run figure` +
      `${b === 0n ? ' (a revoke)' : ''}. If a request of this run is still open, cancel it first: its acceptance pulls from this allowance` +
      ' (and the app\u2019s cancel also clears the approval, so re-check this row after cancelling).',
  },
  {
    key: 'lenderAllowance',
    label: 'lender allowance (principal token → Diamond)',
    touchedBy: ['l-approve-reset', 'l-approve-set', 'l-accept'],
    read: (head) => allowanceAt(LENDER, head),
    format: (v) => `${fmtP(v)} (raw ${v})`,
    restore: (b) =>
      `from the lender, approve(${DIAMOND}, ${b}) on ${loan.principalAsset} — the pre-run figure${b === 0n ? ' (a revoke)' : ''}.`,
  },
  {
    key: 'caps',
    label: `loan ${LOAN_ID} auto-refinance caps`,
    touchedBy: ['b-caps'],
    read: async (head) => {
      const c = await read('getAutoRefinanceCaps', [LOAN_ID], head);
      return { enabled: c.enabled, maxRateBps: Number(c.maxRateBps), maxNewExpiry: c.maxNewExpiry };
    },
    format: (v) => `enabled ${v.enabled}, maxRateBps ${v.maxRateBps}, maxNewExpiry ${v.maxNewExpiry}`,
    restore: (b) =>
      `from the borrower, setAutoRefinanceCaps(${LOAN_ID}, ${b.enabled}, ${b.maxRateBps}, ${b.maxNewExpiry}) — the pre-run caps` +
      ' (only meaningful while the loan is still Active).',
  },
  {
    key: 'openRequests',
    label: `open refinance requests on loan ${LOAN_ID}`,
    touchedBy: ['b-create', 'l-accept'],
    read: openRequestsAt,
    format: (v) => (v.length ? v.map((id) => `#${id}`).join(', ') : 'none'),
    restore: (b, n) => {
      const added = n.filter((id) => !b.includes(id));
      if (added.length === 0) return null;
      return (
        `cancel ${added.map((id) => `#${id}`).join(', ')} from the borrower — "Cancel refinance request" on ` +
        `${SITE}/positions/${LOAN_ID} (it opens a few minutes after posting), or cancelOffer(id) on the Diamond. ` +
        `Until then any lender can accept it${pre.autoRefi && pre.posture.partialFill ? ', and with automatic matching ON the order matcher can fill it' : ''}.`
      );
    },
  },
  {
    key: 'replacementLoan',
    label: `replacement for loan ${LOAN_ID}`,
    // Our accept opens it; so does the order matcher filling the request
    // this run created — either way it is this run's doing.
    touchedBy: ['b-create', 'l-accept'],
    read: replacementAt,
    format: (v) =>
      v === null
        ? 'none'
        : `loan #${v.id} — status ${v.status}; borrower NFT held by ${v.borrowerHolder}, lender NFT held by ${v.lenderHolder}; ` +
          `principal ${fmtP(v.principal)} ${pre.principalSymbol}, rate ${v.rateBps} bps, ${v.durationDays} days; ` +
          `collateral ${v.collateralAsset} × ${v.collateralAmount}`,
    lookup:
      `UNKNOWN — find it by hand: the Diamond's LoanRefinanced events for oldLoanId ${LOAN_ID} ` +
      `(${EXPLORER}/address/${DIAMOND}#events), or the borrower's positions at ${SITE}/positions`,
    // A completed refinance is not undone by one action: the replacement is
    // a live loan with its own parties.
    restore: () => null,
  },
  {
    key: 'oldLoanStatus',
    label: `loan ${LOAN_ID} status`,
    touchedBy: ['b-create', 'l-accept'],
    read: async (head) => (await loanOf(LOAN_ID, head)).status,
    format: (v) => `${v} (${v === LOAN_STATUS.ACTIVE ? 'Active' : v === LOAN_STATUS.REPAID ? 'Repaid' : 'other'})`,
    // A completed refinance is not undone by a single action — the
    // replacement loan is live. The row says so rather than inventing one.
    restore: () => null,
  },
];

/**
 * This run's request as the ledger should see it: `none` before any
 * createOffer (the preflight baseline, where the loan is Active and so has
 * no replacement), `known` once identified, `unidentified` when a
 * createOffer was handed to the wallet but its request could not be
 * pinned — then the replacement is UNKNOWN, never assumed absent.
 */
let RUN_REQUEST = { state: 'none', id: null };
const REPLACEMENT_SCAN_CAP = 2_000;

/** The loan opened from this run's request, read at `head`; null if none. */
async function replacementAt(head) {
  if (RUN_REQUEST.state === 'none') return null;
  if (RUN_REQUEST.state === 'unidentified') throw new Error('this run\u2019s request could not be identified');
  // Loan ids are sequential and an unused id reads back as id 0: only
  // reaching that empty id establishes "none". A scan that exhausts its cap
  // THROWS (#2422 r8), so the ledger prints this entry as UNKNOWN with its
  // event-lookup remedy instead of a "none" it has not established.
  const match = await scanForReplacement({
    readLoan: (id) => loanOf(id, head),
    startId: LOAN_ID + 1n,
    requestId: RUN_REQUEST.id,
    cap: REPLACEMENT_SCAN_CAP,
  });
  if (!match) return null;
  const [borrowerHolder, lenderHolder] = await Promise.all([
    read('ownerOf', [match.borrowerTokenId], head),
    read('ownerOf', [match.lenderTokenId], head),
  ]);
  return {
    id: match.id,
    status: match.status,
    borrowerHolder,
    lenderHolder,
    principal: match.principal,
    rateBps: match.interestRateBps,
    durationDays: match.durationDays,
    collateralAsset: match.collateralAsset,
    collateralAmount: match.collateralAmount,
  };
}

/** Read every ledger entry at `head`; a failed read is recorded, not thrown. */
async function readLedger(head) {
  const out = {};
  for (const e of LEDGER) {
    try {
      out[e.key] = { ok: true, value: await e.read(head) };
    } catch (err) {
      out[e.key] = { ok: false, error: String(err?.shortMessage ?? err?.message ?? err).slice(0, 120) };
    }
  }
  return out;
}
/** The ledger at the pinned preflight block — set before any write. */
let LEDGER_BASELINE = null;

/**
 * On EVERY failed run that wrote anything: identify this run's request
 * from the WRITE PLAN (a consumed createOffer's own receipt, even if the
 * page never confirmed it — #2422 r5), then re-read the whole ledger and
 * print, per entry, baseline, now, whether this run changed it, and the
 * remedy that restores the baseline. Sends nothing.
 */
async function reportAfterFailure() {
  if (!anythingAllowed()) return; // nothing reached the wallet
  let id = REQUEST_ID;
  const create = planSteps().find((st) => st.id === 'b-create' && st.status === 'consumed');
  if (id === null && create) id = await requestIdFromCreateStep(create);
  RUN_REQUEST = id !== null ? { state: 'known', id } : create ? { state: 'unidentified', id: null } : { state: 'none', id: null };
  // Our own accept's receipt names the replacement directly, when there is
  // one; the ledger's scan below confirms it from chain state either way.
  const accept = planSteps().find((st) => st.id === 'l-accept' && st.status === 'consumed');
  if (accept) {
    if (!accept.record.hash) {
      console.log(`\naccept: handed to the wallet with no hash (${accept.record.outcome ?? 'awaiting provider'}) — check the lender's transactions at ${EXPLORER}/address/${LENDER}`);
    } else {
      try {
        const rcpt = await pub.waitForTransactionReceipt({ hash: accept.record.hash, timeout: 90_000 });
        const refi = diamondEvents(rcpt).events.filter((e) => e.eventName === 'LoanRefinanced');
        console.log(
          rcpt.status !== 'success'
            ? `\naccept ${accept.record.hash} REVERTED — it opened no replacement.`
            : `\naccept ${accept.record.hash}: ${refi.map((e) => `LoanRefinanced ${e.args.oldLoanId} → #${e.args.newLoanId}`).join('; ') || 'no LoanRefinanced event'}`,
        );
      } catch (e) {
        console.log(`\naccept ${accept.record.hash}: no receipt yet (${String(e.shortMessage ?? e.message).slice(0, 100)}) — look it up at ${EXPLORER}/tx/${accept.record.hash}`);
      }
    }
  }
  console.log('\n=== touched-state ledger after the failure (latest block) ===');
  let head;
  try {
    head = await pub.getBlockNumber({ cacheTime: 0 });
  } catch (e) {
    console.log(`could not read the chain head (${String(e.shortMessage ?? e.message).slice(0, 120)}) — every entry below is UNKNOWN; check them by hand`);
  }
  let requestState = null;
  if (id !== null && head !== undefined) {
    try {
      requestState = await requestStateAt(id, head);
      console.log(`this run's request #${id}: ${requestState.toUpperCase()}`);
    } catch (e) {
      console.log(`this run's request #${id}: state UNREADABLE (${String(e.shortMessage ?? e.message).slice(0, 120)})`);
    }
  } else if (create && id === null) {
    console.log('this run\u2019s request: NOT IDENTIFIED (see above) — treat a request as possibly live');
  }
  const now = head !== undefined ? await readLedger(head) : {};
  // A fill of OUR request — whoever sent it — is this run's doing: the
  // request is ours, and the fill spends the borrower's payoff allowance
  // (#2422 r10). Detected from the request's on-chain state.
  const touched = runTouchedSteps(
    planSteps().filter((st) => st.status === 'consumed').map((st) => st.id),
    { requestState },
  );
  if (touched.byOthers) {
    console.log(
      `this run's request #${id} was FILLED BY ANOTHER PARTY (getOfferDetails.accepted, with no accept of ours consumed) — ` +
        'what that fill changed is attributed to this run below (step b-request-filled), with its restore',
    );
  }
  const consumed = touched.ids;
  console.log(`baseline: block ${pre.head} (preflight); now: block ${head ?? 'unknown'}`);
  for (const row of ledgerRows(LEDGER, LEDGER_BASELINE, now, consumed)) console.log(formatLedgerRow(row));
  console.log('Nothing was sent to recover: this drive reports, and the operator decides.');
}

/** The request id from the consumed createOffer step's receipt, or null
 *  with the reason printed. Never guesses. */
async function requestIdFromCreateStep(st) {
  console.log('\n=== the createOffer this run handed to the wallet ===');
  const hash = st.record.hash ?? null;
  if (!hash) {
    console.log(
      `no hash came back (outcome: ${st.record.outcome ?? 'awaiting provider'}). It may still have been broadcast: ` +
        `check the borrower's transactions from nonce ${BASELINE_NONCES?.borrower ?? '?'} at ${EXPLORER}/address/${BORROWER}`,
    );
    return null;
  }
  let receipt = null;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  } catch (e) {
    console.log(
      `createOffer ${hash}: no receipt yet (${String(e.shortMessage ?? e.message).slice(0, 100)}) — pending or dropped. ` +
        `Look it up at ${EXPLORER}/tx/${hash}; if it mines, it creates a fillable request.`,
    );
    return null;
  }
  if (receipt.status !== 'success') {
    console.log(`createOffer ${hash} REVERTED at block ${receipt.blockNumber} — it created no request.`);
    return null;
  }
  const decoded = diamondEvents(receipt);
  if (decoded.undecodable > 0) {
    console.log(`createOffer ${hash}: ${decoded.undecodable} Diamond log(s) did not decode — the request id below may be incomplete; inspect ${EXPLORER}/tx/${hash}`);
  }
  const created = decoded.events.filter((e) => e.eventName === 'OfferCreated');
  if (created.length !== 1) {
    console.log(`createOffer ${hash} mined but carries ${created.length} OfferCreated events — inspect it at ${EXPLORER}/tx/${hash}`);
    return null;
  }
  console.log(`createOffer ${hash} mined at block ${receipt.blockNumber}: it created request #${created[0].args.offerId}`);
  return created[0].args.offerId;
}

// ---------------------------------------------------------------------
// Report — printed on every exit once anything could have been written.
// ---------------------------------------------------------------------
/**
 * Reconcile every allowed send against the chain (#2422 r2 P1). The nonce
 * is the one record a lost hash cannot hide from: each mined transaction
 * from a role advances its `latest` nonce, and each broadcast one not yet
 * mined shows in `pending`. Returns the per-role lines and whether anything
 * is unaccounted for.
 */
async function reconcileSends(baselineNonces) {
  const lines = [];
  let unreconciled = false;
  if (!baselineNonces && sendsOf().length > 0) {
    return { lines: ['no nonce baseline was taken — allowed sends cannot be reconciled'], unreconciled: true };
  }
  for (const role of ['borrower', 'lender']) {
    const allowed = sendsOf(role);
    if (allowed.length === 0) continue;
    const who = ROLE_ADDRESS[role];
    let latest;
    let pending;
    try {
      [latest, pending] = await Promise.all([
        pub.getTransactionCount({ address: who, blockTag: 'latest' }),
        pub.getTransactionCount({ address: who, blockTag: 'pending' }),
      ]);
    } catch (e) {
      lines.push(`${role}: nonces unreadable (${String(e.shortMessage ?? e.message).slice(0, 80)}) — ${allowed.length} allowed send(s) NOT reconciled`);
      unreconciled = true;
      continue;
    }
    const minedDelta = latest - baselineNonces[role];
    const pendingDelta = pending - latest;
    const hashed = allowed.filter((t) => t.hash).length;
    const unhashed = allowed.length - hashed;
    lines.push(
      `${role}: ${allowed.length} allowed (${hashed} with a hash, ${unhashed} without); ` +
        `nonce mined +${minedDelta}, pending +${pendingDelta}`,
    );
    if (minedDelta + pendingDelta > allowed.length) {
      lines.push(`  ${role}: MORE transactions reached the chain than the gate allowed — a write bypassed the gate`);
      unreconciled = true;
    }
    if (unhashed > 0) {
      const onChainWithoutHash = minedDelta + pendingDelta - hashed;
      if (onChainWithoutHash > 0) {
        lines.push(
          `  ${role}: ${onChainWithoutHash} send(s) reached the chain although the provider returned no hash — ` +
            `look up nonce(s) from ${baselineNonces[role] + hashed} on the explorer`,
        );
      } else {
        lines.push(
          `  ${role}: ${unhashed} send(s) without a hash are NOT on chain as of this read; a delayed ` +
            `broadcast is still possible — recheck the nonce before treating them as unsent`,
        );
      }
      unreconciled = true;
    }
  }
  return { lines, unreconciled };
}

/**
 * BLOCKED is a claim that nothing was written, so it is refused once the
 * gate has allowed ANY write or signature (#2422 r2 P1): from then on the
 * outcome is FAIL with the full report and the nonce reconciliation. Every
 * BLOCKED exit in this file goes through here, so the rule does not depend
 * on where in the flow a call site happens to sit.
 */
async function blockedBeforeAnyWrite(why, err) {
  if (anythingAllowed()) {
    console.log(`\nSTOPPED (FAIL, not BLOCKED — the gate had already allowed a write): ${why}`);
    await report(BASELINE_NONCES);
    // Defensive (#2422 r7): nothing should be consumed while the plan is
    // closed, but if anything was, its touched state is reported too.
    await reportAfterFailure();
    process.exit(1);
  }
  await blocked(why, err);
}

async function report(baselineNonces) {
  console.log('\n=== write plan ===');
  if (!PLAN) console.log('(no plan was built — nothing could be written)');
  else if (!anythingAllowed()) console.log('(no step was consumed — nothing was written)');
  for (const st of planSteps()) {
    let detail = '';
    if (st.status === 'consumed') {
      if (st.kind === 'tx') {
        detail = st.record.hash ?? '(no hash — outcome unknown)';
        if (st.record.hash) {
          try {
            const r = await pub.waitForTransactionReceipt({ hash: st.record.hash, timeout: 120_000 });
            detail += ` → ${r.status} @ block ${r.blockNumber}`;
          } catch (e) {
            detail += ` → receipt unavailable (${String(e.shortMessage ?? e.message).slice(0, 80)})`;
          }
        } else {
          detail += ` → ${st.record.outcome ?? 'awaiting provider'}`;
        }
      } else {
        detail = st.record.outcome ?? 'awaiting provider';
      }
    }
    const status = st.status === 'pending' ? (st.optional ? 'not used' : 'NOT REACHED') : st.status;
    console.log(
      `${st.id.padEnd(16)} ${st.role.padEnd(8)} ${st.kind.padEnd(5)} ${status.padEnd(11)} ${st.purpose}` +
        (detail ? `  ${detail}` : ''),
    );
  }
  if (PLAN?.refusal()) console.log(`plan refusal: ${PLAN.refusal()}`);
  const rec = await reconcileSends(baselineNonces);
  if (rec.lines.length) {
    console.log('\n=== nonce reconciliation ===');
    for (const l of rec.lines) console.log(l);
  }
  const wr = walletRefusals();
  if (wr.length) {
    console.log('\n=== wallet-level refusals (each one fails the run) ===');
    for (const r of wr) console.log(`${r.role.padEnd(8)} ${r.reason}`);
  }
  if (refusals.length) {
    console.log('\n=== write-gate refusals ===');
    for (const r of refusals) console.log(r);
  }
  if (HALT) console.log(`\n=== halted: ${HALT} ===`);
  if (findings.length) {
    console.log('\n=== UI / flow notes ===');
    for (const f of findings) console.log(`- ${f}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);
  for (const c of failed) console.log(`FAILED: ${c.label}`);
  return rec;
}

// =====================================================================
// 0. Preconditions — BLOCKED on any miss, nothing written yet.
// =====================================================================
console.log(`live-refinance: loan ${LOAN_ID} on ${CHAIN_ID}, site ${SITE}`);

const indexHash = async (base) => {
  const res = await fetch(base, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${base} answered HTTP ${res.status}`);
  const hashes = [...new Set((await res.text()).match(/\/assets\/index-[A-Za-z0-9_-]+\.js/g) ?? [])];
  if (hashes.length !== 1) throw new Error(`${base} shell names ${hashes.length} index bundles`);
  return hashes[0];
};
const siteBundle = await precondition(`opening ${SITE}`, () => indexHash(SITE));
const refBundle = await precondition(`opening ${WORKERS_DEV_URL}`, () => indexHash(WORKERS_DEV_URL));
console.log(`build  ${SITE} → ${siteBundle}\nbuild  ${WORKERS_DEV_URL} → ${refBundle}`);
if (siteBundle !== refBundle) {
  await blockedBeforeAnyWrite(
    `${SITE} serves ${siteBundle} but the workers.dev deploy serves ${refBundle} — ` +
      `review the deployment you just made: rerun with SITE_URL=${WORKERS_DEV_URL}`,
  );
}

const pre = await precondition('reading the preconditions from chain', async () => {
  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC is chain ${chainId}, not ${CHAIN_ID}`);
  const head = await pub.getBlockNumber();
  const block = await pub.getBlock({ blockNumber: head });
  const loan = await loanOf(LOAN_ID, head);
  // Who holds each position NOW (#2422 r3 P2) — read first, because the old
  // lender position's holder is one of the participants the snapshot screens.
  const [borrowerPositionHolder, lenderPositionHolder] = await Promise.all([
    read('ownerOf', [loan.borrowerTokenId], head),
    read('ownerOf', [loan.lenderTokenId], head),
  ]);
  // THE WATCHED-CONFIG SNAPSHOT (#2422 r12, watchedConfig.mjs): every
  // mutable governance value this drive reads, in ONE read, at the pinned
  // head — every participant's sanctions screening included (r14). Every
  // governance figure below comes from it; nothing reads a watched getter
  // directly.
  const watched = await readWatchedConfig(diamondRead, watchedContextOf(loan, lenderPositionHolder), head);
  const { riskAccessGate: riskGate, autoRefinance: autoRefi, paused, partialFill } = watched;
  const collLiquidity = await read('checkLiquidity', [loan.collateralAsset], head);
  const [tosB, tosL] = await Promise.all([
    read('hasAcceptedCurrentTerms', [BORROWER], head),
    read('hasAcceptedCurrentTerms', [LENDER], head),
  ]);
  const bal = async (who) => ({
    eth: await pub.getBalance({ address: who, blockNumber: head }),
    principal: await tokenBalance(loan.principalAsset, who, head),
    collateral: await tokenBalance(loan.collateralAsset, who, head),
    nonceLatest: await pub.getTransactionCount({ address: who, blockTag: 'latest' }),
    noncePending: await pub.getTransactionCount({ address: who, blockTag: 'pending' }),
  });
  const [b, l] = await Promise.all([bal(BORROWER), bal(LENDER)]);
  const offerIds = await allOfferIdsOf(BORROWER, head);
  // The SAME scan the failure ledger makes (#2422 r13): `requestStateAt` →
  // `requestStateOf`, so a cancelled request that has not yet expired is
  // not counted as open, and the two can never disagree.
  const openRequests = await openRequestsAt(head);
  const caps = await read('getAutoRefinanceCaps', [LOAN_ID], head);
  // The LIVE loan-initiation fee rate (ConfigFacet), pinned to the same
  // head — the payoff reserve below is computed from it, never assumed.
  const { lifBps } = watched;
  // The contract's own payoff for the loan at the same head (RepayFacet's
  // view): the borrower's reserve is sized from it and from the loan's
  // remaining-term fields, never from its original length (#2422 r8).
  const repayDue = await read('calculateRepaymentAmount', [LOAN_ID], head);
  // Per-asset pause — the read RefinanceFlow's assertAssetNotPausedLive
  // makes for BOTH legs at submit (#2422 r6 P2). The app treats a failed
  // read as not-paused; here it throws, so an unknown pause state BLOCKS.
  const { principalPaused, collateralPaused } = watched;
  // The form's upper bound on the new length, read where the app reads it
  // (fees.ts: getProtocolConfigBundle()[14], maxOfferDurationDays).
  const { maxOfferDurationDays } = watched;
  // The risk-terms hash the lender's AcceptTerms must carry (the app reads
  // the same getter, fail-closed). Read before any write so the expected
  // acceptance terms are complete before the first signature.
  const { riskTermsHash } = watched;
  // The principal token's decimals, for every principal-denominated figure
  // this drive prints (#2422 r3 P2). The raw comparisons never depend on it.
  const principalDecimals = await pub.readContract({
    address: loan.principalAsset,
    abi: erc20Abi,
    functionName: 'decimals',
    blockNumber: head,
  });
  // What the review screens print the tokens as, and the fee config they
  // quote — read at the same pinned block (#2422 r7).
  const [principalSymbol, collateralSymbol, collateralDecimals] = await Promise.all([
    pub.readContract({ address: loan.principalAsset, abi: erc20Abi, functionName: 'symbol', blockNumber: head }),
    pub.readContract({ address: loan.collateralAsset, abi: erc20Abi, functionName: 'symbol', blockNumber: head }),
    pub.readContract({ address: loan.collateralAsset, abi: erc20Abi, functionName: 'decimals', blockNumber: head }),
  ]);

  // Sanctions screening, TRI-STATE (#2422 r3/r4 P2), now INSIDE the
  // snapshot (r14, `screenParticipant`): oracle unset → "unset, screened
  // nobody"; set → the oracle asked directly as the Diamond asks it, clean
  // only if it ANSWERED not-flagged and the Diamond agrees; flagged or
  // unavailable → BLOCKED. Every later snapshot re-screens every participant.
  const { sanctionsOracle } = watched;
  const oracleSet = !/^0x0{40}$/i.test(sanctionsOracle);
  const sanctionB = watched['screen:borrower'];
  const sanctionL = watched['screen:lender'];

  // The loan's grace window, read the way the app reads it — the payoff
  // approval the borrower signs is the payoff at the end of it.
  const { graceBuckets } = watched;
  // The settlement model's PREMISES (#2422 r9), pinned with everything else.
  // The request does not exist yet; it cannot be made Full by this run (the
  // write plan has no setOfferCreatorFullTariff step), so it enters as not
  // Full and is re-read at the block before the accept.
  const premises = await readSettlementPremises(head, {
    holder: lenderPositionHolder,
    requestId: null,
  });
  const posture = { paused, autoRefinance: autoRefi, partialFill };
  return {
    head,
    now: block.timestamp,
    loan,
    riskGate,
    autoRefi,
    paused,
    collLiquidity,
    tosB,
    tosL,
    b,
    l,
    offerIds,
    openRequests,
    caps,
    lifBps,
    repayDue,
    riskTermsHash,
    principalPaused,
    collateralPaused,
    maxOfferDurationDays,
    principalDecimals,
    principalSymbol,
    collateralSymbol,
    collateralDecimals,
    treasuryFeeBps: watched.treasuryFeeBps,
    borrowerPositionHolder,
    lenderPositionHolder,
    sanctionsOracle,
    oracleSet,
    sanctionB,
    sanctionL,
    graceBuckets,
    premises,
    posture,
    watched,
  };
});

const { loan } = pre;
const misses = [];
const want = (label, ok, observed) => {
  console.log(`pre   ${ok ? 'ok  ' : 'MISS'} ${label}: ${observed}`);
  if (!ok) misses.push(`${label} (observed ${observed})`);
};
// THE SUPPORTED LOAN POSTURE (#2422 r13, supportedPosture.mjs): every Loan
// field the expected builders and the settlement model depend on, with the
// value they support. A loan outside it is BLOCKED here, by field and
// reason — the unsupported mode (a pro-rata or periodic loan, settled
// interest, a rental, liquid collateral) is never modelled.
for (const m of postureMisses(loan)) {
  want(`loan ${m.field} within the supported posture (${m.want}) — ${m.why}`, false, m.value);
}
if (postureMisses(loan).length === 0) console.log('pre   ok   loan is within the supported posture (supportedPosture.mjs): every declared field');
want('stored borrower is the borrower role', eq(loan.borrower, BORROWER), loan.borrower);
want(
  'the borrower role holds the borrower position NFT (ownerOf at the pinned block)',
  eq(pre.borrowerPositionHolder, BORROWER),
  `token ${loan.borrowerTokenId} → ${pre.borrowerPositionHolder}`,
);
want('accepting lender differs from the current lender', !eq(loan.lender, LENDER), loan.lender);
want(
  'the accepting lender does not hold the lender position NFT (a self-refinance is not this scenario)',
  !eq(pre.lenderPositionHolder, LENDER),
  `token ${loan.lenderTokenId} → ${pre.lenderPositionHolder}`,
);
// Unset is not a MISS (the retail oracle is unset by design and this drive
// runs there); it is reported below. Flagged and unavailable both BLOCK.
for (const [who, r] of Object.entries(pre.watched).filter(([k]) => k.startsWith('screen:')).map(([k, v]) => [k.slice(7), v])) {
  want(
    `${who} sanctions screen is not flagged and not unavailable`,
    r.state === 'clean' || r.state === 'unset',
    r.state === 'unavailable'
      ? 'oracle unavailable — its isSanctioned call failed'
      : `${r.state} (oracle ${r.oracleSays ?? 'n/a'}, Diamond ${r.diamondSays})`,
  );
}
// The loan's grace window, resolved exactly as the app resolves it: the
// Diamond's buckets, or the app's default table when it publishes none.
const GRACE_SECONDS = graceSecondsFrom(pre.graceBuckets, loan.durationDays);
console.log(
  `pre   grace window: ${GRACE_SECONDS}s (${pre.graceBuckets.length ? 'from getGraceBuckets' : 'no buckets published — the app\u2019s default table'})`,
);
want('accepting lender is not the borrower', !eq(LENDER, BORROWER), LENDER);
want('collateral is Illiquid now (checkLiquidity)', Number(pre.collLiquidity) === LIQUIDITY_ILLIQUID, pre.collLiquidity);
// At least MIN_TO_MATURITY_SEC before maturity, not merely "not past it"
// (#2422 r2 P2). Past maturity the payoff grows by the late fee and keeps
// accruing, so a run that crosses the due date mid-drive would be signing
// a different deal from the one it reserved for and reviewed — a separate
// scenario (refinancing in the grace window), not this one. The margin is
// generous on purpose: this drive's own worst case is about 35 minutes
// (5 min Offer Book wait + up to 5 min each for posting and accepting, the
// review and consent polls, and up to 3 min per receipt), and two hours is
// more than three times that.
const loanDue = loan.startTime + loan.durationDays * 86_400n;
want(
  `at least ${MIN_TO_MATURITY_SEC / 60n} min before maturity (a refinance near or past the due date is a different scenario)`,
  loanDue - pre.now >= MIN_TO_MATURITY_SEC,
  `now ${pre.now}, due ${loanDue} (${(loanDue - pre.now) / 60n} min away)`,
);
if (LOAN_ID === 22n) {
  for (const [k, v] of Object.entries(LOAN22_FACTS)) {
    want(`loan 22 ${k}`, typeof v === 'string' ? eq(loan[k], v) : loan[k] === v, loan[k]);
  }
}
want('risk-access gate disabled (no tier / pair-consent setup needed)', pre.riskGate === false, pre.riskGate);
want('protocol not paused', pre.paused === false, pre.paused);
// An asset pause is an operational posture of the deployment: the form
// refuses to post (and an accept could not complete) while either leg is
// paused, so the drive states it and stops before launching anything.
want(
  `principal asset ${loan.principalAsset} not paused (isAssetPaused — the operator has paused it if this fails)`,
  pre.principalPaused === false,
  pre.principalPaused,
);
want(
  `collateral asset ${loan.collateralAsset} not paused (isAssetPaused — the operator has paused it if this fails)`,
  pre.collateralPaused === false,
  pre.collateralPaused,
);
want('borrower accepted current Terms', pre.tosB === true, pre.tosB);
want('lender accepted current Terms', pre.tosL === true, pre.tosL);
want('no open refinance request on this loan', pre.openRequests.length === 0, pre.openRequests.join(',') || 'none');
want('borrower has no pending transactions', pre.b.nonceLatest === pre.b.noncePending, `${pre.b.nonceLatest}/${pre.b.noncePending}`);
want('lender has no pending transactions', pre.l.nonceLatest === pre.l.noncePending, `${pre.l.nonceLatest}/${pre.l.noncePending}`);
const PDEC = Number(pre.principalDecimals);
const fmtP = (v) => formatUnits(v, PDEC);
want('lender holds the principal', pre.l.principal >= loan.principal, `${fmtP(pre.l.principal)} ≥ ${fmtP(loan.principal)}`);
// What the borrower must hold SPARE when the lender accepts: the payoff's
// interest share plus the new loan's initiation fee (the new principal
// arrives in the same transaction). The payoff is the LIVE remaining-term
// figure (#2422 r8, `borrowerReserve`): the larger of the contract's payoff
// view at the pinned head and the app's payoff formula — which reads
// `interestAccrualStart` / `interestRemainingDays` — at the latest moment
// this drive could accept (the maturity margin out, so a day's accrual step
// in between is covered and no late fee is). Never the loan's original
// `durationDays`: a loan re-anchored by a partial repayment owes far less,
// and a full-term figure would BLOCK it. The fee uses the LIVE rate read at
// the pinned head (Codex #2422 r1 P2).
const RESERVE = borrowerReserve({
  loan,
  viewDue: pre.repayDue,
  asOf: pre.now,
  horizonSec: MIN_TO_MATURITY_SEC,
  lifBps: pre.lifBps,
});
const lifWei = RESERVE.lif;
const borrowerSpareNeed = RESERVE.reserve;
console.log(
  `pre   payoff: contract view ${fmtP(pre.repayDue)} at block ${pre.head}; reserved for ${fmtP(RESERVE.payoff)} ` +
    `(remaining term: ${loan.interestRemainingDays} days from ${loan.interestAccrualStart || loan.startTime})`,
);
console.log(`pre   live loan-initiation fee: ${pre.lifBps} bps → ${fmtP(lifWei)} on the new principal (decimals ${PDEC})`);
want('borrower holds the payoff top-up (remaining-term interest share + live LIF)', pre.b.principal >= borrowerSpareNeed, `${fmtP(pre.b.principal)} ≥ ${fmtP(borrowerSpareNeed)}`);
const GAS_FLOOR = 300_000_000_000_000n; // 0.0003 ETH — several Base Sepolia txs
console.log(`pre   current risk-terms hash: ${pre.riskTermsHash}`);
// An unset oracle is fail-open BY DESIGN on the retail deploy: every
// address reads unflagged. Say so — a "not flagged" verdict from an unset
// oracle is not a screening result, and must not read as one.
if (!pre.oracleSet) {
  note('sanctions oracle is UNSET on this deployment — isSanctionedAddress is fail-open by design, so the screen screened nobody');
} else {
  console.log(`pre   sanctions oracle: ${pre.sanctionsOracle} — both wallets answered by the oracle directly at block ${pre.head}`);
}
want(
  `REFI_DAYS (${DAYS_N}) is within the live maxOfferDurationDays`,
  DAYS_N <= BigInt(pre.maxOfferDurationDays),
  `${DAYS_N} ≤ ${pre.maxOfferDurationDays}`,
);
want('borrower has gas', pre.b.eth >= GAS_FLOOR, formatUnits(pre.b.eth, 18));
want('lender has gas', pre.l.eth >= GAS_FLOOR, formatUnits(pre.l.eth, 18));
console.log(`pre   auto-refinance switch: ${pre.autoRefi}; matcher partialFill: ${pre.posture.partialFill}; caps on loan: ${JSON.stringify(pre.caps, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
// THE SETTLEMENT MODEL'S PREMISES, established before the first write
// (#2422 r9). The exact-settlement claim models the default fee posture
// only; when the pinned reads say a discount can apply, the claim is stated
// NOT VERIFIED now — with the reason, in this pre-write summary — instead of
// being judged after the irreversible write against a model that does not
// apply. The model is bounded, not extended to every fee branch.
console.log(
  `pre   settlement premises @${pre.head}: ` +
    `borrower effective discount ${pre.premises.inputs.borrowerEffBps} bps, request Full opt-in ${pre.premises.inputs.requestCreatorFull}, ` +
    `exiting holder ${pre.premises.holder} consent ${pre.premises.inputs.holderConsent}, loan lenderMode ${pre.premises.inputs.lenderMode}`,
);
for (const b of pre.premises.basis) console.log(`pre   ok   ${b}`);
if (!pre.premises.holds) {
  MANIFEST.defer(
    'settlement',
    `the default fee posture does not hold at preflight — ${pre.premises.failures.map((f) => f.reason).join('; ')}`,
    pre.premises.failures.map((f) => f.coveredBy).join('; '),
  );
  console.log(
    `pre   NOTE settlement will be NOT VERIFIED by this run (stated before any write): ` +
      pre.premises.failures.map((f) => `${f.party}: ${f.reason}`).join(' | '),
  );
}

if (misses.length) {
  await blockedBeforeAnyWrite(`chain facts differ from the drive's preconditions — nothing was written:\n  - ${misses.join('\n  - ')}`);
}
if (pre.autoRefi && pre.posture.partialFill) {
  note(
    'automatic matching is ON for this deployment, so the order matcher could fill the request before the lender does; ' +
      'the drive accepts promptly and STOPS if any other party fills it',
  );
}

// Every string this drive matches is read from the repo's English
// catalogue, so a copy edit cannot silently turn a disclosure check into
// a false negative (the illiquid warning never says "illiquid").
const EN = await precondition('reading src/i18n/locales/en.json', () =>
  JSON.parse(fs.readFileSync(path.join(HERE, '../../src/i18n/locales/en.json'), 'utf8')),
);
const postureCopy = await precondition('reading the posture copy from en.json', () => postureCopyFrom(EN));
const { illiquidWarning, bookIlliquidTag } = await precondition('reading the illiquid disclosure copy', () => {
  const w = EN?.copy?.match?.illiquidWarning;
  const t = EN?.copy?.offers?.illiquidCollateralTag;
  if (typeof w !== 'string' || typeof t !== 'string') {
    throw new Error('copy.match.illiquidWarning / copy.offers.illiquidCollateralTag missing from en.json');
  }
  return { illiquidWarning: w, bookIlliquidTag: t };
});
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// The posture snapshot every later banner observation is raced against.
console.log(
  `pre   auto-match posture @${pre.head}: ${expectedPostureFrom(pre.posture)} ` +
    `(paused ${pre.posture.paused}, auto-refinance ${pre.posture.autoRefinance}, partial fill ${pre.posture.partialFill})`,
);
// RULE 1's baseline: every observation of the browser is raced against
// these pinned values as well as against reads taken around it.
// That is the WHOLE watched-config snapshot (#2422 r12), not a hand-picked
// subset of it.
OBSERVED_BASELINE = pre.watched;

EXPECT_LOAN = loan;

/** The request's id, once phase 2 has pinned it from the receipt. */
let REQUEST_ID = null;
/**
 * Chain-time ANCHORS (#2422 r4 P2): the latest block's timestamp, read the
 * moment each submit flow starts — just before the click that leads to the
 * app's own `latestBlock` / `chainNow` read. Every time-relative field the
 * app stamps (the request expiry, the caps window, the AcceptTerms
 * deadline, and the payoff approval's floor) is judged against these
 * rather than against the local clock; see `afterAnchor` for the window.
 * Null until read, which leaves those steps unjudgeable — refused.
 */
let BORROWER_ANCHOR = null;
let LENDER_ANCHOR = null;
const chainNow = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp;
// The drive's ONE write plan, built here — before the first write — from
// the loan and the typed terms. See `refinancePlanSteps` for the order and
// what each step may carry.
PLAN = createWritePlan(
  refinancePlanSteps({
    abi: DIAMOND_ABI,
    chainId: CHAIN_ID,
    diamond: DIAMOND,
    loan,
    loanId: LOAN_ID,
    borrower: BORROWER,
    lender: LENDER,
    rateBps: RATE_BPS,
    days: DAYS_N,
    riskTermsHash: pre.riskTermsHash,
    graceSeconds: GRACE_SECONDS,
    borrowerAnchor: () => BORROWER_ANCHOR,
    lenderAnchor: () => LENDER_ANCHOR,
    requestId: () => REQUEST_ID,
    signedAcceptTerms: () => planSteps().find((st) => st.id === 'l-sign' && st.status === 'consumed')?.record ?? null,
  }),
);
console.log(`pre   write plan: ${planSteps().map((st) => `${st.id}${st.optional ? '?' : ''}`).join(' → ')}`);

// The touched-state ledger's BASELINE, at the same pinned block as every
// other precondition and before any write. Every entry must be readable: a
// failure report that cannot say what the state was is no use, so an
// unreadable baseline BLOCKS the drive (nothing written yet).
LEDGER_BASELINE = await precondition('snapshotting the touched-state ledger at the pinned block', async () => {
  const snap = await readLedger(pre.head);
  const bad = Object.entries(snap).filter(([, r]) => !r.ok);
  if (bad.length) throw new Error(`unreadable: ${bad.map(([k, r]) => `${k} (${r.error})`).join('; ')}`);
  return snap;
});
console.log(
  `pre   ledger baseline @${pre.head}: ` +
    LEDGER.map((e) => `${e.key} = ${e.format(LEDGER_BASELINE[e.key].value)}`).join(' | '),
);
const baselineCollateral = pre.b.collateral;
const baselineNonces = { borrower: pre.b.nonceLatest, lender: pre.l.nonceLatest };
BASELINE_NONCES = baselineNonces;
console.log(`pre   borrower collateral WALLET baseline @${pre.head}: ${baselineCollateral}`);
if (process.env.REFI_PREFLIGHT_ONLY === '1') {
  // Read-only rehearsal: every precondition above held, nothing launched.
  console.log('\nREFI_PREFLIGHT_ONLY=1 — preconditions hold; stopping before any browser or write.');
  process.exit(0);
}

// =====================================================================
// BOTH browser sessions are established — launched, gated, first page
// open — BEFORE the first write (Codex #2422 r1 P1). A setup failure here
// has written nothing, so BLOCKED is honest; the same failure after the
// borrower had posted would have exited 2 from inside `launch()`,
// skipping the catch/finally and the transaction report while a live
// request stood on chain. With both sessions in hand, nothing after the
// first write depends on browser setup, and every later failure takes
// the FAIL path below.
//
// `onSetupFailure: 'throw'` so a failure on the SECOND launch can close
// the first before exiting: `blocked()` closes only the browser it last
// registered.
// =====================================================================
const sessions = { borrower: null, lender: null };
async function closeSession(role) {
  const s = sessions[role];
  sessions[role] = null;
  try {
    await s?.done();
  } catch {
    /* closing is best effort */
  }
}
/** A state race observed BEFORE any write (#2422 r9): close both sessions
 *  and exit BLOCKED — `blockedBeforeAnyWrite` turns it into FAIL with the
 *  full report if anything had in fact been allowed. */
async function blockedByRace(why, err) {
  await closeSession('borrower');
  await closeSession('lender');
  await blockedBeforeAnyWrite(why, err);
}
for (const role of ['borrower', 'lender']) {
  try {
    sessions[role] = await launch({
      role,
      onSetupFailure: 'throw',
      startChainId: CHAIN_ID,
      pinnedChainId: CHAIN_ID,
      signingGate: signingGateFor(role),
    });
    await seedProfile(sessions[role].ctx);
    // Keep the wallet's own refusal log past the session's close (#2422 r5).
    walletLogs[role] = sessions[role].blockedRequests;
  } catch (err) {
    await closeSession('borrower');
    await closeSession('lender');
    await blockedBeforeAnyWrite(`setting up the ${role} browser session failed before any write`, err);
  }
}

// Both pages must render in English BEFORE anything can be written — every
// disclosure check below matches the English catalogue. A page that is not
// English here is BLOCKED (nothing written yet).
for (const role of ['borrower', 'lender']) {
  const page = sessions[role].page;
  let lang = '';
  try {
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    lang = await renderedLang(page);
  } catch (err) {
    await closeSession('borrower');
    await closeSession('lender');
    await blockedBeforeAnyWrite(`opening ${SITE} in the ${role} session failed before any write`, err);
  }
  console.log(`pre   ${role} page language: <html lang="${lang}">`);
  if (!isEnglish(lang)) {
    await closeSession('borrower');
    await closeSession('lender');
    await blockedBeforeAnyWrite(
      `the ${role} page renders <html lang="${lang}">, not English — every disclosure check matches the English catalogue`,
    );
  }
}

// A page that asked to sign anything while the plan was CLOSED has halted
// the drive. Nothing was written (the request was refused), but it is a
// product finding, not a missing precondition — so FAIL, with the report.
if (HALT || refusals.length || walletRefusals().length) {
  console.log(`\nSTOPPED (FAIL): a page asked to sign before any phase was armed — ${HALT ?? 'see refusals'}`);
  await closeSession('borrower');
  await closeSession('lender');
  await report(BASELINE_NONCES);
  process.exit(1);
}
// Both page preflights passed. The plan STAYS CLOSED (#2422 r8): the
// borrower role is armed only immediately before the confirmed submit,
// after the position card and the review have been checked, so anything
// the position page asks the wallet for while it loads is refused.
console.log('pre   write plan CLOSED — each role is armed only for its confirmed submit');

// =====================================================================
// From here on, chain state may change: no BLOCKED exits.
// =====================================================================
let exitCode = 0;
let session = sessions.borrower; // the session `shot()` on a stop targets
let requestId = null;
let acceptHash = null;

/** The request as its createOffer stored it (pinned to the create block,
 *  RULE 2) — set by `verifyCreateOutcome`. */
let REQUEST_AS_CREATED = null;
/** The watched-config snapshot the reviews were last judged against (the
 *  read just before the lender is armed) — what the settlement must use. */
let REVIEWED_CONFIG = null;
/** Which outcome verifiers have started — the classifier runs one only once. */
const VERIFY_STARTED = { create: false, accept: false };
/** The post-write classifier's last decision, and its FAIL reason if any. */
let POST_WRITE = null;
let POST_WRITE_FAIL = null;

/**
 * PHASE 2 — what the createOffer did, from its receipt (#2422 r14: a
 * function, so the post-write classifier can run it when the createOffer
 * MINED but the page never said the request was live). Pins the request,
 * checks its terms (scoped, RULE 2), and stops before the lender phase on any
 * mismatch. `pageRequestId` is null when the page named no id.
 */
async function verifyCreateOutcome(pageRequestId) {
  VERIFY_STARTED.create = true;
  // -------------------------------------------------------------------
  // 2. Pin the request on chain from the createOffer receipt itself.
  // -------------------------------------------------------------------
  // Every assertion in this phase GATES the lender phase: a request that
  // is not exactly the one reviewed must never be funded, so a failure
  // here stops the drive rather than only being recorded (Codex #2422 r1).
  const phase2From = checks.length;
  // An allowed send whose provider returned no hash is an UNKNOWN, not an
  // absence: it may have been broadcast. Stop rather than reason past it;
  // the report reconciles it against the borrower's nonce.
  const unhashedB = sendsOf('borrower').filter((t) => !t.hash);
  if (unhashedB.length) {
    stop(`borrower send(s) with no hash — outcome unknown: ${unhashedB.map((t) => t.purpose).join(', ')}`);
  }
  const createTx = hashedSends('borrower').find((t) => t.purpose.startsWith('createOffer'));
  if (!createTx) stop('no createOffer transaction was captured at the wallet boundary');
  const createRcpt = await pub.waitForTransactionReceipt({ hash: createTx.hash, timeout: 180_000 });
  check('createOffer receipt status success', createRcpt.status === 'success', createRcpt.status, 'request.receipt');
  for (const t of hashedSends('borrower')) {
    const r = await pub.waitForTransactionReceipt({ hash: t.hash, timeout: 180_000 });
    if (r.status !== 'success') stop(`borrower tx ${t.hash} (${t.purpose}) reverted`);
  }
  const createDecoded = diamondEvents(createRcpt);
  check('every Diamond log in the createOffer receipt decodes', createDecoded.undecodable === 0, `${createDecoded.undecodable} undecodable`, 'request.receipt');
  const created = createDecoded.events.filter((e) => e.eventName === 'OfferCreated');
  if (created.length !== 1) stop(`createOffer receipt carries ${created.length} OfferCreated events`);
  requestId = created[0].args.offerId;
  // Only now can the lender's plan steps be judged; until this line they
  // refuse, so no lender write could precede the request's pinning.
  REQUEST_ID = requestId;
  // The page's id is compared when the page named one; when it did not, the
  // UI failure is its own failed check (recorded by the classifier).
  if (pageRequestId !== null) {
    check('page names the same request id the receipt created', pageRequestId === requestId, `page #${pageRequestId}, receipt #${requestId}`, 'request.receipt');
  }

  const atCreate = createRcpt.blockNumber;
  const createRcptTs = (await pub.getBlock({ blockNumber: atCreate })).timestamp;
  // RULE 2 (#2422 r10): what the createOffer did is read from ITS receipt,
  // or from a state difference across its block only when no other
  // transaction in that block touched the Diamond or the borrower's wallet
  // or vault. Nothing here is compared against the preflight.
  const borrowerVaultAtCreate = await read('getUserVaultAddress', [BORROWER], atCreate);
  const CREATE = await scopeOf(createRcpt, 'createOffer', { borrower: BORROWER, 'borrower vault': borrowerVaultAtCreate });
  const beforeCreate = atCreate - 1n;
  // The offer index across the create block: exactly one new id, the request.
  const [idsBefore, idsAfter] = await Promise.all([allOfferIdsOf(BORROWER, beforeCreate), allOfferIdsOf(BORROWER, atCreate)]);
  const before = new Set(idsBefore.map(String));
  const newIds = idsAfter.map(String).filter((id) => !before.has(id));
  scopedCheck(
    CREATE,
    'exactly one new borrower offer across the create block (full index), and it is the request',
    newIds.length === 1 && newIds[0] === String(requestId),
    `${newIds.join(',') || 'none'} of ${idsAfter.length}`,
    'request.onlyOffer',
  );
  const req = await read('getOfferDetails', [requestId], atCreate);
  REQUEST_AS_CREATED = req;
  const terms = (label, ok, observed) => scopedCheck(CREATE, label, ok, observed, 'request.terms');
  terms(`request refinanceTargetLoanId == ${LOAN_ID}`, req.refinanceTargetLoanId === LOAN_ID, req.refinanceTargetLoanId);
  terms('request refinanceCarryOver == true', req.refinanceCarryOver === true, req.refinanceCarryOver);
  terms('request is a borrower offer by the borrower', Number(req.offerType) === 1 && eq(req.creator, BORROWER), `${req.offerType} ${req.creator}`);
  terms(`request rate ceiling == ${RATE_BPS} bps (typed ${RATE_PCT}%)`, req.interestRateBpsMax === RATE_BPS, req.interestRateBpsMax);
  terms('request rate floor == 0 (a borrow request is a 0..ceiling band)', req.interestRateBps === 0n, req.interestRateBps);
  terms(`request durationDays == ${DAYS_N}`, req.durationDays === DAYS_N, req.durationDays);
  terms('request amount == old principal', req.amount === loan.principal, req.amount);
  terms('request lending asset == old principal asset', eq(req.lendingAsset, loan.principalAsset), req.lendingAsset);
  terms('request collateral identity == old collateral', eq(req.collateralAsset, loan.collateralAsset) && req.collateralAmount === loan.collateralAmount, `${req.collateralAsset} × ${req.collateralAmount}`);
  terms('request not yet accepted', req.accepted === false, req.accepted);
  terms('request records the borrower\u2019s consent', req.creatorRiskAndTermsConsent === true, req.creatorRiskAndTermsConsent);
  terms('request carries no Full-tariff opt-in', req.creatorFull === false, req.creatorFull);
  // The stored expiry is EXACT (#2422 r13): the expiry the createOffer
  // actually SUBMITTED (decoded from its own calldata), clamped as
  // OfferCreateFacet clamps a refinance-tagged request — to the target
  // loan's grace deadline + 1 — using the loan and the grace buckets as they
  // stood just before the create (scoped by RULE 2 like every term here).
  const createInput = (await pub.getTransaction({ hash: createTx.hash })).input;
  const submittedExpiry = decodeFunctionData({ abi: DIAMOND_ABI, data: createInput }).args[0].expiresAt;
  const [loanBeforeCreate, cfgBeforeCreate] = await Promise.all([loanOf(LOAN_ID, beforeCreate), readObservedConfig(beforeCreate)]);
  const wantExpiry = expectedStoredExpiry({
    submitted: submittedExpiry,
    startTime: loanBeforeCreate.startTime,
    durationDays: loanBeforeCreate.durationDays,
    graceSeconds: graceSecondsFrom(cfgBeforeCreate.graceBuckets, loanBeforeCreate.durationDays),
  });
  terms(
    'request expiry is exactly the submitted expiry, clamped to the loan\u2019s grace deadline as the contract clamps it',
    BigInt(req.expiresAt) === wantExpiry && BigInt(req.expiresAt) > createRcptTs,
    `stored ${req.expiresAt}, submitted ${submittedExpiry}, expected ${wantExpiry}${wantExpiry !== BigInt(submittedExpiry) ? ' (clamped to the grace deadline)' : ''}; block ts ${createRcptTs}`,
  );
  console.log(
    `info  request persisted: rate floor ${req.interestRateBps} bps, ceiling ${req.interestRateBpsMax} bps, ` +
      `collateralLiquidity ${req.collateralLiquidity}, useFullTermInterest ${req.useFullTermInterest}, ` +
      `creatorRiskAndTermsConsent ${req.creatorRiskAndTermsConsent}, expiresAt ${req.expiresAt}`,
  );
  const capsNow = await read('getAutoRefinanceCaps', [LOAN_ID], atCreate);
  console.log(`info  caps after posting: enabled ${capsNow.enabled}, maxRateBps ${capsNow.maxRateBps}, maxNewExpiry ${capsNow.maxNewExpiry}`);
  // Collateral custody at posting (#2422 r10): the create receipt moves no
  // collateral out of the borrower's wallet or vault, and — scoped — neither
  // balance changed across the create block.
  const postOut = [
    ...collateralMovedOut({ logs: createRcpt.logs, token: loan.collateralAsset, from: BORROWER, assetType: loan.collateralAssetType }),
    ...collateralMovedOut({ logs: createRcpt.logs, token: loan.collateralAsset, from: borrowerVaultAtCreate, assetType: loan.collateralAssetType }),
  ];
  check(
    'the createOffer receipt moves no collateral out of the borrower\u2019s wallet or vault',
    postOut.length === 0,
    postOut.join(' | ') || 'none',
    'collateralCarryOver.postNoCollateralOut',
  );
  const collAt = (who, at) => tokenBalance(loan.collateralAsset, who, at);
  const [pw0, pw1, pv0, pv1] = await Promise.all([
    collAt(BORROWER, beforeCreate),
    collAt(BORROWER, atCreate),
    collAt(borrowerVaultAtCreate, beforeCreate),
    collAt(borrowerVaultAtCreate, atCreate),
  ]);
  scopedCheck(
    CREATE,
    'posting moved no collateral: the borrower\u2019s wallet and vault balances are unchanged across the create block',
    pw1 === pw0 && pv1 === pv0,
    `wallet ${pw0} → ${pw1}, vault ${pv0} → ${pv1}`,
    'collateralCarryOver.postBalances',
  );
  const phase2Failed = checks.slice(phase2From).filter((c) => !c.ok);
  if (phase2Failed.length) {
    stop(
      `the posted request does not match what was reviewed (${phase2Failed.map((c) => c.label).join('; ')}) — ` +
        `NOT proceeding to the lender phase. Request #${requestId} is live on chain; cancel it from the ` +
        `borrower's position page once its cooldown opens.`,
    );
  }
  // A request whose terms could not be established in isolation is not
  // funded: that is UNDETERMINED, not a FAIL (exit 3).
  if (CREATE.reason) raceStop(`not funding request #${requestId}: its terms could not be read in isolation — ${CREATE.reason}`);
}

/**
 * PHASES 4–5 — what the accept did, from its receipt and its isolated block
 * (#2422 r14: a function, so the post-write classifier can run it when the
 * accept MINED but the page missed it — the UI failure is then its own
 * failed check, and the chain outcome is still established).
 */
async function verifyAcceptOutcome() {
  // -------------------------------------------------------------------
  // 4. On-chain outcome, pinned at or after the accept's block.
  // -------------------------------------------------------------------
  VERIFY_STARTED.accept = true;
  if (!REVIEWED_CONFIG) stop('internal: the accept is being verified but no reviewed config was recorded before arming');
  const unhashedL = sendsOf('lender').filter((t) => !t.hash);
  if (unhashedL.length) {
    stop(`lender send(s) with no hash — outcome unknown: ${unhashedL.map((t) => t.purpose).join(', ')}`);
  }
  const acceptTx = hashedSends('lender').find((t) => t.purpose.startsWith('acceptOffer'));
  if (!acceptTx) stop('no accept transaction was captured at the wallet boundary');
  acceptHash = acceptTx.hash;
  for (const t of hashedSends('lender')) {
    const r = await pub.waitForTransactionReceipt({ hash: t.hash, timeout: 180_000 });
    if (r.status !== 'success') stop(`lender tx ${t.hash} (${t.purpose}) reverted`);
  }
  const acc = await pub.waitForTransactionReceipt({ hash: acceptHash, timeout: 180_000 });
  check('accept receipt status success', acc.status === 'success', acc.status, 'replacement.events');
  const accDecoded = diamondEvents(acc);
  check('every Diamond log in the accept receipt decodes', accDecoded.undecodable === 0, `${accDecoded.undecodable} undecodable`, 'replacement.events');
  const evs = accDecoded.events;
  const accepted = evs.filter((e) => e.eventName === 'OfferAccepted' && e.args.offerId === requestId);
  const refinanced = evs.filter((e) => e.eventName === 'LoanRefinanced');
  if (accepted.length !== 1) stop(`accept receipt carries ${accepted.length} OfferAccepted events for #${requestId}`);
  const newLoanId = accepted[0].args.loanId;
  console.log(`info  accept events: ${evs.map((e) => e.eventName).join(', ')}`);
  check('replacement is a DIFFERENT loan', newLoanId !== LOAN_ID, newLoanId, 'replacement.events');
  check(
    'LoanRefinanced(old → new, newLender = lender) emitted',
    refinanced.length === 1 &&
      refinanced[0].args.oldLoanId === LOAN_ID &&
      refinanced[0].args.newLoanId === newLoanId &&
      eq(refinanced[0].args.newLender, LENDER) &&
      eq(refinanced[0].args.borrower, BORROWER),
    refinanced.map((e) => `${e.args.oldLoanId}→${e.args.newLoanId} newLender ${e.args.newLender} oldStatus ${e.args.oldLoanNewStatus}`).join('; '),
    'replacement.events',
  );

  const floor = acc.blockNumber;
  const prev = floor - 1n;
  // RULE 2 (#2422 r10): every assertion about what the accept did is read
  // from its receipt, or from state across its block only when no other
  // transaction there touched the Diamond (whose state includes the position
  // NFTs) or a participant's wallet or vault. The same isolation guards the
  // receipt-MODEL checks below, whose inputs (fee posture, position holder,
  // payoff) are state read at the block before.
  // Every post-accept read is PINNED (#2422 r11): to `floor` for what the
  // accept produced, to `prev` for what it started from — never "latest".
  const [oldAtPrev, oldAtFloor] = await Promise.all([loanOf(LOAN_ID, prev), loanOf(LOAN_ID, floor)]);
  // THE PAYOUT OWNER, derived as RefinanceFacet derives it (#2422 r11): the
  // accept first consolidates the old loan's stored lender to the current
  // lender-NFT holder (`eagerConsolidateToHolder`, skip-not-block), then
  // deposits the lender due into `oldLoan.lender`'s vault. So the owner is
  // the stored lender read at `floor` — after the consolidation — and it is
  // cross-checked against the NFT holder at `prev`.
  const oldHolderAtPrev = await read('ownerOf', [oldAtPrev.lenderTokenId], prev);
  const PAYOUT = payoutOwnerOf({
    storedLenderAtFloor: oldAtFloor.lender,
    storedLenderAtPrev: oldAtPrev.lender,
    holderAtPrev: oldHolderAtPrev,
    floor,
    prev,
  });
  const payoutOwner = PAYOUT.owner;
  const [borrowerVault, lenderVault, oldLenderVault] = await Promise.all([
    read('getUserVaultAddress', [BORROWER], floor),
    read('getUserVaultAddress', [LENDER], floor),
    read('getUserVaultAddress', [payoutOwner], floor),
  ]);
  const payoutEvidence = `${PAYOUT.evidence}; its vault ${oldLenderVault}`;
  console.log(`info  ${payoutEvidence}`);
  const ACCEPT = await scopeOf(acc, 'the accept', {
    borrower: BORROWER,
    lender: LENDER,
    'old lender (stored before the accept)': oldAtPrev.lender,
    'payout owner': payoutOwner,
    'old position holder': oldHolderAtPrev,
    'borrower vault': borrowerVault,
    'lender vault': lenderVault,
    'old lender vault': oldLenderVault,
  });
  // The old loan's new status, from the receipt itself.
  check(
    `the accept receipt's LoanRefinanced names loan ${LOAN_ID}'s new status Repaid (1)`,
    refinanced.length === 1 && Number(refinanced[0].args.oldLoanNewStatus) === LOAN_STATUS.REPAID,
    refinanced.map((e) => e.args.oldLoanNewStatus).join(', ') || 'no LoanRefinanced',
    'oldLoanClosed.event',
  );
  scopedCheck(
    ACCEPT,
    `old loan ${LOAN_ID} status == 1 (Repaid) at the accept block ${floor}`,
    oldAtFloor.status === LOAN_STATUS.REPAID,
    oldAtFloor.status,
    'oldLoanClosed.status',
  );
  const fresh = await loanOf(newLoanId, floor);
  // Who HOLDS the replacement's position NFTs, at the accept's block — the
  // stored parties say who the loan was opened for; the NFTs say who can
  // act on it (#2422 r6 P2). Read failures throw, and so fail the run.
  const [newBorrowerHolder, newLenderHolder] = await Promise.all([
    read('ownerOf', [fresh.borrowerTokenId], floor),
    read('ownerOf', [fresh.lenderTokenId], floor),
  ]);
  scopedCheck(
    ACCEPT,
    'replacement borrower position NFT is held by the borrower role',
    eq(newBorrowerHolder, BORROWER),
    `token ${fresh.borrowerTokenId} → ${newBorrowerHolder}`,
    'replacement.positionNfts',
  );
  scopedCheck(
    ACCEPT,
    'replacement lender position NFT is held by the accepting lender role',
    eq(newLenderHolder, LENDER),
    `token ${fresh.lenderTokenId} → ${newLenderHolder}`,
    'replacement.positionNfts',
  );
  // THE REPLACEMENT, field by field, through ONE declared mapping (#2422
  // r14, ROOT B, replacementMapping.mjs): every Loan field is checked as a
  // signed term, a carried value, a reviewed config value or a value the
  // accept block determines — or declared unchecked with its reason (those
  // are listed under NOT VERIFIED). The evidence names every field.
  const signedStep = planSteps().find((st) => st.id === 'l-sign' && st.status === 'consumed');
  const signedTerms = signedStep?.record?.params ? JSON.parse(signedStep.record.params[1]).message : null;
  if (!signedTerms) stop('internal: the accept mined but the signed AcceptTerms were not recorded');
  const replacementEval = evaluateReplacement(fresh, {
    newLoanId,
    requestId,
    acceptor: LENDER,
    acceptTs: (await pub.getBlock({ blockNumber: floor })).timestamp,
    terms: signedTerms,
    request: REQUEST_AS_CREATED,
    oldLoan: oldAtPrev,
    reviewedConfig: REVIEWED_CONFIG,
  });
  scopedCheck(
    ACCEPT,
    `replacement loan ${newLoanId} matches the declared field mapping (${replacementEval.evidence.length} fields; ${replacementEval.unchecked.length} declared unchecked)`,
    replacementEval.mismatches.length === 0,
    (replacementEval.mismatches.length ? replacementEval.mismatches : replacementEval.evidence).join(' | '),
    'replacement.loan',
  );
  // The fees the replacement STAMPED at origination are the ones reviewed
  // (#2422 r12): `_snapshotFeeBps` writes the live treasury fee and — for an
  // ERC-20 origination — the live LIF rate onto the new loan. Compared with
  // the snapshot the reviews were judged against. (Its other *AtInit stamps
  // — fallback, health-factor and LTV parameters — are shown on neither
  // review, so they are not claimed here.)
  scopedCheck(
    ACCEPT,
    'replacement fee stamps equal the reviewed fees (treasuryFeeBpsAtInit, loanInitiationFeeBpsAtInit)',
    BigInt(fresh.treasuryFeeBpsAtInit) === BigInt(REVIEWED_CONFIG.treasuryFeeBps) &&
      BigInt(fresh.loanInitiationFeeBpsAtInit) === BigInt(REVIEWED_CONFIG.lifBps),
    `treasury ${fresh.treasuryFeeBpsAtInit} (reviewed ${REVIEWED_CONFIG.treasuryFeeBps}), LIF ${fresh.loanInitiationFeeBpsAtInit} (reviewed ${REVIEWED_CONFIG.lifBps})`,
    'replacement.feeStamps',
  );
  const reqAfter = await read('getOfferDetails', [requestId], floor);
  scopedCheck(ACCEPT, 'request marked accepted', reqAfter.accepted === true, reqAfter.accepted, 'replacement.requestAccepted');
  // An unreadable index is UNKNOWN, and an assertion that could not be
  // made fails — it is never skipped (#2422 r6 P2).
  let lenderLoans = null;
  let lenderLoansErr = null;
  try {
    lenderLoans = await read('getUserActiveLoans', [LENDER], floor);
  } catch (e) {
    lenderLoansErr = String(e.shortMessage ?? e.message).slice(0, 120);
  }
  scopedCheck(
    ACCEPT,
    'replacement listed among the lender\u2019s active loans',
    lenderLoans !== null && lenderLoans.includes(newLoanId),
    lenderLoans === null ? `UNKNOWN — the active-loan index could not be read (${lenderLoansErr})` : `${lenderLoans.length} loans`,
    'replacement.lenderIndex',
  );
  // -------------------------------------------------------------------
  // 5. The collateral, the lien and the settlement (#2422 r8, r9), read at
  // the block BEFORE the accept (`prev`) and at the accept block (`floor`).
  // Every expected figure comes from the contract's own views at `prev`.
  //
  // TRANSACTION SCOPE (RULE 2, r9/r10, `scopeOf`). The accept receipt's own
  // logs are this transaction's alone. A BLOCK DIFF (state at `floor` minus
  // state at `prev`) covers every transaction in the accept block, so it is
  // attributed to the accept only when no other transaction in that block
  // touched the Diamond or a participant's wallet or vault — established from
  // the block's receipts, never assumed. When another one did, or the
  // receipts cannot be read, each block-diff check AND each receipt-model
  // check is UNDETERMINED with that reason; receipt-only checks still judge.
  // -------------------------------------------------------------------
  /** A block-diff check of the accept: scoped by RULE 2. */
  const stateDiff = (label, ok, observed, at) => scopedCheck(ACCEPT, label, ok, observed, at);

  // Collateral: wallet and vault unchanged across the accept block, and no
  // collateral token left the borrower's vault in the accept itself.
  const collBalance = (who, at) => tokenBalance(loan.collateralAsset, who, at);
  const [walletPrev, walletEnd, vaultPrev, vaultEnd] = await Promise.all([
    collBalance(BORROWER, prev),
    collBalance(BORROWER, floor),
    collBalance(borrowerVault, prev),
    collBalance(borrowerVault, floor),
  ]);
  console.log(`info  borrower collateral wallet: preflight ${baselineCollateral} → accept block ${walletEnd}`);
  stateDiff(
    'borrower collateral WALLET balance unchanged across the accept (carry-over, not re-pledge)',
    walletEnd === walletPrev,
    `${walletPrev} → ${walletEnd}`,
    'collateralCarryOver.walletAtAccept',
  );
  stateDiff(
    `borrower collateral VAULT (${borrowerVault}) balance unchanged across the accept`,
    vaultEnd === vaultPrev,
    `${vaultPrev} → ${vaultEnd}`,
    'collateralCarryOver.vaultAtAccept',
  );
  const collOut = collateralMovedOut({
    logs: acc.logs,
    token: loan.collateralAsset,
    from: borrowerVault,
    assetType: loan.collateralAssetType,
  });
  check(
    'the accept receipt moves no collateral out of the borrower’s vault',
    collOut.length === 0,
    collOut.join(' | ') || 'none',
    'collateralCarryOver.noCollateralOut',
  );

  const [lienOldBefore, lienOldAfter, lienNewAfter] = await Promise.all([
    read('getLoanCollateralLien', [LOAN_ID], prev),
    read('getLoanCollateralLien', [LOAN_ID], floor),
    read('getLoanCollateralLien', [newLoanId], floor),
  ]);
  const fmtLien = (l) => `${l.user} ${l.asset} type ${l.assetType} #${l.tokenId} × ${l.amount}${l.released ? ' RELEASED' : ''}`;
  const lienDiff = lienMismatches({
    oldBefore: lienOldBefore,
    oldAfter: lienOldAfter,
    newAfter: lienNewAfter,
    expected: {
      user: BORROWER,
      asset: loan.collateralAsset,
      assetType: loan.collateralAssetType,
      tokenId: loan.collateralTokenId,
      amount: loan.collateralAmount,
    },
  });
  stateDiff(
    `collateral lien moved intact: loan ${LOAN_ID}'s released and zeroed, loan ${newLoanId}'s live with the same borrower, asset, type, tokenId and amount`,
    lienDiff.length === 0,
    lienDiff.join(' | ') ||
      `old @${prev}: ${fmtLien(lienOldBefore)}; old @${floor}: ${fmtLien(lienOldAfter)}; new @${floor}: ${fmtLien(lienNewAfter)}`,
    'collateralCarryOver.liens',
  );

  // The settlement.
  // The WHOLE watched snapshot at the accept's prestate (#2422 r12): the
  // settlement model's fee inputs come from it, and it must equal the
  // snapshot the reviews were judged against.
  const [repayDue, cfgAtPrev, tsPrev, tsAccept] = await Promise.all([
    read('calculateRepaymentAmount', [LOAN_ID], prev),
    readObservedConfig(prev),
    pub.getBlock({ blockNumber: prev }).then((b) => b.timestamp),
    pub.getBlock({ blockNumber: floor }).then((b) => b.timestamp),
  ]);
  const reviewDrift = configChanges(REVIEWED_CONFIG, cfgAtPrev);
  const { treasury } = cfgAtPrev;
  // The app's payoff formula must agree with the contract's view — the
  // borrower's review quoted the formula, and the accept pays the view.
  const formulaPrev = refinancePayoffAt(oldAtPrev, tsPrev);
  check(
    `the contract's payoff view equals the app's payoff formula at block ${prev}`,
    repayDue === formulaPrev,
    `calculateRepaymentAmount ${repayDue}, formula ${formulaPrev}`,
    'settlement.payoffView',
  );
  const MODEL_CHECKS = ['oldLenderClaim', 'transfers', 'wallets', 'vaults'];
  if (!pre.premises.holds) {
    // Stated NOT VERIFIED before the first write; nothing to judge here.
    console.log('info  settlement: NOT VERIFIED by this run (the default fee posture did not hold at preflight — see the pre-write summary)');
  } else {
    // The premises again, at the block before the accept: the same reads,
    // the CURRENT exiting holder, and the request's Full opt-in. Plus the
    // belt-and-braces post-write guards: a discount event in the receipt, or
    // a payoff that stepped between the two blocks. Any of them means the
    // model's premises did not hold for the accept — UNDETERMINED, not FAIL.
    const atPrev = await readSettlementPremises(prev, {
      holder: oldHolderAtPrev,
      requestId,
    });
    const discounts = evs.filter((e) => e.eventName === 'VPFIYieldFeeDiscountApplied' || e.eventName === 'VPFIDiscountApplied');
    // RULE 2 (#2422 r10): the model's inputs are state at the block before
    // the accept; another transaction in the accept's block, ahead of it,
    // could have moved them — so the model is judged only in isolation.
    const premiseBroken = settlementBlocker({
      prev,
      isolation: ACCEPT.reason,
      reviewDrift,
      premisesAtPrev: atPrev,
      discountEvents: discounts.map((e) => e.eventName),
      payoffStep:
        refinancePayoffAt(oldAtPrev, tsAccept) !== formulaPrev ? { tsPrev, tsAccept } : null,
    });
    if (premiseBroken) {
      for (const key of MODEL_CHECKS) MANIFEST.undetermined('settlement', key, premiseBroken);
      console.log(`UNDET settlement — ${premiseBroken}`);
    } else {
      const S = expectedSettlement({
        repayDue,
        oldPrincipal: oldAtPrev.principal,
        treasuryFeeBpsAtInit: oldAtPrev.treasuryFeeBpsAtInit,
        newPrincipal: fresh.principal,
        lifBps: cfgAtPrev.lifBps,
        matcherBps: cfgAtPrev.lifMatcherFeeBps,
      });
      console.log(
        `info  settlement model @${prev}: payoff ${repayDue} = principal ${oldAtPrev.principal} + interest ${S.interestPortion}; ` +
          `treasury share ${S.treasuryShare} (${S.feeBps} bps); lender due ${S.lenderDue}; LIF ${S.lif} (${cfgAtPrev.lifBps} bps), ` +
          `matcher cut ${S.matcherCut} (${cfgAtPrev.lifMatcherFeeBps} bps); treasury ${treasury}`,
      );
      const [claimBefore, claimAfter] = await Promise.all([
        read('getClaimable', [LOAN_ID, true], prev),
        read('getClaimable', [LOAN_ID, true], floor),
      ]);
      stateDiff(
        `the old lender's claim on loan ${LOAN_ID} rose by exactly the payoff less the treasury share, in the principal asset, unclaimed`,
        claimAfter[1] - claimBefore[1] === S.lenderDue && eq(claimAfter[0], loan.principalAsset) && claimAfter[2] === false,
        `${claimBefore[1]} → ${claimAfter[1]} ${claimAfter[0]} claimed ${claimAfter[2]} (expected +${S.lenderDue}); ${payoutEvidence}`,
        'settlement.oldLenderClaim',
      );
      // The principal token's Transfer logs in THIS receipt — the only
      // figures attributable to this transaction alone, whatever else the
      // block held (the treasury is a shared address).
      const transfers = [];
      const unreadable = [];
      for (const l of acc.logs.filter((x) => eq(x.address, loan.principalAsset))) {
        try {
          const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics });
          if (e.eventName === 'Transfer') transfers.push(e.args);
          else if (e.eventName !== 'Approval') unreadable.push(e.eventName);
        } catch {
          unreadable.push(`undecodable log ${l.topics[0]}`);
        }
      }
      const wantTransfers = expectedPrincipalTransfers(S, {
        borrower: BORROWER,
        lender: LENDER,
        lenderVault,
        treasury,
        oldLenderVault,
        newPrincipal: fresh.principal,
      });
      const transferDiff = [...transferMismatches(wantTransfers, transfers), ...unreadable.map((u) => `unexpected principal-token log: ${u}`)];
      check(
        `the accept receipt's principal-token transfers are exactly the ${wantTransfers.length} the settlement prescribes (treasury legs included)`,
        transferDiff.length === 0,
        `${transferDiff.join(' | ') || transfers.map((t) => `${t.from}→${t.to} ${t.value}`).join('; ')}; ${payoutEvidence}`,
        'settlement.transfers',
      );
      const delta = async (who) => {
        const [a, b] = await Promise.all([
          tokenBalance(loan.principalAsset, who, prev),
          tokenBalance(loan.principalAsset, who, floor),
        ]);
        return b - a;
      };
      // Judged per UNIQUE ADDRESS against the sum of every expected leg
      // (#2422 r12): the payout vault may BE the borrower's or the lender's
      // vault, and then the chain shows their sum.
      const observedOf = async (label, address) => ({ label, address, delta: await delta(address) });
      const wallets = balanceDeltaMismatches(wantTransfers, await Promise.all([
        observedOf('borrower wallet', BORROWER),
        observedOf('lender wallet', LENDER),
      ]));
      stateDiff(
        'wallets: each unique wallet moved by the sum of its expected legs (the borrower: net principal in, payoff out; the lender: principal out, matcher cut in)',
        wallets.mismatches.length === 0,
        (wallets.mismatches.length ? wallets.mismatches : wallets.rows).join(' | '),
        'settlement.wallets',
      );
      const vaults = balanceDeltaMismatches(wantTransfers, await Promise.all([
        observedOf('payout vault', oldLenderVault),
        observedOf('borrower vault', borrowerVault),
        observedOf('lender vault', lenderVault),
      ]));
      stateDiff(
        'vaults: each unique vault moved by the sum of its expected legs (the payout vault: the lender due in; the others: nothing net)',
        vaults.mismatches.length === 0,
        `${(vaults.mismatches.length ? vaults.mismatches : vaults.rows).join(' | ')}; ${payoutEvidence}`,
        'settlement.vaults',
      );
    }
  }

  // Every write the wallets made is one the gate allowed AND saw a hash
  // for: the mined nonce delta equals the hashed sends, nothing pending.
  // Each role is its OWN manifest check, recorded only when its own read
  // succeeds (#2422 r9): one role's evidence never stands in for the other.
  for (const role of ['borrower', 'lender']) {
    const who = ROLE_ADDRESS[role];
    const r = await checkRoleNonces({
      role,
      readNonces: async () => {
        const [latest, pending] = await Promise.all([
          pub.getTransactionCount({ address: who, blockTag: 'latest' }),
          pub.getTransactionCount({ address: who, blockTag: 'pending' }),
        ]);
        return { latest, pending };
      },
      baseline: baselineNonces[role],
      hashed: hashedSends(role).length,
      allowed: sendsOf(role).length,
      record: (key, ok, observed) =>
        check(`${role}: nonce delta == consumed plan transactions, all with a hash, none pending`, ok, observed, `writeDiscipline.${key}`),
    });
    if (!r.recorded) {
      console.log(`UNKNOWN ${role}: nonces unreadable (${r.error}) — writeDiscipline.${role}Nonces stays NOT RUN, so the run cannot PASS`);
    }
  }
  console.log(`\nresult  request offer #${requestId} → replacement loan #${newLoanId}; old loan #${LOAN_ID} closed`);
}

/** Whether one of OUR plan steps mined successfully (its own receipt). */
async function ourStepMined(id) {
  const st = planSteps().find((x) => x.id === id && x.status === 'consumed');
  if (!st?.record?.hash) return false;
  try {
    return (await pub.waitForTransactionReceipt({ hash: st.record.hash, timeout: 120_000 })).status === 'success';
  } catch {
    return false;
  }
}

/**
 * Every premise, re-read now (#2422 r14 ROOT A (ii)): the whole watched
 * snapshot — every participant's sanctions screening included — against the
 * snapshot the run was judged against; the request's state by
 * `requestStateOf` (with the replacement scan when it was filled); the loan's
 * supported posture while our accept has not mined. Never throws: an
 * unreadable premise is returned as `{ error }`.
 */
async function premisesNow({ acceptMined }) {
  try {
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    const cfg = await readObservedConfig(head);
    const configMoves = configChanges(REVIEWED_CONFIG ?? OBSERVED_BASELINE, cfg);
    let request = null;
    if (REQUEST_ID !== null) {
      request = { id: REQUEST_ID, state: await requestStateAt(REQUEST_ID, head) };
      if (request.state === 'accepted') {
        RUN_REQUEST = { state: 'known', id: REQUEST_ID };
        try {
          request.replacement = await replacementAt(head);
        } catch (e) {
          request.scanError = String(e.shortMessage ?? e.message).slice(0, 160);
        }
      }
    }
    const posture = acceptMined
      ? []
      : postureMisses(await loanOf(LOAN_ID, head)).map((m) => `${m.field} is ${m.value} (supported: ${m.want})`);
    return { configChanges: configMoves, request, postureMisses: posture };
  } catch (e) {
    return { error: String(e.shortMessage ?? e.message ?? e).slice(0, 160) };
  }
}

/**
 * THE ONE PLACE A FAILURE IS SETTLED (#2422 r14 ROOT A). The post-write
 * try's only catch calls this, so every stop or error after the first write
 * goes through `classifyPostWriteFailure`: verify the outcome of a
 * transaction of ours that mined (recording the UI failure as its own
 * failed check), or re-read every premise and call it a race when one
 * moved — FAIL only when nothing did. Before any write, a stop is a product
 * FAIL as it always was (a pre-write race exits BLOCKED where it is found).
 */
async function settleFailure(err) {
  let current = err;
  for (let round = 0; current && round < 3; round++) {
    const why = current instanceof Stop ? current.message : `unexpected error: ${String(current.shortMessage ?? current.message ?? current).split('\n')[0]}`;
    console.log(`\nSTOPPED: ${why}`);
    if (!(current instanceof Stop) && current?.stack) console.log(String(current.stack).split('\n').slice(1, 4).join('\n'));
    if (!anythingAllowed()) {
      console.log('(no plan step was consumed before the drive stopped — nothing was written)');
      exitCode = 1;
      return;
    }
    const kind = causeKindOf(current, { RaceStop, Stop });
    const acceptMined = await ourStepMined('l-accept');
    const ours = { acceptMined, createMined: await ourStepMined('b-create'), verified: { ...VERIFY_STARTED } };
    const premises = kind === 'race' ? null : await premisesNow({ acceptMined });
    POST_WRITE = classifyPostWriteFailure({ cause: { kind, why }, ours, premises });
    console.log(`CLASSIFIED (${kind}) → ${POST_WRITE.action}: ${POST_WRITE.why}`);
    if (POST_WRITE.action === 'race') {
      RACE_STOP = RACE_STOP ?? POST_WRITE.why;
      return;
    }
    if (POST_WRITE.action === 'fail') {
      POST_WRITE_FAIL = POST_WRITE.why;
      return;
    }
    const accept = POST_WRITE.action === 'verify-accept';
    if (POST_WRITE.recordUiFailure) {
      check(`the page failed after our ${accept ? 'accept' : 'createOffer'} mined: ${why}`, false, 'the chain outcome is verified below regardless', accept ? 'uiFlow.lenderDone' : 'uiFlow.borrower');
    }
    current = null;
    try {
      if (accept) await verifyAcceptOutcome();
      else await verifyCreateOutcome(null);
    } catch (e) {
      current = e;
    }
  }
}

try {
  // -------------------------------------------------------------------
  // 1. Borrower posts the refinance request through the form.
  // -------------------------------------------------------------------
  const bp = session.page;
  await bp.goto(`${SITE}/positions/${LOAN_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureConnected(bp);
  const bLang = await renderedLang(bp);
  check('borrower page renders English (every disclosure is matched against en.json)', isEnglish(bLang), bLang, 'uiFlow.borrower');

  const card = bp.locator('section.card').filter({ hasText: 'Refinance this loan' });
  if (!(await card.first().waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) {
    await session.shot('refinance-01-no-card');
    stop('the "Refinance this loan" card never rendered for the stored borrower in Advanced mode');
  }
  check('borrower: "Refinance this loan" card renders on /positions/' + LOAN_ID, true, undefined, 'uiFlow.borrower');

  // #2349/#2355 posture disclosure — judged against the chain's switches.
  const banner = card.locator('[data-auto-match-posture]');
  // RULE 1 (#2422 r10, `observeConfig`): the banner is judged only against
  // switches that held still around its observation — read before and after
  // it, and equal to the preflight's. A move is a state race: BLOCKED here,
  // before any write. Never a product FAIL.
  const bannerObs = await observeConfig('the posture banner', async () => {
    const posture = await pollUntil('posture banner settles', async () => {
      const a = await banner.first().getAttribute('data-auto-match-posture', { timeout: 2_000 });
      return a && a !== 'unknown' ? a : null;
    }, { timeoutMs: 45_000 });
    const text = posture ? (await banner.first().innerText()).replace(/\s+/g, ' ').trim() : null;
    return { posture, text };
  });
  const postureNow = expectedPostureFrom(bannerObs.config);
  check(
    `borrower: posture banner states the chain's posture at the observation (${postureNow})`,
    bannerObs.observed.posture === postureNow && bannerObs.observed.text?.includes(postureCopy[postureNow]),
    `${bannerObs.observed.posture}: "${bannerObs.observed.text}"`,
    'borrowerReview.posture',
  );

  await card.getByLabel(/highest yearly rate/i).fill(RATE_PCT);
  await card.getByLabel(/new loan length/i).fill(DAYS);
  const review = card.getByRole('button', { name: /review refinance request/i });
  if (!(await pollUntil('review enabled', () => review.isEnabled(), { timeoutMs: 60_000 }))) {
    await session.shot('refinance-02-review-disabled');
    stop('"Review refinance request" never enabled');
  }
  await review.click();

  // The receipt the borrower consents to — kept as evidence.
  const receiptText = (await card.innerText()).replace(/\s+/g, ' ').trim();
  console.log(`\n--- refinance review (as rendered) ---\n${receiptText.slice(0, 2500)}\n---`);
  check('borrower: review says the collateral carries over', /carries over|without ever unlocking/i.test(receiptText), undefined, 'borrowerReview.receipt');
  await session.shot('refinance-03-review');
  // The figures the borrower is about to consent to, against the chain
  // (#2422 r7). A mismatch or an unparseable row halts before consent.
  // RULE 1: the fee rates and grace window it quotes are judged against the
  // config read around the observation (BLOCKED on a race — nothing written).
  const bObs = await observeConfig('the borrower\u2019s review', () => receiptRows(card));
  const bTerms = await borrowerReviewMismatches(bObs.observed, bObs.config);
  check(
    `borrower: review figures match the chain (${bTerms.compared.join(', ')})`,
    bTerms.mismatches.length === 0,
    bTerms.mismatches.join(' | ') || `all ${bTerms.compared.length} terms match`,
    'borrowerReview.receipt',
  );

  // Rule B: nothing below may lead to a write if anything above failed.
  // Rule A: arm the gate with the three complete requests the form may
  // sign, then open it — the confirm is the one action that may write.
  beforeWriteStep('ticking the borrower consent');
  const confirm = card.getByRole('button', { name: /confirm — post refinance request/i });
  const consentBox = card.locator('input[type="checkbox"]');
  const confirmed = await pollUntil('consent + confirm enabled', async () => {
    beforeWriteStep('ticking the borrower consent');
    if (!(await consentBox.isChecked())) await consentBox.check();
    return confirm.isEnabled();
  }, { timeoutMs: 60_000 });
  if (HALT) stop(`not posting: ${HALT}`);
  if (!confirmed) {
    await session.shot('refinance-04-confirm-disabled');
    stop('"Confirm — post refinance request" never enabled after consent');
  }
  beforeWriteStep('posting the refinance request');
  BORROWER_ANCHOR = await chainNow();
  console.log(`info  borrower anchor (chain time at submit start): ${BORROWER_ANCHOR}`);
  // Arm the borrower role NOW — the card, posture and review checks above
  // have passed, and the next action is the confirmed submit (#2422 r8).
  PLAN.arm('borrower');
  console.log('info  write plan ARMED for the borrower’s confirmed submit');
  await confirm.click();

  const live = await pollUntil('request is live', async () => {
    if (refusals.length || HALT) return 'refused';
    const err = card.locator('.banner-danger');
    if (await err.count()) return `error: ${(await err.first().innerText()).trim()}`;
    const t = await bp.locator('body').innerText();
    const m = t.match(/Refinance request #(\d+) is live/i);
    return m ? m[1] : null;
  }, { timeoutMs: 300_000, everyMs: 2_000 });
  await session.shot('refinance-05-posted');
  if (refusals.length) stop('the borrower form asked for a write the gate had not armed');
  if (HALT) stop(`halted while posting: ${HALT}`);
  if (!live || live.startsWith('error')) {
    stop(`the refinance request did not go live: ${live ?? 'timed out'}`);
  }
  // The borrower's submit has settled: nothing may be signed until the
  // lender's confirmed submit arms the plan again.
  PLAN.close();
  console.log('info  write plan CLOSED after the borrower’s submit');
  const pageRequestId = BigInt(live);

  // Pending card carries the posture disclosure too.
  const pendingCard = bp.locator('section.card').filter({ hasText: new RegExp(`Refinance request #${pageRequestId} is live`, 'i') });
  // RULE 1, after the borrower's write: a race is UNDETERMINED, not FAIL.
  const cardObs = await observeConfig('the standing request card', async () => {
    try {
      return {
        posture: await pendingCard.locator('[data-auto-match-posture]').first().getAttribute('data-auto-match-posture', { timeout: 30_000 }),
        err: null,
      };
    } catch (e) {
      return { posture: null, err: String(e.message).split('\n')[0].slice(0, 120) };
    }
  });
  if (cardObs.undetermined) {
    MANIFEST.undetermined('borrowerReview', 'posture', cardObs.undetermined);
    console.log(`UNDET borrower: the standing request card's posture — ${cardObs.undetermined} (card showed ${cardObs.observed?.posture ?? cardObs.observed?.err})`);
  } else {
    const want = expectedPostureFrom(cardObs.config);
    check(
      `borrower: the standing request card discloses the posture (${want})`,
      cardObs.observed.posture === want,
      cardObs.observed.err ? `UNREADABLE — ${cardObs.observed.err}` : cardObs.observed.posture,
      'borrowerReview.posture',
    );
  }

  await verifyCreateOutcome(pageRequestId);

  await closeSession('borrower');
  // The request is pinned and every request check passed. The plan stays
  // CLOSED through the lender's page loads and review checks; the lender
  // role is armed immediately before "Fund this borrower".

  // -------------------------------------------------------------------
  // 3. A DIFFERENT lender funds it through the Offer Book → guided review.
  // The session already exists (launched and gated before any write).
  // -------------------------------------------------------------------
  session = sessions.lender;
  const lp = session.page;
  const expectedHref = `/lend?offer=${requestId}&chain=${CHAIN_ID}`;
  let reachedViaBook = false;
  await lp.goto(`${SITE}/offers`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureConnected(lp);
  const lLang = await renderedLang(lp);
  check('lender page renders English (every disclosure is matched against en.json)', isEnglish(lLang), lLang, 'uiFlow.lender');
  const fundLink = await pollUntil('request row in the Offer Book', async () => {
    // Someone else may have filled it in the meantime — stop, don't race.
    // Explicitly about NOW (#2422 r11): has anyone filled it yet?
    const o = await read('getOfferDetails', [requestId]);
    if (o.accepted) return 'taken';
    const row = lp.locator('.item-row').filter({ hasText: new RegExp(`offer #${requestId}\\b`) });
    if ((await row.count()) === 0) {
      await lp.reload({ waitUntil: 'domcontentloaded' });
      await lp.waitForTimeout(4_000);
      return null;
    }
    const link = row.first().getByRole('link', { name: /fund this request/i });
    if ((await link.count()) === 0) return `row-without-cta: ${(await row.first().innerText()).replace(/\s+/g, ' ')}`;
    return link.first();
  }, { timeoutMs: 300_000, everyMs: 6_000 });
  if (fundLink === 'taken') {
    // Filled by SOMEONE ELSE while we waited (#2422 r13): a race with the
    // open market or the order matcher — UNDETERMINED (exit 3), with the
    // replacement reported — unless the chain shows something actually
    // wrong (accepted, yet no loan carries it): then FAIL.
    RUN_REQUEST = { state: 'known', id: requestId };
    let replacement = null;
    let scanError = null;
    try {
      replacement = await replacementAt(await pub.getBlockNumber({ cacheTime: 0 }));
    } catch (e) {
      scanError = String(e.shortMessage ?? e.message).slice(0, 160);
    }
    const fill = externalFillVerdict({ requestId, replacement, scanError });
    if (fill.kind === 'fail') stop(fill.why);
    raceStop(fill.why);
  }
  if (typeof fundLink === 'string') {
    await session.shot('refinance-06-row-no-cta');
    stop(`the Offer Book row for request #${requestId} offers no "Fund this request" CTA: ${fundLink}`);
  }
  if (fundLink) {
    const href = await fundLink.getAttribute('href');
    check('Offer Book "Fund this request" links to the guided accept', href === expectedHref, href, 'offerBook.cta');
    const rowText = (await lp.locator('.item-row').filter({ hasText: new RegExp(`offer #${requestId}\\b`) }).first().innerText()).replace(/\s+/g, ' ');
    console.log(`info  book row: ${rowText}`);
    // A disclosure, judged like every other (#2422 r4 P2): a book row that
    // does not tag the collateral as illiquid fails and halts — the lender
    // must not be led from an undisclosed row into a funding review.
    check(
      `Offer Book row for #${requestId} carries the illiquid-collateral tag (copy.offers.illiquidCollateralTag)`,
      rowText.includes(squash(bookIlliquidTag)),
      rowText,
      'offerBook.illiquidTag',
    );
    await session.shot('refinance-06-book-row');
    await fundLink.click();
    reachedViaBook = true;
  } else {
    // The indexer never listed it within the window. The CTA's target is
    // still a UI route, so the accept itself stays a UI accept — but the
    // discovery path is a finding.
    note(`request #${requestId} did not appear in the Offer Book within 5 min (indexer ingest?) — opened the CTA's own target ${expectedHref} directly`);
    MANIFEST.defer(
      'offerBook',
      `the indexer did not list request #${requestId} within 5 minutes, so the lender opened the CTA’s own target directly — no Offer Book row was seen`,
      null,
    );
    await lp.goto(`${SITE}${expectedHref}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  console.log(`info  lender reached the request via ${reachedViaBook ? 'the Offer Book CTA' : 'the CTA target directly'}`);

  const banner2 = lp.getByText(new RegExp(`funding borrow request #${requestId}\\b`, 'i'));
  if (!(await banner2.first().waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) {
    const body = (await lp.locator('body').innerText()).replace(/\s+/g, ' ');
    await session.shot('refinance-07-no-review');
    stop(`the guided accept did not open the review for request #${requestId}: ${body.slice(0, 600)}`);
  }
  check(`lender: review opens as "You’re funding borrow request #${requestId}"`, true, undefined, 'uiFlow.lender');

  const submit = lp.getByRole('button', { name: /fund this borrower/i });
  const consent = lp.locator('label:has(a[href="/help#risks"]) input[type="checkbox"]').last();
  // Let the review settle (liquidity, grace, dry run) before judging it:
  // a disclosure arriving later clears consent by design.
  await pollUntil('review settled', async () => {
    const t = await lp.locator('body').innerText();
    return !/preparing|checking/i.test(t.slice(t.indexOf('Before you sign')));
  }, { timeoutMs: 45_000 });

  // The DISCLOSURES are judged BEFORE consent is given (#2422 r2 P1): the
  // lender must not consent to — or sign — a review that failed to say the
  // collateral is illiquid. Under rule B the failed check halts, and the
  // `beforeWriteStep` below stops before the consent tick and the submit.
  const reviewText = (await lp.locator('main').innerText().catch(() => lp.locator('body').innerText())).replace(/\s+/g, ' ');
  console.log(`\n--- lender review (as rendered, before consent) ---\n${reviewText.slice(0, 4000)}\n---`);
  if (/would fail|will fail|revert/i.test(reviewText)) note('the lender review shows a would-fail / revert note (see the transcript above)');
  check('lender: review carries the illiquid-collateral warning (copy.match.illiquidWarning)', reviewText.includes(squash(illiquidWarning)), undefined, 'lenderReview.illiquidWarning');
  // Evidence, not a verdict: the spec does not say whether a lender funding
  // a refinance request must be told it closes another loan.
  if (!/refinanc/i.test(reviewText)) {
    note('the lender review never says this request refinances an existing loan (accepting it also pays off and closes that loan)');
  }
  await session.shot('refinance-08-lender-review');
  // The figures the lender is about to consent to, against the request on
  // chain and the live fee config (#2422 r7) — before the consent tick.
  //
  // RULE 1 (#2422 r10): the yield fee and grace window are judged against
  // the config read around the observation. The borrower's write has
  // already landed, so a race here cannot be BLOCKED: it is UNDETERMINED,
  // and the drive stops BEFORE the lender's consent — a review nobody could
  // judge is not consented to (`raceStop`, exit 3, never a FAIL).
  // The request AS CREATED — read pinned to its create block under RULE 2
  // (#2422 r11: no post-write read uses "latest" unless its claim is about
  // now). Its terms are what the lender's review must show.
  const reqNow = REQUEST_AS_CREATED;
  const lObs = await observeConfig('the lender\u2019s review', () => receiptRows(lp.locator('main')));
  if (lObs.undetermined) {
    MANIFEST.undetermined('lenderReview', 'receipt', lObs.undetermined);
    raceStop(`not funding: ${lObs.undetermined}`);
  }
  const lTerms = lenderReviewMismatches(lObs.observed, reqNow, lObs.config);
  check(
    `lender: review figures match the request on chain (${lTerms.compared.join(', ')})`,
    lTerms.mismatches.length === 0,
    lTerms.mismatches.join(' | ') || `all ${lTerms.compared.length} terms match`,
    'lenderReview.receipt',
  );

  beforeWriteStep('ticking the lender consent');
  const canSign = await pollUntil('consent + "Fund this borrower" enabled', async () => {
    beforeWriteStep('ticking the lender consent');
    if (!(await consent.isChecked())) await consent.check();
    await lp.waitForTimeout(1_000);
    return submit.isEnabled();
  }, { timeoutMs: 120_000, everyMs: 3_000 });
  if (HALT) stop(`not funding: ${HALT}`);
  if (!canSign) {
    stop('the deployed UI never enabled "Fund this borrower" for this request (see the review transcript above)');
  }
  beforeWriteStep('submitting "Fund this borrower"');
  // ROOT A (iii) (#2422 r14): the request must still be OPEN when the lender
  // is armed. Filled, cancelled or expired → stop through the classifier
  // (an external fill is `externalFillVerdict`), and the lender is never armed.
  const stateBeforeArm = await requestStateAt(requestId, await pub.getBlockNumber({ cacheTime: 0 }));
  if (stateBeforeArm !== 'open') stop(`request #${requestId} is ${stateBeforeArm} before the lender is armed — not arming`);
  // RULE 1, once more, IMMEDIATELY before arming the lender (#2422 r11): the
  // watched config — the risk-terms epoch the AcceptTerms is anchored to
  // included — must still equal the preflight's. A move here is
  // UNDETERMINED and stops the run before the lender is armed.
  const armObs = await observeConfig('the lender\u2019s submit (risk-terms epoch, fees, grace, posture)', async () => null);
  if (armObs.undetermined) {
    MANIFEST.undetermined('lenderReview', 'receipt', armObs.undetermined);
    raceStop(`not arming the lender: ${armObs.undetermined}`);
  }
  // The config the reviews were judged against, as last confirmed before the
  // lender's write: the settlement must be computed from exactly this.
  REVIEWED_CONFIG = armObs.config;
  LENDER_ANCHOR = await chainNow();
  console.log(`info  lender anchor (chain time at submit start): ${LENDER_ANCHOR}`);
  PLAN.arm('lender');
  console.log('info  write plan ARMED for the lender’s confirmed submit');
  await submit.click();

  const outcome = await pollUntil('accept settles', async () => {
    if (refusals.length || HALT) return 'refused';
    if (await lp.getByRole('heading', { name: /loan opened/i }).count()) return 'opened';
    const err = lp.locator('.banner-danger[role="alert"]');
    if (await err.count()) {
      const t = (await err.first().innerText()).trim();
      // A submit error is final only once the button is idle again.
      if (await submit.isEnabled().catch(() => false)) return `error: ${t}`;
    }
    return null;
  }, { timeoutMs: 300_000, everyMs: 2_000 });
  await session.shot('refinance-09-lender-done');
  const doneText = (await lp.locator('body').innerText()).replace(/\s+/g, ' ');
  if (refusals.length) stop('the lender flow asked for a write the gate had not armed');
  if (HALT) stop(`halted while accepting: ${HALT}`);
  if (outcome !== 'opened') stop(`the lender's accept did not complete in the UI: ${outcome ?? 'timed out'}`);
  PLAN.close();
  console.log('info  write plan CLOSED after the lender’s submit');
  check('lender: the app reports "Loan opened"', true, undefined, 'uiFlow.lenderDone');
  const doneIdx = doneText.search(/loan opened/i);
  console.log(`info  lender done step: ${doneText.slice(doneIdx, doneIdx + 400)}`);

  await verifyAcceptOutcome();
} catch (err) {
  // EVERY failure after the first write is settled by ONE classifier
  // (#2422 r14 ROOT A); nothing here decides an exit code by itself.
  try {
    await session?.shot('refinance-zz-stopped');
  } catch {
    /* the page may already be gone */
  }
  await settleFailure(err);
} finally {
  await closeSession('borrower');
  await closeSession('lender');
}

// The write discipline's second half, judged over the WHOLE run: nothing
// was refused by the gate or the wallets, and the plan never latched.
const refusalText = `${refusals.length} gate refusal(s), ${walletRefusals().length} wallet refusal(s), plan ${PLAN?.refusal() ? `latched: ${PLAN.refusal()}` : 'not latched'}`;
if (POST_WRITE?.action === 'race' && refusals.length > 0 && walletRefusals().length === 0) {
  // A gate refusal the classifier traced to a moved premise (#2422 r14):
  // the gate did its job; whether the page misbehaved cannot be established.
  MANIFEST.undetermined('writeDiscipline', 'noRefusals', `${refusalText} — classified a race: ${POST_WRITE.why}`);
} else {
  check(
    'no write was refused by the gate or the wallets, and the plan never latched',
    refusals.length === 0 && walletRefusals().length === 0 && !PLAN?.refusal(),
    refusalText,
    'writeDiscipline.noRefusals',
  );
}
const reconciliation = await report(baselineNonces);
// Something observed WRONG — as opposed to a claim that could not be
// established (a race stop or an UNDETERMINED check, #2422 r9/r10).
// When a post-write failure was settled by the classifier (#2422 r14 ROOT
// A), ITS verdict says whether the stop — a refused write, a halt — was a
// product failure; otherwise they count as they always did.
const failure =
  exitCode !== 0 ||
  POST_WRITE_FAIL !== null ||
  walletRefusals().length > 0 ||
  reconciliation.unreconciled ||
  checks.some((c) => !c.ok) ||
  (POST_WRITE === null && (refusals.length > 0 || (HALT !== null && HALT !== RACE_STOP)));
const VERDICT = runVerdict({ rows: MANIFEST.rows(), failure, raceStop: RACE_STOP });
// Whatever this run may have left standing is reported whenever it did not
// PASS — a race stop leaves a live request, and an undetermined claim may
// hide a change.
if (VERDICT.exit !== 0) await reportAfterFailure();
// THE VERDICT IS THE MANIFEST (#2422 r8): what this run verified, with the
// reads behind it, and what it did not, with where that is covered. Exit
// codes and the outcome line come from ONE precedence rule (`runVerdict`):
// FAIL (1) > STOPPED/COMPLETED UNDETERMINED (3) > PASS (0).
console.log('');
for (const line of MANIFEST.render()) console.log(line);
console.log(`\n${VERDICT.line}`);
process.exit(VERDICT.exit);
