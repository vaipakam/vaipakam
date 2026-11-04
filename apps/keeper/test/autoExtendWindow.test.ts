import { describe, it, expect } from 'vitest';
import { BaseError, ContractFunctionRevertedError, toFunctionSelector, type Address } from 'viem';
import { AutoLifecycleFacetABI } from '@vaipakam/contracts/abis';
import {
  EXTEND_FUNDING_SELECTOR,
  contractWindowVerdict,
  fundingVerdict,
  readContractWindow,
  readFundingVerdict,
} from '../src/autoLifecycle';

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

describe('extension funding (#2814)', () => {
  const ASSET = '0x00000000000000000000000000000000000000a5' as Address;
  const HOLDER = '0x00000000000000000000000000000000000000b0' as Address;

  it('asks the loupe about getExtendFunding(uint256,address)', () => {
    expect(EXTEND_FUNDING_SELECTOR).toBe(toFunctionSelector('getExtendFunding(uint256,address)'));
  });

  it('passes an extension the reserve and the other free balance cover together', () => {
    expect(fundingVerdict({ asset: ASSET, reserved: 60n, otherFree: 40n, chargeNow: 100n })).toBeNull();
    expect(fundingVerdict({ asset: ASSET, reserved: 100n, otherFree: 0n, chargeNow: 100n })).toBeNull();
    expect(fundingVerdict({ asset: ASSET, reserved: 0n, otherFree: 100n, chargeNow: 100n })).toBeNull();
  });

  it('names the three figures when the two fall short', () => {
    expect(fundingVerdict({ asset: ASSET, reserved: 60n, otherFree: 39n, chargeNow: 100n })).toBe(
      `unfunded: reserve 60 + other free 39 < charge 100 (asset ${ASSET})`,
    );
  });

  it('reads the holder\'s funding for the loan from the view', async () => {
    const client = {
      readContract: async (req: { functionName: string; args?: readonly unknown[] }) => {
        expect(req.functionName).toBe('getExtendFunding');
        expect(req.args).toEqual([7n, HOLDER]);
        return [ASSET, 10n, 5n, 20n, 30n] as const;
      },
    };
    expect(await readFundingVerdict(client as never, DIAMOND, 7n, HOLDER)).toBe(
      `unfunded: reserve 10 + other free 5 < charge 20 (asset ${ASSET})`,
    );
  });

  it('leaves the loan for the next run when the view does not read', async () => {
    const client = { readContract: async () => { throw new Error('rpc down'); } };
    expect(await readFundingVerdict(client as never, DIAMOND, 7n, HOLDER)).toMatch(/^funding unread — /);
  });
});
