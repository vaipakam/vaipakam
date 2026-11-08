/**
 * #3205 — the keeper's position-NFT mode. A chain whose deployment record
 * lists `positionNFT` has no protected-mode NFT queue, so the protected
 * account pass says it skipped the transfer step rather than reporting
 * "none released"; any other Diamond reads as the legacy Diamond.
 */
import { describe, expect, it } from 'vitest';
import { positionNftForDiamond } from '../src/positionNft';
import { describeReport, type ProtectedReport } from '../src/protectedAccount';

const report = (over: Partial<ProtectedReport>): ProtectedReport => ({
  chainId: 1,
  released: [],
  cancelled: [],
  transferred: [],
  transferSkipped: null,
  finalized: [],
  waiting: new Map(),
  locks: null,
  alerts: null,
  refused: new Map(),
  unread: new Map(),
  budgetReached: new Set(),
  stopped: null,
  ...over,
});

describe('position-NFT mode', () => {
  it('reads a Diamond no record names as the legacy Diamond', () => {
    const d = '0x00000000000000000000000000000000000000d1';
    expect(positionNftForDiamond(d)).toEqual({ mode: 'legacy', nft: d, diamond: d });
  });

  it('states a skipped transfer step instead of an empty one', () => {
    expect(describeReport(report({ transferSkipped: 'no queue on this chain' }))).toMatch(
      /transfers=skipped \(no queue on this chain\)/,
    );
    expect(describeReport(report({}))).toMatch(/transfers-released=none/);
  });
});
