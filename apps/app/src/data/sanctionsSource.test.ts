/**
 * #2439 — the banner must name the list that actually flagged a wallet.
 *
 * The failure this pins: a wallet sent to the wrong party — the provider of
 * a list that never flagged it, or anyone about a flag that came from its
 * declared recovery sender — or a read failure reported as a definite answer. Every branch of the attribution is here, with a stubbed
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
  classifyWallet,
  isNoSuchFunction,
  readSanctionsSource,
} from './sanctionsSource';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const ORACLE = '0x00000000000000000000000000000000000000c1' as const;
const UPSTREAM = '0x00000000000000000000000000000000000000b1' as const;
const SENDER = '0x00000000000000000000000000000000000000f1' as const;
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

/** A client whose `readContract` answers by function name — or, for an
 *  answer given as a function, by its arguments — and which records the block
 *  every read was pinned to. */
function client(answers: Record<string, Answer>, blocks: (bigint | undefined)[] = []): PublicClient {
  return {
    getBlockNumber: async () => {
      const a = answers.getBlockNumber ?? BLOCK;
      if (a instanceof Error) throw a;
      return a;
    },
    readContract: async ({
      functionName,
      args,
      blockNumber,
    }: {
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) => {
      blocks.push(blockNumber);
      if (!(functionName in answers)) throw new Error(`unexpected read ${functionName}`);
      let a = answers[functionName];
      if (typeof a === 'function') a = (a as (...x: unknown[]) => unknown)(...(args ?? []));
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as PublicClient;
}

const read = (answers: Record<string, Answer>) =>
  readSanctionsSource(client(answers), DIAMOND, WALLET);

/** A test list alone — no upstream: how the configure script deploys it. */
const alone = { getSanctionsOracle: ORACLE, upstream: zeroAddress };
/** A test list layered over another list. */
const layered = { getSanctionsOracle: ORACLE, upstream: UPSTREAM };
/** An oracle that is not a test list. */
const direct = { getSanctionsOracle: ORACLE, upstream: reverted('upstream') };
/** The wallet declared `SENDER` during recovery, and `SENDER` is listed. */
const bannedSender = {
  vaultBannedSource: SENDER,
  isSanctioned: (who: string) => who === SENDER,
};

describe('readSanctionsSource — a test list alone', () => {
  it('names the test list when it flags the wallet', async () => {
    expect(await read({ ...alone, flaggedByOverlay: true })).toBe('testList');
  });

  it('is unknown when nothing flags the wallet at the block read and no sender was declared', async () => {
    expect(await read({ ...alone, flaggedByOverlay: false, vaultBannedSource: zeroAddress })).toBe('unknown');
  });

  it('is unknown when the test list’s flag cannot be read', async () => {
    expect(await read({ ...alone, flaggedByOverlay: unreachable('flaggedByOverlay') })).toBe('unknown');
  });
});

describe('readSanctionsSource — a test list over another list', () => {
  it('names the test list alone when only it flags the wallet', async () => {
    expect(await read({ ...layered, sanctionSource: [true, false] })).toBe('testList');
  });

  it('names both when both lists flag the wallet', async () => {
    expect(await read({ ...layered, sanctionSource: [true, true] })).toBe('both');
  });

  it('names the other list when only it flags the wallet', async () => {
    expect(await read({ ...layered, sanctionSource: [false, true] })).toBe('otherList');
  });

  it('says the other list is unread when its read fails (upstream outage)', async () => {
    expect(
      await read({ ...layered, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: true }),
    ).toBe('testListUpstreamUnread');
  });

  it('is unknown when the other list is unreadable and the test list has not flagged the wallet', async () => {
    // Nothing is known about the wallet's own listing, so a declared sender
    // cannot be offered as the reason either.
    expect(
      await read({
        ...layered,
        sanctionSource: reverted('sanctionSource'),
        flaggedByOverlay: false,
        ...bannedSender,
      }),
    ).toBe('unknown');
  });
});

describe('readSanctionsSource — an oracle that is not a test list', () => {
  it('names the configured list when it flags the wallet at the block read', async () => {
    expect(await read({ ...direct, isSanctioned: true })).toBe('otherList');
  });

  it('treats empty upstream() data as "not a test list", the same as a revert', async () => {
    expect(await read({ ...direct, upstream: zeroData('upstream'), isSanctioned: true })).toBe('otherList');
  });

  it('is unknown, not the configured list, when it no longer flags the wallet at the block read', async () => {
    expect(await read({ ...direct, isSanctioned: false, vaultBannedSource: zeroAddress })).toBe('unknown');
  });

  it('is unknown when its screening read fails', async () => {
    expect(await read({ ...direct, isSanctioned: unreachable('isSanctioned') })).toBe('unknown');
  });

  it('is unknown when upstream() could not be reached at all', async () => {
    expect(await read({ ...direct, upstream: unreachable('upstream') })).toBe('unknown');
  });
});

describe('readSanctionsSource — a declared recovery sender', () => {
  it('names the declared sender when no list flags the wallet itself and the sender is listed', async () => {
    expect(await read({ ...direct, ...bannedSender })).toBe('bannedSource');
    expect(await read({ ...alone, flaggedByOverlay: false, ...bannedSender })).toBe('bannedSource');
  });

  it('prefers the wallet’s own listing: clearing the sender would not lift that', async () => {
    expect(await read({ ...alone, flaggedByOverlay: true, ...bannedSender })).toBe('testList');
    expect(
      await read({ ...direct, vaultBannedSource: SENDER, isSanctioned: () => true }),
    ).toBe('otherList');
  });

  it('is unknown when the declared sender is no longer listed at the block read', async () => {
    expect(
      await read({ ...direct, vaultBannedSource: SENDER, isSanctioned: () => false }),
    ).toBe('unknown');
  });

  it('is unknown when the declared sender cannot be read', async () => {
    expect(
      await read({ ...direct, isSanctioned: false, vaultBannedSource: unreachable('vaultBannedSource') }),
    ).toBe('unknown');
    expect(
      await read({
        ...direct,
        vaultBannedSource: SENDER,
        isSanctioned: (who: string) => (who === SENDER ? unreachable('isSanctioned') : false),
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

  it('pins every read on a layered test list to the same block', async () => {
    const blocks: (bigint | undefined)[] = [];
    await readSanctionsSource(
      client({ ...layered, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: true }, blocks),
      DIAMOND,
      WALLET,
    );
    // oracle, upstream, sanctionSource, flaggedByOverlay
    expect(blocks).toHaveLength(4);
    expect(blocks.every((b) => b === BLOCK)).toBe(true);
  });

  it('pins every read on the declared-sender path to the same block', async () => {
    const blocks: (bigint | undefined)[] = [];
    await readSanctionsSource(client({ ...direct, ...bannedSender }, blocks), DIAMOND, WALLET);
    // oracle, upstream, isSanctioned(wallet), vaultBannedSource, isSanctioned(sender)
    expect(blocks).toHaveLength(5);
    expect(blocks.every((b) => b === BLOCK)).toBe(true);
  });
});

describe('classifyWallet', () => {
  it('a direct oracle: its answer, or unread', () => {
    expect(classifyWallet({ kind: 'direct', flagged: true })).toBe('otherList');
    expect(classifyWallet({ kind: 'direct', flagged: false })).toBe('notFlagged');
    expect(classifyWallet({ kind: 'direct', flagged: null })).toBe('unread');
  });
  it('a test list with no upstream is the whole list, whatever byUpstream says', () => {
    const base = { kind: 'overlay', upstream: zeroAddress, byOverlay: true } as const;
    expect(classifyWallet({ ...base, byUpstream: null })).toBe('testList');
    expect(classifyWallet({ ...base, byUpstream: true })).toBe('testList');
  });
  it('never names a list that the snapshot does not show flagging', () => {
    const base = { kind: 'overlay', upstream: UPSTREAM, byOverlay: false } as const;
    expect(classifyWallet({ ...base, byUpstream: false })).toBe('notFlagged');
    expect(classifyWallet({ ...base, byUpstream: null })).toBe('unread');
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
