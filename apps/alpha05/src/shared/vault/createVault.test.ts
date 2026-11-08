import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import { createdVault, createVaultBlockers, createVaultChanged, measureCreateVault, type CreateVaultReview } from './createVault';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const VAULT = '0x00000000000000000000000000000000000000f1' as Hex;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};

function review(p: Partial<CreateVaultReview>): CreateVaultReview {
  return { identity: 'i', existing: null, frozen: null, dryRun: null, readAt: 0, ...p };
}

function created(user: Hex, proxy: Hex, address: Hex = DIAMOND): Log {
  const topics = encodeEventTopics({ abi: VaultFactoryFacetABI as Abi, eventName: 'UserVaultCreated', args: { user } });
  return { address, topics, data: encodeAbiParameters([{ type: 'address' }], [proxy]) } as unknown as Log;
}

describe('createVaultBlockers', () => {
  it('open when no vault exists and the dry run passes', () => {
    expect(createVaultBlockers(review({}), copy)).toEqual([]);
  });
  it('an existing vault, a flagged wallet, an unread or refused dry run each stop it', () => {
    expect(createVaultBlockers(review({ existing: VAULT }), copy)).toEqual(['vault.alreadyExists']);
    expect(createVaultBlockers(review({ frozen: 'flagged' }), copy)).toEqual(['vault.createFlagged']);
    expect(createVaultBlockers(review({ dryRun: 'unread' }), copy)).toEqual(['vault.dryRunUnread']);
    expect(createVaultBlockers(review({ dryRun: { code: 'SanctionsOracleUnavailable', reason: 'x', reopensAt: null, remedy: null } }), copy)).toEqual(['vault.createOutage']);
    expect(createVaultBlockers(review({ dryRun: { code: 'Other', reason: 'r', reopensAt: null, remedy: null } }), copy)).toEqual(['repay.dryRunRefused:{"reason":"r"}']);
  });
});

describe('createVaultChanged', () => {
  it('a vault appearing, the screen or the dry run changing is a change', () => {
    expect(createVaultChanged(review({}), review({}), copy)).toBeNull();
    expect(createVaultChanged(review({}), review({ existing: VAULT }), copy)).toBe('vault.changedExists');
    expect(createVaultChanged(review({}), review({ frozen: 'flagged' }), copy)).toBe('repay.changedVerdict');
    expect(createVaultChanged(review({}), review({ dryRun: 'unread' }), copy)).toBe('repay.changedVerdict');
  });
});

describe('measureCreateVault', () => {
  it('names the vault the record gives for this wallet', () => {
    expect(createdVault([created(ME, VAULT)], DIAMOND, ME)).toBe(VAULT);
    expect(measureCreateVault([created(ME, VAULT)], DIAMOND, ME, copy)[0]).toMatchObject({ status: 'done' });
  });
  it('a record for another wallet, or from another contract, is not this vault', () => {
    expect(createdVault([created(OTHER, VAULT)], DIAMOND, ME)).toBeNull();
    expect(createdVault([created(ME, VAULT, OTHER)], DIAMOND, ME)).toBeNull();
    expect(measureCreateVault([], DIAMOND, ME, copy)[0]).toMatchObject({ status: 'not-done', reason: 'vault.notCreated' });
  });
});
