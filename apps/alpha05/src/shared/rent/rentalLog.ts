/**
 * RB-CONFIDENCE — what a transaction did to one rental's user right, read
 * from its own log: the Diamond's `VaultRentalUpdated` names the rental it
 * updated (`loanId`) and that rental's record after the update (its user,
 * expiry and rented quantity; a zero user and quantity on a revoke).
 *
 * Read from the log rather than from the owner's vault at the receipt's
 * block, because the vault's figures are aggregates across every active
 * rental of the token, and they move for reasons that are not this
 * transaction: an expired rental drops out of them by itself, and another
 * rental of the same token starting or ending later in the same block moves
 * the total too. Only the log ties the change to this rental.
 */
import { parseEventLogs, type Abi, type Log } from 'viem';
import { VaultFactoryFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const VAULT_FACTORY = VaultFactoryFacetABI as Abi;

/** One rental's record as a transaction left it. */
export interface RentalUpdate {
  /** The owner whose vault holds the NFT. */
  lender: Hex;
  /** The renter named after the update; the zero address on a revoke. */
  user: Hex;
  /** When the renter's use ends, unix seconds. */
  expires: bigint;
  /** Units this rental holds after the update; zero on a revoke. */
  quantity: bigint;
  /** Units rented out across every active rental of the token afterwards. */
  activeTotal: bigint;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** The last update this transaction made to rental `loanId`, or null when
 *  it made none. */
export function rentalUpdate(logs: readonly Log[], diamond: Hex, loanId: bigint): RentalUpdate | null {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: VAULT_FACTORY, logs: [...own], eventName: 'VaultRentalUpdated', strict: false }) as unknown as {
    args: { lender?: Hex; loanId?: bigint; user?: Hex; expires?: bigint | number; quantity?: bigint; activeTotalQuantity?: bigint };
  }[];
  const mine = events.filter((e) => e.args.loanId === loanId && e.args.user !== undefined && e.args.quantity !== undefined);
  const last = mine[mine.length - 1];
  if (!last) return null;
  const a = last.args;
  return { lender: a.lender ?? ZERO, user: a.user!, expires: BigInt(a.expires ?? 0), quantity: a.quantity!, activeTotal: a.activeTotalQuantity ?? 0n };
}

/** Whether the update revoked the rental: no user and nothing rented. */
export function isRevoked(u: RentalUpdate): boolean {
  return u.user.toLowerCase() === ZERO && u.quantity === 0n;
}
