// apps/keeper/test/termsNotice.test.ts — #3734 part two: the Terms
// announcement alert reaches committed wallets that will not be current, once
// per announcement.

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { parseAddressedAlert, renderTelegramAlert, type AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import { memoryScanCursors } from '../src/scanCursors';
import {
  SCAN_INTERVAL_SEC,
  WALLETS_PER_RUN,
  currentAfter,
  describeReport,
  termsNoticeOnce,
  type Announcement,
  type TermsNoticeDeps,
} from '../src/termsNotice';
import type { NoticeOutcome } from '../src/standingInstructions';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const C = '0x00000000000000000000000000000000000000cc';
const NOW = 1_800_000_000;
const ANN: Announcement = { version: 3, effectiveAt: NOW + 7 * 86400, minVersion: 3, newVersion: true };

function setup(opts: {
  ann?: Announcement | null;
  offers?: string[];
  slots?: string[];
  standing?: string[];
  hasSlot?: (w: string) => boolean;
  accepted?: Record<string, number[]>;
  outcome?: (w: string) => NoticeOutcome;
}) {
  const sent: AddressedAlert[] = [];
  const cursors = memoryScanCursors();
  const deps: TermsNoticeDeps = {
    reads: {
      announced: async () => (opts.ann === undefined ? ANN : opts.ann),
      latest: async () => 2,
      accepted: async (w: Address) => opts.accepted?.[w.toLowerCase()] ?? [2],
      inForceAt: async (v) => (v <= 2 ? 1 : 0),
      hasSlot: async (w: Address) => (opts.hasSlot ? opts.hasSlot(w.toLowerCase()) : true),
    },
    sources: {
      offerCreators: async () => opts.offers ?? [],
      slotOwners: async () => opts.slots ?? [],
      standingOwners: async () => opts.standing ?? [],
    },
    cursors,
    notify: async (a) => {
      sent.push(a);
      return opts.outcome ? opts.outcome(a.wallet) : 'sent';
    },
    now: NOW,
  };
  return { deps, sent, cursors };
}

describe('currentAfter', () => {
  const inForce = async (v: number) => (v <= 2 ? 1 : 0);
  it('a new version needs that version or one between the minimum and it', async () => {
    expect(await currentAfter([2], ANN, 2, inForce)).toBe(false);
    expect(await currentAfter([3], ANN, 2, inForce)).toBe(true);
  });
  it('a raised minimum is met by an accepted version in force from it to the latest', async () => {
    const raise: Announcement = { version: 5, effectiveAt: NOW + 1, minVersion: 4, newVersion: false };
    const inForce5 = async (v: number) => (v === 4 || v === 5 ? 1 : v === 3 ? 0 : 1);
    expect(await currentAfter([2], raise, 5, inForce5)).toBe(false);
    expect(await currentAfter([4], raise, 5, inForce5)).toBe(true);
    // A withdrawn version in range never counts.
    expect(await currentAfter([3], { ...raise, minVersion: 3 }, 5, inForce5)).toBe(false);
  });
});

describe('termsNoticeOnce (#3734)', () => {
  it('alerts each committed wallet once, naming what it holds', async () => {
    const { deps, sent, cursors } = setup({ offers: [A, B.toUpperCase().replace('0X', '0x')], slots: [A], standing: [B], accepted: { [C]: [3] } });
    const r = await termsNoticeOnce(1, deps);
    expect(r.key).toBe(`3-3-${ANN.effectiveAt}`);
    expect(sent.map((s) => s.wallet)).toEqual([A, B]);
    expect(sent[0].alert).toEqual({ kind: 'termsAnnounced', version: 3, effectiveAt: ANN.effectiveAt, holds: ['offer', 'autoLend'] });
    expect(sent[1].alert).toMatchObject({ holds: ['offer', 'standing'] });
    // The next run inside the interval reads nothing more.
    expect((await termsNoticeOnce(1, deps)).waiting).toBe(true);
    // After it, nobody is alerted twice.
    const later = await termsNoticeOnce(1, { ...deps, now: NOW + SCAN_INTERVAL_SEC });
    expect(later.alerted).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(cursors.rows.size).toBeGreaterThan(0);
  });

  it('skips a wallet that already accepted, and an owner with no slot left', async () => {
    const { deps, sent } = setup({ offers: [A], slots: [B], accepted: { [A]: [3] }, hasSlot: () => false });
    const r = await termsNoticeOnce(1, deps);
    expect(sent).toEqual([]);
    expect(r.current).toBe(1);
  });

  it('does nothing with no announcement pending, or one already in force', async () => {
    expect((await termsNoticeOnce(1, setup({ ann: null, offers: [A] }).deps)).key).toBeNull();
    const past = setup({ ann: { ...ANN, effectiveAt: NOW }, offers: [A] });
    await termsNoticeOnce(1, past.deps);
    expect(past.sent).toEqual([]);
  });

  it('retries a delivery the agent could not take, and bounds a scan', async () => {
    const many = Array.from({ length: WALLETS_PER_RUN + 5 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    let tries = 0;
    const { deps, sent } = setup({ offers: many, outcome: (w) => (w === many[0] && tries++ === 0 ? 'retry' : 'sent') });
    const r = await termsNoticeOnce(1, deps);
    expect(sent).toHaveLength(WALLETS_PER_RUN);
    expect(r.alerted).toHaveLength(WALLETS_PER_RUN - 1);
    expect(r.retry).toBe(1);
    expect(r.deferred).toBe(5);
    const next = await termsNoticeOnce(1, { ...deps, now: NOW + SCAN_INTERVAL_SEC });
    expect(next.alerted).toEqual([many[0], ...many.slice(WALLETS_PER_RUN)]);
    expect(describeReport(next)).toContain('6 alerted');
  });

  it('a re-announcement with a new time alerts again', async () => {
    const { deps, sent } = setup({ offers: [A] });
    await termsNoticeOnce(1, deps);
    const again = { ...ANN, effectiveAt: ANN.effectiveAt + 86400 };
    await termsNoticeOnce(1, { ...deps, reads: { ...deps.reads, announced: async () => again } });
    expect(sent).toHaveLength(2);
  });
});

describe('the termsAnnounced message', () => {
  it('parses only known holds, and renders in the owner language', () => {
    const raw = { chainId: 84532, wallet: A, alert: { kind: 'termsAnnounced', version: 3, effectiveAt: 1_800_000_000, holds: ['offer', 'standing'] } };
    const m = parseAddressedAlert(raw)!;
    expect(m).not.toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, holds: ['offer', 'nope'] } })).toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, holds: [] } })).toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, holds: ['offer', 'offer'] } })).toBeNull();
    const en = renderTelegramAlert(m, { locale: 'en', chainName: 'Base Sepolia', appOrigin: 'https://app.example' });
    expect(en.text).toContain('Version 3 comes into force on 2027-01-15 08:00 UTC');
    expect(en.text).toContain('open offers and standing instructions');
    expect(en.text).toContain('https://app.example/');
    for (const locale of ['es', 'fr', 'de', 'ja', 'zh', 'ko', 'hi', 'ta', 'ar']) {
      const t = renderTelegramAlert(m, { locale, chainName: 'Base Sepolia', appOrigin: 'https://app.example' });
      expect(t.text, locale).not.toBe(en.text);
      expect(t.text).toContain('2027-01-15 08:00');
    }
  });
});
