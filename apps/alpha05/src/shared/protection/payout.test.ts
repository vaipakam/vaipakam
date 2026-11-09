import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Log } from 'viem';
import { VaultOutflowFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import { creditedTo, payoutOutcomes, payoutRoute, vaultCredit } from './payout';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const OTHER = '0x00000000000000000000000000000000000000e2' as const;
const ME = '0x00000000000000000000000000000000000000a3' as const;
const ASSET = '0x00000000000000000000000000000000000000c4' as const;
const ABI = VaultPayoutFacetABI as Abi;

/** A log of `eventName` from `address`, its indexed and data fields encoded
 *  from `args`. */
function eventLog(address: `0x${string}`, eventName: string, args: Record<string, unknown>): Log {
  const ev = ABI.find((e) => e.type === 'event' && e.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never);
  const data = ev.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics,
    data: encodeAbiParameters(
      data,
      data.map((i) => args[i.name!]),
    ),
  } as unknown as Log;
}

const queued = (address: `0x${string}`, account: `0x${string}`, amount: bigint) =>
  eventLog(address, 'PayoutQueued', { account, id: 1n, asset: ASSET, kind: 0, tokenId: 0n, amount, recipient: account, releaseAt: 1_900_000_000n });

describe('payoutRoute', () => {
  const on = { enabled: true, locked: false, delaySeconds: 3600, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
  it('pays a wallet without the mode at once, and says unknown when unread', () => {
    expect(payoutRoute({ ...on, enabled: false }, ME, ME)).toBe('wallet');
    expect(payoutRoute(null, ME, ME)).toBe('unknown');
  });
  it('queues a payout from the account’s own vault, and holds it while locked', () => {
    expect(payoutRoute(on, ME, ME)).toBe('queued');
    expect(payoutRoute({ ...on, locked: true }, ME, ME)).toBe('held');
  });
  it('pays into the vault from anyone else’s vault', () => {
    expect(payoutRoute(on, ME, OTHER)).toBe('vault');
  });
});

describe('payoutOutcomes', () => {
  it('reads a payout queued for this account and asset from the Diamond only, summed', () => {
    expect(payoutOutcomes([queued(DIAMOND, ME, 7n), queued(DIAMOND, ME, 3n)], DIAMOND, ME, ASSET)).toEqual([{ kind: 'queued', amount: 10n, releaseAt: 1_900_000_000n, recipient: ME }]);
    expect(payoutOutcomes([queued(OTHER, ME, 7n)], DIAMOND, ME, ASSET)).toEqual([]);
    expect(payoutOutcomes([queued(DIAMOND, OTHER, 7n)], DIAMOND, ME, ASSET)).toEqual([]);
    expect(payoutOutcomes([], DIAMOND, ME, ASSET)).toEqual([]);
  });
  it('reads a payout kept in the vault and a payment credited to it', () => {
    const held = eventLog(DIAMOND, 'PayoutHeldInVault', { account: ME, asset: ASSET, tokenId: 0n, amount: 5n });
    expect(payoutOutcomes([held], DIAMOND, ME, ASSET)).toEqual([{ kind: 'held', amount: 5n }]);
    const credited = eventLog(DIAMOND, 'PaymentCreditedToVault', { account: ME, asset: ASSET, tokenId: 0n, amount: 5n, received: 4n });
    expect(payoutOutcomes([credited], DIAMOND, ME, ASSET)).toEqual([{ kind: 'vault', amount: 4n }]);
  });
  it('reads a payment split between the queue and the vault as both', () => {
    const held = eventLog(DIAMOND, 'PayoutHeldInVault', { account: ME, asset: ASSET, tokenId: 0n, amount: 5n });
    expect(payoutOutcomes([queued(DIAMOND, ME, 7n), held], DIAMOND, ME, ASSET)).toEqual([
      { kind: 'queued', amount: 7n, releaseAt: 1_900_000_000n, recipient: ME },
      { kind: 'held', amount: 5n },
    ]);
  });
});

describe('vaultCredit', () => {
  const VAULT = '0x00000000000000000000000000000000000000b5' as const;
  const OUTFLOW = VaultOutflowFacetABI as Abi;
  const outflow = (over: Record<string, unknown> = {}, address: `0x${string}` = DIAMOND): Log => {
    const ev = OUTFLOW.find((e) => e.type === 'event' && e.name === 'VaultOutflow') as AbiEvent;
    const args = { owner: OTHER, vault: OTHER, asset: ASSET, tokenId: 0n, amount: 9n, delivered: 8n, to: VAULT, class_: 2, reason: 1, ref: 7n, ...over };
    const topics = encodeEventTopics({ abi: [ev], eventName: 'VaultOutflow', args } as never);
    const data = ev.inputs.filter((i) => !i.indexed);
    return { address, topics, data: encodeAbiParameters(data, data.map((i) => (args as Record<string, unknown>)[i.name!])) } as unknown as Log;
  };

  it('sums what the Diamond recorded arriving in this vault for a crediting class', () => {
    const logs = [outflow(), outflow({ class_: 3, delivered: 2n }), outflow({ class_: 14, delivered: 1n })];
    expect(vaultCredit(logs, DIAMOND, VAULT, ASSET)).toEqual({ kind: 'credit', amount: 11n });
    expect(creditedTo(logs, DIAMOND, VAULT)).toBe(true);
  });

  it('counts a payout that stayed in its own vault (the vault is its own destination)', () => {
    expect(vaultCredit([outflow({ owner: ME, vault: VAULT, delivered: 9n })], DIAMOND, VAULT, ASSET)).toEqual({ kind: 'credit', amount: 9n });
  });

  it('ignores another vault, another asset or NFT, an uncredited class, another loan and another emitter', () => {
    const logs = [
      outflow({ to: OTHER }),
      outflow({ asset: OTHER }),
      outflow({ tokenId: 4n }),
      outflow({ class_: 13 }),
      outflow({ class_: 0 }),
      outflow({ ref: 8n }),
      outflow({}, OTHER),
    ];
    expect(vaultCredit(logs, DIAMOND, VAULT, ASSET, { tokenId: 0n, ref: [7n] })).toBeNull();
    expect(vaultCredit(logs, DIAMOND, VAULT, ASSET, { tokenId: 4n, ref: [7n] })).toEqual({ kind: 'credit', amount: 8n });
    expect(creditedTo([outflow({ to: OTHER }), outflow({ class_: 13 })], DIAMOND, VAULT)).toBe(false);
  });

  it('narrows to the classes asked for', () => {
    expect(vaultCredit([outflow()], DIAMOND, VAULT, ASSET, { classes: [14] })).toBeNull();
  });
});
