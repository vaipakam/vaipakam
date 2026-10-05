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
// WRITE DISCIPLINE — enforced, not promised. Every signing request the
// page makes passes a gate in THIS process before the injected wallet
// sees it. Allowed, per phase and role:
//   borrower, posting phase:  setAutoRefinanceCaps(<loan>, on, typed
//                             ceiling, ~now+length+30d), a BOUNDED
//                             principal-asset approve(Diamond, …), and a
//                             createOffer whose WHOLE payload is bound to
//                             the loan and the typed terms before signing
//                             (see `createOfferMismatches`)
//   lender, accept phase:     principal-asset approve(Diamond ≤ principal |
//                             Permit2), acceptOffer / acceptOfferWithPermit
//                             for <request> with terms naming this lender,
//                             the borrower, the loan and the principal, the
//                             AcceptTerms signature for this lender, and a
//                             Permit2 transfer signature for the principal
//                             asset to the Diamond
// Anything else is refused at the wallet (EIP-1193 4001), recorded, and
// ends the drive as a FAIL. Outside its phase a role may write nothing.
// Every transaction hash is captured at the wallet boundary and reported
// with its receipt status, and the drive cross-checks the count against
// each role's nonce delta so a write that bypassed the capture would show.
//
// Verdicts (the three-verdict contract in run-live-batch.mjs):
//   0 PASS     — every assertion held.
//   1 FAIL     — an assertion failed, a write was refused by the gate, a
//                transaction reverted, or the UI could not complete a
//                step it should have.
//   2 BLOCKED  — a precondition did not hold BEFORE anything was written
//                (no REFI_LOAN_ID, site build mismatch, chain facts differ,
//                balances short, an open request already exists,
//                credentials missing, or either browser session could not
//                be set up — both are set up before the first write).
// Once the first transaction has been sent, nothing exits BLOCKED: the
// drive has changed chain state and its report must be read.
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
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
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
import { confirmWrite } from './writeConfirm.mjs';
import { expectedPostureFrom, postureCopyFrom } from './refinancePosture.mjs';

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
  return out.replace(/https?:\/\/[^\s"'<>)]+/g, (u) =>
    RPC_ORIGIN && u.startsWith(RPC_ORIGIN) ? `${RPC_ORIGIN}/***` : redactUrl(u),
  );
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
const WORKERS_DEV_URL =
  process.env.WORKERS_DEV_URL ?? 'https://vaipakam-app.dawn-fire-139e.workers.dev';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

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

// ---------------------------------------------------------------------
// Bookkeeping for the report.
// ---------------------------------------------------------------------
const checks = []; // { label, ok, observed }
const findings = []; // UI observations worth recording
const sentTxs = []; // { role, purpose, hash }
const refusals = []; // write-gate refusals — each one fails the drive
let firstWriteSent = false;

function check(label, ok, observed) {
  checks.push({ label, ok: Boolean(ok), observed });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${observed !== undefined ? `  — observed: ${observed}` : ''}`);
  return Boolean(ok);
}
function note(s) {
  findings.push(s);
  console.log(`note  ${s}`);
}
/** Stop the flow: an unexpected state. FAIL once anything was written. */
class Stop extends Error {}
function stop(why) {
  throw new Stop(why);
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
// The write gate. Phase-scoped allowlist, decided in this process.
// ---------------------------------------------------------------------
const gate = {
  borrower: { open: false },
  lender: { open: false, requestId: null },
};

function decodeDiamondCall(data) {
  try {
    return decodeFunctionData({ abi: DIAMOND_ABI, data });
  } catch {
    return null;
  }
}

/**
 * What the borrower's createOffer must carry, bound field by field BEFORE
 * signing (Codex #2422 r1 P1). Set once the preconditions have read the
 * loan; until then `judgeTx` refuses every createOffer.
 *
 * The expected values are the refinance request's CONTRACT, not a copy of
 * whatever the form happens to send: same principal asset and amount as
 * the loan (amountMax too — a request is taken whole), the loan's
 * collateral identity verbatim (that is what selects carry-over), the
 * loan's prepay asset, partial-repay and interest-mode flags, the TYPED
 * ceiling and length, a refinance tag for THIS loan, the borrower's
 * consent, all-or-nothing fill, no prepay listing / parallel sale /
 * periodic cadence, and an expiry about REQUEST_WINDOW_DAYS out.
 *
 * The rate FLOOR is bound to 0, not to the typed ceiling: a borrow
 * request is a band whose floor the app posts as 0 and whose ceiling is
 * what the borrower typed (Offers.tsx: "Borrow requests posted by this
 * app carry floor 0 / ceiling Y by design"; loan 22's request #45
 * persisted floor 0 / ceiling 1200). Binding the floor to the ceiling
 * would refuse the form's legitimate post.
 */
let EXPECT = null;
const REQUEST_WINDOW_SEC = 30n * 86_400n; // RefinanceFlow's REQUEST_WINDOW_DAYS
const CLOCK_SLACK_SEC = 900n; // local clock vs block time, either way
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const within = (v, centre) => v >= centre - CLOCK_SLACK_SEC && v <= centre + CLOCK_SLACK_SEC;

function createOfferMismatches(p) {
  const L = EXPECT.loan;
  const want = [
    ['offerType', Number(p.offerType), 1],
    ['lendingAsset', p.lendingAsset, L.principalAsset, eq],
    ['amount', p.amount, L.principal],
    ['amountMax', p.amountMax, L.principal],
    ['interestRateBps (floor)', p.interestRateBps, 0n],
    ['interestRateBpsMax (typed ceiling)', p.interestRateBpsMax, RATE_BPS],
    ['durationDays (typed length)', p.durationDays, DAYS_N],
    ['assetType', Number(p.assetType), 0],
    ['tokenId', p.tokenId, 0n],
    ['quantity', p.quantity, 1n],
    ['collateralAsset', p.collateralAsset, L.collateralAsset, eq],
    ['collateralAmount', p.collateralAmount, L.collateralAmount],
    ['collateralAmountMax', p.collateralAmountMax, L.collateralAmount],
    ['collateralAssetType', Number(p.collateralAssetType), Number(L.collateralAssetType)],
    ['collateralTokenId', p.collateralTokenId, L.collateralTokenId],
    ['collateralQuantity', p.collateralQuantity, L.collateralQuantity],
    ['prepayAsset', p.prepayAsset, L.prepayAsset, eq],
    ['allowsPartialRepay', p.allowsPartialRepay, L.allowsPartialRepay],
    ['useFullTermInterest', p.useFullTermInterest, L.useFullTermInterest],
    ['creatorRiskAndTermsConsent', p.creatorRiskAndTermsConsent, true],
    ['periodicInterestCadence', Number(p.periodicInterestCadence), 0],
    ['fillMode (all-or-nothing)', Number(p.fillMode), 1],
    ['allowsPrepayListing', p.allowsPrepayListing, false],
    ['allowsParallelSale', p.allowsParallelSale, false],
    ['refinanceTargetLoanId', p.refinanceTargetLoanId, LOAN_ID],
  ];
  const bad = want
    .filter(([, got, exp, cmp]) => !(cmp ? cmp(got, exp) : got === exp))
    .map(([k, got, exp]) => `${k}=${got} (want ${exp})`);
  // The request's own hard expiry: ~REQUEST_WINDOW_DAYS after posting.
  if (!within(BigInt(p.expiresAt), nowSec() + REQUEST_WINDOW_SEC)) {
    bad.push(`expiresAt=${p.expiresAt} (want ~now+30d)`);
  }
  return bad;
}

/** @returns {{ ok: true, purpose: string } | { ok: false, why: string }} */
function judgeTx(role, tx, principalAsset) {
  const g = gate[role];
  if (!g.open) return { ok: false, why: `${role} may not write outside its phase` };
  if (!EXPECT) return { ok: false, why: 'gate not armed (preconditions unread)' };
  if (tx.value && BigInt(tx.value) !== 0n) return { ok: false, why: 'non-zero value' };
  if (!tx.to || !tx.data) return { ok: false, why: 'missing to/data' };
  const principal = EXPECT.loan.principal;
  if (eq(tx.to, principalAsset)) {
    let d;
    try {
      d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    } catch {
      return { ok: false, why: 'unrecognised call on the principal asset' };
    }
    if (d.functionName !== 'approve') return { ok: false, why: `principal-asset ${d.functionName}` };
    const [spender, amount] = d.args;
    const toDiamond = eq(spender, DIAMOND);
    if (!toDiamond && !(role === 'lender' && eq(spender, PERMIT2))) {
      return { ok: false, why: `approve to unexpected spender ${spender}` };
    }
    // Bounded: 0 is the form's reset / unwind; otherwise the borrower's
    // payoff approval (principal + the interest the payoff can reach,
    // capped well above it) or the lender's principal. A Permit2
    // approval moves nothing by itself, so its size is not bounded here.
    if (toDiamond && amount !== 0n) {
      const cap = role === 'borrower' ? EXPECT.payoffApprovalCap : principal;
      if (amount > cap) return { ok: false, why: `approve(Diamond, ${amount}) above the ${cap} this flow needs` };
    }
    return { ok: true, purpose: `approve(${toDiamond ? 'Diamond' : 'Permit2'}, ${amount})` };
  }
  if (!eq(tx.to, DIAMOND)) return { ok: false, why: `call to unexpected contract ${tx.to}` };
  const d = decodeDiamondCall(tx.data);
  if (!d) return { ok: false, why: 'undecodable Diamond call' };
  if (role === 'borrower') {
    if (d.functionName === 'setAutoRefinanceCaps') {
      const [loanId, enabled, maxRateBps, maxNewExpiry] = d.args;
      const bad = [];
      if (loanId !== LOAN_ID) bad.push(`loanId=${loanId}`);
      if (enabled !== true) bad.push(`enabled=${enabled}`);
      if (BigInt(maxRateBps) !== RATE_BPS) bad.push(`maxRateBps=${maxRateBps} (want ${RATE_BPS})`);
      if (!within(BigInt(maxNewExpiry), nowSec() + DAYS_N * 86_400n + REQUEST_WINDOW_SEC)) {
        bad.push(`maxNewExpiry=${maxNewExpiry} (want ~now+${DAYS_N}d+30d)`);
      }
      if (bad.length) return { ok: false, why: `setAutoRefinanceCaps mismatch: ${bad.join(', ')}` };
      return { ok: true, purpose: `setAutoRefinanceCaps(${d.args.join(', ')})` };
    }
    if (d.functionName === 'createOffer') {
      const bad = createOfferMismatches(d.args[0]);
      if (bad.length) return { ok: false, why: `createOffer payload mismatch: ${bad.join('; ')}` };
      return { ok: true, purpose: `createOffer(refinance of loan ${LOAN_ID})` };
    }
    return { ok: false, why: `borrower Diamond call ${d.functionName}` };
  }
  // lender
  if (d.functionName === 'acceptOffer' || d.functionName === 'acceptOfferWithPermit') {
    const [offerId, terms] = d.args;
    if (g.requestId === null || offerId !== g.requestId) {
      return { ok: false, why: `${d.functionName} for offer ${offerId}, expected ${g.requestId}` };
    }
    const bad = [];
    if (!eq(terms?.acceptor, LENDER)) bad.push(`acceptor=${terms?.acceptor}`);
    if (!eq(terms?.offerCreator, BORROWER)) bad.push(`offerCreator=${terms?.offerCreator}`);
    if (terms?.refinanceTargetLoanId !== LOAN_ID) bad.push(`refinanceTargetLoanId=${terms?.refinanceTargetLoanId}`);
    if (terms?.amount !== principal) bad.push(`amount=${terms?.amount}`);
    if (terms?.riskAndTermsConsent !== true) bad.push(`riskAndTermsConsent=${terms?.riskAndTermsConsent}`);
    if (bad.length) return { ok: false, why: `${d.functionName} terms mismatch: ${bad.join(', ')}` };
    return { ok: true, purpose: `${d.functionName}(offer ${offerId})` };
  }
  return { ok: false, why: `lender Diamond call ${d.functionName}` };
}

function judgeTypedData(role, signer, json, principalAsset) {
  const g = gate[role];
  if (!g.open) return { ok: false, why: `${role} may not sign outside its phase` };
  let t;
  try {
    t = JSON.parse(json);
  } catch {
    return { ok: false, why: 'unparseable typed data' };
  }
  if (role !== 'lender') return { ok: false, why: `${role} signature ${t.primaryType}` };
  if (t.primaryType === 'AcceptTerms') {
    if (!eq(t.domain?.verifyingContract, DIAMOND)) return { ok: false, why: 'AcceptTerms for another contract' };
    if (!eq(t.message?.acceptor, signer)) return { ok: false, why: 'AcceptTerms for another acceptor' };
    if (String(t.message?.refinanceTargetLoanId) !== String(LOAN_ID)) {
      return { ok: false, why: `AcceptTerms refinanceTargetLoanId ${t.message?.refinanceTargetLoanId}` };
    }
    return { ok: true, purpose: 'sign AcceptTerms' };
  }
  if (t.primaryType === 'PermitTransferFrom') {
    if (!eq(t.domain?.verifyingContract, PERMIT2)) return { ok: false, why: 'permit for another verifier' };
    if (!eq(t.message?.spender, DIAMOND)) return { ok: false, why: 'permit to another spender' };
    if (!eq(t.message?.permitted?.token, principalAsset)) return { ok: false, why: 'permit for another token' };
    return { ok: true, purpose: `sign Permit2 transfer (${t.message?.permitted?.amount})` };
  }
  return { ok: false, why: `unexpected signature type ${t.primaryType}` };
}

const SIGNING_METHODS = [
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_signTransaction',
  'wallet_sendCalls',
  'eth_sendUserOperation',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
];

/**
 * Wrap the injected provider so every signing request is judged here
 * first, and every sent hash is reported back. Installed AFTER `launch()`
 * adds its own init script, so it runs second and finds the provider in
 * place; EIP-6963 announced the same object, so the wrap covers it too.
 */
async function installGate(ctx, role, principalAsset, advanced = true) {
  await ctx.exposeBinding('__liveRefiGate', async (_src, { method, params }) => {
    let v;
    if (method === 'eth_sendTransaction') v = judgeTx(role, params?.[0] ?? {}, principalAsset);
    else if (method === 'eth_signTypedData_v4') v = judgeTypedData(role, params?.[0], params?.[1], principalAsset);
    else v = { ok: false, why: `unexpected wallet method ${method}` };
    if (!v.ok) {
      refusals.push(`${role}: ${method} — ${v.why}`);
      console.log(`GATE  refused ${role} ${method}: ${v.why}`);
    } else {
      console.log(`GATE  allowed ${role}: ${v.purpose}`);
    }
    return v;
  });
  await ctx.exposeBinding('__liveRefiSent', async (_src, { hash, purpose }) => {
    firstWriteSent = true;
    sentTxs.push({ role, purpose, hash });
    console.log(`TX    ${role} sent ${purpose}: ${hash}`);
  });
  await ctx.addInitScript(
    ({ methods, advanced }) => {
      if (advanced) {
        try {
          localStorage.setItem('app.mode', 'advanced');
        } catch {
          /* storage blocked — the card check will say so */
        }
      }
      const p = window.ethereum;
      if (!p || p.__liveRefiWrapped) return;
      const inner = p.request;
      p.request = async (payload) => {
        const method = payload?.method;
        if (!methods.includes(method)) return inner(payload);
        const v = await window.__liveRefiGate({ method, params: payload.params });
        if (!v.ok) {
          const e = new Error(`live-refinance write gate refused: ${v.why}`);
          e.code = 4001;
          throw e;
        }
        const res = await inner(payload);
        if (method === 'eth_sendTransaction') {
          await window.__liveRefiSent({ hash: res, purpose: v.purpose });
        }
        return res;
      };
      p.__liveRefiWrapped = true;
    },
    { methods: SIGNING_METHODS, advanced },
  );
}

// ---------------------------------------------------------------------
// Report — printed on every exit after the first precondition.
// ---------------------------------------------------------------------
async function report() {
  console.log('\n=== transactions sent ===');
  if (sentTxs.length === 0) console.log('(none)');
  for (const t of sentTxs) {
    let status = 'unknown';
    try {
      const r = await pub.waitForTransactionReceipt({ hash: t.hash, timeout: 120_000 });
      status = `${r.status} @ block ${r.blockNumber}`;
    } catch (e) {
      status = `receipt unavailable (${String(e.shortMessage ?? e.message).slice(0, 80)})`;
    }
    console.log(`${t.role.padEnd(8)} ${t.hash}  ${t.purpose}  → ${status}`);
  }
  if (refusals.length) {
    console.log('\n=== write-gate refusals ===');
    for (const r of refusals) console.log(r);
  }
  if (findings.length) {
    console.log('\n=== UI / flow notes ===');
    for (const f of findings) console.log(`- ${f}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);
  for (const c of failed) console.log(`FAILED: ${c.label}`);
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
  await blocked(
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
  const [riskGate, autoRefi, paused, flags, collLiquidity] = await Promise.all([
    read('getRiskAccessGateEnabled', [], head),
    read('getAutoRefinanceEnabled', [], head),
    read('paused', [], head),
    read('getMasterFlags', [], head),
    read('checkLiquidity', [loan.collateralAsset], head),
  ]);
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
  const openRequests = [];
  for (const id of offerIds) {
    const o = await read('getOfferDetails', [id], head);
    if (
      o.refinanceTargetLoanId === LOAN_ID &&
      !o.accepted &&
      !eq(o.creator, '0x0000000000000000000000000000000000000000') &&
      (o.expiresAt === 0n || o.expiresAt > block.timestamp)
    ) {
      openRequests.push(id);
    }
  }
  const caps = await read('getAutoRefinanceCaps', [LOAN_ID], head);
  // The LIVE loan-initiation fee rate (ConfigFacet), pinned to the same
  // head — the payoff reserve below is computed from it, never assumed.
  const lifBps = await read('getLoanInitiationFeeBps', [], head);
  return { head, now: block.timestamp, loan, riskGate, autoRefi, paused, flags, collLiquidity, tosB, tosL, b, l, offerIds, openRequests, caps, lifBps };
});

const { loan } = pre;
const misses = [];
const want = (label, ok, observed) => {
  console.log(`pre   ${ok ? 'ok  ' : 'MISS'} ${label}: ${observed}`);
  if (!ok) misses.push(`${label} (observed ${observed})`);
};
want('loan is Active', loan.status === LOAN_STATUS.ACTIVE, loan.status);
want('stored borrower is the borrower role', eq(loan.borrower, BORROWER), loan.borrower);
want('accepting lender differs from the current lender', !eq(loan.lender, LENDER), loan.lender);
want('accepting lender is not the borrower', !eq(LENDER, BORROWER), LENDER);
want('collateral recorded Illiquid on the loan', loan.collateralLiquidity === LIQUIDITY_ILLIQUID, loan.collateralLiquidity);
want('collateral is Illiquid now (checkLiquidity)', Number(pre.collLiquidity) === LIQUIDITY_ILLIQUID, pre.collLiquidity);
want('riskAndTermsConsentFromBoth', loan.riskAndTermsConsentFromBoth === true, loan.riskAndTermsConsentFromBoth);
want('ERC-20 loan with ERC-20 collateral', Number(loan.assetType) === 0 && Number(loan.collateralAssetType) === 0, `${loan.assetType}/${loan.collateralAssetType}`);
want('not past maturity (form stays pre-grace)', pre.now < loan.startTime + loan.durationDays * 86_400n, `now ${pre.now}, due ${loan.startTime + loan.durationDays * 86_400n}`);
want('no periodic-interest cadence', Number(loan.periodicInterestCadence) === 0, loan.periodicInterestCadence);
if (LOAN_ID === 22n) {
  for (const [k, v] of Object.entries(LOAN22_FACTS)) {
    want(`loan 22 ${k}`, typeof v === 'string' ? eq(loan[k], v) : loan[k] === v, loan[k]);
  }
}
want('risk-access gate disabled (no tier / pair-consent setup needed)', pre.riskGate === false, pre.riskGate);
want('protocol not paused', pre.paused === false, pre.paused);
want('borrower accepted current Terms', pre.tosB === true, pre.tosB);
want('lender accepted current Terms', pre.tosL === true, pre.tosL);
want('no open refinance request on this loan', pre.openRequests.length === 0, pre.openRequests.join(',') || 'none');
want('borrower has no pending transactions', pre.b.nonceLatest === pre.b.noncePending, `${pre.b.nonceLatest}/${pre.b.noncePending}`);
want('lender has no pending transactions', pre.l.nonceLatest === pre.l.noncePending, `${pre.l.nonceLatest}/${pre.l.noncePending}`);
want('lender holds the principal', pre.l.principal >= loan.principal, formatUnits(pre.l.principal, 18));
// What the borrower must hold SPARE when the lender accepts: the payoff's
// interest share plus the new loan's initiation fee (the new principal
// arrives in the same transaction). The interest share is the FULL term
// at the loan's rate — exact for a full-term-interest loan, an upper
// bound for a pro-rata one — which holds because the precheck above
// requires the loan to be pre-maturity (no late fee yet). The fee uses
// the LIVE rate read at the pinned head, so a governance retune of
// `loanInitiationFeeBps` moves this figure instead of hiding behind a
// hard-coded one (Codex #2422 r1 P2).
const fullTermInterest = (loan.principal * loan.interestRateBps * loan.durationDays) / (10_000n * 365n);
const lifWei = (loan.principal * BigInt(pre.lifBps)) / 10_000n;
const borrowerSpareNeed = fullTermInterest + lifWei;
console.log(`pre   live loan-initiation fee: ${pre.lifBps} bps → ${formatUnits(lifWei, 18)} on the new principal`);
want('borrower holds the payoff top-up (interest share + live LIF)', pre.b.principal >= borrowerSpareNeed, `${formatUnits(pre.b.principal, 18)} ≥ ${formatUnits(borrowerSpareNeed, 18)}`);
const GAS_FLOOR = 300_000_000_000_000n; // 0.0003 ETH — several Base Sepolia txs
want('borrower has gas', pre.b.eth >= GAS_FLOOR, formatUnits(pre.b.eth, 18));
want('lender has gas', pre.l.eth >= GAS_FLOOR, formatUnits(pre.l.eth, 18));
console.log(`pre   auto-refinance switch: ${pre.autoRefi}; matcher partialFill: ${pre.flags[2]}; caps on loan: ${JSON.stringify(pre.caps, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
if (misses.length) {
  await blocked(`chain facts differ from the drive's preconditions — nothing was written:\n  - ${misses.join('\n  - ')}`);
}
if (pre.autoRefi && pre.flags[2]) {
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
const expectedPosture = expectedPostureFrom({
  paused: pre.paused,
  autoRefinance: pre.autoRefi,
  partialFill: pre.flags[2],
});

const PRINCIPAL_ASSET = loan.principalAsset;
// Arm the write gate with the loan it binds every payload to. The payoff
// approval cap is deliberately loose (twice the full-term interest plus a
// tenth of principal over principal): it bounds a runaway approval, while
// the exact figure is the form's own business and grows with late fees.
EXPECT = {
  loan,
  payoffApprovalCap: loan.principal + 2n * fullTermInterest + loan.principal / 10n,
};
const baselineCollateral = pre.b.collateral;
const baselineNonces = { borrower: pre.b.nonceLatest, lender: pre.l.nonceLatest };
const baselineOffers = new Set(pre.offerIds.map(String));
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
for (const role of ['borrower', 'lender']) {
  try {
    sessions[role] = await launch({ role, onSetupFailure: 'throw' });
    await installGate(sessions[role].ctx, role, PRINCIPAL_ASSET);
  } catch (err) {
    await closeSession('borrower');
    await closeSession('lender');
    await blocked(`setting up the ${role} browser session failed before any write`, err);
  }
}

// =====================================================================
// From here on, chain state may change: no BLOCKED exits.
// =====================================================================
let exitCode = 0;
let session = sessions.borrower; // the session `shot()` on a stop targets
let requestId = null;
let acceptHash = null;
try {
  // -------------------------------------------------------------------
  // 1. Borrower posts the refinance request through the form.
  // -------------------------------------------------------------------
  const bp = session.page;
  await bp.goto(`${SITE}/positions/${LOAN_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureConnected(bp);

  const card = bp.locator('section.card').filter({ hasText: 'Refinance this loan' });
  if (!(await card.first().waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) {
    await session.shot('refinance-01-no-card');
    stop('the "Refinance this loan" card never rendered for the stored borrower in Advanced mode');
  }
  check('borrower: "Refinance this loan" card renders on /positions/' + LOAN_ID, true);

  // #2349/#2355 posture disclosure — judged against the chain's switches.
  const banner = card.locator('[data-auto-match-posture]');
  const bannerPosture = await pollUntil('posture banner settles', async () => {
    const a = await banner.first().getAttribute('data-auto-match-posture', { timeout: 2_000 });
    return a && a !== 'unknown' ? a : null;
  }, { timeoutMs: 45_000 });
  const bannerText = bannerPosture ? (await banner.first().innerText()).replace(/\s+/g, ' ').trim() : null;
  check(
    `borrower: posture banner states the chain's posture (${expectedPosture})`,
    bannerPosture === expectedPosture && bannerText?.includes(postureCopy[expectedPosture]),
    `${bannerPosture}: "${bannerText}"`,
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

  // Open the gate only now: the confirm is the one action that may write.
  gate.borrower.open = true;
  const confirm = card.getByRole('button', { name: /confirm — post refinance request/i });
  const consentBox = card.locator('input[type="checkbox"]');
  const confirmed = await pollUntil('consent + confirm enabled', async () => {
    if (!(await consentBox.isChecked())) await consentBox.check();
    return confirm.isEnabled();
  }, { timeoutMs: 60_000 });
  if (!confirmed) {
    await session.shot('refinance-04-confirm-disabled');
    stop('"Confirm — post refinance request" never enabled after consent');
  }
  await confirm.click();

  const live = await pollUntil('request is live', async () => {
    if (refusals.length) return 'refused';
    const err = card.locator('.banner-danger');
    if (await err.count()) return `error: ${(await err.first().innerText()).trim()}`;
    const t = await bp.locator('body').innerText();
    const m = t.match(/Refinance request #(\d+) is live/i);
    return m ? m[1] : null;
  }, { timeoutMs: 300_000, everyMs: 2_000 });
  gate.borrower.open = false;
  await session.shot('refinance-05-posted');
  if (refusals.length) stop('the borrower form asked for a write outside the allowlist');
  if (!live || live.startsWith('error')) {
    stop(`the refinance request did not go live: ${live ?? 'timed out'}`);
  }
  const pageRequestId = BigInt(live);

  // Pending card carries the posture disclosure too.
  const pendingCard = bp.locator('section.card').filter({ hasText: new RegExp(`Refinance request #${pageRequestId} is live`, 'i') });
  const pendingPosture = await pendingCard.locator('[data-auto-match-posture]').first()
    .getAttribute('data-auto-match-posture', { timeout: 30_000 }).catch(() => null);
  check(`borrower: the standing request card discloses the posture (${expectedPosture})`, pendingPosture === expectedPosture, pendingPosture);

  // -------------------------------------------------------------------
  // 2. Pin the request on chain from the createOffer receipt itself.
  // -------------------------------------------------------------------
  // Every assertion in this phase GATES the lender phase: a request that
  // is not exactly the one reviewed must never be funded, so a failure
  // here stops the drive rather than only being recorded (Codex #2422 r1).
  const phase2From = checks.length;
  const createTx = sentTxs.find((t) => t.role === 'borrower' && t.purpose.startsWith('createOffer'));
  if (!createTx) stop('no createOffer transaction was captured at the wallet boundary');
  const createRcpt = await pub.waitForTransactionReceipt({ hash: createTx.hash, timeout: 180_000 });
  check('createOffer receipt status success', createRcpt.status === 'success', createRcpt.status);
  for (const t of sentTxs.filter((x) => x.role === 'borrower')) {
    const r = await pub.waitForTransactionReceipt({ hash: t.hash, timeout: 180_000 });
    if (r.status !== 'success') stop(`borrower tx ${t.hash} (${t.purpose}) reverted`);
  }
  const created = createRcpt.logs
    .filter((l) => eq(l.address, DIAMOND))
    .map((l) => {
      try {
        return decodeEventLog({ abi: DIAMOND_ABI, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .filter((e) => e?.eventName === 'OfferCreated');
  if (created.length !== 1) stop(`createOffer receipt carries ${created.length} OfferCreated events`);
  requestId = created[0].args.offerId;
  check('page names the same request id the receipt created', pageRequestId === requestId, `page #${pageRequestId}, receipt #${requestId}`);

  const atCreate = createRcpt.blockNumber;
  const createRcptTs = (await pub.getBlock({ blockNumber: atCreate })).timestamp;
  // The baseline delta over the WHOLE offer index (paginated to its total):
  // the only id this run may have added is the request itself.
  const idsAfter = await allOfferIdsOf(BORROWER, atCreate);
  const newIds = idsAfter.map(String).filter((id) => !baselineOffers.has(id));
  check(
    'exactly one new borrower offer across the full index, and it is the request',
    newIds.length === 1 && newIds[0] === String(requestId),
    `${newIds.join(',') || 'none'} of ${idsAfter.length}`,
  );
  const req = await read('getOfferDetails', [requestId], atCreate);
  check(`request refinanceTargetLoanId == ${LOAN_ID}`, req.refinanceTargetLoanId === LOAN_ID, req.refinanceTargetLoanId);
  check('request refinanceCarryOver == true', req.refinanceCarryOver === true, req.refinanceCarryOver);
  check('request is a borrower offer by the borrower', Number(req.offerType) === 1 && eq(req.creator, BORROWER), `${req.offerType} ${req.creator}`);
  check(`request rate ceiling == ${RATE_BPS} bps (typed ${RATE_PCT}%)`, req.interestRateBpsMax === RATE_BPS, req.interestRateBpsMax);
  check('request rate floor == 0 (a borrow request is a 0..ceiling band)', req.interestRateBps === 0n, req.interestRateBps);
  check(`request durationDays == ${DAYS_N}`, req.durationDays === DAYS_N, req.durationDays);
  check('request amount == old principal', req.amount === loan.principal, req.amount);
  check('request lending asset == old principal asset', eq(req.lendingAsset, loan.principalAsset), req.lendingAsset);
  check('request collateral identity == old collateral', eq(req.collateralAsset, loan.collateralAsset) && req.collateralAmount === loan.collateralAmount, `${req.collateralAsset} × ${req.collateralAmount}`);
  check('request not yet accepted', req.accepted === false, req.accepted);
  check('request records the borrower\u2019s consent', req.creatorRiskAndTermsConsent === true, req.creatorRiskAndTermsConsent);
  check(
    'request expiry is in the future and no later than ~30 days out',
    req.expiresAt > createRcptTs && req.expiresAt <= createRcptTs + REQUEST_WINDOW_SEC + CLOCK_SLACK_SEC,
    `${req.expiresAt} (block ts ${createRcptTs})`,
  );
  console.log(
    `info  request persisted: rate floor ${req.interestRateBps} bps, ceiling ${req.interestRateBpsMax} bps, ` +
      `collateralLiquidity ${req.collateralLiquidity}, useFullTermInterest ${req.useFullTermInterest}, ` +
      `creatorRiskAndTermsConsent ${req.creatorRiskAndTermsConsent}, expiresAt ${req.expiresAt}`,
  );
  const capsNow = await read('getAutoRefinanceCaps', [LOAN_ID], atCreate);
  console.log(`info  caps after posting: enabled ${capsNow.enabled}, maxRateBps ${capsNow.maxRateBps}, maxNewExpiry ${capsNow.maxNewExpiry}`);
  const collAfterPost = await tokenBalance(loan.collateralAsset, BORROWER, atCreate);
  check('posting pulled no collateral from the borrower wallet', collAfterPost === baselineCollateral, `${collAfterPost}`);
  const phase2Failed = checks.slice(phase2From).filter((c) => !c.ok);
  if (phase2Failed.length) {
    stop(
      `the posted request does not match what was reviewed (${phase2Failed.map((c) => c.label).join('; ')}) — ` +
        `NOT proceeding to the lender phase. Request #${requestId} is live on chain; cancel it from the ` +
        `borrower's position page once its cooldown opens.`,
    );
  }

  await closeSession('borrower');

  // -------------------------------------------------------------------
  // 3. A DIFFERENT lender funds it through the Offer Book → guided review.
  // The session already exists (launched and gated before any write).
  // -------------------------------------------------------------------
  session = sessions.lender;
  gate.lender.requestId = requestId;
  const lp = session.page;
  const expectedHref = `/lend?offer=${requestId}&chain=${CHAIN_ID}`;
  let reachedViaBook = false;
  await lp.goto(`${SITE}/offers`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureConnected(lp);
  const fundLink = await pollUntil('request row in the Offer Book', async () => {
    // Someone else may have filled it in the meantime — stop, don't race.
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
    if (!rowText.includes(squash(bookIlliquidTag))) {
      note(`the book row for #${requestId} carries no illiquid-collateral tag: "${rowText}"`);
    }
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
  // Let the review settle (liquidity, grace, dry run) before consenting:
  // a disclosure arriving later clears consent by design.
  await pollUntil('review settled', async () => {
    const t = await lp.locator('body').innerText();
    return !/preparing|checking/i.test(t.slice(t.indexOf('Before you sign')));
  }, { timeoutMs: 45_000 });
  gate.lender.open = true;
  const canSign = await pollUntil('consent + "Fund this borrower" enabled', async () => {
    if (!(await consent.isChecked())) await consent.check();
    await lp.waitForTimeout(1_000);
    return submit.isEnabled();
  }, { timeoutMs: 120_000, everyMs: 3_000 });
  const reviewText = (await lp.locator('main').innerText().catch(() => lp.locator('body').innerText())).replace(/\s+/g, ' ');
  console.log(`\n--- lender review (as rendered) ---\n${reviewText.slice(0, 4000)}\n---`);
  if (/would fail|will fail|revert/i.test(reviewText)) note('the lender review shows a would-fail / revert note (see the transcript above)');
  check('lender: review carries the illiquid-collateral warning (copy.match.illiquidWarning)', reviewText.includes(squash(illiquidWarning)));
  // Evidence, not a verdict: the spec does not say whether a lender funding
  // a refinance request must be told it closes another loan.
  if (!/refinanc/i.test(reviewText)) {
    note('the lender review never says this request refinances an existing loan (accepting it also pays off and closes that loan)');
  }
  await session.shot('refinance-08-lender-review');
  if (!canSign) {
    gate.lender.open = false;
    stop('the deployed UI never enabled "Fund this borrower" for this request (see the review transcript above)');
  }
  await submit.click();

  const outcome = await pollUntil('accept settles', async () => {
    if (refusals.length) return 'refused';
    if (await lp.getByRole('heading', { name: /loan opened/i }).count()) return 'opened';
    const err = lp.locator('.banner-danger[role="alert"]');
    if (await err.count()) {
      const t = (await err.first().innerText()).trim();
      // A submit error is final only once the button is idle again.
      if (await submit.isEnabled().catch(() => false)) return `error: ${t}`;
    }
    return null;
  }, { timeoutMs: 300_000, everyMs: 2_000 });
  gate.lender.open = false;
  await session.shot('refinance-09-lender-done');
  const doneText = (await lp.locator('body').innerText()).replace(/\s+/g, ' ');
  if (refusals.length) stop('the lender flow asked for a write outside the allowlist');
  if (outcome !== 'opened') stop(`the lender's accept did not complete in the UI: ${outcome ?? 'timed out'}`);
  check('lender: the app reports "Loan opened"', true);
  const doneIdx = doneText.search(/loan opened/i);
  console.log(`info  lender done step: ${doneText.slice(doneIdx, doneIdx + 400)}`);

  // -------------------------------------------------------------------
  // 4. On-chain outcome, pinned at or after the accept's block.
  // -------------------------------------------------------------------
  const acceptTx = sentTxs.find((t) => t.role === 'lender' && t.purpose.startsWith('accept'));
  if (!acceptTx) stop('no accept transaction was captured at the wallet boundary');
  acceptHash = acceptTx.hash;
  for (const t of sentTxs.filter((x) => x.role === 'lender')) {
    const r = await pub.waitForTransactionReceipt({ hash: t.hash, timeout: 180_000 });
    if (r.status !== 'success') stop(`lender tx ${t.hash} (${t.purpose}) reverted`);
  }
  const acc = await pub.waitForTransactionReceipt({ hash: acceptHash, timeout: 180_000 });
  check('accept receipt status success', acc.status === 'success', acc.status);
  const evs = acc.logs
    .filter((l) => eq(l.address, DIAMOND))
    .map((l) => {
      try {
        return decodeEventLog({ abi: DIAMOND_ABI, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const accepted = evs.filter((e) => e.eventName === 'OfferAccepted' && e.args.offerId === requestId);
  const refinanced = evs.filter((e) => e.eventName === 'LoanRefinanced');
  if (accepted.length !== 1) stop(`accept receipt carries ${accepted.length} OfferAccepted events for #${requestId}`);
  const newLoanId = accepted[0].args.loanId;
  console.log(`info  accept events: ${evs.map((e) => e.eventName).join(', ')}`);
  check('replacement is a DIFFERENT loan', newLoanId !== LOAN_ID, newLoanId);
  check(
    'LoanRefinanced(old → new, newLender = lender) emitted',
    refinanced.length === 1 &&
      refinanced[0].args.oldLoanId === LOAN_ID &&
      refinanced[0].args.newLoanId === newLoanId &&
      eq(refinanced[0].args.newLender, LENDER) &&
      eq(refinanced[0].args.borrower, BORROWER),
    refinanced.map((e) => `${e.args.oldLoanId}→${e.args.newLoanId} newLender ${e.args.newLender} oldStatus ${e.args.oldLoanNewStatus}`).join('; '),
  );

  const floor = acc.blockNumber;
  const oldConfirmed = await confirmWrite({
    what: `loan ${LOAN_ID} status`,
    minBlock: floor,
    // `cacheTime: 0`: viem caches this action for the client's polling
    // interval, so consecutive attempts would otherwise reuse ONE head
    // read and a head cached as behind could outlive the chain catching
    // up (same reasoning as live-rate-desk's confirmation).
    getBlockNumber: () => pub.getBlockNumber({ cacheTime: 0 }),
    // The RAW reply, pinned to the head it is handed; `decode` below turns
    // it into a loan. Kept apart so a malformed reply is told from a
    // failure to reach anything (#2107 r3, r7).
    read: async (blockNumber) => {
      const { data } = await pub.call({
        to: DIAMOND,
        data: encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'getLoanDetails', args: [LOAN_ID] }),
        blockNumber,
      });
      return data ?? '0x';
    },
    decode: (data) => {
      const l = decodeFunctionResult({ abi: DIAMOND_ABI, functionName: 'getLoanDetails', data });
      return { ...l, status: Number(l.status) };
    },
    accept: (l) => l.status === LOAN_STATUS.REPAID,
  });
  check(
    `old loan ${LOAN_ID} status == 1 (Repaid)`,
    oldConfirmed.ok,
    oldConfirmed.unconfirmed ? `unconfirmed: ${oldConfirmed.why}` : oldConfirmed.value?.status,
  );
  const fresh = await loanOf(newLoanId, floor);
  check(`replacement loan ${newLoanId} status == 0 (Active)`, fresh.status === LOAN_STATUS.ACTIVE, fresh.status);
  check('replacement offerId == the request', fresh.offerId === requestId, fresh.offerId);
  check('replacement borrower unchanged', eq(fresh.borrower, BORROWER), fresh.borrower);
  check('replacement lender == the accepting `lender` role', eq(fresh.lender, LENDER), fresh.lender);
  check('replacement collateralAsset == old', eq(fresh.collateralAsset, loan.collateralAsset), fresh.collateralAsset);
  check('replacement collateralAmount == old', fresh.collateralAmount === loan.collateralAmount, fresh.collateralAmount);
  check('replacement collateralLiquidity == Illiquid', fresh.collateralLiquidity === LIQUIDITY_ILLIQUID, fresh.collateralLiquidity);
  check('replacement riskAndTermsConsentFromBoth == true', fresh.riskAndTermsConsentFromBoth === true, fresh.riskAndTermsConsentFromBoth);
  check('replacement principal == old principal', fresh.principal === loan.principal, fresh.principal);
  check('replacement principal asset == old', eq(fresh.principalAsset, loan.principalAsset), fresh.principalAsset);
  check(`replacement interestRateBps == the request ceiling (${RATE_BPS})`, fresh.interestRateBps === RATE_BPS, fresh.interestRateBps);
  check(`replacement durationDays == ${DAYS_N}`, fresh.durationDays === DAYS_N, fresh.durationDays);
  const reqAfter = await read('getOfferDetails', [requestId], floor);
  check('request marked accepted', reqAfter.accepted === true, reqAfter.accepted);
  const lenderLoans = await read('getUserActiveLoans', [LENDER], floor).catch(() => null);
  if (lenderLoans) {
    check('replacement listed among the lender’s active loans', lenderLoans.includes(newLoanId), `${lenderLoans.length} loans`);
  }
  const collEnd = await tokenBalance(loan.collateralAsset, BORROWER, floor);
  check(
    'borrower collateral WALLET balance unchanged across post + accept (carry-over, not re-pledge)',
    collEnd === baselineCollateral,
    `${baselineCollateral} → ${collEnd}`,
  );

  // Every write the wallets made is one the gate saw.
  const [nb, nl] = await Promise.all([
    pub.getTransactionCount({ address: BORROWER, blockTag: 'latest' }),
    pub.getTransactionCount({ address: LENDER, blockTag: 'latest' }),
  ]);
  const sentB = sentTxs.filter((t) => t.role === 'borrower').length;
  const sentL = sentTxs.filter((t) => t.role === 'lender').length;
  check('borrower nonce delta == captured borrower txs', nb - baselineNonces.borrower === sentB, `${nb - baselineNonces.borrower} vs ${sentB}`);
  check('lender nonce delta == captured lender txs', nl - baselineNonces.lender === sentL, `${nl - baselineNonces.lender} vs ${sentL}`);
  console.log(`\nresult  request offer #${requestId} → replacement loan #${newLoanId}; old loan #${LOAN_ID} closed`);
} catch (err) {
  exitCode = 1;
  const why = err instanceof Stop ? err.message : `unexpected error: ${String(err.shortMessage ?? err.message ?? err).split('\n')[0]}`;
  console.log(`\nSTOPPED: ${why}`);
  if (!firstWriteSent) console.log('(no transaction had been sent when the drive stopped)');
  if (err instanceof Stop) {
    /* already explained */
  } else if (err?.stack) {
    console.log(String(err.stack).split('\n').slice(1, 4).join('\n'));
  }
  try {
    await session?.shot('refinance-zz-stopped');
  } catch {
    /* the page may already be gone */
  }
} finally {
  gate.borrower.open = false;
  gate.lender.open = false;
  await closeSession('borrower');
  await closeSession('lender');
}

await report();
if (refusals.length || checks.some((c) => !c.ok)) exitCode = 1;
console.log(exitCode === 0 ? '\nlive refinance review: ALL CHECKS PASSED' : '\nlive refinance review: FAILED (see above)');
process.exit(exitCode);
