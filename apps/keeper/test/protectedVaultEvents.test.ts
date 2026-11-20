// apps/keeper/test/protectedVaultEvents.test.ts — #3346: the vault's own
// security events reach the account's manager, read from the chain and
// believed only from a real vault.

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { parseAddressedAlert, renderTelegramAlert, type AddressedAlert } from '@vaipakam/lib/telegramAlerts/message';
import { memoryScanCursors } from '../src/scanCursors';
import {
  TAIL_BACKLOG,
  TAIL_ITEM,
  memoryVaultSet,
  missingEvents,
  vaultAlert,
  vaultSecurityAlerts,
  type VaultCreation,
  type VaultLog,
  type VaultTailDeps,
} from '../src/protectedVaultEvents';
import type { SendResult } from '../src/ownerAlertSend';

const ALICE = '0x00000000000000000000000000000000000000a1' as Address;
const BOB = '0x00000000000000000000000000000000000000b2' as Address;
const SIGNER = '0x00000000000000000000000000000000000000c3' as Address;
const VAULT_A = '0x00000000000000000000000000000000000000d4' as Address;
const FAKE = '0x00000000000000000000000000000000000000e5' as Address;

const lock = (address: Address, block: number, log = 0, account: Address = ALICE): VaultLog => ({ kind: 'VaultLocked', args: { account, by: SIGNER }, address, block, log });

function setup() {
  const sent: AddressedAlert[] = [];
  const st = {
    head: 1000n,
    logs: [] as VaultLog[],
    creations: [{ vault: VAULT_A, owner: ALICE, block: 10 }] as VaultCreation[],
    diamondVault: new Map<Address, Address>([[ALICE, VAULT_A]]),
    outcome: 'sent' as SendResult,
    vaultReads: 0,
    creationFails: false,
  };
  const cursors = memoryScanCursors();
  const vaultSet = memoryVaultSet();
  const deps = (): VaultTailDeps => ({
    reads: {
      floor: 1,
      head: async () => st.head,
      creations: async (from, to) => {
        if (st.creationFails) throw new Error('rpc down');
        return st.creations.filter((c) => BigInt(c.block) >= from && BigInt(c.block) <= to);
      },
      logs: async (from, to) => st.logs.filter((l) => BigInt(l.block) >= from && BigInt(l.block) <= to),
      vaults: async (accounts) => {
        st.vaultReads += 1;
        return accounts.map((a) => st.diamondVault.get(a) ?? ('0x' + '0'.repeat(40)) as Address);
      },
      manager: async (a) => a,
    },
    vaultSet,
    cursors,
    chainId: 84532,
    diamond: '0x0000000000000000000000000000000000000001',
    subscriber: async () => null,
    notify: async (a) => {
      sent.push(a.telegram!.message as AddressedAlert);
      const o = st.outcome;
      return o === 'sent' ? { telegram: 'sent', push: 'off' } : o === 'retry' ? { telegram: 'retry', push: 'off' } : { telegram: 'off', push: 'off' };
    },
    appOrigin: 'https://app.example',
    cutoff: Date.now() + 60_000,
  });
  return { sent, st, cursors, vaultSet, run: () => vaultSecurityAlerts(deps()) };
}

describe('vaultAlert', () => {
  it('names every loosening request, and nothing for a tightening one', () => {
    const at = { address: VAULT_A, block: 1, log: 0 };
    expect(vaultAlert({ ...at, kind: 'VaultLocked', args: { account: ALICE, by: SIGNER } })).toEqual({ kind: 'locked', by: SIGNER });
    expect(vaultAlert({ ...at, kind: 'ReplacementProposed', args: { account: ALICE, nominee: BOB, by: SIGNER, round: 1n } })).toEqual({ kind: 'replacement', nominee: BOB, by: SIGNER });
    expect(vaultAlert({ ...at, kind: 'ProtectionSettingRequested', args: { account: ALICE, action: 4, value: 0n, at: 2000n, by: ALICE } })).toMatchObject({ change: 'unlockRequested', at: 2000, by: ALICE });
    expect(vaultAlert({ ...at, kind: 'ProtectionSettingRequested', args: { account: ALICE, action: 2, value: 3600n, at: 2000n, by: ALICE } })).toMatchObject({ change: 'delayShortRequested', seconds: 3600 });
    expect(vaultAlert({ ...at, kind: 'ProtectionSettingRequested', args: { account: ALICE, action: 3, value: 0n, at: 2000n, by: ALICE } })).toMatchObject({ change: 'switchOffRequested' });
    expect(vaultAlert({ ...at, kind: 'ProtectionSettingRequested', args: { account: ALICE, action: 1, value: 0n, at: 2000n, by: ALICE } })).toBeNull();
    expect(vaultAlert({ ...at, kind: 'SignerAddRequested', args: { account: ALICE, signer: BOB, readyAt: 9n, by: ALICE } })).toMatchObject({ change: 'signerAddRequested', subject: BOB, at: 9 });
    expect(vaultAlert({ ...at, kind: 'AllowlistAddRequested', args: { account: ALICE, destination: BOB, readyAt: 9n, by: ALICE } })).toMatchObject({ change: 'allowlistAddRequested', subject: BOB });
    expect(vaultAlert({ ...at, kind: 'RecoveryAddressCleared', args: { account: ALICE, recovery: BOB, by: ALICE } })).toMatchObject({ change: 'recoveryCleared', subject: BOB, at: null });
    expect(vaultAlert({ ...at, kind: 'RecoveryClaimSettingRequested', args: { account: ALICE, wait: 86400, at: 9n, by: SIGNER } })).toMatchObject({ change: 'claimSettingRequested', seconds: 86400, by: SIGNER });
  });
  it('finds every event it reads in the exported vault ABI', () => {
    expect(missingEvents()).toEqual([]);
  });
});

describe('vaultSecurityAlerts (#3346)', () => {
  it('starts at the head, then alerts on a real vault and never twice', async () => {
    const { sent, st, cursors, run } = setup();
    st.logs = [lock(VAULT_A, 900)];
    await run();
    expect(sent).toEqual([]);
    expect(cursors.rows.size).toBe(1);
    st.logs.push(lock(VAULT_A, 1001), lock(VAULT_A, 1002, 3));
    st.head = 1005n;
    const r = await run();
    expect(r.sent).toBe(2);
    expect(sent[0]).toMatchObject({ wallet: ALICE, alert: { kind: 'locked', by: SIGNER } });
    await run();
    expect(sent).toHaveLength(2);
  });

  it('drops a log from an unknown address without a chain read, and one naming another account', async () => {
    const { sent, st, run } = setup();
    await run();
    st.logs = [lock(FAKE, 1001), lock(VAULT_A, 1002, 0, BOB)];
    st.head = 1003n;
    const r = await run();
    expect(sent).toEqual([]);
    expect(r.foreign).toBe(2);
    expect(st.vaultReads).toBe(0);
  });

  it('believes a hit only when the Diamond names the same vault', async () => {
    const { sent, st, run } = setup();
    await run();
    st.diamondVault.set(ALICE, FAKE);
    st.logs = [lock(VAULT_A, 1001)];
    st.head = 1002n;
    expect((await run()).foreign).toBe(1);
    expect(sent).toEqual([]);
  });

  it('waits for the vault set before dropping a log it does not know', async () => {
    const { sent, st, cursors, run } = setup();
    await run();
    st.creationFails = true;
    st.logs = [lock(VAULT_A, 1001)];
    st.head = 1002n;
    // The set was read through 1000 by the first run, so a vault created at
    // 1001 is not known yet; with the creations unread, the tail waits.
    st.creations.push({ vault: '0x00000000000000000000000000000000000000f6' as Address, owner: BOB, block: 1001 });
    st.logs = [lock('0x00000000000000000000000000000000000000f6' as Address, 1001, 1, BOB)];
    st.diamondVault.set(BOB, '0x00000000000000000000000000000000000000f6' as Address);
    const r = await run();
    expect(r.unread).toMatch(/vault set/);
    const pos = cursors.rows.get(TAIL_ITEM);
    st.creationFails = false;
    await run();
    expect(sent.map((m) => m.wallet)).toEqual([BOB]);
    expect(cursors.rows.get(TAIL_ITEM)).not.toBe(pos);
  });

  it('keeps its place on a retry, and jumps a backlog wider than it works', async () => {
    const { sent, st, run } = setup();
    await run();
    st.logs = [lock(VAULT_A, 1001)];
    st.head = 1002n;
    st.outcome = 'retry';
    expect((await run()).retrying).toBe(1);
    st.outcome = 'sent';
    await run();
    expect(sent).toHaveLength(2);
    st.head = 1002n + TAIL_BACKLOG + 50n;
    expect((await run()).skippedBlocks).toBe(49);
  });
});

describe('the securityChange message', () => {
  it('parses, refuses a bad field, and renders in every locale', () => {
    const raw = { chainId: 84532, wallet: ALICE, alert: { kind: 'securityChange', change: 'signerAddRequested', subject: BOB, what: null, seconds: null, at: 1_800_000_000, by: SIGNER } };
    const m = parseAddressedAlert(raw)!;
    expect(m).not.toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, change: 'nope' } })).toBeNull();
    expect(parseAddressedAlert({ ...raw, alert: { ...raw.alert, subject: 'evil.example' } })).toBeNull();
    const ctx = { chainName: 'Base Sepolia', appOrigin: 'https://app.example' };
    const en = renderTelegramAlert(m, { ...ctx, locale: 'en' }).text;
    expect(en).toContain(`Adding the signer ${BOB} was requested.`);
    expect(en).toContain('lock the vault in the app now');
    const delay = parseAddressedAlert({ ...raw, alert: { ...raw.alert, change: 'delayShortRequested', subject: null, seconds: 5400 } })!;
    expect(renderTelegramAlert(delay, { ...ctx, locale: 'en' }).text).toContain('1.5 hours');
    for (const locale of ['es', 'fr', 'de', 'ja', 'zh', 'ko', 'hi', 'ta', 'ar']) {
      const t = renderTelegramAlert(m, { ...ctx, locale }).text;
      expect(t, locale).not.toBe(en);
      expect(t).toContain(BOB);
    }
  });
});
