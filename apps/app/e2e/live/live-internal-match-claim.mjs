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
// Base Sepolia and signs through the repo's shared write plan (writePlan.mjs)
// holding ONE step: an eth_sendTransaction from this wallet to the Diamond,
// value 0, whose decoded call is claimAsLender(LOAN_ID), compared as a whole
// request (expectedTx). The plan is closed until the driver arms it for its
// own claim click, after every earlier check passed; anything else — that
// claim asked for earlier, a second send, a chain switch the pin refuses — is
// refused and latches the plan.
//
// The verdict is the shared one (outcomeManifest.mjs `runVerdict`), with
// this drive's own claims. Before the claim is sent, any failed check is a
// FAIL. After it, a FAIL comes only from a chain read contradicting an
// outcome claim — the payout (a reverted receipt included) or the loan's
// lifecycle. Every other post-send failure (the page's confirmation, the
// row leaving /claims, a refused request, a page error) is stated as FAILED
// inside an UNDETERMINED verdict, and so is a stop or an unreadable read.
// The OUTCOME MANIFEST printed at the end lists what was verified and what
// this drive does not verify.
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
// only with CLAIM=1 after the gate allowed the claim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits, parseAbi, parseEventLogs } from 'viem';
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
import { is, optional } from './expectedPayload.mjs';
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
const CONNECT_FIRST = readJson('apps/app/src/i18n/locales/en.json')?.copy?.wallet?.connectFirst;
if (typeof CONNECT_FIRST !== 'string') blockedSync('en.json no longer carries copy.wallet.connectFirst');
const ROW = CLAIMS.row ?? {};
// #2466 / #2470 — the position page's Owed line for an unclaimed internally
// matched loan, and the line it must NOT show (the loan is closed but not
// yet settled).
const POSITIONS = readJson('apps/app/src/i18n/locales/en.json')?.copy?.positions ?? {};
for (const k of ['owedInternalMatched', 'owedClosed']) {
  if (typeof POSITIONS[k] !== 'string') blockedSync(`en.json no longer carries copy.positions.${k}`);
}
for (const k of ['matchCleared', 'matchClearedNoCharges', 'matchPaidShort', 'matchPaidFull', 'whyInternalMatchLender']) {
  if (typeof ROW[k] !== 'string') blockedSync(`en.json no longer carries copy.claims.row.${k}`);
}
/** Every fallback line the note can show instead of a comparison. */
const FALLBACK_LINES = ['matchIncomplete', 'matchNotRecorded', 'matchUnreadable', 'matchAmountsUnreadable']
  .map((k) => ROW[k])
  .filter((v) => typeof v === 'string');

// ── The outcome manifest and the write plan ────────────────────────────
// The verdict is the repo's shared one (outcomeManifest.mjs), and the gate
// is the shared write plan (writePlan.mjs) judging the whole request with
// expectedTx (refinanceExpected.mjs) — the same machinery live-refinance.mjs
// uses (#2427 r15 root fix). Rounds 9–14 each found another edge of a
// hand-rolled gate, failure counter and exit ladder; this driver now
// declares its claims and its one planned write, and the shared modules
// decide what a run proved.
//
// OUTCOME CLAIMS — the claims a chain read after the claim can contradict,
// so a FAIL after the send comes only from them (or from a reverted
// receipt, which contradicts `payout`): the payout and the loan's lifecycle.
// Every other check after the send — the page's "Claim complete", the row
// leaving /claims, a refused request, a page error — is stated as FAILED in
// its own clause of an UNDETERMINED verdict, exactly as live-refinance's
// write discipline is. Before the send, any failed check is a FAIL.
const OUTCOME = ['payout', 'lifecycle'];
const CLAIM_ONLY = [
  {
    id: 'claimable',
    claim: 'the exact claim can execute for this wallet before anything is sent',
    checks: { estimate: 'eth_estimateGas for claimAsLender(loanId) from this wallet on the direct RPC — a revert is an observed FAIL, a transport error BLOCKED' },
  },
  {
    id: 'positionLine',
    claim: 'the position page states the same line above its claim button',
    checks: { note: 'the position page body, matched against the line rebuilt from getOwedAtInternalMatch' },
  },
  {
    id: 'pageConfirmed',
    claim: 'the app reports the claim as complete',
    checks: { complete: 'the page shows "Claim complete" within 180 s of the claim click' },
  },
  {
    id: 'payout',
    claim: 'the claim paid this wallet exactly the recorded lender proceeds, in the principal asset',
    checks: {
      paid: "LenderFundsClaimed(loanId) for this wallet, and the sum of principal-asset Transfer logs to it in that transaction's receipt, against getOwedAtInternalMatch.lenderProceeds",
    },
  },
  {
    id: 'lifecycle',
    claim: 'the loan is Settled when the borrower has nothing left to claim, otherwise still InternalMatched',
    checks: { status: "getLoanDetails.status and getClaimableAmount(loanId, borrower) at the claim's receipt block" },
  },
  {
    id: 'rowRemoved',
    claim: 'the claim row leaves /claims',
    checks: { gone: 'the /claims list, once settled and available, carries no row for this loan' },
  },
];
const MANIFEST = createManifest({
  verifiable: [
    {
      id: 'claimRow',
      claim: "the lender's /claims row states what internal matching cleared and the payout comparison, from the protocol's record",
      checks: {
        oneRow: 'exactly one /claims row links to this loan',
        why: 'the row carries copy.claims.row.whyInternalMatchLender',
        note: 'the row carries the line rebuilt from getOwedAtInternalMatch and the en catalogue',
        noFallback: 'the row carries none of the fallback lines',
      },
    },
    {
      id: 'owedLine',
      claim: "the position page says internal matching closed the loan and that it settles once its claims are collected — never 'closed and settled' (#2466, #2470)",
      checks: {
        pending: 'the position page carries copy.positions.owedInternalMatched',
        notSettled: 'the position page does not carry copy.positions.owedClosed',
      },
    },
    ...(SUBMIT_CLAIM ? CLAIM_ONLY : []),
    {
      id: 'pageHealth',
      claim: 'the page threw no uncaught error',
      checks: { noPageErrors: 'no PAGEERROR in the console capture' },
    },
    {
      id: 'writeDiscipline',
      claim: SUBMIT_CLAIM
        ? 'the page asked to sign only the planned claim, and the gate allowed it exactly once'
        : 'the page attempted no write in a read-only session',
      checks: {
        noRefusals: 'no request refused by the wallet gate, the chain pin or the egress guard, and no non-read method on a page WebSocket',
        ...(SUBMIT_CLAIM ? { planned: 'the write plan consumed its one step: claimAsLender(loanId) from this wallet to the Diamond, value 0' } : {}),
      },
    },
  ],
  notVerified: [
    ...(SUBMIT_CLAIM
      ? []
      : CLAIM_ONLY.map((c) => ({
          id: c.id,
          claim: c.claim,
          reason: 'CLAIM=1 was not set — the claim is one-shot and ends the card under test',
          coveredBy: null,
        }))),
    {
      id: 'borrowerCard',
      claim: "the borrower's claim row for the same loan",
      reason: "this drive reads the lender's row only",
      coveredBy: null,
    },
  ],
});
/** Record one check and print it the way the batch log reads. */
const check = (id, key, label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  return MANIFEST.record(id, key, ok, `${label}${detail ? ' — ' + detail : ''}`);
};
const unsettled = (id, key, reason) => {
  console.log(`??   ${id}.${key} — ${reason}`);
  MANIFEST.undetermined(id, key, reason);
};
const failedCount = () => MANIFEST.rows().filter((r) => r.status === 'failed').length;
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
/** The one write this drive may make, as the shared write plan: a whole
 *  eth_sendTransaction compared field by field (expectedTx), so the target,
 *  the decoded call, the sender and the value are all pinned and any field
 *  the request carries that the plan does not name is refused. The gas
 *  limit is the one field narrowed beyond expectedTx: the injected wallet
 *  forwards it, and a limit under the driver's own estimate only buys an
 *  out-of-gas revert that spends the funded wallet's ETH, so one is refused.
 *  (No upper bound: an unused limit is not charged.) */
let claimGasFloor = 0n;
const asBig = (v) => {
  try {
    return BigInt(v);
  } catch {
    return -1n; // absent is handled by `optional`; anything unparseable fails the bound
  }
};
/** A viem error that carries the node's own execution revert. */
const isExecutionRevert = (err) =>
  Boolean(err?.walk?.((e) => e?.name === 'ContractFunctionRevertedError' || e?.name === 'ExecutionRevertedError'));
const PLAN = SUBMIT_CLAIM
  ? createWritePlan([
      {
        id: 'claim',
        role: ROLE,
        kind: 'tx',
        purpose: `claimAsLender(${LOAN_ID})`,
        // Judged at match time: until the driver has its own estimate the
        // step cannot be judged, which refuses the request.
        expected: () =>
          claimGasFloor === 0n
            ? null
            : {
                ...expectedTx({
                  from: WALLET,
                  to: DIAMOND,
                  call: { functionName: 'claimAsLender', args: { loanId: LOAN_ID } },
                  chainId: CHAIN_ID,
                }),
                gas: optional(is(`≥ the driver's own estimate (${claimGasFloor})`, (v) => asBig(v) >= claimGasFloor)),
              },
      },
    ])
  : null;
const abiFor = (to) => (typeof to === 'string' && to.toLowerCase() === DIAMOND.toLowerCase() ? DIAMOND_ABI : null);
const claimStep = () => PLAN?.steps()[0];
/** True once the gate allowed the claim: from then on the drive has written. */
const wrote = () => claimStep()?.status === 'consumed';
/**
 * The signing gate. The plan is CLOSED until the driver arms it immediately
 * before its own claim click, after every pre-claim check passed, so a build
 * that asks for the claim on its own (while /claims loads, say) is refused.
 * The ledger is also read AT the authorization boundary: a failed check or a
 * refused request recorded between the arm and this send (a confirm step can
 * sit here for seconds) closes the plan and withholds the one-shot claim.
 * Any refusal latches the plan, so nothing is signed after one.
 */
function claimGate(method, params) {
  if (PLAN.armed() !== null && preClaimFails() > 0) PLAN.close();
  const kind = method === 'eth_sendTransaction' ? 'tx' : method;
  const actual = kind === 'tx' ? decodeTxForComparison(Array.isArray(params) ? (params[0] ?? {}) : {}, abiFor) : params;
  const v = PLAN.offer(ROLE, kind, actual);
  if (!v.ok) {
    console.log(`GATE  refused ${method}: ${v.why}`);
    return Promise.resolve({ ok: false, why: v.why });
  }
  console.log(`GATE  allowed ${v.step.purpose}`);
  return Promise.resolve({
    ok: true,
    onResult: (hash) => {
      PLAN.record(v.index, { hash, outcome: 'hash returned' });
      console.log(`TX    claim sent: ${hash}`);
    },
    onError: (err) => {
      PLAN.record(v.index, { outcome: `provider rejected: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 160)}` });
    },
  });
}
const claimHash = () => claimStep()?.record?.hash ?? null;
const session = await launch(
  SUBMIT_CLAIM
    ? { role: ROLE, startChainId: CHAIN_ID, pinnedChainId: CHAIN_ID, signingGate: claimGate, readOnlyEgress: true }
    : { role: ROLE, readOnly: true },
);
const { ctx, page, done, consoleErrors, blockedRequests } = session;
/** Evidence capture is never evidence about the app: a screenshot that fails
 *  (a full disk, a closed browser) is logged and the drive goes on, before
 *  the claim as after it. */
const shot = (name) => session.shot(name).catch((e) => console.log(`(screenshot ${name} not saved: ${e.message})`));
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
 *  'unavailable' (the list's own error state), 'disconnected' (the
 *  connect-wallet state, which carries no rows either and so must never
 *  read as an empty list) or 'loading' on timeout. */
async function claimsListSettled(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  // The connector reconnects after a reload, so the connect-wallet state
  // can flash first: it is waited out, and reported only if it is still
  // what the page shows when the wait ends.
  let disconnected = false;
  while (Date.now() < deadline) {
    const body = await page.locator('body').innerText();
    disconnected = body.includes(CONNECT_FIRST);
    if (!disconnected) {
      if (body.includes(CLAIMS.unavailable)) return 'unavailable';
      if (!body.includes(CLAIMS.checking) && body.includes(CLAIMS.title)) return 'available';
    }
    await page.waitForTimeout(1_000);
  }
  return disconnected ? 'disconnected' : 'loading';
}
/** Wallet refusals and page writes the guards recorded, bar the
 *  recognised Cloudflare edge beacon. */
const violationsSoFar = () => [
  ...splitBlocked(blockedRequests ?? [], [new URL(SITE_URL).origin]).violations,
  ...wsViolations,
];
/** Pre-claim FAILs — a check that failed, a request the wallet gate or the
 *  egress guard already refused (an early claim attempt, a chain switch, a
 *  page write), or an uncaught page exception (a page that threw is not one
 *  to sign from, however much of its DOM survived). The claim is one-shot,
 *  so it never runs after one. */
const pageErrors = () => consoleErrors.filter((e) => e.startsWith('PAGEERROR'));
const preClaimFails = () => failedCount() + violationsSoFar().length + pageErrors().length;
const rowFor = () => page.locator(`a.item-row[href$="/positions/${LOAN_ID}"]`);
/**
 * Why the loan is no longer the one this drive judges (#2505), or null. A
 * lender claim made elsewhere during the drive can legitimately settle the
 * loan or clear the lender's claim, and the page then states the new truth;
 * judged against the startup snapshot that reads as a copy FAIL. A move is
 * a precondition that changed under the drive — BLOCKED. A read that gets
 * no answer cannot say, and is reported as such.
 */
async function lifecycleMoved() {
  try {
    const [now, [, lAmount, lClaimed]] = await Promise.all([
      read('getLoanDetails', [LOAN_ID]),
      read('getClaimableAmount', [LOAN_ID, true]),
    ]);
    const why = [];
    if (Number(now.status) !== INTERNAL_MATCHED) why.push(`status ${now.status}, no longer InternalMatched`);
    if (lClaimed || lAmount === 0n) why.push(`the lender claim is ${lClaimed ? 'already collected' : 'empty'}`);
    return why.length > 0 ? why.join(', ') : null;
  } catch (err) {
    return `the direct RPC could not re-read the loan (${err.shortMessage ?? err.message})`;
  }
}
/** Why the drive stopped, when an exception ended it. */
let stopped = null;
/** Set when the driver armed the plan for its own claim click. */
let armedOnce = false;
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
  check('claimRow', 'oneRow', 'the loan has exactly one claim row', rowCount === 1, `${rowCount} rows`);
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
  check('claimRow', 'why', 'row says why: closed by internal matching', flat.includes(ROW.whyInternalMatchLender));
  check('claimRow', 'note', 'row states what matching cleared, and the payout comparison', flat.includes(EXPECTED_NOTE));
  check('claimRow', 'noFallback', 'row shows no fallback line', !FALLBACK_LINES.some((l) => flat.includes(l)));
  await shot(`internal-match-claim-row-${LOAN_ID}`);

  // The position page's Owed line (#2466, #2470), before any claim: an
  // unclaimed internally matched loan is closed but not settled.
  // Not `visit()`: that helper is for the FIRST navigation and reads any
  // failure as infrastructure (BLOCKED). /positions is a product route
  // reached after /claims loaded, so a failure here is a finding (#2481 r3).
  resetWindow();
  const posNav = await page
    .goto(`${SITE_URL.replace(/\/$/, '')}/positions/${LOAN_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .then((r) => ({ status: r?.status() ?? 200 }), (e) => ({ error: e.message }));
  // The page must still BE this loan's (#2481 r6): a redirect to another
  // position would let its copy stand in for this loan's.
  const landedOn = (() => {
    try {
      return new URL(page.url()).pathname.replace(/\/$/, '');
    } catch {
      return '';
    }
  })();
  if (posNav.error || posNav.status >= 400) {
    check('owedLine', 'pending', 'the position page loaded', false, posNav.error ?? `HTTP ${posNav.status}`);
  } else if (landedOn !== `/positions/${LOAN_ID}`) {
    check('owedLine', 'pending', `the position page stayed on loan ${LOAN_ID}`, false, `landed on ${landedOn}`);
  } else {
    let owedText = '';
    const owedDeadline = Date.now() + 45_000;
    while (Date.now() < owedDeadline) {
      owedText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      if (owedText.includes(POSITIONS.owedInternalMatched) || owedText.includes(POSITIONS.owedClosed)) break;
      await page.waitForTimeout(1_000);
    }
    // Neither line within the wait, and the page's own RPC answered nothing in
    // that window: the page never had the facts, so nothing was observed —
    // BLOCKED, never a FAIL on the copy (#2481 r1).
    if (!owedText.includes(POSITIONS.owedInternalMatched) && !owedText.includes(POSITIONS.owedClosed) && (await answered()) === 0) {
      await blocked('the page RPC answered nothing while the position page loaded, so its Owed line was never observed', null, done);
    }
    // Anything but the expected line: first rule out the loan having moved
    // during the drive, which the page would be right to report (#2505).
    if (!owedText.includes(POSITIONS.owedInternalMatched) || owedText.includes(POSITIONS.owedClosed)) {
      const moved = await lifecycleMoved();
      if (moved !== null) {
        await blocked(`loan ${LOAN_ID} moved while the position page was read — ${moved}`, null, done);
      }
    }
    check('owedLine', 'pending', 'the Owed line says matching closed it and it settles once claims are collected', owedText.includes(POSITIONS.owedInternalMatched));
    check('owedLine', 'notSettled', "the page does not call the loan 'closed and settled'", !owedText.includes(POSITIONS.owedClosed));
  }
  await shot(`internal-match-owed-${LOAN_ID}`);
  if (SUBMIT_CLAIM) {
    // The claim flow starts from the claims list.
    resetWindow();
    const back = await page.goto(`${SITE_URL.replace(/\/$/, '')}/claims`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if ((back?.status() ?? 200) >= 400) throw new Error(`/claims answered HTTP ${back.status()} on the way back`);
    const rowBack = await rowFor().first().waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false);
    if (!rowBack) {
      // The same two preconditions the first load is held to (#2505): an
      // RPC that answered nothing in this window means the list was never
      // observed, and a loan that moved meanwhile has rightly left it.
      if ((await answered()) === 0) {
        await blocked('the page RPC answered nothing while /claims reloaded, so its row was never observed', null, done);
      }
      const moved = await lifecycleMoved();
      if (moved !== null) await blocked(`loan ${LOAN_ID} moved before the claim — ${moved}`, null, done);
      throw new Error(`the loan's /claims row did not render on the way back`);
    }
  }

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
    // The button renders before the payout line loads ("checking the exact
    // amount…"), so the line is waited for: a read taken with the button
    // alone failed loan 25's drive although the page went on to state it.
    let posText = '';
    const posDeadline = Date.now() + 45_000;
    while (Date.now() < posDeadline) {
      posText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      if (posText.includes(cleared) || FALLBACK_LINES.some((l) => posText.includes(l))) break;
      await page.waitForTimeout(1_000);
    }
    check('positionLine', 'note', 'position page states the same comparison', posText.includes(EXPECTED_NOTE));
    await shot(`internal-match-position-${LOAN_ID}`);
    if (preClaimFails() > 0) throw new Error('a check failed or a request was refused before the claim; not claiming');
    // The driver's own RPC, before anything is sent: an outage here is a
    // precondition, not a verdict on the page.
    try {
      // Funding is a precondition: an unfunded wallet fails inside the send,
      // which would otherwise read as a product FAIL. Twice the estimate at
      // the current fee, so a fee tick between here and the send still fits.
      const [balance, gasPrice] = await Promise.all([
        pub.getBalance({ address: WALLET, blockTag: 'pending' }),
        pub.getGasPrice(),
      ]);
      let gas;
      try {
        gas = await pub.estimateContractGas({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'claimAsLender', args: [LOAN_ID], account: WALLET });
      } catch (err) {
        // The node ANSWERED that this exact claim cannot execute (a paused
        // Diamond, a broken claim path): an observation, not an outage.
        if (isExecutionRevert(err)) {
          check('claimable', 'estimate', 'the claim can execute for this wallet', false, `eth_estimateGas reverted: ${err.shortMessage ?? err.message}`);
          throw new Error('the claim estimate reverted; not claiming');
        }
        throw err;
      }
      check('claimable', 'estimate', 'the claim can execute for this wallet', true, `estimate ${gas} gas`);
      claimGasFloor = gas;
      const need = gas * gasPrice * 2n;
      if (balance < need) {
        await blocked(`${ROLE} ${WALLET} holds ${formatUnits(balance, 18)} ETH; the claim needs about ${formatUnits(need, 18)}`, null, done);
      }
    } catch (err) {
      if (failedCount() > 0) throw err;
      await blocked('the direct Base Sepolia RPC could not read the balance or the claim gas estimate before the claim was sent', err, done);
    }
    // Re-checked after the funding reads: the page kept running while they
    // were awaited, and a refusal recorded meanwhile must stop the claim.
    if (preClaimFails() > 0) throw new Error('a check failed or a request was refused before the claim; not claiming');
    // The window opens before the click: the click (or its confirm step)
    // starts the app's transaction and receipt reads, and a request already
    // in flight at a reset is not counted in the new window.
    resetWindow();
    PLAN.arm(ROLE);
    armedOnce = true;
    await claimButton.click();
    // A confirm step, where the app shows one before the wallet prompt.
    await page
      .getByRole('button', { name: /^(confirm|claim)/i })
      .last()
      .click({ timeout: 10_000 })
      .catch(() => {});
    // From here on the claim may have been written, so an EXCEPTION is
    // never a product verdict (the shared verdict makes it UNDETERMINED):
    // what the page shows is recorded as a check, and evidence capture can
    // fail without saying anything about the app.
    const confirmed = await page
      .getByText(/claim complete/i)
      .first()
      .waitFor({ timeout: 180_000 })
      .then(
        () => true,
        () => false,
      );
    check('pageConfirmed', 'complete', 'the page confirmed the claim ("Claim complete")', confirmed);
    PLAN.close();
    await shot(`internal-match-claimed-${LOAN_ID}`);
    // The claim's own receipt, by the hash the wallet returned — not a log
    // search, which a claim still pending would make read as "no payout".
    // Direct-RPC reads after the write: an outage here leaves the payout
    // unjudged, which is UNDETERMINED, never a product FAIL.
    const hash = claimHash();
    let receipt = null;
    if (!wrote()) {
      // Nothing was sent through the plan: `planned` states it, and no payout
      // is expected of a send that never happened.
    } else if (!hash) {
      unsettled('payout', 'paid', 'the wallet returned no hash — the claim may still land; check the lender wallet by hand');
    } else {
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      } catch (rErr) {
        unsettled('payout', 'paid', `the direct RPC could not read the claim receipt ${hash} (${rErr.message})`);
      }
    }
    // What the wallet actually RECEIVED, not the event's amount: the event
    // carries only the final claim, while a multi-step match pays its earlier
    // steps' proceeds out of `heldForLender` in the same transaction. So sum
    // every principal-asset Transfer to this wallet in the claim transaction
    // and compare that with the record. The event's asset is checked too,
    // since `fmt` labels amounts with the principal's symbol.
    const mine = receipt
      ? parseEventLogs({
          abi: DIAMOND_ABI,
          eventName: 'LenderFundsClaimed',
          logs: receipt.logs.filter((l) => l.address.toLowerCase() === DIAMOND.toLowerCase()),
        }).find((l) => l.args.loanId === LOAN_ID && l.args.claimant.toLowerCase() === WALLET.toLowerCase())
      : undefined;
    if (receipt && (receipt.status === 'reverted' || !mine)) {
      check(
        'payout',
        'paid',
        'the claim paid this wallet the recorded proceeds in the principal asset',
        false,
        receipt.status === 'reverted' ? `the claim reverted — ${hash} in block ${receipt.blockNumber}` : `no LenderFundsClaimed(${LOAN_ID}) for this wallet in ${hash}`,
      );
    } else if (receipt) {
      const rightAsset = mine.args.asset.toLowerCase() === loan.principalAsset.toLowerCase();
      const received = parseEventLogs({
        abi: ERC20_TRANSFER,
        eventName: 'Transfer',
        logs: receipt.logs.filter((l) => l.address.toLowerCase() === loan.principalAsset.toLowerCase()),
      })
        .filter((t) => t.args.to.toLowerCase() === WALLET.toLowerCase())
        .reduce((sum, t) => sum + t.args.value, 0n);
      check(
        'payout',
        'paid',
        'the claim paid this wallet the recorded proceeds in the principal asset',
        rightAsset && received === rec.lenderProceeds,
        !rightAsset
          ? `the event names ${mine.args.asset}, not ${symbol} ${loan.principalAsset}, in ${hash}`
          : `received ${fmt(received)} (event amount ${fmt(mine.args.amount)}; recorded ${fmt(rec.lenderProceeds)}) in ${hash}`,
      );
      // The lifecycle, not only the list: `claimAsLender` burns the lender NFT
      // before it transitions the loan, so the row can vanish while the loan
      // stays open. With nothing left for the borrower the claim must settle
      // the loan; with an unclaimed borrower residual it stays InternalMatched.
      // Read at the claim's own block; an unreadable read is UNDETERMINED.
      // `readPinned` asks again while the node has not yet seen that block,
      // which is what made both #2427 re-run claims UNDETERMINED.
      try {
        const at = { blockNumber: receipt.blockNumber };
        const [after, [, bAmount, bClaimed]] = await readPinned(() =>
          Promise.all([
            pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getLoanDetails', args: [LOAN_ID], ...at }),
            pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'getClaimableAmount', args: [LOAN_ID, false], ...at }),
          ]),
        );
        const borrowerHasNothing = bAmount === 0n || bClaimed;
        const want = borrowerHasNothing ? SETTLED : INTERNAL_MATCHED;
        check(
          'lifecycle',
          'status',
          `the loan is ${borrowerHasNothing ? 'Settled' : 'still InternalMatched (borrower residual unclaimed)'} after the claim`,
          Number(after.status) === want,
          `status ${after.status} at block ${receipt.blockNumber}; borrower claimable ${bAmount}, claimed ${bClaimed}`,
        );
      } catch (rErr) {
        unsettled('lifecycle', 'status', `the direct RPC could not read the loan's lifecycle after the claim (${rErr.message})`);
      }
    }
    // A row's absence counts only on a SETTLED, AVAILABLE list: the loading
    // and unavailable states carry no rows either.
    // Not `visit()`: its precondition wrapper exits BLOCKED on a failed
    // navigation, and after the send that would bypass the reconciliation
    // in the catch below. A throw here reaches it and is UNDETERMINED.
    resetWindow();
    const reload = await page.goto(`${SITE_URL.replace(/\/$/, '')}/claims`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if ((reload?.status() ?? 200) >= 400) throw new Error(`/claims answered HTTP ${reload.status()} after the claim`);
    const settled = await claimsListSettled();
    if (settled === 'disconnected') {
      // The reload lost the wallet: an empty list here says nothing about
      // this wallet's claims, so the row's absence is not observed.
      unsettled('rowRemoved', 'gone', `/claims rendered the connect-wallet state after the reload, so this wallet's post-claim list was never observed; the claim itself was ${claimHash() ?? '(no hash)'}`);
    } else if (settled === 'available') {
      check('rowRemoved', 'gone', 'the row left /claims after the claim', (await rowFor().count()) === 0);
    } else if ((await answered()) === 0) {
      // A page that answered nothing establishes only that this check was
      // unavailable — never a finding on the app.
      unsettled('rowRemoved', 'gone', `the page RPC answered nothing while /claims reloaded; the claim itself was ${claimHash() ?? '(no hash)'}`);
    } else {
      check('rowRemoved', 'gone', 'the row left /claims after the claim', false, `the claims list never settled (${settled})`);
    }
  }
} catch (err) {
  // Closed synchronously, before anything here awaits: a late or retried
  // claim request during the screenshot, the reconciliation reads or the
  // browser teardown must not pass the gate after this verdict is chosen.
  PLAN?.close();
  stopped = err.message;
  await shot(`internal-match-claim-error-${LOAN_ID}`);
  if (wrote()) {
    // A claim the gate allowed moved (or failed to move) funds whatever the
    // page did next, so its receipt is read and reported — never folded into
    // BLOCKED. A reverted receipt contradicts the payout (FAIL); anything
    // else leaves the run UNDETERMINED through the shared verdict, with what
    // the chain showed in the stop reason.
    const hash = claimHash();
    let receipt = null;
    if (hash) {
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      } catch (rErr) {
        stopped += `; the direct RPC could not read receipt ${hash} (${rErr.message}) — check it by hand`;
      }
    } else {
      // No hash came back: an accepted send can still be pending, so no
      // status read settles it either way.
      stopped += '; the wallet returned no hash — the claim may still land; check the lender wallet by hand';
    }
    if (receipt?.status === 'reverted') {
      check('payout', 'paid', 'the claim paid this wallet the recorded proceeds in the principal asset', false, `the claim reverted — ${hash} in block ${receipt.blockNumber}`);
    } else if (receipt) {
      stopped += `; the claim MINED (${hash}, block ${receipt.blockNumber})`;
    }
  } else if (!armedOnce && failedCount() === 0 && pageErrors().length === 0 && (await answered()) === 0 && violationsSoFar().length === 0) {
    // No answer from the page's own RPC while the assertion waited: nothing
    // page-backed was observed, so this is not a verdict on the card —
    // unless a check already failed or a guard already recorded a refused
    // request, or the page threw (pageHealth is recorded only after this
    // catch), each of which is a finding on a served surface. Once the
    // claim was armed it is never BLOCKED: the claim may have gone out, so
    // the drive falls through to the chain reconciliation below.
    await blocked('the page RPC answered nothing while the drive waited', err, done);
  }
  console.log(`STOP  ${stopped}`);
}
check('pageHealth', 'noPageErrors', 'no page errors', pageErrors().length === 0, pageErrors().join(' | ').slice(0, 300));
// Every refused request, bar the recognised Cloudflare edge beacon. CLAIM
// session: the plan's refusals, the chain pin's (recorded at the wallet
// boundary before the gate is asked), and any page write the egress guard
// stopped. Read-only session: every refused wallet write or non-read request.
const violations = violationsSoFar();
check(
  'writeDiscipline',
  'noRefusals',
  SUBMIT_CLAIM ? 'the page asked to sign only the planned claim' : 'the page attempted no write in a read-only session',
  violations.length === 0,
  violations.map((b) => `${b.reason} ${b.url ?? ''}`.trim()).join(' | '),
);
if (armedOnce) {
  // Only once the drive armed its claim: the plan's one step was consumed
  // exactly once (a duplicate is refused by construction, and a
  // send through any other connector never reaches the plan at all).
  check('writeDiscipline', 'planned', 'the claim was sent through the gated wallet, exactly once', wrote(), `plan step ${claimStep()?.status}`);
}
// A claim that bypassed the plan. The injected wallet's key never leaves the
// gated handler, but a profile still connected through another connector (a
// persisted WalletConnect session holding the same account) can send the
// claim without the plan ever seeing it. So once the driver has clicked its
// claim and the plan shows no send, the chain is asked whether the lender
// claim is recorded anyway: if it is, a write landed outside the gate — the
// shared verdict's gate escape, a FAIL. Unreadable is a write that may have
// happened: UNDETERMINED, never "before any write". Read at the latest block,
// so a claim still pending there is not seen.
let escaped = false;
let escapeUnknown = null;
if (armedOnce && !wrote()) {
  try {
    const [, , lenderClaimed] = await read('getClaimableAmount', [LOAN_ID, true]);
    escaped = lenderClaimed === true;
    if (escaped) {
      console.log(`ESCAPE the lender claim for loan ${LOAN_ID} is recorded on chain, but the write plan never allowed a send`);
    }
  } catch (err) {
    escapeUnknown = `the plan allowed no send, and the direct RPC could not read whether the lender claim landed through another connector (${err.message})`;
  }
}
// From the claim click on, the run is post-write whatever the plan saw: a
// send through another connector can still be pending when the read above
// returns false, so only a send the plan never armed for is "before any
// write". The plan's own record (`planned`) still states what it saw.
if (armedOnce && !wrote() && !escaped && escapeUnknown === null) {
  escapeUnknown =
    'the driver clicked its claim and the plan allowed no send; the lender claim is not recorded at the latest block, but a send through another connector may still be pending — check the lender wallet by hand';
}
const wroteAny = wrote() || armedOnce;
// Teardown is cleanup, not evidence: a browser that fails to close says
// nothing about the app or the chain, so it never replaces the verdict.
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
  outcomeClaims: SUBMIT_CLAIM ? OUTCOME : [],
  // Point the reader at the evidence THIS drive printed: the gate lines, the
  // claim's TX line and the STOP line's receipt reading. It keeps no nonce
  // reconciliation or touched-state ledger.
  evidence: {
    failed: 'see the GATE refusals and the manifest above',
    left: "the TX and STOP lines above give the claim's hash and what its receipt showed; check the lender wallet by hand if neither does",
    escape: 'the chain records the lender claim, but the write plan never allowed a send — it went through another connector (see the ESCAPE line above)',
  },
});
console.log(VERDICT.line);
process.exit(VERDICT.exit);
