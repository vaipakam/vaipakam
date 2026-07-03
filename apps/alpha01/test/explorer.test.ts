import { describe, expect, it } from 'vitest';
import { contractExplorerUrl, txExplorerUrl } from '../src/lib/explorer';

describe('contractExplorerUrl', () => {
  it('builds explorer address links', () => {
    expect(
      contractExplorerUrl(
        'https://sepolia.basescan.org/',
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      ),
    ).toBe('https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('builds explorer transaction links', () => {
    expect(
      txExplorerUrl('https://sepolia.basescan.org/', '0x' + 'a'.repeat(64)),
    ).toBe(`https://sepolia.basescan.org/tx/0x${'a'.repeat(64)}`);
  });
});