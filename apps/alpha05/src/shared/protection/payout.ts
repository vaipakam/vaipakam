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
import { ProtectedAccountFacetABI, VaipakamVaultImplementationABI, VaultOutflowFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import {
  protectedAccountFromVault,
  type DiamondProtection,
  type ProtectedAccountRecordFromVault,
  type VaultProtectionState,
} from '@vaipakam/lib/protectedAccountView';
import { answerOrNull } from '../reads/answer';

type Hex = `0x${string}`;

const PROTECTED = ProtectedAccountFacetABI as Abi;
/** #3379 B2 — the account's vault, which holds its protected record. */
export const VAULT = VaipakamVaultImplementationABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';
const PAYOUT = VaultPayoutFacetABI as Abi;
const OUTFLOW = VaultOutflowFacetABI as Abi;

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

/** The account's protected record (the vault's, with the Diamond's co-sign
 *  setting), as far as a payout's route reads it. */
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

/** #3379 B2 — the account's protected record, now held by its vault: the
 *  Diamond's `getProtection(account)` names the vault (and the co-sign
 *  setting), the vault's `protectionState()` and `vaultOwner()` the rest. An
 *  account with no vault reads as protected mode off. Reverts are thrown
 *  (wrap in `answerOrNull` to read one as unread). The vault exposes no
 *  pending setting times nor when its lock was set: those read 0
 *  ({@link protectedAccountFromVault}). */
export interface ProtectedRecord {
  record: ProtectedAccountRecordFromVault;
  /** The account's vault; null when it has none. */
  vault: Hex | null;
  signers: readonly Hex[];
  allowlist: readonly Hex[];
}

export async function readProtectedRecord(c: PublicClient, diamond: Hex, account: Hex, blockNumber?: bigint): Promise<ProtectedRecord> {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const protection = (await c.readContract({ address: diamond, abi: PROTECTED, functionName: 'getProtection', args: [account], ...at })) as DiamondProtection;
  const vault = protection[0].toLowerCase() === ZERO ? null : protection[0];
  if (vault === null) return { record: protectedAccountFromVault(account, protection, null, null), vault, signers: [], allowlist: [] };
  const [state, owner] = await Promise.all([
    c.readContract({ address: vault, abi: VAULT, functionName: 'protectionState', ...at }) as Promise<VaultProtectionState>,
    c.readContract({ address: vault, abi: VAULT, functionName: 'vaultOwner', ...at }) as Promise<Hex>,
  ]);
  return { record: protectedAccountFromVault(account, protection, state, owner), vault, signers: state[5], allowlist: state[6] };
}

/** The account's record as a payout's route reads it, or null when the
 *  contract gave no answer (a failed source is thrown). */
export async function readProtectedAccountAnswer(c: PublicClient, diamond: Hex, account: Hex, blockNumber?: bigint): Promise<ProtectedAccountAnswer | null> {
  const r = await answerOrNull(readProtectedRecord(c, diamond, account, blockNumber));
  return r === null ? null : r.record;
}

/** The wallet's mode, or null when the contract gave no answer (a failed
 *  source is thrown, so the own rail tries the next one). */
export async function readProtection(c: PublicClient, diamond: Hex, account: Hex, blockNumber?: bigint): Promise<Protection | null> {
  return protectionFrom(await readProtectedAccountAnswer(c, diamond, account, blockNumber));
}

/** Where a payment to `account` from `source`'s vault goes:
 *  - `credit`: into the account's own vault, counted as its own free funds,
 *    which it then withdraws (a loan claim, a new loan's principal: see
 *    `CREDIT_CLASSES`); protected mode does not change it;
 *  - `wallet`: paid at once;
 *  - `queued`: the account's own vault, waiting out its delay (or kept in
 *    the vault if the queue turns out full; the outcome says which);
 *  - `held`: the account's own vault while it is locked;
 *  - `vault`: paid into the account's vault from another one;
 *  - `unknown`: the mode could not be read. */
export type PayoutRoute = 'credit' | 'wallet' | 'queued' | 'held' | 'vault' | 'unknown';

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
export type PayoutOutcome =
  | { kind: 'queued'; amount: bigint; releaseAt: bigint; recipient: Hex }
  | { kind: 'held'; amount: bigint }
  | { kind: 'vault'; amount: bigint }
  | { kind: 'credit'; amount: bigint };

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

/**
 * The movements the protocol credits to the payee's vault as the payee's own
 * free funds, by their class in its `VaultOutflow` record
 * (`VaultOutflowFacet._credits`): a position holder's payout (every loan
 * claim pays the current holder's vault), a counterparty's share, and a new
 * loan's net principal into the borrower's vault. The payee withdraws it
 * through its own withdrawal, and only that is subject to protected mode.
 */
export const CREDIT_CLASSES: readonly number[] = [
  2, // PositionHolder
  3, // Counterparty
  14, // PrincipalToBorrower
];

/**
 * What the transaction credited to `vault` of `asset`, from the Diamond's
 * `VaultOutflow` records of a crediting class whose destination is that
 * vault, as the protocol measured it arriving (`delivered`): one outcome, or
 * none when nothing was credited. A payout from the payee's OWN vault (the
 * payee is still the party the loan recorded) moves nothing and is recorded
 * with the vault as its destination, so it counts here too. `tokenId`
 * narrows it to one NFT of the collection; `ref` to one loan (or, for a new
 * loan's principal, its offer).
 */
function creditEvents(logs: readonly Log[], diamond: Hex, vault: Hex, classes: readonly number[]): Args[] {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: OUTFLOW, logs: [...own], eventName: 'VaultOutflow', strict: false }) as unknown as { args: Args }[];
  return events.map((e) => e.args).filter((a) => String(a.to).toLowerCase() === vault.toLowerCase() && classes.includes(Number(a.class_)));
}

/** Whether the transaction credited anything at all to `vault` (a finish
 *  card then offers the withdrawal). */
export function creditedTo(logs: readonly Log[], diamond: Hex, vault: Hex): boolean {
  return creditEvents(logs, diamond, vault, CREDIT_CLASSES).some((a) => BigInt(a.delivered ?? 0n) > 0n);
}

export function vaultCredit(
  logs: readonly Log[],
  diamond: Hex,
  vault: Hex,
  asset: Hex,
  filter: { tokenId?: bigint; ref?: readonly bigint[]; classes?: readonly number[] } = {},
): PayoutOutcome | null {
  const hits = creditEvents(logs, diamond, vault, filter.classes ?? CREDIT_CLASSES).filter(
    (a) =>
      String(a.asset).toLowerCase() === asset.toLowerCase() &&
      (filter.tokenId === undefined || BigInt(a.tokenId ?? 0n) === filter.tokenId) &&
      (filter.ref === undefined || filter.ref.includes(BigInt(a.ref ?? 0n))),
  );
  if (hits.length === 0) return null;
  return { kind: 'credit', amount: hits.reduce((t, a) => t + BigInt(a.delivered ?? 0n), 0n) };
}
