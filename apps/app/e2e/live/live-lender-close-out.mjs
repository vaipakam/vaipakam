// #2463 live verification — the lender's forced close-out of an overdue loan
// whose liquid collateral must be SOLD, against a real past-grace loan on the
// Base Sepolia Diamond.
//
// What is under test: the overdue card (`ForcedCloseCard`) on the deployed
// build offers the lender a close-out for a loan past its grace period, says
// the collateral is sold on an exchange the app routes, states no amount (the
// settlement path is chosen as the transaction executes), and — with CLOSE=1
// — sends exactly one `triggerDefault(loanId, adapterCalls)` carrying a
// non-empty try-list on the Diamond's ENABLED adapters, after which the chain
// records the close-out.
//
// Steps:
//   1. Build check: SITE_URL must serve the same `/assets/index-*.js` as
//      REFERENCE_SITE_URL (the workers.dev URL the deploy printed). alpha02 is
//      refused outright.
//   2. Chain: LOAN_ID is Active, past its grace period at the latest block,
//      and the ROLE wallet holds its lender position.
//   3. /positions/LOAN_ID: the card mounts, declares a ready state, and its
//      text states no monetary amount (`forcedCloseCard.mjs`).
//   4. CLOSE=1 only, and only when every check above passed: confirm the
//      close-out through the app, and require from the chain that the loan
//      left Active — Defaulted when the sale cleared the protocol's minimum,
//      FallbackPending when it did not (the card discloses both, so either is
//      the route working; a REVERT or a still-Active loan is a FAIL).
//
// Wallet posture: without CLOSE the injected wallet is read-only. With
// CLOSE=1 it is pinned to Base Sepolia and signs through the shared write plan
// (writePlan.mjs) holding ONE step: an eth_sendTransaction from this wallet
// to the Diamond, value 0, whose decoded call is triggerDefault(LOAN_ID, L)
// where L is a non-empty list whose every entry names an adapter index the
// Diamond lists and does not disable. The routes themselves are quoted at
// confirm time, so they are BOUNDED (`is`) rather than predicted. The plan is
// closed until the driver arms it for its own confirm click.
//
// The verdict is the shared one (outcomeManifest.mjs `runVerdict`): before the
// send any failed check is a FAIL; after it, a FAIL comes only from a chain
// read contradicting the outcome claim (`closedOut`), and every other
// post-send failure leaves the run UNDETERMINED.
//
//   SITE_URL=https://app.vaipakam.com \
//   REFERENCE_SITE_URL=https://<worker>.workers.dev \
//   TESTNET_WALLETS_FILE=… LOAN_ID=21 [ROLE=lender2] [CLOSE=1] \
//     node live-lender-close-out.mjs
//
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED, 3
// UNDETERMINED (with CLOSE=1 after the gate allowed the send, or in any mode
// when the plan sent nothing but the wallet nonce cannot be established).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits, parseEventLogs } from 'viem';
import {
  addressOf,
  blocked,
  blockedSync,
  clientsFor,
  ensureConnected,
  launch,
  requireSiteUrl,
  requireSigningRole,
  visit,
  READ_METHODS,
  watchPageRpc,
} from './driver.mjs';
import { is, optional, structMismatches } from './expectedPayload.mjs';
import { monetaryAmountsIn } from './forcedCloseCard.mjs';
import { Held, Suspect, changedFields, nonceBaseline, resolveSettlement, settleRun } from './noWriteSettlement.mjs';
import { createManifest, runVerdict } from './outcomeManifest.mjs';
import { attachLedger, createReadLedger } from './pageSanctionsReads.mjs';
import { readPinned } from './pinnedRead.mjs';
import { splitBlocked } from './readOnlyFindings.mjs';
import { decodeTxForComparison, expectedTx } from './refinanceExpected.mjs';
import { createWritePlan } from './writePlan.mjs';

const SITE_URL = requireSiteUrl();
const REFERENCE_SITE_URL = process.env.REFERENCE_SITE_URL ?? '';
if (!REFERENCE_SITE_URL) {
  blockedSync('REFERENCE_SITE_URL is required: the workers.dev URL of the deploy under review.');
}
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return blockedSync(`${u} is not a URL — check SITE_URL and REFERENCE_SITE_URL.`);
  }
};
for (const u of [SITE_URL, REFERENCE_SITE_URL]) {
  if (/alpha02\./i.test(hostOf(u))) {
    blockedSync(`${u} is alpha02 — it serves the frozen vaipakam-alpha02 Worker, not the deploy under review.`);
  }
}
if (!/\.workers\.dev$/i.test(hostOf(REFERENCE_SITE_URL))) {
  blockedSync(`REFERENCE_SITE_URL ${REFERENCE_SITE_URL} is not a workers.dev host — pass the URL the deploy printed.`);
}
const LOAN_ID = /^\d+$/.test(process.env.LOAN_ID ?? '') ? BigInt(process.env.LOAN_ID) : null;
if (LOAN_ID === null) blockedSync('LOAN_ID must be the overdue loan id.');
const ROLE = process.env.ROLE ?? 'lender';
requireSigningRole(ROLE);
const WALLET = addressOf(ROLE);
const SUBMIT = process.env.CLOSE === '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const CHAIN_ID = 84532;
const ACTIVE = 0;
const DEFAULTED = 2;
/** The one state this drive judges: a liquid-collateral close-out that the
 *  app must route as a SALE (#2463). */
const SALE_STATE = 'ready-needs-route';
/** The card's other ready states. Each is a valid answer for a loan of a
 *  different shape, so meeting one is a missing precondition (BLOCKED),
 *  never a product failure (#2481 r1). */
const OTHER_READY_STATES = new Set(['ready-in-kind', 'ready-internal-match', 'ready-rental']);

function readJson(rel) {
  const file = path.join(REPO, rel);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return blockedSync(`cannot read ${file}\n  ${err.message}`);
  }
}
const DIAMOND = readJson('packages/contracts/src/deployments.json')[String(CHAIN_ID)]?.diamond;
if (typeof DIAMOND !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(DIAMOND)) {
  blockedSync(`deployments bundle ${CHAIN_ID}.diamond is not an address: ${JSON.stringify(DIAMOND)}`);
}
const DIAMOND_ABI = readJson('packages/contracts/src/diamondAbi.json');
const COPY = readJson('apps/app/src/i18n/locales/en.json')?.copy ?? {};
const FC = COPY.forcedClose ?? {};
for (const k of ['submit', 'readyNeedsRoute', 'outcomeNoteSale']) {
  if (typeof FC[k] !== 'string') blockedSync(`en.json no longer carries copy.forcedClose.${k}`);
}
for (const k of ['saleReceipt', 'receipt', 'rentalReceipt']) {
  if (typeof FC[k]?.youReceive !== 'string') blockedSync(`en.json no longer carries copy.forcedClose.${k}.youReceive`);
}

// ── The outcome manifest and the write plan ────────────────────────────
const OUTCOME = ['closedOut'];
const CLOSE_ONLY = [
  {
    id: 'confirmSale',
    claim: 'the confirmation the lender signs under describes the sale',
    checks: {
      outcome: 'the confirm step carries copy.forcedClose.outcomeNoteSale',
      receipt: "the confirmation's own receipt is the SALE receipt (saleReceipt.youReceive), not the standard or rental one",
      preview: 'the exact request the app asks to sign previews (eth_simulateV1, logs) as a SALE — SwapAdapterSucceeded for this loan — before the gate allows it',
    },
  },
  {
    id: 'closedOut',
    claim: 'the close-out ran the sale: its receipt carries LoanDefaulted + SwapAdapterSucceeded (cleared) or LoanFallbackPending + SwapAllAdaptersFailed (fell back) for this loan; any other result after a positive preview is a race, UNDETERMINED',
    checks: {
      receipt: "the close-out's own receipt events, for this loan",
    },
  },
  {
    id: 'pageConfirmed',
    claim: 'the page leaves its confirm step once the transaction is sent',
    checks: { settled: 'the confirm button is gone within 180 s of the click' },
  },
];
const MANIFEST = createManifest({
  verifiable: [
    {
      id: 'card',
      claim: 'the overdue card offers this lender a close-out, says the collateral is SOLD through a route the app builds, and names no amount',
      checks: {
        mounted: 'the forced-close card renders on the position page',
        ready: `the card declares ${SALE_STATE}`,
        saleBody: 'the card carries copy.forcedClose.readyNeedsRoute (the sale explanation for a routable venue)',
        noAmount: 'the card text states no monetary amount',
        submit: "the card shows its close-out button, enabled, labelled copy.forcedClose.submit",
        fresh: 'the chain at the block the card declares, and again at the latest block, still shows this loan Active, past grace and held by this wallet',
      },
    },
    ...(SUBMIT ? CLOSE_ONLY : []),
    {
      id: 'pageHealth',
      claim: 'the page threw no uncaught error',
      checks: { noPageErrors: 'no PAGEERROR in the console capture' },
    },
    {
      id: 'writeDiscipline',
      claim: SUBMIT
        ? 'the page asked to sign only the planned close-out, and the gate allowed it exactly once'
        : 'the page attempted no write in a read-only session',
      checks: {
        noRefusals: 'no request refused by the wallet gate, the chain pin or the egress guard, and no non-read method on a page WebSocket',
        ...(SUBMIT ? { planned: 'the write plan consumed its one step: triggerDefault(loanId, a non-empty try-list on enabled adapters) from this wallet to the Diamond, value 0' } : {}),
      },
    },
  ],
  notVerified: [
    ...(SUBMIT
      ? []
      : CLOSE_ONLY.map((c) => ({ id: c.id, claim: c.claim, reason: 'CLOSE=1 was not set — the close-out is one-shot', coveredBy: null }))),
    {
      id: 'submitterIncentive',
      claim: "the incentive a successful routed close-out pays the caller (msg.sender) before the lender/borrower waterfall, and the card's statement about it",
      reason: 'neither the incentive disclosure on the card nor the incentive transfer in the receipt is asserted by this drive',
      coveredBy: null,
    },
    {
      id: 'saleAmount',
      claim: 'how much the sale fetched, and what each party can claim afterwards',
      reason: 'the claims after a close-out are their own surface; this drive judges the close-out itself',
      coveredBy: null,
    },
  ],
});
const check = (id, key, label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  return MANIFEST.record(id, key, ok, `${label}${detail ? ' — ' + detail : ''}`);
};
const unsettled = (id, key, reason) => {
  console.log(`??   ${id}.${key} — ${reason}`);
  MANIFEST.undetermined(id, key, reason);
};
const failedCount = () => MANIFEST.rows().filter((r) => r.status === 'failed').length;

// ── 1. Build check ─────────────────────────────────────────────────────
async function bundleOf(url) {
  const res = await fetch(new URL('/', url), { redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}, not the shell itself`);
  return (await res.text()).match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}
let siteBundle;
let refBundle;
try {
  [siteBundle, refBundle] = await Promise.all([bundleOf(SITE_URL), bundleOf(REFERENCE_SITE_URL)]);
} catch (err) {
  await blocked('could not fetch the SPA shells for the build check', err);
}
if (!siteBundle || !refBundle) await blocked(`no /assets/index-*.js in a shell (site ${siteBundle}, reference ${refBundle})`);
if (siteBundle !== refBundle) {
  await blocked(`SITE_URL serves ${siteBundle} but the reference deploy serves ${refBundle} — not the build under review`);
}
console.log(`build: ${siteBundle} on both hosts`);

// ── 2. Chain state ─────────────────────────────────────────────────────
const { pub } = clientsFor(CHAIN_ID);
const read = (functionName, args = [], extra = {}) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName, args, ...extra });
let loan;
let lenderHolder;
let enabledAdapters;
let nowSec;
let graceEnd;
/** The enabled roster as `index:address` pairs, so a venue removed and a
 *  different one added into the same slot (the array compacts on removal)
 *  reads as the change it is (#2505). */
const rosterKey = (adapters, disabled) =>
  adapters
    .map((a, i) => (disabled[i] === false ? `${i}:${String(a).toLowerCase()}` : null))
    .filter((x) => x !== null)
    .join(',');
const describeErr = (err) => err?.shortMessage ?? err?.message ?? String(err);
/** An eligibility result that established nothing: some read got no answer. */
/** Every index: what a roster that could not be read at all may enable. */
const ANY_INDEX = { has: () => true };
const unknownAt = (err, block) => ({ ok: false, why: '', unknown: describeErr(err), err, block, enabled: null, possiblyEnabled: ANY_INDEX });
/** The custom error a viem revert decoded to, or null. */
const revertName = (err) => err?.walk?.((e) => e?.name === 'ContractFunctionRevertedError')?.data?.errorName ?? null;
/** Whether the node ANSWERED with a revert, decoded or not (an outage is not one). */
const isRevert = (err) => Boolean(err?.walk?.((e) => e?.name === 'ContractFunctionRevertedError'));
/** LibERC721.LockReason.EarlyWithdrawalSale. */
const LOCK_SALE = 2;
/**
 * What the lender position's lock says about the close-out at `blockNumber`
 * (#2505 r25, r26): `null` when nothing on it withholds the close-out, else
 * the reason. The sale lock is stamped for the whole listing lifecycle, and
 * the app withholds the close-out only once a sale is ACCEPTED, so a sale
 * lock is classified the way the app classifies it: simulating
 * `teardownStaleSaleListing` (`NoStaleSaleListing` on a locked position is an
 * accepted sale; `SaleListingLoanStillLive`, or a teardown that would
 * succeed, is a listing the close-out does not wait for). Any other lock is
 * a lifecycle this drive does not judge, and counts as withholding. Throws
 * when a read gets no answer, or the simulation ends in a revert it cannot
 * name.
 */
async function lockWithholds(lenderTokenId, blockNumber) {
  const lock = Number(await read('positionLock', [lenderTokenId], blockNumber === undefined ? {} : { blockNumber }));
  if (lock === 0) return null;
  if (lock !== LOCK_SALE) return `the lender position is locked (LibERC721.LockReason ${lock}), a lifecycle this drive does not judge`;
  try {
    await pub.simulateContract({
      address: DIAMOND,
      abi: DIAMOND_ABI,
      functionName: 'teardownStaleSaleListing',
      args: [LOAN_ID],
      account: WALLET,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    return null;
  } catch (err) {
    const name = revertName(err);
    if (name === 'SaleListingLoanStillLive') return null;
    if (name === 'NoStaleSaleListing') return 'an accepted sale of the lender position is awaiting completion';
    throw err;
  }
}
/** The roster the drive started from; the gate re-reads `enabledAdapters`. */
let startupRoster;
try {
  loan = await read('getLoanDetails', [LOAN_ID]);
  lenderHolder = await read('ownerOf', [loan.lenderTokenId]);
  const adapters = await read('getSwapAdapters');
  const disabled = await Promise.all(adapters.map((a) => read('isSwapAdapterDisabled', [a])));
  enabledAdapters = new Set(adapters.map((_, i) => i).filter((i) => disabled[i] === false));
  startupRoster = rosterKey(adapters, disabled);
  nowSec = (await pub.getBlock()).timestamp;
  const end = loan.startTime + loan.durationDays * 86_400n;
  // The same lookup DefaultedFacet uses (ConfigFacet.getEffectiveGraceSeconds).
  graceEnd = end + (await read('getEffectiveGraceSeconds', [loan.durationDays]));
} catch (err) {
  await blocked('chain reads failed', err);
}
if (Number(loan.status) !== ACTIVE) await blocked(`loan ${LOAN_ID} status is ${loan.status}, not Active`);
if (lenderHolder.toLowerCase() !== WALLET.toLowerCase()) {
  await blocked(`loan ${LOAN_ID}'s lender position is held by ${lenderHolder}, not ${ROLE} ${WALLET}`);
}
if (nowSec <= graceEnd) {
  await blocked(`loan ${LOAN_ID} is not past grace: grace ends ${graceEnd}, chain time ${nowSec}`);
} else {
  console.log(`chain: loan ${LOAN_ID} Active, past grace by ${((nowSec - graceEnd) / 86_400n).toString()} day(s); ${enabledAdapters.size} enabled adapter(s)`);
}
if (enabledAdapters.size === 0) await blocked('the Diamond lists no enabled swap adapter — a sale close-out cannot be routed');
// The chain's own answer to an empty-list close-out, at startup (#2505 r35):
// every later re-read compares with it. A loan whose collateral must be SOLD
// passes every gate and then reverts `NoEnabledSwapRoute`; any other answer
// (a pause, the lender's KYC tier, an internal match, an in-kind branch) is
// not the routed sale this drive judges, so it is BLOCKED here, named.
{
  let answer;
  try {
    await pub.simulateContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'triggerDefault', args: [LOAN_ID, []], account: WALLET });
    answer = 'success';
  } catch (err) {
    if (!isRevert(err)) await blocked('the direct RPC could not simulate the close-out at startup', err);
    answer = revertName(err) ?? `an undecoded revert (${describeErr(err)})`;
  }
  if (answer !== 'NoEnabledSwapRoute') {
    await blocked(
      answer === 'success'
        ? `loan ${LOAN_ID} would close without a sale at startup (an internal match or an in-kind branch), not the routed sale this drive judges`
        : `the chain refuses loan ${LOAN_ID}'s close-out at startup before any route is consulted (${answer}); this drive judges the routed sale only`,
    );
  }
}
// The lender position's lock (#2505 r25): an in-flight lifecycle on it — an
// accepted or listed sale above all — makes the page withhold the close-out
// (it unmounts the card for an accepted sale) while every other fact here
// reads unchanged. A locked position is not the shape this drive judges, and
// a lock appearing later is a moved precondition.
// Both facts at ONE block (#2505 r29): a listing cancelled between the lock
// read and the simulation would otherwise read as an accepted sale.
let startupHold;
try {
  startupHold = await lockWithholds(loan.lenderTokenId, await pub.getBlockNumber());
} catch (err) {
  await blocked("the direct RPC could not establish what the lender position's lock means for the close-out", err);
}
if (startupHold !== null) await blocked(`loan ${LOAN_ID}: ${startupHold}, so the page rightly withholds the close-out`);
// This wallet's nonce BEFORE any browser activity (#2505 r25): a page can
// send through another connector before the plan is ever armed, so the
// baseline every no-write run is settled against is taken here
// (`noWriteSettlement.mjs`).
let nonceBefore;
try {
  const base = await nonceBaseline(pub, WALLET);
  if (base.blocked) await blocked(`${ROLE} ${base.blocked}`);
  nonceBefore = base.nonce;
} catch (err) {
  await blocked('the direct RPC could not read the wallet nonce at startup', err);
}

/**
 * The facts the card's readiness rests on, at one block: the loan record
 * exactly as it was at startup, the lender position held by this wallet and
 * not withheld by a lock, the same enabled swap-adapter roster the drive
 * started from (what the card's route posture was built on), and the chain's
 * own answer to an empty-list `triggerDefault`, which stands in for every
 * gate the contract applies (#2505 r34).
 *
 * NEVER THROWS (#2505 r13). Every caller gets one shape: `ok`, or a move
 * (`why`), or `unknown` (with its `err`) when nothing moved but some read got
 * no answer. A move any read shows always wins over a read that got none, and
 * because nothing is thrown, a caller combining several results cannot lose
 * one result's move to another's missing answer.
 *
 * `enabled` is the set of adapter indices KNOWN enabled at this block (their
 * flag answered "not disabled"): the whole enabled roster when every flag
 * answered, a subset when some did not, null when the address list itself got
 * no answer.
 */
async function eligibleAt(blockNumber) {
  // EVERY read pinned to ONE block (#2481 r4): for "now", the head is taken
  // first and the rest read at it, so a transaction landing between the reads
  // cannot mix an old status with later facts into an eligible verdict that
  // no single block supports.
  let pinned;
  try {
    pinned = blockNumber ?? (await pub.getBlockNumber());
  } catch (err) {
    return unknownAt(err, null);
  }
  const at = { blockNumber: pinned };
  // Every read settles on its own and every fact is judged from whichever
  // reads answered (#2505): a move any of them shows wins over a sibling that
  // got no answer, which only makes the result unknown when nothing moved.
  // Reads that need the loan use the startup snapshot's immutable fields
  // (token id, start, duration) when the loan read itself is unanswered.
  const settle = (p) => p.then((value) => ({ value }), (err) => ({ err }));
  const [loanR, simR, adaptersR] = await Promise.all([
    settle(read('getLoanDetails', [LOAN_ID], at)),
    // The chain's own answer to the call the card makes before it signs
    // (#2505 r34): `triggerDefault` with an empty try-list, which for a loan
    // whose collateral must be SOLD gets through every gate the contract
    // applies (the pause, the status, the lender's KYC tier, the grace
    // period, the sequencer, an internal match) and then reverts
    // `NoEnabledSwapRoute`. That revert is the expected answer. Any other
    // revert is a gate that now refuses the close-out, and a success is a
    // loan that closes without a sale: either way the card is right to
    // withhold the sale, and this drive does not have to list the gates.
    settle(
      pub.simulateContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'triggerDefault', args: [LOAN_ID, []], account: WALLET, blockNumber: pinned }),
    ),
    // The ROUTE POSTURE at this block too (#2505): the card caches what its
    // roster could route, so a roster that changed since — the last adapter
    // disabled, or one venue replaced by another the app cannot ask, even in
    // the same slot — can leave it declaring a routable sale that no longer
    // is. Any change to the enabled roster, by index AND address, is a moved
    // precondition.
    settle(read('getSwapAdapters', [], at)),
  ]);
  const fixed = loanR.value ?? loan;
  const [holderR, lockR, disabledR] = await Promise.all([
    settle(read('ownerOf', [fixed.lenderTokenId], at)),
    settle(lockWithholds(fixed.lenderTokenId, pinned)),
    // One settled read per adapter, so a flag that answered still counts
    // when a sibling's does not.
    adaptersR.err ? Promise.resolve(null) : Promise.all(adaptersR.value.map((a) => settle(read('isSwapAdapterDisabled', [a], at)))),
  ]);
  const why = [];
  const unanswered = [];
  const judge = (r, fn) => (r.err ? unanswered.push(r.err) : fn(r.value));
  if (simR.err) {
    const name = revertName(simR.err);
    if (name === 'NoEnabledSwapRoute') {
      // Every gate passed; the sale still needs the route the card builds.
    } else if (isRevert(simR.err)) why.push(`the chain's answer to an empty-list close-out changed since startup (then NoEnabledSwapRoute; now ${name ?? describeErr(simR.err)})`);
    else unanswered.push(simR.err);
  } else {
    why.push("the chain's answer to an empty-list close-out changed since startup (then NoEnabledSwapRoute; now it would close without a sale)");
  }
  // The WHOLE loan record against startup (#2505 r33): it changes only by a
  // transaction, and the card reads more of it than the status (an
  // added-collateral top-up re-sizes the sale it quoted), so any field that
  // changed is the loan moving, named with its values.
  judge(loanR, (v) => {
    const changed = changedFields(loan, v);
    if (changed.length > 0) why.push(`the loan record changed since startup (${changed.map((k) => `${k} ${loan[k]} → ${v[k]}`).join(', ')})`);
  });
  // The holder: a position claimed after the loan closed is burned, and the
  // node then answers that the token has no owner. That answer is itself a
  // fact (the position this drive held is gone), never an unknown.
  if (holderR.err) {
    // Only the decoded nonexistent-token error: any other revert, broken
    // routing included, establishes nothing about the position (#2505 r29).
    if (revertName(holderR.err) === 'ERC721NonexistentToken') why.push('the lender position no longer exists');
    else unanswered.push(holderR.err);
  } else if (holderR.value.toLowerCase() !== WALLET.toLowerCase()) {
    why.push(`lender position held by ${holderR.value}`);
  }
  // A hold on the lender position since startup (#2505 r25, r26): an
  // accepted sale leaves the loan Active and the seller its holder, yet the
  // page withholds the close-out. A live listing does not.
  if (lockR.err) unanswered.push(lockR.err);
  else if (lockR.value !== null) why.push(lockR.value);
  // The roster, slot by slot against startup, so each answer counts on its
  // own (#2505 r13). The address list alone settles whether a startup slot's
  // venue is still there; a flag settles only its own slot.
  // `enabled`: indices KNOWN enabled. `possiblyEnabled`: indices not known
  // to be disabled or unlisted — a flag that got no answer may be enabled, and
  // an unreadable list may enable any index (#2505 r21). One view, so a held
  // request is matched against exactly what the gate could not rule out.
  let enabled = null;
  let possiblyEnabled = ANY_INDEX;
  if (adaptersR.err) unanswered.push(adaptersR.err);
  else {
    const adapters = adaptersR.value;
    const slot = (i) => `${i}:${String(adapters[i]).toLowerCase()}`;
    const startupSlots = new Set(startupRoster ? startupRoster.split(',') : []);
    enabled = new Set(adapters.map((_, i) => i).filter((i) => !disabledR[i].err && disabledR[i].value === false));
    possiblyEnabled = new Set(adapters.map((_, i) => i).filter((i) => Boolean(disabledR[i].err) || disabledR[i].value === false));
    const changes = [];
    for (const s of startupSlots) {
      const i = Number(s.split(':')[0]);
      if (i >= adapters.length || slot(i) !== s) changes.push(`${s} no longer listed`);
      else if (!disabledR[i].err && disabledR[i].value !== false) changes.push(`${s} disabled`);
    }
    for (const i of enabled) if (!startupSlots.has(slot(i))) changes.push(`${slot(i)} newly enabled`);
    if (changes.length > 0) why.push(`the enabled adapters changed (at startup [${startupRoster}]; here ${changes.join(', ')})`);
    // Every flag that got no answer is named, moved or not (#2505 r21).
    for (const r of disabledR) if (r.err) unanswered.push(r.err);
  }
  // EVERY unanswered read is named, not only the first (#2505 r20): a reason
  // that lists one gap implies the other facts were established.
  const gaps = unanswered.map(describeErr).join('; ');
  if (why.length === 0 && unanswered.length > 0) return { ...unknownAt(unanswered[0], pinned), unknown: `${unanswered.length} read(s) got no answer: ${gaps}`, enabled, possiblyEnabled };
  if (unanswered.length > 0) why.push(`${unanswered.length} other read(s) got no answer (${gaps})`);
  return { ok: why.length === 0, why: why.join(', '), block: pinned, enabled, possiblyEnabled, unknown: null };
}

// ── Wallet posture ─────────────────────────────────────────────────────
const asBig = (v) => {
  try {
    return BigInt(v);
  } catch {
    return -1n;
  }
};
/** The try-list rule: what the plan accepts for the routes it cannot predict. */
const ROUTES_RULE = `a non-empty try-list whose every adapterIdx is an enabled Diamond adapter (${[...enabledAdapters].join(', ')})`;
const routesOk = (v) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((c) => c && enabledAdapters.has(Number(asBig(c.adapterIdx))) && typeof c.data === 'string' && /^0x[0-9a-fA-F]*$/.test(c.data));
const PLAN = SUBMIT
  ? createWritePlan([
      {
        id: 'closeOut',
        role: ROLE,
        kind: 'tx',
        purpose: `triggerDefault(${LOAN_ID}, routes)`,
        expected: {
          ...expectedTx({
            from: WALLET,
            to: DIAMOND,
            call: { functionName: 'triggerDefault', args: { loanId: LOAN_ID, adapterCalls: is(ROUTES_RULE, routesOk) } },
            chainId: CHAIN_ID,
          }),
          // Bounded below by a fresh estimate of the EXACT call the page asks
          // to sign (#2481 r1): a lower limit only buys an out-of-gas revert
          // that spends the funded wallet's ETH. Computed in the gate, before
          // the plan judges the request.
          gas: optional(is('≥ a fresh estimate of this exact call', (v) => gasFloor > 0n && asBig(v) >= gasFloor)),
        },
      },
    ])
  : null;
let gasFloor = 0n;
/** Whether THIS judgement's fresh estimate succeeded: only then is a held
 *  request's gas bound judged (#2505 r16). */
let estimated = false;
/** The gate's own preview of the request it was asked to sign. */
let previewVerdict = null;
/** Set when the gate found the close-out's eligibility moved since startup,
 *  or could not re-read it (#2505). */
let movedAtGate = null;
/** The reason a {@link Held} stop gave, once the drive is stopped
 *  (`noWriteSettlement.mjs` settles it). */
let held = null;
/** A {@link Suspect} the drive stopped on: a FAIL only if nothing moved. */
let suspect = null;
/**
 * The gate withholding the request it is judging, for a held precondition. Its
 * refusal of THAT request carries this marker, so a held run can set exactly
 * that one aside; it is this drive's own doing. Every other refusal, including
 * any later request the closed plan refuses, is still judged.
 */
// A per-run token, matched anywhere in the recorded reason: the gate's verdict
// reaches the ledger wrapped twice (the wallet gate's "eth_sendTransaction
// refused by the signing gate: …", then the driver's "signing gate: …"), and
// a token no page can predict cannot be matched by a request's own content.
/** Whether the gate has already marked its one withheld request. */
let heldMarked = false;
const HELD_REFUSAL = `held precondition [${randomUUID()}]:`;
/**
 * Only the planned close-out may be withheld this way: the request is first
 * compared with the plan's step (its gas bound aside only for a hold taken
 * before the estimate ran; after it, the bound is judged too). Any other request is refused by the closed
 * plan, unmarked, and judged like every other refusal.
 */
const holdSend = (params, gatePossible = null, { gasChecked = false } = {}) => {
  PLAN.close();
  const actual = decodeTxForComparison(Array.isArray(params) ? (params[0] ?? {}) : {}, abiFor);
  const expected = step()?.expected;
  // The gas bound is set aside only while the estimate it rests on has not
  // run in this judgement; once it has, an under-gassed request is not the
  // planned one and stays a finding (#2505 r15).
  const withoutGas = (o) => (gasChecked ? (o ?? {}) : Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== 'gas')));
  // The app builds its route from the roster it read at confirm time, which
  // the drive never sees: a roster migrated in several transactions while
  // confirmation was open can pass through a set that is neither the startup
  // one nor the gate's (#2505 r22). So once the gate has a roster of its own,
  // a route index counts if it was enabled at startup OR the gate could not
  // rule it out; only an index known disabled or unlisted at both ends fails.
  // That is as far as the drive's reads can judge a held request, which is
  // withheld either way.
  const startupEnabled = enabledAdapters;
  const matchesUnder = (set) => {
    enabledAdapters = set;
    try {
      return Boolean(expected) && structMismatches(withoutGas(expected), withoutGas(actual)).length === 0;
    } finally {
      enabledAdapters = startupEnabled;
    }
  };
  // At the gate, every index it could not rule out counts: one whose flag got
  // no answer, or any index when the list itself was unreadable (#2505 r18,
  // r21). A known-disabled or unlisted index still fails the match.
  const either = gatePossible === null ? startupEnabled : { has: (i) => startupEnabled.has(i) || gatePossible.has(i) };
  const planned = matchesUnder(either);
  // One marked refusal per run (#2505 r24): a second request, even an
  // identical one sent while the first was still being judged, is a duplicate
  // signing attempt and is refused unmarked, so it is judged like any other.
  if (!planned || heldMarked) return null;
  heldMarked = true;
  return { ok: false, why: `${HELD_REFUSAL} the send is withheld` };
};
async function previewSale(tx) {
  try {
    const { results } = await pub.simulateCalls({ account: WALLET, calls: [{ to: tx.to, data: tx.data, value: asBig(tx.value ?? 0) }] });
    const r = results?.[0];
    if (!r || r.status !== 'success' || r.logs === undefined) return 'unknown';
    const ours = (name) =>
      parseEventLogs({ abi: DIAMOND_ABI, eventName: name, logs: r.logs.filter((l) => l.address.toLowerCase() === DIAMOND.toLowerCase()) })
        .some((l) => l.args.loanId === LOAN_ID);
    if (ours('SwapAdapterSucceeded')) return 'sale';
    if (ours('SwapAllAdaptersFailed')) return 'fallback';
    return 'other';
  } catch {
    return 'unknown';
  }
}
const abiFor = (to) => (typeof to === 'string' && to.toLowerCase() === DIAMOND.toLowerCase() ? DIAMOND_ABI : null);
const step = () => PLAN?.steps()[0];
const wrote = () => step()?.status === 'consumed';
/**
 * The card's eligibility AT JUDGING TIME (#2481 r4, #2505): status, grace,
 * holder, pause, sequencer and the enabled roster, at one block, through the
 * same `eligibleAt` the card's snapshot used. Any move since startup withholds
 * the send, and so does a re-read that gets no answer: whether it moved is
 * then unknown. Returns the marked refusal for the planned request, or null.
 *
 * The gate asks it TWICE (#2505 r14): before its simulations, so a moved loan
 * costs none, and again after them, immediately before the plan judges the
 * request, because the estimate and the preview are awaited and a permissionless
 * triggerDefault simulates the same whoever holds the position.
 */
async function holdIfIneligible(params, gasChecked = false) {
  if (movedAtGate === null) {
    const e = await eligibleAt(null);
    // The route bound follows the roster only while it is unmoved, so a
    // held request is still compared with the set the drive started from.
    if (e.ok) enabledAdapters = e.enabled;
    else if (e.unknown) movedAtGate = `unknown: the eligibility could not be re-read at signing (${e.unknown})`;
    else movedAtGate = `at block ${e.block}: ${e.why}`;
    // The indices not ruled out here: a held request naming only those is
    // still the planned one (#2505 r13, r21).
    gatePossible = e.possiblyEnabled;
  }
  if (movedAtGate === null) return null;
  console.log(`GATE  the close-out's preconditions moved or could not be re-read (${movedAtGate}); not signing`);
  return holdSend(params, gatePossible, { gasChecked });
}
/** The indices the gate's latest eligibility read could not rule out. */
let gatePossible = null;
async function gate(method, params) {
  if (PLAN.armed() !== null && preSendFails() > 0) PLAN.close();
  const kind = method === 'eth_sendTransaction' ? 'tx' : method;
  // Only a send the armed plan is about to judge is checked for eligibility.
  const judging = kind === 'tx' && PLAN.armed() !== null;
  if (judging) {
    const tx = Array.isArray(params) ? (params[0] ?? {}) : {};
    const heldBefore = await holdIfIneligible(params);
    if (heldBefore) return heldBefore;
    try {
      estimated = false;
      gasFloor = await pub.estimateGas({ account: WALLET, to: tx.to, data: tx.data, value: asBig(tx.value ?? 0) });
      console.log(`GATE  fresh estimate for the requested call: ${gasFloor} gas`);
      estimated = true;
    } catch (err) {
      // The plan then refuses any request carrying a gas limit, and one with
      // none is signed with the wallet's own estimate — which would fail the
      // same way, before anything is broadcast.
      gasFloor = 0n;
      estimated = false;
      console.log(`GATE  could not estimate the requested call: ${err.shortMessage ?? err.message}`);
    }
  }
  // #2481 r5 — PREVIEW the exact request independently (the same log-returning
  // simulation the app's own guard uses) and require that it SELLS: an
  // estimate succeeds even for a route every adapter rejects, because
  // triggerDefault then completes into the fallback. A preview that ends in
  // the fallback means the app sent what it should have refused — a FAIL;
  // a node that cannot run the preview leaves the sale unproven — BLOCKED.
  if (kind === 'tx' && PLAN.armed() !== null) {
    const tx = Array.isArray(params) ? (params[0] ?? {}) : {};
    previewVerdict = await previewSale(tx);
    console.log(`GATE  independent preview of the requested route: ${previewVerdict}`);
    // An unrunnable preview is a held precondition; any other non-sale is
    // the app's route, judged at confirm.
    if (previewVerdict === 'unknown') {
      const heldRefusal = holdSend(params, null, { gasChecked: estimated });
      if (heldRefusal) return heldRefusal;
    }
    if (previewVerdict !== 'sale') PLAN.close();
  }
  // The eligibility once more, AFTER the awaited simulations (#2505 r14),
  // only for a request that previewed as a sale: a route that did not sell is
  // already the app's failure, judged at confirm, and a later move cannot
  // excuse it (#2505 r17).
  if (judging && previewVerdict === 'sale') {
    const heldAfter = await holdIfIneligible(params, estimated);
    if (heldAfter) return heldAfter;
  }
  // #2481 r3 — again, AFTER the estimate was awaited: a page error or a
  // refused request recorded meanwhile must still withhold the one-shot send.
  if (PLAN.armed() !== null && preSendFails() > 0) PLAN.close();
  const actual = kind === 'tx' ? decodeTxForComparison(Array.isArray(params) ? (params[0] ?? {}) : {}, abiFor) : params;
  const v = PLAN.offer(ROLE, kind, actual);
  if (!v.ok) {
    console.log(`GATE  refused ${method}: ${v.why}`);
    return { ok: false, why: v.why };
  }
  console.log(`GATE  allowed ${v.step.purpose}`);
  return {
    ok: true,
    onResult: (hash) => {
      PLAN.record(v.index, { hash, outcome: 'hash returned' });
      console.log(`TX    close-out sent: ${hash}`);
    },
    onError: (err) => {
      PLAN.record(v.index, { outcome: `provider rejected: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 160)}` });
    },
  };
}
const sentHash = () => step()?.record?.hash ?? null;
const session = await launch(
  SUBMIT
    ? { role: ROLE, startChainId: CHAIN_ID, pinnedChainId: CHAIN_ID, signingGate: gate, readOnlyEgress: true, allowQuoteProxy: true }
    : { role: ROLE, readOnly: true },
);
const { ctx, page, done, consoleErrors, blockedRequests } = session;
const shot = (name) => session.shot(name).catch((e) => console.log(`(screenshot ${name} not saved: ${e.message})`));
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('vaipakam:language', 'en');
  } catch {
    /* storage blocked — the language assertion below says so */
  }
});
const { wsViolations } = attachLedger(page, createReadLedger({}), READ_METHODS);
// The page's own chain answers, HTTP and WebSocket, counted per window — so a
// card that never appears while the page heard NOTHING from the chain reads
// as unobserved (BLOCKED), not as a broken card (#2481 r2).
const rpc = watchPageRpc(page);
let wsAnswers = 0;
let wsGeneration = 0;
page.on('websocket', (ws) => {
  const sent = new Map();
  const each = (payload, fn) => {
    try {
      for (const m of [].concat(JSON.parse(String(payload)))) if (m) fn(m);
    } catch {
      /* not JSON-RPC */
    }
  };
  ws.on('framesent', (f) => each(f.payload, (m) => {
    if (m.id !== undefined && READ_METHODS.has(m.method)) sent.set(m.id, wsGeneration);
  }));
  ws.on('framereceived', (f) => each(f.payload, (m) => {
    if (m.id === undefined || !('result' in m || 'error' in m)) return;
    if (sent.get(m.id) === wsGeneration) wsAnswers++;
    sent.delete(m.id);
  }));
});
const resetWindow = () => {
  rpc.reset();
  wsAnswers = 0;
  wsGeneration++;
};
const answered = async () => (await rpc.settled()) + wsAnswers;
const violationsSoFar = () => [
  ...splitBlocked(blockedRequests ?? [], [new URL(SITE_URL).origin]).violations,
  ...wsViolations,
];
const pageErrors = () => consoleErrors.filter((e) => e.startsWith('PAGEERROR'));
/** The gate's marked refusal of the one request it withheld for a held
 *  precondition: this drive's own doing, never a finding (#2505 r24). */
const ownHold = (b) => String(b.reason).includes(HELD_REFUSAL);
// Every count of what stands before a send sets that one marked refusal
// aside, so a stop after a gate hold is still resolved as the hold rather
// than counted as a failure of its own (#2505 r32).
const preSendFails = () => failedCount() + violationsSoFar().filter((b) => !ownHold(b)).length + pageErrors().length;
/** Why the gate withheld the planned request, when it did; null otherwise. */
const gateHeldReason = () => {
  if (!heldMarked || wrote()) return null;
  if (movedAtGate !== null) {
    return movedAtGate.startsWith('unknown: ')
      ? `whether loan ${LOAN_ID}'s close-out preconditions moved while it was being confirmed is ${movedAtGate}, so the plan signed nothing`
      : `loan ${LOAN_ID}'s close-out preconditions moved while it was being confirmed (${movedAtGate}), so the plan signed nothing`;
  }
  if (previewVerdict === 'unknown') {
    return 'the node could not run the independent preview of the requested route, so a sale could not be established and the plan signed nothing';
  }
  return null;
};
/**
 * BLOCKED for a precondition met before any write, unless a failure was
 * already recorded, which stands: the drive then stops there and the verdict
 * is FAIL (#2505 r14). Every pre-write BLOCKED exit goes through here.
 *
 * It holds the run rather than exiting (#2505 r25): a held run reaches the
 * verdict only after this wallet's nonce is reconciled against its startup
 * baseline, so a send the page made through another connector is a gate
 * escape, never hidden behind a BLOCKED that says nothing was sent.
 */
async function blockPre(why, err = null) {
  if (preSendFails() > 0) {
    throw new Error(`${why}; nothing after it is judged, and the ${preSendFails()} failure(s) recorded before it stand`);
  }
  throw new Held(err ? `${why} (${describeErr(err)})` : why);
}
let stopped = null;
let armedOnce = false;
/** The outcome, read from the chain by the hash the wallet returned. */
async function judgeOutcome(hash) {
  // ROOT RULE (#2481 r6): the app is judged at the point it asks to sign —
  // the gate's independent preview of that exact request must SELL, or the
  // run FAILs there. After the send, the receipt is EVIDENCE, not a verdict
  // on the app: the request previewed as a sale, so anything else the chain
  // did with it (a revert, an internal match, an in-kind branch) came from
  // state that moved between the preview and inclusion — a race — and is
  // UNDETERMINED. Earlier rounds tried to explain each such case by naming
  // the precondition that moved (pause, sequencer, KYC, ordering inside the
  // block, the statuses a loan reaches later in its block); every round found
  // another, because the list has no end. The rule replaces the list.
  //
  // So there is one outcome check, transaction-indexed by the receipt's own
  // events; the end-of-block status read it used to need is gone.
  let receipt;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  } catch (err) {
    unsettled('closedOut', 'receipt', `the direct RPC could not read the close-out receipt ${hash} (${err.message})`);
    return;
  }
  if (receipt.status === 'reverted') {
    unsettled('closedOut', 'receipt', `reverted (${hash}, block ${receipt.blockNumber}) after the request previewed as a sale — state moved before inclusion; not judged a defect`);
    return;
  }
  const diamondLogs = receipt.logs.filter((l) => l.address.toLowerCase() === DIAMOND.toLowerCase());
  const ours = (name) =>
    parseEventLogs({ abi: DIAMOND_ABI, eventName: name, logs: diamondLogs }).some((l) => l.args.loanId === LOAN_ID);
  const matched = parseEventLogs({ abi: DIAMOND_ABI, eventName: 'InternalMatchExecuted', logs: diamondLogs }).some((l) =>
    [l.args.loanIdA, l.args.loanIdB, l.args.loanIdC].includes(LOAN_ID),
  );
  const defaulted = ours('LoanDefaulted');
  const fallback = ours('LoanFallbackPending');
  const sold = ours('SwapAdapterSucceeded');
  const allFailed = ours('SwapAllAdaptersFailed');
  // A SALE is proven by the swap events, never by LoanDefaulted alone
  // (#2481 r2): cleared = LoanDefaulted + SwapAdapterSucceeded; fell back =
  // LoanFallbackPending + SwapAllAdaptersFailed (the card discloses both).
  if (defaulted && sold && !fallback) {
    check('closedOut', 'receipt', 'the close-out ran the sale', true, `LoanDefaulted + SwapAdapterSucceeded (the sale cleared) — ${hash}, block ${receipt.blockNumber}`);
  } else if (fallback && allFailed && !defaulted) {
    check('closedOut', 'receipt', 'the close-out ran the sale', true, `LoanFallbackPending + SwapAllAdaptersFailed (no venue met the minimum at inclusion; collateral held for the lender) — ${hash}, block ${receipt.blockNumber}`);
  } else {
    const what = matched
      ? 'an internal match settled it first (the race the card warns of)'
      : `events: LoanDefaulted ${defaulted}, LoanFallbackPending ${fallback}, SwapAdapterSucceeded ${sold}, SwapAllAdaptersFailed ${allFailed} — a different branch than the sale it previewed as`;
    unsettled('closedOut', 'receipt', `${what} — ${hash}, block ${receipt.blockNumber}; state moved after the preview, so this is not judged a defect`);
  }
}
try {
  resetWindow();
  await visit(page, `/positions/${LOAN_ID}`);
  // The page must still BE this loan's (#2481 r5): a redirect to another
  // position would pair that card with this loan's chain checks.
  const landed = new URL(page.url()).pathname.replace(/\/$/, '');
  if (landed !== `/positions/${LOAN_ID}`) {
    check('card', 'mounted', `the page stayed on loan ${LOAN_ID}`, false, `landed on ${landed}`);
    throw new Error(`navigation left /positions/${LOAN_ID} for ${landed}`);
  }
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (!/^en\b/i.test(lang ?? '')) {
    await blockPre(`the page renders in "${lang}", not English — the expected labels come from the en catalogue`);
  }
  await ensureConnected(page);
  const card = page.getByTestId('forced-close-card');
  const mounted = await card.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false);
  if (!mounted && (await answered()) === 0) {
    await blockPre('the page RPC answered nothing while the position page loaded, so the card was never observable');
  }
  // A card the page rightly withholds (the loan closed by a keeper while the
  // page loaded) is a FAIL only if the loan did not move: settled at the end.
  if (!mounted) throw new Suspect('the forced-close card never rendered', { row: 'card', key: 'mounted', label: 'the forced-close card renders' });
  check('card', 'mounted', 'the forced-close card renders', true);
  // The state settles once the card's reads (and, for a sale, its venue
  // probe) answer; waited for rather than read once.
  let state = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    state = await card.getAttribute('data-forced-close-state');
    if (state === SALE_STATE || OTHER_READY_STATES.has(state ?? '')) break;
    await page.waitForTimeout(1_000);
  }
  if (OTHER_READY_STATES.has(state ?? '')) {
    await blockPre(`loan ${LOAN_ID} resolves to ${state}, a valid card state for a loan that does not need a routed sale — this drive judges the sale route only`);
  }
  if (state !== SALE_STATE) {
    throw new Suspect(`the card declared ${state}, not ${SALE_STATE}`, { row: 'card', key: 'ready', label: `the card declares ${SALE_STATE}`, detail: `declared state ${state}` });
  }
  check('card', 'ready', `the card declares ${SALE_STATE}`, true, `declared state ${state}`);
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  console.log(`card: ${text.slice(0, 600)}`);
  // A deployment posture the card DISCLOSES — no venue the app can ask, the
  // quote proxy not configured, the venue list unreadable — is a precondition
  // of this environment, not a card defect (#2481 r3).
  const postures = [
    ['readyNeedsRouteNoVenue', 'no venue the app can ask on this chain'],
    ['readyNeedsRouteNoEnabledVenue', 'no enabled venue'],
    ['readyNeedsRouteNotConfigured', 'the quote proxy is not configured'],
    ['readyNeedsRouteUnreadable', "the venue list could not be read"],
  ];
  for (const [key, what] of postures) {
    if (typeof FC[key] === 'string' && text.includes(FC[key])) {
      await blockPre(`the card discloses that a sale cannot be routed here (${what}) — not the routable sale this drive judges`);
    }
  }
  check('card', 'saleBody', 'the card says the collateral is sold through a route the app builds', text.includes(FC.readyNeedsRoute));
  // Revalidate the snapshot (#2481 r1): the card declares the block its
  // readiness was resolved at; the chain must show the same facts there AND
  // now. A move in between is a race, BLOCKED — never certified as a PASS.
  const declared = await card.getAttribute('data-forced-close-block');
  // Neither snapshot throws, so a move either one shows survives the other
  // getting no answer (#2505 r13). Only an unanswered declared-block read is
  // retried: a just-mined block may not have reached every node yet.
  const hasDeclared = /^\d+$/.test(declared ?? '');
  const atDeclared = async () => {
    const r = await eligibleAt(BigInt(declared));
    if (r.unknown) throw Object.assign(r.err ?? new Error(r.unknown), { eligibility: r });
    return r;
  };
  const [then, now] = await Promise.all([
    hasDeclared
      ? readPinned(atDeclared).catch((err) => err?.eligibility ?? unknownAt(err, BigInt(declared)))
      : Promise.resolve({ ok: false, why: `no declared block (${declared})`, unknown: null }),
    eligibleAt(null),
  ]);
  const said = (r) => (r.ok ? 'eligible' : r.unknown ? `unknown (${r.unknown})` : r.why);
  if (!hasDeclared) {
    check('card', 'fresh', 'the card declares the block its readiness rests on', false, then.why);
  } else if ((!then.ok && !then.unknown) || (!now.ok && !now.unknown)) {
    await blockPre(`loan ${LOAN_ID} moved while the card was read — at the declared block ${declared}: ${said(then)}; now: ${said(now)}`);
  } else if (then.unknown || now.unknown) {
    await blockPre(`the direct RPC could not re-read the loan's eligibility while the card was read — at the declared block ${declared}: ${said(then)}; now: ${said(now)}`);
  } else {
    check('card', 'fresh', 'the chain at the declared block and now still shows the loan eligible', true, `declared block ${declared}, latest ${now.block}`);
  }
  const amounts = monetaryAmountsIn(text, { locale: 'en' });
  check('card', 'noAmount', 'the card states no amount', amounts.length === 0, amounts.join(', '));
  const submit = page.getByTestId('forced-close-submit');
  const enabled = await submit
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => submit.isEnabled())
    .catch(() => false);
  const label = enabled ? ((await submit.getAttribute('aria-label')) ?? (await submit.innerText())).replace(/\s+/g, ' ').trim() : '';
  // A button that did not come up ready may rightly have been withdrawn for
  // a loan that moved (#2505 r19): settled at the end.
  const submitLabel = 'the close-out button is shown, enabled and labelled as the close-out';
  if (!enabled || label !== FC.submit) throw new Suspect('the close-out button did not come up ready', { row: 'card', key: 'submit', label: submitLabel, detail: `label "${label}"` });
  check('card', 'submit', submitLabel, true, `label "${label}"`);
  await shot(`lender-close-out-card-${LOAN_ID}`);

  if (SUBMIT && preSendFails() > 0) {
    console.log(`SKIP close-out — ${preSendFails()} check(s) failed or request(s) were refused above`);
  } else if (SUBMIT) {
    // Funding is a precondition: an unfunded wallet fails inside the send.
    // Read, then judged outside the try, so the funding verdict is never
    // re-caught as a read failure.
    const funding = await Promise.all([pub.getBalance({ address: WALLET, blockTag: 'pending' }), pub.getGasPrice()]).then(
      ([balance, gasPrice]) => ({ balance, need: 3_000_000n * gasPrice * 2n }),
      (err) => ({ err }),
    );
    if (funding.err) await blockPre('the direct Base Sepolia RPC could not read the balance before the close-out', funding.err);
    if (funding.balance < funding.need) {
      await blockPre(`${ROLE} ${WALLET} holds ${formatUnits(funding.balance, 18)} ETH; a sale close-out needs about ${formatUnits(funding.need, 18)}`);
    }
    if (preSendFails() > 0) throw new Error('a check failed or a request was refused before the close-out; not sending');
    await submit.click();
    const confirm = page.getByTestId('confirm-receipt-confirm');
    await confirm.waitFor({ state: 'visible', timeout: 60_000 });
    // The confirm step quotes the venues; it enables once a route is built.
    await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="confirm-receipt-confirm"]');
        return b && !b.disabled;
      },
      null,
      { timeout: 120_000 },
    );
    await shot(`lender-close-out-confirm-${LOAN_ID}`);
    const confirmText = (await card.innerText()).replace(/\s+/g, ' ');
    check('confirmSale', 'outcome', 'the confirmation describes the sale', confirmText.includes(FC.outcomeNoteSale));
    // The confirmation's OWN receipt (#2481 r2): the sale note above also
    // shows on the card before the confirmation opens, so it alone cannot
    // tell the sale receipt from the standard or rental one.
    const receiptText = (await card.locator('dl.receipt').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(
      'confirmSale',
      'receipt',
      'the confirmation receipt is the sale receipt',
      receiptText.includes(FC.saleReceipt.youReceive) && !receiptText.includes(FC.receipt.youReceive) && !receiptText.includes(FC.rentalReceipt.youReceive),
      receiptText.slice(0, 160),
    );
    if (preSendFails() > 0) throw new Error('a check failed or a request was refused before the close-out; not sending');
    // The nonce baseline, taken at startup, is the only evidence that ties a
    // later state change to THIS wallet rather than to a keeper (#2481 r1).
    PLAN.arm(ROLE);
    armedOnce = true;
    await confirm.click();
    // From here on the close-out may have been written: an exception is never
    // a product verdict. The page leaving its confirm step is recorded, and
    // the chain is the judge.
    // The card may instead REFUSE at confirm time — every venue declined, the
    // preview says it would fall back, the loan changed — keeping the
    // confirmation open with an explicit "nothing was sent" message. That is
    // the app working, on a sale not routable right now: BLOCKED, not a FAIL
    // (#2481 r4).
    const refusals = Object.entries(FC)
      // ONLY the messages that mean nothing was sent (#2481 r5):
      // `routeMissingAnswers` is a warning shown while the shorter route IS
      // sent, and must not read as a refusal.
      .filter(([k, v]) => /^route[A-Z]/.test(k) && typeof v === 'string' && /nothing was (sent|spent)/i.test(v))
      .map(([k, v]) => [k, v]);
    let settled = false;
    let refusedWith = null;
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      if ((await confirm.count()) === 0) {
        settled = true;
        break;
      }
      const t = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
      const hit = refusals.find(([, v]) => t.includes(v));
      if (hit) {
        refusedWith = hit[0];
        break;
      }
      await page.waitForTimeout(1_000);
    }
    if (gateHeldReason() !== null) {
      PLAN.close();
      throw new Held(gateHeldReason());
    }
    if (previewVerdict === 'sale') {
      check('confirmSale', 'preview', 'the route the app asked to sign previews as a sale', true, 'independent preview: SwapAdapterSucceeded');
    }
    if (!wrote() && (previewVerdict === 'fallback' || previewVerdict === 'other')) {
      check('confirmSale', 'preview', 'the route the app asked to sign previews as a sale', false, `independent preview: ${previewVerdict} — the app should have refused this route`);
    }
    if (refusedWith && !wrote()) {
      PLAN.close();
      throw new Held(`the card refused at confirm time and the plan signed nothing (copy.forcedClose.${refusedWith}); the sale is not routable right now`);
    }
    // A confirm step that never settled, with nothing signed, may be the page
    // rightly withholding a close-out whose precondition moved while it was
    // being confirmed: the card's own pre-wallet simulation refuses it, so the
    // gate never sees a request (#2505 r24). A FAIL only if nothing moved,
    // settled at the end.
    if (!settled && !wrote()) {
      PLAN.close();
      throw new Suspect('the page did not leave its confirm step, and the plan signed nothing', { row: 'pageConfirmed', key: 'settled', label: 'the page left its confirm step' });
    }
    check('pageConfirmed', 'settled', 'the page left its confirm step', settled, refusedWith ? `refusal shown: ${refusedWith}` : '');
    PLAN.close();
    await shot(`lender-close-out-sent-${LOAN_ID}`);
    if (wrote()) {
      const hash = sentHash();
      if (hash) await judgeOutcome(hash);
      else unsettled('closedOut', 'receipt', 'the wallet returned no hash — the close-out may still land; check loan status by hand');
    }
  }
} catch (err) {
  PLAN?.close();
  // Judged nowhere here: a hold, a suspect or a plain stop is settled once,
  // after the browser is closed and the nonce reconciled (noWriteSettlement).
  if (err instanceof Held) held = err.message;
  else if (err instanceof Suspect) suspect = err;
  else stopped = err.message;
  await shot(`lender-close-out-error-${LOAN_ID}`);
  if (wrote()) {
    const hash = sentHash();
    if (hash) await judgeOutcome(hash);
    else stopped += '; the wallet returned no hash — the close-out may still land; check loan status by hand';
  }
  console.log(`STOP  ${held ?? suspect?.message ?? stopped}`);
}
// ── Settlement (noWriteSettlement.mjs) ─────────────────────────────────
// One order for every run: the browser is closed first, so the page can add
// no error, refusal or send after its ledgers are judged; the loan is
// re-read once; this wallet's nonce is read last. A run the plan did not
// let write is then BLOCKED, FAIL, a gate escape or UNDETERMINED by one
// rule, whatever path stopped it.
let teardownDone = false;
const closeBrowser = async () => {
  if (teardownDone) return;
  teardownDone = true;
  await done();
};
const settled = await settleRun({
  closeBrowser,
  judgeLedgers: () => {
    check('pageHealth', 'noPageErrors', 'no page errors', pageErrors().length === 0, pageErrors().join(' | ').slice(0, 300));
    // The gate's marked refusal of the one request it withheld is this
    // drive's own doing, never a finding (`ownHold`); every other refusal is.
    const violations = violationsSoFar().filter((b) => !ownHold(b));
    check(
      'writeDiscipline',
      'noRefusals',
      SUBMIT ? 'the page asked to sign only the planned close-out' : 'the page attempted no write in a read-only session',
      violations.length === 0,
      violations.map((b) => `${b.reason} ${b.url ?? ''}`.trim()).join(' | '),
    );
  },
  wrotePlan: wrote,
  // Read for every run the plan did not write for, held or stopped included:
  // a move after a hold (an accepted sale, a transfer, a pause, a retune, a
  // roster change) is named rather than going unreported (#2505 r28).
  factsNow: async () => {
    const now = await eligibleAt(null);
    if (now.unknown) return { unknown: now.unknown };
    if (!now.ok) return { moved: `block ${now.block}: ${now.why}` };
    return {};
  },
  pub,
  wallet: WALLET,
  baseline: nonceBefore,
});
// The gate's own hold, when it withheld the planned request: the stop that
// followed it (a UI wait that ran out) is explained by it (#2505 r32).
if (held === null && !settled.plan) held = gateHeldReason();
const resolved = resolveSettlement({
  settled,
  held,
  stopped,
  suspect,
  findings: failedCount(),
  subject: `loan ${LOAN_ID}'s close-out`,
});
if (resolved.blocked) await blocked(resolved.blocked);
if (resolved.recordSuspect) check(suspect.check.row, suspect.check.key, suspect.check.label, false, suspect.check.detail ?? '');
// Armed, clicked, provably nothing sent, and nothing that explains it: the
// app did not send the close-out it was asked for.
if (armedOnce && !resolved.wrote && held === null && suspect === null) {
  check('writeDiscipline', 'planned', 'the close-out was sent through the gated wallet, exactly once', wrote(), `plan step ${step()?.status}`);
}
if (resolved.gateEscape) console.log(`ESCAPE ${ROLE}: ${resolved.escape}`);
for (const line of MANIFEST.render()) console.log(line);
const VERDICT = runVerdict({
  rows: MANIFEST.rows(),
  wrote: resolved.wrote,
  stopped: resolved.stopped,
  preWriteFailure: !resolved.wrote && failedCount() > 0,
  gateEscape: resolved.gateEscape,
  outcomeClaims: SUBMIT ? OUTCOME : [],
  evidence: {
    failed: 'see the GATE refusals and the manifest above',
    left: "the TX and STOP lines above give the close-out's hash and what its receipt showed; check the loan by hand if neither does",
    escape: resolved.escape ?? 'see the ESCAPE line above',
  },
});
console.log(VERDICT.line);
process.exit(VERDICT.exit);
