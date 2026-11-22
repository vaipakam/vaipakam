import { describe, expect, it } from 'vitest';
import { buildAlertSettingsMessage, buildTelegramLinkMessage, buildTelegramTestMessage, buildTelegramUnlinkMessage } from '@vaipakam/lib/alertsMessage';
import { alertBody, alertMessage, alertRoute, bandsProblem, parseBand, parsePushStatus, readAlertAnswer } from './alerts';
import { parseKnown, readKnown, writeKnown } from './known';

const W = '0xAbCdEf0000000000000000000000000000000001' as const;
const SIG = '0x1234' as const;

describe('alert messages and bodies', () => {
  it('signs the shared messages, byte for byte', () => {
    expect(alertMessage('link', W, 84532, 100)).toBe(buildTelegramLinkMessage(W, 84532, 100));
    expect(alertMessage('unlink', W, 84532, 100)).toBe(buildTelegramUnlinkMessage(W, 84532, 100));
    expect(alertMessage('test-alert', W, 84532, 100)).toBe(buildTelegramTestMessage(W, 84532, 100));
    const save = { dueDateReminders: false } as const;
    expect(alertMessage({ save }, W, 84532, 100)).toBe(buildAlertSettingsMessage(W, 84532, save, 100));
  });

  it('routes each action', () => {
    expect(alertRoute('link')).toEqual({ method: 'POST', path: '/link/telegram' });
    expect(alertRoute('unlink')).toEqual({ method: 'POST', path: '/unlink/telegram' });
    expect(alertRoute('test-alert')).toEqual({ method: 'POST', path: '/telegram/test' });
    expect(alertRoute({ save: {} })).toEqual({ method: 'PUT', path: '/thresholds' });
  });

  it('sends only what a save changes', () => {
    expect(alertBody('link', W, 1, 2, SIG)).toEqual({ wallet: W, chain_id: 1, issuedAt: 2, signature: SIG });
    expect(alertBody({ save: { dueDateReminders: false } }, W, 1, 2, SIG)).toEqual({ wallet: W, chain_id: 1, issuedAt: 2, signature: SIG, notify_maturity_approaching: false });
    expect(alertBody({ save: { pushAlerts: true } }, W, 1, 2, SIG)).toEqual({ wallet: W, chain_id: 1, issuedAt: 2, signature: SIG, push_channel: 'subscribed' });
    expect(alertBody({ save: { bands: { warnHf: 1.6, alertHf: 1.3, criticalHf: 1.1 } } }, W, 1, 2, SIG)).toEqual({
      wallet: W,
      chain_id: 1,
      issuedAt: 2,
      signature: SIG,
      warn_hf: 1.6,
      alert_hf: 1.3,
      critical_hf: 1.1,
    });
  });
});

describe('bands', () => {
  it('reads plain decimals only', () => {
    expect(parseBand(' 1.5 ')).toBe(1.5);
    expect(parseBand('1.0500')).toBe(1.05);
    expect(parseBand('1e1')).toBeNaN();
    expect(parseBand('')).toBeNaN();
    expect(parseBand('-1')).toBeNaN();
  });
  it('refuses what the service refuses', () => {
    expect(bandsProblem({ warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05 })).toBeNull();
    expect(bandsProblem({ warnHf: Number.NaN, alertHf: 1.2, criticalHf: 1.05 })).toBe('not-numbers');
    expect(bandsProblem({ warnHf: 1.2, alertHf: 1.2, criticalHf: 1.05 })).toBe('order');
    expect(bandsProblem({ warnHf: 1.5, alertHf: 1.2, criticalHf: 1 })).toBe('floor');
  });
});

describe('push status', () => {
  const channel = '0x00000000000000000000000000000000000000aa';
  it('reads the two shapes strictly', () => {
    expect(parsePushStatus({ available: true, channel, scope: 'service', billedChainIds: [] })).toEqual({ kind: 'available', channel, scope: 'service', billedChainIds: [] });
    expect(parsePushStatus({ available: false, reason: 'signer-unset', rail: 'keeper', scope: 'service', billedChainIds: [84532] })).toEqual({
      kind: 'unavailable',
      reason: 'signer-unset',
      rail: 'keeper',
      scope: 'service',
      billedChainIds: [84532],
    });
    expect(parsePushStatus({ available: false, reason: 'x', scope: 'agent', billedChainIds: [] })).toMatchObject({ rail: null });
  });
  it('never reads an odd answer as available', () => {
    expect(parsePushStatus(null)).toBeNull();
    expect(parsePushStatus({ available: true, channel: 'nope', scope: 'service', billedChainIds: [] })).toBeNull();
    expect(parsePushStatus({ available: true, channel, scope: 'all', billedChainIds: [] })).toBeNull();
    expect(parsePushStatus({ available: true, channel, scope: 'service' })).toBeNull();
    expect(parsePushStatus({ available: false, reason: 'x', rail: 'other', scope: 'agent', billedChainIds: [] })).toBeNull();
    expect(parsePushStatus({ available: 'yes', channel, scope: 'service', billedChainIds: [] })).toBeNull();
  });
});

describe('answers', () => {
  it('reads a link code and only a real bot link', () => {
    expect(readAlertAnswer('link', 200, { ok: true, code: 'ABCD2345', bot_url: 'https://t.me/vaipakam_bot?start=ABCD2345' })).toEqual({
      ok: true,
      action: 'link',
      code: 'ABCD2345',
      botUrl: 'https://t.me/vaipakam_bot?start=ABCD2345',
    });
    expect(readAlertAnswer('link', 200, { ok: true, code: 'ABCD2345', bot_url: 'https://evil.example/x' })).toMatchObject({ botUrl: null });
    expect(readAlertAnswer('link', 200, { ok: true })).toEqual({ ok: false, problem: 'other', status: 200 });
  });
  it('reads an unlink’s scope and pending networks', () => {
    expect(
      readAlertAnswer('unlink', 200, {
        ok: true,
        scope: 'chain',
        pending: [{ chain_id: 84532, effective_at: 1_800_000_000 }, { chain_id: 97, effective_at: null }, 84532, { chain_id: 'x', effective_at: 1 }],
      }),
    ).toEqual({
      ok: true,
      action: 'unlink',
      scope: 'chain',
      pending: [
        { chainId: 84532, effectiveAt: 1_800_000_000 },
        { chainId: 97, effectiveAt: null },
      ],
    });
    expect(readAlertAnswer('unlink', 200, { ok: true })).toEqual({ ok: false, problem: 'other', status: 200 });
  });
  it('reads a save’s push outcome, older services as stored', () => {
    expect(readAlertAnswer({ save: { pushAlerts: true } }, 200, { ok: true, push: 'kept' })).toEqual({ ok: true, action: 'save', push: 'kept' });
    expect(readAlertAnswer({ save: { pushAlerts: true } }, 200, { ok: true })).toEqual({ ok: true, action: 'save', push: 'stored' });
    expect(readAlertAnswer({ save: { dueDateReminders: true } }, 200, { ok: true })).toEqual({ ok: true, action: 'save', push: 'not-requested' });
  });
  it('names each refusal', () => {
    const cases: [Parameters<typeof readAlertAnswer>[0], number, Record<string, unknown> | null, string][] = [
      ['link', 409, { error: 'request-already-used' }, 'used'],
      [{ save: { pushAlerts: true } }, 409, { error: 'push-unavailable' }, 'push-unavailable'],
      ['link', 503, { error: 'verification-unavailable' }, 'verify-down'],
      [{ save: {} }, 503, { error: 'optout-unavailable' }, 'storage-pending'],
      ['unlink', 503, { error: 'protection-unknown' }, 'protection-unknown'],
      ['test-alert', 503, { error: 'bot-not-configured' }, 'bot-off'],
      ['test-alert', 404, { error: 'not-linked' }, 'not-linked'],
      ['test-alert', 429, { error: 'rate-limited' }, 'cooldown'],
      ['link', 429, { error: 'rate-limited' }, 'busy'],
      ['test-alert', 502, { error: 'send-failed' }, 'send-failed'],
      [{ save: {} }, 400, { error: 'chain-not-configured' }, 'chain-not-watched'],
      ['link', 401, { error: 'verification_failed' }, 'refused'],
      ['link', 400, { error: 'verification_failed' }, 'refused'],
      ['test-alert', 404, null, 'other'],
      ['link', 500, null, 'other'],
    ];
    for (const [action, status, data, problem] of cases) expect(readAlertAnswer(action, status, data)).toEqual({ ok: false, problem, status });
  });
});

describe('what this browser knows', () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }
  it('keeps one record per network and wallet, merged', () => {
    const s = memory();
    writeKnown(84532, W, { dueDate: { on: false, at: 5 } }, s);
    writeKnown(84532, W.toLowerCase() as `0x${string}`, { telegram: { state: 'confirmed', at: 6 } }, s);
    expect(readKnown(84532, W, s)).toEqual({ dueDate: { on: false, at: 5 }, telegram: { state: 'confirmed', at: 6 } });
    expect(readKnown(97, W, s)).toEqual({});
  });
  it('drops a field it cannot read', () => {
    expect(parseKnown({ telegram: { state: 'linked', at: 1 }, push: { at: 2, outcome: 'stored' }, bands: { warnHf: 'x' } })).toEqual({ push: { at: 2, outcome: 'stored' } });
    expect(parseKnown('nope')).toEqual({});
    const unlinked = { state: 'unlinked', at: 3, scope: 'chain' };
    const held = { at: 3, pending: [{ chainId: 84532, effectiveAt: null }, { chainId: 421614, effectiveAt: 1_800_000_000 }] };
    expect(parseKnown({ telegram: unlinked, held })).toEqual({ telegram: unlinked, held });
    // A malformed hold is dropped on its own; the link state stays.
    expect(parseKnown({ telegram: unlinked, held: { ...held, pending: [84532] } })).toEqual({ telegram: unlinked });
    expect(parseKnown({ held: { pending: [] } })).toEqual({});
  });
  it('keeps a hold when a code or a test alert is recorded later', () => {
    const s = memory();
    const held = { at: 3, pending: [{ chainId: 421614, effectiveAt: null }] };
    writeKnown(84532, W, { telegram: { state: 'unlinked', at: 3, scope: 'wallet' }, held }, s);
    writeKnown(84532, W, { telegram: { state: 'code', at: 4, expiresAt: 604 } }, s);
    writeKnown(84532, W, { telegram: { state: 'confirmed', at: 5 } }, s);
    expect(readKnown(84532, W, s)).toEqual({ telegram: { state: 'confirmed', at: 5 }, held });
  });
  it('works with no storage, and keeps what this visit did when storage refuses', () => {
    const none = '0x00000000000000000000000000000000000000a1' as const;
    expect(readKnown(1, none, null)).toEqual({});
    writeKnown(1, none, { dueDate: { on: false, at: 1 } }, null);
    // A later change merges into what this visit did, not into nothing.
    expect(writeKnown(1, none, { bands: { warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05, at: 2 } }, null)).toEqual({
      dueDate: { on: false, at: 1 },
      bands: { warnHf: 1.5, alertHf: 1.2, criticalHf: 1.05, at: 2 },
    });
    // Storage holding an older copy, then refusing writes: the visit's own record wins.
    const w = '0x00000000000000000000000000000000000000a2' as const;
    const old = memory();
    writeKnown(84532, w, { dueDate: { on: true, at: 1 } }, old);
    const full = { getItem: old.getItem, setItem: () => { throw new Error('quota'); } };
    writeKnown(84532, w, { dueDate: { on: false, at: 2 } }, full);
    writeKnown(84532, w, { push: { at: 3, outcome: 'stored' } }, full);
    expect(readKnown(84532, w, full)).toEqual({ dueDate: { on: false, at: 2 }, push: { at: 3, outcome: 'stored' } });
    // Once a write reaches storage again, storage is the record.
    writeKnown(84532, w, {}, old);
    expect(readKnown(84532, w, old)).toEqual({ dueDate: { on: false, at: 2 }, push: { at: 3, outcome: 'stored' } });
  });
});

describe('issuedAt', () => {
  it('never repeats a second, so a quick second request is not a repeat', async () => {
    const { nextIssuedAt } = await import('./useAlertAction');
    const a = nextIssuedAt(1_000_000_000_000);
    const b = nextIssuedAt(1_000_000_000_500);
    const c = nextIssuedAt(1_000_000_010_000);
    expect(b).toBe(a + 1);
    expect(c).toBe(1_000_000_010);
  });
  it('carries the last second across a reload through storage', async () => {
    const { nextIssuedAt } = await import('./useAlertAction');
    const m = new Map<string, string>([['alpha05.alerts.lastIssuedAt', '1500000100']]);
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(nextIssuedAt(1_500_000_000_000, store)).toBe(1_500_000_101);
    expect(m.get('alpha05.alerts.lastIssuedAt')).toBe('1500000101');
  });
  it('drops a count left far ahead by a clock that was fast, so requests work again once it is corrected', async () => {
    const { nextIssuedAt } = await import('./useAlertAction');
    const m = new Map<string, string>([['alpha05.alerts.lastIssuedAt', '1600003600']]);
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    // The fast clock's own count is an hour ahead of the corrected clock.
    nextIssuedAt(1_600_003_600_000, store);
    expect(nextIssuedAt(1_600_000_000_000, store)).toBe(1_600_000_000);
    expect(nextIssuedAt(1_600_000_000_000, store)).toBe(1_600_000_001);
  });
});
