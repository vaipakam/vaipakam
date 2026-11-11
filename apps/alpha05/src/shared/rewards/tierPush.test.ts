import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  encodeAbiParameters,
  encodeErrorResult,
  keccak256,
  parseAbi,
  toHex,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { FEE_MARGIN_BPS, laneSent, laneStanding, paidByCaller, paidSend, readTierPush, recordStanding, tierPushSupport, type TierLane } from './tierPush';
import { selectorOf } from '../capability/CapabilityContext';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const MESSENGER = '0x00000000000000000000000000000000000000c1' as Hex;

const REFUSE = parseAbi(['error NotBroadcastDestination(uint256)']);
const refused = (functionName: string) =>
  new ContractFunctionRevertedError({ abi: REFUSE, data: encodeErrorResult({ abi: REFUSE, errorName: 'NotBroadcastDestination', args: [1n] }), functionName });
const outage = (functionName: string) =>
  new ContractFunctionExecutionError(new HttpRequestError({ url: 'https://rpc.example', status: 429 }), { abi: [], functionName });

const delivered = (v: Partial<{ nonce: bigint; tier: number; bps: number; tierExpirySec: number; tierTableVersion: number; sentAt: number }> = {}) => ({
  nonce: 0n,
  tier: 0,
  bps: 0,
  tierExpirySec: 0,
  tierTableVersion: 0,
  sentAt: 0,
  ...v,
});

const STATUS = [
  3n,
  2,
  1500,
  2 ** 40 - 1,
  1,
  [
    {
      destChainId: 421614n,
      delivered: delivered({ nonce: 3n, tier: 2, bps: 1500, tierExpirySec: 2 ** 40 - 1, tierTableVersion: 1, sentAt: 1_800_000_000 }),
      owed: false,
      budgetPays: false,
    },
    { destChainId: 97n, delivered: delivered({ nonce: 1n, tier: 1, bps: 1000, tierTableVersion: 1, sentAt: 1_799_000_000 }), owed: true, budgetPays: false },
  ],
] as const;

type Call = { functionName: string; address: Hex; args?: readonly unknown[]; blockNumber: bigint };

function client(answers: Record<string, unknown | ((fn: string) => Error)>, calls: Call[] = []): PublicClient {
  return {
    getBlockNumber: async () => 9n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      expect(blockNumber).toBe(9n);
      return { timestamp: 1_800_000_500n };
    },
    readContract: async (call: Call) => {
      expect(call.blockNumber).toBe(9n);
      calls.push(call);
      const a = answers[call.functionName];
      if (typeof a === 'function') throw (a as (fn: string) => Error)(call.functionName);
      return a;
    },
  } as unknown as PublicClient;
}

const ANSWERS = {
  getTierPushStatus: STATUS,
  getEffectiveDiscount: [2, 1500],
  getRewardReporterConfig: [MESSENGER, 84532n, 84532n, true, 43200],
  quoteSendTierUpdateTo: 7_000n,
};

const lane = (v: Partial<TierLane>): TierLane => ({
  chainId: 97,
  delivered: { nonce: 0n, tier: 0, bps: 0n, expiresAt: null, version: 0, sentAt: 0 },
  owed: false,
  budgetPays: false,
  fee: null,
  ...v,
});

describe('readTierPush', () => {
  it('reads the status, the tier now and each owed network’s fee at one block', async () => {
    const calls: Call[] = [];
    const card = await readTierPush(client(ANSWERS, calls), DIAMOND, ME);
    expect(card.recorded).toEqual({ nonce: 3n, tier: 2, bps: 1500n, expiresAt: null, version: 1 });
    expect(card.effective).toEqual({ tier: 2, bps: 1500n });
    expect(card.blockTime).toBe(1_800_000_500);
    expect(card.lanes.map((l) => [l.chainId, l.owed, l.fee])).toEqual([
      [421614, false, null],
      [97, true, 7_000n],
    ]);
    expect(card.lanes[0]!.delivered).toMatchObject({ tier: 2, bps: 1500n, expiresAt: null, sentAt: 1_800_000_000 });
    // The quote asks the messenger for exactly the recorded message, once,
    // for the owed network only, stamped with the block's time.
    const quotes = calls.filter((c) => c.functionName === 'quoteSendTierUpdateTo');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.address).toBe(MESSENGER);
    expect(quotes[0]!.args).toEqual([97n, ME, 2, 1500, 1_800_000_500, 3n, 2 ** 40 - 1, 1]);
  });

  it('asks no fee when no network is owed', async () => {
    const calls: Call[] = [];
    const quiet = [STATUS[0], STATUS[1], STATUS[2], STATUS[3], STATUS[4], [STATUS[5][0]]] as const;
    await readTierPush(client({ ...ANSWERS, getTierPushStatus: quiet }, calls), DIAMOND, ME);
    expect(calls.map((c) => c.functionName)).not.toContain('quoteSendTierUpdateTo');
    expect(calls.map((c) => c.functionName)).not.toContain('getRewardReporterConfig');
  });

  it('tells an empty lane list apart: no messenger, an empty list, or a list that refused', async () => {
    const none = [STATUS[0], STATUS[1], STATUS[2], STATUS[3], STATUS[4], []] as const;
    const base = { ...ANSWERS, getTierPushStatus: none };
    expect((await readTierPush(client({ ...base, getBroadcastDestinations: [] }), DIAMOND, ME)).destinations).toBe('none');
    expect((await readTierPush(client({ ...base, getBroadcastDestinations: refused }), DIAMOND, ME)).destinations).toBe('unreadable');
    expect((await readTierPush(client({ ...base, getBroadcastDestinations: [97n] }), DIAMOND, ME)).destinations).toBe('unreadable');
    const zero = { ...base, getRewardReporterConfig: ['0x0000000000000000000000000000000000000000', 84532n, 84532n, true, 43200] };
    expect((await readTierPush(client(zero), DIAMOND, ME)).destinations).toBe('no-messenger');
    expect((await readTierPush(client(ANSWERS), DIAMOND, ME)).destinations).toBe('listed');
  });

  it('leaves a refused quote unknown, and the tier now unread when it refuses', async () => {
    const card = await readTierPush(client({ ...ANSWERS, quoteSendTierUpdateTo: refused, getEffectiveDiscount: refused }), DIAMOND, ME);
    expect(card.lanes[1]!.fee).toBeNull();
    expect(card.effective).toBeNull();
  });

  it('throws when a source fails, so the own rail tries the next', async () => {
    await expect(readTierPush(client({ ...ANSWERS, getTierPushStatus: outage }), DIAMOND, ME)).rejects.toThrow();
    await expect(readTierPush(client({ ...ANSWERS, quoteSendTierUpdateTo: outage }), DIAMOND, ME)).rejects.toThrow();
  });
});

describe('tierPushSupport', () => {
  const sel = selectorOf;
  const set = (...sigs: string[]) => new Set(sigs.map(sel));
  it('is present only with the status and the paid send and without the retired spacing rule', () => {
    expect(tierPushSupport(null, sel)).toBe('unknown');
    expect(tierPushSupport(set('deliverTierPush(address)'), sel)).toBe('absent');
    expect(tierPushSupport(set('getTierPushStatus(address)', 'deliverTierPush(address)'), sel)).toBe('present');
    expect(tierPushSupport(set('getTierPushStatus(address)', 'deliverTierPush(address)', 'getTierPushSpacingSec()'), sel)).toBe('predates');
    expect(tierPushSupport(set('getTierPushStatus(address)'), sel)).toBe('predates');
  });
});

describe('laneStanding', () => {
  it('names who sends what a network is owed', () => {
    expect(laneStanding(lane({ owed: false }))).toBe('current');
    expect(laneStanding(lane({ owed: true, budgetPays: true }))).toBe('protocol-pays');
    expect(laneStanding(lane({ owed: true, budgetPays: false }))).toBe('needs-paid-send');
  });
});

describe('laneSent', () => {
  it('counts a send only from its time, never from a record number settled without a message', () => {
    const d = { nonce: 3n, tier: 0, bps: 0n, expiresAt: null, version: 0, sentAt: 0 };
    expect(laneSent({ delivered: d })).toBe(false);
    expect(laneSent({ delivered: { ...d, tier: 1, bps: 1000n, sentAt: 1_700_000_000 } })).toBe(true);
  });
});

describe('recordStanding', () => {
  const recorded = { nonce: 2n, tier: 1, bps: 1000n, expiresAt: null, version: 1 };
  it('is behind when the tier now differs, and the same when it matches', () => {
    expect(recordStanding({ recorded, effective: { tier: 2, bps: 1500n } })).toBe('behind');
    expect(recordStanding({ recorded, effective: { tier: 1, bps: 1000n } })).toBe('same');
    expect(recordStanding({ recorded, effective: null })).toBe('unknown');
  });
  it('compares a recorded discount above the ceiling as capped', () => {
    expect(recordStanding({ recorded: { ...recorded, tier: 4, bps: 9000n }, effective: { tier: 4, bps: 5000n } })).toBe('same');
  });
  it('reads a wallet with nothing recorded as behind only once it has a tier', () => {
    const none = { ...recorded, nonce: 0n, tier: 0, bps: 0n };
    expect(recordStanding({ recorded: none, effective: { tier: 0, bps: 0n } })).toBe('same');
    expect(recordStanding({ recorded: none, effective: { tier: 1, bps: 1000n } })).toBe('behind');
  });
});

describe('paidSend', () => {
  it('sizes the value as every owed network’s fee plus the margin', () => {
    const r = paidSend([
      lane({ chainId: 1, owed: false }),
      lane({ chainId: 2, owed: true, fee: 10_000n }),
      lane({ chainId: 3, owed: true, budgetPays: true, fee: 5_000n }),
    ]);
    expect(r).toEqual({ quoted: 15_000n, value: 15_000n + (15_000n * FEE_MARGIN_BPS) / 10_000n, chainIds: [2, 3] });
  });
  it('withholds the send when an owed fee is unquoted, and offers none when nothing is owed', () => {
    expect(paidSend([lane({ owed: true, fee: null })])).toBe('unquoted');
    expect(paidSend([lane({ owed: false })])).toBe('nothing-owed');
    expect(paidSend([])).toBe('nothing-owed');
  });
});

describe('paidByCaller', () => {
  const topic0 = keccak256(toHex('ProtocolTierBroadcastSent(address,uint256,uint8,uint16,uint64,uint256,bool)'));
  const log = (user: Hex, dst: bigint, fee: bigint, callerFunded: boolean, address: Hex = DIAMOND) => ({
    address,
    topics: [topic0, encodeAbiParameters([{ type: 'address' }], [user]), encodeAbiParameters([{ type: 'uint256' }], [dst])] as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint16' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'bool' }],
      [2, 1500, 3n, fee, callerFunded],
    ),
  });
  it('sums only the wallet-paid messages for the account from the Diamond', () => {
    const logs = [log(ME, 97n, 6_000n, true), log(ME, 11155111n, 4_000n, false), log(OTHER, 97n, 9_000n, true), log(ME, 97n, 8_000n, true, MESSENGER)];
    expect(paidByCaller({ logs } as never, DIAMOND, ME)).toBe(6_000n);
  });
});
