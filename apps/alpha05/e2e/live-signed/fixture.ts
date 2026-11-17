/**
 * The signed live fixture: the shared injected wallet (`@vaipakam/e2e-wallet`)
 * bound to a live TEST network, signing as the dev test wallets read from a
 * file on the machine that runs the suite. No key is printed or written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseAbi, parseUnits, type Abi, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { connectWallet as connectShared, walletTest } from '@vaipakam/e2e-wallet';
import { getDeployment } from '@vaipakam/contracts/deployments';
import type { Locator, Page } from '@playwright/test';

export { expect } from '@vaipakam/e2e-wallet';

const PUBLIC_RPC: Record<number, string> = {
  84532: 'https://sepolia.base.org',
  421614: 'https://sepolia-rollup.arbitrum.io/rpc',
  97: 'https://bsc-testnet-rpc.publicnode.com',
};

export const CHAIN_ID = Number(process.env.LIVE_CHAIN_ID ?? 84532);
if (PUBLIC_RPC[CHAIN_ID] === undefined) throw new Error(`LIVE_CHAIN_ID ${CHAIN_ID} is not a test network; signed live journeys run only on 84532, 421614 or 97`);
const RPC = process.env.LIVE_RPC_URL ?? PUBLIC_RPC[CHAIN_ID]!;

export type Role = 'lender' | 'borrower' | 'newLender' | 'newBorrower';

const WALLETS_FILE = (process.env.LIVE_WALLETS_FILE ?? '~/secrets/vaipakam-dev-wallets.json').replace(/^~(?=\/)/, os.homedir());

function roster(): Record<Role, { privateKey: Hex }> {
  if (!fs.existsSync(WALLETS_FILE)) throw new Error(`test wallets file not found at ${path.resolve(WALLETS_FILE)}; set LIVE_WALLETS_FILE`);
  return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
}

export function accountFor(role: Role): PrivateKeyAccount {
  const entry = roster()[role];
  if (entry?.privateKey === undefined) throw new Error(`no test wallet for role ${role} in the wallets file`);
  return privateKeyToAccount(entry.privateKey);
}

const chain = defineChain({ id: CHAIN_ID, name: `test-${CHAIN_ID}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const pub = createPublicClient({ chain, transport: http(RPC) });

const dep = getDeployment(CHAIN_ID) as unknown as { diamond: Hex; testnetMocks: Record<string, Hex> };
export const DIAMOND = dep.diamond;
/** Mintable test tokens: mUSDC ($1) lent, tLIQ ($2,000) locked. */
export const MUSDC = dep.testnetMocks.liquidToken2 as Hex;
export const TLIQ = dep.testnetMocks.liquidToken as Hex;

const MINT = parseAbi(['function mint(address to, uint256 amount)']);

/** Send one setup transaction as a role, outside the app (token minting only). */
export async function writeAs(role: Role, address: Hex, abi: Abi, functionName: string, args: unknown[]): Promise<void> {
  const account = accountFor(role);
  const wallet = createWalletClient({ chain, transport: http(RPC), account });
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== 'success') throw new Error(`${functionName} as ${role} reverted (${hash})`);
}

/** Every role a journey uses holds gas and enough test tokens. */
export async function fund(roles: Role[]): Promise<void> {
  for (const role of roles) {
    const who = accountFor(role).address;
    const gas = await pub.getBalance({ address: who });
    if (gas < 2n * 10n ** 15n) throw new Error(`${role} ${who} holds too little gas on chain ${CHAIN_ID}; top it up first`);
    for (const [token, want] of [
      [MUSDC, parseUnits('2000', 18)],
      [TLIQ, parseUnits('5', 18)],
    ] as const) {
      const bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
      if (bal < want) await writeAs(role, token, MINT, 'mint', [who, want]);
    }
  }
}

export const test = walletTest<Role>({ chainId: CHAIN_ID, rpcUrl: RPC, accountFor, advancedModeStorage: { 'app.mode': 'advanced' }, deviceFromProject: true });

export function connectWallet(page: Page): Promise<void> {
  return connectShared(page, /^connect wallet$/i);
}

/** Wait for a flow's measured outcome and require it to be done. */
export async function settled(scope: Locator): Promise<Locator> {
  const finish = scope.locator('[data-phase="measured"]').first();
  await finish.waitFor({ state: 'visible', timeout: 300_000 });
  const verdict = await finish.getAttribute('data-verdict');
  if (verdict !== 'done') throw new Error(`flow ended ${verdict}: ${(await finish.textContent())?.slice(0, 400)}`);
  return finish;
}

/**
 * Pass the two steps a fresh wallet meets before its first position: the
 * Terms of Service acceptance and a risk-level raise. Each is a real
 * transaction the app asks for; anything else is left to the caller.
 */
export async function clearGates(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1500);
    const terms = page.locator('dialog.terms-prompt[open]');
    if (await terms.isVisible()) {
      const proceed = terms.getByRole('button', { name: /^Continue:/ });
      if (!(await proceed.isVisible())) {
        const consent = terms.locator('input[type="checkbox"]');
        if ((await consent.count()) > 0) await consent.first().check();
        await terms.getByRole('button', { name: 'Confirm in wallet' }).click();
        await proceed.waitFor({ state: 'visible', timeout: 300_000 });
      }
      await proceed.click();
      continue;
    }
    const gate = page.getByTestId('risk-gate').first();
    if (await gate.isVisible()) {
      await gate.getByTestId('risk-open').click();
      const step = page.getByTestId('risk-step').first();
      await step.getByRole('button', { name: 'Confirm in wallet' }).click();
      const finish = await settled(step);
      await finish.getByTestId('risk-back').click();
      continue;
    }
    return;
  }
}
