/**
 * #3631 — "claim and withdraw" as one action, without hiding that it is two
 * protocol steps. A loan claim pays the position holder's OWN vault (the
 * protocol credits it there as the holder's free funds, `VaultOutflow` class
 * PositionHolder), and the withdrawal then moves it from the vault to the
 * wallet, which is the step a protected account's delay gates. So the app
 * asks once how the reader wants it (withdraw to the wallet, or keep it in
 * the vault to lend or post as collateral), sends the claim, MEASURES what
 * the claim credited to the vault from the transaction's own logs, and opens
 * the ordinary withdrawal for exactly that, one asset at a time.
 *
 * What the withdrawal is opened for is never the amount the review promised:
 * only what the protocol recorded arriving in the vault. A claim that
 * credited nothing opens no withdrawal, and a withdrawal that is refused or
 * fails leaves the claim succeeded and the money in the vault, said so.
 *
 * "Ready to claim" is the other half: each payout's amounts, per asset, and
 * the total across every payout this wallet may collect now. Only a payout
 * whose claim is open counts towards the total; one that waits, or whose
 * claim could not be read, is counted apart and said so, never added in.
 */
import type { Log } from 'viem';
import type { Standard } from '../nft/nft';
import { vaultCredit } from '../protection/payout';
import type { WithdrawDraft } from '../vault/withdraw';
import { ASSET_ERC1155, ASSET_ERC20, ASSET_ERC721, type ClaimLane } from './loanClaim';

type Hex = `0x${string}`;

/** How the reader wants a claim's payout: withdrawn to the wallet after the
 *  claim, or kept in the vault. */
export type ClaimMode = 'withdraw' | 'keep';

/** The token standard of a protocol asset type. */
export function standardOf(assetType: number): Standard {
  if (assetType === ASSET_ERC721) return 'erc721';
  if (assetType === ASSET_ERC1155) return 'erc1155';
  return 'erc20';
}

/** One asset a claim pays, as the withdrawal names it: an ERC-20 by its
 *  address, an NFT by its address and token id. */
interface Paid {
  assetType: number;
  asset: Hex;
  tokenId: bigint;
}

/** The assets `lanes` pay, each once: two lanes of one ERC-20 (a lender's
 *  row and the funds held for it) are one withdrawal. */
export function paidAssets(lanes: readonly Pick<ClaimLane, 'asset' | 'assetType' | 'tokenId'>[]): Paid[] {
  const out: Paid[] = [];
  for (const l of lanes) {
    const tokenId = l.assetType === ASSET_ERC20 ? 0n : l.tokenId;
    const seen = out.some((p) => p.asset.toLowerCase() === l.asset.toLowerCase() && p.assetType === l.assetType && p.tokenId === tokenId);
    if (!seen) out.push({ assetType: l.assetType, asset: l.asset, tokenId });
  }
  return out;
}

/**
 * The withdrawals a claim leaves to make: for each asset the claim's lanes
 * pay, what the transaction credited to `vault` for the claimed loans
 * (`refs`), as the protocol measured it arriving. An asset that arrived
 * nowhere (paid straight to the wallet, or not at all) opens nothing.
 */
export function creditedDrafts(
  lanes: readonly Pick<ClaimLane, 'asset' | 'assetType' | 'tokenId'>[],
  logs: readonly Log[],
  diamond: Hex,
  vault: Hex,
  refs: readonly bigint[],
): WithdrawDraft[] {
  const drafts: WithdrawDraft[] = [];
  for (const p of paidAssets(lanes)) {
    const credit = vaultCredit(logs, diamond, vault, p.asset, { ref: refs, ...(p.assetType === ASSET_ERC20 ? {} : { tokenId: p.tokenId }) });
    if (credit === null || credit.amount === 0n) continue;
    const standard = standardOf(p.assetType);
    drafts.push({ standard, asset: p.asset, tokenId: p.tokenId, amount: standard === 'erc721' ? 1n : credit.amount });
  }
  return drafts;
}

/** One asset's total ready to claim: an ERC-20 amount, an ERC-1155
 *  quantity of one token, or one ERC-721 token. */
export interface ReadyTotal {
  assetType: number;
  asset: Hex;
  tokenId: bigint;
  amount: bigint;
}

/** What the payouts add up to, per asset, and what was left out of the
 *  total and why. */
export interface ReadyToClaim {
  totals: ReadyTotal[];
  /** Payouts whose claim is open now and pays something. */
  ready: number;
  /** Payouts that are not open yet (a loan in fallback, the pause, a
   *  position someone else holds): listed, not counted. */
  waiting: number;
  /** Payouts whose claim, or whose rule, could not be read: not counted. */
  unread: number;
}

/** One payout as the total reads it: its lanes, and its claim's verdict
 *  (open, closed, or unknown when it could not be read). */
export interface ReadyInput {
  lanes: readonly ClaimLane[];
  state: 'open' | 'closed' | 'unknown';
}

/** The per-asset total of every open payout, ERC-20 amounts summed, NFTs
 *  each their own entry (an ERC-1155 token's quantities summed). */
export function readyToClaim(rows: readonly ReadyInput[]): ReadyToClaim {
  const totals: ReadyTotal[] = [];
  let ready = 0;
  let waiting = 0;
  let unread = 0;
  for (const r of rows) {
    if (r.state === 'unknown') {
      unread += 1;
      continue;
    }
    if (r.state === 'closed') {
      waiting += 1;
      continue;
    }
    if (r.lanes.length === 0) continue;
    ready += 1;
    for (const l of r.lanes) {
      const tokenId = l.assetType === ASSET_ERC20 ? 0n : l.tokenId;
      const hit =
        l.assetType === ASSET_ERC721 ? undefined : totals.find((t) => t.asset.toLowerCase() === l.asset.toLowerCase() && t.assetType === l.assetType && t.tokenId === tokenId);
      if (hit) hit.amount += l.amount;
      else totals.push({ assetType: l.assetType, asset: l.asset, tokenId, amount: l.assetType === ASSET_ERC721 ? 1n : l.amount });
    }
  }
  return { totals, ready, waiting, unread };
}
