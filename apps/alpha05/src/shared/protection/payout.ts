/**
 * Protected account mode, as it meets a payment the protocol makes to the
 * wallet (LN-54): where the payment goes, said before signing, and what
 * happened to it, measured from the transaction's own logs.
 *
 * A payout from a protected account's OWN vault to its wallet is queued for
 * the account's delay, or kept in the vault while the account is locked or
 * its queue is full (`LibProtectedAccount.gate`). A payment to a protected
 * wallet from anyone else's vault is paid into the account's vault instead,
 * so it leaves only through the account's own withdrawal and its delay. A
 * wallet without the mode is paid at once.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { ProtectedAccountFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

const PROTECTED = ProtectedAccountFacetABI as Abi;
const PAYOUT = VaultPayoutFacetABI as Abi;

/** The parts of the account's mode a payment's route depends on. */
export interface Protection {
  enabled: boolean;
  locked: boolean;
  delaySeconds: number;
  /** Each release from the queue needs a secondary signer's approval
   *  (`LibProtectedAccount.beginRelease` refuses `CosignRequired` without
   *  it, even after the delay). */
  requireCosign: boolean;
  /** A replacement retired the account: a queued payout to its old wallet
   *  is released to `controller` instead (`LibProtectedAccount.gate`). */
  retired: boolean;
  /** The wallet that manages a retired account (the zero address while it
   *  is not retired). */
  controller: Hex;
}

/** `getProtectedAccount`'s answer, as far as a payout's route reads it. */
export interface ProtectedAccountAnswer {
  enabled: boolean;
  locked: boolean;
  delaySeconds: number | bigint;
  requireCosign: boolean;
  retired: boolean;
  controller: Hex;
}

/** The one mapping from the contract's answer to the mode a route reads,
 *  so every flow that reads the account in its own batch states the same
 *  route. */
export function protectionFrom(a: ProtectedAccountAnswer | null): Protection | null {
  return a === null
    ? null
    : { enabled: a.enabled, locked: a.locked, delaySeconds: Number(a.delaySeconds), requireCosign: a.requireCosign, retired: a.retired, controller: a.controller };
}

/** The wallet's mode, or null when the contract gave no answer (a failed
 *  source is thrown, so the own rail tries the next one). */
export async function readProtection(c: PublicClient, diamond: Hex, account: Hex, blockNumber?: bigint): Promise<Protection | null> {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const a = (await answerOrNull(
    c.readContract({ address: diamond, abi: PROTECTED, functionName: 'getProtectedAccount', args: [account], ...at }),
  )) as ProtectedAccountAnswer | null;
  return protectionFrom(a);
}

/** Where a payment to `account` from `source`'s vault goes:
 *  - `wallet`: paid at once;
 *  - `queued`: the account's own vault, waiting out its delay (or kept in
 *    the vault if the queue turns out full; the outcome says which);
 *  - `held`: the account's own vault while it is locked;
 *  - `vault`: paid into the account's vault from another one;
 *  - `unknown`: the mode could not be read. */
export type PayoutRoute = 'wallet' | 'queued' | 'held' | 'vault' | 'unknown';

export function payoutRoute(protection: Protection | null, account: Hex, source: Hex): PayoutRoute {
  if (protection === null) return 'unknown';
  if (!protection.enabled) return 'wallet';
  if (source.toLowerCase() !== account.toLowerCase()) return 'vault';
  return protection.locked ? 'held' : 'queued';
}

/** Where the transaction put a payment of `asset` to `account` instead of
 *  the wallet, from the Diamond's own logs: queued (with the time it can be
 *  released), kept in the vault, or paid into the vault. One payment can
 *  split: with one queue slot left, a claim's first payment is queued and its
 *  second kept in the vault. So every destination the logs show is returned,
 *  each summed; none when nothing was routed (it was paid to the wallet, or
 *  not at all: the transfer itself says which). `tokenId` narrows it to one
 *  NFT of the collection. A queued payment names the wallet its release
 *  goes to: the account's own, or its controller's once it was retired. */
export type PayoutOutcome = { kind: 'queued'; amount: bigint; releaseAt: bigint; recipient: Hex } | { kind: 'held'; amount: bigint } | { kind: 'vault'; amount: bigint };

type Args = Record<string, bigint | number | string | undefined>;

export function payoutOutcomes(logs: readonly Log[], diamond: Hex, account: Hex, asset: Hex, tokenId?: bigint): PayoutOutcome[] {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: PAYOUT, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[];
  // An NFT is matched by its token id too: each routing record carries one,
  // so two NFTs of one collection never share each other's destinations.
  const same = (a: Args) =>
    String(a.account).toLowerCase() === account.toLowerCase() &&
    String(a.asset).toLowerCase() === asset.toLowerCase() &&
    (tokenId === undefined || BigInt(a.tokenId ?? 0n) === tokenId);
  const sum = (name: string, field: string) => {
    const hits = events.filter((e) => e.eventName === name && same(e.args));
    return hits.length === 0 ? null : { total: hits.reduce((t, e) => t + BigInt(e.args[field] ?? 0n), 0n), last: hits.at(-1)!.args };
  };
  const out: PayoutOutcome[] = [];
  const queued = sum('PayoutQueued', 'amount');
  if (queued) out.push({ kind: 'queued', amount: queued.total, releaseAt: BigInt(queued.last.releaseAt ?? 0n), recipient: String(queued.last.recipient).toLowerCase() as Hex });
  const held = sum('PayoutHeldInVault', 'amount');
  if (held) out.push({ kind: 'held', amount: held.total });
  const credited = sum('PaymentCreditedToVault', 'received');
  if (credited) out.push({ kind: 'vault', amount: credited.total });
  return out;
}
