/**
 * #3365 — the keeper fee balance alert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import type { ChainConfig, Env } from '../src/env';
import {
  ALERT_INTERVAL_SEC,
  assess,
  checkChain,
  criticalKey,
  DEFAULT_LIQUIDATION_GAS,
  describeOutcome,
  lowKey,
  recoveredKey,
  reserveSettings,
  runKeeperFeeBalance,
  type FeeBalanceDeps,
} from '../src/keeperFeeBalance';
import type { OpsAlertOutcome } from '../src/opsAlert';

const WALLET = '0xD9257B636E17D5714DD54F260c9F7EB81349E49B' as Address;
const BASE: ChainConfig = { id: 84532, name: 'Base Sepolia', rpc: 'http://base', diamond: '0x1' };
const BNB: ChainConfig = { id: 97, name: 'BNB Testnet', rpc: 'http://bnb', diamond: '0x2' };
const GWEI = 10n ** 9n;
/** One default liquidation at 1 gwei. */
const ONE = DEFAULT_LIQUIDATION_GAS * GWEI;

let balance: bigint;
let fee: bigint;
let readFails: boolean;
let records: Map<string, unknown>;
let sent: { key: string; text: string; interval: number }[];
let outcome: OpsAlertOutcome;

const deps: FeeBalanceDeps = {
  readBalance: async () => {
    if (readFails) throw new Error('rpc down');
    return balance;
  },
  readFeePerGas: async () => fee,
  send: async (_env, key, text, interval) => {
    sent.push({ key, text, interval });
    if (outcome === 'sent') records.set(key, { firstSeenAt: 1, lastSentAt: 1 });
    return outcome;
  },
  prior: async (_env, key) => records.get(key) ?? null,
  clear: async (_env, key) => {
    records.delete(key);
  },
};

const env = (over: Partial<Env> = {}): Env => ({ ...over }) as unknown as Env;

beforeEach(() => {
  balance = 100n * ONE;
  fee = GWEI;
  readFails = false;
  records = new Map();
  sent = [];
  outcome = 'sent';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('assess', () => {
  it('prices the reserve as liquidations x gas x fee and grades the balance', () => {
    expect(assess(20n * ONE, GWEI, 20n, DEFAULT_LIQUIDATION_GAS)).toMatchObject({ reserveWei: 20n * ONE, level: 'ok', recovered: false });
    expect(assess(20n * ONE - 1n, GWEI, 20n, DEFAULT_LIQUIDATION_GAS).level).toBe('low');
    expect(assess(ONE - 1n, GWEI, 20n, DEFAULT_LIQUIDATION_GAS).level).toBe('critical');
    expect(assess(24n * ONE, GWEI, 20n, DEFAULT_LIQUIDATION_GAS).recovered).toBe(true);
  });
});

describe('reserveSettings', () => {
  it('reads the two knobs and keeps the defaults for unset or malformed values, saying so', () => {
    expect(reserveSettings({})).toEqual({ liquidations: { value: 20n }, gas: { value: DEFAULT_LIQUIDATION_GAS } });
    expect(reserveSettings({ KEEPER_FEE_RESERVE_LIQUIDATIONS: '5', KEEPER_FEE_RESERVE_LIQUIDATION_GAS: '900000' })).toEqual({
      liquidations: { value: 5n },
      gas: { value: 900000n },
    });
    const bad = reserveSettings({ KEEPER_FEE_RESERVE_LIQUIDATIONS: '0', KEEPER_FEE_RESERVE_LIQUIDATION_GAS: '1e6' });
    expect(bad.liquidations).toEqual({ value: 20n, malformed: expect.stringMatching(/KEEPER_FEE_RESERVE_LIQUIDATIONS is not a positive whole number/) });
    expect(bad.gas.value).toBe(DEFAULT_LIQUIDATION_GAS);
    expect(bad.gas.malformed).toMatch(/KEEPER_FEE_RESERVE_LIQUIDATION_GAS/);
  });
});

describe('checkChain (#3365)', () => {
  it('says nothing while the balance covers the reserve and no alert is open', async () => {
    const r = await checkChain(env(), BASE, WALLET, deps);
    expect(r.kind).toBe('ok');
    expect(sent).toEqual([]);
  });

  it('posts a low alert with the balance, the count it pays for and the assumptions', async () => {
    balance = 5n * ONE;
    const r = await checkChain(env(), BASE, WALLET, deps);
    expect(r).toMatchObject({ kind: 'alerted', outcome: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(lowKey(84532));
    expect(sent[0].interval).toBe(ALERT_INTERVAL_SEC);
    expect(sent[0].text).toMatch(/is low on ETH/);
    expect(sent[0].text).toMatch(/enough for 5 liquidation\(s\)/);
    expect(sent[0].text).toMatch(/20 liquidations of 2500000 gas each at the current fee of 1 gwei = 0\.05 ETH/);
    expect(sent[0].text).toMatch(/L1 data fee this OP-stack chain adds/);
    expect(sent[0].text).toContain(WALLET);
  });

  it('posts a critical alert under its own key when one liquidation is not covered, without the OP-stack note on BNB', async () => {
    balance = ONE / 2n;
    await checkChain(env(), BNB, WALLET, deps);
    expect(sent[0].key).toBe(criticalKey(97));
    expect(sent[0].text).toMatch(/^CRITICAL: .*BNB Testnet \(97\) cannot pay for even one liquidation/);
    expect(sent[0].text).toMatch(/BNB/);
    expect(sent[0].text).not.toMatch(/OP-stack/);
  });

  it('clears the critical record on the way back to low, so a new fall alerts at once', async () => {
    balance = ONE / 2n;
    await checkChain(env(), BASE, WALLET, deps);
    balance = 5n * ONE;
    await checkChain(env(), BASE, WALLET, deps);
    expect(records.has(criticalKey(84532))).toBe(false);
    expect(sent.map((s) => s.key)).toEqual([criticalKey(84532), lowKey(84532)]);
  });

  it('holds an open alert between the reserve and the recovery margin, then recovers once and clears', async () => {
    balance = 5n * ONE;
    await checkChain(env(), BASE, WALLET, deps);
    balance = 21n * ONE; // above the reserve, below 120%
    expect((await checkChain(env(), BASE, WALLET, deps)).kind).toBe('holding');
    expect(sent).toHaveLength(1);
    balance = 30n * ONE;
    const r = await checkChain(env(), BASE, WALLET, deps);
    expect(r).toMatchObject({ kind: 'recovered', outcome: 'sent' });
    expect(sent[1].key).toBe(recoveredKey(84532));
    expect(sent[1].interval).toBe(0);
    expect(sent[1].text).toMatch(/^Recovered: .* can pay for liquidations again/);
    expect(records.size).toBe(0);
    // Nothing more once recovered.
    expect((await checkChain(env(), BASE, WALLET, deps)).kind).toBe('ok');
    expect(sent).toHaveLength(2);
  });

  it('keeps the alert open when the recovery message failed, and retries next run', async () => {
    balance = 5n * ONE;
    await checkChain(env(), BASE, WALLET, deps);
    balance = 30n * ONE;
    outcome = 'failed';
    await checkChain(env(), BASE, WALLET, deps);
    expect(records.has(lowKey(84532))).toBe(true);
    outcome = 'sent';
    await checkChain(env(), BASE, WALLET, deps);
    expect(records.size).toBe(0);
  });

  it('changes no alert state on a failed read, and says so', async () => {
    balance = 5n * ONE;
    await checkChain(env(), BASE, WALLET, deps);
    readFails = true;
    const r = await checkChain(env(), BASE, WALLET, deps);
    expect(r.kind).toBe('unread');
    expect(describeOutcome(BASE, r)).toMatch(/balance or fee unread \(.+\); alert state unchanged/);
    expect(records.has(lowKey(84532))).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('names a malformed knob in the alert while still using the default', async () => {
    balance = 5n * ONE;
    await checkChain(env({ KEEPER_FEE_RESERVE_LIQUIDATIONS: 'many' }), BASE, WALLET, deps);
    expect(sent[0].text).toMatch(/Setting problem: KEEPER_FEE_RESERVE_LIQUIDATIONS is not a positive whole number, so the default 20 is used/);
  });
});

describe('runKeeperFeeBalance gate', () => {
  it('does nothing and says so while the flag is unset', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(l));
    await runKeeperFeeBalance(
      env({ KEEPER_ENABLED: 'true', KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}` }),
      { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 },
    );
    expect(lines).toEqual(['[keeper] keeperFeeBalance skipped: KEEPER_FEE_BALANCE_ALERT_ENABLED unset']);
  });
});
