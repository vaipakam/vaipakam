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
// UNDETERMINED (only with CLOSE=1 after the gate allowed the send).
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
/** A viem error that carries the node's own execution revert. */
const isExecutionRevert = (err) =>
  Boolean(err?.walk?.((e) => e?.name === 'ContractFunctionRevertedError' || e?.name === 'ExecutionRevertedError'));
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

/** The facts the card's readiness rests on, at one block: still Active,
 *  past grace, the lender position held by this wallet, and the same
 *  enabled swap-adapter roster the drive started from, which is what the
 *  card's route posture was built on. */
async function eligibleAt(blockNumber) {
  // EVERY read pinned to ONE block (#2481 r4): for "now", the head is taken
  // first and the rest read at it, so a transaction landing between the reads
  // cannot mix an old status with later facts into an eligible verdict that
  // no single block supports.
  const pinned = blockNumber ?? (await pub.getBlockNumber());
  const at = { blockNumber: pinned };
  // Each fact is judged as soon as it is read (#2505): a later read that gets
  // no answer must not turn a move already established into "unknown", so
  // such a failure returns the move with what is known; with nothing known it
  // throws, and the caller reports the eligibility as unknown.
  const why = [];
  let enabled = null;
  try {
    // Settled one by one, so a sibling that gets no answer cannot hide a fact
    // another read established; the first unanswered read then stops the
    // walk below, with what is known.
    const [lr, br, pausedR, seqR] = await Promise.allSettled([
      read('getLoanDetails', [LOAN_ID], at),
      pub.getBlock({ blockNumber: pinned }),
      // triggerDefault is whenNotPaused: an emergency pause is a moved
      // precondition like any other (#2481 r4).
      read('paused', [], at),
      // triggerDefault also reverts while the L2 sequencer is unhealthy (or in
      // its recovery window) — another operational precondition (#2481 r5).
      read('sequencerHealthy', [], at),
    ]);
    if (pausedR.status === 'fulfilled' && pausedR.value) why.push('the protocol is paused');
    if (seqR.status === 'fulfilled' && !seqR.value) why.push('the sequencer is not healthy');
    if (lr.status === 'fulfilled' && Number(lr.value.status) !== ACTIVE) why.push(`status ${lr.value.status}`);
    const firstUnanswered = [lr, br, pausedR, seqR].find((r) => r.status === 'rejected');
    if (firstUnanswered) throw firstUnanswered.reason;
    const l = lr.value;
    const b = br.value;
    // The grace end AT THIS BLOCK, from this block's loan and grace schedule:
    // an admin retune between startup and the inspected block changes what
    // triggerDefault itself evaluates there (#2481 r3).
    const graceEndHere = l.startTime + l.durationDays * 86_400n + (await read('getEffectiveGraceSeconds', [l.durationDays], at));
    if (b.timestamp <= graceEndHere) why.push(`not past grace (chain time ${b.timestamp}, grace ends ${graceEndHere})`);
    // The holder: a position claimed after the loan closed is burned, and the
    // node then answers that the token has no owner. That answer is itself a
    // fact (the position this drive held is gone), never an unknown.
    let holder;
    try {
      holder = await read('ownerOf', [l.lenderTokenId], at);
    } catch (err) {
      if (!isExecutionRevert(err)) throw err;
      holder = null;
    }
    if (holder === null) why.push('the lender position no longer exists');
    else if (holder.toLowerCase() !== WALLET.toLowerCase()) why.push(`lender position held by ${holder}`);
    // The ROUTE POSTURE at this block too (#2505): the card caches what its
    // roster could route, so a roster that changed since — the last adapter
    // disabled, or one venue replaced by another the app cannot ask, even in
    // the same slot — can leave it declaring a routable sale that no longer
    // is. Any change to the enabled roster, by index AND address, is a moved
    // precondition.
    const adapters = await read('getSwapAdapters', [], at);
    const disabledHere = await Promise.all(adapters.map((a) => read('isSwapAdapterDisabled', [a], at)));
    const enabledHere = rosterKey(adapters, disabledHere);
    if (enabledHere !== startupRoster) why.push(`the enabled adapters changed (at startup [${startupRoster}], here [${enabledHere}])`);
    enabled = new Set(adapters.map((_, i) => i).filter((i) => disabledHere[i] === false));
  } catch (err) {
    if (why.length === 0) throw err;
    why.push(`a later read got no answer (${err.shortMessage ?? err.message})`);
  }
  return { ok: why.length === 0, why: why.join(', '), block: pinned, enabled };
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
/** The gate's own preview of the request it was asked to sign. */
let previewVerdict = null;
/** Set when the gate found the close-out's eligibility moved since startup,
 *  or could not re-read it (#2505). */
let movedAtGate = null;
/**
 * A precondition that stopped the drive without a finding: the plan signed
 * nothing, but whether THIS WALLET sent nothing is only known once its nonce
 * is reconciled, so it is not reported here. It becomes BLOCKED at the
 * verdict, after that reconciliation (#2505).
 */
class Held extends Error {}
/** The reason a {@link Held} stop gave, once the drive is stopped. */
let held = null;
/**
 * The gate withholding the request it is judging, for a held precondition. Its
 * refusal of THAT request carries this marker, so a held run can set exactly
 * that one aside; it is this drive's own doing. Every other refusal, including
 * any later request the closed plan refuses, is still judged.
 */
const HELD_REFUSAL = 'held precondition:';
/**
 * Only the planned close-out may be withheld this way: the request is first
 * compared with the plan's step (its gas bound aside, since the estimate is
 * skipped once the send is held). Any other request is refused by the closed
 * plan, unmarked, and judged like every other refusal.
 */
const holdSend = (params) => {
  PLAN.close();
  const actual = decodeTxForComparison(Array.isArray(params) ? (params[0] ?? {}) : {}, abiFor);
  const expected = step()?.expected;
  const withoutGas = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== 'gas'));
  const planned = Boolean(expected) && structMismatches(withoutGas(expected), withoutGas(actual)).length === 0;
  if (!planned) return null;
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
async function gate(method, params) {
  if (PLAN.armed() !== null && preSendFails() > 0) PLAN.close();
  const kind = method === 'eth_sendTransaction' ? 'tx' : method;
  if (kind === 'tx' && PLAN.armed() !== null) {
    const tx = Array.isArray(params) ? (params[0] ?? {}) : {};
    // The card's eligibility AT JUDGING TIME (#2481 r4, #2505): status,
    // grace, holder, pause, sequencer and the enabled roster, at one block,
    // through the same `eligibleAt` the card's snapshot used. Any move since
    // startup withholds the send, and so does a re-read that gets no answer:
    // whether it moved is then unknown.
    try {
      const e = await eligibleAt(null);
      // The route bound follows the roster only while it is unmoved, so a
      // held request is still compared with the set the drive started from.
      if (e.ok && e.enabled !== null) enabledAdapters = e.enabled;
      if (!e.ok) movedAtGate = `at block ${e.block}: ${e.why}`;
    } catch (err) {
      movedAtGate = `unknown: the eligibility could not be re-read at signing (${err.shortMessage ?? err.message})`;
    }
    if (movedAtGate !== null) {
      console.log(`GATE  the close-out's preconditions moved or could not be re-read (${movedAtGate}); not signing`);
      const heldRefusal = holdSend(params);
      if (heldRefusal) return heldRefusal;
    }
    try {
      gasFloor = await pub.estimateGas({ account: WALLET, to: tx.to, data: tx.data, value: asBig(tx.value ?? 0) });
      console.log(`GATE  fresh estimate for the requested call: ${gasFloor} gas`);
    } catch (err) {
      // The plan then refuses any request carrying a gas limit, and one with
      // none is signed with the wallet's own estimate — which would fail the
      // same way, before anything is broadcast.
      gasFloor = 0n;
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
      const heldRefusal = holdSend(params);
      if (heldRefusal) return heldRefusal;
    }
    if (previewVerdict !== 'sale') PLAN.close();
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
const preSendFails = () => failedCount() + violationsSoFar().length + pageErrors().length;
let stopped = null;
let armedOnce = false;
/** This wallet's pending nonce just before the arm. */
let nonceBefore = null;
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
    await blocked(`the page renders in "${lang}", not English — the expected labels come from the en catalogue`, null, done);
  }
  await ensureConnected(page);
  const card = page.getByTestId('forced-close-card');
  const mounted = await card.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false);
  if (!mounted && (await answered()) === 0) {
    await blocked('the page RPC answered nothing while the position page loaded, so the card was never observable', null, done);
  }
  check('card', 'mounted', 'the forced-close card renders', mounted);
  if (!mounted) throw new Error('the forced-close card never rendered');
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
    await blocked(`loan ${LOAN_ID} resolves to ${state}, a valid card state for a loan that does not need a routed sale — this drive judges the sale route only`, null, done);
  }
  check('card', 'ready', `the card declares ${SALE_STATE}`, state === SALE_STATE, `declared state ${state}`);
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
      await blocked(`the card discloses that a sale cannot be routed here (${what}) — not the routable sale this drive judges`, null, done);
    }
  }
  check('card', 'saleBody', 'the card says the collateral is sold through a route the app builds', text.includes(FC.readyNeedsRoute));
  // Revalidate the snapshot (#2481 r1): the card declares the block its
  // readiness was resolved at; the chain must show the same facts there AND
  // now. A move in between is a race, BLOCKED — never certified as a PASS.
  const declared = await card.getAttribute('data-forced-close-block');
  try {
    const [then, now] = await Promise.all([
      /^\d+$/.test(declared ?? '') ? readPinned(() => eligibleAt(BigInt(declared))) : Promise.resolve({ ok: false, why: `no declared block (${declared})` }),
      eligibleAt(),
    ]);
    if (!/^\d+$/.test(declared ?? '')) {
      check('card', 'fresh', 'the card declares the block its readiness rests on', false, then.why);
    } else if (!then.ok || !now.ok) {
      await blocked(`loan ${LOAN_ID} moved while the card was read — at the declared block ${declared}: ${then.ok ? 'eligible' : then.why}; now: ${now.ok ? 'eligible' : now.why}`, null, done);
    } else {
      check('card', 'fresh', 'the chain at the declared block and now still shows the loan eligible', true, `declared block ${declared}, latest ${now.block}`);
    }
  } catch (err) {
    await blocked('the direct RPC could not re-read the loan at the card\'s declared block', err, done);
  }
  const amounts = monetaryAmountsIn(text, { locale: 'en' });
  check('card', 'noAmount', 'the card states no amount', amounts.length === 0, amounts.join(', '));
  const submit = page.getByTestId('forced-close-submit');
  const enabled = await submit
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => submit.isEnabled())
    .catch(() => false);
  const label = enabled ? ((await submit.getAttribute('aria-label')) ?? (await submit.innerText())).replace(/\s+/g, ' ').trim() : '';
  check('card', 'submit', 'the close-out button is shown, enabled and labelled as the close-out', enabled && label === FC.submit, `label "${label}"`);
  await shot(`lender-close-out-card-${LOAN_ID}`);

  if (SUBMIT && preSendFails() > 0) {
    console.log(`SKIP close-out — ${preSendFails()} check(s) failed or request(s) were refused above`);
  } else if (SUBMIT) {
    // Funding is a precondition: an unfunded wallet fails inside the send.
    try {
      const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: WALLET, blockTag: 'pending' }), pub.getGasPrice()]);
      const need = 3_000_000n * gasPrice * 2n;
      if (balance < need) {
        await blocked(`${ROLE} ${WALLET} holds ${formatUnits(balance, 18)} ETH; a sale close-out needs about ${formatUnits(need, 18)}`, null, done);
      }
    } catch (err) {
      await blocked('the direct Base Sepolia RPC could not read the balance before the close-out', err, done);
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
    // The wallet's nonce before the arm: the only evidence that ties a later
    // state change to THIS wallet rather than to a keeper (#2481 r1).
    try {
      nonceBefore = await pub.getTransactionCount({ address: WALLET, blockTag: 'pending' });
    } catch (err) {
      await blocked('the direct RPC could not read the wallet nonce before the close-out', err, done);
    }
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
    if (!wrote() && movedAtGate) {
      PLAN.close();
      throw new Held(
        movedAtGate.startsWith('unknown: ')
          ? `whether loan ${LOAN_ID}'s close-out preconditions moved while it was being confirmed is ${movedAtGate}, so the plan signed nothing`
          : `loan ${LOAN_ID}'s close-out preconditions moved while it was being confirmed (${movedAtGate}), so the plan signed nothing`,
      );
    }
    if (!wrote() && previewVerdict === 'unknown') {
      PLAN.close();
      throw new Held('the node could not run the independent preview of the requested route, so a sale could not be established and the plan signed nothing');
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
  if (err instanceof Held) {
    held = err.message;
  } else {
    stopped = err.message;
  }
  await shot(`lender-close-out-error-${LOAN_ID}`);
  if (wrote()) {
    const hash = sentHash();
    if (hash) await judgeOutcome(hash);
    else stopped += '; the wallet returned no hash — the close-out may still land; check loan status by hand';
  }
  console.log(`STOP  ${stopped}`);
}
// A send that bypassed the plan: armed, nothing sent through it, yet THIS
// WALLET's nonce moved. The loan's status alone proves nothing — any keeper
// may close an overdue loan (#2481 r1) — so a status change without a nonce
// change is a race, stated, not an escape.
let escaped = false;
let escapeUnknown = null;
/** The plan was armed, sent nothing, and the wallet's nonce could not be
 *  read: a send through another connector cannot be ruled out. */
let writeUnknown = false;
if (armedOnce && !wrote()) {
  try {
    const [nonceAfter, status] = await Promise.all([
      pub.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      read('getLoanDetails', [LOAN_ID]).then((l) => Number(l.status)),
    ]);
    escaped = nonceBefore !== null && nonceAfter > nonceBefore;
    if (escaped) {
      console.log(`ESCAPE ${ROLE}'s nonce moved ${nonceBefore} → ${nonceAfter}, but the write plan never allowed a send`);
    } else if (status !== ACTIVE) {
      // Nothing was written by this drive; the loan simply moved under it: a
      // held precondition, resolved with the others below.
      const race = `the plan allowed no send and this wallet sent nothing, but loan ${LOAN_ID} is now status ${status}, closed by someone else in the meantime (a race)`;
      held = held === null ? race : `${held}; ${race}`;
    }
    // Nonce unchanged and the loan still Active: PROVABLY no write, so the
    // run stays on the pre-write path, where a failed check is a FAIL.
  } catch (err) {
    writeUnknown = true;
    escapeUnknown = `the plan allowed no send, and the direct RPC could not read the wallet nonce or the loan (${err.message}) — a send through another connector cannot be ruled out`;
  }
}
// The final eligibility read is taken BEFORE the page's ledgers are judged:
// the page keeps running while it is awaited, so an error or a refused
// request it records meanwhile lands in the checks below rather than after.
const finalEligibility =
  !wrote() && !escaped && !writeUnknown && stopped === null && held === null
    ? await eligibleAt(null).catch((err) => ({ ok: false, unknown: err.shortMessage ?? err.message }))
    : null;
check('pageHealth', 'noPageErrors', 'no page errors', pageErrors().length === 0, pageErrors().join(' | ').slice(0, 300));
// A held run's unconsumed step, and the gate's marked refusal of the one
// request it withheld, are not findings (`HELD_REFUSAL`); every other refusal
// is. Judged after the nonce reconciliation, which can itself hold the run.
const heldRun = held !== null;
const ownHold = (b) => String(b.reason).startsWith(`signing gate: ${HELD_REFUSAL}`);
const violations = heldRun ? violationsSoFar().filter((b) => !ownHold(b)) : violationsSoFar();
check(
  'writeDiscipline',
  'noRefusals',
  SUBMIT ? 'the page asked to sign only the planned close-out' : 'the page attempted no write in a read-only session',
  violations.length === 0,
  violations.map((b) => `${b.reason} ${b.url ?? ''}`.trim()).join(' | '),
);
if (armedOnce && !heldRun) {
  check('writeDiscipline', 'planned', 'the close-out was sent through the gated wallet, exactly once', wrote(), `plan step ${step()?.status}`);
}
// #2481 r3 — ARMING is not a write. Only a send the plan consumed, an escape
// the nonce proves, or a nonce that could not be read (a write that cannot
// be ruled out) puts the run on the post-write path.
const wroteAny = wrote() || escaped || writeUnknown;
// The moved-precondition rule (#2505), applied once, here: after the nonce
// reconciliation (so "nothing was sent" is established, not assumed) and
// before any pre-write verdict. A failure already recorded (the checks above
// include page health and write discipline), or a stop the drive hit, stands
// whatever moved afterwards. Otherwise a held stop is BLOCKED, and a run that reached
// its verdict re-reads its eligibility at the latest block, roster included —
// a read-only drive never reaches the signing gate, so this is the only
// re-read a change made after the card's snapshot would meet.
if (!wroteAny && failedCount() === 0 && stopped === null) {
  let why = held;
  if (why === null && finalEligibility !== null) {
    const now = finalEligibility;
    if (now.unknown) why = `the direct RPC could not re-read loan ${LOAN_ID}'s eligibility before the verdict, so whether it moved is unknown (${now.unknown})`;
    else if (!now.ok) why = `loan ${LOAN_ID} moved before the verdict (block ${now.block}): ${now.why}`;
  }
  if (why !== null) await blocked(`${why}; this wallet sent nothing`, null, done);
} else if (held !== null) {
  stopped = [stopped, held].filter(Boolean).join('; ');
}
try {
  await done();
} catch (err) {
  console.log(`(teardown failed: ${err.message} — the verdict below stands)`);
}
for (const line of MANIFEST.render()) console.log(line);
const VERDICT = runVerdict({
  rows: MANIFEST.rows(),
  wrote: wroteAny,
  stopped: [stopped, escapeUnknown].filter(Boolean).join('; ') || null,
  preWriteFailure: !wroteAny && failedCount() > 0,
  gateEscape: escaped,
  outcomeClaims: SUBMIT ? OUTCOME : [],
  evidence: {
    failed: 'see the GATE refusals and the manifest above',
    left: "the TX and STOP lines above give the close-out's hash and what its receipt showed; check the loan by hand if neither does",
    escape: "this wallet's nonce moved, but the write plan never allowed a send — it went through another connector (see the ESCAPE line above)",
  },
});
console.log(VERDICT.line);
process.exit(VERDICT.exit);
