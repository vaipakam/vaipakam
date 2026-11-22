/**
 * #3771 — Give this loan (FeaturesOverExistingPartsDesign.md §4): the holder
 * of a loan's lender position sends that position token to another wallet.
 * Nothing new runs on chain: it is the position token's own transfer, with
 * the protocol's transfer check unchanged.
 *
 * What the review reads, at one block, and why:
 * - the loan and who holds its lender side now: only that holder may give it;
 * - the open seller claims (`getInterestLedger`): interest is paid to an
 *   earlier seller first and a transfer does not remove a claim, so the amount
 *   still owed ahead of the holder is stated, or the review says it could not
 *   be read and states no figure for what the receiver gets;
 * - what the protocol already holds for the lender position out of payments
 *   made (`getClaimable(loanId, true).heldForLender`): the lender claim pays
 *   it, so it goes with the token;
 * - the fee discount that will apply to the receiver: the transfer records
 *   the lower of the figure the loan carries and the receiver's own standing
 *   (`stampLenderEntry` with `carryLower`), read from
 *   `lenderHoldDiscountView(loanId, receiver)`;
 * - the protocol's own verdict: the transfer is tried as a simulated call
 *   from the holder, and a refusal is shown with its reason (and, for the
 *   wait after value left the position, the time it lifts).
 */
import { decodeErrorResult, isAddress, type Abi, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM, LoanFacetABI, PositionNFTABI, SellerClaimFacetABI, VPFIDiscountAccumulatorFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { readSideClaim } from '../claims/loanClaimReview';
import { netOwed, type SellerClaimEntry } from '../claims/sellerClaim';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { holdFrom } from '../positions/lenderDiscount';
import { treasuryShareBps, type LoanDetails } from '../positions/loanView';
import { positionNftForDiamond, readLiveHolderOrNull } from '../positions/positionNft';
import { answerOrNull } from '../reads/answer';
import { askThrough } from '../tx/simulate';
import { formatUtc } from '../ui/format';

type Hex = `0x${string}`;

const NFT = PositionNFTABI as Abi;
const SELLER = SellerClaimFacetABI as Abi;
const ACCUMULATOR = VPFIDiscountAccumulatorFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
/** The token's refusals and the Diamond's transfer check's, in one table. */
const TRANSFER_ERRORS = [...NFT, ...(DIAMOND_ABI_VIEM as Abi)].filter((e) => e.type === 'error') as Abi;

/** `LibVaipakam.LoanStatus.Active`. */
const ACTIVE = 0;
const ZERO = '0x0000000000000000000000000000000000000000';

export type ReceiverProblem = 'empty' | 'invalid' | 'self' | 'contract-of-platform';

/** The receiver as typed: a wallet address that is not the giver's own, nor
 *  the platform's contracts. Whether it is a vault is the protocol's check. */
export function checkReceiver(raw: string, giver: Hex, diamond: Hex): { ok: true; receiver: Hex } | { ok: false; problem: ReceiverProblem } {
  const v = raw.trim();
  if (v === '') return { ok: false, problem: 'empty' };
  if (!isAddress(v, { strict: false }) || v.toLowerCase() === ZERO) return { ok: false, problem: 'invalid' };
  const lower = v.toLowerCase();
  if (lower === giver.toLowerCase()) return { ok: false, problem: 'self' };
  let nft: string | null = null;
  try {
    nft = positionNftForDiamond(diamond).nft.toLowerCase();
  } catch {
    nft = null;
  }
  if (lower === diamond.toLowerCase() || lower === nft) return { ok: false, problem: 'contract-of-platform' };
  return { ok: true, receiver: v as Hex };
}

/** The interest still owed to earlier sellers, ahead of the holder: each
 *  claim as recorded, and the total after the loan's own fee on interest
 *  (what the sellers receive out of later interest). */
export interface OwedAhead {
  claims: SellerClaimEntry[];
  gross: bigint;
  net: bigint;
}

export function owedAhead(claims: readonly SellerClaimEntry[], feeBps: number): OwedAhead {
  const gross = claims.reduce((s, c) => s + c.grossOwed, 0n);
  return { claims: [...claims], gross, net: netOwed(gross, feeBps) };
}

/** The fee discount the receiver will carry on this loan: the lower of the
 *  figure the loan records and the receiver's standing now. At each charge
 *  it is the lower of that and their standing then. */
export interface ReceiverDiscount {
  loanBps: number;
  receiverNowBps: number;
  appliesBps: number;
}

export function receiverDiscount(entryBps: number, receiverNowBps: number): ReceiverDiscount {
  return { loanBps: entryBps, receiverNowBps, appliesBps: Math.min(entryBps, receiverNowBps) };
}

export type DryRun = { kind: 'passes' } | { kind: 'refused'; refusal: Refusal } | { kind: 'unreadable'; reason: string };

export interface GiveReview {
  identity: string;
  loanId: bigint;
  receiver: Hex;
  loan: LoanDetails;
  tokenId: bigint;
  /** The live holder of the lender side; null when there is none. */
  holder: Hex | null;
  /** Null when the ledger could not be read: no figure for the receiver is
   *  then stated. */
  owed: OwedAhead | null;
  /** What the protocol holds for the lender position from payments made;
   *  null when unread. */
  heldForLender: bigint | null;
  /** 'absent' on a Diamond without the view; null when unread. */
  discount: ReceiverDiscount | 'absent' | null;
  dryRun: DryRun;
  block: bigint;
  readAt: number;
}

/** A refusal of the transfer, in the give flow's words where the reason is
 *  one the design names; the protocol's own reason otherwise. */
export function transferRefusal(err: unknown, copy: Pick<CopyAccess, 'text' | 'format'>): Refusal {
  const { text, format } = copy;
  const data = revertData(err);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: TRANSFER_ERRORS, data });
      const a = (d.args ?? []) as readonly unknown[];
      const r = (code: string, reason: string, reopensAt: number | null = null): Refusal => ({ code, reason, reopensAt, remedy: null });
      switch (d.errorName) {
        case 'PositionCoolingDown': {
          const readyAt = Number(a[2] as bigint);
          return r(d.errorName, readyAt > 0 ? format('give.refCooling', { time: formatUtc(readyAt) }) : text('give.refCoolingBlock'), readyAt > 0 ? readyAt * 1000 : null);
        }
        case 'PositionToVault':
          return r(d.errorName, text('give.refToVault'));
        case 'SanctionedAddress':
          return r(d.errorName, text('give.refFlagged'));
        case 'HolderIsLocked':
          return r(d.errorName, text('give.refLocked'));
        case 'TransferFromRecoveredAccount':
          return r(d.errorName, text('give.refRecovered'));
        case 'TransferFromRetiredAccount':
        case 'HolderRetired':
          return r(d.errorName, text('give.refReplaced'));
        default:
          break;
      }
    } catch {
      // Not one of the transfer's own errors: the general reading below.
    }
  }
  return refusalFromError(err);
}

function revertData(err: unknown): Hex | null {
  let e: unknown = err;
  for (let i = 0; i < 8 && e && typeof e === 'object'; i++) {
    const o = e as { data?: unknown; raw?: unknown; cause?: unknown };
    if (typeof o.raw === 'string' && o.raw.startsWith('0x')) return o.raw as Hex;
    if (typeof o.data === 'string' && o.data.startsWith('0x')) return o.data as Hex;
    e = o.cause;
  }
  return null;
}

/** Reads the review for giving `loanId`'s lender side from `own.account` to
 *  `receiver`. Every figure is read at one block; the dry run follows. */
export async function readGiveReview(
  own: OwnStateClient,
  diamond: Hex,
  loanId: bigint,
  receiver: Hex,
  identity: string,
  copy: Pick<CopyAccess, 'text' | 'format'>,
): Promise<GiveReview> {
  const read = await own.read(async (c: PublicClient) => {
    const block = await c.getBlockNumber();
    const at = { blockNumber: block };
    const loan = (await c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [loanId], ...at })) as LoanDetails;
    const [holder, ledger, side, view] = await Promise.all([
      readLiveHolderOrNull(c, diamond, loan.lenderTokenId, block),
      answerOrNull(c.readContract({ address: diamond, abi: SELLER, functionName: 'getInterestLedger', args: [loanId], ...at }) as Promise<readonly [bigint, bigint, unknown, readonly { seller: Hex; grossOwed: bigint }[]]>),
      readSideClaim(c, diamond, loanId, 'lender', at),
      c.readContract({ address: diamond, abi: ACCUMULATOR, functionName: 'lenderHoldDiscountView', args: [loanId, receiver], ...at }).then(
        (v) => ({ ok: true as const, v: holdFrom(v as Record<string, unknown>) }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
    ]);
    return { block, loan, holder, ledger, side, view };
  });
  const { block, loan, holder, ledger, side, view } = read.value;
  const fee = treasuryShareBps(loan).bps;
  const owed = ledger === null ? null : owedAhead(ledger[3].map((x) => ({ seller: x.seller, grossOwed: x.grossOwed })), fee);
  const discount = view.ok ? receiverDiscount(view.v.entryBps, view.v.nowBps) : isMissingRoute(view.e) ? 'absent' : null;
  const nft = positionNftForDiamond(diamond).nft;
  const account = own.account;
  const asked = await askThrough(own, (c) =>
    c.simulateContract({ address: nft, abi: NFT, functionName: 'safeTransferFrom', args: [account, receiver, loan.lenderTokenId], account }),
  );
  const dryRun: DryRun =
    asked.kind === 'answered' ? { kind: 'passes' } : asked.kind === 'reverted' ? { kind: 'refused', refusal: transferRefusal(asked.error, copy) } : { kind: 'unreadable', reason: asked.reason };
  return {
    identity,
    loanId,
    receiver,
    loan,
    tokenId: loan.lenderTokenId,
    holder,
    owed,
    heldForLender: side ? side.heldForLender : null,
    discount,
    dryRun,
    block,
    readAt: Date.now(),
  };
}

function isMissingRoute(e: unknown): boolean {
  return /FunctionDoesNotExist|0xa9ad62f8/.test(String((e as Error)?.message ?? e));
}

/** Why the give cannot be sent now, in order; empty when it can. */
export function giveBlockers(r: GiveReview, account: Hex, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const { text, format } = copy;
  const out: string[] = [];
  if (Number(r.loan.status) !== ACTIVE) out.push(text('give.blockNotRunning'));
  if (r.holder === null || r.holder.toLowerCase() !== account.toLowerCase()) out.push(text('give.blockNotHolder'));
  if (r.dryRun.kind === 'refused') out.push(format('give.blockRefused', { reason: r.dryRun.refusal.reason }));
  if (r.dryRun.kind === 'unreadable') out.push(format('flow.unreadable', { reason: r.dryRun.reason }));
  return out;
}

/** What changed between two reads that the review states, or null. */
export function giveChangedBetween(a: GiveReview, b: GiveReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  if ((a.holder ?? '').toLowerCase() !== (b.holder ?? '').toLowerCase()) return text('give.changedHolder');
  if ((a.owed?.gross ?? null) !== (b.owed?.gross ?? null)) return text('give.changedOwed');
  if (a.heldForLender !== b.heldForLender) return text('give.changedHeld');
  const d = (x: GiveReview['discount']) => (x === null || x === 'absent' ? x : x.appliesBps);
  if (d(a.discount) !== d(b.discount)) return text('give.changedDiscount');
  if (a.loan.status !== b.loan.status) return text('give.changedStatus');
  return null;
}
