/**
 * #1140 — every chain-keyed route on the loan, offer and signed-offer
 * surfaces answers a chain this Worker does not index with a 503
 * `chain-not-configured`, never an empty 200.
 *
 * `/config/:chainId` is covered too, and so are the two reward metrics
 * (#2654): `/metrics/loop-closure` through the same guard, and
 * `/metrics/recycling`, dispatched before `resolveEnv`, through the
 * pre-resolve one. Two halves. The behavioural half calls each route for a chain no RPC is
 * bound for. The structural half is what keeps the rule from being missed
 * again: every exported handler on those surfaces that reads a chain id must
 * ask `chainNotServed`, so a new route fails here until it does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import * as loanRoutes from '../src/loanRoutes';
import * as offerRoutes from '../src/offerRoutes';
import { handleSignedOffersGet } from '../src/signedOfferRoutes';
import { handleConfigSnapshot } from '../src/configSnapshot';
import { handleLoopClosure } from '../src/rewardRoutes';
import { handleRecyclingSeries } from '../src/recycleRoutes';
import { chainNotConfigured, chainNotServed, chainServed, requestedChainId } from '../src/servedChain';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const SERVED = 84532;
const ADDR = '0x' + '11'.repeat(20);

describe('which chain is served', () => {
  it('serves a chain with a deployment and a bound RPC, and no other', () => {
    const env = { RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    expect(chainServed(env, SERVED)).toBe(true);
    expect(chainServed({} as unknown as Env, SERVED)).toBe(false);
    expect(chainServed(env, 999_999)).toBe(false);
    expect(chainNotServed(env, SERVED)).toBeNull();
  });

  it('keeps the default chain for a request that names none or a malformed one', () => {
    expect(requestedChainId(new URL('https://x/'))).toBe(8453);
    expect(requestedChainId(new URL('https://x/?chainId=abc'))).toBe(8453);
    expect(requestedChainId(new URL('https://x/?chainId=84532'))).toBe(84532);
  });
});

describe('an unserved chain is refused on every chain-keyed route (#1140)', () => {
  // No RPC bound: the chain has a deployment but this Worker is not indexing
  // it, which is exactly the case a cacheable empty 200 used to hide.
  const env = () => ({ DB: createSqliteD1(ALL_MIGRATIONS).d1 }) as unknown as Env;
  const q = `chainId=${SERVED}`;
  const cases: [string, () => Promise<Response>][] = [
    ['/loans/active', () => loanRoutes.handleLoansActive(new Request(`https://x/loans/active?${q}`), env())],
    ['/loans/:id', () => loanRoutes.handleLoanById(new Request(`https://x/loans/1?${q}`), env(), '1')],
    ['/loans/by-lender', () => loanRoutes.handleLoansByParticipant(new Request(`https://x/l?${q}`), env(), ADDR, 'lender')],
    ['/loans/by-current-holder', () => loanRoutes.handleLoansByCurrentHolder(new Request(`https://x/l?${q}`), env(), ADDR)],
    ['/activity', () => loanRoutes.handleActivity(new Request(`https://x/activity?${q}`), env())],
    ['/claimables', () => loanRoutes.handleClaimables(new Request(`https://x/c?${q}`), env(), ADDR)],
    ['/claim-candidates', () => loanRoutes.handleClaimCandidates(new Request(`https://x/c?${q}`), env(), ADDR)],
    ['/loans/stats', () => loanRoutes.handleLoansStats(new Request(`https://x/loans/stats?${q}`), env())],
    ['/loans/recent', () => loanRoutes.handleLoansRecent(new Request(`https://x/loans/recent?${q}`), env())],
    ['/loans/timeseries', () => loanRoutes.handleLoansTimeseries(new Request(`https://x/loans/timeseries?${q}`), env())],
    ['/loans/by-participant', () =>
      loanRoutes.handleLoansByHistoricalParticipant(new Request(`https://x/l?${q}&wallet=${ADDR}`), env())],
    ['/offers/stats', () => offerRoutes.handleOffersStats(new Request(`https://x/offers/stats?${q}`), env())],
    ['/offers/markets', () => offerRoutes.handleOffersMarkets(new Request(`https://x/offers/markets?${q}`), env())],
    ['/offers/active', () => offerRoutes.handleOffersActive(new Request(`https://x/offers/active?${q}`), env())],
    ['/offers/:id', () => offerRoutes.handleOfferById(new Request(`https://x/offers/1?${q}`), env(), '1')],
    ['/offers/by-creator', () => offerRoutes.handleOffersByCreator(new Request(`https://x/o?${q}`), env(), ADDR)],
    ['/offers/by-current-holder', () => offerRoutes.handleOffersByCurrentHolder(new Request(`https://x/o?${q}`), env(), ADDR)],
    ['/offers/recent', () => offerRoutes.handleOffersRecent(new Request(`https://x/offers/recent?${q}`), env())],
    ['/signed-offers', () => handleSignedOffersGet(new Request(`https://x/signed-offers?${q}`), env())],
    ['/config/:chainId', () => handleConfigSnapshot(SERVED, env())],
    // #2654 — the reward metrics.
    ['/metrics/loop-closure', () => handleLoopClosure(new Request(`https://x/metrics/loop-closure?${q}`), env())],
    ['/metrics/recycling', () => handleRecyclingSeries(new Request(`https://x/metrics/recycling?${q}`), env())],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const res = await call();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain-not-configured' });
    });
  }
});

describe('the pre-resolve guard (#2654)', () => {
  // `/metrics/recycling` runs before `resolveEnv`, so its env carries the RPC
  // BINDING (a Secrets Store object on a deploy), never a resolved URL.
  const binding = { get: async () => 'http://127.0.0.1:9' };

  it('admits a chain whose deployment exists and whose RPC binding is present, unresolved', () => {
    expect(chainNotConfigured({ RPC_BASE_SEPOLIA: binding }, SERVED)).toBeNull();
  });

  it('refuses a chain with no binding, an empty one, or no deployment', async () => {
    for (const raw of [{}, { RPC_BASE_SEPOLIA: '' }, { RPC_BASE_SEPOLIA: null }]) {
      const res = chainNotConfigured(raw, SERVED);
      expect(res?.status).toBe(503);
      expect(await res?.json()).toEqual({ error: 'chain-not-configured' });
    }
    expect(chainNotConfigured({ RPC_BASE_SEPOLIA: binding }, 999_999)?.status).toBe(503);
  });

  it('serves the recycling series for a configured chain without resolving its secret', async () => {
    let resolved = 0;
    const counting = { get: async () => (resolved++, 'http://127.0.0.1:9') };
    const env = { DB: createSqliteD1(ALL_MIGRATIONS).d1, RPC_BASE_SEPOLIA: counting } as unknown as Env;
    const res = await handleRecyclingSeries(new Request(`https://x/metrics/recycling?chainId=${SERVED}`), env);
    expect(res.status).toBe(200);
    expect(resolved).toBe(0);
  });
});

describe('every handler that reads a chain id asks whether it is served', () => {
  // A handler that fails closed some other way, with the reason.
  const EXEMPT: Record<string, string> = {
    // Needs the chain's config object for the EIP-712 domain, so it asks
    // `chainConfig` and returns the same 503 itself.
    handleSignedOfferPost: 'fails closed through chainConfig',
  };
  // Each module's handlers and the guard they must ask. The recycling route
  // runs before `resolveEnv`, so it asks the pre-resolve guard (#2654).
  const MODULES: [string, string][] = [
    ['loanRoutes.ts', 'chainNotServed(env, chainId)'],
    ['offerRoutes.ts', 'chainNotServed(env, chainId)'],
    ['signedOfferRoutes.ts', 'chainNotServed(env, chainId)'],
    ['rewardRoutes.ts', 'chainNotServed(env, chainId)'],
    ['recycleRoutes.ts', 'chainNotConfigured(env, chainId)'],
  ];
  for (const [file, guard] of MODULES) {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const starts = [...src.matchAll(/^export async function (\w+)\(/gm)];
    for (const [i, m] of starts.entries()) {
      const name = m[1];
      const body = src.slice(m.index, starts[i + 1]?.index ?? src.length);
      // Only request handlers: a scheduled pass (`captureBackingSnapshot`)
      // reads a chain id but answers no request.
      if (!/chainId/.test(body) || !/\(\s*req: Request/.test(body) || name in EXEMPT) continue;
      it(`${file} ${name}`, () => {
        expect(body).toContain(guard);
      });
    }
  }

  it('no route module keeps a private copy of the guard or the parser', () => {
    for (const [file] of MODULES) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/function chainConfigured\(/);
      expect(src, file).not.toMatch(/function parseChainId\(/);
    }
  });
});
