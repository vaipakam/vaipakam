/**
 * WATCH-ONLY live observation of the borrower position page (#1505 /
 * #1511 post-deploy review).
 *
 * Why this exists separately from `driver.mjs`: every other live driver
 * needs `TESTNET_WALLETS_FILE` because it signs. The read-side half of a
 * live review — does the deployed build render the real chain's state
 * for a real position without crashing — needs no key at all, and
 * requiring one meant that half went unrun whenever the funded-wallet
 * secret was unavailable. That is precisely the review that would have
 * caught the defect this drive was written for.
 *
 * It injects a WATCH-ONLY EIP-1193 provider over an address it does not
 * hold: account reads answer with that address, every other RPC forwards
 * to the chain, and every signing / sending method throws. There is no
 * private key in the process, so the guarantee is structural rather than
 * a flag that could be passed wrong — this drive CANNOT move funds or
 * touch state belonging to the observed address.
 *
 * What it checks, against the live Base Sepolia Diamond:
 *   1. `/positions` and each observed `/positions/<id>` render with NO
 *      uncaught error — in particular no hooks-order crash, the #1511
 *      defect (a `useCallback` below the page's early returns) that
 *      survived fourteen review rounds, typecheck, the production build
 *      and a green preview deploy because none of those can see it.
 *   2. The #1505 "Ways to repay or exit early" chooser renders on a real
 *      active loan, naming the handover and offset paths.
 *   3. Whether the #1511 listing-hold card is present, and if so which
 *      state it reports — informational, since a hold only exists while
 *      some lender actually has a sale listing standing.
 *
 * Page traffic is served from THIS process via node fetch, the same shim
 * `driver.mjs` uses: the sandbox egress gateway resets Chromium's own
 * TLS handshakes.
 *
 * Usage (no secrets needed):
 *
 *   node live-position-observe.mjs                  # auto-discovers a borrower
 *   OBSERVE_ADDRESS=0x… node live-position-observe.mjs
 *   SITE_URL=https://<preview>.workers.dev node live-position-observe.mjs
 *
 * Exits non-zero if any observed route crashes or the chooser is missing
 * from an active loan, so a batch run cannot report a regression green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createPublicClient, http, numberToHex } from 'viem';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The SAME contracts source the app ships with, read from disk exactly
// as live-signed-book.mjs / live-rate-desk.mjs do, so this driver cannot
// drift from the app's own address/ABI source. (Reading the files beats
// importing the package here: the barrel is TS re-exporting JSON, which
// plain node refuses without import attributes.)
const CONTRACTS_SRC = path.resolve(HERE, '../../../../packages/contracts/src');

function loadDiamondAbi() {
  const dir = path.join(CONTRACTS_SRC, 'abis');
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (Array.isArray(parsed)) out.push(...parsed);
  }
  return out;
}

const SITE = process.env.SITE_URL ?? 'https://alpha02.vaipakam.com';
const CHAIN_ID = Number(process.env.OBSERVE_CHAIN_ID ?? 84532);
const RPC = process.env.OBSERVE_RPC ?? 'https://sepolia.base.org';
const MAX_POSITIONS = Number(process.env.OBSERVE_MAX_POSITIONS ?? 3);

const deployment = JSON.parse(
  fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
)[String(CHAIN_ID)];
if (!deployment) throw new Error(`no deployment for chain ${CHAIN_ID}`);
const DIAMOND = deployment.diamond;
const DIAMOND_ABI_VIEM = loadDiamondAbi();

/** Signing/sending is not merely denied — there is no key. These are
 *  named so an attempt is reported loudly rather than silently erroring
 *  somewhere inside the app. */
const FORBIDDEN = new Set([
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
]);

const pub = createPublicClient({ transport: http(RPC) });

// ---------------------------------------------------------------- chain
console.log(`site      ${SITE}`);
console.log(`chain     ${CHAIN_ID} via ${RPC}`);
console.log(`diamond   ${DIAMOND}`);

const activeCount = await pub.readContract({
  address: DIAMOND,
  abi: DIAMOND_ABI_VIEM,
  functionName: 'getActiveLoansCount',
});
console.log(`active    ${activeCount} loan(s) on chain`);
if (activeCount === 0n) {
  console.log('\nNo active loans on chain — nothing to observe. Not a failure.');
  process.exit(0);
}

const ids = await pub.readContract({
  address: DIAMOND,
  abi: DIAMOND_ABI_VIEM,
  functionName: 'getActiveLoansPaginated',
  args: [0n, activeCount > 25n ? 25n : activeCount],
});

const loans = [];
for (const id of ids) {
  const d = await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [id],
  });
  loans.push({ id, borrower: d.borrower, lender: d.lender, status: Number(d.status) });
}

// The observed address: whichever borrower holds the most active loans,
// so one session covers as many position pages as possible.
let observed = process.env.OBSERVE_ADDRESS;
if (!observed) {
  const byBorrower = new Map();
  for (const l of loans) {
    const k = l.borrower.toLowerCase();
    byBorrower.set(k, [...(byBorrower.get(k) ?? []), l]);
  }
  const [best] = [...byBorrower.entries()].sort((a, b) => b[1].length - a[1].length);
  observed = best[1][0].borrower;
}
const mine = loans.filter((l) => l.borrower.toLowerCase() === observed.toLowerCase());
console.log(`observing ${observed} (watch-only, no key) — ${mine.length} active loan(s) as borrower`);
if (mine.length === 0) {
  console.error(`\nFAIL: ${observed} holds no active loans as borrower — nothing to observe.`);
  process.exit(1);
}

// -------------------------------------------------------------- browser
const browser = await chromium.launch({
  headless: process.env.OBSERVE_HEADED !== '1',
  args: ['--no-sandbox'],
  ...(process.env.LIVE_CHROMIUM_PATH ? { executablePath: process.env.LIVE_CHROMIUM_PATH } : {}),
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

const signAttempts = [];
const blockedHttp = [];

// Page traffic through this process (Chromium TLS is reset by the
// sandbox gateway). Mutating non-RPC requests are refused: this drive
// advertises itself as read-only and a page regression must not be able
// to POST to a backend while we scrape.
await ctx.route('**/*', async (route) => {
  const req = route.request();
  const method = req.method().toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    let readShaped = false;
    const body = req.postData();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        readShaped =
          calls.every((c) => c && typeof c.jsonrpc === 'string') &&
          !calls.some((c) => FORBIDDEN.has(c.method));
      } catch {
        /* not JSON — refuse */
      }
    }
    if (!readShaped) {
      blockedHttp.push(`${method} ${req.url().slice(0, 140)}`);
      await route.abort('accessdenied').catch(() => {});
      return;
    }
  }
  try {
    const resp = await fetch(req.url(), {
      method: req.method(),
      headers: Object.fromEntries(
        Object.entries(await req.allHeaders()).filter(
          ([k]) =>
            !k.startsWith(':') &&
            !['host', 'content-length', 'accept-encoding'].includes(k.toLowerCase()),
        ),
      ),
      body: req.postDataBuffer() ?? undefined,
      redirect: 'follow',
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)) {
        headers[k] = v;
      }
    });
    await route.fulfill({ status: resp.status, headers, body: buf });
  } catch {
    await route.abort('failed').catch(() => {});
  }
});

await ctx.exposeBinding('__watchRequest', async (_src, { method, params = [] }) => {
  try {
    if (FORBIDDEN.has(method)) {
      signAttempts.push(method);
      // 4100 "unauthorized" is what a watch-only account produces —
      // not 4001, which would read as the user simply declining.
      return { error: { code: 4100, message: `watch-only session: ${method} unavailable` } };
    }
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { result: [observed] };
      case 'eth_chainId':
        return { result: numberToHex(CHAIN_ID) };
      case 'net_version':
        return { result: String(CHAIN_ID) };
      case 'wallet_switchEthereumChain':
        // Single-chain session: accept the chain we are on, refuse others
        // rather than pretend to switch.
        if (Number(params[0].chainId) === CHAIN_ID) return { result: null };
        return { error: { code: 4902, message: 'watch-only session: single chain' } };
      case 'wallet_requestPermissions':
        return { result: [{ parentCapability: 'eth_accounts' }] };
      default: {
        const result = await pub.request({ method, params });
        return { result: result === undefined ? null : result };
      }
    }
  } catch (e) {
    return { error: { code: e.code ?? -32603, message: e.shortMessage ?? e.message ?? 'error' } };
  }
});

await ctx.addInitScript(() => {
  if (window.ethereum?.__vaipakamWatch) return;
  const listeners = {};
  const provider = {
    __vaipakamWatch: true,
    isMetaMask: true,
    request: async (payload) => {
      const r = await window.__watchRequest(payload);
      if (r.error) {
        const err = new Error(r.error.message);
        err.code = r.error.code;
        throw err;
      }
      return r.result;
    },
    on: (ev, fn) => ((listeners[ev] ??= []).push(fn), provider),
    removeListener: (ev, fn) => ((listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn)), provider),
    emit: (ev, arg) => (listeners[ev] ?? []).forEach((f) => f(arg)),
  };
  window.ethereum = provider;
  const info = {
    uuid: '7a3f4b1e-9d2c-4f6a-8e5b-vaipakamwatch0',
    name: 'Vaipakam Watch-Only',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjNzc3Ii8+PC9zdmc+',
    rdns: 'com.vaipakam.watchonly',
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
    );
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
});

/** Load a route and report everything that went wrong on it. */
async function visit(path) {
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).replace(/\s+/g, ' ').slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
  });
  let http = null;
  try {
    const resp = await page.goto(SITE + path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    http = resp?.status() ?? null;
    // The chain reads behind this page are real RPC round-trips.
    await page.waitForTimeout(9_000);
  } catch (e) {
    await page.close();
    return { path, nav: String(e).replace(/\s+/g, ' ').slice(0, 180), pageErrors, consoleErrors };
  }
  const text = await page.evaluate(() => document.body.innerText);
  const hooks = pageErrors.some((e) =>
    /Rendered (more|fewer) hooks|Rules of Hooks|change in the order of Hooks/i.test(e),
  );
  const holdCard = await page.getByTestId('sale-listing-hold-card').count();
  const freeHeld = await page.getByTestId('free-held-options').count();
  const out = {
    path,
    http,
    pageErrors,
    consoleErrors,
    hooks,
    text,
    chooser: /Ways to repay or exit early/i.test(text),
    handover: /hand the loan to another borrower/i.test(text),
    offset: /exit by becoming a lender/i.test(text),
    holdCard: holdCard > 0,
    freeHeld: freeHeld > 0,
    connected: !/Connect wallet/i.test(text.slice(0, 400)),
  };
  await page.close();
  return out;
}

// ---------------------------------------------------------------- drive
const visited = [];
visited.push(await visit('/positions'));
for (const l of mine.slice(0, MAX_POSITIONS)) visited.push(await visit(`/positions/${l.id}`));
await browser.close();

// --------------------------------------------------------------- report
let failures = 0;
console.log('');
for (const v of visited) {
  const detail = /^\/positions\/\d+$/.test(v.path);
  const problems = [];
  if (v.nav) problems.push(`nav: ${v.nav}`);
  if (v.hooks) problems.push('HOOKS-ORDER CRASH');
  if (v.pageErrors?.length) problems.push(`${v.pageErrors.length} uncaught error(s)`);
  // A position DETAIL page for an ACTIVE loan must show the chooser —
  // its absence is the regression this drive exists to catch.
  if (detail && !v.nav && !v.chooser) problems.push('chooser MISSING on an active loan');

  const verdict = problems.length ? 'FAIL' : 'ok';
  if (problems.length) failures++;
  console.log(`${verdict.padEnd(5)} ${v.path.padEnd(16)} http=${v.http ?? '-'} connected=${v.connected ?? '-'}`);
  if (detail && !v.nav) {
    console.log(
      `      chooser=${v.chooser} handover=${v.handover} offset=${v.offset}` +
        ` holdCard=${v.holdCard} freeHeldBtn=${v.freeHeld}`,
    );
  }
  problems.forEach((p) => console.log(`      ! ${p}`));
  (v.pageErrors ?? []).forEach((e) => console.log(`      E ${e}`));
  // Console noise is reported but never fails the drive: production CSP
  // refuses the analytics beacon, and the sandbox proxy resets page
  // WebSockets. Neither is an app defect.
  (v.consoleErrors ?? []).slice(0, 4).forEach((e) => console.log(`      c ${e}`));
}

if (signAttempts.length) {
  console.log(`\nsigning attempts refused (watch-only): ${[...new Set(signAttempts)].join(', ')}`);
}
if (blockedHttp.length) {
  console.log(`\nmutating HTTP refused: ${blockedHttp.length}`);
  blockedHttp.slice(0, 6).forEach((b) => console.log(`  ${b}`));
}

const holds = visited.filter((v) => v.holdCard);
console.log(
  `\nlisting-hold card observed on ${holds.length} of ${visited.filter((v) => /\d$/.test(v.path)).length} position page(s)` +
    (holds.length ? '' : ' — no lender sale listing standing right now, so the hold state is not reachable to observe'),
);

console.log(`\n${visited.length - failures}/${visited.length} routes clean`);
process.exit(failures ? 1 : 0);
