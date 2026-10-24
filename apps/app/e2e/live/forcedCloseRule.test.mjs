import { describe, expect, it } from 'vitest';

import {
  FORCED_CLOSE_FACTS,
  decideForcedClose,
  forcedCloseFacts,
  forcedCloseReadPlan,
  statesReachable,
  unreadViews,
} from './forcedCloseRule.mjs';
import { decideForcedClose as appDecideForcedClose } from '../../src/data/forcedClose.ts';
import {
  forcedCloseFacts as appForcedCloseFacts,
  forcedCloseReadPlan as appForcedCloseReadPlan,
} from '../../src/data/forcedCloseReads.ts';
import { DIAMOND_ABI_VIEM } from '../../src/contracts/diamond.ts';

/**
 * The drive's mirror of the forced-close decision against the app's own
 * code (#2133). Exhaustive over the rule's inputs, so a gate the page
 * gains and the drive lacks cannot pass.
 */
const DOMAIN = {
  assetType: ['erc20', 'rental', undefined],
};
const domainOf = (k) => DOMAIN[k] ?? [true, false, undefined];

function* everyInput(i = 0, acc = {}) {
  if (i === FORCED_CLOSE_FACTS.length) {
    yield acc;
    return;
  }
  for (const v of domainOf(FORCED_CLOSE_FACTS[i])) yield* everyInput(i + 1, { ...acc, [FORCED_CLOSE_FACTS[i]]: v });
}

describe('the drive mirrors decideForcedClose (#2133)', () => {
  it('agrees with the app on every combination of read, unread and value', () => {
    let n = 0;
    for (const input of everyInput()) {
      n += 1;
      if (decideForcedClose(input) !== appDecideForcedClose(input)) {
        expect(decideForcedClose(input), JSON.stringify(input)).toBe(appDecideForcedClose(input));
      }
    }
    // 3^9 × 3: the whole space, not a sample.
    expect(n).toBe(3 ** FORCED_CLOSE_FACTS.length);
  });
});

const DIAMOND = '0x' + '11'.repeat(20);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ASSET = '0x' + '22'.repeat(20);

describe('the drive mirrors the read plan and its mapping (#2133)', () => {
  for (const collateralAsset of [ASSET, undefined]) {
    it(`issues the page's reads in the page's order (collateral ${collateralAsset ? 'known' : 'unknown'})`, () => {
      const shape = (plan) =>
        plan.map((e) => ({
          key: e.key,
          address: e.contract.address,
          functionName: e.contract.functionName,
          args: e.contract.args ?? [],
          abiIsDiamond: e.contract.abi === DIAMOND_ABI_VIEM,
        }));
      const app = appForcedCloseReadPlan({ diamond: DIAMOND, multicall3: MULTICALL3, loanId: 7n, collateralAsset });
      const mine = forcedCloseReadPlan({
        diamond: DIAMOND,
        diamondAbi: DIAMOND_ABI_VIEM,
        multicall3: MULTICALL3,
        loanId: 7n,
        collateralAsset,
      });
      expect(shape(mine)).toEqual(shape(app));
      // The Multicall3 entry's fragment is the same one, by value.
      expect(mine[0].contract.abi).toEqual(app[0].contract.abi);
    });
  }

  // Slot values chosen to hit every branch of the mapper: success and
  // failure per slot, the asked asset matching or not, and each enum value.
  const loanVariants = [
    undefined,
    null,
    { status: 0, assetType: 0, collateralAssetType: 0, collateralAsset: ASSET, riskAndTermsConsentFromBoth: true },
    { status: 1n, assetType: 1n, collateralAssetType: 2n, collateralAsset: ASSET.toUpperCase().replace('0X', '0x'), riskAndTermsConsentFromBoth: false },
    { status: 0, assetType: 2, collateralAssetType: 1, collateralAsset: '0x' + '33'.repeat(20), riskAndTermsConsentFromBoth: 'yes' },
    { status: 'x' },
  ];
  const results = {
    block: [123n, 0n, 'x'],
    defaultable: [true, false, 0n],
    sequencer: [true, false],
    paused: [true, false],
    match: [[true, 3n], [false, 0n], 'nope'],
    liquidity: [0, 1, 2n],
    ltv: [12_000n, 9_000n, 'x'],
    risk: [[11_000n], ['x'], 'nope'],
  };
  const pick = (arr, seed) => arr[seed % arr.length];

  for (const collateralAsset of [ASSET, undefined]) {
    it(`maps every slot the way the page does (collateral ${collateralAsset ? 'known' : 'unknown'})`, () => {
      const appPlan = appForcedCloseReadPlan({ diamond: DIAMOND, multicall3: MULTICALL3, loanId: 7n, collateralAsset });
      const plan = forcedCloseReadPlan({
        diamond: DIAMOND,
        diamondAbi: DIAMOND_ABI_VIEM,
        multicall3: MULTICALL3,
        loanId: 7n,
        collateralAsset,
      });
      for (let seed = 0; seed < 600; seed++) {
        const slots = plan.map((e, i) => {
          if ((seed >> (i % 9)) % 7 === 0) return { status: 'failure', error: new Error('reverted') };
          const result =
            e.key === 'loan' ? pick(loanVariants, seed + i) : pick(results[e.key], Math.floor(seed / (i + 1)));
          return { status: 'success', result };
        });
        expect(forcedCloseFacts(plan, slots), `seed ${seed}`).toEqual(appForcedCloseFacts(appPlan, slots));
      }
    });
  }

  it('refuses a slot count that does not match the plan, as the page does', () => {
    const plan = forcedCloseReadPlan({ diamond: DIAMOND, diamondAbi: [], multicall3: MULTICALL3, loanId: 1n, collateralAsset: undefined });
    expect(() => forcedCloseFacts(plan, [])).toThrow(/slot\(s\) for a plan of/);
  });
});

const ALL_READ = {
  active: true,
  consentFromBoth: true,
  assetType: 'erc20',
  collateralIsNft: false,
  defaultable: true,
  sequencerHealthy: true,
  paused: false,
  internalMatchCandidate: false,
  collateralIlliquid: false,
  ltvCollapsed: false,
};

describe('statesReachable', () => {
  it('is the single resolved state when every fact was read', () => {
    expect([...statesReachable(ALL_READ)]).toEqual(['ready-needs-route']);
    expect([...statesReachable({ ...ALL_READ, paused: true })]).toEqual(['blocked-paused']);
    expect([...statesReachable({ ...ALL_READ, defaultable: false })]).toEqual(['not-yet']);
    expect([...statesReachable({ ...ALL_READ, sequencerHealthy: false })]).toEqual(['blocked-sequencer']);
    expect([...statesReachable({ ...ALL_READ, collateralIlliquid: true, consentFromBoth: false })]).toEqual([
      'blocked-no-consent',
    ]);
    expect([...statesReachable({ ...ALL_READ, assetType: 'rental' })]).toEqual(['ready-rental']);
  });

  it('ignores an unread fact the rule never reaches', () => {
    // A paused protocol decides before every other gate.
    expect([...statesReachable({ paused: true, active: true })]).toEqual(['blocked-paused']);
    // A refused deadline decides before the sequencer and everything after it.
    expect([...statesReachable({ active: true, paused: false, defaultable: false })]).toEqual(['not-yet']);
  });

  it('widens over an unread fact the rule does reach', () => {
    // The grace window read as over, the pause flag unread: the card may
    // honestly say paused or anything downstream of a defaultable loan.
    const s = statesReachable({ ...ALL_READ, paused: undefined, defaultable: false });
    expect([...s].sort()).toEqual(['blocked-paused', 'not-yet']);
  });

  it('never reaches unknown, which is the page answering an unread fact', () => {
    expect(statesReachable({}).has('unknown')).toBe(false);
    expect(statesReachable(undefined).has('unknown')).toBe(false);
  });

  it('names the views behind the facts it could not read', () => {
    expect(unreadViews(ALL_READ)).toEqual([]);
    expect(unreadViews({ ...ALL_READ, paused: undefined, ltvCollapsed: undefined })).toEqual([
      'paused',
      'calculateLTV / getRiskConfig',
    ]);
  });
});
