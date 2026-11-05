import { describe, expect, it } from 'vitest';
import { copyEntry, type CopyKey } from '../copy/useCopy';
import { consentReceipt, modeFrom } from './feeDiscount';

const copy = {
  text: (k: CopyKey) => copyEntry(k).text,
  format: (k: CopyKey, vars: Readonly<Record<string, string>>) => copyEntry(k).text.replace(/\{\{(\w+)\}\}/g, (_, n: string) => vars[n] ?? ''),
};

describe('modeFrom', () => {
  it('is VPFI payment only when both the rate and its reference asset are set', () => {
    expect(modeFrom(10n ** 15n, '0x00000000000000000000000000000000000000aa')).toBe('vpfi');
    expect(modeFrom(0n, '0x00000000000000000000000000000000000000aa')).toBe('direct');
    expect(modeFrom(10n ** 15n, '0x0000000000000000000000000000000000000000')).toBe('direct');
    expect(modeFrom(0n, '0x0000000000000000000000000000000000000000')).toBe('direct');
  });
});

describe('consentReceipt', () => {
  it('turning on in direct mode moves no VPFI and promises no figure', () => {
    const r = consentReceipt({ target: true, mode: 'direct', readAt: 1 }, 'Base Sepolia', copy);
    expect(r.title).toBe('Turn the fee discount on');
    expect(r.rows.map((x) => x.label)).toEqual(['Setting', 'When you borrow', 'When you lend', 'Size', 'Unchanged']);
    expect(r.rows[2]!.value).toEqual({ kind: 'text', text: copyEntry('consent.lendDirect').text });
    expect(r.consequences).toEqual([]);
    expect(r.prompts).toBe(1);
  });
  it('turning on in VPFI mode states that vault VPFI is spent', () => {
    const r = consentReceipt({ target: true, mode: 'vpfi', readAt: 1 }, 'Base Sepolia', copy);
    expect(r.rows[2]!.value).toEqual({ kind: 'text', text: copyEntry('consent.lendVpfi').text });
    expect(r.consequences).toEqual([copyEntry('consent.loseVpfi').text]);
  });
  it('an unreadable mode is an unknown row and a stated consequence, never a guess', () => {
    const r = consentReceipt({ target: true, mode: null, readAt: 1 }, 'Base Sepolia', copy);
    expect(r.rows[2]!.value.kind).toBe('unknown');
    expect(r.consequences).toEqual([copyEntry('consent.loseUnknown').text]);
  });
  it('turning off names what is lost and needs no mode', () => {
    const r = consentReceipt({ target: false, mode: null, readAt: 1 }, 'Base Sepolia', copy);
    expect(r.rows[0]!.value).toEqual({ kind: 'text', text: 'Fee discount on Base Sepolia: off' });
    expect(r.rows.map((x) => x.label)).not.toContain('Size');
    expect(r.rows[2]!.value).toEqual({ kind: 'text', text: copyEntry('consent.lendOff').text });
    expect(r.consequences).toEqual([copyEntry('consent.loseOff').text]);
  });
});
