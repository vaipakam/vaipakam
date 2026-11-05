/**
 * The injected-wallet Playwright fixture, shared by the connected apps' e2e
 * tiers (apps/app/e2e and apps/alpha05/e2e; the apps/app copy was the
 * checked-in port of the campaign harness driver). It injects an EIP-1193 +
 * EIP-6963 provider whose signing and RPC happen in THIS node process via
 * viem against the suite's local Anvil; the app sees a normal injected
 * browser wallet and the ephemeral key never enters the page.
 *
 * Nothing here knows an app: the suite binds it to its chain, its RPC and
 * its wallet roster through {@link WalletFixtureOptions}, and
 * {@link walletTest} returns the `test` object its specs import.
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createWalletClient, http, numberToHex, type Chain, type PrivateKeyAccount } from 'viem';
import { redactSecrets } from '@vaipakam/lib/errorDescription';

/** Per-session wallet behaviour switches, mutable from a spec.
 *  `rejectPermit2` makes the wallet refuse Permit2 typed-data requests
 *  (EIP-1193 4001 user-reject) while signing everything else, the honest
 *  way to force the classic approve+action fallback (#1038).
 *  `permit2Rejections` counts refusals so a spec can assert the permit path
 *  was actually attempted. */
export interface WalletFlags {
  rejectPermit2: boolean;
  permit2Rejections: number;
  /** Permit2-domain typed-data requests SEEN (counted whether signed or
   *  refused): lets a spec assert the permit path was attempted, or prove
   *  it was silently skipped (gated off) with a hard zero. */
  permit2SignatureRequests: number;
  /** eth_sendTransaction count at the provider boundary: ATTEMPTS, not
   *  confirmed broadcasts (a doomed transaction that fails estimation still
   *  counts), so `=== 1` is the strong claim a spec wants. */
  sentTransactions: number;
  /** eth_signTypedData_v4 requests SEEN, by primary type (`AcceptTerms`,
   *  `SignedOffer`, `PermitTransferFrom`, ...). Lets a spec prove a signer
   *  refused BEFORE the wallet was asked. */
  typedDataRequests: Record<string, number>;
}

export function newWalletFlags(): WalletFlags {
  return {
    rejectPermit2: false,
    permit2Rejections: 0,
    permit2SignatureRequests: 0,
    sentTransactions: 0,
    typedDataRequests: {},
  };
}

export interface WalletSession {
  ctx: BrowserContext;
  page: Page;
  account: PrivateKeyAccount;
  consoleErrors: string[];
  flags: WalletFlags;
}

/** How a suite binds the fixture to its chain. */
export interface WalletFixtureOptions<Role extends string> {
  /** The id the local node presents (the app's chain, e.g. Base Sepolia's). */
  chainId: number;
  /** The local node's JSON-RPC URL: reads the provider forwards and the
   *  transport the wallet client sends through. */
  rpcUrl: string;
  /** The suite's wallet roster: the account a role signs as. */
  accountFor: (role: Role) => PrivateKeyAccount;
  /** Forward a read (any method the wallet does not answer itself) to the
   *  node. Defaults to a plain JSON-RPC POST to `rpcUrl`. */
  rpc?: (method: string, params: unknown[]) => Promise<unknown>;
  /** The localStorage entries to seed before the first navigation when a
   *  spec asks for `advanced` mode (the app's own mode key). */
  advancedModeStorage?: Record<string, string>;
  /** The viewport every session opens with. */
  viewport?: { width: number; height: number };
  /** Open each session with the Playwright PROJECT's device instead of a
   *  fixed viewport: its viewport, `isMobile` and `hasTouch`. A suite that
   *  runs a phone project beside a desktop one sets this, so every spec
   *  runs on both devices; `viewport` is then ignored. */
  deviceFromProject?: boolean;
}

export interface WireWalletOptions {
  /** The chain the local node presents and reads go to. */
  chainId: number;
  /** The chain the WALLET reports at first, when a spec starts it on an
   *  unsupported network; `wallet_switchEthereumChain` to `chainId` is then
   *  honoured (and announced to the page) like a real wallet's switch. */
  walletChainId?: number;
  rpcUrl: string;
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  /** A real wallet reports NO accounts until the user approves; `false`
   *  lets a spec drive the disconnected first visit. Connecting through the
   *  app's own control still works: it fires eth_requestAccounts, which
   *  grants the session. */
  preAuthorized: boolean;
}

function chainFor(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `local e2e chain (${chainId})`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

async function jsonRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Wire the injected wallet into a browser context. */
export async function wireWallet(
  ctx: BrowserContext,
  account: PrivateKeyAccount,
  flags: WalletFlags,
  opts: WireWalletOptions,
): Promise<void> {
  const chain = chainFor(opts.chainId, opts.rpcUrl);
  const wallet = createWalletClient({ chain, transport: http(opts.rpcUrl), account });
  let authorized = opts.preAuthorized;
  let current = opts.walletChainId ?? opts.chainId;

  // Real injected wallets refuse to act for an account that is not the
  // selected one; mirroring that catches from/signer wiring regressions the
  // suite would otherwise wave through.
  function assertSessionAccount(requested: unknown, method: string): void {
    if (typeof requested === 'string' && requested.toLowerCase() !== account.address.toLowerCase()) {
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
        authorized = true; // the approval moment, like a real wallet
        return [account.address];
      case 'eth_accounts':
        return authorized ? [account.address] : [];
      case 'eth_chainId':
        return numberToHex(current);
      case 'net_version':
        return String(current);
      case 'wallet_switchEthereumChain': {
        // The node's chain and the one the wallet started on are the chains
        // this wallet "has"; anything else is unrecognised, like a wallet
        // that was never configured for it.
        const wanted = Number((p[0] as { chainId: string }).chainId);
        if (wanted !== opts.chainId && wanted !== (opts.walletChainId ?? opts.chainId)) {
          const err = new Error('Unrecognized chain') as Error & { code: number };
          err.code = 4902;
          throw err;
        }
        current = wanted;
        return null;
      }
      case 'wallet_requestPermissions':
        authorized = true; // granting eth_accounts IS an approval
        return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_revokePermissions':
        authorized = false; // post-revoke eth_accounts reports []
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
        const primary = String(typed.primaryType ?? 'unknown');
        flags.typedDataRequests[primary] = (flags.typedDataRequests[primary] ?? 0) + 1;
        // Spec-controlled Permit2 refusal, matched on the canonical Permit2
        // domain name so other typed-data signing stays untouched.
        if (typed.domain?.name === 'Permit2') flags.permit2SignatureRequests += 1;
        if (flags.rejectPermit2 && typed.domain?.name === 'Permit2') {
          flags.permit2Rejections += 1;
          const err = new Error('User rejected the Permit2 signature request') as Error & { code: number };
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
          chain,
        });
      }
      default:
        // Reads forward to the node.
        return opts.rpc(method, p);
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
      // Only {code, message} crosses into the page, so a revert's DATA would
      // be lost at this boundary, and with it the app's named-refusal copy
      // (the decoders recover the selector from the message string). Walk
      // viem's cause chain for the revert bytes and append them.
      let revertData: string | undefined;
      if (typeof err.walk === 'function') {
        const hit = err.walk((x) => {
          const d = (x as { data?: unknown } | null)?.data;
          return typeof d === 'string' && d.startsWith('0x') && d.length >= 10;
        }) as { data?: string } | null;
        revertData = hit?.data;
      }
      // The text crosses into the page as the wallet's refusal, so it goes
      // through the shared formatter like every other caught value in a
      // Node-side package (#2759): viem's `shortMessage` carries no request
      // URL, the raw message may, and `details` is the node's own text.
      const base = redactSecrets(err.shortMessage ?? err.message ?? 'error');
      const details = redactSecrets((err as { details?: string }).details ?? '');
      const message = [
        base,
        details && details !== base ? details : undefined,
        revertData ? `(data: ${revertData})` : undefined,
      ]
        .filter(Boolean)
        .join(' | ');
      return { error: { code: err.code ?? -32603, message } };
    }
  });

  await ctx.addInitScript(() => {
    const w = window as unknown as {
      ethereum?: { __vaipakamTest?: boolean };
      __walletRequest: (p: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;
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
        // A real wallet announces a switch it accepted; the page's listeners
        // (wagmi) are here, the switch itself was decided in the node side.
        const req = payload as { method?: string; params?: { chainId?: string }[] };
        if (req.method === 'wallet_switchEthereumChain' && req.params?.[0]?.chainId) {
          provider.emit('chainChanged', req.params[0].chainId);
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
      emit: (ev: string, arg: unknown) => (listeners[ev] ?? []).forEach((f) => f(arg)),
    };
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    const info = {
      uuid: '7a3f4b1e-9d2c-4f6a-8e5b-000000000e2e',
      name: 'Vaipakam Test Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjMDA1NUZGIi8+PC9zdmc+',
      rdns: 'com.vaipakam.testwallet',
    };
    const announce = () =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
}

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? numberToHex(x) : x)));
}

/** Ensure the wallet is connected. wagmi AUTO-CONNECTS to the injected
 *  provider (it reports accounts without a prompt, unlike a locked
 *  MetaMask), so the Connect button often detaches mid-click. Success is
 *  therefore "the Connect button is gone"; clicks are best-effort nudges.
 *  `buttonName` is the app's own connect-control label.
 *
 *  The test wallet's own entry is WAITED for before any fallback: a picker
 *  lists a generic "MetaMask" entry (the provider sets `isMetaMask`) before
 *  the EIP-6963 announcement is drawn, and choosing it opens an install
 *  screen that holds no wallet entry at all. (`isVisible` takes no wait, so
 *  an earlier version raced exactly that.) Each retry after the first
 *  presses Escape, so a picker left on such a screen is closed and opened
 *  again. */
export async function connectWallet(page: Page, buttonName: RegExp = /^connect wallet$/i): Promise<void> {
  const btn = page.getByRole('button', { name: buttonName }).first();
  const gone = async () => !(await btn.isVisible().catch(() => false));
  const shown = (name: RegExp, timeout: number) =>
    page
      .getByRole('button', { name })
      .first()
      .waitFor({ state: 'visible', timeout })
      .then(
        () => true,
        () => false,
      );
  const deadline = Date.now() + 25_000;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    if (await gone()) return;
    if (attempt > 0) await page.keyboard.press('Escape').catch(() => {});
    await btn.click({ timeout: 2_000 }).catch(() => {});
    // Prefer the test wallet; fall back to generic entries only once it has
    // had time to appear (later attempts wait less).
    let picked: RegExp | null = (await shown(/vaipakam test wallet/i, attempt < 2 ? 5_000 : 1_000)) ? /vaipakam test wallet/i : null;
    if (!picked) {
      for (const name of [/metamask/i, /browser/i, /injected/i]) {
        if (await shown(name, 250)) {
          picked = name;
          break;
        }
      }
    }
    if (picked) await page.getByRole('button', { name: picked }).first().click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }
  if (!(await gone())) throw new Error('wallet never connected (Connect button still present)');
}

export type LaunchWallet<Role extends string> = (
  role: Role,
  opts?: { advanced?: boolean; preAuthorized?: boolean; walletChainId?: number },
) => Promise<WalletSession>;

/**
 * The `test` object a suite's specs import: `launchWallet(role)` returns an
 * independent context+page, so one test can drive multiple actors (poster +
 * acceptor, seller + buyer). Teardown fails the test on any UNCAUGHT page
 * exception; console.error output is collected for assertions but is not a
 * failure by itself (expected-failure flows legitimately log errors).
 */
export function walletTest<Role extends string>(options: WalletFixtureOptions<Role>) {
  const rpc = options.rpc ?? ((method, params) => jsonRpc(options.rpcUrl, method, params));
  const viewport = options.viewport ?? { width: 1280, height: 900 };
  return base.extend<{ launchWallet: LaunchWallet<Role> }>({
    launchWallet: async ({ browser, baseURL, viewport: projectViewport, isMobile, hasTouch }, use) => {
      const sessions: WalletSession[] = [];
      const device = options.deviceFromProject ? { viewport: projectViewport ?? viewport, isMobile, hasTouch } : { viewport };
      await use(async (role, opts = {}) => {
        const account = options.accountFor(role);
        const ctx = await browser.newContext(device);
        const flags = newWalletFlags();
        await wireWallet(ctx, account, flags, {
          chainId: options.chainId,
          walletChainId: opts.walletChainId,
          rpcUrl: options.rpcUrl,
          rpc,
          preAuthorized: opts.preAuthorized ?? true,
        });
        if (opts.advanced) {
          const entries = options.advancedModeStorage ?? { 'app.mode': 'advanced' };
          await ctx.addInitScript((seed: Record<string, string>) => {
            for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
          }, entries);
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
      const uncaught = sessions.flatMap((s) => s.consoleErrors.filter((e) => e.startsWith('PAGEERROR: ')));
      for (const s of sessions) await s.ctx.close().catch(() => {});
      if (uncaught.length > 0) {
        throw new Error(`uncaught page exception(s) during the scenario:\n${uncaught.join('\n')}`);
      }
    },
  });
}

export { expect };
