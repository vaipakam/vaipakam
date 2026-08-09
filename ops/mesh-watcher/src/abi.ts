/**
 * ABI surface for the mesh watcher — sourced from the COMPILED per-facet
 * JSON, never hand-typed.
 *
 * `ops/lz-watcher` hand-wrote its call signatures with viem's `parseAbi`,
 * and that was correct there: it read the LayerZero V2 standard surface
 * (`endpoint.getConfig`, `oapp.peers`) plus ERC20, none of which live in
 * the Vaipakam Diamond ABI. This Worker reads the Diamond and nothing
 * else, so the same shortcut would reintroduce exactly the failure the
 * 2026-05-05 "watcher offer-decode drift" incident produced — hand-typed
 * tuples whose field positions silently shifted under a contract change,
 * decoding the wrong number into the right-looking variable. The Solidity
 * compiler is the single source of truth for every read-decode shape in
 * this repo (see CLAUDE.md, "Worker ABI consumption").
 *
 * Because a JSON import cannot be `as const`, TypeScript sees the imported
 * ABI as a loose array and viem's return type degrades to `unknown`. The
 * decode itself is still driven by the compiled ABI — field ORDER cannot
 * drift — but the labels this module puts on those values are hand-written
 * and COULD. {@link assertAbiShape} closes that gap: it checks, at startup,
 * that every view this Worker reads still has the exact output arity, order,
 * names and types the reader code assumes, and throws if not. A re-export
 * that changes a view's shape therefore fails the very first tick with a
 * precise message instead of quietly mislabelling a ledger figure.
 */

import type { Abi, AbiFunction } from 'viem';
import rewardAggregatorAbi from '../../../packages/contracts/src/abis/RewardAggregatorFacet.json';
import repatriationAbi from '../../../packages/contracts/src/abis/RepatriationFacet.json';
import interactionRewardsLensAbi from '../../../packages/contracts/src/abis/InteractionRewardsLensFacet.json';

/** The compiled `RewardAggregatorFacet` ABI, as viem consumes it. */
export const REWARD_AGGREGATOR_ABI = rewardAggregatorAbi as unknown as Abi;

/** The compiled `RepatriationFacet` ABI (#1568 C2) — the repatriation
 *  draw / position views the C2 checks read. Kept as its OWN import
 *  rather than merged into the aggregator ABI so a repat-view revert on a
 *  not-yet-refreshed chain stays attributable to the facet that is
 *  actually missing. */
export const REPATRIATION_ABI = repatriationAbi as unknown as Abi;

/** The compiled `InteractionRewardsLensFacet` ABI (#1434 P2-w2) — the
 *  backing snapshot the arrival-reservation check reads (balance, bucket,
 *  and the stranded-recovery reservation in one pinned-block tuple). Own
 *  import for the same attribution reason as the repatriation ABI. */
export const INTERACTION_REWARDS_LENS_ABI =
  interactionRewardsLensAbi as unknown as Abi;

/**
 * Every view this Worker calls, with the output shape its reader assumes.
 * `outputs` lists `name:type` pairs in declaration order — the assertion
 * below compares this to the compiled ABI element-for-element.
 *
 * Keep these in the same order as the reads in `mesh.ts` so a reviewer can
 * diff the two lists by eye.
 */
const EXPECTED_VIEWS: ReadonlyArray<{
  readonly name: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Which compiled facet ABI carries the view (default: aggregator). */
  readonly facet?: 'repatriation';
}> = [
  {
    name: 'getExpectedSourceChainIds',
    inputs: [],
    outputs: [':uint32[]'],
  },
  {
    name: 'getChainRecycledLedger',
    inputs: ['uint32'],
    outputs: [
      'reportedCumulative:uint256',
      'consumedCumulative:uint256',
      'availRecycled:uint256',
      'attributedCumulative:uint256',
    ],
  },
  {
    name: 'getChainRecycledCommitRetirement',
    inputs: ['uint32'],
    outputs: ['retiredCumulative:uint256', 'releasedCumulative:uint256'],
  },
  {
    name: 'getChainOutstandingRecycledCommit',
    inputs: ['uint32'],
    outputs: [':uint256'],
  },
  {
    name: 'getGovernorCommitState',
    inputs: [],
    outputs: [
      'armedFromDay:uint256',
      'outstandingFresh:uint256',
      'outstandingRecycled:uint256',
      'paidOutRecycled:uint256',
    ],
  },
  {
    name: 'getRecycleCustodyPosition',
    inputs: [],
    outputs: [
      'custodyRelocated:uint256',
      'bucket:uint256',
      'reportedCumulative:uint256',
    ],
  },
  {
    name: 'getLocalRecycledCommitRetirement',
    inputs: [],
    outputs: ['retiredCumulative:uint256', 'releasedCumulative:uint256'],
  },
  // #1444 / #1446 — the RAW stored slots. Every other read above exposes a
  // figure the contract DERIVES, which is fine for reporting and useless for
  // verification: a regression in the derivation inflates the published value
  // and Base's accepted copy of it together, so no comparison between them
  // can see it. These three let this Worker re-derive the published figures
  // and disagree with the chain.
  {
    name: 'getRecycleCompositionPosition',
    inputs: [],
    outputs: [
      'creditedRaw:uint256',
      'releasedRemitStranded:uint256',
      'accountingSeeded:bool',
      'isCanonicalRewardChain:bool',
    ],
  },
  // #1568 C2 — the repatriation ledger views, on `RepatriationFacet`.
  // Base-side: the per-chain NET draw (`expectedAvail`'s new term and the
  // §7 #6 second comparison) plus the lifetime release observability.
  {
    name: 'getChainRepatriationDraw',
    inputs: ['uint32'],
    outputs: ['netDraw:uint256', 'lifetimeReleased:uint256'],
    facet: 'repatriation',
  },
  // Chain-local: the repatriated-outflow cumulative — a DESTINATION term
  // in the §7 #8 bucket composition and part of the reported-cumulative
  // floor re-derivation.
  {
    name: 'getRepatriationPosition',
    inputs: [],
    outputs: [
      'repatriatedOutCumulative:uint256',
      'sender:address',
      'receiver:address',
      'authNonce:uint256',
    ],
    facet: 'repatriation',
  },
] as const;

/** Names of the views asserted above — handy for tests and diagnostics. */
export const WATCHED_VIEWS: readonly string[] = EXPECTED_VIEWS.map(
  (v) => v.name,
);

function describe(io: { name?: string; type: string }): string {
  return `${io.name ?? ''}:${io.type}`;
}

/**
 * Verify the compiled ABI still matches what the readers assume.
 *
 * @param abi ABI to check (defaults to the imported facet ABI; the
 *            parameter exists so tests can feed a deliberately-drifted
 *            copy and prove the assertion actually catches it).
 * @throws   On a missing view, or on any arity / order / name / type
 *           mismatch, naming the view and the exact divergence.
 */
export function assertAbiShape(
  abi: Abi = REWARD_AGGREGATOR_ABI,
  repatAbi: Abi = REPATRIATION_ABI,
): void {
  const problems: string[] = [];

  for (const expected of EXPECTED_VIEWS) {
    const source = expected.facet === 'repatriation' ? repatAbi : abi;
    const matches = source.filter(
      (item): item is AbiFunction =>
        item.type === 'function' && item.name === expected.name,
    );

    if (matches.length === 0) {
      problems.push(`${expected.name}: missing from the compiled ABI`);
      continue;
    }
    if (matches.length > 1) {
      // An overload would make the positional decode ambiguous for the
      // untyped call path this Worker uses.
      problems.push(
        `${expected.name}: ${matches.length} overloads in the compiled ABI, expected exactly 1`,
      );
      continue;
    }

    const fn = matches[0]!;
    const actualInputs = fn.inputs.map((i) => i.type);
    if (actualInputs.join(',') !== expected.inputs.join(',')) {
      problems.push(
        `${expected.name}: inputs are (${actualInputs.join(', ')}), expected (${expected.inputs.join(', ')})`,
      );
    }

    const actualOutputs = fn.outputs.map(describe);
    if (actualOutputs.join(',') !== expected.outputs.join(',')) {
      problems.push(
        `${expected.name}: outputs are [${actualOutputs.join(', ')}], expected [${expected.outputs.join(', ')}]`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `mesh-watcher ABI shape drift — re-check the readers in src/mesh.ts against the contracts before deploying:\n  ${problems.join('\n  ')}`,
    );
  }
}
