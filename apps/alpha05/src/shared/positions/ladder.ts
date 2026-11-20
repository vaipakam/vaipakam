/**
 * #3770 — the lending ladder: what an account has lent, by the month its
 * loans fall due, per token. It is a view of the live positions read for
 * the Positions page, nothing more. A loan whose dates could not be read is
 * counted apart, never placed in a month, and a list that was not read in
 * full makes every figure a floor.
 */
import { ASSET_ERC20, positionKey, type Deadlines, type LiveLoanRow } from './model';

type Hex = `0x${string}`;

export interface LadderRung {
  /** `YYYY-MM` of the due date (UTC, with pause credit). */
  month: string;
  asset: Hex;
  principal: bigint;
  loans: number;
}

export interface Ladder {
  rungs: LadderRung[];
  /** Lent loans whose due date could not be read, per token. */
  undated: { asset: Hex; principal: bigint; loans: number }[];
  /** False when the position list was not read in full: every figure is
   *  then at least what is shown. */
  complete: boolean;
}

function monthOf(unixSeconds: bigint): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function lendingLadder(rows: readonly LiveLoanRow[], deadlines: Readonly<Record<string, Deadlines | null>>, complete: boolean): Ladder {
  const rungs = new Map<string, LadderRung>();
  const undated = new Map<string, { asset: Hex; principal: bigint; loans: number }>();
  for (const r of rows) {
    if (r.borrowerSide || r.loan.assetType !== ASSET_ERC20) continue;
    const asset = r.loan.principalAsset;
    const d = deadlines[positionKey(r)] ?? null;
    if (d === null) {
      const k = asset.toLowerCase();
      const u = undated.get(k) ?? { asset, principal: 0n, loans: 0 };
      undated.set(k, { asset, principal: u.principal + r.loan.principal, loans: u.loans + 1 });
      continue;
    }
    const month = monthOf(d.maturity);
    const k = `${month}:${asset.toLowerCase()}`;
    const g = rungs.get(k) ?? { month, asset, principal: 0n, loans: 0 };
    rungs.set(k, { ...g, principal: g.principal + r.loan.principal, loans: g.loans + 1 });
  }
  const sorted = [...rungs.values()].sort((a, b) => (a.month === b.month ? a.asset.localeCompare(b.asset) : a.month < b.month ? -1 : 1));
  return { rungs: sorted, undated: [...undated.values()], complete };
}
