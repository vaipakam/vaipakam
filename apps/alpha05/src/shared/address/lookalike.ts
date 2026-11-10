/**
 * #3415 — the address guard's checks on what a reader typed or pasted
 * (RB-ADDRESS-GUARD). Address poisoning works because people compare only
 * the first and last few characters: an attacker makes an address that
 * shares them with one the reader uses, and leaves it in their history.
 * So an entry that shares the first three and last three hex digits of an
 * address the reader already uses, and is not that address, is refused,
 * with no way past it: the reader is told which address it imitates.
 *
 * Pure: the caller passes the addresses it knows (the saved book, the
 * vault's destinations and pending additions, its signers and keepers, and
 * the connected wallet itself).
 */
import { getAddress, isAddress } from 'viem';

type Hex = `0x${string}`;

/** Where a known address comes from, so a warning can say which one is imitated. */
export type KnownSource = 'own' | 'book' | 'destination' | 'pending' | 'signer' | 'keeper';

export interface KnownAddress {
  address: Hex;
  source: KnownSource;
  /** The reader's own name for it, when it has one (a saved address). */
  label: string | null;
}

/** What the text in an address box is, before anything is sent. */
export type AddressCandidate =
  | { kind: 'empty' }
  /** Not an address, or not one yet (still being typed). */
  | { kind: 'invalid' }
  /** Mixed capitals that do not match the address's checksum: a character
   *  was probably changed or mistyped. */
  | { kind: 'badChecksum' }
  /** Exactly an address the reader already uses. */
  | { kind: 'known'; address: Hex; entry: KnownAddress }
  /** Shares the start and end of a known address and is not it. */
  | { kind: 'lookalike'; address: Hex; of: KnownAddress }
  /** An address this browser has not seen with the reader. */
  | { kind: 'new'; address: Hex };

/** How many hex digits at each end make two addresses look the same. */
export const LOOKALIKE_DIGITS = 3;

/** True when `a` and `b` are different addresses whose first and last
 *  {@link LOOKALIKE_DIGITS} hex digits match, case ignored. */
export function looksAlike(a: Hex, b: Hex): boolean {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  if (x === y) return false;
  const n = LOOKALIKE_DIGITS;
  return x.slice(0, n) === y.slice(0, n) && x.slice(-n) === y.slice(-n);
}

/** Read the text in an address box against the addresses the reader uses. */
export function classifyCandidate(text: string, known: readonly KnownAddress[]): AddressCandidate {
  const t = text.trim();
  if (t === '') return { kind: 'empty' };
  if (!isAddress(t, { strict: false })) return { kind: 'invalid' };
  const hex = t.slice(2);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  const address = getAddress(t);
  if (mixed && address !== t) return { kind: 'badChecksum' };
  const exact = known.find((k) => k.address.toLowerCase() === address.toLowerCase());
  if (exact) return { kind: 'known', address, entry: exact };
  const of = known.find((k) => looksAlike(k.address, address));
  if (of) return { kind: 'lookalike', address, of };
  return { kind: 'new', address };
}

/** One entry per address, the first source listed winning (callers list
 *  the most specific first: the wallet itself, then the saved book). */
export function mergeKnown(...lists: readonly (readonly KnownAddress[])[]): KnownAddress[] {
  const seen = new Set<string>();
  const out: KnownAddress[] = [];
  for (const list of lists)
    for (const k of list) {
      const id = k.address.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(k);
    }
  return out;
}

/** The address split for display: the leading and trailing groups people
 *  compare are set apart, and the middle is never cut. */
export function addressParts(address: Hex): { head: string; middle: string; tail: string } {
  const a = getAddress(address);
  const n = 2 + LOOKALIKE_DIGITS;
  return { head: a.slice(0, n), middle: a.slice(n, -LOOKALIKE_DIGITS), tail: a.slice(-LOOKALIKE_DIGITS) };
}
