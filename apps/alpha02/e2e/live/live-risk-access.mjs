// #1517 post-deploy live review — the /risk-access surface end to end
// on production alpha02 against the live Base Sepolia diamond: the
// page must render the wallet's TRUE chain state (selection compared
// against the chain, not just labels present — Codex #1539 r1), a
// raise must land on-chain through the real wallet-confirm path
// (cooldown default 0 on the testnet ⇒ immediately effective),
// lowering must land and leave the vault back at the safest tier, and
// the strict card must show the withheld-enable posture (no switch
// while OFF). The driver NORMALIZES to Blue-chip before measuring the
// raise (safely rerunnable after an aborted run) and POLLS chain +
// UI to bounded timeouts instead of assuming settlement latency.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { clientsFor, ensureConnected, launch, SITE } from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAMOND = JSON.parse(
  readFileSync(
    path.join(HERE, '../../../../packages/contracts/src/deployments.json'),
    'utf8',
  ),
)['84532'].diamond;
const READ_ABI = parseAbi([
  'function getVaultRiskTier(address) view returns (uint8)',
  'function getEffectiveRiskTier(address) view returns (uint8)',
  'function getRiskStrictMode(address) view returns (bool)',
]);
const WRITE_ABI = parseAbi([
  'function setVaultRiskTier(uint8 level)',
  'function setRiskStrictMode(bool enabled)',
]);
const pub = createPublicClient({
  transport: http(process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org'),
});
const TIER_LABELS = [/Blue-chip only/i, /Broad liquid/i, /Illiquid \/ custom/i];

const { page, account, done } = await launch({ role: 'borrower' });
const who = account.address;
const rawTierOf = () =>
  pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getVaultRiskTier', args: [who] });
const tierOf = () =>
  pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getEffectiveRiskTier', args: [who] });

/** Bounded poll — production settlement latency is not assumable
 *  (Codex #1539 r1): a valid write can take well past a fixed sleep
 *  to mine AND to surface through the page's post-receipt reread. */
async function pollUntil(label, fn, { timeoutMs = 150000, everyMs = 3000 } = {}) {
  const until = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    // A transient RPC error or momentarily-unavailable locator must
    // RETRY until the deadline, not convert an infrastructure blip
    // into a product failure (Codex #1539 r2).
    try {
      if (await fn()) return true;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > until) {
      console.log(
        `poll timed out: ${label}` +
          (lastErr ? ` (last error: ${String(lastErr).slice(0, 140)})` : ''),
      );
      return false;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const fails = [];
const check = (label, ok) => {
  console.log(`${ok ? 'ok ' : 'FAIL'} ${label}`);
  if (!ok) fails.push(label);
};
/** The page's selected radio must NAME the chain's raw tier — the
 *  read-path assertion a label-presence check cannot make. Polled:
 *  right after a write the page's own reconciling reread (receipt
 *  floor + delayed second read) legitimately trails the chain by a
 *  few seconds, and a lagging public RPC stretches that further. */
async function assertSelectionMatchesChain(context) {
  const ok = await pollUntil(
    `${context}: selection matches chain`,
    async () => {
      const raw = Number(await rawTierOf());
      const selected = page.getByRole('radio', { checked: true });
      if ((await selected.count()) !== 1) return false;
      const name = (await selected.innerText()).split('\n')[0];
      return TIER_LABELS[raw].test(name);
    },
    { timeoutMs: 45000 },
  );
  check(`${context}: selected radio matches chain raw tier`, ok);
}

// Mutation bookkeeping for cleanup: a raise TRANSACTION can still be
// pending in the mempool when its bounded poll gives up — the
// confirmed tier then still reads 0 and a naive cleanup would certify
// clean right before the raise mines (Codex #1539 r7).
let raiseClicked = false;
let lowerConfirmed = false;
let raiseSeenBlock = 0n;
// Any cleanup-confirming Blue-chip read must come from a block at or
// after this floor (Codex #1539 r9): raised past the observed raise
// and past each cleanup write's receipt, so a lagging backend's
// pre-raise 0 can never satisfy a confirmation.
let confirmFloor = 0n;

/** Tier-0 observation with a block floor — the uniform stale-read
 *  discipline for every cleanup confirmation. */
async function tierZeroAtOrAfter(minBlock) {
  const bn = await pub.getBlockNumber();
  if (bn < minBlock) return false;
  const t = await pub.readContract({
    address: DIAMOND,
    abi: READ_ABI,
    functionName: 'getVaultRiskTier',
    args: [who],
    blockNumber: bn,
  });
  return Number(t) === 0;
}

// EVERYTHING after launch runs under the cleanup boundary (Codex
// #1539 r5): a throw during strict normalization, navigation, connect
// or the read-path assertions must still restore the wallet and close
// the context — not leave the manual driver stuck.
try {
// Persistent-wallet normalization BEFORE the page loads (Codex #1539
// r4): a prior strict-mode run must not poison the OFF-posture
// assertions. Chain-confirmed direct write, exactly like the fork
// spec's resetRiskState.
if (await pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getRiskStrictMode', args: [who] })) {
  console.log('note: strict mode ON from a prior run — normalizing OFF');
  const w = clientsFor(84532).wallet('borrower');
  const hash = await w.writeContract({
    address: DIAMOND,
    abi: WRITE_ABI,
    functionName: 'setRiskStrictMode',
    args: [false],
  });
  await pub.waitForTransactionReceipt({ hash });
}

await page.goto(SITE + '/risk-access', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await ensureConnected(page);

// 1. Read path — POLL for the initial snapshot first (Codex #1539
// r4): under a lagging RPC the page can still be in its loading
// state moments after connect, and recording assertions against that
// would report infrastructure latency as a product failure.
check(
  'initial risk snapshot rendered',
  await pollUntil('initial snapshot', async () => {
    const t = await page.locator('body').innerText();
    return /Blue-chip only/i.test(t) && /Broad liquid/i.test(t);
  }, { timeoutMs: 90000 }),
);
const body0 = await page.locator('body').innerText();
check('strict card withheld-enable posture', /isn’t offered here yet/i.test(body0));
check('no strict switch while OFF', (await page.getByRole('switch').count()) === 0);
await assertSelectionMatchesChain('pre-write');

// 2. Normalize to Blue-chip FIRST (rerunnable after an aborted run;
// also guarantees the next step is genuinely a raise).
if (Number(await rawTierOf()) !== 0) {
  console.log('note: wallet not at Blue-chip — normalizing via UI first');
  await page.getByRole('radio', { name: /Blue-chip only/i }).click();
  check(
    'normalization landed (effective Blue-chip)',
    await pollUntil('normalize to 0', async () => Number(await tierOf()) === 0),
  );
  // Poll until the PAGE shows Blue-chip selected and Broad clickable —
  // a fixed settle delay can expire inside the page's refetch window
  // and leave the next click aimed at a disabled radio (Codex #1539 r4).
  check(
    'page caught up with normalization',
    await pollUntil('UI shows Blue-chip selected', async () => {
      const sel = page.getByRole('radio', { checked: true });
      if ((await sel.count()) !== 1) return false;
      const name = (await sel.innerText()).split('\n')[0];
      if (!/Blue-chip only/i.test(name)) return false;
      return page.getByRole('radio', { name: /Broad liquid/i }).isEnabled();
    }, { timeoutMs: 90000 }),
  );
}

// 3. Raise to Broad through the real flow — the tier radios SUBMIT on
// click (live-revalidated write; the driver wallet auto-approves).
raiseClicked = true;
await page.getByRole('radio', { name: /Broad liquid/i }).click();
check(
  'raise landed on-chain (effective Broad)',
  await pollUntil('raise to 1', async () => {
    // Fetch the height FIRST and read the tier PINNED to it (Codex
    // #1539 r10): deriving the floor from a second request could pair
    // an up-to-date tier answer with a lagging block number, leaving
    // a floor that still admits pre-raise state. Pinned, the floor is
    // by construction the height that proved tier 1.
    const bn = await pub.getBlockNumber();
    const t = await pub.readContract({
      address: DIAMOND,
      abi: READ_ABI,
      functionName: 'getEffectiveRiskTier',
      args: [who],
      blockNumber: bn,
    });
    if (Number(t) !== 1) return false;
    raiseSeenBlock = bn;
    confirmFloor = bn + 1n;
    return true;
  }),
);
check(
  'success message rendered',
  await pollUntil('success copy', async () => {
    const t = await page.locator('body').innerText();
    // All wordings accepted across copy-direction changes (Codex
    // #1547 r4 added "riskier level saved"; the older alternatives
    // stay for cross-deploy compatibility until every deploy carries
    // the new copy).
    return /riskier level saved|now using a riskier level|level raised|level updated|confirmed against/i.test(t);
  }, { timeoutMs: 60000 }),
);
await assertSelectionMatchesChain('post-raise');

// 4. Lower back to Blue-chip; vault must end at the safest tier.
await page.getByRole('radio', { name: /Blue-chip only/i }).click();
lowerConfirmed = await pollUntil('lower to 0', async () => {
  // Pin the read to a block STRICTLY AFTER the observed raise — bare
  // value equality can be satisfied by a lagging backend still
  // serving the pre-raise state (Codex #1539 r8).
  const bn = await pub.getBlockNumber();
  if (bn <= raiseSeenBlock) return false;
  const t = await pub.readContract({
    address: DIAMOND,
    abi: READ_ABI,
    functionName: 'getEffectiveRiskTier',
    args: [who],
    blockNumber: bn,
  });
  return Number(t) === 0;
});
check('lower landed on-chain (effective Blue-chip)', lowerConfirmed);
check(
  'strict mode still OFF on-chain',
  (await pub.readContract({ address: DIAMOND, abi: READ_ABI, functionName: 'getRiskStrictMode', args: [who] })) === false,
);

} finally {
  try {
    // The cleanup GATE read gets the same transient-error tolerance
    // pollUntil gives everything else (Codex #1539 r6): one flaky RPC
    // response must not skip restoration entirely.
    let cleanupTier = null;
    for (let i = 0; i < 5 && cleanupTier === null; i++) {
      try {
        cleanupTier = Number(await rawTierOf());
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    // Unreadable after retries → attempt restoration anyway; the
    // chain-confirmed check below is the arbiter.
    if (cleanupTier === 0 && raiseClicked && !lowerConfirmed) {
      // The confirmed tier reads clean, but a broadcast raise may
      // still be pending. A direct lowering write from the same
      // account takes the NEXT nonce — it orders AFTER any pending
      // raise and guarantees the terminal state (Codex #1539 r7). If
      // nothing was actually pending this is a same-tier no-op write.
      console.log('cleanup: nonce-ordered lowering behind a possibly-pending raise');
      // Load-balanced public RPCs can hand out a pending-nonce that
      // misses the in-flight raise, making the lowering COMPETE with
      // it instead of following it (Codex #1539 r8). The receipt alone
      // is therefore not proof: re-read the confirmed tier and keep
      // submitting a fresh lowering until Blue-chip is confirmed
      // (bounded).
      const w = clientsFor(84532).wallet('borrower');
      for (let attempt = 0; attempt < 3; attempt++) {
        const hash = await w.writeContract({
          address: DIAMOND,
          abi: WRITE_ABI,
          functionName: 'setVaultRiskTier',
          args: [0],
        });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        // The receipt may belong to a same-nonce replacement (the
        // raise) — and a lagging backend can serve a pre-raise 0
        // (Codex #1539 r9). Confirm only from at least the receipt's
        // own block.
        if (receipt.blockNumber > confirmFloor) confirmFloor = receipt.blockNumber;
        const settled = await pollUntil(
          `cleanup write ${attempt + 1} confirmed Blue-chip`,
          () => tierZeroAtOrAfter(confirmFloor),
          { timeoutMs: 45000 },
        );
        if (settled) break;
      }
    }
    if (cleanupTier !== 0) {
      console.log('cleanup: restoring Blue-chip');
      try {
        await page
          .getByRole('radio', { name: /Blue-chip only/i })
          .click({ timeout: 10000 });
      } catch {
        /* page may be wedged — the direct write below still restores */
      }
      const restored = await pollUntil(
        'cleanup lower',
        () => tierZeroAtOrAfter(confirmFloor),
        { timeoutMs: 60000 },
      );
      if (!restored) {
        // Direct write with the role's own key — the cleanup
        // contract is CHAIN state, not UI reachability.
        const w = clientsFor(84532).wallet('borrower');
        const hash = await w.writeContract({
          address: DIAMOND,
          abi: WRITE_ABI,
          functionName: 'setVaultRiskTier',
          args: [0],
        });
        await pub.waitForTransactionReceipt({ hash });
        console.log('cleanup: restored via direct write');
      }
    }
    // The restore is a CHECK, not best-effort logging (Codex #1539
    // r3): a run that leaves the production wallet raised must exit
    // non-zero, whatever path got it there. Block-floored like every
    // other confirmation (r9) — a stale final read must not report a
    // false success.
    check(
      'cleanup: wallet left at Blue-chip on-chain',
      await pollUntil(
        'final Blue-chip confirmation',
        () => tierZeroAtOrAfter(confirmFloor),
        { timeoutMs: 45000 },
      ),
    );
  } catch (e) {
    console.log('cleanup failed:', String(e).slice(0, 200));
    fails.push('cleanup: wallet restored to Blue-chip');
  } finally {
    await done();
  }
}
if (fails.length) {
  console.log('FAILED checks:', fails.join(' | '));
  process.exit(1);
}
console.log('live risk-access review: ALL CHECKS PASSED');
