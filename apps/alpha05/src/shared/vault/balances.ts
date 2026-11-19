/**
 * #3761 §4.3 — the account's balances on three lines per token, so lent
 * funds and free funds are never read as one figure:
 *
 *   - free balance: what the protocol says may be withdrawn now
 *     (`withdrawableNow`, the vault page's own figure; Withdraw offers this
 *     and nothing else);
 *   - waiting in Auto-lend: capital in the wallet's Auto-lend slots not yet
 *     lent (`availableCapital`), which sits in the vault under the slot and
 *     comes out by taking it out of the slot, its own step;
 *   - in loans, not withdrawable: the principal of the live loans whose
 *     lender position the wallet holds; it is with the borrowers, not in
 *     the vault.
 *
 * Each figure is one the protocol reports; none is derived from another.
 */
import type { Abi, PublicClient } from 'viem';
import { LenderIntentViewFacetABI } from '@vaipakam/contracts/abis';
import { ASSET_ERC20 } from '../positions/model';
import { readPagedList, type HoldingRow } from './holdings';

type Hex = `0x${string}`;

const INTENT = LenderIntentViewFacetABI as Abi;

/** One of the wallet's Auto-lend slots, as far as its waiting capital goes. */
export interface SlotCapital {
  lendingAsset: Hex;
  availableCapital: bigint;
  active: boolean;
}

/** A live loan, as far as the lender side's principal goes. */
export interface LentLoan {
  principalAsset: Hex;
  principal: bigint;
  assetType: number;
}

export interface BalanceLine {
  asset: Hex;
  /** Null when the protocol's figure could not be read. */
  free: bigint | null;
  /** Null when the wallet's Auto-lend slots could not be read: unknown,
   *  never zero. */
  waiting: bigint | null;
  /** True when not every slot could be listed, so `waiting` is a floor. */
  waitingPartial: boolean;
  inLoans: bigint;
  /** True when the wallet's positions were not all read (the scan stopped
   *  at its limit), so `inLoans` is a floor, possibly zero for a token
   *  whose loans lie past it. */
  inLoansPartial: boolean;
}

/** The loans the wallet lent, as read: `complete` false when the position
 *  scan stopped before the end. */
export interface LentRead {
  loans: readonly LentLoan[];
  complete: boolean;
}

/** The wallet's slots as read: every one, or a partial list (`complete`
 *  false); null when they could not be read at all. */
export type SlotRead = { slots: readonly SlotCapital[]; complete: boolean } | null;

/** The wallet's Auto-lend slots, every one it owns. */
export async function readSlotCapital(c: PublicClient, diamond: Hex, account: Hex): Promise<{ slots: SlotCapital[]; complete: boolean }> {
  const rows = await readPagedList<{ intent: { lendingAsset: Hex; availableCapital: bigint }; active: boolean }>(
    (offset, limit) =>
      c.readContract({ address: diamond, abi: INTENT, functionName: 'getLenderIntentsByOwner', args: [account, offset, limit] }) as Promise<
        readonly [readonly { intent: { lendingAsset: Hex; availableCapital: bigint }; active: boolean }[], bigint]
      >,
  );
  return { slots: rows.assets.map((r) => ({ lendingAsset: r.intent.lendingAsset, availableCapital: r.intent.availableCapital, active: r.active })), complete: rows.complete };
}

/**
 * The three lines, one per ERC-20 token any of them names, in the order the
 * tokens first appear (the vault's rows first). A token with all three at
 * zero is left out. Unread slots leave every waiting figure unknown, and a
 * partial slot list marks each as a floor; a partial position read marks
 * each in-loans figure as a floor the same way.
 */
export function balanceLines(rows: readonly Pick<HoldingRow, 'standard' | 'asset' | 'withdrawable'>[], slots: SlotRead, lent: LentRead): BalanceLine[] {
  const lines: BalanceLine[] = [];
  const at = (asset: Hex): BalanceLine => {
    const key = asset.toLowerCase();
    let hit = lines.find((l) => l.asset.toLowerCase() === key);
    if (!hit) {
      hit = { asset, free: 0n, waiting: slots === null ? null : 0n, waitingPartial: slots !== null && !slots.complete, inLoans: 0n, inLoansPartial: !lent.complete };
      lines.push(hit);
    }
    return hit;
  };
  for (const r of rows) {
    if (r.standard !== 'erc20') continue;
    const l = at(r.asset);
    l.free = r.withdrawable === null || l.free === null ? null : l.free + r.withdrawable;
  }
  for (const s of slots?.slots ?? []) {
    if (s.availableCapital === 0n) continue;
    const l = at(s.lendingAsset);
    l.waiting = (l.waiting ?? 0n) + s.availableCapital;
  }
  for (const loan of lent.loans) if (loan.assetType === ASSET_ERC20 && loan.principal > 0n) at(loan.principalAsset).inLoans += loan.principal;
  return lines.filter((l) => l.free === null || l.free > 0n || (l.waiting !== null && l.waiting > 0n) || l.inLoans > 0n);
}
