/**
 * Protected account mode — the app's read of one account's protection state,
 * plus the pure classification the screens render from.
 *
 * Reads target the WALLET's chain (writes settle there) and are pinned to one
 * block, so the settings, the queue and the escape flag describe the same
 * moment and the block time is the clock every "due" comparison uses.
 *
 * Trust rules:
 *   - a Diamond that predates the protected-account facets reads as
 *     `supported: false` (missing-selector probe), never as "protection off";
 *   - a failed read of the account record marks the snapshot untrustworthy:
 *     the screens must not render controls over it, since "off" drawn over a
 *     failed read would invite enabling twice or hide a lock;
 *   - a failed read of the queue or a row is reported as unknown, never as
 *     an empty queue, because an empty list would hide a payout an attacker
 *     queued.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { parseEventLogs, type Log } from 'viem';
import { formatRequestCode } from '@vaipakam/lib/requestCode';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { isMissingSelectorError } from '../contracts/preflights';

/** Row states as the contract numbers them. */
export const ROW_STATE = { Queued: 1, Released: 2, Cancelled: 3 } as const;

/** `LibVaipakam.AssetType` ordinals. */
export const ASSET_KIND = { ERC20: 0, ERC721: 1, ERC1155: 2 } as const;
export type AssetKind = (typeof ASSET_KIND)[keyof typeof ASSET_KIND];

export interface ProtectedAccountRecord {
  enabled: boolean;
  locked: boolean;
  protectNfts: boolean;
  requireCosign: boolean;
  retired: boolean;
  delaySeconds: number;
  pendingDelay: number;
  pendingDelayAt: bigint;
  pendingDisableAt: bigint;
  pendingUnlockAt: bigint;
  pendingNftOffAt: bigint;
  pendingCosignOffAt: bigint;
  cooldownUntil: bigint;
  lockedAt: bigint;
  lockedBy: `0x${string}`;
  controller: `0x${string}`;
  pendingUnpinAt: bigint;
}

export interface PendingPayoutRow {
  id: bigint;
  /** Six-character code from the contract's 30 bits, or null if unread. */
  code: string | null;
  kind: number;
  state: number;
  cosigned: boolean;
  releaseAt: bigint;
  asset: `0x${string}`;
  recipient: `0x${string}`;
  tokenId: bigint;
  amount: bigint;
}

export interface PendingTransferRow {
  id: bigint;
  code: string | null;
  state: number;
  /** A signer co-signed it (needed before release while co-signing is on). */
  cosigned: boolean;
  releaseAt: bigint;
  to: `0x${string}`;
  tokenId: bigint;
}

export interface SignerEntry {
  signer: `0x${string}`;
  /** Active signers carry no pending addition; a pending removal matures
   *  at `removeAt` (0 = none). */
  removeAt: bigint;
}

/** A pending allowlist or signer addition, listed by the contract per
 *  change epoch (a voided one is not listed). It matures at `at` and must be
 *  applied within one further delay, after which it has expired. */
export interface PendingAddition {
  address: `0x${string}`;
  at: bigint;
  /** Signer additions only: the nominee accepted from its own key. */
  accepted?: boolean;
}

export interface ReplacementState {
  nominee: `0x${string}`;
  proposedBy: `0x${string}`;
  readyAt: bigint;
  round: number;
  approvals: number;
  threshold: number;
}

export interface ProtectedAccountSnapshot {
  supported: boolean;
  /** The account record could not be read: render no controls. */
  recordFailed: boolean;
  record: ProtectedAccountRecord | null;
  signers: SignerEntry[] | null;
  allowlist: `0x${string}`[] | null;
  /** Null when unread: a waiting addition may then be missing. */
  pendingAllowlist: PendingAddition[] | null;
  pendingSigners: PendingAddition[] | null;
  payouts: PendingPayoutRow[] | null;
  transfers: PendingTransferRow[] | null;
  replacement: ReplacementState | null;
  escapeOpen: boolean | null;
  /** The pinned implementation, or null when not pinned. */
  vaultPin: `0x${string}` | null;
  /** False when the pin read failed (then `vaultPin` means nothing). */
  vaultPinKnown: boolean;
  delayBounds: { min: number; max: number } | null;
  /** Block time of the pinned read. */
  chainNowSec: bigint;
  fetchedAtMs: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** Chain time now, from the snapshot's block time plus elapsed wall time. */
export function chainNowOf(s: Pick<ProtectedAccountSnapshot, 'chainNowSec' | 'fetchedAtMs'>, nowSec: number): bigint {
  const elapsed = Math.max(0, nowSec - Math.floor(s.fetchedAtMs / 1000));
  return s.chainNowSec + BigInt(elapsed);
}

export type PayoutStatus = 'waiting' | 'due' | 'needsCosign' | 'locked';

/** What a queued payout is waiting on, in the order the contract checks:
 *  the lock first, then the time, then the co-signature. */
export function payoutStatus(
  row: Pick<PendingPayoutRow, 'releaseAt' | 'cosigned'>,
  record: Pick<ProtectedAccountRecord, 'locked' | 'requireCosign'>,
  chainNow: bigint,
): PayoutStatus {
  if (record.locked) return 'locked';
  if (chainNow < row.releaseAt) return 'waiting';
  if (record.requireCosign && !row.cosigned) return 'needsCosign';
  return 'due';
}

/** A pending timed change is due once its time has passed (0 = none). */
export function isDue(at: bigint, chainNow: bigint): boolean {
  return at !== 0n && chainNow >= at;
}

/** Where a pending addition stands: still waiting, ready to apply, or
 *  expired (not applied within one further delay after it matured, as the
 *  contract refuses it then). */
export function additionStatus(at: bigint, delaySeconds: number, chainNow: bigint): 'waiting' | 'ready' | 'expired' {
  if (chainNow < at) return 'waiting';
  return chainNow > at + BigInt(delaySeconds) ? 'expired' : 'ready';
}

/** Whether `who` is the account's manager: the account itself, or its
 *  controller once a replacement retired it. */
export function isManager(account: string, record: ProtectedAccountRecord, who: string | undefined): boolean {
  if (!who) return false;
  const w = who.toLowerCase();
  if (record.retired) return record.controller.toLowerCase() === w;
  return account.toLowerCase() === w;
}

/**
 * Whether the connected wallet may put funds into its OWN account, the one
 * rule every funding surface reads (the depository card, the VPFI deposit):
 * the contract refuses each funding entry point from a wallet whose account
 * a replacement retired, so such a deposit is never offered, nor an approval
 * for one. `unread` until the account record is read; a Diamond without
 * protected account mode retires nothing, so it is `open`.
 */
export type OwnFundingVerdict =
  | { kind: 'unread' }
  | { kind: 'open' }
  | { kind: 'retired'; controller: `0x${string}` };

export function ownFundingVerdict(
  snap: Pick<ProtectedAccountSnapshot, 'supported' | 'recordFailed' | 'record'> | undefined,
  readFailed: boolean,
): OwnFundingVerdict {
  if (!snap || readFailed) return { kind: 'unread' };
  if (!snap.supported) return { kind: 'open' };
  if (snap.recordFailed || snap.record === null) return { kind: 'unread' };
  return snap.record.retired ? { kind: 'retired', controller: snap.record.controller } : { kind: 'open' };
}

/** The contract's cap on an account's open rows (payouts plus position
 *  transfers); a full queue refuses a new withdrawal. */
export const MAX_OPEN_ROWS = 16;

/**
 * Whether a withdrawal from the account, asked for by its manager, can be
 * sent now, the one rule every withdrawal surface reads (the depository card,
 * the VPFI withdrawal). It mirrors the contract: a locked account, a full
 * queue, or (for the old wallet) a retired account is refused, so a refused
 * withdrawal is never offered. `asController` is true when the connected
 * wallet manages a retired account it took over.
 */
export type OwnWithdrawalVerdict =
  | { kind: 'unread' }
  | { kind: 'open'; queued: boolean }
  | { kind: 'locked' }
  | { kind: 'retired'; controller: `0x${string}` }
  | { kind: 'queueFull' };

export function ownWithdrawalVerdict(
  snap: Pick<ProtectedAccountSnapshot, 'supported' | 'recordFailed' | 'record' | 'payouts' | 'transfers'> | undefined,
  readFailed: boolean,
  asController = false,
): OwnWithdrawalVerdict {
  if (!snap || readFailed) return { kind: 'unread' };
  if (!snap.supported) return { kind: 'open', queued: false };
  if (snap.recordFailed || snap.record === null) return { kind: 'unread' };
  const r = snap.record;
  if (!r.enabled) return { kind: 'open', queued: false };
  if (r.retired && !asController) return { kind: 'retired', controller: r.controller };
  if (r.locked) return { kind: 'locked' };
  if (snap.payouts === null || snap.transfers === null) return { kind: 'unread' };
  if (snap.payouts.length + snap.transfers.length >= MAX_OPEN_ROWS) return { kind: 'queueFull' };
  return { kind: 'open', queued: true };
}

/**
 * What a confirmed transaction did with a payment to `account`, read from its
 * receipt and never assumed: paid to the wallet, queued behind the delay,
 * held in the vault (the payout gate holds a payment for a locked account or
 * a full queue), or credited to the vault (a payment from someone else's
 * wallet to a protected account). Only `account`'s own events count, so a
 * counterparty's payout in the same transaction never colours the answer.
 */
export type PayoutOutcome =
  | { kind: 'paid' }
  // `recipient` is who the queued row will pay: the account's wallet, or the
  // controller of a retired account (the gate redirects its payouts there).
  | { kind: 'queued'; recipient: string }
  | { kind: 'held' }
  | { kind: 'inVault' };

export function payoutOutcome(logs: readonly Log[], account: string | undefined): PayoutOutcome {
  const mine = (eventName: 'PayoutHeldInVault' | 'PayoutQueued' | 'PaymentCreditedToVault') =>
    parseEventLogs({ abi: DIAMOND_ABI_VIEM, eventName, logs: logs as Log[] }).filter(
      (e) => !account || String((e.args as { account?: string }).account ?? '').toLowerCase() === account.toLowerCase(),
    );
  if (mine('PayoutHeldInVault').length > 0) return { kind: 'held' };
  const queued = mine('PayoutQueued');
  if (queued.length > 0) {
    return { kind: 'queued', recipient: String((queued[0].args as { recipient?: string }).recipient ?? account ?? '') };
  }
  if (mine('PaymentCreditedToVault').length > 0) return { kind: 'inVault' };
  return { kind: 'paid' };
}

/**
 * Where a payment the protocol makes to the connected wallet will land, for
 * every surface that pays it (a loan claim, a collateral release, the claim
 * batch), so none promises the wallet a payment protection will queue or keep
 * in the vault. It mirrors the payout gate.
 */
export type OwnPayoutRoute =
  | { kind: 'unread' }
  | { kind: 'wallet' }
  // `to` is set when the account was moved to a new wallet: the gate then
  // pays every queued payout to that controller, not to this wallet.
  | { kind: 'queued'; delaySeconds: number; cosign: boolean; to: string | null }
  | { kind: 'vault' }
  // Paid out of ANOTHER account's vault (a transferred position whose
  // assets sit in the recorded party's vault): the vault layer credits a
  // protected recipient's own vault instead and queues nothing, so the
  // owner withdraws it separately.
  | { kind: 'creditedToVault' };

/**
 * `account` is the wallet being paid and `source` the account whose vault
 * pays it (a loan claim pays from the recorded lender's or borrower's
 * vault). When the two differ, the vault layer credits a protected
 * recipient's vault rather than queueing; when either is unknown the
 * payment is taken as the account's own.
 */
export function ownPayoutRoute(
  snap: Pick<ProtectedAccountSnapshot, 'supported' | 'recordFailed' | 'record' | 'payouts' | 'transfers'> | undefined,
  readFailed: boolean,
  account?: string,
  source?: string,
): OwnPayoutRoute {
  if (!snap || readFailed) return { kind: 'unread' };
  if (!snap.supported) return { kind: 'wallet' };
  if (snap.recordFailed || snap.record === null) return { kind: 'unread' };
  const r = snap.record;
  if (!r.enabled) return { kind: 'wallet' };
  if (account && source && account.toLowerCase() !== source.toLowerCase()) return { kind: 'creditedToVault' };
  if (r.locked) return { kind: 'vault' };
  if (snap.payouts === null || snap.transfers === null) return { kind: 'unread' };
  if (snap.payouts.length + snap.transfers.length >= MAX_OPEN_ROWS) return { kind: 'vault' };
  return {
    kind: 'queued',
    delaySeconds: r.delaySeconds,
    cosign: r.requireCosign,
    to: r.retired ? r.controller : null,
  };
}

/** The connected wallet's payout route, read live, for a payment out of
 *  `source`'s vault (the wallet's own when omitted). */
export function useOwnPayoutRoute(source?: string): OwnPayoutRoute {
  const { address } = useActiveChain();
  const q = useProtectedAccount(address ?? undefined);
  return ownPayoutRoute(q.data, q.isError, address ?? undefined, source);
}

export function hasReplacement(r: ReplacementState | null): boolean {
  return Boolean(r && r.nominee.toLowerCase() !== ZERO);
}

/** The fewest active secondary signers a signer-led replacement needs
 *  (`LibProtectedAccount.MIN_RECOVERY_SIGNERS`). */
export const MIN_RECOVERY_SIGNERS = 3;

/**
 * Where an open replacement proposal stands, by the rule
 * `ProtectedAccountFacet.finalizeReplacement` applies:
 * - `collecting`: a signer-led proposal still gathering its majority;
 * - `quorumLost`: it reached its majority once, but the signers active NOW
 *   no longer give it one (too few signers, or too few of the current
 *   signers approve), so completion would be refused;
 * - `nomineeIsSigner`: the nominee has since become a signer, which the
 *   contract refuses at completion;
 * - `scheduled`: it will be completable from `readyAt`;
 * - `due`: completable now.
 * A proposal by the account's manager needs no signer approval.
 * `null` when the signer list could not be read: the stage is unknown.
 */
export type ReplacementStage = 'collecting' | 'quorumLost' | 'nomineeIsSigner' | 'scheduled' | 'due';

export function replacementStage(
  repl: ReplacementState,
  record: ProtectedAccountRecord,
  account: string,
  signers: SignerEntry[] | null,
  chainNow: bigint,
): ReplacementStage | null {
  if (signers === null) return null;
  const nominee = repl.nominee.toLowerCase();
  if (signers.some((x) => x.signer.toLowerCase() === nominee)) return 'nomineeIsSigner';
  const manager = (record.retired ? record.controller : account).toLowerCase();
  const bySigner = repl.proposedBy.toLowerCase() !== manager;
  if (bySigner && (signers.length < MIN_RECOVERY_SIGNERS || repl.approvals < repl.threshold)) {
    return repl.readyAt > 0n ? 'quorumLost' : 'collecting';
  }
  if (repl.readyAt === 0n) return 'collecting';
  return chainNow >= repl.readyAt ? 'due' : 'scheduled';
}

/**
 * Reads `account`'s protection state (default: the connected wallet).
 * Pass another account to act on it as one of its secondary signers.
 */
export function useProtectedAccount(account?: `0x${string}`) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const target = account ?? address;
  const chainId = walletChain?.chainId;
  const publicClient = usePublicClient({ chainId });

  return useQuery({
    queryKey: ['protectedAccount', chainId, target?.toLowerCase()],
    enabled: Boolean(publicClient) && Boolean(target) && onSupportedChain && Boolean(walletChain?.diamondAddress),
    refetchInterval: 30_000,
    queryFn: async (): Promise<ProtectedAccountSnapshot> => {
      const diamond = walletChain!.diamondAddress;
      const block = await publicClient!.getBlock();
      const fetchedAtMs = Date.now();
      const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
        publicClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName,
          args: args as unknown[],
          blockNumber: block.number,
        }) as Promise<T>;
      const soft = async <T,>(p: Promise<T>): Promise<T | null> => {
        try {
          return await p;
        } catch {
          return null;
        }
      };

      const base: ProtectedAccountSnapshot = {
        supported: true,
        recordFailed: false,
        record: null,
        signers: null,
        allowlist: null,
        pendingAllowlist: null,
        pendingSigners: null,
        payouts: null,
        transfers: null,
        replacement: null,
        escapeOpen: null,
        vaultPin: null,
        vaultPinKnown: false,
        delayBounds: null,
        chainNowSec: block.timestamp,
        fetchedAtMs,
      };

      let record: ProtectedAccountRecord;
      try {
        record = await read<ProtectedAccountRecord>('getProtectedAccount', [target]);
      } catch (e) {
        if (isMissingSelectorError(e)) return { ...base, supported: false };
        return { ...base, recordFailed: true };
      }

      const [signerAddrs, allowlist, payoutIds, transferIds, repl, escapeOpen, vaultPin, bounds, pendAllow, pendSign] =
        await Promise.all([
        soft(read<`0x${string}`[]>('getProtectedSigners', [target])),
        soft(read<`0x${string}`[]>('getAllowlist', [target])),
        soft(read<bigint[]>('getPendingPayoutIds', [target])),
        soft(read<bigint[]>('getPendingTransferIds', [target])),
        soft(
          read<
            readonly [
              { nominee: `0x${string}`; proposedBy: `0x${string}`; readyAt: bigint; round: number; approvals: number },
              bigint,
              bigint,
            ]
          >('getReplacement', [target]),
        ),
        soft(read<boolean>('isEscapeOpen')),
        soft(read<`0x${string}`>('getVaultPin', [target])),
        soft(read<readonly [bigint, bigint]>('getProtectedDelayBounds')),
        soft(read<readonly [readonly `0x${string}`[], readonly bigint[]]>('getPendingAllowlistAdditions', [target])),
        soft(
          read<readonly [readonly `0x${string}`[], readonly bigint[], readonly boolean[]]>(
            'getPendingSignerAdditions',
            [target],
          ),
        ),
      ]);

      // A list is known only if EVERY entry under it read: a partial queue
      // would hide the one row that matters.
      const all = async <T,>(ps: Promise<T | null>[]): Promise<T[] | null> => {
        const out = await Promise.all(ps);
        return out.some((x) => x === null) ? null : (out as T[]);
      };

      const signers = signerAddrs
        ? await all(
            signerAddrs.map(async (signer) => {
              const c = await soft(
                read<{ addAt: bigint; accepted: boolean; removeAt: bigint }>('getSignerChange', [target, signer]),
              );
              return c ? { signer, removeAt: c.removeAt } : null;
            }),
          )
        : null;

      const code = async (id: bigint) => {
        const c = await soft(read<number>('requestCode', [id]));
        return c === null ? null : formatRequestCode(c);
      };

      const payouts = payoutIds
        ? await all(
            payoutIds.map(async (id) => {
              const r = await soft(
                read<Omit<PendingPayoutRow, 'id' | 'code'> & { user: string; delivered: bigint }>('getPendingPayout', [
                  id,
                ]),
              );
              if (!r) return null;
              return {
                id,
                code: await code(id),
                kind: Number(r.kind),
                state: Number(r.state),
                cosigned: r.cosigned,
                releaseAt: BigInt(r.releaseAt),
                asset: r.asset,
                recipient: r.recipient,
                tokenId: r.tokenId,
                amount: r.amount,
              };
            }),
          )
        : null;

      const transfers = transferIds
        ? await all(
            transferIds.map(async (id) => {
              const r = await soft(
                read<{ from: string; state: number; cosigned: boolean; releaseAt: bigint; to: `0x${string}`; tokenId: bigint }>(
                  'getPendingPositionTransfer',
                  [id],
                ),
              );
              if (!r) return null;
              return {
                id,
                code: await code(id),
                state: Number(r.state),
                cosigned: Boolean(r.cosigned),
                releaseAt: BigInt(r.releaseAt),
                to: r.to,
                tokenId: r.tokenId,
              };
            }),
          )
        : null;

      return {
        ...base,
        record: {
          ...record,
          delaySeconds: Number(record.delaySeconds),
          pendingDelay: Number(record.pendingDelay),
        },
        signers,
        allowlist,
        pendingAllowlist: pendAllow ? pendAllow[0].map((address, i) => ({ address, at: BigInt(pendAllow[1][i]) })) : null,
        pendingSigners: pendSign
          ? pendSign[0].map((address, i) => ({ address, at: BigInt(pendSign[1][i]), accepted: pendSign[2][i] }))
          : null,
        payouts: payouts?.sort((a, b) => (a.releaseAt < b.releaseAt ? -1 : 1)) ?? null,
        transfers,
        replacement: repl
          ? {
              nominee: repl[0].nominee,
              proposedBy: repl[0].proposedBy,
              readyAt: BigInt(repl[0].readyAt),
              round: Number(repl[0].round),
              approvals: Number(repl[1]),
              threshold: Number(repl[2]),
            }
          : null,
        escapeOpen,
        vaultPin: vaultPin && vaultPin.toLowerCase() !== ZERO ? vaultPin : null,
        vaultPinKnown: vaultPin !== null,
        delayBounds: bounds ? { min: Number(bounds[0]), max: Number(bounds[1]) } : null,
      };
    },
  });
}

/**
 * The retired account the connected wallet now manages (it became that
 * account's controller through a replacement), or null. Undefined while
 * unread; a failed read is an error state, never "none".
 */
export function useRetiredAccountOf() {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const chainId = walletChain?.chainId;
  const publicClient = usePublicClient({ chainId });
  return useQuery({
    queryKey: ['protectedAccount', 'retiredOf', chainId, address?.toLowerCase()],
    enabled: Boolean(publicClient) && Boolean(address) && onSupportedChain && Boolean(walletChain?.diamondAddress),
    queryFn: async (): Promise<`0x${string}` | null> => {
      try {
        const a = (await publicClient!.readContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getRetiredAccountOf',
          args: [address],
        })) as `0x${string}`;
        return a.toLowerCase() === ZERO ? null : a;
      } catch (e) {
        if (isMissingSelectorError(e)) return null;
        throw e;
      }
    },
  });
}
