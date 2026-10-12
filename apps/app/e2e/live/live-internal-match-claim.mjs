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
//   4. CLAIM=1 only: open the position, require the same line there, claim
//      as lender through the app, and require a claim event for the loan
//      and the row to leave /claims.
//
//   SITE_URL=https://app.vaipakam.com \
//   REFERENCE_SITE_URL=https://<worker>.workers.dev \
//   TESTNET_WALLETS_FILE=… LOAN_ID=26 [ROLE=lender] [CLAIM=1] \
//     node live-internal-match-claim.mjs
//
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits, parseAbi } from 'viem';
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
} from './driver.mjs';

const SITE_URL = requireSiteUrl();
const REFERENCE_SITE_URL = process.env.REFERENCE_SITE_URL ?? '';
if (!REFERENCE_SITE_URL) {
  blockedSync('REFERENCE_SITE_URL is required: the workers.dev URL of the deploy under review.');
}
for (const u of [SITE_URL, REFERENCE_SITE_URL]) {
  if (/alpha02\./i.test(new URL(u).host)) {
    blockedSync(`${u} is alpha02 — it serves the frozen vaipakam-alpha02 Worker, not the deploy under review.`);
  }
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
const ROW = readJson('apps/app/src/i18n/locales/en.json')?.copy?.claims?.row ?? {};
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
  const res = await fetch(new URL('/', url), { redirect: 'follow' });
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
const { page, done, shot, consoleErrors } = await launch({ role: ROLE });
const rowFor = () => page.locator(`a.item-row[href$="/positions/${LOAN_ID}"]`);
try {
  await visit(page, '/claims');
  await ensureConnected(page);
  await rowFor().first().waitFor({ state: 'visible', timeout: 60_000 });
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
  if (SUBMIT_CLAIM) {
    await rowFor().first().click();
    await page.waitForURL(new RegExp(`/positions/${LOAN_ID}$`), { timeout: 30_000 });
    // The position page states the same line above its claim button.
    const claimButton = page.getByRole('button', { name: /^claim my funds$/i }).first();
    await claimButton.waitFor({ state: 'visible', timeout: 60_000 });
    const posText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    check('position page states the same comparison', posText.includes(EXPECTED_NOTE));
    await shot(`internal-match-position-${LOAN_ID}`);
    const before = await pub.getBlockNumber();
    await claimButton.click();
    // A confirm step, where the app shows one before the wallet prompt.
    await page
      .getByRole('button', { name: /^(confirm|claim)/i })
      .last()
      .click({ timeout: 10_000 })
      .catch(() => {});
    await page.getByText(/claim complete/i).first().waitFor({ timeout: 180_000 });
    await shot(`internal-match-claimed-${LOAN_ID}`);
    // The claim's own event: this loan, this wallet, the recorded proceeds.
    const claims = await pub.getContractEvents({
      address: DIAMOND,
      abi: DIAMOND_ABI,
      eventName: 'LenderFundsClaimed',
      args: { loanId: LOAN_ID },
      fromBlock: before,
    });
    const mine = claims.find((l) => l.args.claimant.toLowerCase() === WALLET.toLowerCase());
    check(
      'LenderFundsClaimed paid this wallet the recorded proceeds',
      mine !== undefined && mine.args.amount === rec.lenderProceeds,
      mine ? `${fmt(mine.args.amount)} in ${mine.transactionHash}` : 'no event for this wallet',
    );
    await visit(page, '/claims');
    await page.waitForTimeout(8_000);
    check('the row left /claims after the claim', (await rowFor().count()) === 0);
  }
  check('no page errors', consoleErrors.filter((e) => e.startsWith('PAGEERROR')).length === 0);
} catch (err) {
  await shot(`internal-match-claim-error-${LOAN_ID}`).catch(() => {});
  console.log(`FAIL drive — ${err.message}`);
  fails++;
}
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
await done();
process.exit(fails === 0 ? 0 : 1);
