/**
 * #3721 / #3434 — the owner-alert pass, over the REAL shared schema (every
 * indexer migration, which owns it), with the rails and the chain read
 * stubbed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  alertOf,
  renderAlert,
  runOwnerAlertsChain,
  wants,
  STALE_AFTER_SEC,
  type OwnerAlertDeps,
} from '../src/ownerAlerts';
import { createSqliteD1 } from '../../indexer/test/helpers/sqliteD1';

const DIR = new URL('../../indexer/migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), 'utf8'));

const CHAIN = { id: 84532, name: 'Base Sepolia' };
const NOW = 1_800_000_000;
const OWNER = '0x00000000000000000000000000000000000000Aa';
const OTHER = '0x00000000000000000000000000000000000000Bb';
const TO = '0x00000000000000000000000000000000000000Cc';
const USDC = '0x00000000000000000000000000000000000000Dd';

function setup() {
  const h = createSqliteD1(MIGRATIONS);
  let n = 0;
  const event = (kind: string, args: Record<string, unknown>, block: number, at = NOW - 60) =>
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(CHAIN.id, block, n++, '0xaa', kind, JSON.stringify(args), at);
  const owner = (wallet: string, push: boolean, outflow: number | null) =>
    h.db
      .prepare(
        `INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, push_channel, locale, created_at, updated_at, notify_vault_outflow)
         VALUES (?, ?, 1.5, 1.2, 1.05, ?, 'en', 1, 1, ?)`,
      )
      .run(wallet.toLowerCase(), CHAIN.id, push ? 'subscribed' : null, outflow);
  const sent: { rail: string; to: string; text: string }[] = [];
  const deps = (over: Partial<OwnerAlertDeps> = {}): OwnerAlertDeps => ({
    db: h.d1 as D1Database,
    chatsOf: async (pairs) => pairs.map((p) => (p.wallet === OWNER.toLowerCase() ? 'chat-1' : null)),
    sendTelegram: async (chat, text) => {
      sent.push({ rail: 'tg', to: chat, text });
      return 'accepted';
    },
    sendPush: async (wallet, title, body) => {
      sent.push({ rail: 'push', to: wallet, text: `${title}\n${body}` });
      return 'accepted';
    },
    readDecimals: async (assets) => new Map(assets.map((a) => [a.toLowerCase(), 6])),
    decimalsProbeCostsARequest: () => false,
    link: 'https://app.example',
    ...over,
  });
  const cursor = () => h.db.prepare('SELECT block_number, log_index FROM owner_alert_cursor').get();
  return { h, event, owner, sent, deps, cursor };
}

const approval = { owner: OWNER, approved: TO, tokenId: '7' };
const outflow = (owner = OWNER) => ({
  owner,
  vault: OTHER,
  asset: USDC,
  tokenId: '0',
  amount: '1500000',
  delivered: '1500000',
  to: TO,
  class_: 0,
  reason: 0,
  ref: '0',
});

describe('runOwnerAlertsChain', () => {
  it('starts at the newest event on its first pass, sending no history', async () => {
    const t = setup();
    t.event('Approval', approval, 10);
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    expect(t.sent).toEqual([]);
    expect(t.cursor()).toEqual({ block_number: 10, log_index: 0 });
  });

  it('sends an approval to the owner on every linked rail, then moves past it', async () => {
    const t = setup();
    t.event('Approval', approval, 10);
    t.owner(OWNER, true, null);
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW); // initialise
    t.event('Approval', approval, 11);
    t.event('Approval', { ...approval, approved: '0x0000000000000000000000000000000000000000' }, 12); // cleared: nothing
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    expect(t.sent.map((s) => s.rail).sort()).toEqual(['push', 'tg']);
    expect(t.sent[0]!.text).toContain(`Your position token #7 on Base Sepolia was approved for transfer to ${TO.toLowerCase()}`);
    expect(t.cursor()).toEqual({ block_number: 12, log_index: 2 });
    // Delivered once: a second pass sends nothing more.
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    expect(t.sent).toHaveLength(2);
  });

  it('sends an outflow only to an owner who chose it, or a protected one who did not choose', async () => {
    const t = setup();
    t.event('Approval', approval, 1);
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    const chats = async (pairs: { wallet: string }[]) => pairs.map((p) => `chat-${p.wallet}`);
    // OWNER: not chosen, not protected → nothing. OTHER: not chosen, protected → sent.
    t.owner(OWNER, false, null);
    t.event('ProtectionApplied', { account: OTHER, enabled: true, locked: false, retired: false, delaySeconds: '86400' }, 2);
    t.event('VaultOutflow', outflow(OWNER), 3);
    t.event('VaultOutflow', outflow(OTHER), 3);
    await runOwnerAlertsChain(t.deps({ chatsOf: chats, sendPush: null }), CHAIN, { remaining: 12 }, NOW);
    expect(t.sent.map((s) => s.to)).toEqual([`chat-${OTHER.toLowerCase()}`]);
    expect(t.sent[0]!.text).toContain(`1.5 of the token ${USDC.toLowerCase()} left your vault on Base Sepolia to ${TO.toLowerCase()}. Reason: your own withdrawal.`);
    // A retired protection is off again; an explicit 0 is off whatever the mode.
    t.sent.length = 0;
    t.event('ProtectionApplied', { account: OTHER, enabled: true, locked: false, retired: true, delaySeconds: '0' }, 4);
    t.event('VaultOutflow', outflow(OTHER), 5);
    await runOwnerAlertsChain(t.deps({ chatsOf: chats, sendPush: null }), CHAIN, { remaining: 12 }, NOW);
    expect(t.sent).toEqual([]);
  });

  it('stops before an event the allowance cannot carry, and resumes there', async () => {
    const t = setup();
    t.event('Approval', approval, 1);
    t.owner(OWNER, false, null);
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    for (let b = 2; b < 8; b++) t.event('Approval', approval, b);
    // 1 read + 1 settings + 1 chats + sends + 1 cursor write: 6 leaves room for 2 sends.
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 6 }, NOW);
    expect(t.sent).toHaveLength(2);
    expect(t.cursor()).toMatchObject({ block_number: 3 });
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    expect(t.sent).toHaveLength(6);
  });

  it('skips an event older than the stale window, with no send', async () => {
    const t = setup();
    t.event('Approval', approval, 1);
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    t.event('Approval', approval, 2, NOW - STALE_AFTER_SEC - 1);
    await runOwnerAlertsChain(t.deps(), CHAIN, { remaining: 12 }, NOW);
    expect(t.sent).toEqual([]);
    expect(t.cursor()).toMatchObject({ block_number: 2 });
  });
});

describe('alertOf / renderAlert / wants', () => {
  const row = (kind: string, args: Record<string, unknown>) => ({ block_number: 1, log_index: 0, kind, args_json: JSON.stringify(args), block_at: 0 });

  it('reads each kind, and refuses what warrants nothing', () => {
    expect(alertOf(row('Approval', approval))).toMatchObject({ type: 'approved', tokenId: '7' });
    expect(alertOf(row('ApprovalForAll', { owner: OWNER, operator: TO, approved: true }))).toMatchObject({ type: 'approvedAll' });
    expect(alertOf(row('ApprovalForAll', { owner: OWNER, operator: TO, approved: false }))).toBeNull();
    expect(alertOf(row('VaultOutflow', { ...outflow(), reason: 5, ref: '9' }))).toMatchObject({ type: 'outflow', reason: 5, ref: '9' });
    expect(alertOf(row('VaultOutflow', { ...outflow(), to: 'nope' }))).toBeNull();
  });

  it('states the amount in the smallest unit when the decimals are unknown, and names the loan', () => {
    const a = alertOf(row('VaultOutflow', { ...outflow(), reason: 5, ref: '9' }))!;
    const { body } = renderAlert(a, 'Base', new Map());
    expect(body).toContain("1500000 of the token");
    expect(body).toContain("in the token's smallest unit");
    expect(body).toContain('Reason: a repayment to the lender side. It belongs to loan #9.');
    const unknown = renderAlert({ ...(a as never), reason: 99 }, 'Base', new Map());
    expect(unknown.body).toContain('reason code 99');
  });

  it('an approval is always wanted; an outflow by choice or protection', () => {
    const a = alertOf(row('Approval', approval))!;
    const o = alertOf(row('VaultOutflow', outflow()))!;
    const s = (outflow: number | null, prot: boolean) => ({ push: false, outflow, protected: prot });
    expect(wants(a, s(0, false))).toBe(true);
    expect(wants(o, s(null, false))).toBe(false);
    expect(wants(o, s(null, true))).toBe(true);
    expect(wants(o, s(0, true))).toBe(false);
    expect(wants(o, s(1, false))).toBe(true);
  });
});
