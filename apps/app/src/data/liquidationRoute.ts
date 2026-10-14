/**
 * #2463 — the swap try-list a lender's close-out of a liquid, past-due loan
 * needs, from the agent Worker's `POST /liquidation-route`.
 *
 * `triggerDefault` on liquid, non-collapsed collateral reverts
 * `NoEnabledSwapRoute` on an empty try-list, by design (#1005 S9). The agent
 * builds the list with the same `@vaipakam/lib/swapRoutes` builder the keeper
 * runs, sizing the sale from the chain exactly as the contract does; the app
 * only asks for it and submits it. Nothing here ranks, encodes or prices a
 * route.
 *
 * Every way of not having a route is kept distinct, because each says
 * something different to a lender: no agent in this build, the agent could
 * not be reached or answered nonsense, or it answered and no venue can quote
 * the sale right now.
 */
import { useQuery } from '@tanstack/react-query';
import type { Hex } from 'viem';
import { agentOrigin } from './agentOrigin';

export interface LiquidationRoute {
  /** `LibSwap.AdapterCall[]`, best expected output first. Never empty. */
  calls: { adapterIdx: bigint; data: Hex }[];
  /** What the route sells: the loan's full collateral when the agent read
   *  it. Compared with the live loan immediately before submitting. */
  sellAmount: bigint;
  sellToken: string;
  buyToken: string;
}

export type LiquidationRouteRead =
  | { kind: 'route'; route: LiquidationRoute }
  /** The agent answered: no venue can quote this sale right now. */
  | { kind: 'none' }
  /** This build has no agent, so there is nothing to ask. */
  | { kind: 'unconfigured' }
  /** The agent could not be reached, refused, or answered something that
   *  is not a route. Says nothing about whether a route exists. */
  | { kind: 'unreadable' };

const TIMEOUT_MS = 15_000;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

/** Validate the agent's answer field by field; anything off is
 *  `unreadable`, never a partial route. Pure, so it is tested. */
export function parseLiquidationRoute(
  raw: unknown,
  expect: { chainId: number; loanId: string },
): LiquidationRouteRead {
  if (!raw || typeof raw !== 'object') return { kind: 'unreadable' };
  const o = raw as Record<string, unknown>;
  if (o.chainId !== expect.chainId || o.loanId !== expect.loanId) return { kind: 'unreadable' };
  if (typeof o.sellToken !== 'string' || !ADDR.test(o.sellToken)) return { kind: 'unreadable' };
  if (typeof o.buyToken !== 'string' || !ADDR.test(o.buyToken)) return { kind: 'unreadable' };
  if (typeof o.sellAmount !== 'string' || !UINT.test(o.sellAmount)) return { kind: 'unreadable' };
  if (!Array.isArray(o.calls)) return { kind: 'unreadable' };
  const calls: LiquidationRoute['calls'] = [];
  for (const c of o.calls) {
    if (!c || typeof c !== 'object') return { kind: 'unreadable' };
    const { adapterIdx, data } = c as Record<string, unknown>;
    if (typeof adapterIdx !== 'string' || !UINT.test(adapterIdx)) return { kind: 'unreadable' };
    if (typeof data !== 'string' || !HEX.test(data)) return { kind: 'unreadable' };
    calls.push({ adapterIdx: BigInt(adapterIdx), data: data as Hex });
  }
  if (calls.length === 0) return { kind: 'none' };
  return {
    kind: 'route',
    route: { calls, sellAmount: BigInt(o.sellAmount), sellToken: o.sellToken, buyToken: o.buyToken },
  };
}

/** Ask the agent for the route. Never throws. */
export async function fetchLiquidationRoute(chainId: number, loanId: string): Promise<LiquidationRouteRead> {
  const origin = agentOrigin();
  if (origin === null) return { kind: 'unconfigured' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/liquidation-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId, loanId }),
      signal: ctl.signal,
    });
    if (!res.ok) return { kind: 'unreadable' };
    return parseLiquidationRoute(await res.json(), { chainId, loanId });
  } catch {
    return { kind: 'unreadable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The route for the card's DISPLAY: whether a close-out can be offered.
 *  The submit path fetches a fresh one (`fetchLiquidationRoute`) rather than
 *  trusting this cached answer, because quotes and the collateral both
 *  move. Read only while `enabled` (the loan is `ready-needs-route`). */
export function useLiquidationRoute(chainId: number | undefined, loanId: string, enabled: boolean) {
  return useQuery<LiquidationRouteRead>({
    queryKey: ['liquidationRoute', chainId, loanId],
    enabled: enabled && chainId !== undefined,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: () => fetchLiquidationRoute(chainId!, loanId),
  });
}
