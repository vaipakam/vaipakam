import { describe, expect, it } from 'vitest';
import { TxStore, holdsFlow, inFlight } from './txStore';

describe('TxStore', () => {
  it('holds an entry per key, outside any component, and snapshots stably', () => {
    const s = new TxStore();
    expect(s.get('a').phase.kind).toBe('idle');
    expect(s.get('a')).toBe(s.get('b'));
    let calls = 0;
    const off = s.subscribe(() => void (calls += 1));
    s.update('a', (e) => ({ ...e, phase: { kind: 'submitted', hash: '0x01', at: 1 } }));
    const snap = s.all();
    expect(s.all()).toBe(snap);
    expect(snap).toHaveLength(1);
    expect(s.get('a').phase.kind).toBe('submitted');
    expect(s.get('b').phase.kind).toBe('idle');
    off();
    s.update('a', (e) => e);
    expect(calls).toBe(1);
  });

  it('keeps review state beside a flow and clears it on null', () => {
    const s = new TxStore();
    s.setValue('k', { v: 1 });
    expect(s.value<{ v: number }>('k')).toEqual({ v: 1 });
    s.setValue('k', null);
    expect(s.value('k')).toBeNull();
  });

  it('names the phases a page must show without its review inputs', () => {
    expect(holdsFlow({ kind: 'idle' })).toBe(false);
    expect(holdsFlow({ kind: 'review' })).toBe(false);
    expect(holdsFlow({ kind: 'signing' })).toBe(true);
    expect(holdsFlow({ kind: 'failed', message: 'x' })).toBe(true);
    expect(inFlight({ kind: 'signing' })).toBe(true);
    expect(inFlight({ kind: 'receipt-unknown', hash: '0x01', at: 1, message: 'x' })).toBe(false);
  });
});
