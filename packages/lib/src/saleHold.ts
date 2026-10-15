/**
 * Does a lender-sale listing stand on a loan, and in which phase?
 *
 * Shared by the connected app and the keeper (#2483), because both send a
 * settlement that must not run past an ACCEPTED sale. `triggerDefault` does
 * not inspect sale linkage (#2078): closing a loan out after a buyer accepted
 * its lender-position sale strands the buyer's principal. The app's
 * close-out card checks this before every send, and a keeper that closes
 * loans on its own must check exactly the same thing. Two copies of the
 * rule would drift, and a drifted copy here fails toward moving funds.
 *
 * The chain exposes no loanId→saleOfferId view, so EXISTENCE is detected the
 * same way a borrower would act on it: by SIMULATING the permissionless
 * `teardownStaleSaleListing(loanId)` cleanup and classifying the outcome —
 *
 *   - reverts `NoStaleSaleListing`      → no listing, OR (with the lender
 *                                          position sale-locked) an accepted
 *                                          sale awaiting completion
 *   - reverts `SaleListingLoanStillLive`→ a live bounded listing stands
 *   - SUCCEEDS                          → an ended listing still holds the
 *                                          loan; anyone can clear it now
 *
 * Any other outcome classifies `unknown`, and every caller treats `unknown`
 * as "do not send". A transport failure THROWS, so the caller decides how to
 * fail closed. The probe is a plain eth_call: it costs no gas and mutates
 * nothing.
 */
import { toFunctionSelector, type Address, type PublicClient } from 'viem';
import { isRevert, revertErrorName } from './contractRevert';

export type SaleListingHoldState =
  | 'none'
  | 'live'
  | 'clearable'
  | 'accepted'
  | 'unknown';

/** LibERC721.LockReason.EarlyWithdrawalSale — the lender NFT's lock while a
 *  sale lifecycle (listing OR accepted-awaiting-completion) is in flight. */
export const LOCK_EARLY_WITHDRAWAL_SALE = 2;

/** The PR-A bounded-listing selector — the positive facet-version signal.
 *  The PRE-refresh Diamond routes the same one-argument teardown selector
 *  but with the OLD semantics (terminal-loans-only, pause-gated, no expiry
 *  admission), and it shares error names with the new facet — so a raw
 *  probe against it would misclassify a legacy GTC listing as boundedly
 *  `live` (Codex #1511 r1 P1). Only a Diamond that routes the 4-arg
 *  `createLoanSaleOffer` carries the lifecycle the classifier describes; a
 *  caller that cannot confirm it routes must treat a sale-locked position
 *  as `unknown`. */
export const BOUNDED_LISTING_SELECTOR = toFunctionSelector(
  'function createLoanSaleOffer(uint256,uint256,bool,uint64)',
);

/** The two reads the probe makes, with the two errors it classifies. Inline
 *  so this module carries no generated ABI; any other revert is `unknown`
 *  whether or not it decodes. */
const SALE_HOLD_ABI = [
  {
    type: 'function',
    name: 'positionLock',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'teardownStaleSaleListing',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [],
  },
  { type: 'error', name: 'NoStaleSaleListing', inputs: [] },
  { type: 'error', name: 'SaleListingLoanStillLive', inputs: [] },
] as const;

/** Pure classifier for the teardown probe outcome — split out so the mapping
 *  is unit-testable without a chain.
 *
 *  `saleLocked` corroborates the ambiguous arm (Codex #1511 r3): the teardown
 *  reverts `NoStaleSaleListing` BOTH when no listing exists AND for an
 *  accepted sale awaiting its documented manual-recovery completion — but
 *  only the latter keeps the lender NFT sale-locked. Mapping it to `none`
 *  would hide a real hold. */
export function classifyTeardownProbe(input: {
  ok: boolean;
  errorName?: string | null;
  saleLocked?: boolean;
}): SaleListingHoldState {
  if (input.ok) return 'clearable';
  switch (input.errorName) {
    case 'NoStaleSaleListing':
      return input.saleLocked ? 'accepted' : 'none';
    case 'SaleListingLoanStillLive':
      return 'live';
    default:
      return 'unknown';
  }
}

/** The custom-error name of a viem simulate/write failure; null when the
 *  failure is not a decodable revert. Structural — see `contractRevert`. */
export function probeErrorName(err: unknown): string | null {
  return revertErrorName(err);
}

/** Probe the chain for a loan's sale-hold state.
 *
 *  Throws on a transport failure; a revert the classifier does not name is
 *  `unknown`, not a throw, so a caller never mistakes a chain answer it
 *  cannot read for a network blip it might retry past. */
export async function probeSaleHoldLive(
  client: Pick<PublicClient, 'simulateContract' | 'readContract'>,
  diamondAddress: Address,
  loanId: number | bigint,
  /** The loan's lender position token id, '' when unknown (the lock then
   *  cannot rule a listing out, so the probe simulates). */
  lenderTokenId: string | bigint,
  account: Address | undefined,
  /** Read every fact at this block instead of the latest, so a caller can
   *  judge this beside other reads from the same block. */
  blockNumber?: bigint,
): Promise<SaleListingHoldState> {
  // LOCK FIRST. The lender position NFT carries the EarlyWithdrawalSale lock
  // for the WHOLE listing lifecycle — stamped at creation, released only by
  // the teardown or the completion — so an unlocked position PROVES there is
  // nothing to classify, without simulating anything. Most loans were never
  // listed, so this one read answers the common case.
  let saleLocked: boolean | undefined;
  if (lenderTokenId !== '') {
    saleLocked =
      Number(
        await client.readContract({
          address: diamondAddress,
          abi: SALE_HOLD_ABI,
          functionName: 'positionLock',
          args: [BigInt(lenderTokenId)],
          blockNumber,
        }),
      ) === LOCK_EARLY_WITHDRAWAL_SALE;
    if (!saleLocked) return 'none';
  }
  try {
    await client.simulateContract({
      address: diamondAddress,
      abi: SALE_HOLD_ABI,
      functionName: 'teardownStaleSaleListing',
      args: [BigInt(loanId)],
      account,
      blockNumber,
    });
    return classifyTeardownProbe({ ok: true });
  } catch (err) {
    const errorName = probeErrorName(err);
    if (errorName === null && !isRevert(err)) throw err;
    return classifyTeardownProbe({ ok: false, errorName, saleLocked });
  }
}

/** May a settlement that does not check sale linkage be sent on this loan?
 *
 *  The rule the app's close-out card applies, for any caller that needs the
 *  verdict rather than the state: an accepted sale on an Active loan blocks,
 *  and so does a state the probe could not establish. A live or ended
 *  listing does not — no buyer has paid, so closing the loan strands no
 *  one, and the stale listing is cleared by its own permissionless path. */
export function saleHoldBlocksSettlement(state: SaleListingHoldState): boolean {
  return state === 'accepted' || state === 'unknown';
}
