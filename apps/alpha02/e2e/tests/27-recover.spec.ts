/** Stuck-token recovery (T-054 port) — driven end-to-end on the fork
 *  against the real VaultFactoryFacet recovery surface.
 *
 *  Asserts the load-bearing behaviours: (1) the page is reachable ONLY
 *  via the Help explainer's deep link (the discoverability gate — no
 *  nav entry exists to click); (2) the surplus cap is the REAL
 *  on-chain `balanceOf(vault) − tracked` (dust minted straight to the
 *  vault shows up; the amount is capped against it); (3) the typed
 *  CONFIRM friction arms the sign button; (4) the EIP-712 ack +
 *  `recoverStuckERC20` submit round-trips and the SUCCESS outcome is
 *  read from the `StuckERC20Recovered` event, with the tokens landing
 *  in the connected wallet.
 *
 *  Also pinned: the FAIL-SAFE blocked state — recovery hard-requires a
 *  sanctions oracle (SanctionsOracleUnavailable), so with none
 *  configured the page must present recovery as unavailable rather than
 *  offer a doomed form. The spec CREATES that state by zeroing the
 *  oracle itself (Codex #1547 r12) rather than depending on the fork's
 *  deployment shipping it unset — a configured-oracle fork would
 *  correctly render the form. The spec then installs a benign
 *  always-false oracle (anvil_setCode + admin impersonation) and drives
 *  the real success path. The BANNED outcome stays
 *  untestable here (it needs a sanctions-LISTING oracle, which would
 *  poison every other spec's Tier-1 writes if left set) — its
 *  rendering is a copy branch of the same event-decode switch this
 *  spec exercises. The installed benign oracle is equivalent to the
 *  unset default for every other gate (both read "not sanctioned"),
 *  so suite-order side effects are nil; the finally still restores the
 *  oracle to the exact pre-test value (Codex #1547 r4).
 */
import { test, expect } from '../lib/wallet-fixture';
import { connectWallet } from '../lib/wallet-fixture';
import {
  ADMIN,
  CHAIN_ID,
  DIAMOND,
  DIAMOND_ABI_VIEM,
  MOCKS,
  forkChain,
  pub,
  walletFor,
} from '../lib/chain';
import { anvilRpc, setBalance } from '../lib/anvil';
import { encodeFunctionData, parseAbi, parseUnits, type Address } from 'viem';

const MINT_ABI = parseAbi(['function mint(address to, uint256 amount)']);
const BAL_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** A benign sanctions oracle, installed via anvil_setCode: its runtime
 *  bytecode returns one 32-byte zero word for ANY call — every
 *  isSanctioned(address) probe reads `false`. Recovery HARD-REQUIRES
 *  an oracle (SanctionsOracleUnavailable otherwise), and the retail
 *  testnet ships with it unset, so the fork installs one to exercise
 *  the real success path. */
const MOCK_ORACLE = '0x000000000000000000000000000000000000bEEF' as Address;
const ALWAYS_FALSE_CODE = '0x600060005260206000f3';

async function setSanctionsOracle(target: Address): Promise<void> {
  // The setter is owner-gated — impersonate the deployment admin.
  await setBalance(ADMIN, 10n ** 18n);
  await anvilRpc('anvil_impersonateAccount', [ADMIN]);
  try {
    const txHash = (await anvilRpc('eth_sendTransaction', [
      {
        from: ADMIN,
        to: DIAMOND,
        data: encodeFunctionData({
          abi: DIAMOND_ABI_VIEM,
          functionName: 'setSanctionsOracle',
          args: [target],
        }),
      },
    ])) as `0x${string}`;
    await pub.waitForTransactionReceipt({ hash: txHash });
  } finally {
    await anvilRpc('anvil_stopImpersonatingAccount', [ADMIN]);
  }
}

test('help explainer gates the flow; dusted vault recovers to the wallet', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('borrower');
  const token = MOCKS!.liquidToken as Address;
  // Snapshot the ORIGINAL oracle address BEFORE any assertion runs
  // (Codex #1547 r4): the finally must restore THIS exact value, not
  // unconditionally zero it — a fork whose deployment ships with an
  // oracle configured keeps that state intact, and a failed-then-
  // retried first attempt can't mask the drift by having zeroed it.
  const originalOracle = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getSanctionsOracle',
  })) as Address;
  try {
  // CREATE the unset-oracle state instead of assuming the fork is in it
  // (Codex #1547 r12). The blocked-state assertion below is strict, and
  // a retail deploy is REQUIRED to configure a sanctions oracle
  // post-deploy — so a fork of a configured deployment would correctly
  // render the form and fail an unconditional assertion. Zero it
  // explicitly through the same admin-impersonation path that installs
  // the benign mock later; the finally restores the exact snapshot
  // above either way.
  await setSanctionsOracle(
    '0x0000000000000000000000000000000000000000' as Address,
  );

  // Ensure the borrower HAS a vault (fork state inherits one from the
  // live testnet history, but a freshly redeployed diamond wouldn't).
  let vault = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserVaultAddress',
    args: [account.address],
  })) as Address;
  if (vault === '0x0000000000000000000000000000000000000000') {
    const wallet = walletFor(account);
    const hash = await wallet.writeContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getOrCreateUserVault',
      args: [account.address],
      chain: forkChain,
      account,
    });
    await pub.waitForTransactionReceipt({ hash });
    vault = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getUserVaultAddress',
      args: [account.address],
    })) as Address;
  }

  // Seed UNSOLICITED dust: mint straight to the vault address, outside
  // any protocol flow — exactly the shape recovery exists for. The
  // faucet mocks expose an unrestricted mint.
  const dust = parseUnits('1.5', 18);
  const minter = walletFor(account);
  const mintHash = await minter.writeContract({
    address: token,
    abi: MINT_ABI,
    functionName: 'mint',
    args: [vault, dust],
    chain: forkChain,
    account,
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });

  const walletBalBefore = (await pub.readContract({
    address: token,
    abi: BAL_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;

  // In via the ONLY in-app path: the Help explainer's deep link.
  await page.goto('/help', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await page.getByRole('link', { name: /open the recovery flow/i }).click();
  await expect(page).toHaveURL(/\/recover$/);

  // FAIL-SAFE blocked state: recovery hard-requires a sanctions oracle,
  // so with none configured the page must say so instead of offering a
  // doomed form. That state was CREATED above, not assumed.
  await expect(
    page.getByText(/recovery isn’t available on this network yet/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel(/token contract address/i)).toHaveCount(0);

  // Install a benign oracle (isSanctioned → false for everyone) as the
  // deployment admin, then reload — the flow opens.
  await anvilRpc('anvil_setCode', [MOCK_ORACLE, ALWAYS_FALSE_CODE]);
  await setSanctionsOracle(MOCK_ORACLE);
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Form: token meta + the real on-chain surplus render once the
  // token address resolves.
  await page.getByLabel(/token contract address/i).fill(token);
  await expect(page.getByText(/recoverable surplus/i)).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByLabel(/sender address/i)
    .fill(account.address);
  await page.getByLabel(/amount to recover/i).fill('1.5');

  await page.getByRole('button', { name: /review recovery/i }).click();

  // The signed declaration asserts the user has read the Advanced User
  // Guide's stuck-token section, so the review card must LINK it
  // (Codex #1547 r5) — an attestation to unreachable reading material
  // is not a real acknowledgement.
  await expect(
    page.getByRole('link', { name: /advanced user guide/i }),
  ).toHaveAttribute('href', /\/help\/advanced#stuck-recovery/);

  // The typed-CONFIRM friction: sign stays disabled until the literal
  // is typed.
  const sign = page.getByRole('button', { name: /sign & recover/i });
  await expect(sign).toBeDisabled();
  await page.getByLabel(/type confirm/i).fill('confirm');
  await expect(sign).toBeEnabled(); // case-insensitive on purpose
  await sign.click();

  // Success outcome — decoded from StuckERC20Recovered, tokens back in
  // the connected wallet.
  await expect(page.getByText(/recovery complete/i)).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    page.getByRole('link', { name: /view the transaction/i }),
  ).toBeVisible();

  const walletBalAfter = (await pub.readContract({
    address: token,
    abi: BAL_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
  expect(walletBalAfter - walletBalBefore).toBe(dust);

  // The completed-recovery card offers the way back to a blank form
  // (Codex #1547 r15). The route stays mounted and the stored record is
  // already forgotten, so without this action a wallet holding a SECOND
  // unsolicited token had to reload or navigate away and back.
  await page.getByRole('button', { name: /recover another token/i }).click();
  await expect(page.getByText(/recovery complete/i)).toHaveCount(0);
  const tokenField = page.getByLabel(/token contract address/i);
  await expect(tokenField).toBeVisible();
  await expect(tokenField).toHaveValue('');

  // The settled submission must be FORGOTTEN (Codex #1547 r6/r7): a
  // reload here has to land on a fresh form, never rehydrate an
  // unresolved-submission card — or the terminal 'executed' lock —
  // over a recovery that has already completed. A record left behind
  // would also leak straight into the next run of this spec.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel(/token contract address/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText(/result unconfirmed|recovery attempt went through/i),
  ).toHaveCount(0);
  } finally {
    // Restore the EXACT pre-test oracle (Codex #1547 r4) — on the
    // retail fork that's the unset default, but a configured-oracle
    // deployment must get its own value back, not a forced zero.
    await setSanctionsOracle(originalOracle);
  }
});

/**
 * Codex #1547 r7 — the receipt-less "an attempt WAS processed" verdict
 * (the on-chain recovery counter advanced while the transaction itself
 * stayed unreadable) is a TERMINAL LOCK: that attempt may have moved
 * only part of the surplus, so the card must not offer a plain start
 * over, and a lock a page reload clears is not a lock at all.
 *
 * Reaching the verdict itself has no fork trigger (anvil mines
 * instantly, so a receipt is always readable), but the PERSISTENCE and
 * the two-step way out are pure app behaviour over the stored record —
 * so this drives them from a seeded record across a real reload, which
 * is exactly the state the rehydrate path reads. No oracle is touched:
 * terminal outcome cards render ahead of the availability gate.
 */
test('a processed-but-unreadable recovery stays locked across a reload', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('borrower');
  await page.goto('/recover', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  // The exact shape signAndSubmit persists, plus the r7 settled flag.
  const storageKey = `alpha02.recoverPending.${CHAIN_ID}.${account.address.toLowerCase()}`;
  const record = JSON.stringify({
    txHash: `0x${'11'.repeat(32)}`,
    declaredSource: account.address,
    amount: '1500000000000000000',
    symbol: 'MOCK',
    decimals: 18,
    recoveryNonce: '0',
    deadline: '1',
    settled: 'executed',
  });
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [storageKey, record] as const,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(
    page.getByText(/your recovery attempt went through/i),
  ).toBeVisible({ timeout: 30_000 });
  // No plain start-over on this card — withholding it IS the lock, and
  // the explicit new-recovery action stays hidden behind the first step.
  await expect(
    page.getByRole('button', { name: /^start over$/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /start a new recovery/i }),
  ).toHaveCount(0);

  // Two-step way out: acknowledge having checked the wallet, THEN the
  // explicit "this is a separate recovery" action.
  await page.getByRole('button', { name: /checked my wallet/i }).click();
  await page.getByRole('button', { name: /start a new recovery/i }).click();
  await expect(
    page.getByText(/your recovery attempt went through/i),
  ).toHaveCount(0);

  // …and the release is persisted too — the lock must not come back.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByText(/your recovery attempt went through/i),
  ).toHaveCount(0);
});

/**
 * Cross-tab RELEASE of an unresolved card (Codex #1547 r13).
 *
 * Every tab open on one wallet shares a single record of the
 * outstanding attempt. When another tab settles or CANCELS that attempt
 * it removes the record — and a tab still showing the unresolved card
 * used to keep showing it. Worst case is a signature the user declined
 * before anything was sent: there is no transaction for "check again"
 * to find, so the card sat there until the signed deadline expired.
 *
 * The release is deliberately narrow, and all four rules are pinned
 * here: a removal naming a DIFFERENT attempt leaves the card alone, a
 * removal naming THIS attempt returns the tab to a usable form, an
 * event whose oldValue names THIS attempt while its newValue already
 * carries a NEWER one releases the stale card and adopts the newer
 * record (Codex #1547 r14 — the backgrounded-tab ordering case), a
 * write and its removal delivered BACK TO BACK in one task still
 * release (Codex #1547 r15 — no render happens in between), and a
 * SETTLED verdict (the executed lock) survives a removal untouched.
 *
 * Driven by dispatching the same `storage` event the browser delivers
 * to every other tab of the origin — a second real tab is what fires it
 * in production, but the handler under test is identical, and the fork
 * rig runs one context per wallet. The oracle is installed benign so
 * the released state is the real FORM rather than the availability
 * block; the finally restores the exact snapshot.
 */
test('a record another tab removes releases only the matching unresolved card', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('borrower');
  const originalOracle = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getSanctionsOracle',
  })) as Address;
  try {
    await anvilRpc('anvil_setCode', [MOCK_ORACLE, ALWAYS_FALSE_CODE]);
    await setSanctionsOracle(MOCK_ORACLE);

    await page.goto('/recover', { waitUntil: 'domcontentloaded' });
    await connectWallet(page);

    const storageKey = `alpha02.recoverPending.${CHAIN_ID}.${account.address.toLowerCase()}`;
    // An UNRESOLVED attempt (no `settled` flag) — the shape a broadcast
    // whose receipt was never read leaves behind.
    const pendingRecord = JSON.stringify({
      txHash: `0x${'22'.repeat(32)}`,
      attemptId: 'attempt-one',
      declaredSource: account.address,
      amount: '1500000000000000000',
      symbol: 'MOCK',
      decimals: 18,
      recoveryNonce: '0',
      deadline: '1',
    });
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [storageKey, pendingRecord] as const,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByText(/transaction submitted — result unconfirmed/i),
    ).toBeVisible({ timeout: 30_000 });

    /** The event the browser delivers to every OTHER tab on a removal. */
    const removeFromAnotherTab = (oldValue: string | null) =>
      page.evaluate(
        ([key, previous]) => {
          window.localStorage.removeItem(key);
          window.dispatchEvent(
            new StorageEvent('storage', {
              key,
              oldValue: previous,
              newValue: null,
              storageArea: window.localStorage,
            }),
          );
        },
        [storageKey, oldValue] as const,
      );

    /** The event the browser delivers on a WRITE — another tab claiming
     *  the shared slot. `oldValue` carries whatever the slot held
     *  before, which on a claim-over-a-removal is the attempt this tab
     *  is still showing (Codex #1547 r14). */
    const claimFromAnotherTab = (oldValue: string | null, newValue: string) =>
      page.evaluate(
        ([key, previous, next]) => {
          window.localStorage.setItem(key, next);
          window.dispatchEvent(
            new StorageEvent('storage', {
              key,
              oldValue: previous,
              newValue: next,
              storageArea: window.localStorage,
            }),
          );
        },
        [storageKey, oldValue, newValue] as const,
      );

    // (1) A removal naming a DIFFERENT attempt must not touch this card
    // — that is another tab tidying up an older record, not news about
    // the attempt on screen.
    await removeFromAnotherTab(
      JSON.stringify({ ...JSON.parse(pendingRecord), attemptId: 'attempt-two' }),
    );
    await expect(
      page.getByText(/transaction submitted — result unconfirmed/i),
    ).toBeVisible();

    // (2) A removal naming THIS attempt releases the card — back to a
    // usable form, not a card describing something that no longer
    // exists.
    await removeFromAnotherTab(pendingRecord);
    await expect(
      page.getByText(/transaction submitted — result unconfirmed/i),
    ).toHaveCount(0);
    await expect(page.getByLabel(/token contract address/i)).toBeVisible();

    // (3) The removal is not always delivered on its own (Codex #1547
    // r14). A backgrounded tab can process its queued event only after
    // the other tab has ALREADY claimed a new attempt over the removed
    // one — so the event says "the attempt you are showing left the
    // slot, this newer one owns it now". Deciding from a fresh read of
    // storage saw only the newer record and left this tab stuck on the
    // stale card forever; deciding from the event releases it first and
    // then adopts what replaced it.
    await claimFromAnotherTab(null, pendingRecord);
    await expect(
      page.getByText(/transaction submitted — result unconfirmed/i),
    ).toBeVisible();
    const newerRecord = JSON.stringify({
      // A fresh claim is HASHLESS — reserved before the wallet prompt
      // opens — which is also what makes the swap unmistakable on
      // screen: a different card title, not just a different link.
      txHash: null,
      attemptId: 'attempt-three',
      declaredSource: account.address,
      amount: '2500000000000000000',
      symbol: 'MOCK',
      decimals: 18,
      recoveryNonce: '1',
      deadline: '1',
    });
    await claimFromAnotherTab(pendingRecord, newerRecord);
    await expect(
      page.getByText(/transaction submitted — result unconfirmed/i),
    ).toHaveCount(0);
    await expect(
      page.getByText(/we don.t know whether this was sent/i),
    ).toBeVisible();
    await removeFromAnotherTab(newerRecord);
    await expect(
      page.getByText(/we don.t know whether this was sent/i),
    ).toHaveCount(0);

    // (4) BACK-TO-BACK write-then-removal (Codex #1547 r15). Another
    // tab reserving an attempt and dropping it a moment later — the
    // signature the user rejects as soon as the wallet opens — delivers
    // BOTH events in the same task, so React batches the two updates
    // with no render between them. Deciding the release from a step
    // snapshot that a passive effect mirrors one render later saw
    // `form` (the state before the adoption it had just made), skipped
    // the release, and stranded this tab on a hashless card for an
    // attempt that no longer existed. Dispatched without an intervening
    // render wait on purpose — waiting for one hides the ordering.
    const rejectedRecord = JSON.stringify({
      txHash: null,
      attemptId: 'attempt-four',
      declaredSource: account.address,
      amount: '3500000000000000000',
      symbol: 'MOCK',
      decimals: 18,
      recoveryNonce: '2',
      deadline: '1',
    });
    await page.evaluate(
      ([key, next]) => {
        window.localStorage.setItem(key, next);
        window.dispatchEvent(
          new StorageEvent('storage', {
            key,
            oldValue: null,
            newValue: next,
            storageArea: window.localStorage,
          }),
        );
        window.localStorage.removeItem(key);
        window.dispatchEvent(
          new StorageEvent('storage', {
            key,
            oldValue: next,
            newValue: null,
            storageArea: window.localStorage,
          }),
        );
      },
      [storageKey, rejectedRecord] as const,
    );
    await expect(
      page.getByText(/we don.t know whether this was sent/i),
    ).toHaveCount(0);
    await expect(page.getByLabel(/token contract address/i)).toBeVisible();

    // (5) A SETTLED verdict survives the same removal: the processed-
    // attempt lock is something the user still has to read, and another
    // tab clearing storage must never wipe it off this screen.
    const settledRecord = JSON.stringify({
      ...JSON.parse(pendingRecord),
      settled: 'executed',
    });
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [storageKey, settledRecord] as const,
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.getByText(/your recovery attempt went through/i),
    ).toBeVisible({ timeout: 30_000 });
    await removeFromAnotherTab(settledRecord);
    await expect(
      page.getByText(/your recovery attempt went through/i),
    ).toBeVisible();
  } finally {
    await setSanctionsOracle(originalOracle);
    await page.evaluate(
      (key) => window.localStorage.removeItem(key),
      `alpha02.recoverPending.${CHAIN_ID}.${account.address.toLowerCase()}`,
    );
  }
});
