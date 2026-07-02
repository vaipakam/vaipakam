import { describe, expect, it } from 'vitest';
import { createChainModule } from '@vaipakam/defi-client';

describe('createChainModule', () => {
  it('keeps BNB testnet user-facing when deployments include a Diamond', () => {
    const mod = createChainModule(() => undefined);
    const bnb = mod.getChainByChainId(97);
    expect(bnb).toBeDefined();
    expect(bnb?.diamondAddress).toBeTruthy();
    expect(mod.isChainSupported(97)).toBe(true);
  });
});