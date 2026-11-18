import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, type Abi } from 'viem';
import { VaultRecoveryABI } from '@vaipakam/contracts/abis';
import {
  hasRecovery,
  parseRecoveryProof,
  parseRecoveryRequest,
  recoveryAddressProblem,
  recoveryAnswerLink,
  recoveryCall,
  recoveryRequestLink,
  recoveryWaitSeconds,
  type RecoveryAnswer,
} from './recovery';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const VAULT = '0x00000000000000000000000000000000000000f1' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const REC = '0x00000000000000000000000000000000000000a1' as Hex;
const DAY = 86_400;
const none = { inForce: null, pending: null, pendingAt: 0, recovered: false };

const params = (link: string) => new URL(link, 'https://x.test').searchParams;

describe('the recovery links', () => {
  it('a request carries the network, the account and the address, and reads back strictly', () => {
    const link = recoveryRequestLink({ chainId: 31337, account: ME, recovery: REC });
    expect(link).toContain('/protection?');
    expect(parseRecoveryRequest(params(link))).toEqual({ chainId: 31337, account: getAddress(ME), recovery: getAddress(REC) });
    const q = params(link);
    q.set('rr_recovery', 'nope');
    expect(parseRecoveryRequest(q)).toBeNull();
    q.delete('rr_recovery');
    expect(parseRecoveryRequest(q)).toBeNull();
  });

  it('an answer carries everything the signature names, and refuses any field of the wrong shape', () => {
    const a: RecoveryAnswer = { chainId: 31337, vault: VAULT, account: ME, diamond: DIAMOND, recovery: REC, nonce: 3n, expiry: 1_800_000_000, signature: '0xabcd' };
    const link = recoveryAnswerLink(a);
    expect(link).toContain('/vault?');
    expect(parseRecoveryProof(params(link))).toEqual({ ...a, vault: getAddress(VAULT), diamond: getAddress(DIAMOND), account: getAddress(ME), recovery: getAddress(REC) });
    for (const [k, v] of [
      ['rp_nonce', '-1'],
      ['rp_expiry', 'soon'],
      ['rp_sig', 'zz'],
      ['rp_vault', '0x12'],
    ]) {
      const q = params(link);
      q.set(k, v);
      expect(parseRecoveryProof(q)).toBeNull();
    }
  });

  it('the owner’s call asks directly and proves with the recovery wallet’s signature', () => {
    const a: RecoveryAnswer = { chainId: 31337, vault: VAULT, account: ME, diamond: DIAMOND, recovery: REC, nonce: 0n, expiry: 1_800_000_000, signature: '0xabcd' };
    const d = decodeFunctionData({ abi: VaultRecoveryABI as Abi, data: recoveryCall(a, ME) });
    expect(d.functionName).toBe('requestRecoveryAddress');
    expect(d.args).toEqual([getAddress(REC), { key: getAddress(ME), expiry: 0n, sig: '0x' }, { key: getAddress(REC), expiry: 1_800_000_000n, sig: '0xabcd' }]);
  });
});

describe('the recovery address rules the app can check', () => {
  it('refuses the wallet itself, its vault, the protocol and the current address', () => {
    expect(recoveryAddressProblem(ME, ME, VAULT, DIAMOND, none)).toBe('self');
    expect(recoveryAddressProblem(VAULT, ME, VAULT, DIAMOND, none)).toBe('vault');
    expect(recoveryAddressProblem(DIAMOND, ME, VAULT, DIAMOND, none)).toBe('protocol');
    expect(recoveryAddressProblem(REC, ME, VAULT, DIAMOND, { ...none, inForce: REC })).toBe('current');
    expect(recoveryAddressProblem(REC, ME, VAULT, DIAMOND, { ...none, pending: REC, pendingAt: 1 })).toBe('current');
    expect(recoveryAddressProblem(REC, ME, VAULT, DIAMOND, none)).toBeNull();
  });

  it('a first address waits twice the delay (the shortest while off); a change waits 30 days', () => {
    expect(recoveryWaitSeconds(none, false, 0, 2 * DAY)).toBe(4 * DAY);
    expect(recoveryWaitSeconds(none, true, 3 * DAY, 2 * DAY)).toBe(6 * DAY);
    expect(recoveryWaitSeconds({ ...none, inForce: REC }, true, 3 * DAY, 2 * DAY)).toBe(30 * DAY);
    expect(hasRecovery(none)).toBe(false);
    expect(hasRecovery({ ...none, pending: REC, pendingAt: 1 })).toBe(true);
  });
});
