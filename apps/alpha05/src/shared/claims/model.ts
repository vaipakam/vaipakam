/**
 * RB-CLAIM — one claim flow, many entry points. Every settled amount owed to
 * the wallet is a row of this shape, whatever produced it; Claims renders
 * the canonical list and "Claim everything" takes every row whose
 * `collectable` is open. Seller claims (interest sold with a position) are
 * collected one by one and are therefore excluded from Claim everything,
 * as the rulebook records.
 */
import type { Verdict } from '../eligibility/types';

export type ClaimKind = 'lender-terminal' | 'borrower-terminal' | 'fallback-in-kind' | 'seller-interest' | 'extension-reserve' | 'payroll' | 'reward' | 'protected-payout';

export interface ClaimRow {
  id: string;
  kind: ClaimKind;
  chainId: number;
  /** The asset and the amount the PROTOCOL states; null amount = the
   *  protocol does not state one (the forced-close card names no amount). */
  asset: `0x${string}`;
  amount: bigint | null;
  /** The position or record the claim comes from, for the row's link. */
  source: { label: string; to: string };
  collectable: Verdict;
  /** Whether "Claim everything" may include it. */
  inClaimEverything: boolean;
}
