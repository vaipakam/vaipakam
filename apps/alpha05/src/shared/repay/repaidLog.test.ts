import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { RepayFacetABI } from '@vaipakam/contracts/abis';
import { partialPrincipalAfter, repaidStatus } from './repaidLog';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const OTHER = '0x00000000000000000000000000000000000000e2' as const;
const PAYER = '0x00000000000000000000000000000000000000a3' as const;

function repaidLog(address: `0x${string}`, loanId: bigint, newStatus: number): Log {
  const topics = encodeEventTopics({ abi: RepayFacetABI as Abi, eventName: 'LoanRepaid', args: { loanId, repayer: PAYER } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }], [1n, 0n, 0n, 0n, newStatus]);
  return { address, topics, data } as unknown as Log;
}

function partialLog(address: `0x${string}`, loanId: bigint, newPrincipal: bigint): Log {
  const topics = encodeEventTopics({ abi: RepayFacetABI as Abi, eventName: 'PartialRepaid', args: { loanId } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [5n, newPrincipal, 0n]);
  return { address, topics, data } as unknown as Log;
}

describe('partialPrincipalAfter', () => {
  it('reads the principal the part payment left this loan with', () => {
    expect(partialPrincipalAfter([partialLog(DIAMOND, 7n, 95n)], DIAMOND, 7n)).toBe(95n);
  });
  it('ignores another loan, another contract and a full repayment', () => {
    expect(partialPrincipalAfter([partialLog(DIAMOND, 8n, 95n), partialLog(OTHER, 7n, 95n), repaidLog(DIAMOND, 7n, 1)], DIAMOND, 7n)).toBeNull();
  });
});

describe('repaidStatus', () => {
  it('reads the status the repayment left this loan in, from the Diamond’s own log', () => {
    expect(repaidStatus([repaidLog(DIAMOND, 7n, 1)], DIAMOND, 7n)).toBe(1);
  });
  it('ignores another loan and another contract', () => {
    expect(repaidStatus([repaidLog(DIAMOND, 8n, 1), repaidLog(OTHER, 7n, 1)], DIAMOND, 7n)).toBeNull();
  });
  it('is null when the transaction recorded no repayment', () => {
    expect(repaidStatus([], DIAMOND, 7n)).toBeNull();
  });
});
