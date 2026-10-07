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
  classifySubject,
  explain,
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
const HASH = `0x${'aa'.repeat(32)}` as const;
const OTHER_HASH = `0x${'bb'.repeat(32)}` as const;

/** A client whose `readContract` answers by function name — or, for an
 *  answer given as a function, by its arguments — and which records the block
 *  every read was pinned to. */
function client(answers: Record<string, Answer>, blocks: (bigint | undefined)[] = []): PublicClient {
  return {
    // `getBlock` answers by call order when given a function, so a test can
    // replace the pinned block between the first and the second look.
    getBlock: async (params: { blockTag?: string; blockNumber?: bigint }) => {
      let a: unknown = answers.getBlock ?? { number: BLOCK, hash: HASH };
      if (typeof a === 'function') a = (a as (p: unknown) => unknown)(params);
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

/** Each oracle fixture declares no recovery sender unless a test adds one;
 *  the sender is read on every path, flagged wallet or not. */

/** A test list alone — no upstream: how the configure script deploys it. */
const alone = { getSanctionsOracle: ORACLE, upstream: zeroAddress, vaultBannedSource: zeroAddress };
/** A test list layered over another list. */
const layered = { getSanctionsOracle: ORACLE, upstream: UPSTREAM, vaultBannedSource: zeroAddress };
/** An oracle that is not a test list. */
const direct = {
  getSanctionsOracle: ORACLE,
  upstream: reverted('upstream'),
  vaultBannedSource: zeroAddress,
};
/** The wallet declared `SENDER` during recovery, and `SENDER` is listed. */
const bannedSender = {
  vaultBannedSource: SENDER,
  isSanctioned: (who: string) => who === SENDER,
};

describe('readSanctionsSource — a test list alone', () => {
  it('names the test list when it flags the wallet', async () => {
    expect(await read({ ...alone, flaggedByOverlay: true })).toEqual(['testList']);
  });

  it('is unknown when nothing flags the wallet at the block read and no sender was declared', async () => {
    expect(await read({ ...alone, flaggedByOverlay: false, vaultBannedSource: zeroAddress })).toEqual(['unknown']);
  });

  it('is unknown when the test list’s flag cannot be read', async () => {
    expect(await read({ ...alone, flaggedByOverlay: unreachable('flaggedByOverlay') })).toEqual(['unknown']);
  });
});

describe('readSanctionsSource — a test list over another list', () => {
  it('names the test list alone when only it flags the wallet', async () => {
    expect(await read({ ...layered, sanctionSource: [true, false] })).toEqual(['testList']);
  });

  it('names both when both lists flag the wallet', async () => {
    expect(await read({ ...layered, sanctionSource: [true, true] })).toEqual(['both']);
  });

  it('names the other list when only it flags the wallet', async () => {
    expect(await read({ ...layered, sanctionSource: [false, true] })).toEqual(['otherList']);
  });

  it('says the other list is unread when its read fails (upstream outage)', async () => {
    expect(
      await read({ ...layered, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: true }),
    ).toEqual(['testListUpstreamUnread']);
  });

  it('is unknown when the other list is unreadable and the test list has not flagged the wallet', async () => {
    // Neither subject can be told: the outage hides the other list's answer
    // for the wallet and for its declared sender alike.
    expect(
      await read({
        ...layered,
        sanctionSource: reverted('sanctionSource'),
        flaggedByOverlay: false,
        ...bannedSender,
      }),
    ).toEqual(['unknown']);
  });
});

describe('readSanctionsSource — an oracle that is not a test list', () => {
  it('names the configured list when it flags the wallet at the block read', async () => {
    expect(await read({ ...direct, isSanctioned: true })).toEqual(['otherList']);
  });

  it('treats empty upstream() data as "not a test list", the same as a revert', async () => {
    expect(await read({ ...direct, upstream: zeroData('upstream'), isSanctioned: true })).toEqual(['otherList']);
  });

  it('is unknown, not the configured list, when it no longer flags the wallet at the block read', async () => {
    expect(await read({ ...direct, isSanctioned: false, vaultBannedSource: zeroAddress })).toEqual(['unknown']);
  });

  it('is unknown when its screening read fails', async () => {
    expect(await read({ ...direct, isSanctioned: unreachable('isSanctioned') })).toEqual(['unknown']);
  });

  it('is unknown when upstream() could not be reached at all', async () => {
    expect(await read({ ...direct, upstream: unreachable('upstream') })).toEqual(['unknown']);
  });
});

describe('readSanctionsSource — a declared recovery sender', () => {
  /** A test-list answer per address: `listed` are on the test list. */
  const overlayFlags =
    (...listed: string[]) =>
    (who: string) =>
      listed.includes(who);

  it('names the sender as the cause, and the list that flags it, when no list flags the wallet itself', async () => {
    expect(await read({ ...direct, ...bannedSender })).toEqual(['bannedSource', 'senderOtherList']);
    expect(
      await read({ ...alone, vaultBannedSource: SENDER, flaggedByOverlay: overlayFlags(SENDER) }),
    ).toEqual(['bannedSource', 'senderTestList']);
  });

  it('keeps each subject’s own list on a layered test list', async () => {
    // The wallet is on the test list; its sender only on the list it extends.
    expect(
      await read({
        ...layered,
        vaultBannedSource: SENDER,
        sanctionSource: (who: string) => (who === SENDER ? [false, true] : [true, false]),
      }),
    ).toEqual(['testList', 'alsoBannedSource', 'senderOtherList']);
  });

  it('names both reasons when the wallet and its declared sender are flagged: clearing one alone would not lift the flag', async () => {
    expect(
      await read({ ...alone, vaultBannedSource: SENDER, flaggedByOverlay: overlayFlags(WALLET, SENDER) }),
    ).toEqual(['testList', 'alsoBannedSource', 'senderTestList']);
    expect(
      await read({ ...direct, vaultBannedSource: SENDER, isSanctioned: () => true }),
    ).toEqual(['otherList', 'alsoBannedSource', 'senderOtherList']);
  });

  it('keeps a sender established by the test list when the wallet’s own reading fails (upstream outage)', async () => {
    expect(
      await read({
        ...layered,
        vaultBannedSource: SENDER,
        sanctionSource: reverted('sanctionSource'),
        flaggedByOverlay: overlayFlags(SENDER),
      }),
    ).toEqual(['bannedSourceWalletUnread', 'senderTestListUpstreamUnread']);
  });

  it('says a declared sender is unread when its screening read fails', async () => {
    expect(
      await read({
        ...direct,
        vaultBannedSource: SENDER,
        isSanctioned: (who: string) => (who === SENDER ? unreachable('isSanctioned') : true),
      }),
    ).toEqual(['otherList', 'bannedSourceUnread']);
  });

  it('does not assert a declared sender when the lookup itself fails', async () => {
    expect(
      await read({ ...alone, flaggedByOverlay: true, vaultBannedSource: unreachable('vaultBannedSource') }),
    ).toEqual(['testList', 'senderLookupUnread']);
  });

  it('names the wallet’s own listing alone when its declared sender is not flagged', async () => {
    expect(
      await read({ ...alone, vaultBannedSource: SENDER, flaggedByOverlay: overlayFlags(WALLET) }),
    ).toEqual(['testList']);
  });

  it('is unknown when the declared sender is no longer flagged and nothing flags the wallet', async () => {
    expect(
      await read({ ...direct, vaultBannedSource: SENDER, isSanctioned: () => false }),
    ).toEqual(['unknown']);
  });

  it('is unknown when nothing about either subject could be established', async () => {
    expect(
      await read({ ...direct, isSanctioned: false, vaultBannedSource: unreachable('vaultBannedSource') }),
    ).toEqual(['unknown']);
    expect(
      await read({
        ...direct,
        vaultBannedSource: SENDER,
        isSanctioned: (who: string) => (who === SENDER ? unreachable('isSanctioned') : false),
      }),
    ).toEqual(['unknown']);
    expect(
      await read({ ...direct, isSanctioned: unreachable('isSanctioned'), vaultBannedSource: zeroAddress }),
    ).toEqual(['unknown']);
  });
});

describe('readSanctionsSource — reads', () => {
  it('is unknown when the Diamond’s oracle cannot be read', async () => {
    expect(await read({ getSanctionsOracle: unreachable('getSanctionsOracle') })).toEqual(['unknown']);
  });

  it('is unknown when no oracle is configured (nothing to attribute to)', async () => {
    expect(await read({ getSanctionsOracle: zeroAddress })).toEqual(['unknown']);
  });

  it('is unknown when the current block cannot be read', async () => {
    expect(await read({ getBlock: unreachable('getBlock') })).toEqual(['unknown']);
  });

  it('repeats the reads when the pinned block is replaced while they run', async () => {
    let looks = 0;
    // First attempt: pinned at HASH, then the height holds OTHER_HASH. Every
    // later look agrees.
    const getBlock = () => ({ number: BLOCK, hash: looks++ === 1 ? OTHER_HASH : HASH });
    expect(await read({ ...alone, flaggedByOverlay: true, getBlock })).toEqual(['testList']);
    expect(looks).toBe(4);
  });

  it('is unknown when the pinned block keeps being replaced', async () => {
    let looks = 0;
    const getBlock = () => ({ number: BLOCK, hash: looks++ % 2 === 0 ? HASH : OTHER_HASH });
    expect(await read({ ...alone, flaggedByOverlay: true, getBlock })).toEqual(['unknown']);
    expect(looks).toBe(6);
  });

  it('is unknown when the pinned block cannot be looked up again', async () => {
    let looks = 0;
    const getBlock = () => (looks++ === 0 ? { number: BLOCK, hash: HASH } : unreachable('getBlock'));
    expect(await read({ ...alone, flaggedByOverlay: true, getBlock })).toEqual(['unknown']);
  });

  it('pins every read on a layered test list to the same block', async () => {
    const blocks: (bigint | undefined)[] = [];
    await readSanctionsSource(
      client({ ...layered, sanctionSource: reverted('sanctionSource'), flaggedByOverlay: true }, blocks),
      DIAMOND,
      WALLET,
    );
    // oracle, upstream, sanctionSource, flaggedByOverlay, vaultBannedSource
    expect(blocks).toHaveLength(5);
    expect(blocks.every((b) => b === BLOCK)).toBe(true);
  });

  it('pins every read on the declared-sender path to the same block', async () => {
    const blocks: (bigint | undefined)[] = [];
    await readSanctionsSource(client({ ...direct, ...bannedSender }, blocks), DIAMOND, WALLET);
    // oracle, upstream + isSanctioned for the wallet, vaultBannedSource,
    // upstream + isSanctioned for the sender
    expect(blocks).toHaveLength(6);
    expect(blocks.every((b) => b === BLOCK)).toBe(true);
  });
});

describe('explain', () => {
  const none = { kind: 'none' } as const;
  const lookupFailed = { kind: 'lookupFailed' } as const;
  const declared = (reading: 'testList' | 'both' | 'otherList' | 'notFlagged' | 'unread') =>
    ({ kind: 'declared', reading }) as const;

  it('nothing established about either subject is unknown', () => {
    for (const sender of [none, lookupFailed, declared('notFlagged'), declared('unread')]) {
      expect(explain('unread', sender)).toEqual(['unknown']);
      expect(explain('notFlagged', sender)).toEqual(['unknown']);
    }
  });

  it('a flagged sender is named with its own list, whatever is known of the wallet', () => {
    expect(explain('notFlagged', declared('both'))).toEqual(['bannedSource', 'senderBoth']);
    expect(explain('unread', declared('otherList'))).toEqual([
      'bannedSourceWalletUnread',
      'senderOtherList',
    ]);
    expect(explain('both', declared('testList'))).toEqual([
      'both',
      'alsoBannedSource',
      'senderTestList',
    ]);
  });

  it('a listed wallet: its listing, then only what is established of its sender', () => {
    expect(explain('both', declared('unread'))).toEqual(['both', 'bannedSourceUnread']);
    expect(explain('both', lookupFailed)).toEqual(['both', 'senderLookupUnread']);
    expect(explain('both', declared('notFlagged'))).toEqual(['both']);
    expect(explain('both', none)).toEqual(['both']);
  });
});

describe('classifySubject', () => {
  it('a direct oracle: its answer, or unread', () => {
    expect(classifySubject({ kind: 'direct', flagged: true })).toBe('otherList');
    expect(classifySubject({ kind: 'direct', flagged: false })).toBe('notFlagged');
    expect(classifySubject({ kind: 'direct', flagged: null })).toBe('unread');
  });
  it('a test list with no upstream is the whole list, whatever byUpstream says', () => {
    const base = { kind: 'overlay', upstream: zeroAddress, byOverlay: true } as const;
    expect(classifySubject({ ...base, byUpstream: null })).toBe('testList');
    expect(classifySubject({ ...base, byUpstream: true })).toBe('testList');
  });
  it('never names a list that the snapshot does not show flagging', () => {
    const base = { kind: 'overlay', upstream: UPSTREAM, byOverlay: false } as const;
    expect(classifySubject({ ...base, byUpstream: false })).toBe('notFlagged');
    expect(classifySubject({ ...base, byUpstream: null })).toBe('unread');
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
