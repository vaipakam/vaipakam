/**
 * Injected-wallet Playwright fixture — the checked-in port of the
 * campaign harness driver (docs/TestScopes/alpha02-harness-seed/
 * driver.mjs). Injects an EIP-1193 + EIP-6963 provider whose signing
 * and RPC happen in THIS node process via viem against the anvil
 * fork; the app sees a normal injected browser wallet and the
 * ephemeral key never enters the page.
 *
 * `launchWallet(role)` returns an independent context+page, so one
 * test can drive multiple actors (poster + acceptor, seller + buyer).
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createWalletClient, http, numberToHex } from 'viem';
import type { PrivateKeyAccount } from 'viem';
import { ANVIL_URL, anvilRpc } from './anvil';
import { CHAIN_ID, forkChain } from './chain';
import { accountFor, type Role } from './wallets';

/** Per-session wallet behaviour switches, mutable from a spec.
 *  `rejectPermit2` makes the wallet refuse Permit2 typed-data
 *  requests (EIP-1193 4001 user-reject) while signing everything
 *  else — the honest way to force the classic approve+action
 *  fallback (#1038). `permit2Rejections` counts refusals so a spec
 *  can assert the permit path was actually attempted. */
export interface WalletFlags {
  rejectPermit2: boolean;
  permit2Rejections: number;
  /** Permit2-domain typed-data requests SEEN (counted whether signed
   *  or refused) — lets a spec assert the permit path was attempted,
   *  or prove it was silently skipped (gated off) with a hard zero. */
  permit2SignatureRequests: number;
  /** eth_sendTransaction count, incremented at the provider boundary —
   *  ATTEMPTS, not confirmed broadcasts (a doomed transaction that
   *  fails estimation still counts). That makes `=== 1` the strong
   *  claim a spec wants: one attempt, no hidden failed extras. */
  sentTransactions: number;
}

export interface WalletSession {
  ctx: BrowserContext;
  page: Page;
  account: PrivateKeyAccount;
  consoleErrors: string[];
  flags: WalletFlags;
}

async function wireWallet(
  ctx: BrowserContext,
  account: PrivateKeyAccount,
  flags: WalletFlags,
): Promise<void> {
  const wallet = createWalletClient({
    chain: forkChain,
    transport: http(ANVIL_URL),
    account,
  });

  // Real injected wallets refuse to act for an account that isn't the
  // selected one — mirroring that catches from/signer wiring
  // regressions the suite would otherwise wave through (a stale
  // address in the app would sign fine here but fail in MetaMask).
  function assertSessionAccount(requested: unknown, method: string): void {
    if (
      typeof requested === 'string' &&
      requested.toLowerCase() !== account.address.toLowerCase()
    ) {
      const err = new Error(
        `${method} requested account ${requested} but the wallet's selected account is ${account.address}`,
      ) as Error & { code: number };
      err.code = 4100; // EIP-1193 "unauthorized"
      throw err;
    }
  }

  async function handle({ method, params }: { method: string; params?: unknown[] }) {
    const p = (params ?? []) as never[];
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address];
      case 'eth_chainId':
        return numberToHex(CHAIN_ID);
      case 'net_version':
        return String(CHAIN_ID);
      case 'wallet_switchEthereumChain': {
        const wanted = Number((p[0] as { chainId: string }).chainId);
        if (wanted !== CHAIN_ID) {
          const err = new Error('Unrecognized chain') as Error & { code: number };
          err.code = 4902;
          throw err;
        }
        return null;
      }
      case 'wallet_requestPermissions':
      case 'wallet_revokePermissions':
        return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_watchAsset':
        return true;
      case 'personal_sign':
        // params: [data, address]
        assertSessionAccount(p[1], method);
        return account.signMessage({ message: { raw: p[0] as `0x${string}` } });
      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJson]
        assertSessionAccount(p[0], method);
        const typed = JSON.parse(p[1] as string);
        // Spec-controlled Permit2 refusal — matched on the canonical
        // Permit2 domain name so AcceptTerms signing stays untouched.
        if (typed.domain?.name === 'Permit2') {
          flags.permit2SignatureRequests += 1;
        }
        if (flags.rejectPermit2 && typed.domain?.name === 'Permit2') {
          flags.permit2Rejections += 1;
          const err = new Error(
            'User rejected the Permit2 signature request',
          ) as Error & { code: number };
          err.code = 4001;
          throw err;
        }
        return account.signTypedData({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
      }
      case 'eth_sendTransaction': {
        flags.sentTransactions += 1;
        const tx = p[0] as {
          from?: `0x${string}`;
          to?: `0x${string}`;
          data?: `0x${string}`;
          value?: string;
          gas?: string;
        };
        assertSessionAccount(tx.from, method);
        return wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
          account,
          chain: forkChain,
        });
      }
      default:
        // Reads forward to the fork.
        return anvilRpc(method, p);
    }
  }

  await ctx.exposeBinding('__walletRequest', async (_src, payload) => {
    try {
      const result = await handle(payload as { method: string; params?: unknown[] });
      return { result: jsonSafe(result) };
    } catch (e) {
      const err = e as Error & {
        code?: number;
        shortMessage?: string;
        walk?: (fn: (x: unknown) => boolean) => unknown;
      };
      // Only {code, message} crosses into the page — a revert's DATA
      // would be lost at this boundary, and with it the app's friendly
      // named-revert copy (decodeContractError regex-recovers the
      // selector from the message string). Walk viem's cause chain for
      // the revert bytes and append them.
      let revertData: string | undefined;
      if (typeof err.walk === 'function') {
        const hit = err.walk((x) => {
          const d = (x as { data?: unknown } | null)?.data;
          return typeof d === 'string' && d.startsWith('0x') && d.length >= 10;
        }) as { data?: string } | null;
        revertData = hit?.data;
      }
      const base = err.shortMessage ?? err.message ?? 'error';
      const details = (err as { details?: string }).details;
      const message = [
        base,
        details && details !== base ? details : undefined,
        revertData ? `(data: ${revertData})` : undefined,
      ]
        .filter(Boolean)
        .join(' | ');
      return {
        error: { code: err.code ?? -32603, message },
      };
    }
  });

  await ctx.addInitScript(() => {
    const w = window as unknown as {
      ethereum?: { __vaipakamTest?: boolean };
      __walletRequest: (p: unknown) => Promise<{
        result?: unknown;
        error?: { code: number; message: string };
      }>;
    };
    if (w.ethereum?.__vaipakamTest) return;
    const listeners: Record<string, ((a: unknown) => void)[]> = {};
    const provider = {
      __vaipakamTest: true,
      isMetaMask: true,
      request: async (payload: unknown) => {
        const r = await w.__walletRequest(payload);
        if (r.error) {
          const err = new Error(r.error.message) as Error & { code: number };
          err.code = r.error.code;
          throw err;
        }
        return r.result;
      },
      on: (ev: string, fn: (a: unknown) => void) => {
        (listeners[ev] ??= []).push(fn);
        return provider;
      },
      removeListener: (ev: string, fn: (a: unknown) => void) => {
        listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
        return provider;
      },
      emit: (ev: string, arg: unknown) =>
        (listeners[ev] ?? []).forEach((f) => f(arg)),
    };
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    const info = {
      uuid: '7a3f4b1e-9d2c-4f6a-8e5b-000000000e2e',
      name: 'Vaipakam Test Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjMDA1NUZGIi8+PC9zdmc+',
      rdns: 'com.vaipakam.testwallet',
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({ info, provider }),
        }),
      );
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
}

function jsonSafe(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? numberToHex(x) : x)),
  );
}

/** Ensure the wallet is connected. wagmi AUTO-CONNECTS to the injected
 *  provider (it reports accounts without a prompt, unlike a locked
 *  MetaMask), so the Connect button often detaches mid-click — the
 *  first CI run failed on exactly that race. Success is therefore
 *  "the Connect button is gone"; clicks are best-effort nudges. */
export async function connectWallet(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: /^connect wallet$/i }).first();
  const gone = async () => !(await btn.isVisible().catch(() => false));
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await gone()) return;
    await btn.click({ timeout: 2_000 }).catch(() => {});
    for (const name of [/vaipakam test wallet/i, /metamask/i, /browser/i, /injected/i]) {
      const opt = page.getByRole('button', { name }).first();
      if (await opt.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await opt.click({ timeout: 2_000 }).catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(1_000);
  }
  if (!(await gone())) {
    throw new Error('wallet never connected (Connect button still present)');
  }
}

export const test = base.extend<{
  launchWallet: (role: Role, opts?: { advanced?: boolean }) => Promise<WalletSession>;
}>({
  launchWallet: async ({ browser, baseURL }, use) => {
    const sessions: WalletSession[] = [];
    await use(async (role, opts = {}) => {
      const account = accountFor(role);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const flags: WalletFlags = {
        rejectPermit2: false,
        permit2Rejections: 0,
        permit2SignatureRequests: 0,
        sentTransactions: 0,
      };
      await wireWallet(ctx, account, flags);
      if (opts.advanced) {
        await ctx.addInitScript(() => {
          localStorage.setItem('alpha02.mode', 'advanced');
        });
      }
      const page = await ctx.newPage();
      page.setDefaultTimeout(20_000);
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
      // Land on the app root once so the origin exists for localStorage.
      await page.goto(baseURL ?? '/', { waitUntil: 'domcontentloaded' });
      const session = { ctx, page, account, consoleErrors, flags };
      sessions.push(session);
      return session;
    });
    // Teardown gate: an UNCAUGHT page exception means the UI broke even
    // if the awaited success copy already rendered — fail the test.
    // console.error output stays collected (visible in `consoleErrors`
    // for scenario-level assertions/debugging) but is not a failure by
    // itself: expected-failure flows (e.g. the cancel-cooldown revert)
    // and dev-mode library noise legitimately log errors.
    const uncaught = sessions.flatMap((s) =>
      s.consoleErrors.filter((e) => e.startsWith('PAGEERROR: ')),
    );
    for (const s of sessions) await s.ctx.close().catch(() => {});
    if (uncaught.length > 0) {
      throw new Error(
        `uncaught page exception(s) during the scenario:\n${uncaught.join('\n')}`,
      );
    }
  },
});

export { expect };
