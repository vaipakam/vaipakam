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

/** The compiled `RewardAggregatorFacet` ABI, as viem consumes it. */
export const REWARD_AGGREGATOR_ABI = rewardAggregatorAbi as unknown as Abi;

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
export function assertAbiShape(abi: Abi = REWARD_AGGREGATOR_ABI): void {
  const problems: string[] = [];

  for (const expected of EXPECTED_VIEWS) {
    const matches = abi.filter(
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
