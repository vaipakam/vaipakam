/**
 * ACC-23 — withdraw what is free in the wallet's own vault, back to that
 * wallet. What the review stands on is read through the wallet's connection,
 * at one block where the chain allows: the wallet's vault, the protocol
 * pause and whether the escape route is open under it, the wallet's standing
 * with the sanctions screen, the account's protected mode (whether a
 * replacement retired the wallet, whether the mode is on, the lock, the
 * delay and the secondary signer), and the protocol's own figure for what
 * this wallet may withdraw now (`withdrawableNow`: the deposit record's
 * holding, never more than what no loan, offer, claim, standing offer or
 * queued payout holds). Then the protocol's dry run of this very withdrawal.
 *
 * The protocol pays a wallet without protected mode at once. With the mode
 * on it queues the payout for the account's delay (`LibProtectedAccount.
 * queuePayout`), refuses it while the account is locked, and refuses it when
 * the account's queue is full; it also stays open during a pause for a
 * protected account once the escape route has opened. The app withdraws to
 * the connected wallet only: the protocol would pay any address it screens
 * for an account without the mode, and the app does not offer one, so the
 * destination is always the wallet that signs.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, ProtectedAccountFacetABI, VaultDepositoryFacetABI, VaultFactoryFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { ASSET_TYPE, type Standard } from '../nft/nft';
import { payoutRoute, type PayoutRoute, type Protection } from '../protection/payout';
import { routeChanged } from '../protection/payoutCopy';
import { answerOrNull } from '../reads/answer';
import { frozenState, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import { askThrough } from '../tx/simulate';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const FACTORY = VaultFactoryFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const PROTECTED = ProtectedAccountFacetABI as Abi;
const PAYOUT = VaultPayoutFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** What the withdrawal is opened for: an ERC-20 (token id 0), one NFT
 *  token, or an NFT collection whose token the reader names (token id null:
 *  the deposit record keeps no token ids). */
export interface WithdrawSubject {
  standard: Standard;
  asset: Hex;
  tokenId: bigint | null;
}

/** What the reader chose: the asset, the token, and how much of it (one
 *  for an ERC-721). */
export interface WithdrawDraft {
  standard: Standard;
  asset: Hex;
  tokenId: bigint;
  amount: bigint;
}

export interface WithdrawReview {
  identity: string;
  draft: WithdrawDraft;
  /** The wallet's vault; null when it has none. */
  vault: Hex | null;
  /** The protocol pause; null when unread. */
  paused: boolean | null;
  /** Whether the escape route is open under the pause; null when unread. */
  escapeOpen: boolean | null;
  frozen: FrozenState;
  /** Whether a replacement retired this wallet; null when unread. */
  retired: boolean | null;
  /** The account's protected mode; null when unread. */
  protection: Protection | null;
  /** Where the withdrawal goes: the wallet at once, the account's payout
   *  queue, kept back while the account is locked (refused), or unknown. */
  route: PayoutRoute;
  /** The protocol's figure for what this wallet may withdraw now; null when
   *  unread. */
  withdrawable: bigint | null;
  /** The protocol's dry run of this withdrawal: null when it passes, its
   *  refusal when it refuses, 'unread' when it could not be run. Asked only
   *  when nothing the app reads already stops it. */
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

/** The call a draft stands for: from the wallet's own vault, to the wallet. */
export function withdrawCall(d: WithdrawDraft, account: Hex) {
  return {
    abi: DEPOSITORY,
    functionName: 'withdrawFromVault' as const,
    args: [account, ASSET_TYPE[d.standard], d.asset, d.standard === 'erc20' ? 0n : d.tokenId, d.standard === 'erc721' ? 1n : d.amount, account] as const,
  };
}

/** The amount a draft takes, in the asset's own unit. */
export const withdrawAmount = (d: WithdrawDraft): bigint => (d.standard === 'erc721' ? 1n : d.amount);

export async function readWithdrawReview(own: OwnStateClient, diamond: Hex, draft: WithdrawDraft, identity: string, copy: Copy): Promise<WithdrawReview> {
  const account = own.account;
  const facts = await own
    .read(async (c: PublicClient) => {
      const block = await c.getBlockNumber({ cacheTime: 0 });
      const at = { blockNumber: block };
      const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
        answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
      const [vault, paused, escapeOpen, posture, mode, withdrawable] = await Promise.all([
        c.readContract({ address: diamond, abi: FACTORY, functionName: 'getUserVaultAddress', args: [account], ...at }) as Promise<Hex>,
        read<boolean>(ADMIN, 'paused'),
        read<boolean>(PAYOUT, 'isEscapeOpen'),
        readSanctionsPosture(c, diamond, account, block),
        read<{ retired: boolean; enabled: boolean; locked: boolean; delaySeconds: number | bigint; requireCosign: boolean }>(PROTECTED, 'getProtectedAccount', [account]),
        read<bigint>(DEPOSITORY, 'withdrawableNow', [account, ASSET_TYPE[draft.standard], draft.asset, draft.standard === 'erc20' ? 0n : draft.tokenId]),
      ]);
      const protection: Protection | null =
        mode === null ? null : { enabled: mode.enabled, locked: mode.locked, delaySeconds: Number(mode.delaySeconds), requireCosign: mode.requireCosign };
      return {
        vault: vault.toLowerCase() === ZERO ? null : vault,
        paused,
        escapeOpen,
        frozen: frozenState(posture),
        retired: mode === null ? null : mode.retired,
        protection,
        withdrawable,
      };
    })
    .then((x) => x.value);
  const base: WithdrawReview = { identity, draft, ...facts, route: payoutRoute(facts.protection, account, account), dryRun: null, readAt: Date.now() };
  if (withdrawBlockers(base, copy, () => '').length > 0) return base;
  const call = withdrawCall(draft, account);
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

/** Whether the pause stops this withdrawal: it does unless the account runs
 *  protected mode and the escape route is open; null when that is unread. */
export function pauseStops(r: Pick<WithdrawReview, 'paused' | 'escapeOpen' | 'protection'>): boolean | null {
  if (r.paused === false) return false;
  if (r.paused === null) return null;
  if (r.protection === null || r.escapeOpen === null) return null;
  return !(r.protection.enabled && r.escapeOpen);
}

/** What stops the review, in words (empty when nothing does), most
 *  fundamental first. `amountText` names an amount of the asset. */
export function withdrawBlockers(r: WithdrawReview, copy: Copy, amountText: (v: bigint) => string): string[] {
  const { text, format } = copy;
  if (r.vault === null) return [text('vaultWithdraw.noVault')];
  if (r.retired === true) return [text('vaultWithdraw.retired')];
  if (r.frozen === 'flagged') return [text('vaultWithdraw.flagged')];
  if (pauseStops(r) === true) return [text('vaultWithdraw.paused')];
  if (r.route === 'held') return [text('vaultWithdraw.locked')];
  const want = withdrawAmount(r.draft);
  if (r.withdrawable !== null && want > r.withdrawable)
    return [r.withdrawable === 0n ? text('vaultWithdraw.nothingFree') : format('vaultWithdraw.overFree', { free: amountText(r.withdrawable) })];
  if (r.dryRun !== null && r.dryRun !== 'unread') return [format('vaultWithdraw.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function withdrawChanged(a: WithdrawReview, b: WithdrawReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if ((a.vault ?? '').toLowerCase() !== (b.vault ?? '').toLowerCase()) return text('vaultWithdraw.changedVault');
  if (a.paused !== b.paused || a.escapeOpen !== b.escapeOpen || a.frozen !== b.frozen || a.retired !== b.retired) return text('repay.changedVerdict');
  if (routeChanged(a, b)) return text('payout.changed');
  const want = withdrawAmount(a.draft);
  const fits = (r: WithdrawReview) => (r.withdrawable === null ? null : r.withdrawable >= want);
  if (fits(a) !== fits(b)) return text('repay.changedFunds');
  if (a.withdrawable !== b.withdrawable) return text('vaultWithdraw.changedFree');
  if ((a.dryRun === null) !== (b.dryRun === null) || (a.dryRun === 'unread') !== (b.dryRun === 'unread')) return text('repay.changedVerdict');
  return null;
}

/** The withdrawal the transaction's record names for `account`: the amount
 *  asked for and whether the protocol queued it, or null when it names
 *  none. */
export function withdrawRequested(logs: readonly Log[], diamond: Hex, account: Hex, d: WithdrawDraft): { amount: bigint; queued: boolean } | null {
  const events = parseEventLogs({ abi: DEPOSITORY, logs: logs as Log[], eventName: 'VaultWithdrawRequested', strict: false });
  for (const e of events) {
    if (e.address.toLowerCase() !== diamond.toLowerCase()) continue;
    const args = e.args as { account?: Hex; asset?: Hex; kind?: number | bigint; tokenId?: bigint; amount?: bigint; recipient?: Hex; queued?: boolean };
    if (args.account?.toLowerCase() !== account.toLowerCase() || args.asset?.toLowerCase() !== d.asset.toLowerCase()) continue;
    if (Number(args.kind) !== ASSET_TYPE[d.standard]) continue;
    if (d.standard !== 'erc20' && args.tokenId !== d.tokenId) continue;
    if (args.recipient?.toLowerCase() !== account.toLowerCase()) continue;
    if (args.amount !== undefined) return { amount: args.amount, queued: args.queued === true };
  }
  return null;
}
