// #2427 live verification — the internal-match claim card against a REAL
// internally matched ERC-20 loan on the Base Sepolia Diamond (set up by
// contracts/script/BaseSepoliaInternalMatch.s.sol).
//
// What is under test: the lender's claim row states what internal matching
// cleared and compares the principal with what the matches paid, from the
// protocol's own record (`ClaimFacet.getOwedAtInternalMatch`) — and nothing
// else. The expected line is rebuilt here from that chain read and the app's
// own English catalogue, so a wrong figure, a missing comparison or a
// fallback line ("not recorded" / "couldn't be read") is a FAIL.
//
// Steps:
//   1. Build check: SITE_URL must serve the same `/assets/index-*.js` as
//      REFERENCE_SITE_URL (the workers.dev URL the deploy printed). Both
//      hosts answer every path with a 200 SPA shell, so only the bundle hash
//      says which build is being reviewed. alpha02 is refused outright.
//   2. Chain: LOAN_ID is InternalMatched, its record is stamped, and the
//      ROLE wallet holds its lender position.
//   3. /claims: the loan's row carries exactly the expected note.
//   4. CLAIM=1 only, and only when every check above passed: open the
//      position, require the same line there, claim as lender through the
//      app, and require a claim event for the loan and the row to leave
//      /claims. The claim is one-shot (it ends the card under test), so any
//      earlier FAIL stops the drive before it.
//
// Wallet posture: without CLAIM the injected wallet is read-only, so a page
// asking for any signature gets a wallet error. With CLAIM=1 it is pinned to
// Base Sepolia and its signing gate allows exactly one request: an
// eth_sendTransaction to the Diamond whose calldata is claimAsLender(LOAN_ID),
// and only once the driver is clicking the claim button after every earlier
// check passed. Anything else — that same claim asked for earlier, or a chain
// switch the pin refuses — is refused and named as a FAIL. Once the claim is
// sent, an exception is never a product verdict: a reverted receipt is a
// FAIL, and any other stop is UNDETERMINED (the drive wrote and could not
// finish its checks). Failed checks are FAILs either way.
//
// REFERENCE_SITE_URL must be a workers.dev host (what the deploy printed).
//
// The profile is seeded to English before the first paint, because every
// expected string comes from the en catalogue; the rendered language is then
// asserted, so a profile the seed could not reach is BLOCKED, not a FAIL.
//
// A page whose own RPC answered nothing while an assertion waited is BLOCKED:
// there was no page-backed observation to judge.
//
//   SITE_URL=https://app.vaipakam.com \
//   REFERENCE_SITE_URL=https://<worker>.workers.dev \
//   TESTNET_WALLETS_FILE=… LOAN_ID=26 [ROLE=lender] [CLAIM=1] \
//     node live-internal-match-claim.mjs
//
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED, and —
// declared in verdictContract.mjs's FOUR_VERDICT_DRIVERS — 3 UNDETERMINED,
// only with CLAIM=1 after the claim was sent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, formatUnits, parseAbi, parseEventLogs } from 'viem';
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
  watchPageRpc,
  READ_METHODS,
} from './driver.mjs';
import { attachLedger, createReadLedger } from './pageSanctionsReads.mjs';
import { splitBlocked } from './readOnlyFindings.mjs';

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
// The reference is what the deploy itself published, so it must be a
// workers.dev host: any other reference (the custom domain, or SITE_URL
// passed twice) could be the same stale build and agree with itself.
// SITE_URL may BE that workers.dev URL — then the build under review is the
// one the deploy printed, and the check below is satisfied by construction.
if (!/\.workers\.dev$/i.test(hostOf(REFERENCE_SITE_URL))) {
  blockedSync(`REFERENCE_SITE_URL ${REFERENCE_SITE_URL} is not a workers.dev host — pass the URL the deploy printed.`);
}
const LOAN_ID = /^\d+$/.test(process.env.LOAN_ID ?? '') ? BigInt(process.env.LOAN_ID) : null;
if (LOAN_ID === null) blockedSync('LOAN_ID must be the internally matched loan id.');
const ROLE = process.env.ROLE ?? 'lender';
requireSigningRole(ROLE);
const WALLET = addressOf(ROLE);
const SUBMIT_CLAIM = process.env.CLAIM === '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const CHAIN_ID = 84532;
const INTERNAL_MATCHED = 5;
const SETTLED = 3;

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
const CLAIMS = readJson('apps/app/src/i18n/locales/en.json')?.copy?.claims ?? {};
for (const k of ['title', 'checking', 'unavailable']) {
  if (typeof CLAIMS[k] !== 'string') blockedSync(`en.json no longer carries copy.claims.${k}`);
}
const ROW = CLAIMS.row ?? {};
for (const k of ['matchCleared', 'matchClearedNoCharges', 'matchPaidShort', 'matchPaidFull', 'whyInternalMatchLender']) {
  if (typeof ROW[k] !== 'string') blockedSync(`en.json no longer carries copy.claims.row.${k}`);
}
/** Every fallback line the note can show instead of a comparison. */
const FALLBACK_LINES = ['matchIncomplete', 'matchNotRecorded', 'matchUnreadable', 'matchAmountsUnreadable']
  .map((k) => ROW[k])
  .filter((v) => typeof v === 'string');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};
const fill = (t, vars) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);

/** The app's `formatTokenAmount` (src/lib/format.ts), so the expected line
 *  is written the way the page writes it. */
function formatTokenAmount(raw, decimals, maxFraction = 4) {
  const asString = formatUnits(raw, decimals);
  const num = Number(asString);
  if (!Number.isFinite(num)) return asString;
  if (num !== 0 && Math.abs(num) < 1) return num.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  return num.toLocaleString('en-US', { maximumFractionDigits: maxFraction });
}

// ── 1. Build check ─────────────────────────────────────────────────────
async function bundleOf(url) {
  // Not followed: a reference host that redirects to SITE_URL would make
  // both checks read the same shell, which is the stale-build
  // self-comparison this check exists to rule out.
  const res = await fetch(new URL('/', url), { redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}${res.headers.get('location') ? ` → ${res.headers.get('location')}` : ''}, not the shell itself`);
  const html = await res.text();
  const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  return m?.[0] ?? null;
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
const read = (functionName, args = []) => pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName, args });
const ERC20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const ERC20_TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
let loan;
let rec;
let symbol;
let decimals;
let lenderHolder;
try {
  loan = await read('getLoanDetails', [LOAN_ID]);
  const [principal, interest, lateFee, lenderProceeds, recordedAt, incomplete] = await read('getOwedAtInternalMatch', [LOAN_ID]);
  rec = { principal, interest, lateFee, lenderProceeds, recordedAt, incomplete };
  [symbol, decimals] = await Promise.all([
    pub.readContract({ address: loan.principalAsset, abi: ERC20, functionName: 'symbol' }),
    pub.readContract({ address: loan.principalAsset, abi: ERC20, functionName: 'decimals' }),
  ]);
  lenderHolder = await read('ownerOf', [loan.lenderTokenId]);
} catch (err) {
  await blocked('chain reads failed', err);
}
if (Number(loan.status) !== INTERNAL_MATCHED) await blocked(`loan ${LOAN_ID} status is ${loan.status}, not InternalMatched`);
if (rec.incomplete || rec.recordedAt === 0n) {
  await blocked(`loan ${LOAN_ID} has no whole record (incomplete=${rec.incomplete}, recordedAt=${rec.recordedAt})`);
}
if (lenderHolder.toLowerCase() !== WALLET.toLowerCase()) {
  await blocked(`loan ${LOAN_ID}'s lender position is held by ${lenderHolder}, not ${ROLE} ${WALLET}`);
}
const fmt = (v) => `${formatTokenAmount(v, Number(decimals))} ${symbol}`;
console.log(
  `record: principal ${fmt(rec.principal)}, interest ${fmt(rec.interest)}, late fee ${fmt(rec.lateFee)}, ` +
    `lender proceeds ${fmt(rec.lenderProceeds)}, recordedAt ${rec.recordedAt}`,
);

const charges = rec.interest + rec.lateFee;
const cleared =
  charges > 0n
    ? fill(ROW.matchCleared, { principal: fmt(rec.principal), charges: fmt(charges) })
    : fill(ROW.matchClearedNoCharges, { principal: fmt(rec.principal) });
const short = rec.principal > rec.lenderProceeds ? rec.principal - rec.lenderProceeds : 0n;
const EXPECTED_NOTE =
  short > 0n
    ? `${cleared} ${fill(ROW.matchPaidShort, { paid: fmt(rec.lenderProceeds), short: fmt(short) })}`
    : `${cleared} ${ROW.matchPaidFull}`;
console.log(`expected note: ${EXPECTED_NOTE}`);

// ── 3. The claim row ───────────────────────────────────────────────────
// ── Wallet posture ─────────────────────────────────────────────────────
const CLAIM_CALLDATA = encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'claimAsLender', args: [LOAN_ID] });
let claimSends = 0;
/** Closed until the driver itself is about to click the claim button, after
 *  every pre-claim assertion passed — so a build that asks for the claim on
 *  its own (while /claims loads, say) is refused, not signed. */
let claimArmed = false;
/** The claim's hash once the wallet returned it, so a later failure can be
 *  reconciled against the chain instead of reported as unobserved. */
let claimHash = null;
/** The gas limit band an explicit claim gas may sit in: at least the
 *  driver's own estimate (less only buys an out-of-gas revert) and at most
 *  twice it. Both set before the gate is armed. */
let claimGasFloor = 0n;
/** Set when the claim MINED but the driver's own RPC could not read back
 *  what it needs to judge it: the run is UNDETERMINED (exit 3), not FAIL. */
let undetermined = null;
let claimGasCap = 0n;
const asBig = (v) => {
  try {
    return v === undefined || v === null ? 0n : BigInt(v);
  } catch {
    return -1n; // unparseable — refused below
  }
};
function claimGate(method, params) {
  const tx = Array.isArray(params) ? params[0] : undefined;
  const ok =
    method === 'eth_sendTransaction' &&
    claimArmed &&
    claimSends === 0 &&
    // The ledger is read AT the authorization boundary, not only before
    // arming: a refused request or a failed check recorded between the
    // arm and this send (a confirm step can sit here for seconds) still
    // stops the one-shot claim. Evaluated only once armed, which is after
    // the ledger exists.
    preClaimFails() === 0 &&
    typeof tx?.to === 'string' &&
    tx.to.toLowerCase() === DIAMOND.toLowerCase() &&
    typeof tx?.data === 'string' &&
    tx.data.toLowerCase() === CLAIM_CALLDATA.toLowerCase() &&
    // The whole transaction, not only where it goes and what it calls:
    // claimAsLender is nonpayable, so any value only buys a revert; the
    // sender must be this wallet; and an explicit gas limit must sit
    // between the driver's own estimate and twice it.
    asBig(tx.value) === 0n &&
    (tx.from === undefined || (typeof tx.from === 'string' && tx.from.toLowerCase() === WALLET.toLowerCase())) &&
    (tx.gas === undefined || (claimGasFloor > 0n && asBig(tx.gas) >= claimGasFloor && asBig(tx.gas) <= claimGasCap));
  if (!ok) {
    const why = claimArmed && preClaimFails() > 0
      ? `${method} arrived after a check failed or a request was refused — the claim is withheld`
      : claimArmed
      ? `${method} is not the one claimAsLender(${LOAN_ID}) send this drive allows`
      : `${method} arrived before the driver's claim click — the gate was closed`;
    console.log(`GATE  refused ${why}`);
    return Promise.resolve({ ok: false, why });
  }
  claimSends++;
  console.log(`GATE  allowed claimAsLender(${LOAN_ID})`);
  return Promise.resolve({
    ok: true,
    onResult: (hash) => {
      claimHash = hash;
      console.log(`TX    claim sent: ${hash}`);
    },
  });
}
const session = await launch(
  SUBMIT_CLAIM
    ? { role: ROLE, startChainId: CHAIN_ID, pinnedChainId: CHAIN_ID, signingGate: claimGate, readOnlyEgress: true }
    : { role: ROLE, readOnly: true },
);
const { ctx, page, done, shot, consoleErrors, blockedRequests } = session;
// English before the first paint (the shared i18n factory's storage key).
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('vaipakam:language', 'en');
  } catch {
    /* storage blocked — the language assertion below says so */
  }
});
const rpc = watchPageRpc(page);
// The page's own WebSocket RPC: a door neither the wallet gate nor the
// egress guard covers (driver.mjs serves only HTTP through its shim). A
// non-read method sent on it is OBSERVED here, not prevented, and counts
// as a violation exactly like a refused request.
const { wsViolations } = attachLedger(page, createReadLedger({}), READ_METHODS);
// JSON-RPC answers that arrive on the page's WebSockets (wagmi prefers a
// configured WSS transport), counted in the same window as `rpc`'s HTTP
// answers so a socket-served page is never read as "answered nothing".
// Correlated like `watchPageRpc`: an answer counts only when it answers a
// chain READ (a READ_METHODS method — so WalletConnect's relay protocol
// never counts) sent on the same socket in the CURRENT window.
let wsAnswers = 0;
let wsGeneration = 0;
page.on('websocket', (ws) => {
  const sent = new Map(); // JSON-RPC id -> generation it was sent in
  const each = (payload, fn) => {
    try {
      for (const m of [].concat(JSON.parse(String(payload)))) if (m) fn(m);
    } catch {
      /* not JSON-RPC */
    }
  };
  ws.on('framesent', (f) =>
    each(f.payload, (m) => {
      if (m.id !== undefined && READ_METHODS.has(m.method)) sent.set(m.id, wsGeneration);
    }),
  );
  ws.on('framereceived', (f) =>
    each(f.payload, (m) => {
      if (m.id === undefined || !('result' in m || 'error' in m)) return;
      if (sent.get(m.id) === wsGeneration) wsAnswers++;
      sent.delete(m.id);
    }),
  );
});
const resetWindow = () => {
  rpc.reset();
  wsAnswers = 0;
  wsGeneration++;
};
const answered = async () => (await rpc.settled()) + wsAnswers;
/** Wait for /claims to leave its loading state. Returns 'available',
 *  'unavailable' (the list's own error state) or 'loading' on timeout. */
async function claimsListSettled(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await page.locator('body').innerText();
    if (body.includes(CLAIMS.unavailable)) return 'unavailable';
    if (!body.includes(CLAIMS.checking) && body.includes(CLAIMS.title)) return 'available';
    await page.waitForTimeout(1_000);
  }
  return 'loading';
}
/** Wallet refusals and page writes the guards recorded, bar the
 *  recognised Cloudflare edge beacon. */
const violationsSoFar = () => [
  ...splitBlocked(blockedRequests ?? [], [new URL(SITE_URL).origin]).violations,
  ...wsViolations,
];
/** Pre-claim FAILs — an assertion that failed, or a request the wallet gate
 *  or the egress guard already refused (an early claim attempt, a chain
 *  switch, a page write). The claim is one-shot, so it never runs after one. */
const preClaimFails = () => fails + violationsSoFar().length;
const rowFor = () => page.locator(`a.item-row[href$="/positions/${LOAN_ID}"]`);
try {
  // The window opens BEFORE the first load, so the response that populated
  // the claims list counts — a settled list that omits the loan is a FAIL,
  // not an unanswered window.
  resetWindow();
  await visit(page, '/claims');
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (!/^en\b/i.test(lang ?? '')) {
    await blocked(`the page renders in "${lang}", not English — the expected lines come from the en catalogue`, null, done);
  }
  await ensureConnected(page);
  await rowFor().first().waitFor({ state: 'visible', timeout: 60_000 });
  // One loan, one card: a duplicate would misstate the wallet's claimable
  // funds, and every check below reads a single row.
  const rowCount = await rowFor().count();
  check('the loan has exactly one claim row', rowCount === 1, `${rowCount} rows`);
  // The note renders once the principal token's details load.
  const deadline = Date.now() + 30_000;
  let text = '';
  while (Date.now() < deadline) {
    text = await rowFor().first().innerText();
    if (text.includes(cleared) || FALLBACK_LINES.some((l) => text.includes(l))) break;
    await page.waitForTimeout(1_000);
  }
  const flat = text.replace(/\s+/g, ' ');
  console.log(`row: ${flat}`);
  check('row says why: closed by internal matching', flat.includes(ROW.whyInternalMatchLender));
  check('row states what matching cleared, and the payout comparison', flat.includes(EXPECTED_NOTE));
  check('row shows no fallback line', !FALLBACK_LINES.some((l) => flat.includes(l)));
  await shot(`internal-match-claim-row-${LOAN_ID}`);

  // ── 4. The claim itself (opt-in) ─────────────────────────────────────
  if (SUBMIT_CLAIM && preClaimFails() > 0) {
    console.log(`SKIP claim — ${preClaimFails()} check(s) failed above; the claim would end the card under test`);
  } else if (SUBMIT_CLAIM) {
    resetWindow();
    await rowFor().first().click();
    await page.waitForURL(new RegExp(`/positions/${LOAN_ID}$`), { timeout: 30_000 });
    // The position page states the same line above its claim button.
    const claimButton = page.getByRole('button', { name: /^claim my funds$/i }).first();
    await claimButton.waitFor({ state: 'visible', timeout: 60_000 });
    const posText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    check('position page states the same comparison', posText.includes(EXPECTED_NOTE));
    await shot(`internal-match-position-${LOAN_ID}`);
    if (preClaimFails() > 0) throw new Error('a check failed or a request was refused before the claim; not claiming');
    // The driver's own RPC, before anything is sent: an outage here is a
    // precondition, not a verdict on the page.
    let before;
    try {
      before = await pub.getBlockNumber();
      // Funding is a precondition: an unfunded wallet fails inside the send,
      // which would otherwise read as a product FAIL. Twice the estimate at
      // the current fee, so a fee tick between here and the send still fits.
      const [balance, gas, gasPrice] = await Promise.all([
        pub.getBalance({ address: WALLET, blockTag: 'pending' }),
        pub.estimateContractGas({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'claimAsLender', args: [LOAN_ID], account: WALLET }),
        pub.getGasPrice(),
      ]);
      const need = gas * gasPrice * 2n;
      claimGasFloor = gas;
      claimGasCap = gas * 2n;
      if (balance < need) {
        await blocked(`${ROLE} ${WALLET} holds ${formatUnits(balance, 18)} ETH; the claim needs about ${formatUnits(need, 18)}`, null, done);
      }
    } catch (err) {
      await blocked('the direct Base Sepolia RPC could not read the block, the balance or the claim gas estimate before the claim was sent', err, done);
    }
    // The window opens before the click: the click (or its confirm step)
    // starts the app's transaction and receipt reads, and a request already
    // in flight at a reset is not counted in the new window.
    // Re-checked after the funding reads: the page kept running while they
    // were awaited, and a refusal recorded meanwhile must stop the claim.
    if (preClaimFails() > 0) throw new Error('a check failed or a request was refused before the claim; not claiming');
    resetWindow();
    claimArmed = true;
    await claimButton.click();
    // A confirm step, where the app shows one before the wallet prompt.
    await page
      .getByRole('button', { name: /^(confirm|claim)/i })
      .last()
      .click({ timeout: 10_000 })
      .catch(() => {});
    // From here on the claim may have been written, so an EXCEPTION is
    // never a product verdict: what the page shows is judged by check(),
    // and evidence capture can fail without saying anything about the app.
    const confirmed = await page
      .getByText(/claim complete/i)
      .first()
      .waitFor({ timeout: 180_000 })
      .then(
        () => true,
        () => false,
      );
    check('the page confirmed the claim ("Claim complete")', confirmed);
    // The send must have gone through the GATED injected wallet: a profile
    // still connected through another connector (a persisted WalletConnect
    // session) would bypass the exact-call gate, and its claim would
    // otherwise pass every chain check below.
    check('the claim was sent through the gated wallet, exactly once', claimSends === 1, `gate allowed ${claimSends} send(s)`);
    await shot(`internal-match-claimed-${LOAN_ID}`).catch((e) => console.log(`(screenshot not saved: ${e.message})`));
    // The claim's own event: this loan, this wallet, the recorded proceeds.
    // Direct-RPC reads after the write: an outage here leaves the payout
    // unjudged, which is UNDETERMINED, never a product FAIL.
    let claims = null;
    try {
      claims = await pub.getContractEvents({
        address: DIAMOND,
        abi: DIAMOND_ABI,
        eventName: 'LenderFundsClaimed',
        args: { loanId: LOAN_ID },
        fromBlock: before,
      });
    } catch (rErr) {
      undetermined = `the direct RPC could not read LenderFundsClaimed after the claim (${rErr.message}); check ${claimHash ?? 'the claim'} by hand`;
    }
    const mine = claims?.find((l) => l.args.claimant.toLowerCase() === WALLET.toLowerCase());
    // What the wallet actually RECEIVED, not the event's amount: the event
    // carries only the final claim, while a multi-step match pays its earlier
    // steps' proceeds out of `heldForLender` in the same transaction. So sum
    // every principal-asset Transfer to this wallet in the claim transaction
    // and compare that with the record. The event's asset is checked too,
    // since `fmt` labels amounts with the principal's symbol.
    const rightAsset = mine !== undefined && mine.args.asset.toLowerCase() === loan.principalAsset.toLowerCase();
    let received = null;
    let receipt = null;
    if (mine) {
      try {
        receipt = await pub.getTransactionReceipt({ hash: mine.transactionHash });
      } catch (rErr) {
        undetermined = `the direct RPC could not read the claim receipt ${mine.transactionHash} (${rErr.message})`;
      }
    }
    if (receipt) {
      const transfers = parseEventLogs({
        abi: ERC20_TRANSFER,
        eventName: 'Transfer',
        logs: receipt.logs.filter((l) => l.address.toLowerCase() === loan.principalAsset.toLowerCase()),
      });
      received = transfers
        .filter((t) => t.args.to.toLowerCase() === WALLET.toLowerCase())
        .reduce((sum, t) => sum + t.args.value, 0n);
    }
    // Judged only on what was read: an unread event list or receipt is the
    // UNDETERMINED recorded above, not a missing payout.
    if (claims !== null && (!mine || receipt)) check(
      'the claim paid this wallet the recorded proceeds in the principal asset',
      rightAsset && received === rec.lenderProceeds,
      !mine
        ? 'no LenderFundsClaimed for this wallet'
        : !rightAsset
          ? `the event names ${mine.args.asset}, not ${symbol} ${loan.principalAsset}, in ${mine.transactionHash}`
          : `received ${fmt(received)} (event amount ${fmt(mine.args.amount)}) in ${mine.transactionHash}`,
    );
    // The lifecycle, not only the list: `claimAsLender` burns the lender NFT
    // before it transitions the loan, so the row can vanish while the loan
    // stays open. With nothing left for the borrower the claim must settle
    // the loan; with an unclaimed borrower residual it stays InternalMatched.
    // Read at the claim's own block; an unreadable read is UNDETERMINED.
    if (receipt) {
      try {
        const at = { blockNumber: receipt.blockNumber };
        const [after, [, bAmount, bClaimed]] = await Promise.all([
          pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getLoanDetails', args: [LOAN_ID], ...at }),
          pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getClaimableAmount', args: [LOAN_ID, false], ...at }),
        ]);
        const borrowerHasNothing = bAmount === 0n || bClaimed;
        const want = borrowerHasNothing ? SETTLED : INTERNAL_MATCHED;
        check(
          `the loan is ${borrowerHasNothing ? 'Settled' : 'still InternalMatched (borrower residual unclaimed)'} after the claim`,
          Number(after.status) === want,
          `status ${after.status} at block ${receipt.blockNumber}; borrower claimable ${bAmount}, claimed ${bClaimed}`,
        );
      } catch (rErr) {
        undetermined = `the direct RPC could not read the loan's lifecycle after the claim (${rErr.message})`;
      }
    }
    // A row's absence counts only on a SETTLED, AVAILABLE list: the loading
    // and unavailable states carry no rows either.
    resetWindow();
    await visit(page, '/claims');
    const settled = await claimsListSettled();
    if (settled === 'available') {
      check('the row left /claims after the claim', (await rowFor().count()) === 0);
    } else if ((await answered()) === 0) {
      // After the write, a page that answered nothing establishes only that
      // this verification was unavailable — UNDETERMINED, never FAIL (and
      // never BLOCKED, since the claim was sent).
      undetermined = `the page RPC answered nothing while /claims reloaded, so the row's removal is unverified; the claim itself was ${claimHash ?? '(no hash)'}`;
    } else {
      check('the row left /claims after the claim', false, `the claims list never settled (${settled})`);
    }
  }
  check('no page errors', consoleErrors.filter((e) => e.startsWith('PAGEERROR')).length === 0);
} catch (err) {
  // Closed synchronously, before anything here awaits: a late or retried
  // claim request during the screenshot, the reconciliation reads or the
  // browser teardown must not pass the gate after this verdict is chosen.
  claimArmed = false;
  await shot(`internal-match-claim-error-${LOAN_ID}`).catch(() => {});
  // A claim the wallet already sent moved (or failed to move) funds whatever
  // the page did next, so its outcome is read from the chain and reported —
  // never folded into BLOCKED.
  // ONE rule after the send (the root fix for rounds 10-12, which each
  // found another post-write exception reported as a product FAIL): an
  // exception after the claim was allowed is UNDETERMINED, because the drive
  // wrote and then stopped before its checks finished. The single
  // exception-path FAIL is a receipt that positively shows the claim
  // reverted. Product findings come only from check() — any recorded before
  // the stop still make the run FAIL.
  if (claimSends > 0) {
    let receipt = null;
    let unread = '';
    if (claimHash) {
      try {
        receipt = await pub.waitForTransactionReceipt({ hash: claimHash, timeout: 120_000 });
      } catch (rErr) {
        unread = ` and the direct RPC could not read receipt ${claimHash} (${rErr.message}) — check it by hand`;
      }
    } else {
      // No hash came back: an accepted send can still be pending, so no
      // status read settles it either way.
      unread = ' and the wallet returned no hash — the claim may still land; check the lender wallet by hand';
    }
    if (receipt?.status === 'reverted') {
      console.log(`FAIL the claim reverted — ${claimHash} in block ${receipt.blockNumber}`);
      fails++;
    } else {
      const mined = receipt ? `; the claim MINED (${claimHash}, block ${receipt.blockNumber})` : '';
      undetermined = `the drive stopped after the claim was sent (${err.message})${mined}${unread}`;
    }
  } else {
    // No answer from the page's own RPC while the assertion waited: nothing
    // page-backed was observed, so this is not a verdict on the card —
    // unless a guard already recorded a refused request, which is a
    // product finding whatever the RPC did afterwards.
    // A check that already failed is a finding on a served surface too,
    // so it also rules BLOCKED out.
    if (fails === 0 && (await answered()) === 0 && violationsSoFar().length === 0) {
      await blocked('the page RPC answered nothing while the drive waited', err, done);
    }
    console.log(`FAIL drive — ${err.message}`);
    fails++;
  }
}
// Every refused request, bar the recognised Cloudflare edge beacon. CLAIM
// session: the claim gate's refusals, the chain pin's (recorded at the
// wallet boundary before the gate is asked), and any page write the egress
// guard stopped. Read-only session: every refused wallet write or non-read
// request.
const violations = violationsSoFar();
const violationCheck = SUBMIT_CLAIM
  ? 'the page asked to sign only the planned claim'
  : 'the page attempted no write in a read-only session';
for (const b of violations) check(violationCheck, false, `${b.reason} ${b.url ?? ''}`);
await done();
if (fails > 0) {
  console.log(`${fails} FAILURES`);
  process.exit(1);
}
if (undetermined) {
  console.log(`UNDETERMINED — ${undetermined}`);
  process.exit(3);
}
console.log('ALL PASS');
process.exit(0);
