import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import { NOT_WATCHED_KEYS, PLATFORM_CONTRACT_KEYS, addressKeys, watchedAddresses } from './watchedContracts.js';

describe('watchedAddresses', () => {
  it('classifies every address key in the deployment bundle', () => {
    const unclassified = new Set<string>();
    for (const record of Object.values(DEPLOYMENTS as unknown as Record<string, Record<string, unknown>>)) {
      for (const key of addressKeys(record).keys()) {
        if (!PLATFORM_CONTRACT_KEYS.has(key) && !NOT_WATCHED_KEYS.has(key)) unclassified.add(key);
      }
    }
    expect([...unclassified]).toEqual([]);
  });

  it('no key is both watched and not watched', () => {
    expect([...PLATFORM_CONTRACT_KEYS].filter((k) => NOT_WATCHED_KEYS.has(k))).toEqual([]);
  });

  it('watches platform contracts only: not people, implementations, outside tokens or another chain', () => {
    const a = (n: number) => '0x' + String(n).repeat(40);
    const w = watchedAddresses({
      diamond: a(1),
      vaultImpl: a(2),
      admin: a(3),
      weth: a(4),
      baseRewardDeployment: a(5),
      sanctions: { oracle: a(6) },
      facets: { x: a(7) },
      testnetMocks: { usdc: a(8) },
    });
    expect(w).toEqual([a(1), a(8)]);
    expect(watchedAddresses({ diamond: a(1), testnetMocks: { usdc: a(8) } }, { includeTestnetMocks: false })).toEqual([a(1)]);
  });
});
