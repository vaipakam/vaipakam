// FIXTURE SEEDER for `live-refinance.mjs` — originates ONE Active loan on
// Base Sepolia, backed by ILLIQUID collateral with both parties' consent,
// end to end through the deployed app.
//
// Why this drive exists. `live-refinance.mjs` needs `REFI_LOAN_ID` = an
// Active, illiquid-collateral, both-parties-consented loan whose stored
// borrower is the `borrower` role and whose lender is NOT the `lender` role,
// and a successful refinance CLOSES that loan — so every refinance review
// consumes its fixture. Until this seeder, the fixture was made by hand
// (loan 22 was), which left the post-deploy review blocked whenever none
// was standing (2026-10-23, #2421: the Diamond held no eligible loan). The
// fixture is made through the APP, not a script, so every payload signed is
// one the app itself built; no admin key, no oracle or config write, and no
// hand-encoded AcceptTerms is involved.
//
// WHAT IT DOES, as the app's own users would:
//   1. The BORROWER (role `borrower`) mints the faucet's illiquid tILQ on
//      `/faucet` — only when its wallet holds less than the collateral.
//   2. The borrower posts a BORROW REQUEST on `/borrow` (details → "Post my
//      own borrow request instead" → terms → review → consent → "Post borrow
//      request"): the principal in WETH, tILQ as collateral. The request is
//      pinned from the createOffer receipt's own `OfferCreated` event, and
//      its STORED record is compared with the intent — creator, every term,
//      and the collateral leg classified Illiquid by the chain.
//   3. A DIFFERENT lender (role `newLender` by default, never `lender` or
//      `borrower`) opens the request's guided accept (`/lend?offer=<id>`),
//      consents and presses "Fund this borrower".
//   4. The outcome is read from the accept's receipt and reads pinned to
//      its block: exactly one loan opened from this request, Active, the
//      borrower and lender as intended, collateral = the request's tILQ,
//      collateral classified Illiquid, both parties' consent recorded, and
//      each position NFT held by its originator. The drive then prints the
//      `live-refinance.mjs` command that consumes the loan.
//
// FUNDS MOVED, stated before anything is signed (the preflight prints the
// figures): the faucet mints test tILQ to the borrower (no funds leave
// anyone); the borrower's collateral leaves its wallet into its own vault,
// escrowed under the request; at accept the lender's principal leaves its
// wallet, the loan-initiation fee is taken from it in the lending asset,
// and the borrower receives the rest. Gas is paid by both wallets. All on
// Base Sepolia, with testnet tokens.
//
// WRITE DISCIPLINE — the refinance drive's, reused rather than restated:
//   (A) ONE ORDERED WRITE PLAN (writePlan.mjs), every step a COMPLETE
//       expected object (seedLoanExpected.mjs, compared by
//       expectedPayload.mjs — a field the expected object does not name is
//       a mismatch), declared before the first write:
//         b-mint? → b-approve-reset? → b-approve-set? → b-create →
//         l-sign → l-approve-reset? → l-approve-set? → l-accept
//       (`b-mint` is in the plan only when the borrower needs tILQ; the
//       approvals mirror erc20.ts `ensureAllowance` and must be EXACTLY the
//       pull). A request is allowed only if it matches the NEXT step; any
//       other request is refused and latches the plan.
//   (B) THE PLAN IS CLOSED UNTIL ARMED. Each role is armed immediately
//       before its confirmed click (the faucet button, "Post borrow
//       request", "Fund this borrower") and closed when that click settles;
//       a request at any other moment is refused and halts the drive.
//   (C) THE GATE LIVES IN THE WALLET (`launch({ signingGate,
//       pinnedChainId: 84532 })`), so no page-side wrapper can be skipped
//       and no chain switch can move a signature to another network.
//   (D) PERMIT2 IS OUT OF PLAN. The app routes the borrower's POST through a
//       Permit2 signature when the wallet already holds a covering Permit2
//       approval and no Diamond allowance (a lender funding a BORROW request
//       never takes that path — OfferFlow offers it for lender offers only).
//       The plan carries the classic approve path only, so a borrower with
//       such an approval is BLOCKED before anything is written.
//   (E) CONFIG HELD STILL. Governance values and both participants'
//       sanctions screening come from ONE snapshot (watchedConfig.mjs), read
//       at the pinned preflight block and re-read immediately before each
//       role is armed: a change is a state race — BLOCKED before any write,
//       a stop (UNDETERMINED) after one. The same rule as the refinance
//       drive's, from the same module.
//
// Verdicts (the FOUR-verdict contract — FOUR_VERDICT_DRIVERS):
//   0 PASS     — the loan is open and every outcome check passed; the
//                REFI_LOAN_ID line names it.
//   1 FAIL     — before any write: a page that would not complete a step,
//                or a disclosure missing; after a write: a chain read that
//                contradicts the outcome (the request stored other than
//                posted, a loan that is not the intended fixture), or a
//                nonce count showing a send the gate never allowed.
//   2 BLOCKED  — a precondition did not hold before anything was written
//                (build mismatch, chain facts, balances, a Permit2 approval,
//                Terms not accepted, credentials, browser setup).
//   3 UNDETERMINED — any other stop after the first write: the report
//                lists what was sent, what is now standing (an open request
//                still holding the borrower's collateral, a leftover
//                approval) and how to unwind it.
//
// MANUAL-ONLY (MANUAL_ONLY_DRIVERS): it writes to the testnet and its
// product is a fixture another manual drive consumes; the batch runner
// skips it.
//
// Run (from apps/app/e2e/live/):
//   SITE_URL=https://app.vaipakam.com \
//   BASE_SEPOLIA_RPC=<an RPC URL; may carry a key — it is never printed> \
//   node live-seed-illiquid-loan.mjs
// Optional: SEED_PRINCIPAL (WETH, default 0.0001 — small enough that the
// `lender` role can fund the later refinance from its own WETH), SEED_COLLATERAL
// (tILQ, default 100), SEED_RATE_PCT (default 10), SEED_DAYS (default 30),
// SEED_LENDER_ROLE (default newLender), WORKERS_DEV_URL (the build-parity
// reference), SEED_PREFLIGHT_ONLY=1 (check every precondition and print the
// plan, then exit 0 without launching a browser or writing anything),
// TESTNET_WALLETS_FILE, LIVE_CHROMIUM_PATH (see README).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEventLog, erc20Abi, formatUnits, parseAbi } from 'viem';
import {
  addressOf,
  optionalAddressOf,
  blockedSync,
  chooseMenuValue,
  CHAINS,
  clientsFor,
  ensureConnected,
  launch,
  pasteAssetLive,
  requireSigningRole,
  requireSiteUrl,
  SITE,
} from './driver.mjs';
import { redactUrl } from './redact.mjs';
import { decodeTxForComparison } from './refinanceExpected.mjs';
import {
  FAUCET_ILLIQUID_UNITS,
  FORM_DURATION_BUCKETS_DAYS,
  formExactUnits,
  requestRecordMismatches,
  seedPlanSteps,
} from './seedLoanExpected.mjs';
import { createWritePlan } from './writePlan.mjs';
import { readWatchedConfig } from './watchedConfig.mjs';
import { configChanges } from './observation.mjs';
import { nonceBaseline, reconcileNonce } from './noWriteSettlement.mjs';

// ---------------------------------------------------------------------
// Output hygiene FIRST: the RPC URL may carry a provider key, and viem
// embeds request URLs in its errors. Every console line is scrubbed.
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
    if (u.startsWith('https://sepolia.basescan.org/')) return u;
    return redactUrl(u);
  });
}
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? scrub(a) : a)));
}

requireSiteUrl();
const LENDER_ROLE = process.env.SEED_LENDER_ROLE ?? 'newLender';
requireSigningRole('borrower');
requireSigningRole(LENDER_ROLE);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '../../../..');
const CHAIN_ID = 84532;
const EXPLORER = 'https://sepolia.basescan.org';
const WORKERS_DEV_URL = process.env.WORKERS_DEV_URL ?? 'https://vaipakam-app.dawn-fire-139e.workers.dev';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** The refinance drive's maturity margin — a fixture closer to maturity
 *  than this would BLOCK there. */
const MIN_TO_MATURITY_SEC = 2n * 3_600n;
/** Gas headroom per wallet: a few app transactions on Base Sepolia. */
const MIN_GAS_WEI = 10n ** 15n;
const LIQUIDITY_ILLIQUID = 1;
const LOAN_ACTIVE = 0;

// The inputs are held to the FORM's own rules before anything is read or
// written (#2695 r1): a value the form would refuse — a length with no menu
// row, a zero or over-precise amount — would otherwise pass the preflight
// and stall the drive at a form that never enables, possibly after the
// faucet mint. The amount rule is applied once the token decimals are read.
const PRINCIPAL_RAW = process.env.SEED_PRINCIPAL ?? '0.0001';
const COLLATERAL_RAW = process.env.SEED_COLLATERAL ?? '100';
const RATE_PCT = process.env.SEED_RATE_PCT ?? '10';
const DAYS_RAW = process.env.SEED_DAYS ?? '30';
if (!/^\d+(\.\d{1,2})?$/.test(RATE_PCT) || !/^\d+$/.test(DAYS_RAW)) {
  blockedSync(`SEED_RATE_PCT / SEED_DAYS are not numbers: ${RATE_PCT} / ${DAYS_RAW}`);
}
const RATE_BPS = BigInt(Math.round(Number(RATE_PCT) * 100));
const DAYS = BigInt(DAYS_RAW);
if (RATE_BPS <= 0n || RATE_BPS > 10_000n) blockedSync(`SEED_RATE_PCT must be above 0 and at most 100; got ${RATE_PCT}`);
if (!FORM_DURATION_BUCKETS_DAYS.includes(Number(DAYS))) {
  blockedSync(`SEED_DAYS must be one of the form's lengths (${FORM_DURATION_BUCKETS_DAYS.join(', ')}); got ${DAYS_RAW}`);
}
/** The form's amount rule (format.ts parseExactUnits): positive and no finer
 *  than the token — else BLOCKED before anything is written. */
function formAmount(name, raw, decimals) {
  const v = formExactUnits(raw, decimals);
  if (v === 'invalid') blockedSync(`${name}=${raw} is not a decimal amount the form accepts`);
  if (v === 'too-precise') blockedSync(`${name}=${raw} has more decimals than the token's ${decimals}; the form refuses it`);
  if (v <= 0n) blockedSync(`${name} must be above zero; got ${raw}`);
  return v;
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------
// Deployment + chain access — the same bundle and RPC the app and the
// injected wallet use.
// ---------------------------------------------------------------------
const DEPLOYMENT = (() => {
  const file = path.join(REPO, 'packages/contracts/src/deployments.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))[String(CHAIN_ID)];
  } catch (err) {
    blockedSync(`cannot read the deployments bundle\n  path: ${file}\n  ${err.message}`);
  }
})();
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIAMOND = DEPLOYMENT?.diamond;
const WETH = DEPLOYMENT?.weth;
const TILQ = DEPLOYMENT?.testnetMocks?.illiquidToken;
for (const [name, v] of Object.entries({ diamond: DIAMOND, weth: WETH, 'testnetMocks.illiquidToken': TILQ })) {
  if (!ADDRESS_RE.test(v ?? '')) blockedSync(`deployments bundle ${CHAIN_ID}.${name} is not an address: ${JSON.stringify(v)}`);
}
const DIAMOND_ABI = (() => {
  const file = path.join(REPO, 'packages/contracts/src/diamondAbi.json');
  try {
    const abi = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(abi)) throw new Error('not an ABI array');
    return abi;
  } catch (err) {
    blockedSync(`cannot read the combined Diamond ABI\n  path: ${file}\n  ${err.message}`);
  }
})();
const EN = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '../../src/i18n/locales/en.json'), 'utf8')).copy;
  } catch (err) {
    blockedSync(`cannot read src/i18n/locales/en.json: ${err.message}`);
  }
})();
/** The faucet token: a plain ERC-20 plus Faucet.tsx's `mint(to, amount)`. */
const FAUCET_ABI = [
  ...erc20Abi,
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
];
const { pub } = clientsFor(CHAIN_ID);
const BORROWER = addressOf('borrower');
const LENDER = addressOf(LENDER_ROLE);
/** The wallet that will FUND the refinance later — only read about, never
 *  signed for, so its absence is a note, not an exit. */
const REFI_LENDER = optionalAddressOf('lender');
// The fixture's parties are distinct WALLETS, not distinct role names
// (#2695 r1): a SEED_LENDER_ROLE whose key resolves to the borrower would
// escrow the collateral and then fail the accept; one resolving to the
// `lender` role would open a loan the refinance drive cannot use.
if (eq(LENDER, BORROWER)) {
  blockedSync(`SEED_LENDER_ROLE=${LENDER_ROLE} resolves to the borrower's address ${BORROWER}; the fixture needs a different lender`);
}
if (REFI_LENDER && eq(LENDER, REFI_LENDER)) {
  blockedSync(
    `SEED_LENDER_ROLE=${LENDER_ROLE} resolves to the \`lender\` role's address ${REFI_LENDER} — ` +
      'live-refinance.mjs needs a loan whose lender is NOT that role (it funds the refinance)',
  );
}
/** The oracle interface the Diamond calls (ISanctionsList), asked directly
 *  so an unavailable oracle is seen as such (watchedConfig.mjs). */
const SANCTIONS_LIST_ABI = parseAbi(['function isSanctioned(address addr) view returns (bool)']);
const WATCHED_CTX = {
  principalAsset: WETH,
  collateralAsset: TILQ,
  participants: { borrower: BORROWER, lender: LENDER },
  readOracle: (oracle, who, blockNumber) =>
    pub.readContract({ address: oracle, abi: SANCTIONS_LIST_ABI, functionName: 'isSanctioned', args: [who], ...(blockNumber !== undefined ? { blockNumber } : {}) }),
};

const read = (functionName, args = [], blockNumber) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });
/** THE governance snapshot (watchedConfig.mjs) — the only way this drive
 *  reads config or screens a participant. */
const readConfig = (blockNumber) => readWatchedConfig(read, WATCHED_CTX, blockNumber);
const tokenRead = (address, functionName, args = [], blockNumber) =>
  pub.readContract({ address, abi: erc20Abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });
const chainNow = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp;

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

async function pollUntil(label, fn, { timeoutMs = 120_000, everyMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  console.log(`info  timed out waiting for: ${label}`);
  return null;
}

// ---------------------------------------------------------------------
// Bookkeeping.
// ---------------------------------------------------------------------
const checks = [];
const notes = [];
const refusals = [];
let HALT = null;
class Stop extends Error {}
function check(label, ok, observed) {
  checks.push({ label, ok: Boolean(ok), observed });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${observed !== undefined ? ` — ${observed}` : ''}`);
  if (!ok && !HALT) HALT = `check failed: ${label}`;
  return Boolean(ok);
}
function stop(why) {
  if (!HALT) HALT = why;
  throw new Stop(why);
}
const note = (s) => {
  notes.push(s);
  console.log(`note  ${s}`);
};

/** Exit BLOCKED — only legal while the plan has allowed nothing. */
function blockedNow(why) {
  if (PLAN && PLAN.steps().some((s) => s.status === 'consumed')) {
    throw new Error(`internal: BLOCKED requested after a write was allowed (${why})`);
  }
  console.log(`\nBLOCKED: ${why}\nNothing was written.`);
  process.exit(2);
}

// =====================================================================
// 0. Preconditions — BLOCKED on any miss, nothing written yet.
// =====================================================================
console.log(`live-seed-illiquid-loan: chain ${CHAIN_ID}, Diamond ${DIAMOND}, site ${SITE}`);
console.log(`roles  borrower = ${BORROWER} (role borrower), lender = ${LENDER} (role ${LENDER_ROLE})`);

const indexHash = async (base) => {
  const res = await fetch(base, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${base} answered HTTP ${res.status}`);
  const hashes = [...new Set((await res.text()).match(/\/assets\/index-[A-Za-z0-9_-]+\.js/g) ?? [])];
  if (hashes.length !== 1) throw new Error(`${base} shell names ${hashes.length} index bundles`);
  return hashes[0];
};
let PLAN = null;
let pre;
try {
  const [siteBundle, refBundle] = await Promise.all([indexHash(SITE), indexHash(WORKERS_DEV_URL)]);
  console.log(`build  ${SITE} → ${siteBundle}\nbuild  ${WORKERS_DEV_URL} → ${refBundle}`);
  if (siteBundle !== refBundle) {
    blockedNow(`${SITE} serves ${siteBundle} but the workers.dev deploy serves ${refBundle} — rerun with SITE_URL=${WORKERS_DEV_URL}`);
  }
  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) blockedNow(`the RPC is chain ${chainId}, not ${CHAIN_ID}`);
  const head = await pub.getBlockNumber();
  const [pDec, cDec, cSym] = await Promise.all([
    tokenRead(WETH, 'decimals', [], head),
    tokenRead(TILQ, 'decimals', [], head),
    tokenRead(TILQ, 'symbol', [], head),
  ]);
  const principal = formAmount('SEED_PRINCIPAL', PRINCIPAL_RAW, Number(pDec));
  const collateralAmount = formAmount('SEED_COLLATERAL', COLLATERAL_RAW, Number(cDec));
  // Governance values and both participants' screening: ONE snapshot.
  const watched = await readConfig(head);
  const [pLiq, cLiq, tosB, tosL] = await Promise.all([
    read('checkLiquidity', [WETH], head),
    read('checkLiquidity', [TILQ], head),
    read('hasAcceptedCurrentTerms', [BORROWER], head),
    read('hasAcceptedCurrentTerms', [LENDER], head),
  ]);
  const [bEth, lEth, bTilq, lWeth, bTilqDiamond, bTilqPermit2, lWethDiamond] = await Promise.all([
    pub.getBalance({ address: BORROWER, blockNumber: head }),
    pub.getBalance({ address: LENDER, blockNumber: head }),
    tokenRead(TILQ, 'balanceOf', [BORROWER], head),
    tokenRead(WETH, 'balanceOf', [LENDER], head),
    tokenRead(TILQ, 'allowance', [BORROWER, DIAMOND], head),
    tokenRead(TILQ, 'allowance', [BORROWER, PERMIT2], head),
    tokenRead(WETH, 'allowance', [LENDER, DIAMOND], head),
  ]);
  // The nonce baselines, read at BOTH tags (noWriteSettlement.mjs): a wallet
  // with a transaction already pending gives no baseline, since that send
  // could mine during the drive and read as one the gate never allowed.
  const [bBase, lBase] = await Promise.all([nonceBaseline(pub, BORROWER), nonceBaseline(pub, LENDER)]);
  const refiLenderWeth = REFI_LENDER ? await tokenRead(WETH, 'balanceOf', [REFI_LENDER], head) : null;
  const faucetUnit = FAUCET_ILLIQUID_UNITS * 10n ** BigInt(cDec);
  pre = {
    head,
    watched,
    pDec: Number(pDec),
    cDec: Number(cDec),
    cSym,
    principal,
    collateralAmount,
    riskTermsHash: watched.riskTermsHash,
    needsMint: bTilq < collateralAmount,
    allowances: { bTilqDiamond, lWethDiamond },
    nonces: { borrower: bBase.nonce, lender: lBase.nonce },
    refiLenderWeth,
  };
  const want = (label, ok, observed) => {
    console.log(`${ok ? 'pre   ok' : 'pre   MISS'}  ${label} — ${observed}`);
    if (!ok) blockedNow(label);
  };
  want(`principal asset WETH ${WETH} classified Liquid`, Number(pLiq) === 0, `checkLiquidity = ${pLiq}`);
  want(`collateral ${cSym} ${TILQ} classified ILLIQUID — the fixture's point`, Number(cLiq) === LIQUIDITY_ILLIQUID, `checkLiquidity = ${cLiq}`);
  want('protocol not paused', watched.paused === false, watched.paused);
  want(
    'neither asset paused (isAssetPaused — an operator posture)',
    watched.principalPaused === false && watched.collateralPaused === false,
    `${watched.principalPaused} / ${watched.collateralPaused}`,
  );
  want('risk-access gate disabled (no tier / pair-consent setup in the plan)', watched.riskAccessGate === false, watched.riskAccessGate);
  const maxDays = BigInt(watched.maxOfferDurationDays);
  want(`SEED_DAYS (${DAYS}) within the live maxOfferDurationDays (the menu hides longer lengths)`, DAYS <= maxDays, `${maxDays}`);
  // TRI-STATE screening (watchedConfig.mjs): a flagged participant and an
  // oracle that did not answer both BLOCK; an unset oracle screened nobody,
  // which is said, never read as "clean".
  for (const label of ['borrower', 'lender']) {
    const sc = watched[`screen:${label}`];
    want(`${label} sanctions screen is neither flagged nor unavailable`, sc.state === 'clean' || sc.state === 'unset', sc.state);
    if (sc.state === 'unset') note(`no sanctions oracle is configured, so the ${label} was screened by nobody (stated, not "clean")`);
  }
  want('both wallets accepted the current Terms (a Terms step is not in the plan)', tosB === true && tosL === true, `${tosB} / ${tosL}`);
  want('borrower has gas', bEth >= MIN_GAS_WEI, `${formatUnits(bEth, 18)} ETH`);
  want('lender has gas', lEth >= MIN_GAS_WEI, `${formatUnits(lEth, 18)} ETH`);
  want(`lender holds the principal (${PRINCIPAL_RAW} WETH)`, lWeth >= principal, `${formatUnits(lWeth, pre.pDec)} WETH`);
  // One faucet press is the only mint the plan allows: it must cover the
  // shortfall, or the drive would mint and still be short.
  want(
    `the borrower's ${cSym} plus at most one faucet press covers the collateral`,
    bTilq + (pre.needsMint ? faucetUnit : 0n) >= collateralAmount,
    `holds ${formatUnits(bTilq, pre.cDec)}, one press mints ${FAUCET_ILLIQUID_UNITS}, needs ${COLLATERAL_RAW}`,
  );
  want('borrower nonce baseline (no transaction pending at startup)', !bBase.blocked, bBase.blocked ?? `nonce ${bBase.nonce}`);
  want('lender nonce baseline (no transaction pending at startup)', !lBase.blocked, lBase.blocked ?? `nonce ${lBase.nonce}`);
  // (D) — posting with zero Diamond allowance and a covering Permit2
  // approval would route the app through a Permit2 signature, which the plan
  // does not carry. The lender's accept of a BORROW request never takes the
  // Permit2 path (OfferFlow: lender offers only), so only the borrower's leg
  // is checked.
  want(
    'borrower holds no covering tILQ→Permit2 approval (the app would sign a Permit2 post instead)',
    !(bTilqDiamond === 0n && bTilqPermit2 >= collateralAmount),
    `Diamond ${bTilqDiamond}, Permit2 ${bTilqPermit2}`,
  );
  console.log(
    `pre   borrower ${cSym}: ${formatUnits(bTilq, pre.cDec)} — ${pre.needsMint ? 'short of the collateral, so the plan presses the faucet once' : 'covers the collateral, no faucet step'}`,
  );
  if (refiLenderWeth === null) {
    note('the `lender` role is not in the wallet file, so the later refinance cannot be funded from it');
  } else if (refiLenderWeth < principal) {
    note(
      `the \`lender\` role holds ${formatUnits(refiLenderWeth, pre.pDec)} WETH, less than this principal — ` +
        'live-refinance.mjs would BLOCK on its balance; lower SEED_PRINCIPAL or fund that wallet',
    );
  }
  // The initiation fee at the LIVE rate is the most the borrower can be
  // charged; a VPFI hold-tier discount (resolved by the contract at accept,
  // not read here) can only lower it. Both figures are stated as such.
  const lifCap = (principal * BigInt(watched.lifBps)) / 10_000n;
  console.log(
    '\nFUNDS THIS RUN MOVES (Base Sepolia, testnet tokens):\n' +
      (pre.needsMint ? `  - faucet mints ${FAUCET_ILLIQUID_UNITS} ${cSym} to the borrower ${BORROWER}\n` : '') +
      `  - ${COLLATERAL_RAW} ${cSym} leave the borrower's wallet into its own vault, escrowed under the request\n` +
      `  - at accept, ${PRINCIPAL_RAW} WETH leave the lender ${LENDER}; the loan-initiation fee is taken from it in WETH: ` +
      `at most ${formatUnits(lifCap, pre.pDec)} WETH (${Number(watched.lifBps) / 100}% live rate — lower if the borrower's VPFI hold tier discounts it, which the contract decides at accept), ` +
      `so the borrower receives at least ${formatUnits(principal - lifCap, pre.pDec)} WETH\n` +
      `  - terms: ${RATE_PCT}% a year ceiling, ${DAYS} days, full-term interest (the form's default), collateral handed over in kind on default\n` +
      '  - gas from both wallets',
  );
} catch (err) {
  blockedNow(`reading the preconditions failed: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 300)}`);
}

// ---------------------------------------------------------------------
// The write plan (A), declared before anything can be signed.
// ---------------------------------------------------------------------
const INTENT = {
  principalAsset: WETH,
  principal: pre.principal,
  collateralAsset: TILQ,
  collateralAmount: pre.collateralAmount,
  rateBps: RATE_BPS,
  days: DAYS,
};
let REQUEST_ID = null;
let REQUEST_STORED = null;
let LENDER_ANCHOR = null;
PLAN = createWritePlan(
  seedPlanSteps({
    abi: DIAMOND_ABI,
    chainId: CHAIN_ID,
    diamond: DIAMOND,
    intent: INTENT,
    collateralDecimals: pre.cDec,
    needsMint: pre.needsMint,
    borrower: BORROWER,
    lender: LENDER,
    riskTermsHash: pre.riskTermsHash,
    lenderAnchor: () => LENDER_ANCHOR,
    requestId: () => REQUEST_ID,
    storedRequest: () => REQUEST_STORED,
    signedAcceptTerms: () => PLAN.steps().find((s) => s.id === 'l-sign' && s.status === 'consumed')?.record ?? null,
  }),
);
console.log(`\npre   write plan: ${PLAN.steps().map((s) => `${s.id}${s.optional ? '?' : ''}`).join(' → ')}`);
if (process.env.SEED_PREFLIGHT_ONLY === '1') {
  console.log('\nSEED_PREFLIGHT_ONLY=1 — preconditions hold; stopping before any browser or write.');
  process.exit(0);
}

const anyAllowed = () => PLAN.steps().some((s) => s.status === 'consumed');
function abiFor(to) {
  if (eq(to, DIAMOND)) return DIAMOND_ABI;
  if (eq(to, TILQ)) return FAUCET_ABI;
  if (eq(to, WETH)) return erc20Abi;
  return null;
}
function judge(role, method, params) {
  if (HALT) return { ok: false, why: `halted — ${HALT}` };
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
function signingGateFor(role) {
  return async (method, params) => {
    const v = judge(role, method, params);
    if (!v.ok) {
      refusals.push(`${role}: ${method} — ${v.why}`);
      console.log(`GATE  refused ${role} ${method}: ${v.why}`);
      if (!HALT) HALT = `the ${role} page asked to sign something the plan does not allow next (${method})`;
      return { ok: false, why: v.why };
    }
    console.log(`GATE  allowed ${role}: step ${v.stepId} — ${v.purpose}`);
    return {
      ok: true,
      onResult: (result) => {
        PLAN.record(v.index, v.kind === 'tx' ? { hash: result, outcome: 'hash returned' } : { signature: result, outcome: 'signed' });
        console.log(`${v.kind === 'tx' ? 'TX  ' : 'SIG '}  ${role} ${v.purpose}${v.kind === 'tx' ? `: ${result}` : ''}`);
      },
      onError: (err) => {
        PLAN.record(v.index, { outcome: `provider rejected: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 160)}` });
      },
    };
  };
}

/** Every consumed tx step of `role`, mined and successful — or a stop. */
async function minedSteps(role) {
  const out = [];
  for (const s of PLAN.steps().filter((x) => x.role === role && x.kind === 'tx' && x.status === 'consumed')) {
    if (!s.record.hash) stop(`${s.id} was allowed but no hash came back (${s.record.outcome}) — it may still have been broadcast`);
    const r = await pub.waitForTransactionReceipt({ hash: s.record.hash, timeout: 180_000 });
    if (r.status !== 'success') stop(`${s.id} ${s.record.hash} reverted at block ${r.blockNumber}`);
    out.push({ step: s, receipt: r });
  }
  return out;
}

// ---------------------------------------------------------------------
// Sessions — both set up (and English asserted) before the first write.
// ---------------------------------------------------------------------
async function seedProfile(ctx) {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vaipakam:language', 'en');
    } catch {
      /* the English assertion below says so */
    }
  });
}
const sessions = { borrower: null, lender: null };
/** Each session's wallet-level refusal log (driver.mjs `blockedRequests`),
 *  kept by reference past the session's close: a refusal the wallet made
 *  BEFORE the gate was asked — a switch to another chain, say — is a
 *  safety stop even if the page recovered from it, so it halts the drive
 *  and the run cannot PASS. */
const walletLogs = { borrower: [], lender: [] };
const walletRefusals = () => ['borrower', 'lender'].flatMap((r) => walletLogs[r].map((x) => `${r}: ${x.reason}`));
async function closeSession(role) {
  const s = sessions[role];
  sessions[role] = null;
  try {
    await s?.done();
  } catch {
    /* best effort */
  }
}
for (const [role, walletRole] of [['borrower', 'borrower'], ['lender', LENDER_ROLE]]) {
  try {
    sessions[role] = await launch({
      role: walletRole,
      onSetupFailure: 'throw',
      startChainId: CHAIN_ID,
      pinnedChainId: CHAIN_ID,
      signingGate: signingGateFor(role),
    });
    walletLogs[role] = sessions[role].blockedRequests;
    await seedProfile(sessions[role].ctx);
    await sessions[role].page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const lang = await pollUntil('<html lang>', async () => (await sessions[role].page.evaluate(() => document.documentElement.lang || '')) || null, { timeoutMs: 30_000, everyMs: 1_000 });
    if (!/^en(-|$)/i.test(lang ?? '')) throw new Error(`the ${role} page renders <html lang="${lang}">, not English`);
  } catch (err) {
    await closeSession('borrower');
    await closeSession('lender');
    blockedNow(`setting up the ${role} browser session failed: ${String(err?.message ?? err).slice(0, 300)}`);
  }
}

/** Arm `role`, click, and wait for `done` (a locator) or a submit error. */
async function armedClick(role, page, button, done, label) {
  if (HALT) stop(`not ${label}: ${HALT}`);
  if (walletRefusals().length) stop(`not ${label}: the wallet refused a request on its own (${walletRefusals().join('; ')})`);
  // (E) — the config the plan and the reviews were built against must still
  // hold at the moment the role is armed.
  let now;
  try {
    now = await readConfig();
  } catch (err) {
    const why = `the governance snapshot could not be re-read before ${label} (${String(err?.shortMessage ?? err?.message).slice(0, 120)})`;
    if (!anyAllowed()) {
      await closeSession('borrower');
      await closeSession('lender');
      blockedNow(why);
    }
    stop(why);
  }
  const moved = configChanges(pre.watched, now);
  if (moved.length) {
    const why = `the chain config moved since the preflight (${moved.join('; ')}) — a state race, not a product defect`;
    if (!anyAllowed()) {
      await closeSession('borrower');
      await closeSession('lender');
      blockedNow(`${why}; rerun once it is stable`);
    }
    stop(`not ${label}: ${why}`);
  }
  PLAN.arm(role);
  console.log(`info  write plan ARMED for the ${role}: ${label}`);
  await button.click();
  const outcome = await pollUntil(`${label} settles`, async () => {
    if (refusals.length || HALT) return 'refused';
    if (await done.count()) return 'done';
    const err = page.locator('.banner-danger[role="alert"]');
    if ((await err.count()) && (await button.isEnabled().catch(() => false))) return `error: ${squash(await err.first().innerText())}`;
    return null;
  }, { timeoutMs: 300_000, everyMs: 2_000 });
  PLAN.close();
  console.log(`info  write plan CLOSED after the ${role}: ${label}`);
  if (refusals.length) stop(`the ${role} page asked for a write the plan does not allow (${refusals.at(-1)})`);
  if (walletRefusals().length) stop(`the wallet refused a request on its own during ${label} (${walletRefusals().join('; ')})`);
  if (HALT) stop(HALT);
  if (outcome !== 'done') stop(`${label} did not complete in the UI: ${outcome ?? 'timed out'}`);
}

let LOAN_ID = null;
let session = null;
try {
  // -------------------------------------------------------------------
  // 1. Faucet — only when the borrower is short of tILQ.
  // -------------------------------------------------------------------
  const bp = sessions.borrower.page;
  session = sessions.borrower;
  if (pre.needsMint) {
    await bp.goto(`${SITE}/faucet`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await ensureConnected(bp);
    // "Mint {{units, number}} tILQ" — the number is locale-formatted, so the
    // template is matched with any thousands separator rather than one guess.
    const units = '1[,.\\u202f\\u00a0\\s]?000';
    const fromTemplate = (tpl) =>
      new RegExp(
        tpl
          .split(/(\{\{units, number\}\}|\{\{symbol\}\})/)
          .map((part) =>
            part === '{{units, number}}' ? units : part === '{{symbol}}' ? pre.cSym : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join(''),
        'i',
      );
    const label = EN.faucet.illiquid.action;
    const mint = bp.getByRole('button', { name: fromTemplate(label) });
    if (!(await mint.first().waitFor({ state: 'visible', timeout: 45_000 }).then(() => true, () => false))) {
      stop(`the faucet shows no "${label}" button`);
    }
    const minted = bp.getByText(fromTemplate(EN.faucet.mintedTokens));
    await armedClick('borrower', bp, mint.first(), minted, `pressing "${label}"`);
    await minedSteps('borrower');
    const bal = await tokenRead(TILQ, 'balanceOf', [BORROWER]);
    check(`borrower now holds the collateral (${COLLATERAL_RAW} ${pre.cSym})`, bal >= pre.collateralAmount, formatUnits(bal, pre.cDec));
  }

  // -------------------------------------------------------------------
  // 2. The borrower posts the borrow request through the guided flow.
  // -------------------------------------------------------------------
  await bp.goto(`${SITE}/borrow`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureConnected(bp);
  await chooseMenuValue(bp, 'lending-asset', WETH);
  await bp.locator('#amount').fill(PRINCIPAL_RAW);
  await chooseMenuValue(bp, 'duration', String(DAYS));
  const see = bp.getByRole('button', { name: /see matching offers/i });
  if (!(await pollUntil('"See matching offers" enabled', () => see.isEnabled(), { timeoutMs: 30_000, everyMs: 1_000 }))) {
    stop('"See matching offers" never enabled on /borrow');
  }
  await see.click();
  await bp.getByRole('button', { name: EN.match.orPostBorrow }).click();
  await bp.locator('#rate').fill(RATE_PCT);
  await pasteAssetLive(bp, 'collateral-asset', TILQ);
  await bp.locator('#collateral-amount').fill(COLLATERAL_RAW);
  const cont = bp.getByRole('button', { name: /continue to review/i });
  if (!(await pollUntil('"Continue to review" enabled', () => cont.isEnabled(), { timeoutMs: 30_000, everyMs: 1_000 }))) {
    stop('"Continue to review" never enabled on the borrow terms step');
  }
  await cont.click();
  const post = bp.getByRole('button', { name: EN.borrow.postRequest });
  await post.waitFor({ state: 'visible', timeout: 45_000 });
  await pollUntil('borrower review settled', async () => {
    const t = await bp.locator('body').innerText();
    return !/preparing|checking/i.test(t.slice(t.indexOf('Before you sign')));
  }, { timeoutMs: 45_000 });
  const bReview = squash(await bp.locator('main').innerText().catch(() => bp.locator('body').innerText()));
  console.log(`\n--- borrower review (as rendered, before consent) ---\n${bReview.slice(0, 3000)}\n---`);
  // A disclosure, judged before consent: the borrower must be told the
  // collateral is handed over in kind on default.
  check('borrower: review carries the illiquid warning (copy.match.illiquidWarning)', bReview.includes(squash(EN.match.illiquidWarning)));
  await session.shot('seed-01-borrower-review');
  if (HALT) stop(`not posting: ${HALT}`);
  const bConsent = bp.locator('label:has(a[href="/help#risks"]) input[type="checkbox"]').last();
  const bReady = await pollUntil('consent + "Post borrow request" enabled', async () => {
    if (!(await bConsent.isChecked())) await bConsent.check();
    await bp.waitForTimeout(1_000);
    return post.isEnabled();
  }, { timeoutMs: 120_000, everyMs: 3_000 });
  if (!bReady) stop('the deployed UI never enabled "Post borrow request"');
  await armedClick('borrower', bp, post, bp.getByText(EN.borrow.posted), 'posting the borrow request');
  await session.shot('seed-02-borrower-posted');

  // Pin the request from the createOffer receipt, never from "newest".
  const bMined = await minedSteps('borrower');
  const create = bMined.find((m) => m.step.id === 'b-create');
  if (!create) stop('no createOffer was captured at the wallet boundary');
  const created = diamondEvents(create.receipt);
  const oc = created.events.filter((e) => e.eventName === 'OfferCreated');
  if (created.undecodable > 0 || oc.length !== 1 || !eq(oc[0].args.creator, BORROWER)) {
    stop(`the createOffer receipt carries ${oc.length} OfferCreated event(s) and ${created.undecodable} undecodable Diamond log(s)`);
  }
  // The id is known from the receipt now — kept BEFORE the stored record is
  // judged, so a stop below still reports the open request and its remedy.
  // The lender's steps stay refused until REQUEST_STORED is set too.
  REQUEST_ID = oc[0].args.offerId;
  const stored = await read('getOfferDetails', [REQUEST_ID], create.receipt.blockNumber);
  const mism = requestRecordMismatches(INTENT, stored, { borrower: BORROWER });
  if (!check(`request #${REQUEST_ID} is stored exactly as posted, collateral classified Illiquid`, mism.length === 0, mism.join(' | ') || 'all terms match')) {
    stop(`request #${REQUEST_ID} was stored other than posted`);
  }
  REQUEST_STORED = stored;
  console.log(`info  request #${REQUEST_ID} created at block ${create.receipt.blockNumber} (${create.step.record.hash})`);
  await closeSession('borrower');

  // -------------------------------------------------------------------
  // 3. The lender funds it through the guided accept.
  // -------------------------------------------------------------------
  session = sessions.lender;
  const lp = session.page;
  await lp.goto(`${SITE}/lend?offer=${REQUEST_ID}&chain=${CHAIN_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureConnected(lp);
  const banner = lp.getByText(new RegExp(`funding borrow request #${REQUEST_ID}\\b`, 'i'));
  if (!(await banner.first().waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) {
    stop(`the guided accept did not open the review for request #${REQUEST_ID}`);
  }
  const fund = lp.getByRole('button', { name: EN.offerFlow.lender.acceptSubmitLabel });
  await pollUntil('lender review settled', async () => {
    const t = await lp.locator('body').innerText();
    return !/preparing|checking/i.test(t.slice(t.indexOf('Before you sign')));
  }, { timeoutMs: 45_000 });
  const lReview = squash(await lp.locator('main').innerText().catch(() => lp.locator('body').innerText()));
  console.log(`\n--- lender review (as rendered, before consent) ---\n${lReview.slice(0, 3000)}\n---`);
  check('lender: review carries the illiquid warning (copy.match.illiquidWarning)', lReview.includes(squash(EN.match.illiquidWarning)));
  await session.shot('seed-03-lender-review');
  if (HALT) stop(`not funding: ${HALT}`);
  const lConsent = lp.locator('label:has(a[href="/help#risks"]) input[type="checkbox"]').last();
  const lReady = await pollUntil('consent + "Fund this borrower" enabled', async () => {
    if (!(await lConsent.isChecked())) await lConsent.check();
    await lp.waitForTimeout(1_000);
    return fund.isEnabled();
  }, { timeoutMs: 120_000, everyMs: 3_000 });
  if (!lReady) stop('the deployed UI never enabled "Fund this borrower"');
  const before = await read('getOfferDetails', [REQUEST_ID]);
  if (before.accepted) stop(`request #${REQUEST_ID} was accepted by someone else before the lender was armed`);
  LENDER_ANCHOR = await chainNow();
  await armedClick('lender', lp, fund, lp.getByRole('heading', { name: /loan opened/i }), 'funding the request');
  await session.shot('seed-04-lender-done');

  // -------------------------------------------------------------------
  // 4. The outcome, from the accept receipt and reads at its block.
  // -------------------------------------------------------------------
  const lMined = await minedSteps('lender');
  const acc = lMined.find((m) => m.step.id === 'l-accept');
  if (!acc) stop('no acceptOffer was captured at the wallet boundary');
  const ev = diamondEvents(acc.receipt);
  const oa = ev.events.filter((e) => e.eventName === 'OfferAccepted' && e.args.offerId === REQUEST_ID);
  const li = ev.events.filter((e) => e.eventName === 'LoanInitiated');
  if (ev.undecodable > 0 || oa.length !== 1 || li.length !== 1 || li[0].args.loanId !== oa[0].args.loanId) {
    check('the accept receipt opens exactly one loan from this request', false, `${oa.length} OfferAccepted, ${li.length} LoanInitiated, ${ev.undecodable} undecodable`);
    throw new Stop('outcome contradicted');
  }
  LOAN_ID = oa[0].args.loanId;
  const at = acc.receipt.blockNumber;
  const loan = await read('getLoanDetails', [LOAN_ID], at);
  const [bHolder, lHolder] = await Promise.all([read('ownerOf', [loan.borrowerTokenId], at), read('ownerOf', [loan.lenderTokenId], at)]);
  const due = BigInt(loan.startTime) + BigInt(loan.durationDays) * 86_400n;
  const now = await chainNow();
  const outcome = [
    ['loan is Active', Number(loan.status) === LOAN_ACTIVE, loan.status],
    ['loan opened from this request', loan.offerId === REQUEST_ID, loan.offerId],
    ['stored borrower = the `borrower` role', eq(loan.borrower, BORROWER), loan.borrower],
    [`stored lender = the ${LENDER_ROLE} role (not the \`lender\` role)`, eq(loan.lender, LENDER) && !(REFI_LENDER && eq(loan.lender, REFI_LENDER)), loan.lender],
    ['collateral classified Illiquid', Number(loan.collateralLiquidity) === LIQUIDITY_ILLIQUID, loan.collateralLiquidity],
    ['both parties’ risk-and-terms consent recorded', loan.riskAndTermsConsentFromBoth === true, loan.riskAndTermsConsentFromBoth],
    [`collateral = ${COLLATERAL_RAW} ${pre.cSym}`, eq(loan.collateralAsset, TILQ) && loan.collateralAmount === pre.collateralAmount, `${loan.collateralAsset} ${loan.collateralAmount}`],
    [`principal = ${PRINCIPAL_RAW} WETH`, eq(loan.principalAsset, WETH) && loan.principal === pre.principal, `${loan.principalAsset} ${loan.principal}`],
    ['borrower position NFT held by the borrower', eq(bHolder, BORROWER), bHolder],
    ['lender position NFT held by the lender', eq(lHolder, LENDER), lHolder],
    ['at least two hours from maturity (live-refinance.mjs margin)', due - now >= MIN_TO_MATURITY_SEC, `due ${new Date(Number(due) * 1000).toISOString()}`],
  ];
  for (const [label, ok, observed] of outcome) check(label, ok, String(observed));
} catch (err) {
  if (!(err instanceof Stop)) {
    if (!HALT) HALT = `unexpected error: ${String(err?.message ?? err).slice(0, 300)}`;
    console.log(`error ${String(err?.stack ?? err).slice(0, 800)}`);
  }
  try {
    await session?.shot('seed-zz-stopped');
  } catch {
    /* the page may already be gone */
  }
} finally {
  await closeSession('borrower');
  await closeSession('lender');
}

// =====================================================================
// Report + verdict.
// =====================================================================
console.log('\n=== write plan ===');
for (const s of PLAN.steps()) {
  console.log(`  ${s.id.padEnd(16)} ${s.status.padEnd(9)} ${s.record.hash ? `${EXPLORER}/tx/${s.record.hash}` : (s.record.outcome ?? '')}`);
}
// The nonce is the record a lost hash cannot hide from — read at BOTH tags
// against the both-tag baseline (noWriteSettlement.mjs `reconcileNonce`).
let nonceEscape = false;
let nonceUnknown = false;
for (const [role, who] of [['borrower', BORROWER], ['lender', LENDER]]) {
  const allowed = PLAN.steps().filter((s) => s.role === role && s.kind === 'tx' && s.status === 'consumed').length;
  const r = await reconcileNonce(pub, who, pre.nonces[role]);
  if (r.kind === 'unknown') {
    nonceUnknown = true;
    console.log(`nonce ${role}: ${allowed} send(s) allowed — ${r.why}`);
    continue;
  }
  const sent = r.kind === 'unchanged' ? 0 : r.to - r.from;
  if (sent > allowed) nonceEscape = true;
  if (sent !== allowed) nonceUnknown = true;
  console.log(`nonce ${role}: ${allowed} send(s) allowed, ${sent} counted${sent === allowed ? '' : ' — DOES NOT RECONCILE'}`);
}
const wrote = anyAllowed();
const failedNow = checks.filter((c) => !c.ok);
const passing =
  LOAN_ID !== null && failedNow.length === 0 && refusals.length === 0 && walletRefusals().length === 0 && !HALT && !nonceUnknown;
if (walletRefusals().length) console.log(`\nwallet refusals: ${walletRefusals().join('; ')}`);
if (wrote && !passing) {
  if (LOAN_ID !== null) {
    // Known from the accept receipt even when a later read failed: stated,
    // with where to inspect it.
    console.log(`\nloan ${LOAN_ID} WAS opened by this run's accept (from its receipt) — inspect it at ${EXPLORER}/address/${DIAMOND} or with getLoanDetails(${LOAN_ID}) before using it`);
  }
  // What is standing, and how to unwind it — stated, never implied.
  console.log('\n=== standing state after the stop ===');
  try {
    const [bA, lA] = await Promise.all([tokenRead(TILQ, 'allowance', [BORROWER, DIAMOND]), tokenRead(WETH, 'allowance', [LENDER, DIAMOND])]);
    console.log(`  borrower tILQ allowance to the Diamond: ${bA} (baseline ${pre.allowances.bTilqDiamond})${bA !== pre.allowances.bTilqDiamond ? ` — restore with approve(Diamond, ${pre.allowances.bTilqDiamond})` : ''}`);
    console.log(`  lender WETH allowance to the Diamond: ${lA} (baseline ${pre.allowances.lWethDiamond})${lA !== pre.allowances.lWethDiamond ? ` — restore with approve(Diamond, ${pre.allowances.lWethDiamond})` : ''}`);
  } catch (e) {
    console.log(`  allowances unreadable: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`);
  }
  if (REQUEST_ID !== null) {
    try {
      const o = await read('getOfferDetails', [REQUEST_ID]);
      console.log(
        o.accepted
          ? `  request #${REQUEST_ID} was ACCEPTED — look up its loan on ${EXPLORER}/address/${DIAMOND}`
          : `  request #${REQUEST_ID} is OPEN and holds the borrower's ${COLLATERAL_RAW} ${pre.cSym} in escrow — ` +
              'reuse it by funding it from the app, or cancel it from My positions (cancel unlocks after the 5-minute cooldown)',
      );
    } catch (e) {
      console.log(`  request #${REQUEST_ID}: unreadable (${String(e?.shortMessage ?? e?.message).slice(0, 120)})`);
    }
  }
}
if (notes.length) {
  console.log('\n=== notes ===');
  for (const n of notes) console.log(`- ${n}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);
for (const c of failed) console.log(`FAILED: ${c.label}`);

if (nonceEscape) {
  console.log('\nOUTCOME: FAIL — a wallet nonce moved beyond what the gate allowed');
  process.exit(1);
}
if (passing) {
  console.log(`\nOUTCOME: PASS — loan ${LOAN_ID} is open and is the refinance fixture.`);
  console.log(`REFI_LOAN_ID=${LOAN_ID}`);
  console.log(`\nNext: SITE_URL=${SITE} REFI_LOAN_ID=${LOAN_ID} node live-refinance.mjs`);
  process.exit(0);
}
if (!wrote) {
  console.log(`\nOUTCOME: FAIL before any write — ${HALT ?? 'see the failed checks above'}\nNothing was written.`);
  process.exit(1);
}
if (LOAN_ID !== null && failed.length > 0) {
  console.log(`\nOUTCOME: FAIL — loan ${LOAN_ID} opened but is NOT the intended fixture (see the failed checks); do not use it for live-refinance.mjs`);
  process.exit(1);
}
if (failed.some((c) => c.label.startsWith('request #') || c.label.startsWith('the accept receipt'))) {
  console.log(`\nOUTCOME: FAIL — a chain read contradicts what was posted (see the failed checks)`);
  process.exit(1);
}
console.log(`\nOUTCOME: UNDETERMINED — the drive wrote to the chain and stopped: ${HALT ?? 'see above'}`);
process.exit(3);
