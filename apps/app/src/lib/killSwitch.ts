/**
 * Write-path kill switch (#1028 item 3).
 *
 * `VITE_DISABLED_FLOWS` is a comma-separated list of flow ids (or
 * `all`) the operator can set in the deploy environment to switch a
 * write path off while a facet bug or incident is investigated —
 * flipping a build var and redeploying beats shipping a code change
 * under pressure. (A remote flag with no rebuild at all is the
 * documented upgrade path on card #1028.)
 *
 * SCOPE IS PRINCIPLED, mirroring the sanctions Tier-1/Tier-2 split:
 * only position-OPENING and optional flows are switchable — posting
 * or accepting an offer, listing or renting an NFT, depositing VPFI.
 * Close-out paths (repay, claims, withdrawals) are deliberately NOT
 * represented here and must never be: an operator precaution must
 * not be able to trap funds or make users miss repayment deadlines.
 */

export type KillableFlow =
  | 'post-offer'
  | 'accept-offer'
  | 'nft-list'
  | 'nft-rent'
  | 'vpfi-deposit';

const DISABLED: ReadonlySet<string> = new Set(
  ((import.meta.env.VITE_DISABLED_FLOWS as string | undefined) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function flowDisabled(flow: KillableFlow): boolean {
  return DISABLED.has(flow) || DISABLED.has('all');
}
