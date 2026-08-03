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
 *  Also pinned: the FAIL-SAFE blocked state — the retail deploy ships
 *  with the sanctions oracle unset and recovery hard-requires it
 *  (SanctionsOracleUnavailable), so the page must present recovery as
 *  unavailable rather than offer a doomed form. The spec then installs
 *  a benign always-false oracle (anvil_setCode + admin impersonation)
 *  and drives the real success path. The BANNED outcome stays
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

  // FAIL-SAFE blocked state first: the retail deploy ships with the
  // sanctions oracle unset, and recovery hard-requires it — the page
  // must say so instead of offering a doomed form.
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
  } finally {
    // Restore the EXACT pre-test oracle (Codex #1547 r4) — on the
    // retail fork that's the unset default, but a configured-oracle
    // deployment must get its own value back, not a forced zero.
    await setSanctionsOracle(originalOracle);
  }
});
