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

  it('provides wrapped-native defaults on BNB testnet and Arbitrum Sepolia', () => {
    const mod = createChainModule(() => undefined);
    expect(mod.getChainByChainId(97)?.wrappedNativeAddress).toBe(
      '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
    );
    expect(mod.getChainByChainId(421614)?.wrappedNativeAddress).toBe(
      '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    );
  });

  it('reads predominant stable from env when deployment artifact lacks mockERC20A', () => {
    const stable = '0x5c74c94173F05dA1720953407cbb920F3DF9f887';
    const mod = createChainModule((key) =>
      key === 'VITE_ARB_SEP_PREDOMINANT_STABLE' ? stable : undefined,
    );
    expect(mod.getChainByChainId(421614)?.predominantStableAddress).toBe(stable);
  });
});