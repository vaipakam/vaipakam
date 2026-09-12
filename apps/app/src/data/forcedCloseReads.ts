/**
 * The forced-close readiness reads as ONE aggregate — the plan that builds
 * it and the mapper that reads it back. Pure: no wagmi, no query, no chain,
 * so both halves are tested without either.
 *
 * ## Why an aggregate, given the rule against batching
 *
 * `useForcedClose.ts` used to issue one query per fact, and its header
 * gave the reason: the reads fail INDEPENDENTLY and mean different things.
 * `calculateLTV` reverts by design on illiquid collateral, and a batch
 * that let that revert take the defaultability answer down with it would
 * turn the card permanently `unknown` on the positions it serves best.
 *
 * That rule is about failure isolation, not about the number of requests.
 * Multicall3's `aggregate3` with `allowFailure` returns a status per call,
 * so an LTV revert is one `failure` slot beside six `success` slots — the
 * same independence, in one `eth_call` instead of seven.
 *
 * ## Why the block comes from INSIDE the aggregate
 *
 * The card publishes the block its readiness resolved at (#2098, #2131).
 * Sampling `eth_blockNumber` beside the reads would give a sighting — a
 * number the reads may or may not have been evaluated at. Pinning the
 * reads to a sampled block would make the number exact but would fail
 * whenever a load-balanced provider's other node has not yet seen it.
 * `Multicall3.getBlockNumber()` as one more call in the same aggregate
 * returns `block.number` of the very execution that produced the facts:
 * provenance as a fact, with no pinning and no extra request.
 *
 * ## Why the plan and the mapper live together
 *
 * The mapper reads slots back by position. Building the call list in one
 * place and the field list in another is how the two drift; here the plan
 * is a list of KEYED entries, and the mapper zips keys to slots, so the
 * order is shared by construction rather than by discipline.
 */
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { LOAN_STATUS_ACTIVE } from '../contracts/loanLive';
import { LIQUIDITY_LIQUID } from '../contracts/preflights';
import { AssetType } from '../lib/types';

/** `Multicall3.getBlockNumber()` — on the deployed contract, though viem's
 *  bundled `multicall3Abi` does not carry it. */
export const MULTICALL3_BLOCK_NUMBER_ABI = [
  {
    type: 'function',
    name: 'getBlockNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'blockNumber', type: 'uint256' }],
  },
] as const;

export type ForcedCloseReadKey =
  | 'block'
  | 'loan'
  | 'defaultable'
  | 'sequencer'
  | 'paused'
  | 'match'
  | 'liquidity'
  | 'ltv'
  | 'risk';

/** One call in the aggregate. `contract` is what viem's `multicall` takes;
 *  the shape is kept loose here so this module needs no viem generics. */
export interface ForcedCloseReadEntry {
  key: ForcedCloseReadKey;
  contract: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  };
}

/** What `multicall({ allowFailure: true })` hands back, per call. */
export interface MulticallSlot {
  status: 'success' | 'failure';
  result?: unknown;
  error?: unknown;
}

/** EVERY chain fact `decideForcedClose` consumes, plus where they came
 *  from. Every, not most (#2148 round 1 P1): the block is published as
 *  the height the decision was made at, and that is true only if every
 *  input to the decision was evaluated in the same execution — so the
 *  loan's own status, consent flag and shape are read HERE, from the
 *  loan struct inside the aggregate, rather than taken from the page's
 *  separately-timed status query or the indexed row. The one input not
 *  here is whether the viewer holds the lender position, which is not a
 *  fact about the loan and only ever removes the card (and with it the
 *  block) rather than dating it. */
export interface ForcedCloseFacts {
  /** `block.number` of the execution that produced every other field.
   *  `undefined` only if that one call failed — the facts are still
   *  facts, of a block the card then cannot name. */
  block: bigint | undefined;
  /** `loan.status === Active`, from the struct read in the aggregate. */
  active: boolean | undefined;
  /** `loan.riskAndTermsConsentFromBoth`, same read. Set at init and
   *  never changes, so it would be true at any block — it is read here
   *  anyway so the provenance claim needs no exceptions. */
  consentFromBoth: boolean | undefined;
  /** The PRINCIPAL leg — an NFT rental never takes the swap path. */
  assetType: 'erc20' | 'rental' | undefined;
  /** The COLLATERAL leg is an ERC-721/1155 — a separate axis from the
   *  principal leg; see `ForcedCloseInput.collateralIsNft`. */
  collateralIsNft: boolean | undefined;
  defaultable: boolean | undefined;
  sequencerHealthy: boolean | undefined;
  paused: boolean | undefined;
  internalMatchCandidate: boolean | undefined;
  collateralIlliquid: boolean | undefined;
  ltvCollapsed: boolean | undefined;
}

/**
 * The calls, in the order the mapper reads them back.
 *
 * `liquidity` is present only when there is an ERC-20 collateral asset to
 * ask about — `checkLiquidity` rejects a zero address outright, and the
 * decision never asks the question for a rental.
 */
export function forcedCloseReadPlan(input: {
  diamond: `0x${string}`;
  multicall3: `0x${string}`;
  loanId: bigint;
  collateralAsset: `0x${string}` | undefined;
}): ForcedCloseReadEntry[] {
  const d = { address: input.diamond, abi: DIAMOND_ABI_VIEM } as const;
  const plan: ForcedCloseReadEntry[] = [
    {
      key: 'block',
      contract: {
        address: input.multicall3,
        abi: MULTICALL3_BLOCK_NUMBER_ABI,
        functionName: 'getBlockNumber',
      },
    },
    // The loan itself, so status / consent / shape carry the same
    // provenance as the polled facts beside them.
    { key: 'loan', contract: { ...d, functionName: 'getLoanDetails', args: [input.loanId] } },
    { key: 'defaultable', contract: { ...d, functionName: 'isLoanDefaultable', args: [input.loanId] } },
    { key: 'sequencer', contract: { ...d, functionName: 'sequencerHealthy' } },
    { key: 'paused', contract: { ...d, functionName: 'paused' } },
    { key: 'match', contract: { ...d, functionName: 'hasInternalMatchCandidate', args: [input.loanId] } },
  ];
  if (input.collateralAsset !== undefined) {
    plan.push({
      key: 'liquidity',
      contract: { ...d, functionName: 'checkLiquidity', args: [input.collateralAsset] },
    });
  }
  plan.push(
    { key: 'ltv', contract: { ...d, functionName: 'calculateLTV', args: [input.loanId] } },
    { key: 'risk', contract: { ...d, functionName: 'getRiskConfig' } },
  );
  return plan;
}

/**
 * Read the aggregate back into facts. A failed slot is `undefined` for its
 * field and touches nothing else — the independence the per-query design
 * had, kept.
 *
 * A slot count that does not match the plan is a programming error, not a
 * chain answer, and is thrown rather than mapped: zipping a short or long
 * list by position would assign facts to the wrong fields silently.
 */
export function forcedCloseFacts(
  plan: readonly ForcedCloseReadEntry[],
  slots: readonly MulticallSlot[],
): ForcedCloseFacts {
  if (slots.length !== plan.length) {
    throw new Error(
      `forced-close aggregate returned ${slots.length} slot(s) for a plan of ${plan.length}`,
    );
  }
  const ok = new Map<ForcedCloseReadKey, unknown>();
  plan.forEach((entry, i) => {
    const slot = slots[i];
    if (slot.status === 'success') ok.set(entry.key, slot.result);
  });
  const bool = (key: ForcedCloseReadKey): boolean | undefined =>
    ok.has(key) ? Boolean(ok.get(key)) : undefined;

  const blockRaw = ok.get('block');
  const loanRaw = ok.get('loan');
  const matchRaw = ok.get('match');
  const liquidityRaw = ok.get('liquidity');
  const ltvRaw = ok.get('ltv');
  const riskRaw = ok.get('risk');

  // The loan struct's three fields the decision reads. Each is `undefined`
  // when the slot failed OR the field is not the shape expected — a struct
  // from a different ABI is not evidence of anything.
  const loan =
    loanRaw !== null && typeof loanRaw === 'object'
      ? (loanRaw as {
          status?: unknown;
          assetType?: unknown;
          collateralAssetType?: unknown;
          riskAndTermsConsentFromBoth?: unknown;
        })
      : undefined;
  const enumField = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined;
  const status = enumField(loan?.status);
  const principalType = enumField(loan?.assetType);
  const collateralType = enumField(loan?.collateralAssetType);

  return {
    block: typeof blockRaw === 'bigint' ? blockRaw : undefined,
    active: status === undefined ? undefined : status === LOAN_STATUS_ACTIVE,
    consentFromBoth:
      typeof loan?.riskAndTermsConsentFromBoth === 'boolean'
        ? loan.riskAndTermsConsentFromBoth
        : undefined,
    assetType:
      principalType === undefined
        ? undefined
        : principalType === AssetType.ERC20
          ? 'erc20'
          : 'rental',
    collateralIsNft: collateralType === undefined ? undefined : collateralType !== AssetType.ERC20,
    defaultable: bool('defaultable'),
    sequencerHealthy: bool('sequencer'),
    paused: bool('paused'),
    // `hasInternalMatchCandidate` returns `[found, loanId]`.
    internalMatchCandidate: Array.isArray(matchRaw) ? Boolean(matchRaw[0]) : undefined,
    collateralIlliquid:
      liquidityRaw === undefined ? undefined : Number(liquidityRaw) !== LIQUIDITY_LIQUID,
    // LTV against the RESOLVED threshold — `getRiskConfig` has already
    // applied the `0 ⇒ default` rule, so no copy of 11000 lives here.
    // Both halves must have answered; an LTV revert on illiquid
    // collateral is the expected shape and yields `undefined`.
    ltvCollapsed:
      typeof ltvRaw === 'bigint' && Array.isArray(riskRaw) && typeof riskRaw[0] === 'bigint'
        ? ltvRaw > riskRaw[0]
        : undefined,
  };
}
