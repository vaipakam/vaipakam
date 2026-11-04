// #2814 live verification — the loan page's automatic-extension card and the
// extension reserve, driven end to end through the deployed app with two dev
// wallets on the Base Sepolia Diamond.
//
// Fixture: LOAN_ID names an Active, non-rental ERC-20 loan with no interest
// schedule (cadence 0) whose borrower position BORROWER_ROLE holds and whose
// lender position LENDER_ROLE holds, with no extension reserve standing. If
// none stands, `live-seed-illiquid-loan.mjs` makes one through the app.
//
// Steps:
//   0. Build check: SITE_URL serves the same `/assets/index-*.js` as
//      REFERENCE_SITE_URL (a workers.dev host); alpha02 is refused.
//      Chain preflight: the fixture's shape, the protocol switch on and not
//      paused, both wallets' Terms, balances, nonces, and the borrower's
//      allowance to the Diamond at 0. Every past-grace Active loan on the Diamond is
//      listed for step 6.
//   1. Borrower, /positions/LOAN_ID: the card (data-testid auto-extend)
//      renders with the switch on, the window as the chain states it, and
//      "Your limits as borrower". The borrower saves limits (a highest rate
//      and a latest end date) through a six-row review receipt; exactly one
//      setAutoExtendBorrowerCaps with those values is signed, and
//      getAutoExtendBorrowerCaps(loanId) returns them at the receipt's block.
//   2. Lender, same page: saves overlapping limits the same way
//      (setAutoExtendLenderCaps, getAutoExtendLenderCaps). Back as borrower,
//      the band line states the overlap, worded as limits, not a promise.
//   3. Borrower: after a fresh page load bracketed by two chain reads, the
//      reserve panel (data-testid extend-reserve) shows the chain's figures,
//      reserved 0, naming a charge "now" only while the window is open. A small reserve is added through its
//      six-row receipt (the exact amount stated): approve if needed, then
//      fundExtendReserve(loanId, amount); getExtendFunding shows it reserved
//      and the receipt carries ExtendReserveFunded.
//   4. Borrower: the reserve is withdrawn through its receipt with exactly
//      one withdrawExtendReserve(borrower, loanId, amount); reserved reads 0,
//      the outcome banner stays in view after the panel empties, and the
//      indexer files the deposit under the borrower
//      (GET /activity?actor=…&kind=ExtendReserveFunded; read last, so the
//      indexer's lag behind the head is spent on the steps that follow).
//   5. A second reserve is added; the LENDER's /claims lists no reserve; the
//      BORROWER's /claims lists it under "Extension reserves" and it is
//      withdrawn from there. No reserve and no approval is left standing.
//   6. Read-only: on a past-grace loan of this Diamond, if one exists, the
//      forced close-out card renders and makes no KYC refusal claim (retail
//      runs with KYC enforcement off). With none, NOT VERIFIED, named.
//
// FUNDS MOVED, all on Base Sepolia with testnet tokens: no funds move to set
// limits (gas only). Each deposit moves RESERVE of the loan's principal asset
// from the borrower's wallet into the borrower's own vault, reserved for this
// loan (ExtendReserveFunded); each withdrawal moves it back from the vault to
// the borrower's wallet (ExtendReserveWithdrawn). Nothing reaches the lender
// or the treasury. Both wallets pay gas. The limits both sides set stay in
// force afterwards (they are what a later extension of this loan would use);
// turn them off from the card to clear them.
//
// WRITE DISCIPLINE (the seed and refinance drives', reused):
//   (A) ONE ORDERED WRITE PLAN (writePlan.mjs), every step a COMPLETE
//       expected object (autoExtendExpected.mjs):
//         b-caps → l-caps → b-approve-reset? → b-approve-set? → b-fund →
//         b-withdraw → b-approve-reset-2? → b-approve-set-2? → b-fund-2 →
//         b-withdraw-2
//       Anything else is refused and latches the plan.
//   (B) THE PLAN IS CLOSED UNTIL ARMED: each role is armed immediately before
//       its confirm click and closed when the click settles.
//   (C) THE GATE LIVES IN THE WALLET (`launch({ signingGate, pinnedChainId })`)
//       and the browser refuses page-initiated writes (`readOnlyEgress`).
//   (D) Nonces are reconciled per wallet at the end against the startup
//       baseline: a send the plan never allowed is a FAIL.
//
// Verdicts (FOUR_VERDICT_DRIVERS):
//   0 PASS     — every claim under VERIFIED holds.
//   1 FAIL     — before any write, any failed check or stop; after one, a
//                page or chain read that positively contradicts a claim, or
//                a nonce showing a send the gate never allowed.
//   2 BLOCKED  — a precondition did not hold before anything was written.
//   3 UNDETERMINED — any other stop after a write; the report lists what was
//                sent and what is left standing (a reserve, an approval).
// MANUAL-ONLY (MANUAL_ONLY_DRIVERS): it writes to the testnet.
//
//   SITE_URL=https://app.vaipakam.com \
//   [REFERENCE_SITE_URL=https://<worker>.workers.dev] \
//   TESTNET_WALLETS_FILE=… LOAN_ID=1 [BORROWER_ROLE=borrower] [LENDER_ROLE=newLender] \
//   [RESERVE=0.00001] [BORROWER_MAX_RATE_PCT=12] [LENDER_MIN_RATE_PCT=8] \
//     node live-auto-extend.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erc20Abi, formatUnits, parseEventLogs } from 'viem';
import {
  addressOf,
  blocked,
  blockedSync,
  CHAINS,
  clientsFor,
  ensureConnected,
  exitWithVerdict,
  indexerOrigin,
  launch,
  requireSigningRole,
  requireSiteUrl,
  visit,
  watchPageRpc,
} from './driver.mjs';
import { awaitSurface, notReadyReason } from './readiness.mjs';
import { createManifest, runVerdict } from './outcomeManifest.mjs';
import { createWritePlan } from './writePlan.mjs';
import { decodeTxForComparison } from './refinanceExpected.mjs';
import { nonceBaseline, reconcileNonce } from './noWriteSettlement.mjs';
import { readPinned } from './pinnedRead.mjs';
import { splitBlocked } from './readOnlyFindings.mjs';
import { redactUrl } from './redact.mjs';
import {
  autoExtendPlanSteps,
  capsMismatches,
  fill,
  formatBpsAsPercent,
  formatTokenAmount,
  formatTokenAmountExact,
  fundedRowFor,
  reserveFigureMismatches,
  squash,
} from './autoExtendExpected.mjs';

// Output hygiene first: the RPC URL may carry a provider key, and viem embeds
// request URLs in its errors. Every console line is scrubbed.
const RPC_URL = CHAINS[84532].rpc;
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...args) =>
    orig(...args.map((a) => (typeof a === 'string' && RPC_URL ? a.split(RPC_URL).join(redactUrl(RPC_URL)) : a)));
}

const SITE_URL = requireSiteUrl();
const REFERENCE_SITE_URL = process.env.REFERENCE_SITE_URL ?? 'https://vaipakam-app.dawn-fire-139e.workers.dev';
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return blockedSync(`${u} is not a URL — check SITE_URL and REFERENCE_SITE_URL.`);
  }
};
for (const u of [SITE_URL, REFERENCE_SITE_URL]) {
  if (/alpha02\./i.test(hostOf(u))) blockedSync(`${u} is alpha02 — it serves the frozen vaipakam-alpha02 Worker.`);
}
if (!/\.workers\.dev$/i.test(hostOf(REFERENCE_SITE_URL))) {
  blockedSync(`REFERENCE_SITE_URL ${REFERENCE_SITE_URL} is not a workers.dev host — pass the URL the deploy printed.`);
}
const LOAN_ID = /^\d+$/.test(process.env.LOAN_ID ?? '') ? BigInt(process.env.LOAN_ID) : null;
if (LOAN_ID === null) blockedSync('LOAN_ID must name the fixture loan (see the header).');
const BORROWER_ROLE = process.env.BORROWER_ROLE ?? 'borrower';
const LENDER_ROLE = process.env.LENDER_ROLE ?? 'newLender';
if (BORROWER_ROLE === LENDER_ROLE) blockedSync('BORROWER_ROLE and LENDER_ROLE must be two different wallets.');
requireSigningRole(BORROWER_ROLE);
requireSigningRole(LENDER_ROLE);
const RESERVE_RAW = process.env.RESERVE ?? '0.00001';
const B_RATE_PCT = process.env.BORROWER_MAX_RATE_PCT ?? '12';
const L_RATE_PCT = process.env.LENDER_MIN_RATE_PCT ?? '8';
for (const [k, v] of [['RESERVE', RESERVE_RAW], ['BORROWER_MAX_RATE_PCT', B_RATE_PCT], ['LENDER_MIN_RATE_PCT', L_RATE_PCT]]) {
  if (!/^\d+(\.\d+)?$/.test(v)) blockedSync(`${k} is not a number: ${v}`);
}
const B_RATE_BPS = Math.round(Number(B_RATE_PCT) * 100);
const L_RATE_BPS = Math.round(Number(L_RATE_PCT) * 100);
if (!(L_RATE_BPS <= B_RATE_BPS && B_RATE_BPS <= 10_000)) {
  blockedSync(`the limits must overlap: LENDER_MIN_RATE_PCT ${L_RATE_PCT} ≤ BORROWER_MAX_RATE_PCT ${B_RATE_PCT} ≤ 100`);
}
/** Days past the loan's current end each side's latest end date sits; the
 *  lender's is the earlier, so it is the band's end. */
const B_END_DAYS = 30;
const L_END_DAYS = 20;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const CHAIN_ID = 84532;
const EXPLORER = 'https://sepolia.basescan.org';
const MIN_GAS_WEI = 10n ** 15n;
function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  } catch (err) {
    return blockedSync(`cannot read ${rel}\n  ${err.message}`);
  }
}
const DIAMOND = readJson('packages/contracts/src/deployments.json')[String(CHAIN_ID)]?.diamond;
if (typeof DIAMOND !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(DIAMOND)) {
  blockedSync(`deployments bundle ${CHAIN_ID}.diamond is not an address: ${JSON.stringify(DIAMOND)}`);
}
const DIAMOND_ABI = readJson('packages/contracts/src/diamondAbi.json');
const EN = readJson('apps/app/src/i18n/locales/en.json')?.copy ?? {};
const AE = EN.autoExtend;
const R = AE?.reserve;
for (const [k, v] of Object.entries({
  'autoExtend.title': AE?.title,
  'autoExtend.editBorrower': AE?.editBorrower,
  'autoExtend.bandOverlap': AE?.bandOverlap,
  'autoExtend.windowBefore': AE?.windowBefore,
  'autoExtend.receiptBorrower.youReceive': AE?.receiptBorrower?.youReceive,
  'autoExtend.receiptLender.youReceive': AE?.receiptLender?.youReceive,
  'autoExtend.reserve.receiptAdd.youReceive': R?.receiptAdd?.youReceive,
  'autoExtend.reserve.receiptWithdraw.youReceive': R?.receiptWithdraw?.youReceive,
  'autoExtend.claims.title': AE?.claims?.title,
  'forcedClose.blockedKyc': EN.forcedClose?.blockedKyc,
  'receipt.heading': EN.receipt?.heading,
})) {
  if (typeof v !== 'string') blockedSync(`en.json no longer carries copy.${k}`);
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const describeErr = (err) => String(err?.shortMessage ?? err?.message ?? err).split('\n')[0].slice(0, 240);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 0. Build check ─────────────────────────────────────────────────────
async function bundleOf(url) {
  const res = await fetch(new URL('/', url), { redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}, not the shell itself`);
  return (await res.text()).match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}
let siteBundle;
try {
  const [a, b] = await Promise.all([bundleOf(SITE_URL), bundleOf(REFERENCE_SITE_URL)]);
  if (!a || !b) await blocked(`no /assets/index-*.js in a shell (site ${a}, reference ${b})`);
  if (a !== b) await blocked(`SITE_URL serves ${a} but the reference deploy serves ${b} — not the build under review`);
  siteBundle = a;
} catch (err) {
  await blocked('could not fetch the SPA shells for the build check', err);
}
console.log(`build: ${siteBundle} on ${hostOf(SITE_URL)} and ${hostOf(REFERENCE_SITE_URL)}`);

// ── 0. Chain preflight ─────────────────────────────────────────────────
const { pub } = clientsFor(CHAIN_ID);
const read = (functionName, args = [], blockNumber) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });
// Every configuration read that can exit the process (`blockedSync`) runs
// here, before any write: after one, an exit would skip the settlement.
const IDX = indexerOrigin();
const BORROWER = addressOf(BORROWER_ROLE);
const LENDER = addressOf(LENDER_ROLE);
if (eq(BORROWER, LENDER)) await blocked(`${BORROWER_ROLE} and ${LENDER_ROLE} are the same wallet (${BORROWER}); the drive needs two`);
const pre = {};
try {
  const head = await pub.getBlock({ blockTag: 'latest' });
  const at = head.number;
  pre.head = head;
  pre.loan = await read('getLoanDetails', [LOAN_ID], at);
  [pre.bHolder, pre.lHolder, pre.switchOn, pre.paused, pre.window, pre.funding, pre.bCaps, pre.lCaps, pre.tosB, pre.tosL] = await Promise.all([
    read('ownerOf', [pre.loan.borrowerTokenId], at),
    read('ownerOf', [pre.loan.lenderTokenId], at),
    read('getAutoExtendEnabled', [], at),
    read('paused', [], at),
    read('getAutoExtendWindow', [LOAN_ID], at),
    read('getExtendFunding', [LOAN_ID, BORROWER], at),
    read('getAutoExtendBorrowerCaps', [LOAN_ID], at),
    read('getAutoExtendLenderCaps', [LOAN_ID], at),
    read('hasAcceptedCurrentTerms', [BORROWER], at),
    read('hasAcceptedCurrentTerms', [LENDER], at),
  ]);
  pre.protection = await read('getProtectedAccount', [BORROWER], at);
  pre.deadlines = await read('getLoanDeadlines', [LOAN_ID], at);
  pre.asset = pre.funding[0];
  const tokenRead = (functionName, args = []) => pub.readContract({ address: pre.asset, abi: erc20Abi, functionName, args, blockNumber: at });
  [pre.decimals, pre.symbol, pre.assetBal, pre.allowance, pre.ethB, pre.ethL] = await Promise.all([
    tokenRead('decimals'),
    tokenRead('symbol'),
    tokenRead('balanceOf', [BORROWER]),
    tokenRead('allowance', [BORROWER, DIAMOND]),
    pub.getBalance({ address: BORROWER, blockNumber: at }),
    pub.getBalance({ address: LENDER, blockNumber: at }),
  ]);
} catch (err) {
  await blocked('the chain preflight reads failed', err);
}
const L0 = pre.loan;
const want = (ok, why) => (ok ? null : why);
const preflightFailures = [
  want(Number(L0.status) === 0, `loan ${LOAN_ID} status is ${L0.status}, not Active`),
  want(Number(L0.assetType) === 0, `loan ${LOAN_ID} is not an ERC-20 loan (assetType ${L0.assetType}) — an NFT rental cannot be extended`),
  want(Number(L0.periodicInterestCadence) === 0, `loan ${LOAN_ID} pays interest on a schedule (cadence ${L0.periodicInterestCadence})`),
  want(eq(pre.bHolder, BORROWER), `loan ${LOAN_ID}'s borrower position is held by ${pre.bHolder}, not ${BORROWER_ROLE} ${BORROWER}`),
  want(eq(pre.lHolder, LENDER), `loan ${LOAN_ID}'s lender position is held by ${pre.lHolder}, not ${LENDER_ROLE} ${LENDER}`),
  want(pre.switchOn === true, 'the protocol auto-extend switch is off'),
  want(pre.paused === false, 'the protocol is paused'),
  want(pre.funding[1] === 0n, `the borrower already holds a reserve of ${pre.funding[1]} on loan ${LOAN_ID} — withdraw it first`),
  // Each deposit spends the allowance it uses, so only a zero start makes
  // "nothing left standing" mean zero at the end, whatever approvals ran.
  want(pre.allowance === 0n, `the borrower's ${pre.symbol} allowance to the Diamond is ${pre.allowance}, not 0 — revoke it first`),
  // A protected account's vault payouts can be queued or held in its vault
  // rather than paid to the wallet; this drive follows only the direct route.
  want(!pre.protection.enabled && !pre.protection.locked, `${BORROWER_ROLE} runs protected account mode (enabled ${pre.protection.enabled}, locked ${pre.protection.locked}), so a withdrawal may be queued or held in its vault rather than returned to the wallet`),
  want(pre.tosB === true && pre.tosL === true, `both wallets must have accepted the current Terms (${pre.tosB} / ${pre.tosL})`),
  want(pre.ethB >= MIN_GAS_WEI && pre.ethL >= MIN_GAS_WEI, `each wallet needs ≥ ${formatUnits(MIN_GAS_WEI, 18)} ETH for gas`),
].filter(Boolean);
const RESERVE = (() => {
  const m = RESERVE_RAW.match(/^(\d*)(?:\.(\d*))?$/);
  const frac = (m?.[2] ?? '').replace(/0+$/, '');
  if (!m || frac.length > pre.decimals) return null;
  return BigInt((m[1] || '0') + frac.padEnd(pre.decimals, '0'));
})();
if (!RESERVE || RESERVE <= 0n) preflightFailures.push(`RESERVE ${RESERVE_RAW} is not a positive amount of a ${pre.decimals}-decimal token`);
else if (pre.assetBal < RESERVE) preflightFailures.push(`${BORROWER_ROLE} holds ${formatUnits(pre.assetBal, pre.decimals)} ${pre.symbol}, less than the reserve ${RESERVE_RAW}`);
if (preflightFailures.length) await blocked(`loan ${LOAN_ID} is not the fixture this drive needs:\n  - ${preflightFailures.join('\n  - ')}`);
// The loan's effective maturity (its original end plus any pause credit), the
// end the app's band is judged against: the original end alone can sit before
// it on a loan that lived through a pause.
const LOAN_END = Number(pre.deadlines[2]);
const WINDOW = { opensAt: Number(pre.window[0]), closesAt: Number(pre.window[1]) };
console.log(
  `chain: loan ${LOAN_ID} Active, ERC-20 ${pre.symbol} principal, cadence 0; borrower ${BORROWER_ROLE}, lender ${LENDER_ROLE}; ` +
    `window ${new Date(WINDOW.opensAt * 1000).toISOString()} → ${new Date(WINDOW.closesAt * 1000).toISOString()}; ` +
    `limits before: borrower ${pre.bCaps.enabled ? 'on' : 'off'}, lender ${pre.lCaps.enabled ? 'on' : 'off'}; allowance ${pre.allowance}`,
);
const nonces = {};
for (const [role, who] of [['borrower', BORROWER], ['lender', LENDER]]) {
  try {
    const base = await nonceBaseline(pub, who);
    if (base.blocked) await blocked(`${role}: ${base.blocked}`);
    nonces[role] = base.nonce;
  } catch (err) {
    await blocked(`could not read the ${role}'s nonce at startup`, err);
  }
}
// Step 6's subject: an Active loan on this Diamond past its grace period, as
// the chain itself decides it (isLoanDefaultable, which counts any pause
// credit the loan has accrued), never recomputed here from its start and term.
// The card is shown only to the loan's lender, so only a loan whose lender
// position one of the two signing wallets holds is observable, and it is
// opened in that wallet's session.
const pastGrace = [];
const pastGraceOther = [];
try {
  const at = pre.head.number;
  for (let id = 1n; id < 500n; id++) {
    const l = await read('getLoanDetails', [id], at);
    if (l.startTime === 0n) break;
    if (Number(l.status) !== 0) continue;
    if (!(await read('isLoanDefaultable', [id], at))) continue;
    const holder = await read('ownerOf', [l.lenderTokenId], at);
    const role = eq(holder, BORROWER) ? 'borrower' : eq(holder, LENDER) ? 'lender' : null;
    if (role) pastGrace.push({ id, role });
    else pastGraceOther.push(id);
  }
} catch (err) {
  await blocked('could not list the Diamond’s loans for the past-grace check', err);
}
console.log(
  `chain: past-grace Active loans whose lender a signing wallet holds: ${pastGrace.length ? pastGrace.map((g) => `${g.id} (${g.role})`).join(', ') : 'none'}` +
    (pastGraceOther.length ? `; held by other wallets: ${pastGraceOther.join(', ')}` : ''),
);

// ── The outcome manifest ───────────────────────────────────────────────
const SIX = 'the review receipt has its six rows, and its first states exactly what is being signed';
const MANIFEST = createManifest({
  verifiable: [
    {
      id: 'card',
      claim: "the borrower sees the automatic-extension card with the switch on, the chain's window and their own limits editor",
      checks: {
        mounted: 'the card (data-testid auto-extend) renders with copy.autoExtend.title',
        switchOn: 'no switched-off or paused banner, the chain switch reading on',
        window: "the window line is the catalogue's, filled with the chain's getAutoExtendWindow",
        editor: 'the borrower sees "Your limits as borrower"',
      },
    },
    {
      id: 'borrowerCaps',
      claim: "the borrower's limits are saved through a review receipt as exactly one setAutoExtendBorrowerCaps carrying them",
      checks: {
        receipt: SIX,
        saved: 'the page says the limits are saved',
        chain: 'the receipt carries AutoExtendBorrowerCapsChanged and getAutoExtendBorrowerCaps returns those limits, set by the borrower, at its block',
      },
    },
    {
      id: 'lenderCaps',
      claim: "the lender's overlapping limits are saved the same way through setAutoExtendLenderCaps",
      checks: {
        editor: 'the lender sees "Your limits as lender"',
        receipt: SIX,
        saved: 'the page says the limits are saved',
        chain: 'the receipt carries AutoExtendLenderCapsChanged and getAutoExtendLenderCaps returns those limits, set by the lender, at its block',
      },
    },
    {
      id: 'band',
      claim: 'back as borrower, the card states the overlap of both limits as limits, not a promise',
      checks: {
        text: 'the band line is copy.autoExtend.bandOverlap filled with the intersection (lender minimum, borrower maximum, earlier end), which says a term can still be refused',
      },
    },
    {
      id: 'reservePanel',
      claim: "the borrower's reserve panel states the chain's figures, with nothing reserved",
      checks: {
        figures: "reserved, other free balance and the charge at the end of the window lie between getExtendFunding read just before and just after a fresh page load; the charge now is listed, within the same bracket, only while the window is open",
      },
    },
    {
      id: 'fund',
      claim: 'a reserve is added through its receipt as fundExtendReserve(loanId, amount), after at most an exact approval',
      checks: {
        receipt: SIX,
        added: 'the page says the reserve was added',
        chain: 'the receipt carries ExtendReserveFunded(loanId, borrower, asset, amount, amount) and getExtendFunding reads it reserved at its block',
      },
    },
    {
      id: 'withdraw',
      claim: 'the reserve is withdrawn through its receipt as exactly one withdrawExtendReserve(borrower, loanId, amount), and the outcome stays in view',
      checks: {
        receipt: SIX,
        chain: 'the receipt carries ExtendReserveWithdrawn and getExtendFunding reads 0 reserved at its block',
        outcome: 'the withdrawn banner is still visible once the panel reads 0 reserved and offers no withdrawal',
      },
    },
    {
      id: 'indexer',
      claim: 'the indexer files the deposit under the borrower',
      checks: { row: 'GET /activity?chainId&actor=<borrower>&kind=ExtendReserveFunded returns the deposit’s row (loan, transaction, actor)' },
    },
    {
      id: 'claims',
      claim: 'Claims lists the reserve for its depositor only, and withdraws it from there',
      checks: {
        fund: 'a second reserve is added through the loan page, read reserved at its block',
        lenderNone: "the lender's /claims, after its reserve query answered, lists no reserve on the fixture loan",
        listed: "the borrower's /claims lists Loan #<id> under Extension reserves with the amount and that it pays this loan's extensions",
        withdrawn: 'the withdrawal from Claims is ExtendReserveWithdrawn, 0 reserved at its block, with the outcome shown on Claims',
      },
    },
    {
      id: 'leftNothing',
      claim: 'the run leaves no reserve and no approval standing',
      checks: { state: "getExtendFunding reads 0 reserved, and the borrower's allowance to the Diamond is back at 0, as it was at startup" },
    },
    ...(pastGrace.length
      ? [
          {
            id: 'forcedClose',
            claim: 'on a past-grace loan the forced close-out card renders and claims no KYC refusal',
            checks: { card: `the forced-close card renders for the lender on loan ${pastGrace[0].id} and neither declares nor states the KYC block` },
          },
        ]
      : []),
    {
      id: 'pageHealth',
      claim: 'the pages threw no uncaught error and sent no malformed chain request',
      checks: { noPageErrors: 'no PAGEERROR in either console capture', noMalformedRpc: 'no page chain request refused as malformed' },
    },
    {
      id: 'writeDiscipline',
      claim: 'the pages asked to sign only the planned requests, and the wallets sent nothing else',
      checks: {
        noRefusals: 'no request refused by the gate, the chain pin or the egress guard',
        nonces: "each wallet's nonce moved by exactly the sends its steps allowed",
      },
    },
  ],
  notVerified: [
    ...(pastGrace.length
      ? []
      : [
          {
            id: 'forcedClose',
            claim: 'on a past-grace loan the forced close-out card renders and claims no KYC refusal',
            reason: pastGraceOther.length
              ? `the past-grace loans on this Diamond (${pastGraceOther.join(', ')}) are lent by neither signing wallet, and the card is shown only to the lender`
              : 'no Active loan on this Diamond is past its grace period, so the card is not observable',
            coveredBy: 'live-lender-close-out.mjs on a past-grace loan',
          },
        ]),
    {
      id: 'extension',
      claim: 'an extension itself runs inside the window and draws the reserve',
      reason: 'the window opens near maturity; this drive only sets the limits and the reserve the extension would use',
      coveredBy: null,
    },
    {
      id: 'turnOff',
      claim: '"Turn off" clears a side’s limits',
      reason: 'the limits are left in force on purpose (the fixture for a later extension review)',
      coveredBy: 'src/data/autoExtend.test.ts capsArgs (disabled)',
    },
  ],
});
const OUTCOME = ['card', 'borrowerCaps', 'lenderCaps', 'band', 'reservePanel', 'fund', 'withdraw', 'indexer', 'claims', 'leftNothing'];
const check = (id, key, label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  return MANIFEST.record(id, key, ok, `${label}${detail ? ' — ' + detail : ''}`);
};
const unsettled = (id, key, reason) => {
  console.log(`??   ${id}.${key} — ${reason}`);
  MANIFEST.undetermined(id, key, reason);
};

// ── The write plan and the gates ───────────────────────────────────────
// The latest end dates as the date inputs take them, and the instants the
// app derives from them (`endOfLocalDay`) — computed in the browser below,
// whose clock and zone the app uses.
const dateOf = (sec) => {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// Counted from the loan's end, or from a day after the startup block when
// the loan is already past its end: the app (and the executor) read a latest
// end less than a day away as too early for any extension, so the overlap
// this drive expects needs both ends well past that.
const END_ANCHOR = Math.max(LOAN_END, Number(pre.head.timestamp) + 86_400);
const B_END_DATE = dateOf(END_ANCHOR + B_END_DAYS * 86_400);
const L_END_DATE = dateOf(END_ANCHOR + L_END_DAYS * 86_400);
let PLAN = null;
let HALT = null;
const refusals = [];
class Stop extends Error {}
const stop = (why) => {
  if (!HALT) HALT = why;
  throw new Stop(why);
};
const abiFor = (to) => (eq(to, DIAMOND) ? DIAMOND_ABI : eq(to, pre.asset) ? erc20Abi : null);
function signingGateFor(role) {
  return async (method, params) => {
    let why = null;
    let v = null;
    if (HALT) why = `halted — ${HALT}`;
    else if (method !== 'eth_sendTransaction') why = `unexpected wallet method ${method}`;
    else {
      v = PLAN.offer(role, 'tx', decodeTxForComparison(params?.[0] ?? {}, abiFor));
      if (!v.ok) why = v.why;
    }
    if (why) {
      refusals.push(`${role}: ${method} — ${why}`);
      console.log(`GATE  refused ${role} ${method}: ${why}`);
      if (!HALT) HALT = `the ${role} page asked to sign something the plan does not allow next (${method})`;
      return { ok: false, why };
    }
    PLAN.record(v.index, { outcome: 'awaiting provider' });
    console.log(`GATE  allowed ${role}: ${v.step.id} — ${v.step.purpose}`);
    return {
      ok: true,
      onResult: (hash) => {
        PLAN.record(v.index, { hash, outcome: 'hash returned' });
        console.log(`TX    ${role} ${v.step.id}: ${hash}`);
      },
      onError: (err) => PLAN.record(v.index, { outcome: `provider rejected: ${describeErr(err)}` }),
    };
  };
}
const wrote = () => (PLAN?.steps() ?? []).some((s) => s.status === 'consumed');

// ── Sessions ───────────────────────────────────────────────────────────
const sessions = {};
const rpcWatch = {};
for (const [role, walletRole] of [['borrower', BORROWER_ROLE], ['lender', LENDER_ROLE]]) {
  sessions[role] = await launch({
    role: walletRole,
    startChainId: CHAIN_ID,
    pinnedChainId: CHAIN_ID,
    signingGate: signingGateFor(role),
    readOnlyEgress: true,
    freshProfile: true,
  });
  await sessions[role].ctx.addInitScript(() => {
    try {
      localStorage.setItem('vaipakam:language', 'en');
    } catch {
      /* the English assertion below says so */
    }
  });
  rpcWatch[role] = watchPageRpc(sessions[role].page);
}
const bp = sessions.borrower.page;
const lp = sessions.lender.page;
const shot = (role, name) => sessions[role].shot(name).catch((e) => console.log(`(screenshot ${name} not saved: ${e.message})`));
const walletRefusals = () =>
  ['borrower', 'lender'].flatMap((r) => splitBlocked(sessions[r].blockedRequests ?? [], [new URL(SITE_URL).origin]).violations.map((b) => `${r}: ${b.reason} ${b.url ?? ''}`.trim()));
const pageErrors = () => ['borrower', 'lender'].flatMap((r) => sessions[r].consoleErrors.filter((e) => e.startsWith('PAGEERROR')).map((e) => `${r}: ${e}`));

// The instants the app derives from each date input, in the browser's zone.
const endOfDay = (page, value) =>
  page.evaluate((v) => {
    const [y, m, d] = v.split('-').map(Number);
    return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000);
  }, value);
/** src/lib/format.ts formatDateTime, run in the page so its zone and locale apply. */
const dateTimeText = (page, sec) =>
  page.evaluate(
    (s) =>
      new Date(s * 1000).toLocaleString(document.documentElement.lang || 'en-US', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    sec,
  );

async function pollUntil(label, fn, { timeoutMs = 120_000, everyMs = 2_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(everyMs);
  }
}

/** ConnectKit can leave its "Connected" screen open over the page after a
 *  (re)connect, which swallows the next click (seen on /claims in this
 *  drive's first run). Close it with Escape, ConnectKit's own close key. */
async function closeConnected(page) {
  const dialog = page.getByRole('dialog').filter({ hasText: /\bconnected\b/i }).first();
  if (!(await dialog.isVisible().catch(() => false))) return;
  await page.keyboard.press('Escape').catch(() => {});
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
}
const click = async (page, locator) => {
  await closeConnected(page);
  await locator.click();
};
/**
 * Connected as `who` after a full navigation. The injected wallet reconnects
 * on its own within a few seconds; clicking "Connect wallet" before it does
 * opens ConnectKit's chooser, whose WalletConnect pairing later expires as an
 * uncaught page error ("Proposal expired"). So the header's own account
 * button is waited for first, and `ensureConnected` is only the fallback.
 */
async function connect(page, who) {
  const account = page.getByRole('button', { name: new RegExp(`${who.slice(0, 6)}\\W{1,3}${who.slice(-4)}`, 'i') }).first();
  await account.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
  await ensureConnected(page);
  await closeConnected(page);
}

/** Arm `role`, click, and wait for `done` or a danger banner inside `scope`. */
async function armedClick(role, page, button, done, scope, label) {
  if (HALT) stop(`not ${label}: ${HALT}`);
  if (walletRefusals().length) stop(`not ${label}: a request was refused (${walletRefusals().join('; ')})`);
  await closeConnected(page);
  PLAN.arm(role);
  console.log(`info  plan ARMED for the ${role}: ${label}`);
  await button.click();
  const outcome = await pollUntil(
    `${label} settles`,
    async () => {
      if (refusals.length || HALT) return 'refused';
      if (await done.count()) return 'done';
      const err = scope.locator('.banner-danger');
      if (await err.count()) return `error: ${squash(await err.first().innerText())}`;
      return null;
    },
    { timeoutMs: 300_000 },
  );
  PLAN.close();
  console.log(`info  plan CLOSED after the ${role}: ${label} (${outcome ?? 'timed out'})`);
  if (refusals.length || HALT) stop(HALT ?? refusals.at(-1));
  if (outcome !== 'done') stop(`${label} did not complete in the UI: ${outcome ?? 'timed out'}`);
}

/** The highest block any of this run's mined writes landed in; settlement
 *  reads at or after it, so a lagging RPC backend cannot show older state. */
let lastWriteBlock = 0n;
/** The mined receipt of a consumed step, or a stop. */
async function minedReceipt(id) {
  const s = PLAN.steps().find((x) => x.id === id);
  if (s?.status !== 'consumed') stop(`step ${id} was never signed (${s?.status})`);
  if (!s.record.hash) stop(`${id} was allowed but no hash came back (${s.record.outcome})`);
  const r = await pub.waitForTransactionReceipt({ hash: s.record.hash, timeout: 180_000 });
  if (r.blockNumber > lastWriteBlock) lastWriteBlock = r.blockNumber;
  if (r.status !== 'success') stop(`${id} ${s.record.hash} reverted at block ${r.blockNumber}`);
  return r;
}
const diamondEvents = (receipt, eventName) =>
  parseEventLogs({ abi: DIAMOND_ABI, eventName, logs: receipt.logs.filter((l) => eq(l.address, DIAMOND)) }).filter((e) => e.args.loanId === LOAN_ID);
/** Payouts to the borrower that a protected account's gate queued or kept in
 *  its vault instead of paying (preflight refuses such a wallet; this catches
 *  one switched on mid-run). Each is money the run did not return. */
const diverted = [];
const divertedPayouts = (receipt) =>
  parseEventLogs({ abi: DIAMOND_ABI, eventName: ['PayoutQueued', 'PayoutHeldInVault'], logs: receipt.logs.filter((l) => eq(l.address, DIAMOND)) })
    .filter((e) => eq(e.args.account, BORROWER))
    .map((e) => `${e.eventName} ${e.args.amount} of ${e.args.asset}${e.eventName === 'PayoutQueued' ? ` (queue id ${e.args.id}, releases ${new Date(Number(e.args.releaseAt) * 1000).toISOString()})` : ' (kept in the vault)'} — ${receipt.transactionHash}`);
const fundingAt = (blockNumber) => readPinned(() => read('getExtendFunding', [LOAN_ID, BORROWER], blockNumber));

/** The six receipt rows inside `scope`, as [label, value] pairs. */
async function receiptRows(scope) {
  const rows = scope.locator('dl.receipt').last().locator('.receipt-row');
  await rows.first().waitFor({ state: 'visible', timeout: 30_000 });
  const n = await rows.count();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([squash(await rows.nth(i).locator('dt').innerText()), squash(await rows.nth(i).locator('dd').innerText())]);
  }
  return out;
}
function judgeReceipt(id, rows, youReceive, extra = []) {
  const labels = ['youReceive', 'youLock', 'youMayOwe', 'youCanLose', 'fees', 'whenThisEnds'].map((k) => EN.receipt[k]);
  const labelled = rows.length === 6 && rows.every(([l], i) => l === labels[i]);
  const first = rows[0]?.[1] === squash(youReceive);
  const extras = extra.filter(([i, text]) => !rows[i]?.[1]?.includes(text)).map(([i, text]) => `row ${i + 1} lacks "${text}"`);
  check(id, 'receipt', `${id}: six-row receipt stating what is signed`, labelled && first && extras.length === 0, labelled ? (first ? extras.join('; ') : `first row "${rows[0]?.[1]}" ≠ "${squash(youReceive)}"`) : `rows ${JSON.stringify(rows.map(([l]) => l))}`);
}

/**
 * Navigate. Before anything is written this is `visit`, whose failure is a
 * BLOCKED precondition. After a write it must not exit the process: a stop
 * here has to reach the settlement below, which reports what is left
 * standing and reconciles nonces.
 */
async function go(page, pathname) {
  if (!wrote()) return visit(page, pathname);
  let resp;
  try {
    resp = await page.goto(new URL(pathname, SITE_URL).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    stop(`opening ${pathname} failed: ${describeErr(err)}`);
  }
  const status = resp?.status();
  if (typeof status === 'number' && status >= 400) stop(`opening ${pathname} answered HTTP ${status}`);
  return resp;
}

async function openPosition(page, role) {
  await go(page, `/positions/${LOAN_ID}`);
  await connect(page, role === 'borrower' ? BORROWER : LENDER);
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (!/^en\b/i.test(lang ?? '')) stop(`the ${role} page renders in "${lang}", not English`);
  const surface = await awaitSurface(page);
  if (!surface.ready) stop(`the ${role}'s position page: ${notReadyReason(surface)}`);
  const card = page.getByTestId('auto-extend');
  if (!(await card.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) return null;
  return card;
}

/** One side's limits, saved through the editor on the open card. */
async function saveLimits(side, page, card, rateBps, dateValue, latestEnd) {
  const heading = side === 'borrower' ? AE.editBorrower : AE.editLender;
  const editor = card.locator('div.stack').filter({ has: page.getByRole('heading', { name: heading, level: 4 }) }).last();
  await editor.waitFor({ state: 'visible', timeout: 60_000 });
  await editor.locator('input[inputmode="decimal"]').fill(String(rateBps / 100));
  await editor.locator('input[type="date"]').fill(dateValue);
  const review = editor.getByRole('button', { name: AE.review });
  if (!(await pollUntil('"Review limits" enabled', () => review.isEnabled(), { timeoutMs: 30_000, everyMs: 1_000 }))) {
    stop(`"${AE.review}" never enabled for the ${side}`);
  }
  await click(page, review);
  const r = side === 'borrower' ? AE.receiptBorrower : AE.receiptLender;
  const endText = await dateTimeText(page, latestEnd);
  judgeReceipt(`${side}Caps`, await receiptRows(editor), fill(r.youReceive, { rate: formatBpsAsPercent(rateBps), end: endText }));
  await shot(side, `auto-extend-${side}-caps-receipt`);
  const confirm = editor.getByTestId('confirm-receipt-confirm');
  await armedClick(side, page, confirm, editor.getByText(AE.saved), editor, `saving the ${side}'s limits`);
  check(`${side}Caps`, 'saved', `${side}: the page says the limits are saved`, true);
  const receipt = await minedReceipt(side === 'borrower' ? 'b-caps' : 'l-caps');
  const ev = diamondEvents(receipt, side === 'borrower' ? 'AutoExtendBorrowerCapsChanged' : 'AutoExtendLenderCapsChanged');
  const caps = await readPinned(() => read(side === 'borrower' ? 'getAutoExtendBorrowerCaps' : 'getAutoExtendLenderCaps', [LOAN_ID], receipt.blockNumber));
  const mism = capsMismatches({ side, rateBps, latestEnd, setter: side === 'borrower' ? BORROWER : LENDER }, caps);
  check(`${side}Caps`, 'chain', `${side}: the chain holds exactly those limits`, ev.length === 1 && mism.length === 0, `${ev.length} event(s); ${mism.join(', ') || 'getter matches'} — ${receipt.transactionHash}, block ${receipt.blockNumber}`);
}

const reservePanel = (card) => card.getByTestId('extend-reserve');
/**
 * Claims' reserve discovery once it has answered: the card publishes
 * `extend-reserves-state` (loading, empty, unavailable, listed, with the
 * loans it could not read and whether the list was cut short). Returns null
 * if it is still loading after `timeoutMs`.
 */
async function reserveDiscovery(page, timeoutMs = 120_000) {
  const marker = page.getByTestId('extend-reserves-state');
  return pollUntil(
    'reserve discovery answers',
    async () => {
      if ((await marker.count()) !== 1) return null;
      const state = await marker.getAttribute('data-state');
      if (!state || state === 'loading') return null;
      const unread = ((await marker.getAttribute('data-unread')) ?? '').split(',').filter(Boolean).map(Number);
      return { state, unread, truncated: (await marker.getAttribute('data-truncated')) === 'true' };
    },
    { timeoutMs, everyMs: 2_000 },
  );
}
/**
 * The panel once its figures are resolved: the extension state has answered
 * (`data-phase` is not `unread`) and the token's units are known
 * (`data-amounts` is `ready`). Returns the published phase, or null if either
 * is still unresolved after `timeoutMs`.
 */
async function panelResolved(panel, timeoutMs = 90_000) {
  return pollUntil(
    'the reserve panel resolves its figures',
    async () => {
      const phase = await panel.getAttribute('data-phase');
      return phase && phase !== 'unread' && (await panel.getAttribute('data-amounts')) === 'ready' ? phase : null;
    },
    { timeoutMs, everyMs: 2_000 },
  );
}
async function panelLines(panel) {
  return panel.locator('li').allInnerTexts();
}

/** Add RESERVE through the panel's receipt; returns the deposit's receipt. */
async function fundReserve(page, card, suffix) {
  const panel = reservePanel(card);
  await panel.waitFor({ state: 'visible', timeout: 60_000 });
  await panel.locator('input[inputmode="decimal"]').fill(RESERVE_RAW);
  const review = panel.getByRole('button', { name: R.review });
  if (!(await pollUntil('"Review deposit" enabled', () => review.isEnabled(), { timeoutMs: 30_000, everyMs: 1_000 }))) {
    stop(`"${R.review}" never enabled`);
  }
  await click(page, review);
  const exact = `${formatTokenAmountExact(RESERVE, pre.decimals)} ${pre.symbol}`;
  const rows = await receiptRows(panel);
  if (!suffix) judgeReceipt('fund', rows, fill(R.receiptAdd.youReceive, { amount: exact }), [[1, exact], [4, exact]]);
  await shot('borrower', `auto-extend-fund${suffix}-receipt`);
  await armedClick('borrower', page, panel.getByTestId('confirm-receipt-confirm'), panel.getByText(R.added), panel, `adding ${exact} to the reserve`);
  const receipt = await minedReceipt(`b-fund${suffix}`);
  const ev = diamondEvents(receipt, 'ExtendReserveFunded');
  const f = await fundingAt(receipt.blockNumber);
  const evOk = ev.length === 1 && eq(ev[0].args.holder, BORROWER) && eq(ev[0].args.asset, pre.asset) && ev[0].args.amount === RESERVE && ev[0].args.reserved === RESERVE;
  const detail = `ExtendReserveFunded ${ev.length === 1 ? `amount ${ev[0].args.amount}, reserved ${ev[0].args.reserved}` : `×${ev.length}`}; getExtendFunding reserved ${f[1]} — ${receipt.transactionHash}, block ${receipt.blockNumber}`;
  if (suffix) check('claims', 'fund', 'a second reserve is reserved on chain', evOk && f[1] === RESERVE, detail);
  else {
    check('fund', 'added', 'the page says the reserve was added', true);
    check('fund', 'chain', `${exact} is reserved on chain`, evOk && f[1] === RESERVE, detail);
  }
  return receipt;
}

/** Withdraw the whole reserve from `scope` (the panel or a Claims row). */
async function withdrawReserve(page, scope, done, label, id) {
  const review = scope.getByRole('button', { name: R.reviewWithdraw });
  if (!(await review.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) stop(`"${R.reviewWithdraw}" never appeared ${label}`);
  await click(page, review);
  const shown = `${formatTokenAmountExact(RESERVE, pre.decimals)} ${pre.symbol}`;
  const rows = await receiptRows(scope);
  if (id === 'withdraw') judgeReceipt('withdraw', rows, fill(R.receiptWithdraw.youReceive, { amount: shown }));
  await armedClick('borrower', page, scope.getByTestId('confirm-receipt-confirm'), done, scope, `withdrawing the reserve ${label}`);
  const receipt = await minedReceipt(id === 'withdraw' ? 'b-withdraw' : 'b-withdraw-2');
  const ev = diamondEvents(receipt, 'ExtendReserveWithdrawn');
  const f = await fundingAt(receipt.blockNumber);
  const ok = ev.length === 1 && eq(ev[0].args.holder, BORROWER) && ev[0].args.amount === RESERVE && ev[0].args.reserved === 0n && f[1] === 0n;
  const held = divertedPayouts(receipt);
  diverted.push(...held);
  return {
    receipt,
    ok,
    detail: `ExtendReserveWithdrawn ×${ev.length}${ev[0] ? ` amount ${ev[0].args.amount}` : ''}; reserved ${f[1]}${held.length ? `; NOT paid to the wallet: ${held.join('; ')}` : ''} — ${receipt.transactionHash}, block ${receipt.blockNumber}`,
  };
}

let B_END = null;
let L_END = null;
try {
  // Both sessions on the site, English, before the plan exists.
  for (const [role, page] of [['borrower', bp], ['lender', lp]]) {
    await visit(page, '/');
    const lang = await pollUntil('<html lang>', () => page.evaluate(() => document.documentElement.lang || null), { timeoutMs: 30_000, everyMs: 1_000 });
    if (!/^en(-|$)/i.test(lang ?? '')) await blocked(`the ${role} page renders <html lang="${lang}">, not English`);
  }
  B_END = await endOfDay(bp, B_END_DATE);
  L_END = await endOfDay(lp, L_END_DATE);
  // Re-read just before the plan: a pause since the preflight would have
  // moved the effective maturity.
  const startHead = await pub.getBlock({ blockTag: 'latest' });
  const startNow = Number(startHead.timestamp);
  const endNow = Number((await readPinned(() => read('getLoanDeadlines', [LOAN_ID], startHead.number)))[2]);
  if (!(L_END < B_END && L_END > endNow && L_END - startNow > 2 * 86_400)) {
    await blocked(`the latest end dates do not land as planned (${L_END_DATE} → ${L_END}, ${B_END_DATE} → ${B_END}, effective loan end ${endNow}, chain time ${startNow})`);
  }
  PLAN = createWritePlan(
    autoExtendPlanSteps({
      borrower: BORROWER,
      lender: LENDER,
      diamond: DIAMOND,
      asset: pre.asset,
      loanId: LOAN_ID,
      amount: RESERVE,
      chainId: CHAIN_ID,
      borrowerCaps: { rateBps: B_RATE_BPS, latestEnd: B_END },
      lenderCaps: { rateBps: L_RATE_BPS, latestEnd: L_END },
    }),
  );
  console.log(`\nplan  ${PLAN.steps().map((s) => `${s.id}${s.optional ? '?' : ''}`).join(' → ')}`);
  console.log(`plan  borrower: up to ${B_RATE_PCT}%, latest end ${B_END_DATE} (${B_END}); lender: at least ${L_RATE_PCT}%, latest end ${L_END_DATE} (${L_END}); reserve ${RESERVE_RAW} ${pre.symbol}`);

  // ── 1. Borrower: the card, then the borrower's limits ─────────────────
  let card = await openPosition(bp, 'borrower');
  if (!card) {
    check('card', 'mounted', 'the auto-extend card renders for the borrower', false);
    stop('the auto-extend card never rendered for the borrower');
  }
  const editorHeading = card.getByRole('heading', { name: AE.editBorrower, level: 4 });
  await editorHeading.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
  const cardText = squash(await card.innerText());
  console.log(`card: ${cardText.slice(0, 700)}`);
  check('card', 'mounted', 'the auto-extend card renders with its title', cardText.includes(AE.title));
  check('card', 'switchOn', 'the card shows the switch on and the protocol running', !cardText.includes(squash(AE.switchOff)) && !cardText.includes(squash(AE.paused)));
  const nowSec = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
  const windowLine =
    nowSec < WINDOW.opensAt
      ? fill(AE.windowBefore, { opens: await dateTimeText(bp, WINDOW.opensAt), closes: await dateTimeText(bp, WINDOW.closesAt) })
      : nowSec <= WINDOW.closesAt
        ? fill(AE.windowOpen, { closes: await dateTimeText(bp, WINDOW.closesAt) })
        : fill(AE.windowClosed, { closes: await dateTimeText(bp, WINDOW.closesAt) });
  check('card', 'window', "the window line states the chain's window", cardText.includes(squash(windowLine)), windowLine);
  check('card', 'editor', `the borrower sees "${AE.editBorrower}"`, await editorHeading.isVisible());
  await shot('borrower', 'auto-extend-borrower-card');
  await saveLimits('borrower', bp, card, B_RATE_BPS, B_END_DATE, B_END);

  // ── 2. Lender: overlapping limits; borrower reads the band ────────────
  const lcard = await openPosition(lp, 'lender');
  if (!lcard) {
    check('lenderCaps', 'editor', 'the auto-extend card renders for the lender', false);
    stop('the auto-extend card never rendered for the lender');
  }
  const lHeading = lcard.getByRole('heading', { name: AE.editLender, level: 4 });
  check('lenderCaps', 'editor', `the lender sees "${AE.editLender}"`, await lHeading.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false));
  await saveLimits('lender', lp, lcard, L_RATE_BPS, L_END_DATE, L_END);
  await shot('lender', 'auto-extend-lender-saved');

  card = await openPosition(bp, 'borrower');
  if (!card) stop('the auto-extend card did not render again for the borrower');
  const band = fill(AE.bandOverlap, {
    min: formatBpsAsPercent(L_RATE_BPS),
    max: formatBpsAsPercent(B_RATE_BPS),
    end: await dateTimeText(bp, L_END),
  });
  const bandSeen = await pollUntil('the band line', async () => squash(await card.innerText()).includes(squash(band)), { timeoutMs: 90_000, everyMs: 3_000 });
  check('band', 'text', 'the borrower reads the overlap, worded as limits that can still be refused', Boolean(bandSeen), band);
  await shot('borrower', 'auto-extend-band');

  // ── 3. The reserve panel, then a deposit ──────────────────────────────
  // The panel polls on its own clock, so its figures may predate any read
  // taken now. A fresh page load between two chain reads puts the page's own
  // read inside that bracket, and the figures are judged against it.
  const beforeHead = await pub.getBlock({ blockTag: 'latest' });
  const before = await read('getExtendFunding', [LOAN_ID, BORROWER], beforeHead.number);
  card = await openPosition(bp, 'borrower');
  if (!card) stop('the auto-extend card did not render again for the borrower');
  const panel = reservePanel(card);
  await panel.waitFor({ state: 'visible', timeout: 60_000 });
  const pagePhase = await panelResolved(panel);
  const lines = await panelLines(panel);
  const afterHead = await pub.getBlock({ blockTag: 'latest' });
  const after = await read('getExtendFunding', [LOAN_ID, BORROWER], afterHead.number);
  // The page names an extension "now" only while the window is open; the
  // bracket must not straddle an edge of the window for that to be decided.
  const openAt = (t) => Number(t) >= WINDOW.opensAt && Number(t) <= WINDOW.closesAt;
  if (openAt(beforeHead.timestamp) !== openAt(afterHead.timestamp)) {
    stop('the window opened or closed while the panel was read, so whether it should name a charge now is not decided');
  }
  const figures = reserveFigureMismatches(
    lines,
    { reserved: R.reserved, otherFree: R.otherFree, chargeNow: R.chargeNow, chargeAtEnd: R.chargeAtEnd },
    {
      reserved: [before[1], after[1]],
      otherFree: [before[2], after[2]],
      chargeNow: openAt(afterHead.timestamp) ? [before[3], after[3]] : null,
      chargeAtEnd: [before[4], after[4]],
    },
    pre.decimals,
    pre.symbol,
  );
  // The page's own phase must agree with the chain's on whether the window
  // is open, since that is what decides the charge-now line.
  if (pagePhase && (pagePhase === 'open') !== openAt(afterHead.timestamp)) {
    figures.push(`the page reads the window as ${pagePhase}, the chain as ${openAt(afterHead.timestamp) ? 'open' : 'not open'}`);
  }
  if (!pagePhase) {
    unsettled('reservePanel', 'figures', `the panel never resolved its figures within 90 s (phase ${await panel.getAttribute('data-phase')}, amounts ${await panel.getAttribute('data-amounts')})`);
  } else check('reservePanel', 'figures', "the panel states the chain's figures, nothing reserved", figures.length === 0 && before[1] === 0n, figures.join(' | ') || lines.map(squash).join(' | '));
  await fundReserve(bp, card, '');
  await shot('borrower', 'auto-extend-funded');

  // ── 4. Withdraw from the panel; the outcome stays ─────────────────────
  const outcomeBanner = card.locator('.banner-info', { hasText: R.withdrawn });
  const w1 = await withdrawReserve(bp, panel, outcomeBanner, 'from the loan page', 'withdraw');
  check('withdraw', 'chain', 'the reserve is withdrawn on chain', w1.ok, w1.detail);
  const emptied = await pollUntil(
    'the panel reads 0 reserved',
    async () => {
      const t = (await panelLines(panel)).map(squash);
      const zero = t.includes(squash(fill(R.reserved, { amount: `0 ${pre.symbol}` })));
      return zero && (await panel.getByRole('button', { name: R.reviewWithdraw }).count()) === 0;
    },
    { timeoutMs: 120_000, everyMs: 3_000 },
  );
  if (!emptied) unsettled('withdraw', 'outcome', 'the panel never re-read 0 reserved within 120 s, so whether the banner outlives it was not observed');
  else check('withdraw', 'outcome', 'the withdrawn banner stays in view after the panel empties', await outcomeBanner.isVisible(), squash(await outcomeBanner.innerText().catch(() => '')));
  await shot('borrower', 'auto-extend-withdrawn');

  // ── 5. A second reserve; Claims for both wallets ──────────────────────
  await fundReserve(bp, card, '-2');
  await shot('borrower', 'auto-extend-funded-2');

  // ── 5 (cont.). The indexer files the first deposit ───────────────────
  // Claims finds a reserve only through the indexer's deposit events, so a
  // Claims page read before the indexer has this loan's deposit says nothing
  // about the card. The deposits are already mined; this waits out the lag.
  const fundHash = PLAN.steps().find((s) => s.id === 'b-fund').record.hash;
  const idxUrl = `${IDX}/activity?chainId=${CHAIN_ID}&actor=${BORROWER.toLowerCase()}&kind=ExtendReserveFunded`;
  const row = await pollUntil(
    'the indexer files the deposit',
    async () => {
      const res = await fetch(idxUrl);
      if (!res.ok) return null;
      return fundedRowFor((await res.json())?.events, { loanId: LOAN_ID, txHash: fundHash, holder: BORROWER });
    },
    { timeoutMs: 600_000, everyMs: 15_000 },
  );
  if (row) check('indexer', 'row', 'the indexer files the deposit under the borrower', true, `block ${row.blockNumber}, tx ${row.txHash}`);
  else unsettled('indexer', 'row', `no ExtendReserveFunded row for ${fundHash} under the borrower within 600 s (${idxUrl}) — indexer lag cannot be told from a missing row`);

  // Settled to a boolean as it is created, so a timeout or a closed page can
  // never surface as an unhandled rejection that ends the run unsettled.
  const lenderQuery = lp
    .waitForResponse(
      (res) => res.url().includes('/activity?') && res.url().includes(`actor=${LENDER.toLowerCase()}`) && res.url().includes('ExtendReserveFunded'),
      { timeout: 90_000 },
    )
    .then((r) => r.ok(), () => false);
  await go(lp, '/claims');
  await connect(lp, LENDER);
  const lSurface = await awaitSurface(lp);
  const answered = await lenderQuery;
  if (!lSurface.ready || !answered) {
    unsettled('claims', 'lenderNone', !lSurface.ready ? notReadyReason(lSurface) : "the lender's reserve query never answered, so an absent section proves nothing");
  } else {
    // Only this loan's row is judged (the lender may hold reserves of its own
    // on other loans), and only once discovery has answered: an absent row
    // proves nothing while the list is loading, unavailable, cut short, or
    // could not read this loan.
    const d = await reserveDiscovery(lp);
    const lenderRows = await lp
      .getByTestId('extend-reserves')
      .locator('li.item-row')
      .filter({ has: lp.getByRole('link', { name: fill(AE.claims.rowTitle, { id: String(LOAN_ID) }), exact: true }) })
      .count();
    if (lenderRows > 0) check('claims', 'lenderNone', `the lender's Claims lists no reserve on loan ${LOAN_ID}`, false, `${lenderRows} row(s) for loan ${LOAN_ID}`);
    else if (!d) unsettled('claims', 'lenderNone', "the lender's reserve discovery never answered within 120 s");
    else if (d.state === 'unavailable' || d.truncated || d.unread.includes(Number(LOAN_ID))) {
      unsettled('claims', 'lenderNone', `the lender's discovery is ${d.state}${d.truncated ? ', cut short' : ''}${d.unread.length ? `, unread loans ${d.unread.join(', ')}` : ''}, so an absent row proves nothing`);
    } else check('claims', 'lenderNone', `the lender's Claims lists no reserve on loan ${LOAN_ID}`, true, `discovery ${d.state}, no row for loan ${LOAN_ID}`);
  }
  await shot('lender', 'auto-extend-claims-lender');

  const rowTitle = fill(AE.claims.rowTitle, { id: String(LOAN_ID) });
  const amountLine = fill(R.leftover, { amount: `${formatTokenAmount(RESERVE, pre.decimals)} ${pre.symbol}` });
  const reserves = bp.getByTestId('extend-reserves');
  const item = reserves.locator('li.item-row').filter({ has: bp.getByRole('link', { name: rowTitle, exact: true }) });
  // The list is found through the indexer and each row then reads the chain,
  // so the row is judged once its amount and withdrawal have loaded. A
  // Claims page that says the index is unavailable is opened again: that is
  // the indexer's outage, not this card's.
  if (!row) {
    unsettled('claims', 'listed', "the indexer has not filed this loan's deposit, so the borrower's Claims cannot list it yet and an absent row proves nothing");
    stop(`the indexer did not file ${fundHash} within 600 s, so the borrower's Claims was not judged`);
  }
  let listed = false;
  let itemText = '';
  let discovery = null;
  // The row's amount as the row publishes it (`data-amount`): the token's
  // units are a read of their own, so a row whose amount is still loading or
  // could not be read says nothing about the amount.
  let rowAmount = 'absent';
  for (let attempt = 0; attempt < 3 && !itemText; attempt++) {
    await go(bp, '/claims');
    await connect(bp, BORROWER);
    const bSurface = await awaitSurface(bp);
    if (!bSurface.ready) stop(`the borrower's Claims: ${notReadyReason(bSurface)}`);
    discovery = await reserveDiscovery(bp);
    // Unavailable or never answered is the indexer's or RPC's state, not a
    // verdict on the card: open the page again.
    if (!discovery || discovery.state === 'unavailable') continue;
    listed = await reserves.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    if (!listed) continue;
    const seen = await pollUntil(
      `${rowTitle} loaded on Claims`,
      async () => {
        if ((await item.count()) !== 1) return null;
        const amt = await item.getAttribute('data-amount');
        if (amt === 'unavailable') return { amt, text: '' };
        if (amt !== 'ready' || (await item.getByRole('button', { name: R.reviewWithdraw }).count()) !== 1) return null;
        return { amt, text: squash(await item.innerText()) };
      },
      { timeoutMs: 120_000, everyMs: 3_000 },
    );
    rowAmount = seen?.amt ?? ((await item.count()) === 1 ? ((await item.getAttribute('data-amount')) ?? 'loading') : 'absent');
    // A row whose amount resolved is judged as it stands, right or wrong;
    // one still loading or unreadable is opened again.
    itemText = seen?.text || (rowAmount === 'ready' ? squash(await item.innerText()) : '');
  }
  // A missing row is judged only against a discovery that answered, read
  // this loan, and was not cut short; otherwise it is left undetermined and
  // the reserve is reported standing by the settlement.
  const discoveryUnsure =
    !discovery || discovery.state === 'unavailable' || discovery.truncated || discovery.unread.includes(Number(LOAN_ID));
  await shot('borrower', 'auto-extend-claims-borrower');
  if (!itemText && discoveryUnsure) {
    unsettled('claims', 'listed', `the borrower's reserve discovery is ${discovery ? `${discovery.state}${discovery.truncated ? ', cut short' : ''}${discovery.unread.length ? `, unread loans ${discovery.unread.join(', ')}` : ''}` : 'unanswered'} after 3 visits`);
    stop(`the borrower's Claims could not show ${rowTitle}: discovery did not answer for it`);
  }
  if (!itemText && (rowAmount === 'loading' || rowAmount === 'unavailable')) {
    unsettled('claims', 'listed', `${rowTitle} is listed but its amount is ${rowAmount === 'loading' ? 'still loading' : "unreadable (the token's units could not be read)"} after 3 visits, so the amount was not judged`);
    stop(`the borrower's Claims row for loan ${LOAN_ID} never resolved its amount`);
  }
  check(
    'claims',
    'listed',
    `the borrower's Claims lists ${rowTitle} under "${AE.claims.title}"`,
    listed && (await reserves.innerText()).includes(AE.claims.title) && itemText.includes(squash(amountLine)) && itemText.includes(squash(R.kept)),
    itemText || 'no such row',
  );
  if (!itemText) stop(`the borrower's Claims did not list ${rowTitle}`);
  const w2 = await withdrawReserve(bp, item, reserves.locator('.banner-info', { hasText: R.withdrawn }), 'from Claims', 'withdraw-2');
  check('claims', 'withdrawn', 'the reserve is withdrawn from Claims, with the outcome shown there', w2.ok, w2.detail);
  await shot('borrower', 'auto-extend-claims-withdrawn');

  // ── 6. Read-only: the forced close-out card on a past-grace loan ──────
  if (pastGrace.length) {
    const { id: fcId, role: fcRole } = pastGrace[0];
    const fcPage = fcRole === 'borrower' ? bp : lp;
    await go(fcPage, `/positions/${fcId}`);
    const fc = fcPage.getByTestId('forced-close-card');
    const shown = await fc.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false);
    // The card renders while its facts are still unread ("unknown"), and
    // could become blocked-kyc once the admission read answers: judge only a
    // resolved state.
    const state = shown
      ? await pollUntil(
          'the forced-close facts resolve',
          async () => {
            // Resolved: a state other than "unknown", published with the
            // block its facts were read at.
            const s = await fc.getAttribute('data-forced-close-state');
            const b = await fc.getAttribute('data-forced-close-block');
            return s && s !== 'unknown' && b ? s : null;
          },
          { timeoutMs: 90_000, everyMs: 2_000 },
        )
      : null;
    if (!shown) check('forcedClose', 'card', `the forced-close card renders on loan ${fcId}`, false);
    else if (!state) unsettled('forcedClose', 'card', `the forced-close card on loan ${fcId} never resolved its facts within 90 s`);
    else if (state === 'not-yet') {
      // The chain called this loan defaultable at startup; a card that says
      // "not yet" did not exercise the overdue case this check is about.
      unsettled('forcedClose', 'card', `loan ${fcId} was defaultable at startup but the card reads not-yet at block ${await fc.getAttribute('data-forced-close-block')}, so the overdue case was not exercised`);
    } else {
      const block = await fc.getAttribute('data-forced-close-block');
      const text = squash(await fc.innerText());
      check('forcedClose', 'card', `the forced-close card on loan ${fcId} claims no KYC refusal`, state !== 'blocked-kyc' && !text.includes(squash(EN.forcedClose.blockedKyc)), `state ${state}, read at block ${block}`);
    }
  }
} catch (err) {
  if (!(err instanceof Stop)) {
    if (!HALT) HALT = `unexpected error: ${describeErr(err)}`;
    console.log(`error ${String(err?.stack ?? err).slice(0, 800)}`);
  }
  PLAN?.close();
  await shot('borrower', 'auto-extend-zz-stopped');
  console.log(`STOP  ${HALT}`);
}

// ── Settlement ─────────────────────────────────────────────────────────
for (const r of ['borrower', 'lender']) await rpcWatch[r].settled().catch(() => 0);
const faults = ['borrower', 'lender'].flatMap((r) => rpcWatch[r].sessionFaults().map((f) => `${r}: ${f}`));
for (const r of ['borrower', 'lender']) await sessions[r].done().catch(() => {});
check('pageHealth', 'noPageErrors', 'no page errors', pageErrors().length === 0, pageErrors().join(' | ').slice(0, 300));
check('pageHealth', 'noMalformedRpc', 'no malformed chain request', faults.length === 0, faults.join(' | ').slice(0, 300));
check('writeDiscipline', 'noRefusals', 'the pages asked to sign only the planned requests', refusals.length === 0 && walletRefusals().length === 0, [...refusals, ...walletRefusals()].join(' | ').slice(0, 400));
let gateEscape = false;
const nonceLines = [];
let noncesOk = true;
for (const [role, who] of [['borrower', BORROWER], ['lender', LENDER]]) {
  const allowed = (PLAN?.steps() ?? []).filter((s) => s.role === role && s.status === 'consumed').length;
  const r = await reconcileNonce(pub, who, nonces[role]);
  if (r.kind === 'unknown') {
    noncesOk = false;
    nonceLines.push(`${role}: ${allowed} allowed — ${r.why}`);
    continue;
  }
  const sent = r.kind === 'unchanged' ? 0 : r.to - r.from;
  if (sent > allowed) gateEscape = true;
  if (sent !== allowed) noncesOk = false;
  nonceLines.push(`${role}: ${allowed} allowed, ${sent} sent`);
}
if (noncesOk) check('writeDiscipline', 'nonces', 'each wallet sent exactly what its steps allowed', true, nonceLines.join('; '));
else if (gateEscape) check('writeDiscipline', 'nonces', 'each wallet sent exactly what its steps allowed', false, nonceLines.join('; '));
else unsettled('writeDiscipline', 'nonces', nonceLines.join('; '));

// What the run left standing, read from the chain whatever happened above.
// Pinned to one block at or after this run's last mined write, so a
// load-balanced RPC whose latest state lags cannot report an older reserve
// or allowance as standing.
let standing = null;
try {
  const head = await pub.getBlockNumber();
  const at = head > lastWriteBlock ? head : lastWriteBlock;
  const [f, allowance] = await readPinned(() =>
    Promise.all([
      read('getExtendFunding', [LOAN_ID, BORROWER], at),
      pub.readContract({ address: pre.asset, abi: erc20Abi, functionName: 'allowance', args: [BORROWER, DIAMOND], blockNumber: at }),
    ]),
  );
  standing = { reserved: f[1], allowance };
  const detail = `reserved ${f[1]}, allowance ${allowance} (startup ${pre.allowance})`;
  // Judged only when the planned withdrawals all ran: an interrupted run can
  // leave a reserve or an approval standing without any fault in the app, so
  // it is reported (LEFT STANDING below) and left undetermined.
  const cleanupRan = !HALT && ['b-withdraw', 'b-withdraw-2'].every((id) => PLAN?.steps().find((x) => x.id === id)?.status === 'consumed');
  if (cleanupRan && diverted.length) {
    unsettled('leftNothing', 'state', `a withdrawal was queued or kept in the vault by protected account mode, so the reserve did not come back to the wallet — ${detail}; ${diverted.join('; ')}`);
  } else if (cleanupRan) check('leftNothing', 'state', 'no reserve and no approval left standing', f[1] === 0n && allowance === pre.allowance, detail);
  else if (wrote()) unsettled('leftNothing', 'state', `the run stopped before its withdrawals all ran, so what it left is reported, not judged — ${detail}`);
} catch (err) {
  console.log(`standing state unreadable: ${describeErr(err)}`);
  if (wrote()) unsettled('leftNothing', 'state', `what the run left standing could not be read: ${describeErr(err)}`);
}

console.log('\n=== write plan ===');
for (const s of PLAN?.steps() ?? []) {
  console.log(`  ${s.id.padEnd(18)} ${s.status.padEnd(9)} ${s.record.hash ? `${EXPLORER}/tx/${s.record.hash}` : (s.record.outcome ?? '')}`);
}
console.log(`nonces: ${nonceLines.join('; ')}`);
if (standing && (standing.reserved !== 0n || standing.allowance !== pre.allowance)) {
  console.log(
    `\nLEFT STANDING: reserved ${formatUnits(standing.reserved, pre.decimals)} ${pre.symbol} on loan ${LOAN_ID} ` +
      `(withdraw it from /claims as ${BORROWER_ROLE}); ${pre.symbol} allowance to the Diamond ${standing.allowance} (startup ${pre.allowance}).`,
  );
}
if (diverted.length) console.log(`\nLEFT STANDING: withdrawn but not paid to ${BORROWER_ROLE}'s wallet — ${diverted.join('; ')}`);
// The limits as the chain holds them now, not as this run asked: a save that
// failed or never ran leaves whatever stood before.
try {
  const [bc, lc] = await Promise.all([read('getAutoExtendBorrowerCaps', [LOAN_ID]), read('getAutoExtendLenderCaps', [LOAN_ID])]);
  const capsLine = (c, bound) =>
    c.enabled ? `${bound === 'max' ? 'up to' : 'at least'} ${formatBpsAsPercent(bound === 'max' ? c.maxRateBps : c.minRateBps)} until ${new Date(Number(c.maxNewExpiry) * 1000).toISOString()}` : 'off';
  console.log(`\nlimits on loan ${LOAN_ID} now: borrower ${capsLine(bc, 'max')}; lender ${capsLine(lc, 'min')} (turn a side off from the card)`);
} catch (err) {
  console.log(`\nlimits on loan ${LOAN_ID} now: UNKNOWN — the caps reads failed (${describeErr(err)})`);
}
for (const line of MANIFEST.render()) console.log(line);
const VERDICT = runVerdict({
  rows: MANIFEST.rows(),
  wrote: wrote(),
  stopped: HALT,
  preWriteFailure: !wrote() && MANIFEST.rows().some((r) => r.status === 'failed'),
  gateEscape,
  outcomeClaims: OUTCOME,
  evidence: {
    failed: 'see the GATE lines and the manifest above',
    left: 'the write plan and LEFT STANDING lines above say what this run sent and left',
    escape: "a wallet's nonce shows a transaction the write gate never allowed",
  },
});
console.log(VERDICT.line);
await exitWithVerdict(VERDICT.exit);
