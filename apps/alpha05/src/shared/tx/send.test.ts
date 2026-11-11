import { ContractFunctionRevertedError, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { GAS_LIMIT_MARGIN_PCT } from '@vaipakam/lib/gasLimit';
import { gasLimitThrough } from './send';

const abi = parseAbi(['function repayLoan(uint256)']);
const revert = () => new ContractFunctionRevertedError({ abi, functionName: 'repayLoan', message: 'LoanNotActive' });

describe('gasLimitThrough (RB-GAS)', () => {
  it('sends with the shared margin on the first estimate, never the bare estimate', async () => {
    expect(GAS_LIMIT_MARGIN_PCT).toBe(30n);
    expect(await gasLimitThrough([async () => 100_000n])).toBe(130_000n);
    // Rounded up, so the margin is never shaved by integer division.
    expect(await gasLimitThrough([async () => 101n])).toBe(132n);
  });

  it('asks the wallet first and the app’s endpoints only when the wallet cannot answer', async () => {
    const asked: string[] = [];
    const g = await gasLimitThrough([
      async () => {
        asked.push('wallet');
        throw new Error('provider timeout');
      },
      async () => {
        asked.push('proxy');
        return 200_000n;
      },
    ]);
    expect(asked).toEqual(['wallet', 'proxy']);
    expect(g).toBe(260_000n);
  });

  it('sets no limit when the call reverts, so the wallet reports the refusal itself', async () => {
    let later = false;
    const g = await gasLimitThrough([
      async () => {
        throw revert();
      },
      async () => {
        later = true;
        return 1n;
      },
    ]);
    expect(g).toBeUndefined();
    expect(later).toBe(false);
  });

  it('sets no limit when no source can estimate at all', async () => {
    const g = await gasLimitThrough([
      async () => {
        throw new Error('down');
      },
      async () => {
        throw new Error('down too');
      },
    ]);
    expect(g).toBeUndefined();
  });
});
