import { describe, expect, it } from 'vitest';
import {
  alertKeyChainId,
  ownedAlertChainIds,
  pickChain,
  rotationOrder,
  slotIndex,
} from '../src/rotation';

describe('rotation — one chain per tick', () => {
  it('puts the canonical chain first, then the rest ascending and deduplicated', () => {
    expect(rotationOrder(84532, [421614, 97, 84532, 97])).toEqual([84532, 97, 421614]);
    expect(rotationOrder(84532, [])).toEqual([84532]);
  });

  it('visits every chain once per cycle of consecutive cron slots', () => {
    const order = rotationOrder(84532, [84532, 421614, 97]);
    const step = 300;
    const start = Date.UTC(2026, 10, 4, 9, 0, 0);
    const seen = [0, 1, 2, 3, 4, 5].map((k) =>
      pickChain(order, { kind: 'slot', index: slotIndex(start + k * step * 1000, step) }),
    );
    // Each chain exactly twice in six slots, never twice in a row — so at
    // three chains and a 5-minute cron each chain is read every 15 minutes.
    for (const id of order) expect(seen.filter((c) => c === id)).toHaveLength(2);
    for (let k = 1; k < seen.length; k++) expect(seen[k]).not.toBe(seen[k - 1]);
  });

  it('keys the slot to the scheduled time, so a late start keeps its slot', () => {
    const t = Date.UTC(2026, 10, 4, 9, 5, 0);
    expect(slotIndex(t + 299_000, 300)).toBe(slotIndex(t, 300));
    expect(slotIndex(t + 300_000, 300)).toBe(slotIndex(t, 300) + 1);
  });

  it('observes a manually named chain only when it is in the mesh', () => {
    const order = [84532, 97, 421614];
    expect(pickChain(order, { kind: 'chain', chainId: 97 })).toBe(97);
    expect(pickChain(order, { kind: 'chain', chainId: 1 })).toBeNull();
  });

  it('lets a tick prune only its own chain and the watcher-level id', () => {
    expect(ownedAlertChainIds(97)).toEqual([97, 0]);
    expect(ownedAlertChainIds(null)).toEqual([0]);
  });

  it('reads the chain id from a finding key', () => {
    expect(alertKeyChainId('bucket-coverage/x:84532')).toBe(84532);
    expect(alertKeyChainId('coverage-gap/no-rpc/own-ledger:97')).toBe(97);
    expect(alertKeyChainId('watcher-tick-failed/tick:0')).toBe(0);
    expect(alertKeyChainId('legacy')).toBeNull();
  });
});
