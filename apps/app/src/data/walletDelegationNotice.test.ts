import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { delegationAckKey, walletDelegationNotice } from './walletDelegationNotice';

const DELEGATE = '0x00000000000000000000000000000000000000Cc';
const designator = (a: string) => `0xef0100${a.slice(2).toLowerCase()}` as `0x${string}`;

describe('walletDelegationNotice (#3434)', () => {
  it('says nothing for a plain wallet or a contract account', () => {
    expect(walletDelegationNotice(undefined, null)).toEqual({ kind: 'none' });
    expect(walletDelegationNotice('0x', null)).toEqual({ kind: 'none' });
    expect(walletDelegationNotice('0x6080604052', null)).toEqual({ kind: 'none' });
  });

  it('warns for a delegated wallet, naming the delegate', () => {
    expect(walletDelegationNotice(designator(DELEGATE), null)).toEqual({ kind: 'warn', delegate: getAddress(DELEGATE.toLowerCase()) });
  });

  it('stays quiet once the owner acknowledged that delegate, and warns again for another', () => {
    expect(walletDelegationNotice(designator(DELEGATE), DELEGATE.toLowerCase())).toEqual({ kind: 'none' });
    const other = '0x00000000000000000000000000000000000000dD';
    expect(walletDelegationNotice(designator(other), DELEGATE.toLowerCase())).toMatchObject({ kind: 'warn' });
  });

  it('keys the acknowledgement by chain and lowercased wallet, under the app namespace', () => {
    expect(delegationAckKey(84532, '0xAbC')).toBe('vaipakam.delegationAck.84532.0xabc');
  });
});
