/**
 * RW-03 — a one-time signed transfer through Permit2, used where an entry
 * accepts one in place of a token approval (the VPFI deposit,
 * `depositVPFIToVaultWithPermit`).
 *
 * The wallet signs a transfer of exactly one amount of one token, to the
 * protocol as the only spender, valid until a deadline and usable once (its
 * nonce is burned on first use). Permit2 moves the tokens only when the
 * protocol presents that signature, and the protocol presents it only in a
 * transaction this wallet sends, delivering into this wallet's own vault.
 *
 * It needs no new approval only where the wallet has already let Permit2
 * move the token (its own approval for Permit2, which other apps may share).
 * The route is offered only then: asking for that standing approval here
 * would trade a one-off approval of exactly the amount for an open-ended
 * one, which is the opposite of what signing is for.
 */
import { erc20Abi, type Abi, type PublicClient } from 'viem';
import { PERMIT2 } from '../approvals/approvals';

type Hex = `0x${string}`;

/** How long a signed transfer stays valid, counted from the chain's clock. */
export const PERMIT_DEADLINE_SECONDS = 30 * 60;

export const SIGNATURE_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'nonceBitmap',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** The typed data Permit2 checks a signed transfer against (its
 *  `PermitTransferFrom`, with the spender bound by the contract). */
export const PERMIT_TRANSFER_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

/** Permit2's signing domain on a network: named, with no version. */
export function permitDomain(chainId: number) {
  return { name: 'Permit2', chainId, verifyingContract: PERMIT2 } as const;
}

/** The signed transfer as the protocol's entry takes it. */
export interface PermitTransfer {
  permitted: { token: Hex; amount: bigint };
  nonce: bigint;
  deadline: bigint;
}

/** The message the wallet signs: the transfer, with the protocol as its
 *  only spender. */
export function permitMessage(p: PermitTransfer, spender: Hex) {
  return { permitted: p.permitted, spender, nonce: p.nonce, deadline: p.deadline };
}

/** Whether a signed transfer of `amount` needs nothing more from the
 *  wallet; null fields were not read. */
export interface PermitRoute {
  /** Permit2 has code at its address on this network. */
  deployed: boolean;
  /** The wallet's own approval for Permit2 over this token. */
  allowance: bigint | null;
}

export async function readPermitRoute(c: PublicClient, account: Hex, token: Hex, blockNumber: bigint): Promise<PermitRoute> {
  const code = await c.getCode({ address: PERMIT2, blockNumber });
  const deployed = code !== undefined && code !== '0x';
  if (!deployed) return { deployed, allowance: null };
  const allowance = await c
    .readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, PERMIT2], blockNumber })
    .catch(() => null);
  return { deployed, allowance };
}

/** Whether the route is open for `amount`: Permit2 is here and the wallet's
 *  approval for it already covers the amount. Null when that is unknown. */
export function permitCovers(r: PermitRoute, amount: bigint): boolean | null {
  if (!r.deployed) return false;
  return r.allowance === null ? null : r.allowance >= amount;
}

/** A nonce Permit2 has not burned for this wallet: a random word and bit,
 *  checked against the wallet's nonce bitmap, so a signature is never made
 *  over a nonce that is already spent. */
export async function unusedNonce(
  c: PublicClient,
  account: Hex,
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b),
): Promise<bigint> {
  for (let i = 0; i < 4; i++) {
    const bytes = random(new Uint8Array(31));
    const word = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
    const bit = BigInt(random(new Uint8Array(1))[0]!);
    const map = (await c.readContract({ address: PERMIT2, abi: SIGNATURE_TRANSFER_ABI as Abi, functionName: 'nonceBitmap', args: [account, word] })) as bigint;
    if (((map >> bit) & 1n) === 0n) return (word << 8n) | bit;
  }
  throw new Error('no unused Permit2 nonce was found');
}
