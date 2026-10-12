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
//      `OfferCreated` event — never from "newest offer" alone — and the
//      page's "Refinance request #N is live" must name that same id. (Its
//      terms were matched field by field by the write gate before the
//      createOffer was signed; they are not re-asserted as an outcome.)
//   3. A DIFFERENT lender (role `lender`) finds the request in the Offer
//      Book, presses its "Fund this request" CTA and accepts it through
//      the guided review ("Fund this borrower"). If the indexer has not
//      listed the request yet, the lender opens that CTA's own target
//      (`/lend?offer=<id>`) instead, and the drive records it: the accept
//      still runs through the app's review and signing. There is NO
//      scripted fallback: if the deployed UI cannot accept the request,
//      that is the finding, and the drive stops.
//   4. The outcome is asserted ONLY as far as the accept's receipt and
//      reads pinned to the accept block prove it directly (#2431 re-cut —
//      see THE VERDICT below): the old loan Repaid; exactly one replacement,
//      Active, same borrower, the accepting lender; the collateral lien
//      moved intact to it with no collateral leaving the borrower's vault.
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
// THE VERDICT IS AN OUTCOME MANIFEST (outcomeManifest.mjs), narrowed in the
// #2431 re-cut to what a RECEIPT and reads PINNED TO THE ACCEPT BLOCK prove
// directly. VERIFIED, each printed as verified only when every read it
// declares ran and passed:
//   requestIdentity       — the page's "Refinance request #N is live" names
//                           the OfferCreated id in the createOffer receipt
//                           (#2434 r2).
//   oldLoanClosed         — getLoanDetails(old) at the accept block: Repaid.
//   replacementOpened     — the accept receipt's OfferAccepted and
//                           LoanRefinanced name exactly one replacement id,
//                           and getLoanDetails(new) at the accept block shows
//                           Active, the same borrower and the request's lender.
//   collateralLienCarried — getLoanCollateralLien at the accept block: the
//                           old lien released, the replacement's live on the
//                           borrower's vault (user = the borrower) with the
//                           same asset/type/tokenId/amount; and the
//                           receipt has no collateral-token transfer out of
//                           the borrower's vault.
//   writeDiscipline       — no refusal, and each role's nonces reconcile
//                           with its consumed plan transactions.
// Everything else is printed under NOT VERIFIED BY THIS DRIVER with the
// reason and where it IS covered — the exact settlement amounts above all
// (claimable, wallet/vault deltas, transfer legs, fee stamps: the fork test
// and the RefinanceFacet suites), every other request and replacement term,
// the indexer after the accept, the grace-window case, liquid collateral,
// the old lender's claim, rewards. Modelling those here took fourteen review
// rounds of premises, block isolation and field mappings, each round finding
// a new edge; the re-cut deleted it rather than patching it (precedent
// #2149). Reads pinned to the accept block see that block's END state, so a
// later transaction in the same block could in principle change them; that
// is stated under NOT VERIFIED, and is acceptable for a status, a lien and
// an id.
//
// OBSERVATIONS ARE RACED BEFORE A WRITE (`observeConfig`, observation.mjs).
// Every check that compares something RENDERED with chain config (the
// posture banner; the fee rates and grace window on both reviews) reads the
// watched-config snapshot (watchedConfig.mjs — governance values and every
// participant's sanctions screening) before and after the observation and
// compares both with the preflight's. A difference is a state race: BLOCKED
// before any write; after one (the lender's review, the re-read just before
// the lender is armed) the drive stops before that write. The same re-read
// runs just before the BORROWER is armed (#2434 r2), where a move is
// BLOCKED. An observation that THROWS is still followed by its after-read:
// a moved config is a race, a stable one rethrows the observation's error.
// The request must still be open when the lender is armed. These are WRITE
// GATES, not claims.
//
// ONE FAILURE RULE (#2431 re-cut, `settleFailure` + `runVerdict`). Before
// any write, a failure is FAIL (a pre-write race is BLOCKED). After the
// first write, any stop is UNDETERMINED (exit 3), with the touched-state
// ledger and the replacement state printed — EXCEPT when a chain read
// positively contradicts an outcome claim: the app's "is live" banner
// naming a request other than the receipt's, the old loan still Active after
// our accept mined, our accept mined with no single replacement, or the lien
// not carried. Those are FAIL (exit 1), and so is a nonce count showing a
// transaction the gate never allowed. When the page fails after our accept
// MINED, the accept's claims are read from its receipt anyway, so a
// contradiction is never hidden behind a UI failure.
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
// leaves writeDiscipline unverified, so the run cannot PASS (a nonce count
// ABOVE what the gate allowed is a gate escape: FAIL). Once the gate has
// allowed anything, no exit is BLOCKED and nothing reports "nothing written".
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
// from both sessions and halt the drive; the run cannot PASS.
//
// MATURITY MARGIN. The loan must be at least two hours from maturity at
// preflight. Past maturity the payoff grows by the late fee, so a run that
// crossed the due date would sign a different deal from the one it
// reserved for and reviewed — refinancing in the grace window is a
// separate scenario, not this one. Two hours is over three times this
// drive's own worst case (about 35 minutes).
//
// Verdicts (the FOUR-verdict contract — FOUR_VERDICT_DRIVERS in
// verdictContract.mjs, which run-live-batch.mjs classifies by):
//   0 PASS     — the drive ran to the end and every VERIFIED claim of the
//                outcome manifest ran and passed (the NOT VERIFIED ones are
//                printed with their reasons and coverage).
//   1 FAIL     — BEFORE any write: a check failed (a review figure, a
//                disclosure, a page that would not complete a step) or a
//                page asked to sign while the plan was closed. AFTER a
//                write: only a chain read that contradicts an outcome claim
//                (the banner naming another request, old loan not Repaid
//                after our accept mined, no single replacement, the lien
//                not carried), or a nonce count
//                showing a transaction the gate never allowed.
//   2 BLOCKED  — a precondition did not hold BEFORE anything was written
//                (no REFI_LOAN_ID, site build mismatch, chain facts differ,
//                balances short, an open request already exists,
//                credentials missing, or either browser session could not
//                be set up — both are set up before the first write).
// Once the first transaction has been sent, nothing exits BLOCKED: the
// drive has changed chain state and its report must be read.
//   3 UNDETERMINED — anything else after the first write that is not a
//                PASS: a stop (a UI failure, a race, a refused write, a
//                reverted transaction, a request filled by someone else),
//                or an outcome claim whose reads could not run. Printed
//                "OUTCOME: UNDETERMINED" with what stopped the drive and
//                which claims were not established; the touched-state
//                ledger and the replacement state follow. Deliberately NOT
//                exit 0: an exit code is read without the line beside it,
//                and 0 would certify claims nobody established. Not 1 (no
//                chain read contradicts a claim) and not 2 (chain state has
//                changed). The driver DECLARES this fourth code in
//                FOUR_VERDICT_DRIVERS (#2434 r2), so a batch run would
//                report it as UNDETERMINED rather than FAIL; an exit 3 from
//                any undeclared driver stays a FAIL.
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
  erc20Abi,
  formatUnits,
  parseAbi,
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
import { observationVerdict, observeAgainstChain } from './observation.mjs';
import { readWatchedConfig } from './watchedConfig.mjs';
import { postureMisses } from './supportedPosture.mjs';
import {
  checkRoleNonces,
  collateralMovedOut,
  lienCarried,
  requestStateOf,
  scanForReplacement,
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
// THE OUTCOME MANIFEST (outcomeManifest.mjs) — what this drive's verdict
// claims, declared before anything runs. Narrowed in the #2431 re-cut to
// what a RECEIPT and reads PINNED TO THE ACCEPT BLOCK prove directly: three
// outcome claims plus the write discipline. Each VERIFIED claim names the
// reads behind it and prints as verified only when every one of them ran
// and passed. Everything else is stated under NOT VERIFIED BY THIS DRIVER,
// with the reason and where it is covered — nothing is left implied.
// ---------------------------------------------------------------------
const MANIFEST = createManifest({
  verifiable: [
    {
      id: 'requestIdentity',
      claim: 'the app named the request this run created',
      checks: {
        banner: 'the page\u2019s "Refinance request #N is live" banner: N equals the OfferCreated id in the createOffer receipt',
      },
    },
    {
      id: 'oldLoanClosed',
      claim: `loan ${LOAN_ID} is closed as Repaid`,
      checks: { status: `getLoanDetails(${LOAN_ID}).status pinned to the accept block` },
    },
    {
      id: 'replacementOpened',
      claim: 'the accept opened exactly one replacement loan: Active, for the same borrower, lent by the request\u2019s lender',
      checks: {
        events: 'the accept receipt: success, exactly one OfferAccepted for the request and exactly one LoanRefinanced(old → new), naming the same single replacement id',
        loan: 'getLoanDetails(replacement) pinned to the accept block: status Active, borrower = the old loan\u2019s, lender = the accepting lender',
      },
    },
    {
      id: 'collateralLienCarried',
      claim: 'the collateral lien moved from the old loan to the replacement, and the accept took no collateral out of the borrower\u2019s vault',
      checks: {
        liens: 'getLoanCollateralLien(old) and (replacement) pinned to the accept block: the old released, the replacement live, locking the borrower\u2019s vault (user = the borrower), with the same asset, type, tokenId and amount',
        noCollateralOut: 'the accept receipt\u2019s collateral-token logs: no Transfer (ERC-20/721) or TransferSingle/Batch (ERC-1155) out of the borrower\u2019s vault',
      },
    },
    {
      id: 'writeDiscipline',
      claim: 'every signature and transaction was the next step of the declared write plan, exactly, and the chain shows nothing the gate did not allow',
      checks: {
        borrowerNonces: 'the borrower\u2019s latest / pending nonce vs its consumed plan transactions, all with a hash — recorded only if that read succeeds',
        lenderNonces: 'the lender\u2019s latest / pending nonce vs its consumed plan transactions, all with a hash — recorded only if that read succeeds',
        noRefusals: 'the gate\u2019s and the wallets\u2019 refusal logs, and the plan\u2019s latch',
      },
    },
  ],
  notVerified: [
    {
      id: 'settlementAmounts',
      claim: 'the exact settlement amounts: the old lender\u2019s claimable, the wallet and vault deltas, the transfer-leg amounts and the treasury\u2019s, the replacement\u2019s fee stamps',
      reason: 'modelling them needs the fee posture, discounts and same-block isolation; this driver claims only what a receipt and pinned reads prove directly',
      coveredBy: 'contracts/test/fork/RefinanceIlliquidLiveForkTest.t.sol; contracts/test/RefinanceFacetTest.t.sol; contracts/test/FeeEntitlementFacetTest.t.sol',
    },
    {
      id: 'termsBeyondClaims',
      claim: 'every request and replacement term beyond the three claims: rate, length, interest mode, principal, expiry, consent, position-NFT holders, liquidity tags',
      reason: 'the createOffer and AcceptTerms the wallets signed are each matched field by field by the write gate before signing, but the state the contract stored from them is not re-asserted',
      coveredBy: 'contracts/test/RefinanceFacetTest.t.sol; contracts/test/fork/RefinanceIlliquidLiveForkTest.t.sol',
    },
    {
      id: 'reviewScreens',
      claim: 'what the review screens showed: their figures and disclosures',
      reason: 'each is checked before consent as a WRITE GATE (a mismatch stops the write), not claimed as an outcome',
      coveredBy: 'apps/app/e2e/live/reviewTerms.test.mjs (the parser, on the real loan-22 receipts)',
    },
    {
      id: 'oldLienTombstone',
      claim: 'the released old lien\u2019s remaining Encumbrance fields: user, asset, tokenId, amount, assetType',
      reason:
        'a released lien is a tombstone and `released` is the contract\u2019s source of truth; the claim is only that it is released (every field is declared in refinanceOutcome.mjs LIEN_FIELDS)',
      coveredBy: 'contracts/test/T092AutoLifecycleIntegrationTest.t.sol test_576_atomicRefinance_carriesCollateralOverViaLienRetag (released, amount zeroed)',
    },
    {
      id: 'sameBlockLater',
      claim: 'that no later transaction in the accept block changed the status, lien or loan read at that block\u2019s end',
      reason: 'the three claims read state pinned to the accept block, which a later same-block transaction could in principle change; accepted for these reads, since such a change would itself be another action on the same loans',
      coveredBy: null,
    },
    {
      id: 'indexerAfter',
      claim: 'after the accept, the indexer and the app\u2019s lists show the request filled and the replacement among both parties\u2019 positions',
      reason: 'the outcome is read on chain; the Offer Book is used only to find the request',
      coveredBy: null,
    },
    {
      id: 'graceWindow',
      claim: 'a refinance accepted inside the old loan\u2019s grace window settles with the late fee',
      reason: 'excluded by this drive\u2019s precondition (at least two hours before maturity)',
      coveredBy: 'contracts/test/RefinanceFacetTest.t.sol testRefinanceLoan_graceWindow_succeeds; PrecloseFacetTest.testPreclosedDirect_graceWindow_chargesLateFee',
    },
    {
      id: 'liquidCollateral',
      claim: 'refinancing a loan with LIQUID collateral (the replacement\u2019s HF / LTV gates)',
      reason: 'this drive refinances an illiquid-collateral loan only',
      coveredBy: 'apps/app/e2e/tests/29-refinance-completion.spec.ts (CI-Anvil)',
    },
    {
      id: 'oldLenderPayout',
      claim: 'the exiting lender can claim the settled payoff out of the protocol',
      reason: 'claiming it is a write outside this drive\u2019s plan',
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
        'not asserted — the app approves the payoff at the request\u2019s last fillable moment (late-fee headroom included), so an accept before that leaves the difference approved; loan 22\u2019s run left 0.0000764 WETH',
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
/** Stop the flow: an unexpected state. FAIL before any write; after one,
 *  UNDETERMINED unless a chain read contradicts a claim (`settleFailure`). */
class Stop extends Error {}
function stop(why) {
  halt(why);
  throw new Stop(why);
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
  let escaped = false;
  if (!baselineNonces && sendsOf().length > 0) {
    return { lines: ['no nonce baseline was taken — allowed sends cannot be reconciled'], unreconciled: true, escaped: false };
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
      escaped = true;
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
  return { lines, unreconciled, escaped };
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
// field the expected builders, the reserve and the review checks depend on,
// with the value they support. A loan outside it is BLOCKED here, by field
// and reason, before anything is written — the unsupported mode (a pro-rata
// or periodic loan, settled interest, a rental, liquid collateral) never
// reaches a write gate built for another one.
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

/** The request as its createOffer stored it, read at the create block — the
 *  terms the lender's review is compared with. */
let REQUEST_AS_CREATED = null;
/** Whether the accept outcome has been verified (it runs at most once). */
let ACCEPT_VERIFIED = false;
/** The stop that ended the drive, once anything was written; null if none. */
let STOPPED = null;

/**
 * The request this run created, from the createOffer's own receipt: the
 * receipt succeeded and carries exactly one OfferCreated, whose id the
 * lender's plan steps are then pinned to. The stored request is read at the
 * create block for the lender's review to be compared with; its terms are
 * NOT re-asserted as an outcome (the createOffer itself was matched field by
 * field by the write gate before it was signed, and the lender's AcceptTerms
 * binds every term the accept uses).
 */
async function pinRequestFromReceipt() {
  // An allowed send whose provider returned no hash is an UNKNOWN, not an
  // absence: it may have been broadcast. The report reconciles it by nonce.
  const unhashedB = sendsOf('borrower').filter((t) => !t.hash);
  if (unhashedB.length) stop(`borrower send(s) with no hash — outcome unknown: ${unhashedB.map((t) => t.purpose).join(', ')}`);
  const createTx = hashedSends('borrower').find((t) => t.purpose.startsWith('createOffer'));
  if (!createTx) stop('no createOffer transaction was captured at the wallet boundary');
  for (const t of hashedSends('borrower')) {
    const r = await pub.waitForTransactionReceipt({ hash: t.hash, timeout: 180_000 });
    if (r.status !== 'success') stop(`borrower tx ${t.hash} (${t.purpose}) reverted`);
  }
  const createRcpt = await pub.waitForTransactionReceipt({ hash: createTx.hash, timeout: 180_000 });
  const decoded = diamondEvents(createRcpt);
  const created = decoded.events.filter((e) => e.eventName === 'OfferCreated');
  if (decoded.undecodable > 0 || created.length !== 1) {
    stop(`the createOffer receipt carries ${created.length} OfferCreated event(s) and ${decoded.undecodable} undecodable Diamond log(s)`);
  }
  requestId = created[0].args.offerId;
  // Only now can the lender's plan steps be judged; until this line they
  // refuse, so no lender write could precede the request's pinning.
  REQUEST_ID = requestId;
  REQUEST_AS_CREATED = await read('getOfferDetails', [requestId], createRcpt.blockNumber);
  console.log(`info  createOffer ${createTx.hash} mined at block ${createRcpt.blockNumber}: request #${requestId}`);
}

/**
 * THE THREE OUTCOME CLAIMS (#2431 re-cut), from the accept's receipt and
 * reads PINNED TO THE ACCEPT BLOCK — nothing else:
 *   oldLoanClosed       — getLoanDetails(old) shows Repaid;
 *   replacementOpened   — the receipt names exactly one replacement (one
 *                         OfferAccepted for the request, one LoanRefinanced
 *                         old → new, the same id), and getLoanDetails(new)
 *                         shows Active, the same borrower, the accepting lender;
 *   collateralLienCarried — getLoanCollateralLien: old released, replacement
 *                         live with the same asset/type/tokenId/amount; and
 *                         no collateral-token transfer out of the borrower's
 *                         vault in the receipt.
 * Run on the happy path, and by `settleFailure` when our accept MINED but the
 * page failed — so a contradiction is never hidden behind a UI failure.
 */
async function verifyAcceptOutcome() {
  ACCEPT_VERIFIED = true;
  const acceptStep = planSteps().find((st) => st.id === 'l-accept' && st.status === 'consumed');
  if (!acceptStep?.record?.hash) stop('no accept transaction hash was captured at the wallet boundary');
  acceptHash = acceptStep.record.hash;
  const acc = await pub.waitForTransactionReceipt({ hash: acceptHash, timeout: 180_000 });
  if (acc.status !== 'success') stop(`our accept ${acceptHash} reverted at block ${acc.blockNumber}`);
  const floor = acc.blockNumber;
  const decoded = diamondEvents(acc);
  const accepted = decoded.events.filter((e) => e.eventName === 'OfferAccepted' && e.args.offerId === requestId);
  const refinanced = decoded.events.filter((e) => e.eventName === 'LoanRefinanced' && e.args.oldLoanId === LOAN_ID);
  const ids = [...new Set([...accepted.map((e) => e.args.loanId), ...refinanced.map((e) => e.args.newLoanId)].map(String))];
  console.log(`info  accept ${acceptHash} mined at block ${floor}: ${decoded.events.map((e) => e.eventName).join(', ')}`);
  check(
    'the accept receipt names exactly one replacement (one OfferAccepted for the request, one LoanRefinanced from this loan, the same id)',
    decoded.undecodable === 0 && accepted.length === 1 && refinanced.length === 1 && ids.length === 1 && BigInt(ids[0]) !== LOAN_ID,
    `OfferAccepted ${accepted.map((e) => `#${e.args.loanId}`).join(',') || 'none'}; LoanRefinanced ${refinanced.map((e) => `${e.args.oldLoanId}→#${e.args.newLoanId}`).join(',') || 'none'}; ${decoded.undecodable} undecodable`,
    'replacementOpened.events',
  );
  const [oldAtFloor, oldLienAfter] = await Promise.all([loanOf(LOAN_ID, floor), read('getLoanCollateralLien', [LOAN_ID], floor)]);
  check(`loan ${LOAN_ID} is Repaid (1) at the accept block ${floor}`, oldAtFloor.status === LOAN_STATUS.REPAID, oldAtFloor.status, 'oldLoanClosed.status');
  if (ids.length !== 1) return; // no single replacement to read; the claim above has failed
  const newLoanId = BigInt(ids[0]);
  const [fresh, newLien, borrowerVault] = await Promise.all([
    loanOf(newLoanId, floor),
    read('getLoanCollateralLien', [newLoanId], floor),
    read('getUserVaultAddress', [BORROWER], floor),
  ]);
  check(
    `replacement loan ${newLoanId} is Active, for the same borrower, lent by the accepting lender (at block ${floor})`,
    fresh.status === LOAN_STATUS.ACTIVE && eq(fresh.borrower, loan.borrower) && eq(fresh.lender, LENDER),
    `status ${fresh.status}, borrower ${fresh.borrower}, lender ${fresh.lender}`,
    'replacementOpened.loan',
  );
  const lienDiff = lienCarried({
    oldAfter: oldLienAfter,
    newAfter: newLien,
    expected: { user: loan.borrower, asset: loan.collateralAsset, assetType: loan.collateralAssetType, tokenId: loan.collateralTokenId, amount: loan.collateralAmount },
  });
  check(
    `the collateral lien moved: loan ${LOAN_ID}'s released, loan ${newLoanId}'s live on the borrower's vault with the same asset, type, tokenId and amount`,
    lienDiff.length === 0,
    lienDiff.join(' | ') || `old released ${oldLienAfter.released}; new user ${newLien.user}, ${newLien.asset} type ${newLien.assetType} #${newLien.tokenId} × ${newLien.amount}`,
    'collateralLienCarried.liens',
  );
  const out = collateralMovedOut({ logs: acc.logs, token: loan.collateralAsset, from: borrowerVault, assetType: loan.collateralAssetType });
  check('the accept receipt moves no collateral out of the borrower’s vault', out.length === 0, out.join(' | ') || 'none', 'collateralLienCarried.noCollateralOut');
  console.log(`\nresult  request offer #${requestId} → replacement loan #${newLoanId}; old loan #${LOAN_ID} status ${oldAtFloor.status}`);
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
 * THE ONE PLACE A FAILURE IS SETTLED (#2431 re-cut). Before any write, a
 * stop is a product FAIL (a pre-write race exits BLOCKED where it is found).
 * After the first write, the stop is recorded and the run is UNDETERMINED
 * (exit 3) — unless the accept MINED and its outcome has not been verified
 * yet: then the accept's claims are read anyway, so a chain read that
 * contradicts one of them is still a FAIL. `runVerdict` decides the exit.
 */
async function settleFailure(err) {
  const why = err instanceof Stop ? err.message : `unexpected error: ${String(err?.shortMessage ?? err?.message ?? err).split('\n')[0]}`;
  console.log(`\nSTOPPED: ${why}`);
  if (!(err instanceof Stop) && err?.stack) console.log(String(err.stack).split('\n').slice(1, 4).join('\n'));
  if (!anythingAllowed()) {
    console.log('(no plan step was consumed before the drive stopped — nothing was written)');
    exitCode = 1;
    return;
  }
  STOPPED = why;
  if (!ACCEPT_VERIFIED && (await ourStepMined('l-accept'))) {
    console.log('info  our accept MINED although the drive stopped — reading the accept\u2019s outcome claims from its receipt anyway');
    try {
      await verifyAcceptOutcome();
    } catch (e) {
      console.log(`info  the outcome could not be read in full: ${String(e?.shortMessage ?? e?.message ?? e).split('\n')[0]}`);
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
  check('borrower page renders English (every disclosure is matched against en.json)', isEnglish(bLang), bLang);

  const card = bp.locator('section.card').filter({ hasText: 'Refinance this loan' });
  if (!(await card.first().waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) {
    await session.shot('refinance-01-no-card');
    stop('the "Refinance this loan" card never rendered for the stored borrower in Advanced mode');
  }
  check('borrower: "Refinance this loan" card renders on /positions/' + LOAN_ID, true);

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
  check('borrower: review says the collateral carries over', /carries over|without ever unlocking/i.test(receiptText));
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
  // The same pre-arm re-read the lender gets (#2434 r2): the watched config
  // must still equal the preflight's — the config the review above was
  // judged against — IMMEDIATELY before the borrower is armed. Nothing has
  // been written yet, so a move exits BLOCKED inside `observeConfig`.
  const bArmObs = await observeConfig('the borrower\u2019s submit (fees, grace, posture, risk-terms epoch)', async () => null);
  if (bArmObs.undetermined) stop(`not arming the borrower: ${bArmObs.undetermined}`);
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
  console.log(`info  the page reports request #${live} is live`);

  // 2. The request, from the createOffer's own receipt.
  await pinRequestFromReceipt();
  // The app's own statement of WHICH request is live must be the one the
  // receipt created (#2434 r2). A different id is the app naming the wrong
  // lifecycle identity — a positive contradiction of `requestIdentity`, so
  // a FAIL even though a write has happened, and the drive stops here.
  if (
    !check(
      `the app's "Refinance request #N is live" names the request the createOffer receipt created (#${requestId})`,
      BigInt(live) === requestId,
      `page #${live}, receipt #${requestId}`,
      'requestIdentity.banner',
    )
  ) {
    stop(`the app reports request #${live} as live, but the createOffer receipt created #${requestId}`);
  }

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
  check('lender page renders English (every disclosure is matched against en.json)', isEnglish(lLang), lLang);
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
  // Filled by someone else while we waited: after a write that is a stop
  // like any other (UNDETERMINED); the failure report prints the
  // replacement state from the scan or the LoanRefinanced lookup.
  if (fundLink === 'taken') stop(`request #${requestId} was accepted by another party before the lender reached it`);
  if (typeof fundLink === 'string') {
    await session.shot('refinance-06-row-no-cta');
    stop(`the Offer Book row for request #${requestId} offers no "Fund this request" CTA: ${fundLink}`);
  }
  if (fundLink) {
    const href = await fundLink.getAttribute('href');
    check('Offer Book "Fund this request" links to the guided accept', href === expectedHref, href);
    const rowText = (await lp.locator('.item-row').filter({ hasText: new RegExp(`offer #${requestId}\\b`) }).first().innerText()).replace(/\s+/g, ' ');
    console.log(`info  book row: ${rowText}`);
    // A disclosure, judged like every other (#2422 r4 P2): a book row that
    // does not tag the collateral as illiquid fails and halts — the lender
    // must not be led from an undisclosed row into a funding review.
    check(
      `Offer Book row for #${requestId} carries the illiquid-collateral tag (copy.offers.illiquidCollateralTag)`,
      rowText.includes(squash(bookIlliquidTag)),
      rowText,
    );
    await session.shot('refinance-06-book-row');
    await fundLink.click();
    reachedViaBook = true;
  } else {
    // The indexer never listed it within the window. The CTA's target is
    // still a UI route, so the accept itself stays a UI accept — but the
    // discovery path is a finding.
    note(`request #${requestId} did not appear in the Offer Book within 5 min (indexer ingest?) — opened the CTA's own target ${expectedHref} directly`);
    await lp.goto(`${SITE}${expectedHref}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  console.log(`info  lender reached the request via ${reachedViaBook ? 'the Offer Book CTA' : 'the CTA target directly'}`);

  const banner2 = lp.getByText(new RegExp(`funding borrow request #${requestId}\\b`, 'i'));
  if (!(await banner2.first().waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) {
    const body = (await lp.locator('body').innerText()).replace(/\s+/g, ' ');
    await session.shot('refinance-07-no-review');
    stop(`the guided accept did not open the review for request #${requestId}: ${body.slice(0, 600)}`);
  }
  check(`lender: review opens as "You’re funding borrow request #${requestId}"`, true);

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
  check('lender: review carries the illiquid-collateral warning (copy.match.illiquidWarning)', reviewText.includes(squash(illiquidWarning)));
  // Evidence, not a verdict: the spec does not say whether a lender funding
  // a refinance request must be told it closes another loan.
  if (!/refinanc/i.test(reviewText)) {
    note('the lender review never says this request refinances an existing loan (accepting it also pays off and closes that loan)');
  }
  await session.shot('refinance-08-lender-review');
  // The figures the lender is about to consent to, against the request on
  // chain and the live fee config (#2422 r7) — before the consent tick.
  //
  // The yield fee and grace window are judged against the config read
  // around the observation (observation.mjs). A move stops the drive BEFORE
  // the lender's consent — a review nobody could judge is never consented
  // to. The request's terms are the ones stored at its create block.
  const reqNow = REQUEST_AS_CREATED;
  const lObs = await observeConfig('the lender\u2019s review', () => receiptRows(lp.locator('main')));
  if (lObs.undetermined) stop(`not funding: ${lObs.undetermined}`);
  const lTerms = lenderReviewMismatches(lObs.observed, reqNow, lObs.config);
  check(
    `lender: review figures match the request on chain (${lTerms.compared.join(', ')})`,
    lTerms.mismatches.length === 0,
    lTerms.mismatches.join(' | ') || `all ${lTerms.compared.length} terms match`,
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
  // The request must still be OPEN when the lender is armed: filled,
  // cancelled or expired → stop, and the lender is never armed.
  const stateBeforeArm = await requestStateAt(requestId, await pub.getBlockNumber({ cacheTime: 0 }));
  if (stateBeforeArm !== 'open') stop(`request #${requestId} is ${stateBeforeArm} before the lender is armed — not arming`);
  // RULE 1, once more, IMMEDIATELY before arming the lender (#2422 r11): the
  // watched config — the risk-terms epoch the AcceptTerms is anchored to
  // included — must still equal the preflight's. A move here is
  // UNDETERMINED and stops the run before the lender is armed.
  const armObs = await observeConfig('the lender\u2019s submit (risk-terms epoch, fees, grace, posture)', async () => null);
  if (armObs.undetermined) stop(`not arming the lender: ${armObs.undetermined}`);
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
  check('lender: the app reports "Loan opened"', true);
  const doneIdx = doneText.search(/loan opened/i);
  console.log(`info  lender done step: ${doneText.slice(doneIdx, doneIdx + 400)}`);

  await verifyAcceptOutcome();
} catch (err) {
  // EVERY failure is settled in ONE place (`settleFailure`); nothing here
  // decides an exit code by itself.
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

// THE WRITE DISCIPLINE, judged over the WHOLE run: nothing was refused by
// the gate or the wallets, the plan never latched, and each role's nonces
// account for exactly its consumed plan transactions — each role its own
// check, recorded only when its own read succeeds.
check(
  'no write was refused by the gate or the wallets, and the plan never latched',
  refusals.length === 0 && walletRefusals().length === 0 && !PLAN?.refusal(),
  `${refusals.length} gate refusal(s), ${walletRefusals().length} wallet refusal(s), plan ${PLAN?.refusal() ? `latched: ${PLAN.refusal()}` : 'not latched'}`,
  'writeDiscipline.noRefusals',
);
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
  if (!r.recorded) console.log(`UNKNOWN ${role}: nonces unreadable (${r.error}) — writeDiscipline.${role}Nonces stays NOT RUN`);
}
const reconciliation = await report(baselineNonces);
// ONE rule decides the exit (`runVerdict`, #2431 re-cut): before any write a
// stop is FAIL; after one, FAIL only when a chain read contradicts one of the
// outcome claims or the nonces show a transaction the gate never
// allowed — anything else that is not a clean PASS is UNDETERMINED (exit 3).
const VERDICT = runVerdict({
  rows: MANIFEST.rows(),
  wrote: anythingAllowed(),
  stopped: STOPPED,
  preWriteFailure: exitCode !== 0,
  gateEscape: reconciliation.escaped,
});
// Whatever this run may have left standing — the touched-state ledger, the
// replacement by scan or LoanRefinanced lookup — is printed whenever it did
// not PASS.
if (VERDICT.exit !== 0) await reportAfterFailure();
// THE VERDICT IS THE MANIFEST: what this run verified, with the reads behind
// it, and what it did not, with where that is covered.
console.log('');
for (const line of MANIFEST.render()) console.log(line);
console.log(`\n${VERDICT.line}`);
process.exit(VERDICT.exit);
