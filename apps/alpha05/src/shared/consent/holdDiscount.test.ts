import { describe, expect, it } from 'vitest';
import { copyEntry } from '../copy/useCopy';
import { holdDiscountFrom } from './holdDiscount';

describe('holdDiscountFrom', () => {
  it('reads no platform token as no holding discount', () => {
    expect(holdDiscountFrom({ state: 'ready', data: '0x0000000000000000000000000000000000000000', error: null })).toBe('none');
  });
  it('reads an installed token as a discount that can apply', () => {
    expect(holdDiscountFrom({ state: 'ready', data: '0x00000000000000000000000000000000000000Aa', error: null })).toBe('installed');
  });
  it('never claims either answer from a failed or pending read', () => {
    expect(holdDiscountFrom({ state: 'failed', data: null, error: 'down' })).toBe('unread');
    expect(holdDiscountFrom({ state: 'reading', data: null, error: null })).toBe('reading');
  });
  it('states an answer whose last refresh failed as unread, never as no discount', () => {
    expect(holdDiscountFrom({ state: 'ready', data: '0x0000000000000000000000000000000000000000', error: 'timed out' })).toBe('unread');
    expect(holdDiscountFrom({ state: 'ready', data: '0x00000000000000000000000000000000000000Aa', error: 'timed out' })).toBe('unread');
  });
});

describe('the no-holding-discount line', () => {
  it('says plainly that fees are charged in full', () => {
    expect(copyEntry('consent.noHoldDiscount').text).toBe('No platform token is installed on this network yet, so no holding discount applies to any fee.');
  });
});
