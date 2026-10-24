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
//     deploy; the RPC is Base Sepolia; the request exists, is open, is a
//     refinance request (refinanceTargetLoanId > 0) posted by that loan's
//     borrower; the loan is Active; the viewer is neither party; and the
//     request can be TAKEN now, read the way the app reads it
//     (refinanceRequestReview.ts: `checkRefinanceRequest`, then the loan's
//     recorded request via `getRefinanceRequest`). A request the app would
//     show as unavailable is not this review's subject, so it BLOCKS; a
//     Diamond without those getters is the app's `unchecked` case, which the
//     banner then says, and the drive proceeds on it.
//   EVERYTHING THE PAGE IS JUDGED AGAINST — the fee and grace config (ONE
//     snapshot, watchedConfig.mjs), the collateral's liquidity and the
//     request's standing — is read before AND after the observation
//     (observation.mjs): a change is a state race, BLOCKED, never a FAIL.
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
// BLOCKED (a precondition, a state race around the observation, or no-write
// evidence the RPC could not supply). MANUAL-ONLY: it needs REFI_REQUEST_ID naming a
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
import { observeAgainstChain } from './observation.mjs';
import { nonceBaseline, reconcileNonce } from './noWriteSettlement.mjs';
import { readWatchedConfig } from './watchedConfig.mjs';
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

/** The app's missing-selector test (contracts/preflights.ts
 *  `isMissingSelectorError`): a Diamond that does not route the getter. */
const isMissingSelector = (e) =>
  /function does not exist|functiondoesnotexist|functionnotfound|0xa9ad62f8/i.test(
    [e?.data, e?.cause?.data, e?.shortMessage, e?.message].map((x) => (typeof x === 'string' ? x : JSON.stringify(x ?? ''))).join(' '),
  );
const revertName = (e) => {
  const reverted = typeof e?.walk === 'function' ? e.walk((x) => x?.name === 'ContractFunctionRevertedError') : null;
  return reverted ? (reverted.data?.errorName ?? reverted.reason ?? 'reverted') : null;
};

/**
 * The request's standing, read the way the app reads it
 * (refinanceRequestReview.ts `readStanding`): `checkRefinanceRequest`
 * reverting is `blocked` (its error named), a Diamond without it is
 * `unchecked`; then the loan's recorded request must be THIS one and live.
 */
async function readStanding(loanId, blockNumber) {
  try {
    await read('checkRefinanceRequest', [loanId, REQUEST_ID], blockNumber);
  } catch (e) {
    if (isMissingSelector(e)) return { kind: 'unchecked' };
    const name = revertName(e);
    if (name) return { kind: 'blocked', reason: name };
    throw e;
  }
  let recorded;
  try {
    recorded = await read('getRefinanceRequest', [loanId], blockNumber);
  } catch (e) {
    if (isMissingSelector(e)) return { kind: 'unchecked' };
    throw e;
  }
  const [recordedOfferId, live] = recorded;
  if (BigInt(recordedOfferId) !== REQUEST_ID) return { kind: 'blocked', reason: `RefinanceRequestNotRecorded (the loan records #${recordedOfferId})` };
  if (!live) return { kind: 'blocked', reason: 'RefinanceRequestNotLive' };
  return { kind: 'takeable' };
}

const checks = [];
function check(label, ok, observed) {
  checks.push({ label, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${observed !== undefined ? ` — ${observed}` : ''}`);
  return Boolean(ok);
}
/** BLOCKED before the browser opened: only reads have run. */
function blocked(why) {
  console.log(`\nBLOCKED: ${why}\nNothing was written (no browser was opened).`);
  process.exit(2);
}
/**
 * BLOCKED after the browser opened (#2695 r2): the wallet is read-only, but
 * "nothing was written" is a claim about the wallets, which only the nonce
 * reconciliation makes — so it is read here, and when it cannot be
 * established the report says that instead of the claim.
 */
async function blockedAfterLaunch(why) {
  await session?.done().catch(() => {});
  const lines = [];
  for (const [who, address] of [['viewer', VIEWER], ['borrower', pre.borrower]]) {
    const r = await reconcileNonce(pub, address, pre.nonces[who]);
    if (r.kind !== 'unchanged') lines.push(`${who}: ${r.kind === 'sent' ? `nonce moved ${r.from} → ${r.to}` : r.why}`);
  }
  console.log(
    `\nBLOCKED: ${why}\n` +
      (lines.length === 0
        ? 'Nothing was written: the wallet was read-only and both nonces are where the preflight read them.'
        : `Whether anything was written could NOT be established: ${lines.join('; ')}`),
  );
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

/**
 * EVERYTHING the page is judged against, in one object, so the race rule
 * (observation.mjs) compares all of it before and after the observation:
 * the governance snapshot (fees, grace — watchedConfig.mjs), the
 * collateral's liquidity (it decides the warning) and the request's
 * standing (it decides the banner).
 */
async function judgedState(ctx, loanId, blockNumber) {
  const [watched, collateralLiquidity, standing] = await Promise.all([
    readWatchedConfig(read, ctx, blockNumber),
    read('checkLiquidity', [ctx.collateralAsset], blockNumber),
    readStanding(loanId, blockNumber),
  ]);
  return { ...watched, collateralLiquidity: Number(collateralLiquidity), standing };
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
  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) blocked(`the RPC is chain ${chainId}, not ${CHAIN_ID} — no live Base Sepolia state would be reviewed`);
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
  const ctx = { principalAsset: req.lendingAsset, collateralAsset: req.collateralAsset };
  const [pDec, pSym, cDec, cSym, baseline, viewerBase, borrowerBase] = await Promise.all([
    token(req.lendingAsset, 'decimals', head),
    token(req.lendingAsset, 'symbol', head),
    token(req.collateralAsset, 'decimals', head),
    token(req.collateralAsset, 'symbol', head),
    judgedState(ctx, loanId, head),
    nonceBaseline(pub, VIEWER),
    nonceBaseline(pub, loan.borrower),
  ]);
  if (baseline.standing.kind === 'blocked') {
    blocked(`request #${REQUEST_ID} cannot be taken now (${baseline.standing.reason}) — the app shows it as unavailable, with no receipt; it is not a fixture for this review`);
  }
  for (const [who, b] of [['viewer', viewerBase], ['borrower', borrowerBase]]) {
    if (b.blocked) blocked(`no nonce baseline for the ${who}: ${b.blocked}`);
  }
  pre = {
    head,
    req,
    loanId,
    ctx,
    baseline,
    borrower: loan.borrower,
    principal: { decimals: Number(pDec), symbol: pSym },
    collateral: { decimals: Number(cDec), symbol: cSym },
    nonces: { viewer: viewerBase.nonce, borrower: borrowerBase.nonce },
  };
  console.log(
    `pre   @${head}: request #${REQUEST_ID} refinances loan #${loanId} (Active), carry-over ${req.refinanceCarryOver}, ` +
      `standing ${baseline.standing.kind}, collateral ${baseline.collateralLiquidity === 1 ? 'Illiquid' : 'Liquid'}, ` +
      `created by the loan's borrower ${loan.borrower}`,
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
  await blockedAfterLaunch(`setting up the read-only browser session failed: ${String(err?.message ?? err).slice(0, 300)}`);
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
    await blockedAfterLaunch(`the page renders <html lang="${lang}">, not English — every check is matched against en.json`);
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
    // RULE 1 (observation.mjs): the page is read BETWEEN two reads of
    // everything it is judged against; a change around it — or against the
    // preflight — is a state race, BLOCKED, never a FAIL.
    const result = await observeAgainstChain({
      baseline: pre.baseline,
      readConfig: () => judgedState(pre.ctx, pre.loanId),
      observe: async () => ({
        reviewText: squash(await page.locator('main').innerText().catch(() => page.locator('body').innerText())),
        order: await page.evaluate(() => window.__refiReceiptOrder),
        bannerText: (await page.locator('[data-testid="refinance-request-banner"]').count())
          ? squash(await page.locator('[data-testid="refinance-request-banner"]').first().innerText())
          : '',
        rows: await page.locator('main dl.receipt .receipt-row').evaluateAll((els) =>
          els.map((r) => ({ label: r.querySelector('dt')?.textContent ?? '', value: r.querySelector('dd')?.textContent ?? '' })),
        ),
      }),
    });
    if (result.state !== 'stable') {
      await blockedAfterLaunch(
        result.state === 'race'
          ? `what the review is judged against moved around the observation (${result.changes.join('; ')}) — a state race, not a product defect; rerun once it is stable`
          : `what the review is judged against could not be read around the observation (${result.error})`,
      );
    }
    const config = result.config;
    const { reviewText, order, bannerText, rows } = result.observed;
    console.log(`\n--- lender review (as rendered, never consented) ---\n${reviewText.slice(0, 4000)}\n---`);
    await session.shot('refi-review-01');

    // 1. No receipt before the refinance answer.
    check(
      'no funding receipt is ever shown without the refinance banner (observed from the first paint)',
      order.receiptSeen > 0 && order.receiptWithoutBanner === 0,
      `${order.samples} DOM samples, receipt present in ${order.receiptSeen}, without the banner in ${order.receiptWithoutBanner}` +
        (order.firstViolation ? `; first: ${order.firstViolation}` : ''),
    );

    // 2. The banner names the loan — and, on a Diamond without the standing
    // getters, says it could not check the request (the app's `unchecked`).
    const wantBanner = squash(EN.match.refinanceRequestBanner.split('{{loanId}}').join(String(pre.loanId)));
    const wantFull = config.standing.kind === 'unchecked' ? squash(`${wantBanner} ${EN.match.refinanceRequestUnchecked}`) : wantBanner;
    check(
      `the refinance banner names loan #${pre.loanId} (copy.match.refinanceRequestBanner${config.standing.kind === 'unchecked' ? ' + refinanceRequestUnchecked' : ''})`,
      bannerText === wantFull,
      bannerText || '(no banner)',
    );

    // 3. The receipt, figure by figure and EXACTLY (reviewTerms.mjs), the
    // carry-over line included — against the config read around it.
    const terms = compareLenderReceipt(rows, {
      en: EN,
      req: pre.req,
      principal: pre.principal,
      collateral: pre.collateral,
      treasuryFeeBps: config.treasuryFeeBps,
      graceSeconds: graceSecondsFrom(config.graceBuckets, pre.req.durationDays),
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

    // 4. The illiquid disclosure, when the chain classifies the collateral so.
    if (config.collateralLiquidity === 1) {
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
// Both tags against the both-tag baseline (noWriteSettlement.mjs). A read
// that fails, or a node view that moved backwards, cannot show "nothing
// written": that is said, and the run ends BLOCKED rather than PASS or FAIL.
let nonceEvidence = null;
for (const [who, address] of [['viewer', VIEWER], ['borrower', pre.borrower]]) {
  const r = await reconcileNonce(pub, address, pre.nonces[who]);
  if (r.kind === 'unknown') nonceEvidence ??= `${who}: ${r.why}`;
  else check(`the ${who}’s nonce did not move`, r.kind === 'unchanged', r.kind === 'unchanged' ? `${pre.nonces[who]}` : `${r.from} → ${r.to}`);
}
if ((session.blockedRequests ?? []).length) {
  console.log(`info  read-only session refused ${session.blockedRequests.length} page request(s): ${session.blockedRequests.map((r) => r.reason).slice(0, 8).join('; ')}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n=== ${checks.length - failed.length}/${checks.length} checks passed ===`);
for (const c of failed) console.log(`FAILED: ${c.label}`);
if (failed.length) {
  console.log('\nOUTCOME: FAIL');
  process.exit(1);
}
if (nonceEvidence) {
  console.log(`\nBLOCKED: every review check passed, but whether anything was written could NOT be established (${nonceEvidence})`);
  process.exit(2);
}
console.log('\nOUTCOME: PASS');
process.exit(0);
