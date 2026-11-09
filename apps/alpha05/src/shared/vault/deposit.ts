/**
 * ACC-22 — deposit one asset into the wallet's own vault, outside any loan.
 * What the review stands on is read through the wallet's connection, at one
 * block where the chain allows: the wallet's vault (a deposit creates it when
 * there is none), the protocol pause (a deposit is closed under it), the
 * wallet's standing with the sanctions screen, whether the wallet was retired
 * by a replacement (a retired wallet funds nothing), the account's protected
 * mode (which decides how what is deposited can leave again), and the
 * wallet's own holding of the asset with the approval it has given the
 * protocol.
 *
 * The protocol pulls exactly the amount and refuses a token that does not
 * arrive in full, so a fee-on-transfer token is refused by the protocol's own
 * dry run, which runs once the approval is in place. Nothing a deposit adds
 * is pledged: it is counted as the wallet's. How it leaves again is the
 * account's protected mode's to say: at once without the mode, after the
 * account's delay with it, and not at all while the account is locked (the
 * protocol still takes a deposit then), so the review states which.
 */
import { erc20Abi, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI, ProtectedAccountFacetABI, VaultDepositoryFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { ASSET_TYPE, diamondMayMove, holds, readErc1155, readErc721, type Erc1155State, type Erc721State, type Standard } from '../nft/nft';
import { tokenAcceptsApproval } from '../offers/reads';
import { answerOrNull } from '../reads/answer';
import { frozenState, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import { allowanceSteps } from '../tx/approval';
import { payoutRoute, protectionFrom, type PayoutRoute, type ProtectedAccountAnswer, type Protection } from '../protection/payout';
import { routeChanged } from '../protection/payoutCopy';
import { readVpfiFacts, type VpfiFacts } from '../rewards/vpfiFacts';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const FACTORY = VaultFactoryFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const PROTECTED = ProtectedAccountFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** What the reader chose: the asset, its standard as its contract claims,
 *  the token id (zero for an ERC-20) and the amount (one for an ERC-721). */
export interface DepositDraft {
  standard: Standard;
  asset: Hex;
  tokenId: bigint;
  amount: bigint;
}

export type DepositHolding =
  | { kind: 'erc20'; balance: bigint; allowance: bigint; approvalSteps: number }
  | { kind: 'erc721'; state: Erc721State; approvalSteps: number }
  | { kind: 'erc1155'; state: Erc1155State; approvalSteps: number };

export interface DepositReview {
  identity: string;
  draft: DepositDraft;
  /** The wallet's vault; null when it has none yet (the deposit creates it). */
  vault: Hex | null;
  /** The protocol pause; null when unread (the dry run then decides). */
  paused: boolean | null;
  frozen: FrozenState;
  /** Whether a replacement retired this wallet; null when unread. */
  retired: boolean | null;
  /** The account's protected mode; null when unread. */
  protection: Protection | null;
  holding: DepositHolding;
  /** The fee-discount tier's side when the asset is this network's VPFI;
   *  null for any other asset. */
  vpfi: VpfiFacts | null;
  readAt: number;
}

/** The call a draft stands for. */
export function depositCall(d: DepositDraft) {
  return {
    abi: DEPOSITORY,
    functionName: 'depositToVault' as const,
    args: [ASSET_TYPE[d.standard], d.asset, d.standard === 'erc20' ? 0n : d.tokenId, d.standard === 'erc721' ? 1n : d.amount] as const,
  };
}

export async function readDepositReview(own: OwnStateClient, diamond: Hex, draft: DepositDraft, identity: string): Promise<DepositReview> {
  const account = own.account;
  const facts = await own
    .read(async (c: PublicClient) => {
      const block = await c.getBlockNumber({ cacheTime: 0 });
      const at = { blockNumber: block };
      const [vault, paused, posture, account_] = await Promise.all([
        c.readContract({ address: diamond, abi: FACTORY, functionName: 'getUserVaultAddress', args: [account], ...at }) as Promise<Hex>,
        answerOrNull(c.readContract({ address: diamond, abi: ADMIN, functionName: 'paused', ...at }) as Promise<boolean>),
        readSanctionsPosture(c, diamond, account, block),
        answerOrNull(c.readContract({ address: diamond, abi: PROTECTED, functionName: 'getProtectedAccount', args: [account], ...at }) as Promise<ProtectedAccountAnswer>),
      ]);
      let holding: DepositHolding;
      // An ERC-721 token needs one approval for that token unless the
      // protocol may already move it; an ERC-1155 collection needs the
      // operator approval, granted for this deposit and taken back after it,
      // unless the wallet had already granted it (left as the wallet set it).
      if (draft.standard === 'erc721') {
        const state = await readErc721(c, draft.asset, draft.tokenId, account, diamond, block);
        holding = { kind: 'erc721', state, approvalSteps: diamondMayMove(state, diamond) ? 0 : 1 };
      } else if (draft.standard === 'erc1155') {
        const state = await readErc1155(c, draft.asset, draft.tokenId, account, diamond, block);
        holding = { kind: 'erc1155', state, approvalSteps: state.approvedForAll ? 0 : 2 };
      } else {
        const [balance, allowance] = await Promise.all([
          c.readContract({ address: draft.asset, abi: erc20Abi, functionName: 'balanceOf', args: [account], ...at }),
          c.readContract({ address: draft.asset, abi: erc20Abi, functionName: 'allowance', args: [account, diamond], ...at }),
        ]);
        holding = { kind: 'erc20', balance, allowance, approvalSteps: 0 };
      }
      const protection = protectionFrom(account_);
      const vpfi = draft.standard === 'erc20' ? await readVpfiFacts(c, diamond, account, draft.asset, block) : null;
      return {
        vpfi,
        vault: vault.toLowerCase() === ZERO ? null : vault,
        paused,
        frozen: frozenState(posture),
        retired: account_ === null ? null : account_.retired,
        protection,
        holding,
      };
    })
    .then((x) => x.value);
  let holding = facts.holding;
  // The deposit pulls exactly the amount: a standing approval that covers it
  // is left alone, and a smaller one is raised to exactly the amount.
  if (holding.kind === 'erc20' && holding.allowance < draft.amount) {
    const h = holding;
    const steps = await allowanceSteps(
      { accepts: (v) => own.read((c) => tokenAcceptsApproval(c, draft.asset, account, diamond, v)).then((x) => x.value) },
      h.allowance,
      draft.amount,
    );
    holding = { ...h, approvalSteps: steps.length };
  }
  return { identity, draft, vault: facts.vault, paused: facts.paused, frozen: facts.frozen, retired: facts.retired, protection: facts.protection, holding, vpfi: facts.vpfi, readAt: Date.now() };
}

/** How what this deposit adds can leave the vault for the wallet later:
 *  at once, after the account's delay, not while the account is locked, or
 *  unknown when the mode was not read. */
export function withdrawRoute(protection: Protection | null): PayoutRoute {
  // A withdrawal pays the account from its own vault, so the source is the
  // account itself and only the mode decides the route.
  return payoutRoute(protection, ZERO, ZERO);
}

/** The wallet prompts the deposit takes: the approval's, then the deposit. */
export const depositPromptCount = (r: DepositReview): number => r.holding.approvalSteps + 1;

/** What the wallet holds of the chosen asset short of the draft, in the
 *  asset's own unit; null when it holds enough. An ERC-721 token the wallet
 *  does not hold reads as 1 short. */
export function depositShort(r: DepositReview, account: Hex): bigint | null {
  const h = r.holding;
  if (h.kind === 'erc20') return h.balance >= r.draft.amount ? null : r.draft.amount - h.balance;
  if (h.kind === 'erc721') return holds(h.state, account) ? null : 1n;
  return h.state.balance >= r.draft.amount ? null : r.draft.amount - h.state.balance;
}

/** What stops the review, in words (empty when nothing does), most
 *  fundamental first. `shortText` names an ERC-20 or ERC-1155 shortfall. */
export function depositBlockers(r: DepositReview, account: Hex, copy: Copy, shortText: (short: bigint) => string): string[] {
  const { text } = copy;
  if (r.paused === true) return [text('vaultDeposit.paused')];
  if (r.frozen === 'flagged') return [text('vaultDeposit.flagged')];
  if (r.retired === true) return [text('vaultDeposit.retired')];
  const h = r.holding;
  if (h.kind === 'erc721') {
    if (h.state.owner === null) return [text('vaultDeposit.noToken')];
    if (!holds(h.state, account)) return [text('vaultDeposit.notHeld')];
    return [];
  }
  const short = depositShort(r, account);
  return short === null ? [] : [shortText(short)];
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function depositChanged(a: DepositReview, b: DepositReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if ((a.vault ?? '').toLowerCase() !== (b.vault ?? '').toLowerCase()) return text('vaultDeposit.changedVault');
  if (a.paused !== b.paused || a.frozen !== b.frozen || a.retired !== b.retired) return text('repay.changedVerdict');
  if (routeChanged({ route: withdrawRoute(a.protection), protection: a.protection }, { route: withdrawRoute(b.protection), protection: b.protection }))
    return text('payout.changed');
  const x = a.holding;
  const y = b.holding;
  if (x.kind !== y.kind || x.approvalSteps !== y.approvalSteps) return text('repay.changedFunds');
  if (x.kind === 'erc20' && y.kind === 'erc20' && x.balance >= a.draft.amount !== y.balance >= b.draft.amount) return text('repay.changedFunds');
  if (x.kind === 'erc20' && y.kind === 'erc20' && x.allowance !== y.allowance) return text('repay.changedFunds');
  if (x.kind === 'erc721' && y.kind === 'erc721' && (x.state.owner ?? '').toLowerCase() !== (y.state.owner ?? '').toLowerCase()) return text('repay.changedFunds');
  if (x.kind === 'erc1155' && y.kind === 'erc1155' && x.state.balance >= a.draft.amount !== y.state.balance >= b.draft.amount) return text('repay.changedFunds');
  if ((a.vpfi?.consent ?? null) !== (b.vpfi?.consent ?? null)) return text('rewardsVault.changedConsent');
  return null;
}

/** The deposit the transaction's record names for `account`: the asset,
 *  token id and amount the protocol credited, or null when it names none. */
export function deposited(logs: readonly Log[], diamond: Hex, account: Hex, d: DepositDraft): bigint | null {
  const events = parseEventLogs({ abi: DEPOSITORY, logs: logs as Log[], eventName: 'VaultDeposited', strict: false });
  for (const e of events) {
    if (e.address.toLowerCase() !== diamond.toLowerCase()) continue;
    const args = e.args as { account?: Hex; asset?: Hex; kind?: number | bigint; tokenId?: bigint; amount?: bigint };
    if (args.account?.toLowerCase() !== account.toLowerCase() || args.asset?.toLowerCase() !== d.asset.toLowerCase()) continue;
    if (Number(args.kind) !== ASSET_TYPE[d.standard]) continue;
    if (d.standard !== 'erc20' && args.tokenId !== d.tokenId) continue;
    if (args.amount !== undefined) return args.amount;
  }
  return null;
}
