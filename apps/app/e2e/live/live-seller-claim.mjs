// #1209 live verification — a lender who sold their position withdraws, from
// the Claims page, the interest they earned while they held it, against a
// REAL seller claim on the Base Sepolia Diamond (set up by
// contracts/script/BaseSepoliaSellerClaim.s.sol: open, sell, repay).
//
// What is under test: the seller-claims card on /claims of the deployed build
// finds the loan, offers the withdrawal for it, and — with WITHDRAW=1 — sends
// exactly one `claimAsSeller(loanId)` from the seller's wallet, after which
// the chain records the withdrawal and the card states it for this loan.
// The card is read through the states it publishes (`data-state` on
// `seller-claims-state`, the row's `data-withdraw`, the
// `seller-claim-withdrawn` outcome), never through its wording.
//
// Steps:
//   1. Build check: SITE_URL must serve the same `/assets/index-*.js` as
//      REFERENCE_SITE_URL (the workers.dev URL the deploy printed). Both
//      hosts answer every path with a 200 SPA shell, so only the bundle hash
//      says which build is being reviewed. alpha02 is refused outright.
//   2. Chain: the sale recorded a claim for ROLE on LOAN_ID, the loan is no
//      longer Active, something is waiting for the seller
//      (`getSellerInterestHeld` > 0), and the chain itself would let ROLE
//      withdraw it now (a simulation of `claimAsSeller`). Otherwise BLOCKED:
//      there is no claim to judge a card against.
//   3. /claims: discovery settles as `listed`, the loan has exactly one row,
//      the row offers the withdrawal (`data-withdraw="ready"`), and the loan
//      is not among the rows the card could not read.
//   4. WITHDRAW=1 only, and only when every check above passed: press the
//      row's Withdraw, then require the card's outcome for this loan, and
//      from the chain: one `SellerInterestWithdrawn(loanId, seller)` with a
//      positive amount in the principal asset, exactly that amount received
//      by the wallet in the same transaction, and nothing left waiting at the
//      withdrawal's block.
//
// Wallet posture: without WITHDRAW the injected wallet is read-only, so a
// page asking for any signature gets a wallet error. With WITHDRAW=1 it is
// pinned to Base Sepolia and signs through the shared write plan
// (writePlan.mjs) holding ONE step: an eth_sendTransaction from this wallet
// to the Diamond, value 0, whose decoded call is claimAsSeller(LOAN_ID),
// compared as a whole request (expectedTx), with its gas limit bound below
// by the driver's own estimate. The plan is closed until the driver arms it
// for its own click; anything else is refused and latches the plan.
//
// The verdict is the shared one (outcomeManifest.mjs `runVerdict`), with this
// drive's outcome claims (`payout`, `drained`): before the send any failed
// check is a FAIL; after it, a FAIL comes only from a chain read contradicting
// those claims (a reverted receipt included), and every other post-send
// failure leaves the run UNDETERMINED. The settlement is
// `noWriteSettlement.mjs`, exactly as in live-internal-match-claim.mjs.
//
//   SITE_URL=https://app.vaipakam.com \
//   REFERENCE_SITE_URL=https://<worker>.workers.dev \
//   TESTNET_WALLETS_FILE=… LOAN_ID=4 [ROLE=lender] [WITHDRAW=1] \
//     node live-seller-claim.mjs
//
// Exit codes follow the batch contract: 0 PASS, 1 FAIL, 2 BLOCKED, and —
// declared in verdictContract.mjs's FOUR_VERDICT_DRIVERS — 3 UNDETERMINED,
// with WITHDRAW=1 after the gate allowed the send, or in any mode when the
// plan sent nothing but the wallet nonce cannot be established.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits, parseAbi, parseEventLogs } from 'viem';
import {
  exitWithVerdict,
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
import { Held, Suspect, nonceBaseline, resolveSettlement, settleRun } from './noWriteSettlement.mjs';
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
// workers.dev host: any other reference could be the same stale build and
// agree with itself.
if (!/\.workers\.dev$/i.test(hostOf(REFERENCE_SITE_URL))) {
  blockedSync(`REFERENCE_SITE_URL ${REFERENCE_SITE_URL} is not a workers.dev host — pass the URL the deploy printed.`);
}
const LOAN_ID = /^\d+$/.test(process.env.LOAN_ID ?? '') ? BigInt(process.env.LOAN_ID) : null;
if (LOAN_ID === null) blockedSync('LOAN_ID must be the sold, repaid loan (BaseSepoliaSellerClaim.s.sol prints it).');
const ROLE = process.env.ROLE ?? 'lender';
requireSigningRole(ROLE);
const WALLET = addressOf(ROLE);
const SUBMIT = process.env.WITHDRAW === '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const CHAIN_ID = 84532;
const ACTIVE = 0;

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

// ── The outcome manifest and the write plan ────────────────────────────
// OUTCOME CLAIMS — the claims a chain read after the withdrawal can
// contradict, so a FAIL after the send comes only from them (or from a
// reverted receipt, which contradicts `payout`).
const OUTCOME = ['payout', 'drained'];
const SEND_ONLY = [
  {
    id: 'withdrawable',
    claim: 'the exact withdrawal can execute for this wallet before anything is sent',
    checks: { estimate: 'eth_estimateGas for claimAsSeller(loanId) from this wallet on the direct RPC — a revert is NOT ESTABLISHED, a transport error BLOCKED' },
  },
  {
    id: 'cardOutcome',
    claim: 'the card states the withdrawal for this loan',
    checks: { stated: 'a seller-claim-withdrawn outcome carrying this loan id within 180 s of the click' },
  },
  {
    id: 'payout',
    claim: 'the withdrawal paid this wallet, in the principal asset, exactly the amount the chain records',
    checks: {
      paid: "one SellerInterestWithdrawn(loanId, this wallet) with a positive amount and the principal asset, and the sum of principal-asset Transfer logs to this wallet in that transaction's receipt equal to it",
    },
  },
  {
    id: 'drained',
    claim: 'nothing is left waiting for the seller on this loan',
    checks: { zero: "getSellerInterestHeld(loanId, wallet, principalAsset) at the withdrawal's receipt block is 0" },
  },
];
const MANIFEST = createManifest({
  verifiable: [
    {
      id: 'claimRow',
      claim: "the seller's /claims card finds this loan and offers its withdrawal",
      checks: {
        listed: 'seller-claims-state settles as listed',
        readable: 'the loan is not among the rows the card could not read (data-unread)',
        oneRow: 'exactly one seller-claims row carries this loan id',
        ready: 'the row publishes data-withdraw="ready" and carries the Withdraw button',
      },
    },
    ...(SUBMIT ? SEND_ONLY : []),
    {
      id: 'pageHealth',
      claim: 'the page threw no uncaught error and sent no malformed chain request',
      checks: {
        noPageErrors: 'no PAGEERROR in the console capture',
        noMalformedRpc: 'no chain request the page sent was refused as malformed by a reachable provider (#1633)',
      },
    },
    {
      id: 'writeDiscipline',
      claim: SUBMIT
        ? 'the page asked to sign only the planned withdrawal, and the gate allowed it exactly once'
        : 'the page attempted no write in a read-only session',
      checks: {
        noRefusals: 'no request refused by the wallet gate, the chain pin or the egress guard, and no non-read method on a page WebSocket',
        ...(SUBMIT ? { planned: 'the write plan consumed its one step: claimAsSeller(loanId) from this wallet to the Diamond, value 0' } : {}),
      },
    },
  ],
  notVerified: [
    ...(SUBMIT
      ? []
      : SEND_ONLY.map((c) => ({
          id: c.id,
          claim: c.claim,
          reason: 'WITHDRAW=1 was not set — the withdrawal is one-shot and ends the row under test',
          coveredBy: null,
        }))),
    {
      id: 'copy',
      claim: "the card's wording (held and owed lines, the withdrawn sentence)",
      reason: 'this drive reads the states the card publishes, not its text',
      coveredBy: 'apps/app/e2e/tests/56-seller-claims.spec.ts reads the same states on Anvil',
    },
    {
      id: 'saleAndRepay',
      claim: 'the sale and the repayment that created the claim',
      reason: 'set up by contracts/script/BaseSepoliaSellerClaim.s.sol, which checks its own outcome on chain',
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
  // Not followed: a reference host that redirects to SITE_URL would make
  // both checks read the same shell.
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
let claimOwed;
let heldBefore;
let symbol;
let decimals;
try {
  loan = await read('getLoanDetails', [LOAN_ID]);
  const [, , , claims] = await read('getInterestLedger', [LOAN_ID]);
  claimOwed = claims.find((c) => c.seller.toLowerCase() === WALLET.toLowerCase())?.grossOwed ?? null;
  heldBefore = await read('getSellerInterestHeld', [LOAN_ID, WALLET, loan.principalAsset]);
  [symbol, decimals] = await Promise.all([
    pub.readContract({ address: loan.principalAsset, abi: ERC20, functionName: 'symbol' }),
    pub.readContract({ address: loan.principalAsset, abi: ERC20, functionName: 'decimals' }),
  ]);
} catch (err) {
  await blocked('chain reads failed', err);
}
const fmt = (v) => `${formatUnits(v, Number(decimals))} ${symbol}`;
if (claimOwed === null) await blocked(`loan ${LOAN_ID}'s interest ledger holds no seller claim for ${ROLE} ${WALLET}`);
if (Number(loan.status) === ACTIVE) {
  await blocked(`loan ${LOAN_ID} is still Active — run the fixture's repay stage first, so the claim is paid and can be withdrawn`);
}
if (heldBefore === 0n) await blocked(`nothing is waiting for ${ROLE} ${WALLET} on loan ${LOAN_ID} (getSellerInterestHeld is 0)`);
// The chain's own answer, at startup: a withdrawal the chain already refuses
// (a pause, a sanctions flag) is not a card this drive can judge.
try {
  await pub.simulateContract({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'claimAsSeller', args: [LOAN_ID], account: WALLET });
} catch (err) {
  if (!err?.walk?.((e) => e?.name === 'ContractFunctionRevertedError')) await blocked('the direct RPC could not simulate the withdrawal at startup', err);
  const name = err.walk((e) => e?.name === 'ContractFunctionRevertedError')?.data?.errorName;
  await blocked(`the chain already refuses claimAsSeller(${LOAN_ID}) for ${ROLE} ${WALLET} at startup (${name ?? err.shortMessage ?? err.message})`);
}
console.log(`claim: owed ${fmt(claimOwed)} gross, waiting ${fmt(heldBefore)}; loan status ${loan.status}`);

// ── Wallet posture ─────────────────────────────────────────────────────
let gasFloor = 0n;
const asBig = (v) => {
  try {
    return BigInt(v);
  } catch {
    return -1n;
  }
};
const isExecutionRevert = (err) =>
  Boolean(err?.walk?.((e) => e?.name === 'ContractFunctionRevertedError' || e?.name === 'ExecutionRevertedError'));
const PLAN = SUBMIT
  ? createWritePlan([
      {
        id: 'withdraw',
        role: ROLE,
        kind: 'tx',
        purpose: `claimAsSeller(${LOAN_ID})`,
        // Judged at match time: until the driver has its own estimate the
        // step cannot be judged, which refuses the request.
        expected: () =>
          gasFloor === 0n
            ? null
            : {
                ...expectedTx({
                  from: WALLET,
                  to: DIAMOND,
                  call: { functionName: 'claimAsSeller', args: { loanId: LOAN_ID } },
                  chainId: CHAIN_ID,
                }),
                gas: optional(is(`≥ the driver's own estimate (${gasFloor})`, (v) => asBig(v) >= gasFloor)),
              },
      },
    ])
  : null;
const abiFor = (to) => (typeof to === 'string' && to.toLowerCase() === DIAMOND.toLowerCase() ? DIAMOND_ABI : null);
const planStep = () => PLAN?.steps()[0];
const wrote = () => planStep()?.status === 'consumed';
/** The signing gate: closed until the driver arms it for its own click, and
 *  closed again when a check failed or a request was refused after the arm. */
function gate(method, params) {
  if (PLAN.armed() !== null && preSendFails() > 0) PLAN.close();
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
      console.log(`TX    withdrawal sent: ${hash}`);
    },
    onError: (err) => {
      PLAN.record(v.index, { outcome: `provider rejected: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 160)}` });
    },
  });
}
const sentHash = () => planStep()?.record?.hash ?? null;
let nonceAtStart;
try {
  const base = await nonceBaseline(pub, WALLET);
  if (base.blocked) await blocked(`${ROLE} ${base.blocked}`);
  nonceAtStart = base.nonce;
} catch (err) {
  await blocked('the direct RPC could not read the wallet nonce at startup', err);
}
// A throwaway profile: no paired connector session can carry a signing
// request past the browser's close (#2505 r36).
const session = await launch(
  SUBMIT
    ? { role: ROLE, startChainId: CHAIN_ID, pinnedChainId: CHAIN_ID, signingGate: gate, readOnlyEgress: true, freshProfile: true }
    : { role: ROLE, readOnly: true, freshProfile: true },
);
const { page, done, consoleErrors, blockedRequests } = session;
const shot = (name) => session.shot(name).catch((e) => console.log(`(screenshot ${name} not saved: ${e.message})`));
const rpc = watchPageRpc(page);
const { wsViolations } = attachLedger(page, createReadLedger({}), READ_METHODS);
const resetWindow = () => rpc.reset();
const answered = () => rpc.settled();
const violationsSoFar = () => [
  ...splitBlocked(blockedRequests ?? [], [new URL(SITE_URL).origin]).violations,
  ...wsViolations,
];
const pageErrors = () => consoleErrors.filter((e) => e.startsWith('PAGEERROR'));
const preSendFails = () => failedCount() + violationsSoFar().length + pageErrors().length + rpc.sessionFaults().length;
let held = null;
let suspect = null;
async function blockPre(why, err = null) {
  if (preSendFails() > 0) {
    throw new Error(`${why}; nothing after it is judged, and the ${preSendFails()} failure(s) recorded before it stand`);
  }
  throw new Held(err ? `${why} (${err?.shortMessage ?? err?.message ?? err})` : why);
}
const stateMarker = () => page.getByTestId('seller-claims-state');
const rowFor = () => page.locator(`[data-testid="seller-claims"] li[data-loan="${LOAN_ID}"]`);
const outcomeFor = () => page.locator(`[data-testid="seller-claim-withdrawn"][data-loan="${LOAN_ID}"]`);
/** The discovery state once it leaves `loading`, or 'loading' on timeout. */
async function discoverySettled(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await stateMarker().getAttribute('data-state', { timeout: 5_000 }).catch(() => null);
    if (state && state !== 'loading') return state;
    await page.waitForTimeout(1_000);
  }
  return 'loading';
}
let stopped = null;
let armedOnce = false;
try {
  resetWindow();
  await visit(page, '/claims');
  await ensureConnected(page);
  const state = await discoverySettled();
  if (state === 'loading' && (await answered()) === 0) {
    await blockPre('the page RPC answered nothing while seller claims loaded, so the card was never observed');
  }
  // Anything but `listed` may be the page rightly reporting a claim that moved
  // (withdrawn elsewhere meanwhile): not established, never a FAIL (#2505 r48).
  if (state !== 'listed') {
    throw new Suspect(`seller-claims discovery settled as ${state}`, { row: 'claimRow', key: 'listed', label: 'seller-claims discovery settled as listed' });
  }
  check('claimRow', 'listed', 'seller-claims discovery settled as listed', true);
  const unread = ((await stateMarker().getAttribute('data-unread')) ?? '').split(',').filter(Boolean);
  check('claimRow', 'readable', 'the card read this loan', !unread.includes(String(LOAN_ID)), unread.length ? `unread: ${unread.join(',')}` : '');
  const rowCount = await rowFor().count();
  if (rowCount === 0) {
    throw new Suspect(`the seller-claims card has no row for loan ${LOAN_ID}`, { row: 'claimRow', key: 'oneRow', label: 'exactly one seller-claims row carries this loan id' });
  }
  check('claimRow', 'oneRow', 'exactly one seller-claims row carries this loan id', rowCount === 1, `${rowCount} rows`);
  // The row's withdrawal verdict is the page's own simulation of
  // claimAsSeller, read with the row: ready, nothing-yet, refused or unknown.
  const verdict = await rowFor().first().getAttribute('data-withdraw');
  const hasButton = (await rowFor().first().getByTestId('seller-claim-withdraw').count()) === 1;
  check('claimRow', 'ready', 'the row offers the withdrawal', verdict === 'ready' && hasButton, `data-withdraw=${verdict}, button ${hasButton ? 'shown' : 'absent'}`);
  await shot(`seller-claim-row-${LOAN_ID}`);

  // ── 4. The withdrawal itself (opt-in) ────────────────────────────────
  if (SUBMIT && preSendFails() > 0) {
    console.log(`SKIP withdrawal — ${preSendFails()} check(s) failed above; it would end the row under test`);
  } else if (SUBMIT) {
    try {
      const [balance, gasPrice] = await Promise.all([
        pub.getBalance({ address: WALLET, blockTag: 'pending' }),
        pub.getGasPrice(),
      ]);
      let gas;
      try {
        gas = await pub.estimateContractGas({ address: DIAMOND, abi: DIAMOND_ABI, functionName: 'claimAsSeller', args: [LOAN_ID], account: WALLET });
      } catch (err) {
        if (isExecutionRevert(err)) {
          throw new Suspect('the withdrawal estimate reverted; not withdrawing', {
            row: 'withdrawable',
            key: 'estimate',
            label: 'the withdrawal can execute for this wallet',
            detail: `eth_estimateGas reverted: ${err.shortMessage ?? err.message}`,
          });
        }
        throw err;
      }
      check('withdrawable', 'estimate', 'the withdrawal can execute for this wallet', true, `estimate ${gas} gas`);
      gasFloor = gas;
      const need = gas * gasPrice * 2n;
      if (balance < need) {
        await blockPre(`${ROLE} ${WALLET} holds ${formatUnits(balance, 18)} ETH; the withdrawal needs about ${formatUnits(need, 18)}`);
      }
    } catch (err) {
      if (err instanceof Held || err instanceof Suspect) throw err;
      if (preSendFails() > 0) throw err;
      await blockPre('the direct Base Sepolia RPC could not read the balance or the gas estimate before the withdrawal was sent', err);
    }
    if (preSendFails() > 0) throw new Error('a check failed or a request was refused before the withdrawal; not withdrawing');
    resetWindow();
    PLAN.arm(ROLE);
    armedOnce = true;
    await rowFor().first().getByTestId('seller-claim-withdraw').click();
    // From here on the withdrawal may have been written, so an exception is
    // never a product verdict (the shared verdict makes it UNDETERMINED).
    const stated = await outcomeFor()
      .first()
      .waitFor({ state: 'visible', timeout: 180_000 })
      .then(
        () => true,
        () => false,
      );
    PLAN.close();
    if (!wrote()) {
      throw new Suspect('the page sent no withdrawal after Withdraw was clicked', {
        row: 'writeDiscipline',
        key: 'planned',
        label: 'the withdrawal was sent through the gated wallet, exactly once',
        detail: `plan step ${planStep()?.status}; card ${stated ? 'stated a withdrawal' : 'stated nothing'}`,
      });
    }
    check('cardOutcome', 'stated', 'the card states the withdrawal for this loan', stated);
    await shot(`seller-claim-withdrawn-${LOAN_ID}`);
    const hash = sentHash();
    let receipt = null;
    if (!hash) {
      unsettled('payout', 'paid', 'the wallet returned no hash — the withdrawal may still land; check the seller wallet by hand');
    } else {
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      } catch (rErr) {
        unsettled('payout', 'paid', `the direct RPC could not read the withdrawal receipt ${hash} (${rErr.message})`);
      }
    }
    const events = receipt
      ? parseEventLogs({
          abi: DIAMOND_ABI,
          eventName: 'SellerInterestWithdrawn',
          logs: receipt.logs.filter((l) => l.address.toLowerCase() === DIAMOND.toLowerCase()),
        }).filter((l) => l.args.loanId === LOAN_ID && l.args.seller.toLowerCase() === WALLET.toLowerCase())
      : [];
    if (receipt && (receipt.status === 'reverted' || events.length !== 1)) {
      check(
        'payout',
        'paid',
        'the withdrawal paid this wallet exactly the recorded amount in the principal asset',
        false,
        receipt.status === 'reverted'
          ? `the withdrawal reverted — ${hash} in block ${receipt.blockNumber}`
          : `${events.length} SellerInterestWithdrawn(${LOAN_ID}) for this wallet in ${hash}, not one`,
      );
    } else if (receipt) {
      const ev = events[0];
      const rightAsset = ev.args.asset.toLowerCase() === loan.principalAsset.toLowerCase();
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
        'the withdrawal paid this wallet exactly the recorded amount in the principal asset',
        rightAsset && ev.args.amount > 0n && received === ev.args.amount,
        !rightAsset
          ? `the event names ${ev.args.asset}, not ${symbol} ${loan.principalAsset}, in ${hash}`
          : `event ${fmt(ev.args.amount)}, received ${fmt(received)} (waiting before: ${fmt(heldBefore)}) in ${hash}`,
      );
      try {
        const left = await readPinned(() =>
          pub.readContract({
            address: DIAMOND,
            abi: DIAMOND_ABI,
            functionName: 'getSellerInterestHeld',
            args: [LOAN_ID, WALLET, loan.principalAsset],
            blockNumber: receipt.blockNumber,
          }),
        );
        check('drained', 'zero', 'nothing is left waiting for the seller on this loan', left === 0n, `${fmt(left)} at block ${receipt.blockNumber}`);
      } catch (rErr) {
        unsettled('drained', 'zero', `the direct RPC could not read what is left waiting after the withdrawal (${rErr.message})`);
      }
    }
  }
} catch (err) {
  // Closed synchronously, before anything here awaits.
  PLAN?.close();
  if (err instanceof Held) held = err.message;
  else if (err instanceof Suspect) suspect = err;
  else stopped = err.message;
  await shot(`seller-claim-error-${LOAN_ID}`);
  if (wrote()) {
    const hash = sentHash();
    let receipt = null;
    if (hash) {
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      } catch (rErr) {
        stopped = `${stopped ?? suspect?.message ?? held}; the direct RPC could not read receipt ${hash} (${rErr.message}) — check it by hand`;
      }
    } else {
      stopped = `${stopped ?? suspect?.message ?? held}; the wallet returned no hash — the withdrawal may still land; check the seller wallet by hand`;
    }
    if (receipt?.status === 'reverted') {
      check('payout', 'paid', 'the withdrawal paid this wallet exactly the recorded amount in the principal asset', false, `the withdrawal reverted — ${hash} in block ${receipt.blockNumber}`);
    } else if (receipt) {
      stopped = `${stopped ?? suspect?.message ?? held}; the withdrawal MINED (${hash}, block ${receipt.blockNumber})`;
    }
  } else if (held === null && !armedOnce && failedCount() === 0 && pageErrors().length === 0 && (await answered()) === 0 && violationsSoFar().length === 0) {
    // Nothing page-backed was observed: a precondition, not a verdict.
    held = `the page RPC answered nothing while the drive waited (${suspect?.message ?? stopped})`;
    [suspect, stopped] = [null, null];
  }
  console.log(`STOP  ${held ?? suspect?.message ?? stopped}`);
}
// ── Settlement (noWriteSettlement.mjs) ─────────────────────────────────
const settled = await settleRun({
  closeBrowser: done,
  judgeLedgers: () => {
    check('pageHealth', 'noPageErrors', 'no page errors', pageErrors().length === 0, pageErrors().join(' | ').slice(0, 300));
    check('pageHealth', 'noMalformedRpc', 'no malformed chain request', rpc.sessionFaults().length === 0, rpc.sessionFaults().join(' | ').slice(0, 300));
    const violations = violationsSoFar();
    check(
      'writeDiscipline',
      'noRefusals',
      SUBMIT ? 'the page asked to sign only the planned withdrawal' : 'the page attempted no write in a read-only session',
      violations.length === 0,
      violations.map((b) => `${b.reason} ${b.url ?? ''}`.trim()).join(' | '),
    );
  },
  wrotePlan: wrote,
  pub,
  wallet: WALLET,
  baseline: nonceAtStart,
});
const resolved = resolveSettlement({ settled, held, stopped, suspect, findings: failedCount(), subject: `loan ${LOAN_ID}'s seller claim` });
if (resolved.blocked) await blocked(resolved.blocked);
if (resolved.undetermined) {
  const u = resolved.undetermined;
  unsettled(u.row, u.key, `${u.label}: ${u.why}${u.detail ? ` (${u.detail})` : ''}; something outside the page may explain it and this drive cannot rule that out`);
}
if (armedOnce && (wrote() || !resolved.wrote) && held === null && suspect === null) {
  check('writeDiscipline', 'planned', 'the withdrawal was sent through the gated wallet, exactly once', wrote(), `plan step ${planStep()?.status}`);
}
for (const line of MANIFEST.render()) console.log(line);
const VERDICT = runVerdict({
  rows: MANIFEST.rows(),
  wrote: resolved.wrote,
  stopped: resolved.stopped,
  preWriteFailure: !resolved.wrote && failedCount() > 0,
  gateEscape: resolved.gateEscape,
  writeUnknown: resolved.writeUnknown === true,
  outcomeClaims: SUBMIT ? OUTCOME : [],
  evidence: {
    failed: 'see the GATE refusals and the manifest above',
    left: "the TX and STOP lines above give the withdrawal's hash and what its receipt showed; check the seller wallet by hand if neither does",
    escape: 'no gate escape is reported by this drive',
  },
});
console.log(VERDICT.line);
await exitWithVerdict(VERDICT.exit);
