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
 *   LIVE_PROXY_SETUP=./my-egress-shim.mjs node live-position-observe.mjs
 *
 * Exit codes — a batch run must never read a drive that verified nothing
 * as a pass:
 *   0  observed and clean
 *   1  a REGRESSION, judged against a page we actually observed: a route
 *      crashed or returned non-2xx, the chooser (or one of its two new
 *      paths) is missing from an eligible loan, or the PAGE tried to sign
 *      / send / POST something a read-only surface should never ask for
 *   2  BLOCKED — could not observe, or could not trust what it observed.
 *      No eligible loans; the requested address holds none; a discovery
 *      or setup step failed (unreachable RPC, browser launch); every
 *      candidate's chain state moved before it could be visited; a
 *      misconfigured OBSERVE_MAX_POSITIONS would assert nothing; or our
 *      own allowlist refused a read the app needed, which may have left a
 *      degraded page. Nothing trustworthy was verified, so this is
 *      deliberately not 0: `run-live-batch.mjs` would otherwise print
 *      PASS for a drive that made no trustworthy assertions at all.
 *
 * The 1-vs-2 line is the important one: exit 1 must always mean "the app
 * did something wrong", never "the harness could not look properly".
 */
// Sandbox egress shim (proxy CA + undici dispatcher) — optional, and the
// SAME knob `driver.mjs` and `live-desk-i18n-capture.mjs` honour. Without
// it this drive documented a setting it never read, so in a sandbox whose
// gateway resets TLS every routed page request and every viem read failed
// with no indication the shim had been ignored (#1529 review round 11).
if (process.env.LIVE_PROXY_SETUP) {
  await import(process.env.LIVE_PROXY_SETUP);
}
// Capture AFTER the shim, exactly as driver.mjs does: node's built-in
// fetch is what both the page-route pump and viem's http transport ride.
const ufetch = globalThis.fetch;
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
// A limit of 0 (or a typo) would visit no detail route at all: the
// `/positions` list can pass on its own, and the run would exit 0 having
// asserted nothing about the chooser — the exact no-verification-passes
// outcome the exit contract exists to prevent (#1529 review round 7).
const MAX_POSITIONS_RAW = process.env.OBSERVE_MAX_POSITIONS ?? '3';
const MAX_POSITIONS = Number(MAX_POSITIONS_RAW);
if (!Number.isInteger(MAX_POSITIONS) || MAX_POSITIONS < 1) {
  console.error(
    `\nBLOCKED: OBSERVE_MAX_POSITIONS must be a positive integer,` +
      ` got "${MAX_POSITIONS_RAW}". A limit below 1 would assert nothing.`,
  );
  process.exit(2);
}

// A mistyped OBSERVE_CHAIN_ID, or one this repo has no deployment for,
// is a SETUP precondition — the same category as an absent wallet file
// or an unreachable RPC. Throwing here exits 1, and the batch runner
// then prints a product FAIL for a configuration mistake that stopped
// the drive from observing anything at all, which is exactly the
// mislabelling the three-verdict contract exists to prevent (#1529
// review round 12).
let deployment;
try {
  deployment = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
  )[String(CHAIN_ID)];
} catch (err) {
  console.error(
    `\nBLOCKED: cannot read the deployments artifact.\n  ${err.message}`,
  );
  process.exit(2);
}
if (!deployment?.diamond) {
  const known = JSON.parse(
    fs.readFileSync(path.join(CONTRACTS_SRC, 'deployments.json'), 'utf8'),
  );
  console.error(
    `\nBLOCKED: no deployment for chain ${CHAIN_ID} in deployments.json.` +
      `\n  known chains: ${Object.keys(known).join(', ')}` +
      `\n  → set OBSERVE_CHAIN_ID to one of those, or re-export` +
      ` deployments (contracts/script/exportFrontendDeployments.sh).`,
  );
  process.exit(2);
}
const DIAMOND = deployment.diamond;
const DIAMOND_ABI_VIEM = loadDiamondAbi();

/**
 * ALLOWLIST, deliberately — not a list of banned writes.
 *
 * A denylist cannot carry a safety property: it has to enumerate every
 * way to send, and the set keeps growing (`wallet_sendCalls`,
 * `eth_sendUserOperation`, provider-specific sends, app-specific JSON-RPC
 * mutations). One that is merely forgotten is forwarded (#1529 review).
 * So this names the read and connection methods the drive actually needs
 * and refuses everything else, which makes an omission a false REFUSAL —
 * visible in the report and easy to fix — rather than a silent send.
 *
 * Every refusal is recorded, printed AND ends the run non-zero. Printing
 * alone was not enough: the app can catch a refused read and render a
 * degraded page that still contains the chooser, so the drive would have
 * reported clean while observing something less than the real surface
 * (#1529 review round 5). See the exit-code contract at the top.
 */
const ALLOWED_RPC = new Set([
  // Reads. eth_call and eth_estimateGas change no state.
  'eth_accounts',
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'net_version',
  'web3_clientVersion',
  // Subscriptions (WebSocket reads).
  'eth_subscribe',
  'eth_unsubscribe',
  // Connection handshake — answered locally, never forwarded.
  'eth_requestAccounts',
  'wallet_getPermissions',
  'wallet_requestPermissions',
  'wallet_switchEthereumChain',
]);

/** Severity classification ONLY — never a permission decision. What is
 *  permitted is decided solely by ALLOWED_RPC, so a write method nobody
 *  anticipated is still refused; it would merely be reported as an
 *  allowlist gap rather than a violation. */
const WRITE_SHAPED = /^(eth_send|eth_sign|personal_sign|wallet_send)/;

const pub = createPublicClient({ transport: http(RPC) });

// ---------------------------------------------------------------- chain
console.log(`site      ${SITE}`);
console.log(`chain     ${CHAIN_ID} via ${RPC}`);
console.log(`diamond   ${DIAMOND}`);

/**
 * Discovery and setup failures are BLOCKED, never FAIL.
 *
 * Exit 1 is reserved for assertions against pages we successfully
 * observed. An unreachable or flaky RPC during discovery means we never
 * got as far as observing anything — but an uncaught top-level rejection
 * exits 1 regardless, so the batch would report a product regression for
 * a network blip (#1529 review round 7).
 */
async function discovery(what, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `\nBLOCKED: ${what} failed, so nothing could be observed.` +
        `\n  ${String(err).split('\n')[0].slice(0, 200)}`,
    );
    process.exit(2);
  }
}

// One height for the whole discovery walk — see the pagination note.
const snapshotBlock = await discovery('reading the chain head', () =>
  pub.getBlockNumber(),
);
const activeCount = await discovery('reading the active-loan count', () =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getActiveLoansCount',
    blockNumber: snapshotBlock,
  }),
);
console.log(`active    ${activeCount} loan(s) on chain`);
if (activeCount === 0n) {
  console.log('\nBLOCKED: no active loans on chain — nothing to observe, nothing verified.');
  process.exit(2);
}

// Walk the WHOLE set, a page at a time. The underlying list is a
// swap-and-pop array, so it is not ordered by eligibility — a first-page
// cap would miss the only eligible loan (or the requested address's) on a
// busy chain and then report BLOCKED, claiming none exists (#1529 review).
// PINNED to one block. The list is swap-and-pop, so a loan settling
// between page reads moves the former LAST id down into an offset already
// fetched — and the walk, continuing from the next offset against a stale
// count, never sees it. If that moved loan was the only eligible one the
// drive would report BLOCKED with an observable position still on chain
// (#1529 review round 9). Reading every page at a fixed height makes the
// walk a consistent snapshot instead of a moving target.
const PAGE = 25n;
const ids = [];
for (let offset = 0n; offset < activeCount; offset += PAGE) {
  const remaining = activeCount - offset;
  const page = await discovery(`reading active loans from offset ${offset}`, () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getActiveLoansPaginated',
      args: [offset, remaining < PAGE ? remaining : PAGE],
      blockNumber: snapshotBlock,
    }),
  );
  if (page.length === 0) break;
  ids.push(...page);
}
console.log(`fetched   ${ids.length} loan id(s) across ${Math.ceil(Number(activeCount) / 25)} page(s)`);

// LoanStatus.Active — `getActiveLoansPaginated` also returns
// FallbackPending (4), and AssetType.ERC20 — an NFT-rental row is not a
// lending position. The chooser renders for neither, so a candidate that
// is either would be a FALSE "chooser MISSING" rather than a finding
// (#1529 review).
const STATUS_ACTIVE = 0;
const ASSET_ERC20 = 0;
/** LibERC721.LockReason.PrecloseOffset — mirrors data/offsetPending.ts. */
const LOCK_PRECLOSE_OFFSET = 1;

/**
 * The chooser's render gate has FOUR conditions, not two
 * (`PositionDetails.tsx`): active, not a rental, no live preclose-offset
 * lock, and grace not verifiably over. The last two are just as capable
 * of hiding it CORRECTLY, so a drive that checks only the first two calls
 * valid deployed behaviour a regression (#1529 review round 6).
 *
 * Both follow the app's own reads: the offset lock from
 * `positionLock(borrowerTokenId)`, the grace deadline from
 * `getGraceBuckets` matched on the loan's duration and falling back to
 * the compile-time schedule when the chain publishes no buckets.
 *
 * That fallback is load-bearing, not defensive: Base Sepolia publishes
 * an EMPTY bucket set today. A first draft returned zero grace there,
 * which made every matured loan read as past-grace and skipped all eight
 * loans on the chain — the drive reported BLOCKED while the pages it
 * would have checked were rendering perfectly well. Mirror the app's
 * `readGraceSecondsLive` branch for branch; do not simplify it.
 */
/** Mirrors `lib/grace.defaultGraceSeconds`, which in turn mirrors
 *  LibVaipakam.gracePeriod's compile-time schedule. Used when the chain
 *  publishes NO buckets — which is the case on Base Sepolia today, so
 *  this is the live path, not a corner. Treating an empty set as zero
 *  grace makes every matured loan look past-grace the instant it
 *  matures, which is how a first draft of this drive managed to skip
 *  every loan on the chain. */
function defaultGraceSeconds(durationDays) {
  if (durationDays < 7n) return 3_600n;
  if (durationDays < 30n) return 86_400n;
  if (durationDays < 90n) return 3n * 86_400n;
  if (durationDays < 180n) return 7n * 86_400n;
  if (durationDays < 365n) return 14n * 86_400n;
  return 30n * 86_400n;
}

let graceBucketsCache;
async function graceSecondsFor(durationDays) {
  graceBucketsCache ??= await discovery('reading the grace buckets', () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getGraceBuckets',
    }),
  );
  const buckets = graceBucketsCache;
  if (buckets.length > 0) {
    for (const b of buckets) {
      if (b.maxDurationDays === 0n) return b.graceSeconds; // catch-all
      if (durationDays < b.maxDurationDays) return b.graceSeconds;
    }
    // Malformed set — the contract falls back to the last entry.
    return buckets[buckets.length - 1].graceSeconds;
  }
  return defaultGraceSeconds(durationDays);
}

async function offsetLockedOn(borrowerTokenId) {
  try {
    const lock = await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'positionLock',
      args: [borrowerTokenId],
    });
    return Number(lock) === LOCK_PRECLOSE_OFFSET;
  } catch {
    // Unreadable — assume locked and skip the loan. Skipping costs one
    // observation; a false regression costs trust in the whole drive.
    return true;
  }
}

/**
 * Who may act on the borrower side. NOT `loan.borrower`: role and action
 * authority travel with the borrower POSITION NFT, and `PositionDetails`
 * decides the role from `ownerOf(borrowerTokenId)` — so once a position
 * has been transferred, the stored address is history and the page
 * correctly classifies it as a viewer. Grouping by the stored address
 * would inject exactly such a wallet and then report the resulting
 * absent chooser as a regression (#1529 review).
 *
 * Falls back to the stored address only when the token read reverts —
 * i.e. the token is gone — which the eligibility filter then drops
 * anyway.
 */
async function borrowerAuthorityOf(loan) {
  try {
    return await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'ownerOf',
      args: [loan.borrowerTokenId],
    });
  } catch {
    return null;
  }
}

// Chain time, not the local clock — the grace comparison the app makes is
// chain-anchored, and a skewed sandbox clock would misclassify loans near
// the boundary.
const chainNow = await discovery('reading chain time', () =>
  pub.getBlock({ blockTag: 'latest' }).then((b) => b.timestamp),
);

const loans = [];
for (const id of ids) {
  const d = await discovery(`reading loan ${id}`, () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getLoanDetails',
      args: [id],
    }),
  );
  const loan = {
    id,
    borrower: d.borrower,
    lender: d.lender,
    status: Number(d.status),
    assetType: Number(d.assetType),
    borrowerTokenId: d.borrowerTokenId,
    startTime: d.startTime,
    durationDays: d.durationDays,
  };
  loan.authority = await borrowerAuthorityOf(loan);
  // Only worth the extra reads on loans that clear the cheap gates.
  if (loan.status === STATUS_ACTIVE && loan.assetType === ASSET_ERC20 && loan.authority) {
    loan.offsetLocked = await offsetLockedOn(loan.borrowerTokenId);
    const grace = await graceSecondsFor(loan.durationDays);
    const graceDeadline = loan.startTime + loan.durationDays * 86_400n + grace;
    loan.graceOver = chainNow > graceDeadline;
  }
  loans.push(loan);
}

/** Exactly the predicate `PositionDetails` gates the chooser on. */
const eligible = loans.filter(
  (l) =>
    l.status === STATUS_ACTIVE &&
    l.assetType === ASSET_ERC20 &&
    l.authority !== null &&
    l.offsetLocked === false &&
    l.graceOver === false,
);
const dropped = loans.length - eligible.length;
if (dropped > 0) {
  // Never silently narrow the candidate set — say what was set aside, and
  // why, so a shrinking pool is legible rather than mysterious.
  const why = (l) =>
    l.status !== STATUS_ACTIVE
      ? 'not active'
      : l.assetType !== ASSET_ERC20
        ? 'NFT rental'
        : l.authority === null
          ? 'borrower token burned'
          : l.offsetLocked
            ? 'offset in progress'
            : 'past grace';
  console.log(
    `skipping  ${dropped} loan(s) the chooser does not render for: ` +
      loans
        .filter((l) => !eligible.includes(l))
        .map((l) => `${l.id} (${why(l)})`)
        .join(', '),
  );
}

// The observed address: whichever borrower-side authority holds the most
// eligible loans, so one session covers as many position pages as
// possible.
let observed = process.env.OBSERVE_ADDRESS;
if (!observed) {
  const byAuthority = new Map();
  for (const l of eligible) {
    const k = l.authority.toLowerCase();
    byAuthority.set(k, [...(byAuthority.get(k) ?? []), l]);
  }
  const [best] = [...byAuthority.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!best) {
    console.log('\nBLOCKED: no chooser-eligible loans on chain — nothing verified.');
    process.exit(2);
  }
  observed = best[1][0].authority;
}
const mine = eligible.filter((l) => l.authority.toLowerCase() === observed.toLowerCase());
console.log(
  `observing ${observed} (watch-only, no key) — ${mine.length} eligible loan(s) as borrower`,
);
for (const l of mine) {
  const moved = l.authority.toLowerCase() !== l.borrower.toLowerCase();
  console.log(`  loan ${l.id}${moved ? ` (position transferred from ${l.borrower})` : ''}`);
}
if (mine.length === 0) {
  console.error(
    `\nBLOCKED: ${observed} holds no chooser-eligible borrower position — nothing verified.`,
  );
  process.exit(2);
}

// -------------------------------------------------------------- browser
const browser = await discovery('launching the browser', () =>
  chromium.launch({
    headless: process.env.OBSERVE_HEADED !== '1',
    args: ['--no-sandbox'],
    ...(process.env.LIVE_CHROMIUM_PATH ? { executablePath: process.env.LIVE_CHROMIUM_PATH } : {}),
  }),
);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

/** Every refusal, with why — a too-narrow allowlist must be visible. */
const refusedRpc = [];
const blockedHttp = [];

// Page traffic through this process (Chromium TLS is reset by the
// sandbox gateway). Mutating non-RPC requests are refused: this drive
// advertises itself as read-only and a page regression must not be able
// to POST to a backend while we scrape.
await ctx.route('**/*', async (route) => {
  const req = route.request();
  const method = req.method().toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    // Default-deny: a mutating request rides through only when it is
    // JSON-RPC whose EVERY method is on the allowlist. Anything else —
    // a non-RPC POST, or RPC naming a method we did not sanction — is
    // refused and named.
    let why = `${method} (non-RPC mutating request)`;
    let badMethod = null;
    let allowed = false;
    const body = req.postData();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        if (calls.every((c) => c && typeof c.jsonrpc === 'string')) {
          const bad = calls.find((c) => !ALLOWED_RPC.has(c.method));
          allowed = bad === undefined;
          if (bad) {
            badMethod = bad.method;
            why = `json-rpc ${bad.method} (not allowlisted)`;
          }
        }
      } catch {
        /* not JSON — refuse with the default reason */
      }
    }
    if (!allowed) {
      // Keep the METHOD, not just a sentence: the exit-code decision
      // below applies the same write-vs-allowlist-gap split the injected
      // provider uses. Labelling every refused POST a mutation reported a
      // harness omission (e.g. an unlisted `eth_getProof`) as a product
      // FAIL (#1529 review round 7).
      blockedHttp.push({ why, method: badMethod, url: req.url().slice(0, 120) });
      await route.abort('accessdenied').catch(() => {});
      return;
    }
  }
  try {
    const resp = await ufetch(req.url(), {
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
    if (!ALLOWED_RPC.has(method)) {
      refusedRpc.push(method);
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

/**
 * Load a route and report everything that went wrong on it.
 *
 * `expectChooser` makes the settle CONDITIONAL rather than a fixed sleep.
 * A fixed wait is wrong in both directions against a live chain: too
 * short and a slow RPC round-trip reads as "the chooser is missing",
 * failing the drive for a defect that isn't there; too long and every
 * run pays for the worst case. Waiting for the thing being asserted
 * resolves as soon as it appears, and only spends the full timeout in
 * the case where the answer is genuinely negative — where spending it is
 * exactly right, because that is the claim the drive would be making.
 */
async function visit(path, { expectChooser = false } = {}) {
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
    if (expectChooser) {
      // The chain reads behind this page are real RPC round-trips, so
      // wait for the assertion's own subject. A timeout here is NOT an
      // error to propagate — absence is a legitimate observation, and
      // the reporting below is what decides whether it is a failure.
      await page
        .locator('section.card')
        .filter({ hasText: /Ways to repay or exit early/i })
        .first()
        .waitFor({ state: 'visible', timeout: 45_000 })
        .catch(() => {});
    }
    // Short settle regardless: lets the cards below the chooser (the
    // hold card among them) finish their own reads before we scrape.
    await page.waitForTimeout(4_000);
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

/**
 * Discovery happens up front, but each detail page can take the better
 * part of a minute — so by the time a candidate is visited, minutes may
 * have passed. In that window a loan can gain an offset lock, cross its
 * grace deadline, or have its borrower NFT transferred, and the page will
 * correctly evaluate the NEWER state and hide the chooser while this
 * drive still holds a stale candidate. Reporting that as a regression
 * would be a race in the harness, not a defect in the app (#1529 review
 * round 7).
 *
 * So the volatile gates are re-read immediately before each visit. A
 * candidate that has changed is SKIPPED, not failed — nothing was
 * observed about it either way.
 */
async function stillEligible(loan) {
  // These reads are as much "could not inspect" as the discovery ones, so
  // they go through the same wrapper: an RPC failure here must not escape
  // and exit 1 as a product regression (#1529 review round 8).
  const [lockedNow, authorityNow, now, live] = await discovery(
    `re-reading loan ${loan.id} before visiting it`,
    () =>
      Promise.all([
        offsetLockedOn(loan.borrowerTokenId),
        borrowerAuthorityOf(loan),
        pub.getBlock({ blockTag: 'latest' }).then((b) => b.timestamp),
        pub.readContract({
          address: DIAMOND,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getLoanDetails',
          args: [loan.id],
        }),
      ]),
  );
  // STATUS too, not just the volatile gates: a loan repaid, liquidated or
  // defaulted between discovery and the visit correctly loses its
  // chooser, and the minutes-old status would call that a regression.
  if (Number(live.status) !== STATUS_ACTIVE) return 'no longer active';
  if (lockedNow) return 'offset started since discovery';
  if (authorityNow === null) return 'borrower token burned since discovery';
  if (authorityNow.toLowerCase() !== observed.toLowerCase()) {
    return 'position transferred since discovery';
  }
  // The LIVE term, not the discovered one. `extendLoanInPlace` rewrites
  // startTime and durationDays while the loan stays Active, so a stale
  // term would judge an extended loan against its old deadline and skip a
  // page that is correctly still chooser-eligible — and, if it was the
  // only candidate, report BLOCKED (#1529 review round 10). The grace
  // bucket follows the live duration too, since the bucket is chosen BY
  // duration.
  const grace = await graceSecondsFor(live.durationDays);
  if (now > live.startTime + live.durationDays * 86_400n + grace) {
    return 'crossed its grace deadline since discovery';
  }
  return null;
}

// ---------------------------------------------------------------- drive
const visited = [];
const racedOut = [];
visited.push(await visit('/positions'));
// Walk candidates until MAX_POSITIONS pages have actually been OBSERVED,
// not merely attempted. A pre-slice let a raced-out candidate consume the
// quota, so the drive silently verified fewer pages than asked for — and
// if every sliced row raced out it reported BLOCKED while eligible
// candidates sat untried behind the slice (#1529 review round 9).
let observedDetails = 0;
for (const l of mine) {
  if (observedDetails >= MAX_POSITIONS) break;
  const changed = await stillEligible(l);
  if (changed) {
    racedOut.push(`${l.id} (${changed})`);
    continue;
  }
  visited.push(await visit(`/positions/${l.id}`, { expectChooser: true }));
  observedDetails += 1;
}
await browser.close();

if (racedOut.length) {
  console.log(
    `\nskipped mid-run, chain state moved: ${racedOut.join(', ')}` +
      `\n  → not a failure; nothing was observed about these.`,
  );
}

// --------------------------------------------------------------- report
let failures = 0;
console.log('');
for (const v of visited) {
  const detail = /^\/positions\/\d+$/.test(v.path);
  const problems = [];
  if (v.nav) problems.push(`nav: ${v.nav}`);
  // A 404/500 does not throw and does not fire `pageerror`: page.goto
  // resolves and the status is merely recorded. Unchecked, a route that
  // never loaded counted toward "routes clean" (#1529 review).
  if (!v.nav && (v.http === null || v.http === undefined || v.http < 200 || v.http >= 300)) {
    problems.push(`navigation returned ${v.http ?? 'no response'}`);
  }
  if (v.hooks) problems.push('HOOKS-ORDER CRASH');
  if (v.pageErrors?.length) problems.push(`${v.pageErrors.length} uncaught error(s)`);
  // A position DETAIL page for an eligible loan must show the chooser
  // AND both newly-exposed paths. Printing handover/offset without
  // failing on them let the drive pass while missing one of the two
  // #1505 surfaces it claims to validate (#1529 review).
  if (detail && !v.nav) {
    if (!v.chooser) problems.push('chooser MISSING on an eligible loan');
    else {
      if (!v.handover) problems.push('handover path MISSING from the chooser');
      if (!v.offset) problems.push('offset path MISSING from the chooser');
    }
  }

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

// A refusal is never just informational. Printing it while the exit code
// says PASS is precisely the silent-pass shape the BLOCKED verdict exists
// to prevent: the app can catch a refused read, render a degraded page
// that still happens to contain the chooser, and the drive would report
// clean (#1529 review round 5). Zero refusals is the established
// expectation from a real run, so any refusal at all ends the run
// non-zero — as a REGRESSION when the page tried to mutate, and as
// BLOCKED when it is our own allowlist that is too narrow, because those
// have different remedies.
const pageTriedToWrite = [...new Set(refusedRpc)].filter((m) => WRITE_SHAPED.test(m));
const allowlistTooNarrow = [...new Set(refusedRpc)].filter((m) => !WRITE_SHAPED.test(m));

if (pageTriedToWrite.length) {
  console.log(
    `\nREAD-ONLY VIOLATION — the page asked to sign or send:` +
      ` ${pageTriedToWrite.join(', ')}` +
      `\n  → refused, so nothing was sent, but a read-only surface should` +
      ` never have asked. This is a finding, not a harness gap.`,
  );
}
if (allowlistTooNarrow.length) {
  console.log(
    `\nALLOWLIST TOO NARROW — refused non-write method(s):` +
      ` ${allowlistTooNarrow.join(', ')}` +
      `\n  → the page may have rendered with less than it asked for, so` +
      ` this run's observations are not trustworthy. Add these to` +
      ` ALLOWED_RPC and re-run.`,
  );
}
// Same split as the provider path: a refused WRITE is a finding about the
// page; a refused non-write is our allowlist being too narrow.
const httpWrites = blockedHttp.filter((b) => b.method === null || WRITE_SHAPED.test(b.method));
const httpGaps = blockedHttp.filter((b) => b.method !== null && !WRITE_SHAPED.test(b.method));
if (httpWrites.length) {
  console.log(`\nREAD-ONLY VIOLATION — mutating HTTP refused: ${httpWrites.length}`);
  httpWrites.slice(0, 8).forEach((b) => console.log(`  ${b.why} → ${b.url}`));
}
if (httpGaps.length) {
  console.log(
    `\nALLOWLIST TOO NARROW — refused non-write RPC over HTTP:` +
      ` ${[...new Set(httpGaps.map((b) => b.method))].join(', ')}` +
      `\n  → the page may have rendered with less than it asked for.` +
      ` Add these to ALLOWED_RPC and re-run.`,
  );
}

const holds = visited.filter((v) => v.holdCard);
console.log(
  `\nlisting-hold card observed on ${holds.length} of ${visited.filter((v) => /\d$/.test(v.path)).length} position page(s)` +
    (holds.length ? '' : ' — no lender sale listing standing right now, so the hold state is not reachable to observe'),
);

console.log(`\n${visited.length - failures}/${visited.length} routes clean`);

// A page-initiated write attempt is a regression in the app; a
// too-narrow allowlist means this run simply cannot be trusted. Neither
// may exit 0.
if (failures || pageTriedToWrite.length || httpWrites.length) process.exit(1);
if (allowlistTooNarrow.length || httpGaps.length) process.exit(2);
// Every candidate moved out from under us: the list route alone proves
// nothing about the chooser, so this run verified nothing.
if (!visited.some((v) => /^\/positions\/\d+$/.test(v.path))) {
  console.log(
    '\nBLOCKED: no position detail page was observed — nothing verified.',
  );
  process.exit(2);
}
process.exit(0);
