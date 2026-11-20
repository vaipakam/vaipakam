/**
 * #3769 — "Borrow for someone" (FeaturesOverExistingPartsDesign §2). The
 * guarantor borrows as any borrower does; the other person's address is the
 * app's own note and gives nobody a right. It is checked only so the review
 * never names a meaningless address.
 */
import { getAddress, isAddress } from "viem";

type Hex = `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000";

export type ForWhomCheck =
  | { ok: true; address: Hex }
  | { ok: false; why: "empty" | "invalid" | "zero" | "self" };

export function checkForWhom(typed: string, account: Hex | null): ForWhomCheck {
  const t = typed.trim();
  if (t === "") return { ok: false, why: "empty" };
  if (!isAddress(t, { strict: false })) return { ok: false, why: "invalid" };
  const address = getAddress(t) as Hex;
  if (address.toLowerCase() === ZERO) return { ok: false, why: "zero" };
  if (account !== null && address.toLowerCase() === account.toLowerCase())
    return { ok: false, why: "self" };
  return { ok: true, address };
}
