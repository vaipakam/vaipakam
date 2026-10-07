/**
 * #2439 — the banner must name the list that actually flagged a wallet.
 *
 * The failure this pins: a wallet flagged only by a test network's test list
 * being told to contact Chainalysis, or a read failure being reported as a
 * definite answer. Every branch of the attribution is here, with a stubbed
 * client standing in for the chain.
 */
import { describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  zeroAddress,
  type Abi,
  type PublicClient,
} from 'viem';
import {
  classifySanctionsSource,
  isNoSuchFunction,
  readSanctionsSource,
} from './sanctionsSource';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const ORACLE = '0x00000000000000000000000000000000000000c1' as const;
const CHAINALYSIS = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb' as const;
const WALLET = '0x00000000000000000000000000000000000000a1' as const;

const ABI: Abi = [];

function reverted(fn: string): Error {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: ABI, functionName: fn }),
    { abi: ABI, functionName: fn },
  );
}
function zeroData(fn: string): Error {
  return new ContractFunctionExecutionError(
    new ContractFunctionZeroDataError({ functionName: fn }),
    { abi: ABI, functionName: fn },
  );
}
function unreachable(fn: string): Error {
  return new ContractFunctionExecutionError(
    new HttpRequestError({ url: 'https://rpc.invalid' }),
    { abi: ABI, functionName: fn },
  );
}

type Answer = unknown | Error;

/** A client whose `readContract` answers by function name. */
function client(answers: Record<string, Answer>): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (!(functionName in answers)) throw new Error(`unexpected read ${functionName}`);
      const a = answers[functionName];
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as PublicClient;
}

const read = (answers: Record<string, Answer>) =>
  readSanctionsSource(client(answers), DIAMOND, WALLET);

describe('readSanctionsSource', () => {
  it('names the provider when the oracle is the provider’s own (no upstream() on it: revert)', async () => {
    expect(await read({ getSanctionsOracle: ORACLE, upstream: reverted('upstream') })).toBe('provider');
  });

  it('names the provider when the oracle answers upstream() with empty data', async () => {
    expect(await read({ getSanctionsOracle: ORACLE, upstream: zeroData('upstream') })).toBe('provider');
  });

  it('does NOT name the provider when upstream() could not be reached at all', async () => {
    expect(await read({ getSanctionsOracle: ORACLE, upstream: unreachable('upstream') })).toBe('unknown');
  });

  it('names the provider on a test list that has not flagged the wallet', async () => {
    expect(
      await read({ getSanctionsOracle: ORACLE, upstream: CHAINALYSIS, flaggedByOverlay: false }),
    ).toBe('provider');
  });

  it('names the test list alone when only it flags the wallet', async () => {
    expect(
      await read({
        getSanctionsOracle: ORACLE,
        upstream: CHAINALYSIS,
        flaggedByOverlay: true,
        sanctionSource: [true, false],
      }),
    ).toBe('testList');
  });

  it('names both when both lists flag the wallet', async () => {
    expect(
      await read({
        getSanctionsOracle: ORACLE,
        upstream: CHAINALYSIS,
        flaggedByOverlay: true,
        sanctionSource: [true, true],
      }),
    ).toBe('both');
  });

  it('says the provider side is unread when the attribution read fails (upstream outage)', async () => {
    expect(
      await read({
        getSanctionsOracle: ORACLE,
        upstream: CHAINALYSIS,
        flaggedByOverlay: true,
        sanctionSource: reverted('sanctionSource'),
      }),
    ).toBe('testListProviderUnread');
  });

  it('names the test list alone on a network the provider does not cover', async () => {
    expect(
      await read({ getSanctionsOracle: ORACLE, upstream: zeroAddress, flaggedByOverlay: true }),
    ).toBe('testList');
  });

  it('is unknown when the Diamond’s oracle cannot be read', async () => {
    expect(await read({ getSanctionsOracle: unreachable('getSanctionsOracle') })).toBe('unknown');
  });

  it('is unknown when no oracle is configured (nothing to attribute to)', async () => {
    expect(await read({ getSanctionsOracle: zeroAddress })).toBe('unknown');
  });

  it('is unknown when the test list’s own flag cannot be read', async () => {
    expect(
      await read({
        getSanctionsOracle: ORACLE,
        upstream: CHAINALYSIS,
        flaggedByOverlay: unreachable('flaggedByOverlay'),
      }),
    ).toBe('unknown');
  });
});

describe('classifySanctionsSource', () => {
  it('a non-overlay oracle is the provider', () => {
    expect(classifySanctionsSource('notOverlay')).toBe('provider');
  });
  it('an overlay flag with no upstream is the test list, whatever byUpstream says', () => {
    expect(classifySanctionsSource({ upstream: zeroAddress, byOverlay: true, byUpstream: null })).toBe(
      'testList',
    );
  });
});

describe('isNoSuchFunction', () => {
  it('accepts a revert and empty data, rejects transport failures and plain errors', () => {
    expect(isNoSuchFunction(reverted('x'))).toBe(true);
    expect(isNoSuchFunction(zeroData('x'))).toBe(true);
    expect(isNoSuchFunction(unreachable('x'))).toBe(false);
    expect(isNoSuchFunction(new Error('x'))).toBe(false);
  });
});
