/** #3538 — the HF liquidator's check against a loan's fallback gate. */
import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { FORCED_SALE_FALLBACK_DEFERRED_TOPIC, SWAP_ADAPTER_SUCCEEDED_TOPIC } from '@vaipakam/lib/routeBuilder';
import { liquidationDeferredRefusal } from '../src/fallbackGate';

const DIAMOND: Address = '0x00000000000000000000000000000000000000d1';
const LOAN_TOPIC = `0x${(7).toString(16).padStart(64, '0')}`;

function client(gate: readonly [bigint, bigint, bigint] | null, ending: 'deferred' | 'sale') {
  let previews = 0;
  return {
    previews: () => previews,
    c: {
      readContract: async () => {
        if (gate === null) throw new Error('FunctionDoesNotExist');
        return gate;
      },
      simulateCalls: async () => {
        previews += 1;
        const t = ending === 'deferred' ? FORCED_SALE_FALLBACK_DEFERRED_TOPIC : SWAP_ADAPTER_SUCCEEDED_TOPIC;
        return { results: [{ status: 'success', logs: [{ address: DIAMOND, topics: [t, LOAN_TOPIC] }] }] };
      },
    } as unknown as PublicClient,
  };
}

const check = (c: PublicClient) =>
  liquidationDeferredRefusal({ client: c, diamond: DIAMOND, account: DIAMOND, loanId: 7n, data: '0x' });

describe('the liquidator and the fallback gate', () => {
  it('sends unread below the retry, and on a Diamond without the gate', async () => {
    for (const gate of [[0n, 0n, 0n] as const, [1n, 1n, 601n] as const, null]) {
      const f = client(gate, 'deferred');
      expect(await check(f.c)).toBeNull();
      expect(f.previews()).toBe(0);
    }
  });

  it('past the retry, holds back only a call that would be deferred again', async () => {
    const dead = client([2n, 1n, 601n], 'deferred');
    expect(await check(dead.c)).toMatch(/fallback opens at 601/);
    const live = client([2n, 1n, 601n], 'sale');
    expect(await check(live.c)).toBeNull();
  });
});
