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
import {
  protectedAccountFromVault,
  VAULT_PROTECTION_VIEWS_ABI,
  type DiamondProtection,
  type VaultProtectionPending,
  type VaultProtectionState,
  type VaultReplacementTally,
} from '@vaipakam/lib/protectedAccountView';
import { useQueries, useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { parseEventLogs, type Log } from 'viem';
import { formatRequestCode } from '@vaipakam/lib/requestCode';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { VaipakamVaultImplementationABI } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { isMissingSelectorError } from '../contracts/preflights';
import { LEGACY_DIAMOND_NFT_ABI, POSITION_NFT_ABI, type PositionNftMode } from '../contracts/positionNft';

/** Row states as the contract numbers them. */
export const ROW_STATE = { Queued: 1, Released: 2, Cancelled: 3 } as const;

/** `LibVaipakam.AssetType` ordinals. */
export const ASSET_KIND = { ERC20: 0, ERC721: 1, ERC1155: 2 } as const;
export type AssetKind = (typeof ASSET_KIND)[keyof typeof ASSET_KIND];

/**
 * #3379 B2 — the record lives in the account's vault and is rebuilt here from
 * the vault's views (`protectionState`, `vaultOwner`, `protectionPending`)
 * and the Diamond's `getProtection` (`protectedAccountFromVault`).
 */
export interface ProtectedAccountRecord {
  enabled: boolean;
  locked: boolean;
  /** Legacy-mode chains only (#3205): the account delays its position NFT
   *  transfers through the Diamond's queue. Always false in standalone
   *  mode, where the PositionNFT holder lock protects the NFTs instead. */
  protectNfts: boolean;
  requireCosign: boolean;
  retired: boolean;
  delaySeconds: number;
  pendingDelay: number;
  pendingDelayAt: bigint;
  pendingDisableAt: bigint;
  pendingUnlockAt: bigint;
  /** Legacy-mode only, like `protectNfts`; 0 in standalone mode. */
  pendingNftOffAt: bigint;
  pendingCosignOffAt: bigint;
  cooldownUntil: bigint;
  lockedAt: bigint;
  lockedBy: `0x${string}`;
  controller: `0x${string}`;
  /** #3204 — retired; a pending pin change is held by the VaultBeacon. */
  retiredPendingUnpinAt: bigint;
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
  /** Whether the release needs a co-signature, by the release's own rule
   *  (`payoutNeedsCosign`, Codex #3489 r2): the account's co-sign setting
   *  while it has a signer, or an unverified allowlisted destination (#3415).
   *  Null when that read failed. */
  needsCosign: boolean | null;
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

/** The PositionNFT holder lock on an account's own tokens (#3205,
 *  standalone mode): `unlockAt` is a pending unlock and `lowerAt` a pending
 *  lowering of `delay` to `lowerDelay` (0 = none pending). */
export interface HolderLockState {
  locked: boolean;
  delay: bigint;
  unlockAt: bigint;
  lowerDelay: bigint;
  lowerAt: bigint;
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
  /** Approvals by the signers active now (`vault.replacementTally()`). */
  approvals: number;
  threshold: number;
}

export interface ProtectedAccountSnapshot {
  supported: boolean;
  /** #3379 B2 — the account's vault, where its protected record lives and
   *  every protected-mode write is sent; null when it has none yet. */
  vault: `0x${string}` | null;
  /** The account record could not be read: render no controls. */
  recordFailed: boolean;
  record: ProtectedAccountRecord | null;
  signers: SignerEntry[] | null;
  allowlist: `0x${string}`[] | null;
  /** Null when unread: a waiting addition may then be missing. */
  pendingAllowlist: PendingAddition[] | null;
  pendingSigners: PendingAddition[] | null;
  payouts: PendingPayoutRow[] | null;
  /** The legacy Diamond's queued position NFT transfers. Always `[]` in
   *  standalone mode, where no such queue exists (#3205). */
  transfers: PendingTransferRow[] | null;
  /** Where the chain's position NFTs live (#3205). */
  nftMode: PositionNftMode;
  /** Standalone mode: the account's PositionNFT holder lock; null when
   *  unread or in legacy mode. */
  holderLock: HolderLockState | null;
  replacement: ReplacementState | null;
  escapeOpen: boolean | null;
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
  row: Pick<PendingPayoutRow, 'releaseAt' | 'cosigned'> & { needsCosign?: boolean | null },
  record: Pick<ProtectedAccountRecord, 'locked' | 'requireCosign'>,
  chainNow: bigint,
): PayoutStatus {
  if (record.locked) return 'locked';
  if (chainNow < row.releaseAt) return 'waiting';
  if (needsCosign(row, record) && !row.cosigned) return 'needsCosign';
  return 'due';
}

/** Whether a row needs a co-signature: the row's own reading of the release
 *  rule (Codex #3489 r2), or, when that read failed, the account's co-sign
 *  setting (the release itself still enforces the full rule). */
export function needsCosign(
  row: { needsCosign?: boolean | null },
  record: Pick<ProtectedAccountRecord, 'requireCosign'>,
): boolean {
  return row.needsCosign ?? record.requireCosign;
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
  // `account` is whose vault holds it; only that account's manager (its
  // controller once it is retired) can withdraw it.
  | { kind: 'held'; account: string }
  | { kind: 'inVault'; account: string };

/**
 * EVERY outcome the receipt shows for payments to `account` (out of
 * `source`'s vault, the account's own when omitted), distinct and in a fixed
 * order: queued rows (one per recipient), payments held in the vault,
 * payments credited to the vault. Empty means the wallet was paid. A
 * transaction can carry several (a claim batch whose queue fills part-way,
 * or a claim paying more than one asset), and each needs saying.
 */
export function payoutOutcomes(
  logs: readonly Log[],
  account: string | undefined,
  source?: string,
): PayoutOutcome[] {
  // The gate's events name the PAYING account (`source`, the recipient's own
  // when omitted); a vault credit names the recipient.
  const accounts = [account, source].filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase());
  const mine = (eventName: 'PayoutHeldInVault' | 'PayoutQueued' | 'PaymentCreditedToVault') =>
    parseEventLogs({ abi: DIAMOND_ABI_VIEM, eventName, logs: logs as Log[] }).filter(
      (e) =>
        accounts.length === 0 ||
        accounts.includes(String((e.args as { account?: string }).account ?? '').toLowerCase()),
    );
  const out: PayoutOutcome[] = [];
  const recipients = new Set(
    mine('PayoutQueued').map((e) =>
      String((e.args as { recipient?: string }).recipient ?? account ?? '').toLowerCase(),
    ),
  );
  for (const recipient of recipients) out.push({ kind: 'queued', recipient });
  const holders = (eventName: 'PayoutHeldInVault' | 'PaymentCreditedToVault') =>
    new Set(mine(eventName).map((e) => String((e.args as { account?: string }).account ?? '').toLowerCase()));
  for (const a of holders('PayoutHeldInVault')) out.push({ kind: 'held', account: a });
  for (const a of holders('PaymentCreditedToVault')) out.push({ kind: 'inVault', account: a });
  return out;
}

/** One outcome for a transaction that pays a single row (an owner's own
 *  withdrawal): held, else queued, else credited, else paid. */
export function payoutOutcome(
  logs: readonly Log[],
  account: string | undefined,
  source?: string,
): PayoutOutcome {
  const all = payoutOutcomes(logs, account, source);
  return all.find((o) => o.kind === 'held') ?? all.find((o) => o.kind === 'queued') ?? all[0] ?? { kind: 'paid' };
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
  // `manager` is set when someone other than the recipient manages the
  // vault it stays in (a retired account's controller): only they can
  // withdraw it.
  | { kind: 'vault'; manager: string | null }
  // Paid out of ANOTHER account's vault (a transferred position whose
  // assets sit in the recorded party's vault): the vault layer credits a
  // protected recipient's own vault instead and queues nothing, so the
  // owner withdraws it separately.
  | { kind: 'creditedToVault'; manager: string | null };

type RouteSnap = Pick<ProtectedAccountSnapshot, 'supported' | 'recordFailed' | 'record' | 'payouts' | 'transfers'>;

/** One account as the route rule reads it: its address and its snapshot. */
export interface RouteAccount {
  address?: string;
  snap: RouteSnap | undefined;
  readFailed: boolean;
}

/** The controller of a retired account, when it is not `wallet`: the one
 *  who manages (and alone withdraws from) that account's vault. */
function managerOther(r: { retired: boolean; controller: string }, wallet: string | undefined): string | null {
  return r.retired && !sameAddress(r.controller, wallet) ? r.controller : null;
}

const sameAddress = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** The payout gate of `account` for a payment it makes to its own wallet or
 *  to its controller: wallet (mode off), held in the vault (locked or full),
 *  or queued, paid to the controller once the account is retired. */
function gateRoute(account: RouteAccount, recipient: string | undefined, rowsAhead = 0): OwnPayoutRoute {
  const { snap, readFailed } = account;
  if (!snap || readFailed) return { kind: 'unread' };
  if (!snap.supported) return { kind: 'wallet' };
  if (snap.recordFailed || snap.record === null) return { kind: 'unread' };
  const r = snap.record;
  if (!r.enabled) return { kind: 'wallet' };
  const to = managerOther(r, recipient);
  if (r.locked) return { kind: 'vault', manager: to };
  if (snap.payouts === null || snap.transfers === null) return { kind: 'unread' };
  if (snap.payouts.length + snap.transfers.length + rowsAhead >= MAX_OPEN_ROWS) return { kind: 'vault', manager: to };
  return { kind: 'queued', delaySeconds: r.delaySeconds, cosign: r.requireCosign, to };
}

/**
 * Where a payment out of `source`'s vault to `recipient`'s wallet lands, in
 * the contract's order. `source` is the account whose vault pays (a loan
 * claim pays from the recorded lender's or borrower's vault); omitted, it is
 * the recipient itself.
 *  1. The SOURCE account's payout gate catches a payment to its own wallet or
 *     to its controller (a replacement controller claiming a position the
 *     retired account still records): wallet, queued in that account, or
 *     held in its vault.
 *  2. Otherwise the vault layer credits a protected recipient's own vault,
 *     queueing nothing.
 *  3. Otherwise the wallet is paid.
 */
export function payoutRoute(
  recipient: RouteAccount,
  source?: RouteAccount,
  rowsAhead: (account: string | undefined) => number = () => 0,
): OwnPayoutRoute {
  const gate = gateAccount(recipient, source);
  if (gate === 'unread') return { kind: 'unread' };
  if (gate) return gateRoute(gate, recipient.address, rowsAhead(gate.address));
  const r = recipient.snap;
  if (!r || recipient.readFailed) return { kind: 'unread' };
  if (!r.supported) return { kind: 'wallet' };
  if (r.recordFailed || r.record === null) return { kind: 'unread' };
  if (!r.record.enabled) return { kind: 'wallet' };
  return { kind: 'creditedToVault', manager: managerOther(r.record, recipient.address) };
}

/**
 * Whose payout gate a payment out of `source`'s vault to `recipient` passes
 * through: the recipient's own when it pays itself, the source's when the
 * recipient is its controller, none when the payment is cross-account (the
 * vault layer then decides), or 'unread' when the source cannot be read.
 * The batch preview uses it to count the queue rows its earlier legs take.
 */
export function gateAccount(recipient: RouteAccount, source?: RouteAccount): RouteAccount | null | 'unread' {
  if (!source || !source.address || !recipient.address || sameAddress(source.address, recipient.address)) {
    return recipient;
  }
  const s = source.snap;
  if (!s || source.readFailed) return 'unread';
  if (s.supported && (s.recordFailed || s.record === null)) return 'unread';
  if (s.supported && s.record?.enabled && sameAddress(s.record.controller, recipient.address)) return source;
  return null;
}

/** Who manages each read account's vault, for `wallet`'s outcome text: the
 *  controller of a retired account when it is not `wallet`, else null. */
export function vaultManagerLookup(accounts: readonly RouteAccount[], wallet: string | undefined) {
  return (account: string): string | null => {
    const a = accounts.find((x) => sameAddress(x.address, account));
    const r = a?.snap?.record;
    return r ? managerOther(r, wallet) : null;
  };
}

/** A payment out of the account's own vault (or by the protocol) to its own
 *  wallet. */
export function ownPayoutRoute(snap: RouteSnap | undefined, readFailed: boolean): OwnPayoutRoute {
  return gateRoute({ snap, readFailed }, undefined);
}

/** The connected wallet's payout route, read live, for a payment out of
 *  `source`'s vault (the wallet's own when omitted). */
export function useOwnPayoutRoute(source?: string): OwnPayoutRoute {
  const { address } = useActiveChain();
  const other = source && !sameAddress(source, address) ? (source as `0x${string}`) : undefined;
  const [mine, theirs] = useProtectedAccounts([address ?? undefined, other]);
  return payoutRoute(
    { address: address ?? undefined, snap: mine.data, readFailed: mine.isError },
    other ? { address: other, snap: theirs.data, readFailed: theirs.isError } : undefined,
  );
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
  const { address } = useActiveChain();
  const options = useProtectedAccountQueryOptions();
  return useQuery(options(account ?? address ?? undefined));
}

/** Several accounts' snapshots at once (one query each, shared cache with
 *  {useProtectedAccount}), in the order given. */
export function useProtectedAccounts(accounts: readonly (`0x${string}` | undefined)[]) {
  const options = useProtectedAccountQueryOptions();
  return useQueries({ queries: accounts.map((a) => options(a)) });
}

function useProtectedAccountQueryOptions() {
  const { walletChain, onSupportedChain } = useActiveChain();
  const chainId = walletChain?.chainId;
  const publicClient = usePublicClient({ chainId });
  return (target: `0x${string}` | undefined) => ({
    queryKey: ['protectedAccount', chainId, target?.toLowerCase()],
    enabled: Boolean(publicClient) && Boolean(target) && onSupportedChain && Boolean(walletChain?.diamondAddress),
    refetchInterval: 30_000,
    queryFn: async (): Promise<ProtectedAccountSnapshot> => {
      const diamond = walletChain!.diamondAddress;
      const surface = walletChain!.positionNft;
      const legacy = surface.mode === 'legacy';
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
      // TODO(#3321 positionNft-legacy-removal): the legacy queue reads.
      const readLegacy = <T,>(functionName: string, args: readonly unknown[]) =>
        publicClient!.readContract({
          address: diamond,
          abi: LEGACY_DIAMOND_NFT_ABI,
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
        vault: null,
        recordFailed: false,
        record: null,
        signers: null,
        allowlist: null,
        pendingAllowlist: null,
        pendingSigners: null,
        payouts: null,
        transfers: null,
        nftMode: surface.mode,
        holderLock: null,
        replacement: null,
        escapeOpen: null,
        delayBounds: null,
        chainNowSec: block.timestamp,
        fetchedAtMs,
      };

      // #3379 B2: the record is the vault's; the Diamond names the vault and
      // holds the co-sign setting.
      const readVault = <T,>(vault: `0x${string}`, functionName: string, args: readonly unknown[] = []) =>
        publicClient!.readContract({
          address: vault,
          abi: VaipakamVaultImplementationABI,
          functionName,
          args: args as unknown[],
          blockNumber: block.number,
        }) as Promise<T>;
      // The vault views not yet in the exported ABI (inline fragments).
      const readVaultViews = <T,>(vault: `0x${string}`, functionName: 'protectionPending' | 'replacementTally') =>
        publicClient!.readContract({
          address: vault,
          abi: VAULT_PROTECTION_VIEWS_ABI,
          functionName,
          blockNumber: block.number,
        }) as Promise<T>;
      let protection: DiamondProtection;
      try {
        protection = await read<DiamondProtection>('getProtection', [target]);
      } catch (e) {
        if (isMissingSelectorError(e)) return { ...base, supported: false };
        return { ...base, recordFailed: true };
      }
      const vault = protection[0].toLowerCase() === ZERO ? null : protection[0];
      let state: VaultProtectionState | null = null;
      let owner: `0x${string}` | null = null;
      let pendingSettings: VaultProtectionPending | null = null;
      if (vault !== null) {
        try {
          [state, owner, pendingSettings] = await Promise.all([
            readVault<VaultProtectionState>(vault, 'protectionState'),
            readVault<`0x${string}`>(vault, 'vaultOwner'),
            readVaultViews<VaultProtectionPending>(vault, 'protectionPending'),
          ]);
        } catch {
          return { ...base, vault, recordFailed: true };
        }
      }
      // NFT protection's Diamond queue was retired (#3318): it reads off.
      const record: ProtectedAccountRecord = protectedAccountFromVault(target!, protection, state, owner, pendingSettings);
      const signerAddrs: `0x${string}`[] | null = state ? [...state[5]] : vault === null ? [] : null;
      const allowlist: `0x${string}`[] | null = state ? [...state[6]] : vault === null ? [] : null;

      const none = <T,>(v: T) => Promise.resolve(v);
      const [payoutIds, transferIds, holderLockRaw, repl, escapeOpen, bounds, pending, tally] = await Promise.all([
        soft(read<bigint[]>('getPendingPayoutIds', [target])),
        // Standalone mode has no NFT queue: an empty list, not an unread one.
        legacy ? soft(readLegacy<bigint[]>('getPendingTransferIds', [target])) : Promise.resolve([] as bigint[]),
        legacy
          ? Promise.resolve(null)
          : soft(
              publicClient!.readContract({
                address: surface.nft,
                abi: POSITION_NFT_ABI,
                functionName: 'lockOf',
                args: [target!],
                blockNumber: block.number,
              }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
            ),
        vault === null
          ? none([ZERO, ZERO, 0n, 0] as unknown as readonly [`0x${string}`, `0x${string}`, bigint, number])
          : soft(readVault<readonly [`0x${string}`, `0x${string}`, bigint, number]>(vault, 'replacementProposal')),
        soft(read<boolean>('isEscapeOpen')),
        soft(read<readonly [bigint, bigint]>('getProtectedDelayBounds')),
        vault === null
          ? none([[], []] as unknown as readonly [readonly `0x${string}`[], readonly `0x${string}`[]])
          : soft(readVault<readonly [readonly `0x${string}`[], readonly `0x${string}`[]]>(vault, 'pendingAdditions')),
        vault === null ? none([0n, 0n] as VaultReplacementTally) : soft(readVaultViews<VaultReplacementTally>(vault, 'replacementTally')),
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
                readVault<{ addAt: bigint; accepted: boolean; removeAt: bigint }>(vault!, 'signerEntry', [signer]),
              );
              return c ? { signer, removeAt: c.removeAt } : null;
            }),
          )
        : null;

      // Each pending addition's timing is in its vault entry.
      const pendAllow = pending
        ? await all(
            pending[0].map(async (address) => {
              const e = await soft(readVault<{ readyAt: bigint }>(vault!, 'allowEntry', [address]));
              return e ? { address, at: BigInt(e.readyAt) } : null;
            }),
          )
        : null;
      const pendSign = pending
        ? await all(
            pending[1].map(async (address) => {
              const e = await soft(readVault<{ addAt: bigint; accepted: boolean }>(vault!, 'signerEntry', [address]));
              return e ? { address, at: BigInt(e.addAt), accepted: e.accepted } : null;
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
              const needs = await soft(read<boolean>('payoutNeedsCosign', [id]));
              return {
                id,
                needsCosign: needs,
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
                readLegacy<{ from: string; state: number; cosigned: boolean; releaseAt: bigint; to: `0x${string}`; tokenId: bigint }>(
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
        vault,
        record: {
          ...record,
          delaySeconds: Number(record.delaySeconds),
          pendingDelay: Number(record.pendingDelay),
        },
        signers,
        allowlist,
        pendingAllowlist: pendAllow,
        pendingSigners: pendSign,
        payouts: payouts?.sort((a, b) => (a.releaseAt < b.releaseAt ? -1 : 1)) ?? null,
        transfers,
        holderLock: holderLockRaw
          ? {
              locked: holderLockRaw[0],
              delay: BigInt(holderLockRaw[1]),
              unlockAt: BigInt(holderLockRaw[2]),
              lowerDelay: BigInt(holderLockRaw[3]),
              lowerAt: BigInt(holderLockRaw[4]),
            }
          : null,
        replacement: repl && tally
          ? {
              nominee: repl[0],
              proposedBy: repl[1],
              readyAt: BigInt(repl[2]),
              round: Number(repl[3]),
              approvals: Number(tally[0]),
              threshold: Number(tally[1]),
            }
          : null,
        escapeOpen,
        delayBounds: bounds ? { min: Number(bounds[0]), max: Number(bounds[1]) } : null,
      };
    },
  });
}

/**
 * Every retired account the connected wallet now manages (it became each
 * one's controller through a replacement; a wallet may manage several), or
 * an empty list. Undefined while unread; a failed read is an error state,
 * never "none".
 */
export function useRetiredAccountsOf() {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const chainId = walletChain?.chainId;
  const publicClient = usePublicClient({ chainId });
  return useQuery({
    queryKey: ['protectedAccount', 'retiredAccountsOf', chainId, address?.toLowerCase()],
    enabled: Boolean(publicClient) && Boolean(address) && onSupportedChain && Boolean(walletChain?.diamondAddress),
    queryFn: async (): Promise<readonly `0x${string}`[]> => {
      try {
        return (await publicClient!.readContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getRetiredAccountsOf',
          args: [address],
        })) as readonly `0x${string}`[];
      } catch (e) {
        if (isMissingSelectorError(e)) return [];
        throw e;
      }
    },
  });
}
