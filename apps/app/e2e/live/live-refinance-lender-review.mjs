// #2421 post-deploy review — the LENDER's review of a STANDING refinance
// request, observed READ-ONLY.
//
// Why this drive exists. #2421 changed what a lender sees before funding a
// refinance request: the review names the running loan it pays off and
// closes (the refinance banner), describes the collateral from the
// request's recorded carry-over decision (carried over vs a fresh pledge),
// and shows no receipt until it knows whether the request is a refinance.
// `live-refinance.mjs` exercises that review only on the way to a REAL
// accept, so it writes, and it posts its own request first. This drive
// reviews a request that already stands — `REFI_REQUEST_ID` — and writes
// nothing: the wallet is launched `readOnly` (driver.mjs refuses every
// signing method at the injected-wallet boundary, and every mutating
// request the page makes), the consent box is never ticked, and the run
// ends by showing that neither participant's nonce moved.
//
// WHAT IT CHECKS (the lender is the `lender` role, or REFI_VIEWER_ROLE):
//   preconditions (BLOCKED on a miss): the build matches the workers.dev
//     deploy; the request exists, is open, is a refinance request
//     (refinanceTargetLoanId > 0) posted by that loan's borrower; the loan
//     is Active; the viewer is neither party.
//   1. NO RECEIPT BEFORE THE ANSWER — an observer installed before the
//      first paint records every moment the funding receipt (`dl.receipt`)
//      is in the page without the refinance banner beside it. Any such
//      moment FAILs: the receipt would have described the deal without
//      saying it closes another loan.
//   2. THE BANNER NAMES THE LOAN — the banner equals
//      copy.match.refinanceRequestBanner for the request's target loan.
//   3. THE RECEIPT — every figure against the request on chain and the live
//      fee config (reviewTerms.mjs `compareLenderReceipt`), including the
//      collateral line chosen from the recorded carry-over decision
//      (lenderCollateralCarriedOver / lenderCollateralFreshPledge) and the
//      loan id it names.
//   4. The illiquid warning, when the collateral is classified illiquid.
//   5. NOTHING WAS WRITTEN — no signing request reached the wallet, and both
//      participants' nonces are where the preflight read them.
//
// Verdicts (THREE_VERDICT_DRIVERS): 0 PASS, 1 FAIL (a check above), 2
// BLOCKED (a precondition). MANUAL-ONLY: it needs REFI_REQUEST_ID naming a
// standing refinance request, which no batch can supply.
//
// Run (from apps/app/e2e/live/):
//   SITE_URL=https://app.vaipakam.com REFI_REQUEST_ID=<offer id> \
//   BASE_SEPOLIA_RPC=<an RPC URL; never printed> node live-refinance-lender-review.mjs
// Optional: REFI_VIEWER_ROLE (default lender), WORKERS_DEV_URL,
// TESTNET_WALLETS_FILE, LIVE_CHROMIUM_PATH (see README).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erc20Abi } from 'viem';
import {
  addressOf,
  blockedSync,
  CHAINS,
  clientsFor,
  ensureConnected,
  launch,
  requireSigningRole,
  requireSiteUrl,
  SITE,
} from './driver.mjs';
import { redactUrl } from './redact.mjs';
import { graceSecondsFrom } from './refinanceExpected.mjs';
import { compareLenderReceipt } from './reviewTerms.mjs';

// Output hygiene first: the RPC URL may carry a provider key.
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
  return out.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => (RPC_ORIGIN && u.startsWith(RPC_ORIGIN) ? `${RPC_ORIGIN}/***` : redactUrl(u)));
}
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? scrub(a) : a)));
}

requireSiteUrl();
const VIEWER_ROLE = process.env.REFI_VIEWER_ROLE ?? 'lender';
requireSigningRole(VIEWER_ROLE);
const RAW_ID = process.env.REFI_REQUEST_ID;
if (!RAW_ID || !/^\d+$/.test(RAW_ID.trim())) {
  blockedSync(`REFI_REQUEST_ID is required — the standing refinance request to review (got ${JSON.stringify(RAW_ID ?? null)})`);
}
const REQUEST_ID = BigInt(RAW_ID.trim());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '../../../..');
const CHAIN_ID = 84532;
const WORKERS_DEV_URL = process.env.WORKERS_DEV_URL ?? 'https://vaipakam-app.dawn-fire-139e.workers.dev';
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const readJson = (rel, what) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  } catch (err) {
    blockedSync(`cannot read ${what} (${rel}): ${err.message}`);
  }
};
const DIAMOND = readJson('packages/contracts/src/deployments.json', 'the deployments bundle')[String(CHAIN_ID)]?.diamond;
if (!/^0x[0-9a-fA-F]{40}$/.test(DIAMOND ?? '')) blockedSync(`deployments bundle ${CHAIN_ID}.diamond is not an address`);
const DIAMOND_ABI = readJson('packages/contracts/src/diamondAbi.json', 'the combined Diamond ABI');
const EN = readJson('apps/app/src/i18n/locales/en.json', 'the English catalogue').copy;
const { pub } = clientsFor(CHAIN_ID);
const VIEWER = addressOf(VIEWER_ROLE);
const read = (functionName, args = [], blockNumber) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });
const token = (address, functionName, blockNumber) =>
  pub.readContract({ address, abi: erc20Abi, functionName, blockNumber });

const checks = [];
function check(label, ok, observed) {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${observed !== undefined ? ` — ${observed}` : ''}`);
  return Boolean(ok);
}
function blocked(why) {
  console.log(`\nBLOCKED: ${why}\nNothing was written (the wallet is read-only).`);
  process.exit(2);
}
async function pollUntil(fn, { timeoutMs, everyMs = 1_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

// =====================================================================
// 0. Preconditions — pinned to one block.
// =====================================================================
console.log(`live-refinance-lender-review: request #${REQUEST_ID} on ${CHAIN_ID}, viewer ${VIEWER} (role ${VIEWER_ROLE}), site ${SITE}`);
let pre;
try {
  const indexHash = async (base) => {
    const res = await fetch(base, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${base} answered HTTP ${res.status}`);
    const hashes = [...new Set((await res.text()).match(/\/assets\/index-[A-Za-z0-9_-]+\.js/g) ?? [])];
    if (hashes.length !== 1) throw new Error(`${base} shell names ${hashes.length} index bundles`);
    return hashes[0];
  };
  const [site, ref] = await Promise.all([indexHash(SITE), indexHash(WORKERS_DEV_URL)]);
  console.log(`build  ${SITE} → ${site}\nbuild  ${WORKERS_DEV_URL} → ${ref}`);
  if (site !== ref) blocked(`${SITE} serves ${site} but the workers.dev deploy serves ${ref}`);
  const head = await pub.getBlockNumber();
  const req = await read('getOfferDetails', [REQUEST_ID], head);
  if (/^0x0{40}$/i.test(req.creator)) blocked(`request #${REQUEST_ID} does not exist (or was cancelled)`);
  if (req.accepted) blocked(`request #${REQUEST_ID} is already accepted — there is no standing review to observe`);
  if (BigInt(req.refinanceTargetLoanId) === 0n) blocked(`request #${REQUEST_ID} is not a refinance request (refinanceTargetLoanId = 0)`);
  if (BigInt(req.expiresAt) !== 0n && BigInt(req.expiresAt) <= (await pub.getBlock({ blockNumber: head })).timestamp) {
    blocked(`request #${REQUEST_ID} has expired`);
  }
  const loanId = BigInt(req.refinanceTargetLoanId);
  const loan = await read('getLoanDetails', [loanId], head);
  if (Number(loan.status) !== 0) blocked(`loan #${loanId} is not Active (status ${loan.status})`);
  if (!eq(loan.borrower, req.creator)) blocked(`request #${REQUEST_ID} was posted by ${req.creator}, not loan #${loanId}'s borrower ${loan.borrower}`);
  if (eq(VIEWER, loan.borrower) || eq(VIEWER, loan.lender)) blocked(`the viewer ${VIEWER} is a party to loan #${loanId}`);
  const [pDec, pSym, cDec, cSym, fees, buckets, collLiq, nonceViewer, nonceBorrower] = await Promise.all([
    token(req.lendingAsset, 'decimals', head),
    token(req.lendingAsset, 'symbol', head),
    token(req.collateralAsset, 'decimals', head),
    token(req.collateralAsset, 'symbol', head),
    read('getFeesConfig', [], head),
    read('getGraceBuckets', [], head),
    read('checkLiquidity', [req.collateralAsset], head),
    pub.getTransactionCount({ address: VIEWER, blockNumber: head }),
    pub.getTransactionCount({ address: loan.borrower, blockNumber: head }),
  ]);
  pre = {
    head,
    req,
    loanId,
    borrower: loan.borrower,
    principal: { decimals: Number(pDec), symbol: pSym },
    collateral: { decimals: Number(cDec), symbol: cSym },
    treasuryFeeBps: fees[0],
    graceSeconds: graceSecondsFrom(buckets, req.durationDays),
    illiquid: Number(collLiq) === 1,
    nonces: { viewer: nonceViewer, borrower: nonceBorrower },
  };
  console.log(
    `pre   @${head}: request #${REQUEST_ID} refinances loan #${loanId} (Active), carry-over ${req.refinanceCarryOver}, ` +
      `collateral ${pre.illiquid ? 'Illiquid' : 'Liquid'}, created by the loan's borrower ${loan.borrower}`,
  );
} catch (err) {
  blocked(`reading the preconditions failed: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 300)}`);
}

// =====================================================================
// 1–4. The lender's review, observed from the first paint, never consented.
// =====================================================================
let session;
try {
  session = await launch({ role: VIEWER_ROLE, readOnly: true, onSetupFailure: 'throw', startChainId: CHAIN_ID });
} catch (err) {
  blocked(`setting up the read-only browser session failed: ${String(err?.message ?? err).slice(0, 300)}`);
}
const { page, ctx } = session;
try {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('vaipakam:language', 'en');
    } catch {
      /* the English assertion below says so */
    }
    // Record every moment the funding receipt is in the page WITHOUT the
    // refinance banner beside it — from the first paint, so a receipt that
    // flashed before the refinance answer arrived is caught too.
    const log = (window.__refiReceiptOrder = { samples: 0, receiptSeen: 0, receiptWithoutBanner: 0, firstViolation: null });
    const sample = () => {
      log.samples += 1;
      const receipt = document.querySelector('dl.receipt');
      if (!receipt) return;
      log.receiptSeen += 1;
      if (!document.querySelector('[data-testid="refinance-request-banner"]')) {
        log.receiptWithoutBanner += 1;
        if (!log.firstViolation) log.firstViolation = (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400);
      }
    };
    new MutationObserver(sample).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`${SITE}/lend?offer=${REQUEST_ID}&chain=${CHAIN_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await ensureConnected(page);
  const lang = await pollUntil(async () => (await page.evaluate(() => document.documentElement.lang || '')) || null, { timeoutMs: 30_000 });
  if (!/^en(-|$)/i.test(lang ?? '')) {
    await session.done();
    blocked(`the page renders <html lang="${lang}">, not English — every check is matched against en.json`);
  }
  const fundingLine = page.getByText(new RegExp(`funding borrow request #${REQUEST_ID}\\b`, 'i'));
  if (!(await fundingLine.first().waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false))) {
    check(`the guided accept opens the review for request #${REQUEST_ID}`, false, squash(await page.locator('body').innerText()).slice(0, 400));
  } else {
    // Let the review settle (refinance read, liquidity, dry run).
    await pollUntil(async () => {
      const t = await page.locator('body').innerText();
      return !/preparing|checking/i.test(t.slice(Math.max(0, t.indexOf('Before you sign'))));
    }, { timeoutMs: 60_000 });
    await page.waitForTimeout(3_000);
    const reviewText = squash(await page.locator('main').innerText().catch(() => page.locator('body').innerText()));
    console.log(`\n--- lender review (as rendered, never consented) ---\n${reviewText.slice(0, 4000)}\n---`);
    await session.shot('refi-review-01');

    // 1. No receipt before the refinance answer.
    const order = await page.evaluate(() => window.__refiReceiptOrder);
    check(
      'no funding receipt is ever shown without the refinance banner (observed from the first paint)',
      order.receiptSeen > 0 && order.receiptWithoutBanner === 0,
      `${order.samples} DOM samples, receipt present in ${order.receiptSeen}, without the banner in ${order.receiptWithoutBanner}` +
        (order.firstViolation ? `; first: ${order.firstViolation}` : ''),
    );

    // 2. The banner names the loan.
    const banner = page.locator('[data-testid="refinance-request-banner"]');
    const bannerText = (await banner.count()) ? squash(await banner.first().innerText()) : '';
    const wantBanner = squash(EN.match.refinanceRequestBanner.split('{{loanId}}').join(String(pre.loanId)));
    check(`the refinance banner names loan #${pre.loanId} (copy.match.refinanceRequestBanner)`, bannerText.startsWith(wantBanner), bannerText || '(no banner)');
    if (bannerText.length > wantBanner.length) {
      console.log(`info  banner carries more after the template: "${bannerText.slice(wantBanner.length).trim()}"`);
    }

    // 3. The receipt, figure by figure, carry-over line included.
    const rows = await page.locator('main dl.receipt .receipt-row').evaluateAll((els) =>
      els.map((r) => ({ label: r.querySelector('dt')?.textContent ?? '', value: r.querySelector('dd')?.textContent ?? '' })),
    );
    const terms = compareLenderReceipt(rows, {
      en: EN,
      req: pre.req,
      principal: pre.principal,
      collateral: pre.collateral,
      treasuryFeeBps: pre.treasuryFeeBps,
      graceSeconds: pre.graceSeconds,
    });
    check(
      `the receipt matches the request on chain (${terms.compared.join(', ')})`,
      terms.mismatches.length === 0,
      terms.mismatches.join(' | ') || `all ${terms.compared.length} terms match`,
    );
    const lineKey = pre.req.refinanceCarryOver ? 'lenderCollateralCarriedOver' : 'lenderCollateralFreshPledge';
    const line = EN.offerFlow.receipts[lineKey].split('{{loanId}}').join(String(pre.loanId)).split('{{collateral}}');
    const youCanLose = rows.find((r) => squash(r.label) === squash(EN.receipt.youCanLose))?.value ?? '';
    check(
      `the collateral line is the recorded ${pre.req.refinanceCarryOver ? 'carry-over' : 'fresh-pledge'} wording naming loan #${pre.loanId} (receipts.${lineKey})`,
      line.every((part) => squash(youCanLose).includes(squash(part))),
      squash(youCanLose) || '(no row)',
    );

    // 4. The illiquid disclosure.
    if (pre.illiquid) {
      check('the review carries the illiquid warning (copy.match.illiquidWarning)', reviewText.includes(squash(EN.match.illiquidWarning)));
    }
  }
} catch (err) {
  check('the review could be observed', false, String(err?.message ?? err).slice(0, 300));
} finally {
  await session.done().catch(() => {});
}

// 5. Nothing was written.
const signing = (session.blockedRequests ?? []).filter((r) => /sign|send|wallet rpc/i.test(r.reason));
check('no signing or sending request reached the read-only wallet', signing.length === 0, signing.map((r) => r.reason).join('; ') || 'none');
const [nv, nb] = await Promise.all([
  pub.getTransactionCount({ address: VIEWER }),
  pub.getTransactionCount({ address: pre.borrower }),
]);
check('neither participant’s nonce moved', nv === pre.nonces.viewer && nb === pre.nonces.borrower, `viewer ${pre.nonces.viewer}→${nv}, borrower ${pre.nonces.borrower}→${nb}`);
if ((session.blockedRequests ?? []).length) {
  console.log(`info  read-only session refused ${session.blockedRequests.length} page request(s): ${session.blockedRequests.map((r) => r.reason).slice(0, 8).join('; ')}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);
for (const c of failed) console.log(`FAILED: ${c.label}`);
console.log(failed.length ? '\nOUTCOME: FAIL' : '\nOUTCOME: PASS');
process.exit(failed.length ? 1 : 0);
