// Shared Playwright driver for the alpha02 testnet review.
//
// Launches a persistent Chromium profile per ROLE (so localStorage —
// pending markers, mode flags — survives across scenario scripts) and
// injects an EIP-1193 + EIP-6963 wallet whose signing and RPC happen
// in THIS node process via viem (the private key never enters the
// page). The site sees a normal injected browser wallet.
//
// Usage from a scenario script:
//   import { launch } from './driver.mjs';
//   const { page, ctx, done } = await launch({ role: 'lender' });
//   ...playwright steps...
//   await done();
// Sandbox egress shim (proxy CA + undici dispatcher) — optional:
// present only in environments that need it, pointed at by env.
if (process.env.LIVE_PROXY_SETUP) {
  await import(process.env.LIVE_PROXY_SETUP);
}
// Node's built-in fetch (undici under the hood) — no extra dep. The
// optional LIVE_PROXY_SETUP shim may swap the global dispatcher.
const ufetch = globalThis.fetch;
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, arbitrumSepolia } from 'viem/chains';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Dev TEST wallets only — throwaway keys holding testnet dust. The
// file lives OUTSIDE the repo on purpose (never commit keys); point
// TESTNET_WALLETS_FILE at a JSON of { <role>: { address, privateKey } }
// or an array of { role, address, privateKey }.
const WALLETS_RAW = JSON.parse(
  fs.readFileSync(
    process.env.TESTNET_WALLETS_FILE ??
      path.join(HERE, '../testnet-wallets/wallets.json'),
    'utf8',
  ),
);
// Normalize both documented shapes to a role map — the array form
// ({ role, address, privateKey }[]) indexed as a map yields
// undefined.privateKey otherwise.
const WALLETS = Array.isArray(WALLETS_RAW)
  ? Object.fromEntries(WALLETS_RAW.map((w) => [w.role ?? w.name, w]))
  : WALLETS_RAW;

export const CHAINS = {
  84532: {
    chain: baseSepolia,
    rpc: process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org',
  },
  421614: {
    chain: arbitrumSepolia,
    rpc: process.env.ARB_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc',
  },
};

export const SITE = process.env.SITE_URL ?? 'https://alpha02.vaipakam.com';

/** A real wallet rejects operations for an account it doesn't hold —
 *  mirror that so app regressions can't falsely pass a live review. */
function assertInjectedAccount(requested, account) {
  if (
    typeof requested === 'string' &&
    requested.toLowerCase() !== account.address.toLowerCase()
  ) {
    throw new Error(
      `wallet request for ${requested} but injected account is ${account.address}`,
    );
  }
}

/** Connect the injected wallet through ConnectKit if the page shows
 *  the connect state — a clean profiles/ dir must not depend on a
 *  pre-primed session (round 3). Safe to call when already
 *  connected: it no-ops if no connect button is visible. */
export async function ensureConnected(page) {
  const connect = page.getByRole('button', { name: /connect wallet/i }).first();
  if (!(await connect.isVisible().catch(() => false))) return;
  await connect.click();
  // ConnectKit lists announced EIP-6963 providers by name.
  await page.getByText('Vaipakam Test Wallet', { exact: false }).first()
    .click({ timeout: 15_000 });
  // Connected when the connect CTA leaves the header.
  await connect.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
}

export function clientsFor(chainId) {
  const { chain, rpc } = CHAINS[chainId];
  return {
    pub: createPublicClient({ chain, transport: http(rpc) }),
    wallet: (role) =>
      createWalletClient({
        chain,
        transport: http(rpc),
        account: privateKeyToAccount(WALLETS[role].privateKey),
      }),
  };
}

export function addressOf(role) {
  return WALLETS[role].address;
}

export async function launch({ role, startChainId = 84532, headless = true }) {
  const account = privateKeyToAccount(WALLETS[role].privateKey);
  let chainId = startChainId;

  const profileDir = path.join(HERE, 'profiles', role);
  fs.mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless,
    // Optional override for environments with a pre-provisioned
    // browser image (e.g. a sandbox that blocks downloads); when
    // unset, Playwright resolves its own installed Chromium.
    ...(process.env.LIVE_CHROMIUM_PATH
      ? { executablePath: process.env.LIVE_CHROMIUM_PATH }
      : {}),
    args: ['--no-sandbox'],
    viewport: { width: 1280, height: 900 },
  });

  // The egress gateway resets Chromium's own TLS handshakes, so ALL
  // page traffic is served from THIS process via undici (whose stack
  // the proxy accepts). WebSockets aren't covered — the SPA + JSON-RPC
  // don't need them.
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    try {
      const resp = await ufetch(req.url(), {
        method: req.method(),
        headers: Object.fromEntries(
          Object.entries(await req.allHeaders()).filter(
            ([k]) =>
              !k.startsWith(':') &&
              !['host', 'content-length', 'accept-encoding'].includes(
                k.toLowerCase(),
              ),
          ),
        ),
        body: req.postDataBuffer() ?? undefined,
      });
      const body = Buffer.from(await resp.arrayBuffer());
      const headers = {};
      resp.headers.forEach((v, k) => {
        if (
          !['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)
        ) {
          headers[k] = v;
        }
      });
      await route.fulfill({ status: resp.status, headers, body });
    } catch {
      await route.abort('failed');
    }
  });

  const rpcLog = [];
  async function handle({ method, params }) {
    const { chain, rpc } = CHAINS[chainId];
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const wallet = createWalletClient({ chain, transport: http(rpc), account });
    rpcLog.push(method);
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address];
      case 'eth_chainId':
        return numberToHex(chainId);
      case 'net_version':
        return String(chainId);
      case 'wallet_switchEthereumChain': {
        const wanted = Number(params[0].chainId);
        if (!CHAINS[wanted]) {
          const err = new Error('Unrecognized chain');
          err.code = 4902;
          throw err;
        }
        chainId = wanted;
        return null;
      }
      case 'wallet_requestPermissions':
      case 'wallet_revokePermissions':
        return [{ parentCapability: 'eth_accounts' }];
      case 'personal_sign': {
        // params: [hexMessage, address] — reject a request for any
        // address other than the injected account, as a real wallet
        // would; silently signing would let an app regression (stale
        // `from`) pass the live review.
        assertInjectedAccount(params[1], account);
        return account.signMessage({ message: { raw: params[0] } });
      }
      case 'eth_signTypedData_v4': {
        assertInjectedAccount(params[0], account);
        const typed = JSON.parse(params[1]);
        return account.signTypedData({
          domain: typed.domain,
          types: typed.types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
      }
      case 'eth_sendTransaction': {
        const tx = params[0];
        if (tx.from) assertInjectedAccount(tx.from, account);
        const hash = await wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });
        return hash;
      }
      default:
        // All reads forward to the chain RPC.
        return pub.request({ method, params });
    }
  }

  await ctx.exposeBinding('__walletRequest', async (_src, payload) => {
    try {
      const result = await handle(payload);
      return { result: jsonSafe(result) };
    } catch (e) {
      return {
        error: {
          code: e.code ?? -32603,
          message: e.shortMessage ?? e.message ?? 'error',
        },
      };
    }
  });

  await ctx.addInitScript(() => {
    if (window.ethereum?.__vaipakamTest) return;
    const listeners = {};
    const provider = {
      __vaipakamTest: true,
      isMetaMask: true,
      request: async (payload) => {
        const r = await window.__walletRequest(payload);
        if (r.error) {
          const err = new Error(r.error.message);
          err.code = r.error.code;
          throw err;
        }
        return r.result;
      },
      on: (ev, fn) => {
        (listeners[ev] ??= []).push(fn);
        return provider;
      },
      removeListener: (ev, fn) => {
        listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
        return provider;
      },
      emit: (ev, arg) => (listeners[ev] ?? []).forEach((f) => f(arg)),
    };
    window.ethereum = provider;
    // EIP-6963 announce so ConnectKit/wagmi discovers it reliably.
    const info = {
      uuid: '7a3f4b1e-9d2c-4f6a-8e5b-vaipakamtest0',
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

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.setDefaultTimeout(20_000);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  return {
    ctx,
    page,
    account,
    consoleErrors,
    rpcLog,
    setChain: (id) => {
      chainId = id;
    },
    shot: async (name) => {
      const dir = path.join(HERE, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
      return path.join(dir, `${name}.png`);
    },
    done: async () => {
      await ctx.close();
    },
  };
}

function jsonSafe(v) {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? numberToHex(x) : x)),
  );
}
