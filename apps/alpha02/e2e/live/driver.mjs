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
  try {
    await import(process.env.LIVE_PROXY_SETUP);
  } catch (err) {
    // A shim that will not load is a broken ENVIRONMENT, not a product
    // regression (Codex #1621 r6) — and it fails before any browser or
    // page exists, so there is nothing this run could have observed.
    // `blockedSync` is a hoisted function declaration, so it is callable
    // from here despite being defined further down.
    blockedSync(
      `cannot load LIVE_PROXY_SETUP — the egress shim this environment` +
        ` needs would not initialise.\n  module: ${process.env.LIVE_PROXY_SETUP}` +
        `\n  ${err.message}`,
    );
  }
}
// Node's built-in fetch (undici under the hood) — no extra dep. The
// optional LIVE_PROXY_SETUP shim may swap the global dispatcher.
const ufetch = globalThis.fetch;
import fs from 'node:fs';
import os from 'node:os';
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
const WALLETS_PATH =
  process.env.TESTNET_WALLETS_FILE ??
  path.join(HERE, '../testnet-wallets/wallets.json');
let LIVE_BROWSER = null;

/**
 * Register a browser/context for `blocked()` to close.
 *
 * `launch()` registers its own, so drives built on it need not call
 * this. It exists for the one drive that launches Chromium itself
 * (`live-desk-i18n-capture.mjs` runs a per-locale context matrix that
 * `launch()`'s single-context shape does not express) so it can still
 * reach the SHARED blocked exit rather than keep a second copy of it.
 */
export function trackBrowser(browser) {
  LIVE_BROWSER = browser;
}

/**
 * Synchronous BLOCKED exit, for the pre-browser precondition checks
 * (`loadWallets`, `walletFor`, bundle-shape and config validation) that
 * run before any browser exists and cannot await.
 */
export function blockedSync(why) {
  console.error(`\nBLOCKED: ${why}`);
  process.exit(2);
}

/**
 * Exit BLOCKED (code 2) — "this drive could not verify anything", as
 * distinct from FAIL (code 1) — "this drive found a defect".
 *
 * The distinction is the whole point of the three-verdict contract in
 * `run-live-batch.mjs`: a misclassified infra blip sends someone hunting
 * a product bug that does not exist, and habitual FAIL rows train
 * reviewers to skim past the one that is real (#1581).
 *
 * The rule for choosing: if the drive never got a served page to assert
 * against — unreachable site, dead RPC, absent credential, no browser,
 * no eligible on-chain state — it is BLOCKED. If it asserted against a
 * page that WAS served and the assertion failed, that is FAIL.
 *
 * Closes any browser this module opened, so a blocked exit cannot leave
 * a Chromium behind. Callers do not wire that themselves — it was the
 * per-driver duplication `live-position-observe.mjs`'s `discovery()`
 * wrapper existed to avoid.
 */
export async function blocked(why, err, cleanup) {
  const detail = err ? `\n  ${String(err.message ?? err).split('\n')[0].slice(0, 300)}` : '';
  console.error(`\nBLOCKED: ${why}${detail}`);
  try {
    await LIVE_BROWSER?.close();
  } catch {
    /* exiting anyway — a close failure must not mask the real cause */
  }
  try {
    // Runs AFTER the close, so a caller removing a throwaway profile
    // directory is not fighting a Chromium that still holds it open.
    await cleanup?.();
  } catch {
    /* same — cleanup is best effort on the way out */
  }
  process.exit(2);
}

/**
 * A browser/context SETUP failure, raised instead of exiting when the
 * caller has asked to decide the verdict itself (Codex #1621 r1).
 *
 * `launch()` exiting BLOCKED directly is right for a drive that has
 * observed nothing yet — which is all of them at launch time, with one
 * exception. `live-recover-locales.mjs` launches a fresh browser PER
 * LOCALE and accumulates findings across them, so a setup failure on
 * locale 6 must not discard a real localization defect found on locale
 * 2: "verified nothing" would be a false statement about that run. It
 * catches this and lets its own `exitOnEvidence` choose.
 *
 * Part 1 of #1581 broke exactly that, silently — moving the exit inside
 * `launch()` meant that catch could never run, and the precedence rule
 * #1590 r6 added went dead without any test noticing.
 */
export class LiveSetupError extends Error {
  constructor(what, cause) {
    super(`browser setup failed (${what})`);
    this.name = 'LiveSetupError';
    this.cause = cause;
  }
}

/**
 * A PRECONDITION failure raised where exiting immediately would be
 * unsafe (Codex #1621 r4).
 *
 * `blockedSync` is right before a drive can mutate anything. After that
 * point `process.exit` skips the drive's `finally`, which is what cancels
 * a posted offer or a resting signed order — so a stale ABI bundle could
 * cost real testnet funds. Throwing instead lets the cleanup run, and the
 * drive classifies this type as BLOCKED at its final exit.
 *
 * Preferred over an up-front list of everything used after the mutation
 * boundary: such a list drifted within one review round (it omitted
 * `getOffer` and `previewMatch`), and a list that must stay exhaustive to
 * be safe is the wrong shape for a safety property.
 */
export class LivePreconditionError extends Error {
  constructor(why) {
    super(why);
    this.name = 'LivePreconditionError';
  }
}

/**
 * Run a setup/precondition step; any throw is BLOCKED, not FAIL.
 *
 * Wrap the things that must work before verification can start —
 * navigation to the site, reading deployment data, resolving config —
 * and leave assertions against a served page unwrapped so a real defect
 * still exits 1.
 */
export async function precondition(what, fn) {
  try {
    return await fn();
  } catch (err) {
    await blocked(`${what} failed, so nothing could be observed`, err);
  }
}

/**
 * Open a site path as a PRECONDITION — BLOCKED on failure, not FAIL.
 *
 * Use this for a drive's FIRST navigation, which is its reachability
 * probe: an unreachable site, a DNS failure or a dead preview means the
 * drive never got a page to assert against.
 *
 * Deliberately NOT for later navigations. Once the site is known
 * reachable, a route that fails to load is a plausible product
 * regression — a broken route IS a defect — so those keep exiting 1.
 * The line is "did we ever get served anything", not "did every
 * navigation succeed".
 */
/**
 * Watch whether the PAGE's own JSON-RPC endpoint is answering.
 *
 * The problem this solves: several drives read their verdict out of a
 * chain-backed UI state — a precheck banner rendered from an eth_call, a
 * submit button gated on live reads. When the RPC the deployed page uses
 * stops answering, that state never arrives, a `waitFor` expires, and the
 * drive reports FAIL. Every one of those drives is registered in
 * THREE_VERDICT_DRIVERS, so the batch TRUSTS that code and calls an
 * outage a product regression.
 *
 * Two traps, both of which a first attempt at this fell into:
 *
 *  1. SCOPE. A whole-session counter is disarmed by the page-load reads
 *     that have nothing to do with the verdict: the endpoint answers on
 *     load, then dies or starts throttling exactly when the assertion's
 *     reads go out, and the drive falls through to FAIL anyway. So the
 *     window has to be reset immediately before the wait that matters.
 *
 *  2. WHAT COUNTS. A 200 carrying a JSON-RPC *error* still proves the
 *     endpoint answered — and for a revert-driven assertion that error IS
 *     the expected result. Counting only `result` misses precisely the
 *     call the verdict rests on.
 *
 * Usage: `const rpc = watchPageRpc(page)` once after launch; `rpc.reset()`
 * just before the critical wait; `await rpc.settled()` in the failure
 * path, and treat `0` as BLOCKED.
 *
 * Counted from the page's traffic rather than an endpoint the driver
 * picks, because the served SPA chooses its RPC at build time — the only
 * reliable way to know which endpoint matters is to watch what the page
 * does (the reasoning live-rpc-audit.mjs records at length).
 */
export function watchPageRpc(page) {
  let answered = 0;
  const bodyReads = [];
  // Membership is decided when the REQUEST starts, not when its response
  // arrives. A slow hydration request issued before `reset()` can land
  // after it, and counting that as an answer makes a total outage DURING
  // the assertion look like a live endpoint — FAIL where BLOCKED is right,
  // the exact failure this helper exists to prevent. live-rpc-audit.mjs
  // already keys on the request object for this reason; the helper was
  // first written without carrying that over.
  //
  // Stamped with a GENERATION rather than added to a set. A set plus a
  // cleared tally is not enough and was the second wrong version of this:
  // clearing the counter does nothing about a stale request whose response
  // arrives later and increments it again. The generation bumps on reset,
  // so a response can only count when its request started in the CURRENT
  // window. (A WeakSet cannot be cleared, which is what made the set
  // approach quietly unfixable.)
  let generation = 0;
  const startedIn = new WeakMap();
  // Recorded requests that have not yet emitted `response`. Without this,
  // `settled()` snapshots `bodyReads` while a request is still in flight,
  // `Promise.allSettled([])` returns instantly, and the window reports
  // ZERO answers — a false BLOCKED over whatever the drive was asserting.
  // live-rpc-audit.mjs solved this with a bounded drain loop; this helper
  // was written without it, the same way it was written without
  // request-start attribution.
  const outstanding = new Set();
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    startedIn.set(req, generation);
    outstanding.add(req);
  });
  // A request that fails at the transport level never emits `response`, so
  // it would otherwise hold the drain loop open for the whole grace period.
  page.on('requestfailed', (req) => outstanding.delete(req));
  page.on('response', (res) => {
    outstanding.delete(res.request());
    // Captured here and RE-CHECKED after the body read below. The read is
    // async, so a response that passed this gate can finish parsing after
    // a later `reset()` and increment the freshly-zeroed counter — making
    // a completely unanswered window look RPC-live. Checking the
    // generation only once, before the await, was the fifth way this
    // helper got the window wrong.
    const gen = startedIn.get(res.request());
    if (gen !== generation || res.status() !== 200) return;
    // `response` fires on HEADERS and does not await handlers, so the body
    // is still in flight; collect the promises and settle before judging.
    bodyReads.push(
      res
        .text()
        .then((text) => {
          // The window may have closed while this body was in flight.
          if (gen !== generation) return;
          const parsed = JSON.parse(text);
          for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
            if (r && r.jsonrpc && (r.result !== undefined || r.error !== undefined)) {
              answered++;
            }
          }
        })
        .catch(() => {
          /* not a JSON-RPC body, or it never arrived */
        }),
    );
  });
  return {
    /**
     * Start a fresh window. Call immediately before the critical wait.
     *
     * Only responses to POSTs that START after this point can contribute:
     * the generation bump orphans everything already in flight.
     */
    reset() {
      generation++;
      answered = 0;
      bodyReads.length = 0;
      outstanding.clear();
    },
    /**
     * Report answers seen this window.
     *
     * Drains outstanding requests first, bounded — a request still
     * unanswered after the grace period did not contribute an answer
     * anyway, and must not hang the drive. Then settles the body reads,
     * because `response` fires on HEADERS and the parse is still in
     * flight when the handler returns.
     */
    async settled(graceMs = 15_000) {
      const until = Date.now() + graceMs;
      while (outstanding.size > 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await Promise.allSettled(bodyReads);
      return answered;
    },
  };
}

export async function visit(page, pathname, opts = {}) {
  return precondition(`opening ${pathname}`, async () => {
    const resp = await page.goto(`${SITE}${pathname}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
      ...opts,
    });
    // A THROW is not the only way a target can be unreachable (Codex
    // #1621 r8). `page.goto` resolves normally for an HTTP error page —
    // a preview URL 404ing, a CDN returning 502/503 — so without this the
    // helper declared reachability established and every later assertion
    // ran against a gateway error body. During an infrastructure outage
    // that is not one misleading row but the whole fleet reporting
    // product FAILs, which is the exact scenario this contract exists to
    // prevent.
    //
    // Status is checked only for the FIRST navigation, which is what this
    // helper is for. A later route returning 404 is a plausible product
    // regression and stays exit 1.
    const status = resp?.status();
    if (typeof status === 'number' && status >= 400) {
      throw new Error(`${SITE}${pathname} answered HTTP ${status}`);
    }
    return resp;
  });
}

let WALLETS;
/**
 * Read LAZILY, on the first request for a key — not at import.
 *
 * A keyless drive (`launch({ keyless: true })`, e.g.
 * live-recover-locales.mjs) reads only public pages and must not depend
 * on a signing credential to run. Loading at module scope made the mere
 * IMPORT of this file exit 2, so a public probe could not reuse the
 * browser + route-shim machinery here and would have had to duplicate
 * it — which is how two copies of the egress shim start diverging
 * (Codex #1590 r1).
 *
 * Signing drives are unaffected: they reach `walletFor()` inside
 * `launch()`, which is the first thing it does, so the BLOCKED exit
 * still fires before any browser work.
 */
function loadWallets() {
  if (WALLETS !== undefined) return WALLETS;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(WALLETS_PATH, 'utf8'));
  } catch (err) {
    // Exit 2 = BLOCKED, per the contract in run-live-batch.mjs. An absent
    // dev-wallet file is a missing PRECONDITION, not a product regression:
    // letting this throw exits 1 and makes every ordinary
    // secret-unavailable batch read as a defect, which is exactly the
    // mislabelling the three-verdict contract exists to prevent (#1529
    // review round 6).
    // Uses the shared exit so there is one definition of "BLOCKED" —
    // this message and `walletFor`'s were separate copies of it.
    blockedSync(
      `cannot read the dev wallet file — this driver signs, so it cannot run` +
        ` without one.\n  path: ${WALLETS_PATH}\n  ${err.message}` +
        `\n  → set TESTNET_WALLETS_FILE, or run a watch-only drive` +
        ` (live-position-observe.mjs) which needs no key.`,
    );
  }
  // Normalize both documented shapes to a role map — the array form
  // ({ role, address, privateKey }[]) indexed as a map yields
  // undefined.privateKey otherwise.
  WALLETS = Array.isArray(raw)
    ? Object.fromEntries(raw.map((w) => [w.role ?? w.name, w]))
    : raw;
  return WALLETS;
}

/**
 * The ONE accessor for a role's key, so a missing credential is BLOCKED
 * wherever it is discovered.
 *
 * A readable-but-incomplete wallet file is just as much a missing
 * precondition as an absent one — an empty `{}` parses fine and then
 * `WALLETS[role].privateKey` throws deep inside `launch`, which exits 1
 * and reads as a product regression (#1529 review round 7). The file
 * check alone was not enough; the check has to be per ROLE, at the point
 * of use.
 */
function walletFor(role) {
  const wallets = loadWallets();
  const w = wallets?.[role];
  const key = w?.privateKey;
  // Shared exit, not a local copy of it (#1581).
  const blocked = (why) => {
    const roles = Object.keys(wallets ?? {});
    blockedSync(
      `the dev wallet file has no usable credential for role "${role}" — ${why}.` +
        `\n  path:  ${WALLETS_PATH}` +
        `\n  roles: ${roles.length ? roles.join(', ') : '(none)'}` +
        `\n  → each role needs { address, privateKey } with a 32-byte key,` +
        ` and the address must be the one that key derives.`,
    );
  };

  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    blocked('no valid privateKey');
  }
  // The ADDRESS is a credential too, not decoration. `addressOf` is used
  // BEFORE launch by several drivers, so a missing one crashes with exit 1
  // rather than BLOCKED — and worse, an address belonging to a DIFFERENT
  // key makes a drive inspect one wallet while injecting another, which
  // fails in a way that looks like an app bug (#1529 review round 8).
  if (typeof w.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(w.address)) {
    blocked('no valid address');
  }
  // The regex proves 32 bytes of hex, not a usable key: secp256k1 also
  // requires 1 <= k < n, so the all-zero placeholder and anything at or
  // above the curve order pass the shape test and throw here. Letting
  // that escape exits 1 from every signing driver, and the batch reports
  // an unusable CREDENTIAL as a possible product FAIL — the precondition
  // shape this file's `blocked()` exists for (#1529 review round 20).
  let derived;
  try {
    derived = privateKeyToAccount(key).address;
  } catch {
    blocked('privateKey is 32 bytes of hex but not a valid secp256k1 key');
  }
  if (derived.toLowerCase() !== w.address.toLowerCase()) {
    blocked(
      `address ${w.address} is not the one its privateKey derives (${derived})`,
    );
  }
  return w;
}

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
  // A remembered session can complete right after the click and hide
  // the modal before the provider option is clickable — treat "the
  // connect CTA left the header" as connected, and only try the
  // option click while the CTA is still up (round 5).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await connect.isVisible().catch(() => false))) {
      await page.waitForTimeout(1_000);
      return;
    }
    // ConnectKit lists announced EIP-6963 providers by name.
    await page
      .getByText('Vaipakam Test Wallet', { exact: false })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => {});
    await page.waitForTimeout(500);
  }
  throw new Error('wallet connect did not complete within 30s');
}

export function clientsFor(chainId) {
  const { chain, rpc } = CHAINS[chainId];
  return {
    pub: createPublicClient({ chain, transport: http(rpc) }),
    wallet: (role) =>
      createWalletClient({
        chain,
        transport: http(rpc),
        account: privateKeyToAccount(walletFor(role).privateKey),
      }),
  };
}

export function addressOf(role) {
  return walletFor(role).address;
}

/**
 * Assert a signing driver's credential UP FRONT.
 *
 * Loading the wallet file lazily (so keyless drives can import this
 * module) moved the BLOCKED exit from import time to first use — and
 * several signing drivers do live chain reads BEFORE they ever reach
 * `launch` or `addressOf`. With no credential and a slow or unavailable
 * public RPC, those reads now fail with exit 1, or hang, instead of the
 * immediate exit 2 the batch contract documents: a missing secret would
 * be reported as a product regression (Codex #1590 r4).
 *
 * Call this at the top of any driver that signs, before its first
 * network call. It is the same per-role validation `walletFor` does, so
 * there is no second rule to keep in step — only an earlier moment to
 * apply it.
 */
export function requireSigningRole(role) {
  walletFor(role);
}

export async function launch({
  role,
  startChainId = 84532,
  headless = true,
  // readOnly: deny every signing/write RPC at the injected-wallet
  // boundary. For evidence sweeps (live-ux-sweep) that advertise
  // themselves as read-only: a page regression (or a compromised
  // preview target) asking for a signature mid-visit gets a wallet
  // error instead of an auto-approved signature (Codex #1154 P2).
  readOnly = false,
  // preAuthorized: whether `eth_accounts` reports the account BEFORE
  // the page ever calls `eth_requestAccounts`. Default true mirrors a
  // returning user whose wallet already authorized the site (the
  // historical driver behaviour every connected scenario relies on).
  // Pass false for FIRST-VISIT evidence: a real wallet returns [] to
  // `eth_accounts` until the user approves, and with the permissive
  // default wagmi treats the announced provider as already-connected —
  // the 2026-07-13 second-pass sweep's "disconnected" session silently
  // rendered every route CONNECTED because of exactly that.
  preAuthorized = true,
  // allowRequestAccounts: whether `eth_requestAccounts` may grant the
  // approval at all. A session whose PURPOSE is to stay disconnected
  // must pass false: otherwise an app regression (or wallet-library
  // change) that requests accounts on page load would silently flip
  // the session connected while the report still stamps it
  // `connected:false` — recreating the false evidence preAuthorized
  // exists to prevent (Codex #1181 P2). When false, the request gets
  // an EIP-1193 4001 rejection — exactly what a real user dismissing
  // the wallet popup produces — and is logged to blockedRequests so
  // the sweep surfaces the attempt loudly.
  allowRequestAccounts = true,
  // freshProfile: run on a THROWAWAY browser profile (temp dir,
  // removed on done()) instead of the persistent per-role profile.
  // First-visit evidence needs it: the persistent profile carries
  // localStorage/IndexedDB from earlier runs (dismissed banners, mode
  // flags, connectkit state), so a later run would no longer
  // represent a first visit (Codex #1181 P2).
  freshProfile = false,
  // keyless: launch the browser + egress route shim with NO wallet
  // injected and no key read. For drives that only read PUBLIC pages
  // (live-recover-locales.mjs): the page sees no provider at all, which
  // is both the honest posture for a public probe and the reason the
  // drive can run in an environment with no dev-wallet file. The route
  // shim, viewport, profile handling and `done()` cleanup are shared
  // with every other drive rather than copied (Codex #1590 r1).
  keyless = false,
  // onSetupFailure: what a browser/context SETUP failure does.
  //
  //   'blocked' (default) — exit 2 immediately. Right for a drive that
  //     has observed nothing yet, which is every drive at launch time.
  //   'throw' — raise a `LiveSetupError` for the caller to handle.
  //     For a drive that launches repeatedly and ACCUMULATES findings
  //     across launches, where exiting here would discard evidence
  //     already gathered and claim the run verified nothing. Only
  //     `live-recover-locales.mjs` needs it (Codex #1621 r1).
  //
  // The default is the safe one on purpose: forgetting the option costs
  // a correct-but-blunt verdict, never a silently discarded finding.
  onSetupFailure = 'blocked',
} = {}) {
  const account = keyless
    ? null
    : privateKeyToAccount(walletFor(role).privateKey);
  let chainId = startChainId;
  let authorized = preAuthorized;

  let profileDir = null;
  // A throwaway profile is created BEFORE the browser is launched, so a
  // launch failure (Chromium missing, bad LIVE_CHROMIUM_PATH, no disk)
  // leaves it behind — the caller never gets a `done()` to clean up
  // with. Cleaning here rather than at each call site keeps the
  // create/remove pair in one place (Codex #1590 r6).
  const removeThrowawayProfile = () => {
    if (freshProfile && profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  };

  /**
   * Run one browser/context SETUP step.
   *
   * EVERY pre-page step goes through this, not just the launch (Codex
   * #1621 r1). Guarding only `launchPersistentContext` left the route
   * shim, the wallet binding, the init script and the first page
   * unguarded: a rejection there reached the driver's top level as exit
   * 1 AND leaked the Chromium, so an environment problem after a
   * successful launch still read as a product regression. COVERAGE.md
   * already stated the rule — "every step of it belongs inside the same
   * wrapper" — and part 1 implemented only the first step of it.
   */
  const setup = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (onSetupFailure === 'throw') {
        // The caller decides the verdict, so clean up what `blocked()`
        // would have and hand the failure back intact.
        try {
          await LIVE_BROWSER?.close();
        } catch {
          /* best effort on the way out */
        }
        LIVE_BROWSER = null;
        // Best effort, exactly as the close above is (Codex #1621 r6). An
        // rmSync failure here would REPLACE the LiveSetupError with a raw
        // filesystem exception, and the evidence-accumulating callers key
        // on `instanceof LiveSetupError` — so they would rethrow and exit 1
        // for a setup problem where no page was ever observed, defeating
        // the whole point of handing the error back.
        try {
          removeThrowawayProfile();
        } catch {
          /* the setup failure is the story; a leftover temp dir is not */
        }
        throw new LiveSetupError(what, err);
      }
      // BLOCKED, not FAIL (#1581): no usable browser means the drive
      // never got a page to assert against. Rethrowing exited 1 and made
      // a missing or unusable Chromium read as a product regression.
      await blocked(`browser setup failed (${what})`, err, removeThrowawayProfile);
    }
  };

  // Creating the profile directory is setup too (Codex #1621 r2). An
  // unwritable profile parent or exhausted temp storage threw here,
  // BEFORE the wrapper below existed to catch it, so the shared
  // launcher's promise of BLOCKED-on-setup-failure had a hole in it at
  // the very first step.
  await setup('creating the browser profile directory', async () => {
    profileDir = freshProfile
      ? fs.mkdtempSync(path.join(os.tmpdir(), `alpha02-fresh-${role}-`))
      : path.join(HERE, 'profiles', role);
    fs.mkdirSync(profileDir, { recursive: true });
  });

  const ctx = await setup('launching the browser', async () => {
    const created = await chromium.launchPersistentContext(profileDir, {
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
    // Register it so a later `blocked()` — from this module or a driver —
    // closes it instead of leaving a Chromium behind.
    LIVE_BROWSER = created;
    return created;
  });

  // The egress gateway resets Chromium's own TLS handshakes, so ALL
  // page traffic is served from THIS process via undici (whose stack
  // the proxy accepts). WebSockets aren't covered — the SPA + JSON-RPC
  // don't need them.
  // read-only HTTP guard (Codex #1154 r3 P2): the wallet-level guard
  // stops SIGNING, but a page-initiated backend write (support ticket,
  // alerts POST) or a raw-tx broadcast would still ride the route shim.
  // Chain READS are JSON-RPC POSTs, so mutating methods can't be
  // blanket-blocked; instead: a mutating request is allowed through
  // only when its body is JSON-RPC whose every method avoids the
  // broadcast/signing set — anything else is aborted AND logged so a
  // sweep can fail loudly instead of silently mutating state.
  // ONE allowlist for BOTH doors (Codex #1894 r5/r6).
  //
  // There are two ways a page can reach the chain: the injected wallet
  // binding, and a raw JSON-RPC POST straight at the RPC endpoint
  // through the route shim. Each used to be gated by its own denylist,
  // and a denylist has to enumerate every write that will ever exist —
  // both already missed the ones the ecosystem added later
  // (`wallet_sendCalls`, `eth_sendUserOperation`). Whichever door was
  // fixed alone, the other stayed open, which is how one of two guards
  // ends up weaker than the other.
  //
  // Drawn from `live-position-observe.mjs`'s ALLOWED_RPC: that file
  // already answered "which methods are reads" for its own HTTP layer,
  // and a second independently-drifting answer is the same failure in a
  // new place. A too-narrow list costs a refused read, which surfaces
  // LOUDLY in a live drive; a denylist gap surfaces not at all.
  const READ_METHODS = new Set([
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
    'eth_getProof',
    'eth_getStorageAt',
    'eth_getTransactionByHash',
    'eth_getTransactionCount',
    'eth_getTransactionReceipt',
    'eth_maxPriorityFeePerGas',
    'eth_syncing',
    'eth_subscribe',
    'eth_unsubscribe',
    'net_version',
    'web3_clientVersion',
    'wallet_getPermissions',
  ]);

  const RPC_WRITE_METHODS = new Set([
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'eth_signTransaction',
    'eth_sign',
    'personal_sign',
    'eth_signTypedData_v4',
  ]);
  const blockedRequests = [];
  function readOnlyViolation(req) {
    if (!readOnly) return null;
    const method = req.method().toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
    const body = req.postData();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        if (calls.every((c) => c && typeof c.jsonrpc === 'string')) {
          // Named write first, so the reason still says `json-rpc
          // eth_sendTransaction` for the cases that always worked and
          // the existing assertions keep reading the same way.
          const bad = calls.find((c) => RPC_WRITE_METHODS.has(c.method));
          if (bad) return `json-rpc ${bad.method}`;
          // Then the allowlist, which is what closes the gap: a raw
          // `eth_sendUserOperation` POST at the RPC endpoint bypasses
          // the injected provider entirely, and the six-entry denylist
          // let it through unrecorded (Codex #1894 r6).
          const unlisted = calls.find((c) => !READ_METHODS.has(c.method));
          if (unlisted) return `json-rpc ${unlisted.method} (not a permitted read)`;
          return null; // every method is a permitted read
        }
      } catch {
        /* not JSON — fall through to block */
      }
    }
    return `${method} (non-RPC mutating request)`;
  }

  await setup('installing the route shim', () =>
    ctx.route('**/*', async (route) => {
    const req = route.request();
    const violation = readOnlyViolation(req);
    if (violation) {
      // WHO asked, not only what was asked (Codex #1894 r5). A record
      // carrying just destination and reason cannot distinguish the app
      // POSTing to a third-party host from that third party's own page
      // doing it, so any consumer that exempts a host is really
      // exempting the destination for everybody — including the
      // compromised or malfunctioning build this guard exists to catch.
      // `frame()` is null for service-worker and some navigation
      // requests, and can throw on a detached frame; an unknown
      // initiator is recorded as such, and a consumer must treat unknown
      // as "not exempt".
      let initiator = '(unknown)';
      try {
        initiator = req.frame()?.url()?.slice(0, 300) || '(unknown)';
      } catch {
        /* detached frame — leave it unknown, which is the safe reading */
      }
      blockedRequests.push({
        reason: violation,
        url: req.url().slice(0, 300),
        initiator,
      });
      await route.abort('accessdenied').catch(() => {});
      return;
    }
    try {
      const resp = await ufetch(req.url(), {
        method: req.method(),
        // Hand a 3xx BACK to the browser instead of following it here
        // (#1648 r2). `fetch` follows redirects by default and returns
        // the FINAL body, which `route.fulfill` then serves at the
        // ORIGINAL url — so the page ends up showing another route's
        // content while `page.url()` and the response url both still
        // read as the requested one. Every driver is blind to a
        // redirect under that shape, and `live-ux-sweep`'s new
        // redirected-away check could never fire. With `manual` the
        // 3xx + `location` reaches Chromium, which follows it itself,
        // so the URLs move the way they would with no shim installed.
        redirect: 'manual',
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
    }),
  );

  const rpcLog = [];
  const WRITE_METHODS = new Set([
    'personal_sign',
    'eth_sign',
    'eth_signTypedData',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
    'eth_signTransaction',
    'eth_sendRawTransaction',
  ]);
  async function handle({ method, params }) {
    const { chain, rpc } = CHAINS[chainId];
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const wallet = createWalletClient({ chain, transport: http(rpc), account });
    rpcLog.push(method);
    if (readOnly && WRITE_METHODS.has(method)) {
      // Land wallet-level refusals in the SAME violations list as the
      // HTTP guard: an app that catches the wallet error would
      // otherwise leave a clean report while a write was attempted
      // (Codex #1154 r4 P2).
      blockedRequests.push({ reason: `wallet rpc ${method}`, url: '(injected wallet)' });
      const err = new Error(`read-only driver session: ${method} disabled`);
      err.code = 4200; // EIP-1193 unsupported method
      throw err;
    }
    switch (method) {
      case 'eth_requestAccounts':
        // An explicit request is the user-approval moment — from here
        // on the session is authorized (matches a real wallet's
        // approve-once-then-remember behaviour). A session launched
        // with allowRequestAccounts:false refuses the approval like a
        // user dismissing the popup (EIP-1193 4001) AND logs it: a
        // page that auto-requests accounts during a stay-disconnected
        // sweep must surface loudly, not silently flip the session
        // connected (Codex #1181 P2).
        if (!allowRequestAccounts) {
          blockedRequests.push({
            reason: 'wallet rpc eth_requestAccounts (disconnected session)',
            url: '(injected wallet)',
          });
          const rejection = new Error(
            'stay-disconnected driver session: account request rejected',
          );
          rejection.code = 4001; // EIP-1193 user rejected request
          throw rejection;
        }
        authorized = true;
        return [account.address];
      case 'eth_accounts':
        // Pre-approval, a real wallet reports NO accounts; only an
        // already-authorized session exposes the address (see the
        // preAuthorized launch option).
        return authorized ? [account.address] : [];
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
        // Granting the eth_accounts permission IS the approval moment
        // — same gate as eth_requestAccounts, or a page connecting via
        // the permissions path would slip past a stay-disconnected
        // session without a trace (Codex #1181 r2 P2).
        if (!allowRequestAccounts) {
          blockedRequests.push({
            reason: 'wallet rpc wallet_requestPermissions (disconnected session)',
            url: '(injected wallet)',
          });
          const permRejection = new Error(
            'stay-disconnected driver session: permission request rejected',
          );
          permRejection.code = 4001; // EIP-1193 user rejected request
          throw permRejection;
        }
        authorized = true;
        return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_revokePermissions':
        // A real wallet's revoke makes subsequent eth_accounts report
        // nothing — mirror that instead of leaving the session
        // authorized after the page explicitly disconnected.
        authorized = false;
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
        // ALLOWLIST under readOnly, not the denylist above (Codex #1894
        // r5). `WRITE_METHODS` has to enumerate every write that will
        // ever exist, and it already misses the ones the ecosystem added
        // after it was written — `wallet_sendCalls`, `eth_sendUserOperation`.
        // Those fell through to here unrecorded, so a page that
        // attempted one and caught the error left a clean report: the
        // guard's whole job is to notice the ATTEMPT, and it did not.
        //
        // `live-position-observe.mjs` already made this argument for the
        // HTTP layer and shipped an allowlist there; this applies the
        // same rule at the wallet, which was the one place still
        // enumerating what to refuse instead of what to permit.
        //
        // A too-narrow allowlist is a real cost and is why the list is
        // generous with reads — but it fails LOUDLY, as a refused read
        // in a live drive, rather than silently the way a denylist gap
        // does. That asymmetry is the reason to prefer it.
        if (readOnly && !READ_METHODS.has(method)) {
          blockedRequests.push({
            reason: `wallet rpc ${method} (not a permitted read)`,
            url: '(injected wallet)',
            initiator: '(injected wallet)',
          });
          const unknown = new Error(
            `read-only driver session: ${method} is not a permitted read`,
          );
          unknown.code = 4200; // EIP-1193 unsupported method
          throw unknown;
        }
        // All reads forward to the chain RPC.
        return pub.request({ method, params });
    }
  }

  // The injected EIP-1193 wallet. Skipped entirely when keyless: a
  // public-page probe should present no provider at all, so an app
  // regression that asks for accounts on load has nothing to answer it.
  if (!keyless) {
    await setup('exposing the wallet binding', () =>
      ctx.exposeBinding('__walletRequest', async (_src, payload) => {
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
      }),
    );

    await setup('installing the wallet init script', () =>
      ctx.addInitScript(() => {
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
      }),
    );
  }

  const page = await setup('opening the first page', async () => ctx.pages()[0] ?? ctx.newPage());
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
    blockedRequests,
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
      if (freshProfile) {
        // Throwaway profile — remove it so first-visit evidence can
        // never leak state into a later run (and temp space stays
        // bounded across sweep nights).
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    },
  };
}

function jsonSafe(v) {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? numberToHex(x) : x)),
  );
}

/** Choose a row in the app's SelectMenu dropdown (button + listbox —
 *  NOT a native <select>; selectOption does not apply). Rows carry
 *  data-value; `i` flag tolerates checksum-vs-lowercase casing. */
export async function chooseMenuValue(page, menuId, value) {
  await page.locator(`#${menuId}`).click();
  const row = page.locator(`[role="listbox"] [data-value="${value}" i]`);
  await row.waitFor({ state: 'visible', timeout: 30000 });
  await row.click();
}

/** Open an AssetPicker's paste branch and fill an address. */
export async function pasteAssetLive(page, pickerId, address) {
  await chooseMenuValue(page, pickerId, '__custom__');
  await page
    .locator(`.field:has(#${pickerId}) input[placeholder="0x…"]`)
    .fill(address);
}
