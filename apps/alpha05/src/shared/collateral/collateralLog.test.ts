import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { AddCollateralFacetABI } from '@vaipakam/contracts/abis';
import { collateralAdded, curedFromFallback } from './collateralLog';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const OTHER = '0x00000000000000000000000000000000000000e2' as const;
const PAYER = '0x00000000000000000000000000000000000000a3' as const;
const ABI = AddCollateralFacetABI as Abi;

function added(address: `0x${string}`, loanId: bigint, after: bigint): Log {
  const topics = encodeEventTopics({ abi: ABI, eventName: 'CollateralAdded', args: { loanId, borrower: PAYER } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [5n, after, 2n * 10n ** 18n, 4000n]);
  return { address, topics, data } as unknown as Log;
}

function cured(address: `0x${string}`, loanId: bigint): Log {
  const topics = encodeEventTopics({ abi: ABI, eventName: 'LoanCuredFromFallback', args: { loanId, borrower: PAYER } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [10n, 2n * 10n ** 18n]);
  return { address, topics, data } as unknown as Log;
}

describe('collateralAdded', () => {
  it('reads the collateral and the protocol’s figures after the top-up', () => {
    expect(collateralAdded([added(DIAMOND, 7n, 15n)], DIAMOND, 7n)).toEqual({ newCollateralAmount: 15n, newHf: 2n * 10n ** 18n, newLtv: 4000n });
  });
  it('ignores another loan and another contract', () => {
    expect(collateralAdded([added(DIAMOND, 8n, 15n), added(OTHER, 7n, 15n)], DIAMOND, 7n)).toBeNull();
  });
});

describe('curedFromFallback', () => {
  it('is true only for this loan’s cure, from the Diamond', () => {
    expect(curedFromFallback([cured(DIAMOND, 7n)], DIAMOND, 7n)).toBe(true);
    expect(curedFromFallback([cured(DIAMOND, 8n), cured(OTHER, 7n)], DIAMOND, 7n)).toBe(false);
  });
});
