import { describe, it, expect } from 'vitest';
import { admittedWindow, APPROVAL_WINDOWS, deadlineWindows, stepClass, TX_DEADLINE_SECONDS, TX_STEPS, txValidUntil } from './txDeadline';

describe('txValidUntil', () => {
  it('adds the one window to the chain time', () => {
    expect(TX_DEADLINE_SECONDS).toBe(1800);
    expect(txValidUntil(1_700_000_000n)).toBe(1_700_001_800n);
  });
});

describe('#3770: the window by step class and wallet kind', () => {
  const key = { kind: 'key' } as const;
  const team = { kind: 'contract', threshold: 2n } as const;
  const solo = { kind: 'contract', threshold: 1n } as const;
  it('gives a key wallet thirty minutes and no choice on every step', () => {
    for (const step of Object.keys(TX_STEPS)) expect(deadlineWindows(step, key)).toEqual({ choices: [1800], preselected: 1800 });
  });
  it('lets a contract wallet choose on a fixed-terms step, pre-selecting by its threshold', () => {
    expect(deadlineWindows('acceptOffer', team)).toEqual({ choices: APPROVAL_WINDOWS, preselected: 86400 });
    expect(deadlineWindows('acceptOffer', solo).preselected).toBe(1800);
    expect(deadlineWindows('acceptOffer', { kind: 'contract', threshold: null }).preselected).toBe(1800);
  });
  it('never lengthens a live-price or unruled step', () => {
    for (const step of ['borrowInstant', 'directSale', 'signedOrder', 'notAStep']) {
      expect(deadlineWindows(step, team)).toEqual({ choices: [1800], preselected: 1800 });
      expect(admittedWindow(step, team, 7 * 86400)).toBe(1800);
    }
  });
  it('caps adopting a stray asset at 24 hours', () => {
    expect(deadlineWindows('adoptAsset', team)).toEqual({ choices: [1800, 86400], preselected: 86400 });
    expect(admittedWindow('adoptAsset', team, 7 * 86400)).toBe(86400);
  });
  it('marks the steps whose window covers a signed message and its transaction', () => {
    for (const step of ['acceptOffer', 'acceptRental', 'takeRentalRequest']) expect(stepClass(step)).toMatchObject({ signedMessage: true });
    expect(stepClass('postOffer')).not.toHaveProperty('signedMessage');
  });
  it('reads an unknown step as unruled, and admits only an offered window', () => {
    expect(stepClass('nope')).toEqual({ kind: 'short', why: 'unruled' });
    expect(admittedWindow('postOffer', team, 3 * 86400)).toBe(3 * 86400);
    expect(admittedWindow('postOffer', team, 12345)).toBe(86400);
    expect(txValidUntil(100n, 86400)).toBe(86500n);
  });
});
