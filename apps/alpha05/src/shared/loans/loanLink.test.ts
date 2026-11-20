import { describe, expect, it } from 'vitest';
import { linkChainId, loanLink } from './loanLink';

describe('loan link', () => {
  it('names the network with the loan', () => {
    expect(loanLink('https://alpha05.vaipakam.com', 12n, 84532)).toBe('https://alpha05.vaipakam.com/positions/12?chain=84532');
  });
  it('reads the network a link names, telling none apart from a bad one', () => {
    expect(linkChainId(null)).toBeUndefined();
    expect(linkChainId('84532')).toBe(84532);
    expect(linkChainId('0')).toBeNull();
    expect(linkChainId('base')).toBeNull();
  });
});
