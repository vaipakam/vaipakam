import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreclassifiedFailure } from '../src/errors';
import {
  alertKeyChainId,
  cronStepSeconds,
  ownedAlertChainIds,
  pickChain,
  resolveTickScope,
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

describe('rotation — the cron is the only cadence (#3144)', () => {
  it('reads the interval from an evenly spaced cron', () => {
    expect(cronStepSeconds('*/5 * * * *')).toBe(300);
    expect(cronStepSeconds('* * * * *')).toBe(60);
    expect(cronStepSeconds('*/15 * * * *')).toBe(900);
    expect(cronStepSeconds('  */30   * * * *  ')).toBe(1800);
  });

  it('refuses a schedule whose firings are not evenly spaced', () => {
    // */7 fires at :56 and then :00, four minutes apart.
    expect(cronStepSeconds('*/7 * * * *')).toBeNull();
    expect(cronStepSeconds('0,15,30,45 * * * *')).toBeNull();
    expect(cronStepSeconds('*/5 9-17 * * *')).toBeNull();
    expect(cronStepSeconds('*/5 * * *')).toBeNull();
    expect(cronStepSeconds('*/0 * * * *')).toBeNull();
    expect(cronStepSeconds('*/60 * * * *')).toBeNull();
  });

  it('visits every chain at any supported cadence, including the one that once pinned it', () => {
    // A 15-minute cron with a separately configured 5-minute step moved
    // the slot by three per firing, which at three chains is the same
    // chain every time. With the step taken from the cron there is no
    // second number to disagree.
    const order = [84532, 97, 421614];
    for (const cron of ['* * * * *', '*/5 * * * *', '*/15 * * * *']) {
      const step = cronStepSeconds(cron)!;
      const start = Date.UTC(2026, 10, 4, 10, 0, 0);
      const seen = [0, 1, 2].map((k) =>
        pickChain(order, resolveTickScope({ kind: 'cron', cron, scheduledTimeMs: start + k * step * 1000 })),
      );
      expect(new Set(seen)).toEqual(new Set(order));
    }
  });

  it('fails an unsupported cron as a configuration fault instead of observing', () => {
    let thrown: unknown;
    try {
      resolveTickScope({ kind: 'cron', cron: '0,15,30,45 * * * *', scheduledTimeMs: 0 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PreclassifiedFailure);
    expect((thrown as PreclassifiedFailure).failure.kind).toBe('config');
    expect((thrown as PreclassifiedFailure).failure.summary).toContain('0,15,30,45 * * * *');
  });

  it('passes manual scopes through unchanged', () => {
    expect(resolveTickScope({ kind: 'chain', chainId: 97 })).toEqual({ kind: 'chain', chainId: 97 });
    expect(resolveTickScope({ kind: 'slot', index: 4 })).toEqual({ kind: 'slot', index: 4 });
  });

  it('deploys with a cron the rotation supports', () => {
    const jsonc = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const block = /"crons"\s*:\s*\[([^\]]*)\]/.exec(jsonc);
    expect(block).not.toBeNull();
    const crons = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(crons.length).toBeGreaterThan(0);
    for (const cron of crons) expect(cronStepSeconds(cron)).not.toBeNull();
  });
});
