// apps/keeper/test/protectedRecoveryClaim.test.ts — #3756: the recovery
// claim's alerts reach the owner and every signer at the request, the
// reminders and the end, once each.

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { parseAddressedAlert, renderTelegramAlert, type AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import { memoryScanCursors } from '../src/scanCursors';
import {
  CLAIM_SCAN_INTERVAL_SEC,
  STAGE_GRACE_SEC,
  dueStage,
  endFromReason,
  recoveryClaimAlerts,
  stateItem,
  type ClaimAlertDeps,
  type ClaimEndEvent,
  type ClaimView,
} from '../src/protectedRecoveryClaim';
import type { DeliveryOutcome } from '../src/alertDelivery';

const DAY = 86400;
const ACC = '0x00000000000000000000000000000000000000aa' as Address;
const SIGNER = '0x00000000000000000000000000000000000000bb' as Address;
const REC = '0x00000000000000000000000000000000000000cc' as Address;
const VAULT = '0x00000000000000000000000000000000000000dd' as Address;
const AT = 1_800_000_000;
const RUN = AT + 90 * DAY;

function view(over: Partial<ClaimView> = {}): ClaimView {
  return {
    vault: VAULT,
    manager: ACC,
    signers: [SIGNER],
    requestedAt: AT,
    runnableAt: RUN,
    lapsesAt: RUN + 30 * DAY,
    recovery: REC,
    pauseUntil: 0,
    recovered: false,
    recoveredAt: 0,
    ...over,
  };
}

function setup() {
  const sent: AddressedAlert[] = [];
  const state = { v: view() as ClaimView | 'none', end: null as ClaimEndEvent | null, outcome: (): DeliveryOutcome => ({ telegram: 'sent', push: 'off' }) };
  const cursors = memoryScanCursors();
  let now = AT + 60;
  const deps = (): ClaimAlertDeps => ({
    reads: {
      head: async () => 100n,
      views: async (accs) => accs.map(() => state.v),
      endEvent: async () => state.end,
    },
    cursors,
    chainId: 84532,
    diamond: '0x0000000000000000000000000000000000000001',
    accounts: async (after) => (after === '' ? [ACC] : []),
    subscriber: async () => null,
    notify: async (a) => {
      sent.push(a.telegram!.message as AddressedAlert);
      return state.outcome();
    },
    appOrigin: 'https://app.example',
    nowSec: now,
    cutoff: Date.now() + 60_000,
  });
  const run = async (at: number) => {
    now = at;
    return recoveryClaimAlerts(deps());
  };
  return { sent, state, cursors, run };
}

describe('dueStage', () => {
  it('walks the request, the half-way point, seven days and one day before the run', () => {
    expect(dueStage(AT, RUN, AT - 1)).toBe(-1);
    expect(dueStage(AT, RUN, AT)).toBe(0);
    expect(dueStage(AT, RUN, AT + 45 * DAY)).toBe(1);
    expect(dueStage(AT, RUN, RUN - 7 * DAY)).toBe(2);
    expect(dueStage(AT, RUN, RUN - DAY)).toBe(3);
    // A reminder far past its time is not sent: the earlier stage stands.
    expect(dueStage(AT, RUN, RUN - 7 * DAY + STAGE_GRACE_SEC)).toBe(1);
    // Once the claim may run, no reminder is due.
    expect(dueStage(AT, RUN, RUN)).toBe(0);
  });
  it('skips a stage that falls before the one before it', () => {
    const run = AT + 10 * DAY; // half-way at 5 days, after the 7-day mark
    expect(dueStage(AT, run, AT + 5 * DAY)).toBe(1);
    expect(dueStage(AT, run, run - DAY)).toBe(3);
  });
});

describe('recoveryClaimAlerts (#3756)', () => {
  it('announces the request to the owner and every signer, once, then the reminders', async () => {
    const { sent, run } = setup();
    await run(AT + 60);
    expect(sent.map((m) => m.to ?? m.wallet)).toEqual([ACC, SIGNER]);
    expect(sent[0].alert).toMatchObject({ kind: 'recoveryClaim', stage: 'requested', recovery: REC, runnableAt: RUN });
    expect((await run(AT + 120)).waiting).toBe(true);
    await run(AT + 60 + CLAIM_SCAN_INTERVAL_SEC);
    expect(sent).toHaveLength(2);
    await run(AT + 45 * DAY);
    expect(sent.slice(2).map((m) => (m.alert as { stage: string }).stage)).toEqual(['halfway', 'halfway']);
    await run(RUN - DAY);
    expect(sent).toHaveLength(6);
  });

  it('announces a cancel with who cancelled it and the pause, then forgets the claim', async () => {
    const { sent, state, cursors, run } = setup();
    await run(AT + 60);
    state.v = view({ requestedAt: 0, pauseUntil: AT + 31 * DAY });
    state.end = { reason: 0, by: SIGNER };
    const r = await run(AT + DAY);
    expect(r.ended).toBe(1);
    expect(sent.slice(2).map((m) => m.alert)).toEqual([
      { kind: 'recoveryClaimEnded', end: 'cancelled', requestedAt: AT, by: SIGNER, pauseUntil: AT + 31 * DAY },
      { kind: 'recoveryClaimEnded', end: 'cancelled', requestedAt: AT, by: SIGNER, pauseUntil: AT + 31 * DAY },
    ]);
    expect((await cursors.get([stateItem(ACC)])).get(stateItem(ACC))).toBe('');
  });

  it('reads an end from the view when the event cannot be read', async () => {
    const { sent, state, run } = setup();
    await run(AT + 60);
    state.v = view({ requestedAt: 0, recovered: true, recoveredAt: RUN + 1 });
    await run(RUN + 2);
    expect(sent[2].alert).toMatchObject({ end: 'recovered' });
    const lapse = setup();
    await lapse.run(AT + 60);
    lapse.state.v = view({ requestedAt: 0 });
    await lapse.run(RUN + 31 * DAY);
    expect(lapse.sent[2].alert).toMatchObject({ end: 'lapsed', pauseUntil: null });
  });

  it('keeps a delivery a channel may take later, and stays quiet with no claim', async () => {
    const { sent, state, run } = setup();
    state.outcome = () => ({ telegram: 'retry', push: 'off' });
    expect((await run(AT + 60)).retrying).toBe(2);
    state.outcome = () => ({ telegram: 'sent', push: 'off' });
    await run(AT + 60 + CLAIM_SCAN_INTERVAL_SEC);
    expect(sent).toHaveLength(4);
    await run(AT + 60 + 2 * CLAIM_SCAN_INTERVAL_SEC);
    expect(sent).toHaveLength(4);
    const quiet = setup();
    quiet.state.v = 'none';
    await quiet.run(AT);
    expect(quiet.sent).toEqual([]);
  });

  it('maps the vault reasons', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 9].map(endFromReason)).toEqual([
      'cancelled',
      'ownerCall',
      'switchedOff',
      'locked',
      'replaced',
      'recovered',
      'protectionOff',
      'recoveryChanged',
      'unknown',
    ]);
  });
});

describe('the recovery claim messages', () => {
  it('parse and render in every locale', () => {
    const raw = { chainId: 84532, wallet: ACC, to: SIGNER, alert: { kind: 'recoveryClaim', stage: 'week', recovery: REC, requestedAt: AT, runnableAt: RUN, lapsesAt: RUN + DAY } };
    const m = parseAddressedAlert(raw)!;
    expect(m).not.toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, runnableAt: AT - 1 } })).toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, stage: 'soon' } })).toBeNull();
    const ended = parseAddressedAlert({ chainId: 84532, wallet: ACC, alert: { kind: 'recoveryClaimEnded', end: 'cancelled', requestedAt: AT, by: SIGNER, pauseUntil: AT + DAY } })!;
    expect(ended).not.toBeNull();
    expect(parseAddressedAlert({ chainId: 84532, wallet: ACC, alert: { kind: 'recoveryClaimEnded', end: 'gone', requestedAt: AT, by: null, pauseUntil: null } })).toBeNull();
    const ctx = { chainName: 'Base Sepolia', appOrigin: 'https://app.example' };
    const en = renderTelegramAlert(m, { ...ctx, locale: 'en' }).text;
    expect(en).toContain('Reminder: 7 days left.');
    expect(en).toContain('https://app.example/');
    expect(renderTelegramAlert(ended, { ...ctx, locale: 'en' }).text).toContain('No new claim can be asked before');
    for (const locale of ['es', 'fr', 'de', 'ja', 'zh', 'ko', 'hi', 'ta', 'ar']) {
      const t = renderTelegramAlert(m, { ...ctx, locale }).text;
      expect(t, locale).not.toBe(en);
      expect(t).toContain(new Date(RUN * 1000).toISOString().slice(0, 16).replace('T', ' '));
    }
  });
});
