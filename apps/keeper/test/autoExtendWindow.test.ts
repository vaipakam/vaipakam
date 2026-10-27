import { describe, it, expect } from 'vitest';
import { BaseError, ContractFunctionRevertedError, type Address } from 'viem';
import { AutoLifecycleFacetABI } from '@vaipakam/contracts/abis';
import { contractWindowVerdict, readContractWindow } from '../src/autoLifecycle';

const DAY = 86_400n;
const DIAMOND = '0x00000000000000000000000000000000000d1a30' as Address;

/** A read that reverts with `errorName`, the way viem surfaces one. */
function revert(errorName: string): Error {
  const inner = new ContractFunctionRevertedError({
    abi: AutoLifecycleFacetABI as never,
    functionName: 'getAutoExtendWindow',
    data: '0x',
  });
  (inner as { data?: unknown }).data = { errorName, args: [] };
  return new BaseError('reverted', { cause: inner });
}

describe('contract window (#2738)', () => {
  const OPENS = 1_800_000_000n;
  const CLOSES = OPENS + 6n * DAY;

  it('is open between the published bounds, both inclusive', () => {
    expect(contractWindowVerdict(OPENS, CLOSES, OPENS - 1n)).toBe(`window opens at ${OPENS}`);
    expect(contractWindowVerdict(OPENS, CLOSES, OPENS)).toBeNull();
    expect(contractWindowVerdict(OPENS, CLOSES, CLOSES)).toBeNull();
    expect(contractWindowVerdict(OPENS, CLOSES, CLOSES + 1n)).toBe(`past grace (ended ${CLOSES})`);
  });

  it('reads the loan\'s window from the view', async () => {
    const client = {
      readContract: async (req: { functionName: string; args?: readonly unknown[] }) => {
        expect(req.functionName).toBe('getAutoExtendWindow');
        expect(req.args).toEqual([7n]);
        return [OPENS, CLOSES] as const;
      },
    };
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS + DAY)).toBeNull();
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS - DAY)).toMatch(/^window opens at /);
  });

  it('skips a loan that left Active since its page was read', async () => {
    const client = { readContract: async () => { throw revert('LoanNotActive'); } };
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS)).toBe('no longer active');
  });

  it('leaves the loan for the next run when the view does not read', async () => {
    const client = { readContract: async () => { throw new Error('rpc down'); } };
    expect(await readContractWindow(client as never, DIAMOND, 7n, OPENS)).toMatch(/^window unread — /);
  });
});
