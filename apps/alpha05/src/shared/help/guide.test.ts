import { describe, expect, it } from 'vitest';
import { guideUrl } from './guide';

describe('guideUrl', () => {
  it('links the guide page of the mode the reader is in', () => {
    expect(guideUrl('basic', 'advanced-mode')).toBe('https://vaipakam.com/help/basic#advanced-mode');
    expect(guideUrl('advanced', 'deployments')).toBe('https://vaipakam.com/help/advanced#deployments');
  });
  it('links the page itself when the entry names no anchor', () => {
    expect(guideUrl('basic', undefined)).toBe('https://vaipakam.com/help/basic');
  });
  it('refuses an anchor that is not a kebab-case id', () => {
    expect(() => guideUrl('basic', 'Why Mode?')).toThrow(/kebab-case/);
  });
});
