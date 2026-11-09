// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { knownSnapshot, subscribeKnown, writeKnown } from './known';

const W = '0xabcdef0000000000000000000000000000000002' as const;

describe('the record every alert card shows', () => {
  it('reads storage again when a card mounts after none was listening for other tabs', () => {
    const off = subscribeKnown(() => undefined);
    writeKnown(84532, W, { dueDate: { on: true, at: 1 } });
    expect(knownSnapshot(84532, W).dueDate?.on).toBe(true);
    off();
    // Another tab switches reminders off while no card is mounted here: no
    // storage event reaches this tab's cache.
    const k = Object.keys(localStorage).find((x) => x.endsWith(W))!;
    localStorage.setItem(k, JSON.stringify({ dueDate: { on: false, at: 2 } }));
    const again = subscribeKnown(() => undefined);
    expect(knownSnapshot(84532, W).dueDate?.on).toBe(false);
    again();
  });
});
