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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHAINALYSIS_ORACLE_OWNER,
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

const OWNED = { owner: CHAINALYSIS_ORACLE_OWNER };
const STRANGER = '0x00000000000000000000000000000000000000e1' as const;
/** A test list over Chainalysis's own oracle. */
const overlay = { getSanctionsOracle: ORACLE, upstream: CHAINALYSIS, ...OWNED };
/** Chainalysis's own oracle, configured directly. */
const direct = { getSanctionsOracle: ORACLE, upstream: reverted('upstream'), ...OWNED };

describe('readSanctionsSource — a direct oracle', () => {
  it('names the provider when the oracle is Chainalysis’s own and flags the wallet', async () => {
    expect(await read({ ...direct, isSanctioned: true })).toBe('provider');
  });

  it('treats empty upstream() data as "not a test list", the same as a revert', async () => {
    expect(await read({ ...direct, upstream: zeroData('upstream'), isSanctioned: true })).toBe('provider');
  });

  it('is unknown, not the provider, when Chainalysis no longer flags the wallet at the block read', async () => {
    // The banner's own check said flagged; by the attribution's block the
    // provider had delisted the wallet.
    expect(await read({ ...direct, isSanctioned: false })).toBe('unknown');
  });

  it('is unknown when the provider’s screening read fails', async () => {
    expect(await read({ ...direct, isSanctioned: unreachable('isSanctioned') })).toBe('unknown');
  });

  it('does NOT name Chainalysis for an oracle owned by anyone else', async () => {
    expect(await read({ ...direct, owner: STRANGER, isSanctioned: true })).toBe('unknown');
  });

  it('does NOT name Chainalysis for an oracle with no owner() at all', async () => {
    expect(await read({ ...direct, owner: reverted('owner'), isSanctioned: true })).toBe('unknown');
  });

  it('does NOT name the provider when upstream() could not be reached at all', async () => {
    expect(await read({ ...direct, upstream: unreachable('upstream') })).toBe('unknown');
  });
});

describe('readSanctionsSource — a test list', () => {
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
    expect(await read({ ...overlay, sanctionSource: [false, false] })).toBe('unknown');
  });

  it('does NOT name Chainalysis for an upstream that is not Chainalysis’s own', async () => {
    expect(await read({ ...overlay, owner: STRANGER, sanctionSource: [false, true] })).toBe('unknown');
    expect(await read({ ...overlay, owner: STRANGER, sanctionSource: [true, true] })).toBe(
      'testListProviderUnread',
    );
    expect(await read({ ...overlay, owner: STRANGER, sanctionSource: [true, false] })).toBe(
      'testListProviderUnread',
    );
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

  it('is unknown when the test list’s own flag cannot be read either', async () => {
    expect(
      await read({
        ...overlay,
        sanctionSource: reverted('sanctionSource'),
        flaggedByOverlay: unreachable('flaggedByOverlay'),
      }),
    ).toBe('unknown');
  });
});

describe('readSanctionsSource — reads', () => {
  it('is unknown when the Diamond’s oracle cannot be read', async () => {
    expect(await read({ getSanctionsOracle: unreachable('getSanctionsOracle') })).toBe('unknown');
  });

  it('is unknown when no oracle is configured (nothing to attribute to)', async () => {
    expect(await read({ getSanctionsOracle: zeroAddress })).toBe('unknown');
  });

  it('is unknown when the current block cannot be read', async () => {
    expect(await read({ getBlockNumber: unreachable('getBlockNumber') })).toBe('unknown');
  });

  it('pins every read on a test list to the same block', async () => {
    const blocks: (bigint | undefined)[] = [];
    await readSanctionsSource(
      client({ ...overlay, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: true }, blocks),
      DIAMOND,
      WALLET,
    );
    // oracle, upstream, upstream's owner, sanctionSource, flaggedByOverlay
    expect(blocks).toHaveLength(5);
    expect(blocks.every((b) => b === BLOCK)).toBe(true);
  });

  it('pins every read on a direct oracle to the same block', async () => {
    const blocks: (bigint | undefined)[] = [];
    await readSanctionsSource(client({ ...direct, isSanctioned: true }, blocks), DIAMOND, WALLET);
    // oracle, upstream, owner, isSanctioned
    expect(blocks).toHaveLength(4);
    expect(blocks.every((b) => b === BLOCK)).toBe(true);
  });
});

describe('classifySanctionsSource', () => {
  it('names a direct oracle only when it is the provider’s own and flags the wallet', () => {
    expect(classifySanctionsSource({ kind: 'direct', isProvider: true, flagged: true })).toBe('provider');
    expect(classifySanctionsSource({ kind: 'direct', isProvider: true, flagged: false })).toBe('unknown');
    expect(classifySanctionsSource({ kind: 'direct', isProvider: true, flagged: null })).toBe('unknown');
    expect(classifySanctionsSource({ kind: 'direct', isProvider: false, flagged: true })).toBe('unknown');
  });
  it('an overlay flag with no upstream is the no-provider test list, whatever byUpstream says', () => {
    const base = { kind: 'overlay', upstream: zeroAddress, upstreamIsProvider: false, byOverlay: true } as const;
    expect(classifySanctionsSource({ ...base, byUpstream: null })).toBe('testListNoProvider');
    expect(classifySanctionsSource({ ...base, byUpstream: false })).toBe('testListNoProvider');
  });
  it('never names a list that the snapshot does not show flagging', () => {
    const base = { kind: 'overlay', upstream: CHAINALYSIS, upstreamIsProvider: true, byOverlay: false } as const;
    expect(classifySanctionsSource({ ...base, byUpstream: false })).toBe('unknown');
    expect(classifySanctionsSource({ ...base, byUpstream: null })).toBe('unknown');
  });
});

describe('CHAINALYSIS_ORACLE_OWNER', () => {
  it('is the owner the configure script verifies before pointing a Diamond at Chainalysis', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../../../../contracts/script/ConfigureSanctionsOracle.s.sol', import.meta.url)),
      'utf8',
    );
    const m = script.match(/CHAINALYSIS_OWNER\s*=\s*(0x[0-9a-fA-F]{40})/);
    expect(m?.[1]).toBe(CHAINALYSIS_ORACLE_OWNER);
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
