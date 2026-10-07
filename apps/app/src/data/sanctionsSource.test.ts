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

const BLOCK = 123_456n;

/** A client whose `readContract` answers by function name, and which records
 *  the block every read was pinned to. */
function client(answers: Record<string, Answer>, blocks: (bigint | undefined)[] = []): PublicClient {
  return {
    getBlockNumber: async () => {
      const a = answers.getBlockNumber ?? BLOCK;
      if (a instanceof Error) throw a;
      return a;
    },
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      blocks.push(blockNumber);
      if (!(functionName in answers)) throw new Error(`unexpected read ${functionName}`);
      const a = answers[functionName];
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as PublicClient;
}

const read = (answers: Record<string, Answer>) =>
  readSanctionsSource(client(answers), DIAMOND, WALLET);

const overlay = { getSanctionsOracle: ORACLE, upstream: CHAINALYSIS };

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

  it('names the provider when the test list reads the provider as flagging and has not flagged it', async () => {
    expect(await read({ ...overlay, sanctionSource: [false, true] })).toBe('provider');
  });

  it('names the test list alone when only it flags the wallet', async () => {
    expect(await read({ ...overlay, sanctionSource: [true, false] })).toBe('testList');
  });

  it('names both when both lists flag the wallet', async () => {
    expect(await read({ ...overlay, sanctionSource: [true, true] })).toBe('both');
  });

  it('is unknown, not the provider, when neither list flags the wallet at the block read', async () => {
    // The banner's own check said flagged; by the attribution's block the
    // test-list flag was cleared. Naming the provider here would send the user
    // to a list that never flagged them.
    expect(await read({ ...overlay, sanctionSource: [false, false] })).toBe('unknown');
  });

  it('says the provider side is unread when the provider read fails (upstream outage)', async () => {
    expect(
      await read({ ...overlay, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: true }),
    ).toBe('testListProviderUnread');
  });

  it('is unknown when the provider is unreadable and the test list has not flagged the wallet', async () => {
    expect(
      await read({ ...overlay, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: false }),
    ).toBe('unknown');
  });

  it('says there is no provider list on a network the provider does not cover', async () => {
    expect(
      await read({ getSanctionsOracle: ORACLE, upstream: zeroAddress, flaggedByOverlay: true }),
    ).toBe('testListNoProvider');
  });

  it('is unknown on a no-provider network when the test list has not flagged the wallet', async () => {
    expect(
      await read({ getSanctionsOracle: ORACLE, upstream: zeroAddress, flaggedByOverlay: false }),
    ).toBe('unknown');
  });

  it('is unknown when the Diamond’s oracle cannot be read', async () => {
    expect(await read({ getSanctionsOracle: unreachable('getSanctionsOracle') })).toBe('unknown');
  });

  it('is unknown when no oracle is configured (nothing to attribute to)', async () => {
    expect(await read({ getSanctionsOracle: zeroAddress })).toBe('unknown');
  });

  it('is unknown when the test list’s own flag cannot be read either', async () => {
    expect(
      await read({
        ...overlay,
        sanctionSource: reverted('sanctionSource'),
        flaggedByOverlay: unreachable('flaggedByOverlay'),
      }),
    ).toBe('unknown');
  });

  it('is unknown when the current block cannot be read', async () => {
    expect(await read({ getBlockNumber: unreachable('getBlockNumber') })).toBe('unknown');
  });

  it('pins every read to the same block', async () => {
    const blocks: (bigint | undefined)[] = [];
    await readSanctionsSource(
      client({ ...overlay, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: true }, blocks),
      DIAMOND,
      WALLET,
    );
    expect(blocks).toHaveLength(4);
    expect(blocks.every((b) => b === BLOCK)).toBe(true);
  });
});

describe('classifySanctionsSource', () => {
  it('a non-overlay oracle is the provider', () => {
    expect(classifySanctionsSource('notOverlay')).toBe('provider');
  });
  it('an overlay flag with no upstream is the no-provider test list, whatever byUpstream says', () => {
    expect(classifySanctionsSource({ upstream: zeroAddress, byOverlay: true, byUpstream: null })).toBe(
      'testListNoProvider',
    );
    expect(classifySanctionsSource({ upstream: zeroAddress, byOverlay: true, byUpstream: false })).toBe(
      'testListNoProvider',
    );
  });
  it('never names a list that the snapshot does not show flagging', () => {
    expect(classifySanctionsSource({ upstream: CHAINALYSIS, byOverlay: false, byUpstream: false })).toBe(
      'unknown',
    );
    expect(classifySanctionsSource({ upstream: CHAINALYSIS, byOverlay: false, byUpstream: null })).toBe(
      'unknown',
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
