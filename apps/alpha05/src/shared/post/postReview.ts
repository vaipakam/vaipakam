/**
 * OFF-05 / OFF-06 / OFF-07 / OFF-16 / OFF-17 / OFF-18 / OFF-19 — what a
 * borrower's own request, or a lender's own offer, stands on, read in one go
 * through the wallet's connection, and the rules that turn it into the
 * receipt, the blockers stated in place, and the "what changed" of a
 * re-check. The two sides differ in what posting locks (the collateral for a
 * request, the amount lent for an offer: `stakeOf`) and in the receipt each
 * signs against (`lenderPostReceipt` for an offer); every other rule here is
 * one rule for both.
 *
 * The protocol's verdict is its own: the request is dry-run as `createOffer`
 * from this wallet. Every check the protocol makes before it pulls the
 * collateral is in that answer (the term cap, the pair rules, sanctions,
 * pauses, the risk gate, the amount bounds), so the page never repeats a
 * rule it could get wrong. While the collateral is not yet approved, the
 * dry run stops at the pull itself, which is the one refusal the approval
 * step clears; it is named as such, and the dry run after the approval is
 * the protocol's verdict on the whole request.
 */
import type { Abi, PublicClient } from 'viem';
import { OfferCreateFacetABI, RiskFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError, revertArgs, UNRECOGNISED } from '../eligibility/refusal';
import { readAssetClass, type AssetClass } from '../offers/assets';
import { shortfall } from '../offers/model';
import { CONFIG, ORACLE, readGraceSeconds, readLifBps, readTreasuryFeeBps, readVault, readWalletFunds, tokenAcceptsApproval, type WalletFunds } from '../offers/reads';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { askThrough } from '../tx/simulate';
import { chainValidUntil } from '../tx/deadline';
import { allowanceSteps } from '../tx/approval';
import { formatBps, shortAddress } from '../ui/format';
import { createParams, isRanged, stakeOf, type CreateParams, type ParsedPost, type PostPair, type PostSide } from './postModel';
import { POST_KEYS } from './postCopy';
import { CADENCE_ERRORS, cadenceRefusalText, classifyCadenceError, periodGraceLookupDays, type CadenceRefusal } from '../offers/cadence';
import { needFromRefusal, type RiskNeed } from '../risk/riskAccess';
import { readPostTariff, tariffBlockers, tariffKey, type PostTariff } from './tariffReview';
import { postCall, readGuardPriced } from './guardPost';
import { diamondMayMove, holds, readErc1155, readErc721, type Erc1155State, type Erc721State } from '../nft/nft';

type Hex = `0x${string}`;

export const CREATE_ABI = OfferCreateFacetABI as Abi;
const RISK = RiskFacetABI as Abi;

/** The health factor the depth-tiered regime admits a loan at: the
 *  liquidation threshold itself (1.0), as the protocol's start-of-loan check
 *  uses it; only the untiered regime reads the tunable floor. */
const HF_TIERED_FLOOR = 10n ** 18n;

/** The request or offer as the reader confirmed it on the form: which side
 *  posts it, the figures, the pair, and the expiry fixed when the review
 *  opened, so a re-read never moves the deadline under a consent. */
export interface PostDraft {
  side: PostSide;
  parsed: ParsedPost;
  pair: PostPair;
  expiresAt: bigint;
}

/** The protocol's answer to the request as a dry run from this wallet. */
export type CreateVerdict =
  /** It would go through as it stands. */
  | { kind: 'ok' }
  /** Every check passed up to pulling the collateral, which the approval
   *  step allows; the dry run after the approval decides. */
  | { kind: 'needs-approval' }
  /** The protocol refused, with its own reason. `ceiling` is the largest
   *  amount the posted collateral supports today, when the refusal is that
   *  the largest amount asks for more (`MaxLendingAboveCeiling`); `minCollateral`
   *  is the least collateral a lending offer must ask for its whole amount
   *  today, when the refusal is that it asks for less
   *  (`MinCollateralBelowFloor`); `schedule` is why the interest schedule
   *  is closed, when that is the refusal. */
  | { kind: 'refused'; code: string; reason: string; ceiling?: bigint; minCollateral?: bigint; schedule?: CadenceRefusal }
  /** No answer could be read; the review says so instead of guessing. */
  | { kind: 'unreadable'; reason: string };

export interface PostReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  /** The wallet the review was read for, and the protocol it would post to. */
  account: Hex;
  diamond: Hex;
  draft: PostDraft;
  params: CreateParams;
  verdict: CreateVerdict;
  lendingClass: AssetClass;
  collateralClass: AssetClass;
  /** OFF-16: the request's risk at today's prices, at each point a lender
   *  can take it, with the limits the protocol checks. */
  risk: PostRisk;
  maxDurationDays: bigint;
  graceSeconds: bigint;
  /** OFF-14: the grace a missed period gets before it can be settled, read
   *  live; null without a schedule, or when it could not be read. */
  periodGraceSeconds: bigint | null;
  /** OFF-22: the Full fee tariff's reads, when the request chose it. */
  tariff: PostTariff | null;
  /** #3358: whether the pair can be priced for the guard the post arms;
   *  null when it arms none. */
  guardPriced: boolean | null;
  lifBps: bigint;
  /** A lending offer's protocol share of interest, today's setting (the
   *  loan fixes the share in force when it opens); null for a request, or
   *  when it could not be read. */
  protocolShareBps: bigint | null;
  /** The poster's vault; the zero address when posting opens it. */
  vault: Hex;
  /** What the wallet holds of what posting locks (the collateral for a
   *  request, the amount for an offer) and what it lets the protocol move,
   *  read at the same time as the rest. */
  holding: Holding;
  readAt: number;
}

/** A loan-to-value read at today's prices: the figure in bps, a collateral
 *  that values to nothing (OFF-16: refused, never shown as 0%), a pair with
 *  no price (a token or an illiquid leg), or a read that failed. */
export type LtvRead = { kind: 'value'; bps: bigint } | { kind: 'worthless' } | { kind: 'unpriced' } | { kind: 'unread'; reason: string };

/**
 * OFF-16 — the risk a request carries at each point a lender can take it.
 * `direct` is what a lender taking it directly lends (the smallest amount
 * against the floor collateral). A match locks the collateral its lender
 * asks for, not what the request posts (`LibOfferMatch`): for a collateral
 * range at least the floor, up to everything posted; otherwise only the
 * lender's requirement, with the rest refunded. So `largest` (the largest
 * amount against everything posted, only for a range) is the least risky a
 * largest match can start, and `largestAtFloor` (the largest amount against
 * the floor, only for a collateral range) the riskiest; without a collateral
 * range a match can lock less than everything, down to the protocol's
 * start-of-loan limit, which is what bounds it.
 * `directWithinLimit` is the protocol's own create-time limit applied at the
 * direct point: the create dry run checks the largest point only, so the
 * direct point is asked separately (a dry run of a single-value request
 * there) and is 'unknown' when that answer says nothing about the limit.
 * `start` is the start-of-loan limit every loan is checked against, read
 * live; 'unread' when the read failed, 'none' for a pair it does not apply
 * to (an unpriced leg).
 * `partialFill` is the matching switch (RB-SWITCH class 1a): while it is off,
 * a range fills once and the matchers refuse.
 * A lending offer is taken directly for its whole amount against the
 * collateral it asks, and each match asks a share of that collateral
 * matching the part it lends, so one figure states its risk: `direct` is
 * the whole amount against the collateral, and `largest`,
 * `largestAtFloor` and the direct probe are not asked.
 */
export interface PostRisk {
  direct: LtvRead;
  largest: LtvRead | null;
  largestAtFloor: LtvRead | null;
  directWithinLimit: 'within' | 'over' | 'unknown' | 'not-asked';
  /** The largest amount the floor collateral supports, when the direct
   *  point is over the limit and the protocol said what it is. */
  directCeiling: bigint | null;
  start: StartGate;
  partialFill: boolean | null;
}

/** The start-of-loan limit: the health factor a loan must start at (and,
 *  in the depth-tiered regime, the tier's loan-to-value cap), a read that
 *  failed, or no limit for a pair the check does not apply to. */
export type StartGate = { kind: 'hf'; floor: bigint; tiered: boolean } | { kind: 'unread' } | { kind: 'none' };

/** The collateral as the wallet stands on it. An ERC-20 leg: the balance and
 *  allowance, and the wallet prompts the approval takes (0 when the
 *  allowance covers it, 2 when the token must be set to zero first). An
 *  ERC-721 leg (NFT-13): who holds the token and whether the protocol may
 *  move it. An ERC-1155 leg: how many of the token the wallet holds and
 *  whether the wallet already lets the protocol move the collection. */
export type Holding =
  | { kind: 'erc20'; funds: WalletFunds; approvalSteps: number }
  | { kind: 'erc721'; tokenId: bigint; state: Erc721State }
  | { kind: 'erc1155'; tokenId: bigint; quantity: bigint; state: Erc1155State };

/** The token errors a pull without an approval ends in, by name and by
 *  selector (the protocol's ABI does not carry a token's errors, so viem
 *  reports them by selector): the transfer the approval step allows, not a
 *  protocol refusal. `VaultDepositFailed` is the protocol's own wrap of a
 *  pull into the vault that reverted with no data (a token that refuses a
 *  short allowance with a bare revert, as WETH does): while the allowance
 *  is short it is that same pull, and the dry run after the approval
 *  decides. */
const PULL_ERRORS = new Set([
  'VaultDepositFailed',
  'ERC20InsufficientAllowance',
  'SafeERC20FailedOperation',
  '0xfb8f41b2',
  '0x5274afe7',
  'ERC721InsufficientApproval',
  '0x177e802f',
  'ERC1155MissingApprovalForAll',
  '0xe237d922',
]);

/** Reads the configured longest term, in days. */
export async function readMaxDurationDays(client: PublicClient, diamond: Hex): Promise<bigint> {
  const bundle = (await client.readContract({ address: diamond, abi: CONFIG, functionName: 'getProtocolConfigBundle' })) as readonly unknown[];
  return bundle[12] as bigint;
}

/**
 * The dry run, judged. With the allowance covering the collateral, any
 * revert is the protocol's refusal. Without it, the dry run stops at the
 * pull unless the protocol refused first, and the protocol refuses only with
 * named errors; so a token's pull error, or a revert this build cannot name
 * (a bare revert as some tokens give, an allowance message), is the pull
 * the approval step clears. The dry run after the approval is the
 * protocol's verdict on the whole request, so nothing is posted on this
 * reading alone.
 */
export function judgeDryRun(
  outcome: { kind: 'answered' } | { kind: 'reverted'; error: unknown } | { kind: 'unreadable'; reason: string },
  allowanceCovers: boolean,
): CreateVerdict {
  if (outcome.kind === 'answered') return { kind: 'ok' };
  if (outcome.kind === 'unreadable') return { kind: 'unreadable', reason: outcome.reason };
  const refusal = refusalFromError(outcome.error);
  if (!allowanceCovers && (PULL_ERRORS.has(refusal.code) || unnamed(refusal.code) || /allowance/i.test(refusal.reason))) return { kind: 'needs-approval' };
  return {
    kind: 'refused',
    code: refusal.code,
    reason: refusal.reason,
    ...ceilingOf(refusal.code, outcome.error),
    ...minCollateralOf(refusal.code, outcome.error),
    ...scheduleOf(refusal.code, outcome.error),
  };
}

/** Why the interest schedule is closed, when the protocol's refusal is one
 *  of its cadence errors, classified from the error's own arguments. */
function scheduleOf(code: string, error: unknown): { schedule?: CadenceRefusal } {
  if (!CADENCE_ERRORS.has(code)) return {};
  const schedule = classifyCadenceError(code, revertArgs(error));
  return schedule === null ? {} : { schedule };
}

/** The ceiling a `MaxLendingAboveCeiling(provided, ceiling)` refusal names. */
function ceilingOf(code: string, error: unknown): { ceiling?: bigint } {
  if (code !== 'MaxLendingAboveCeiling') return {};
  const args = revertArgs(error);
  return typeof args?.[1] === 'bigint' ? { ceiling: args[1] } : {};
}

/** The least collateral a `MinCollateralBelowFloor(provided, floor)`
 *  refusal names: what a lending offer must ask for its whole amount at
 *  today's prices. */
function minCollateralOf(code: string, error: unknown): { minCollateral?: bigint } {
  if (code !== 'MinCollateralBelowFloor') return {};
  const args = revertArgs(error);
  return typeof args?.[1] === 'bigint' ? { minCollateral: args[1] } : {};
}

/**
 * The protocol's create-time limit at the direct point, from a dry run of
 * a single-value request there: `over` when it refuses with the limit (and
 * the largest amount the floor supports, when it says), `within` when it
 * passes or stops only at the collateral pull (which comes after the
 * limit), and `unknown` when it stops for another reason. As in
 * `judgeDryRun`, a revert without a protocol name counts as the pull only
 * while the allowance is short; with the allowance covering, the pull cannot
 * be what stopped it, so it says nothing about the limit.
 */
export function judgeLimit(
  outcome: { kind: 'answered' } | { kind: 'reverted'; error: unknown } | { kind: 'unreadable'; reason: string },
  allowanceCovers: boolean,
): { kind: 'within' } | { kind: 'over'; ceiling: bigint | null } | { kind: 'unknown' } {
  if (outcome.kind === 'answered') return { kind: 'within' };
  if (outcome.kind === 'unreadable') return { kind: 'unknown' };
  const refusal = refusalFromError(outcome.error);
  if (refusal.code === 'MaxLendingAboveCeiling') return { kind: 'over', ceiling: ceilingOf(refusal.code, outcome.error).ceiling ?? null };
  if (!allowanceCovers && (PULL_ERRORS.has(refusal.code) || unnamed(refusal.code) || /allowance/i.test(refusal.reason))) return { kind: 'within' };
  return { kind: 'unknown' };
}

/** A pair's loan-to-value at today's prices, the protocol's own figure
 *  (`calculateLTV`); a collateral that values to nothing is named, never
 *  read as 0%. */
export async function readLtv(client: PublicClient, diamond: Hex, borrowed: Hex, amount: bigint, collateral: Hex, collateralAmount: bigint): Promise<LtvRead> {
  try {
    const bps = (await client.readContract({ address: diamond, abi: ORACLE, functionName: 'calculateLTV', args: [borrowed, amount, collateral, collateralAmount] })) as bigint;
    return { kind: 'value', bps };
  } catch (e) {
    if (refusalFromError(e).code === 'ZeroCollateral') return { kind: 'worthless' };
    throw e;
  }
}

/** The start-of-loan limit, read live: the tunable health-factor floor
 *  (`getMinHealthFactor`, 1.2 to 2.0) while the depth-tiered regime is off;
 *  the liquidation threshold (1.0) and the tier's loan-to-value cap while it
 *  is on. */
export async function readStartGate(client: PublicClient, diamond: Hex): Promise<StartGate> {
  const tiered = (await client.readContract({ address: diamond, abi: CONFIG, functionName: 'getDepthTieredLtvEnabled' })) as boolean;
  if (tiered) return { kind: 'hf', floor: HF_TIERED_FLOOR, tiered: true };
  return { kind: 'hf', floor: (await client.readContract({ address: diamond, abi: RISK, functionName: 'getMinHealthFactor' })) as bigint, tiered: false };
}

/** Whether a refusal carries no error name: a bare or unknown revert, or
 *  one known only by its selector. */
export function unnamed(code: string): boolean {
  return code === UNRECOGNISED || /^0x[0-9a-fA-F]{8}$/.test(code);
}

export async function readPostReview(own: OwnStateClient, diamond: Hex, draft: PostDraft, identity: string): Promise<PostReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const { pair, parsed } = draft;
  const params = createParams(parsed, pair, draft.expiresAt, draft.side);
  const leg = pair.leg;
  const stake = stakeOf(draft.side, parsed, pair);
  const [lendingClass, collateralClass, maxDurationDays, graceSeconds, lifBps, vault, held, protocolShareBps] = await Promise.all([
    r<AssetClass>((c) => readAssetClass(c, diamond, pair.lending)),
    r<AssetClass>((c) => readAssetClass(c, diamond, pair.collateral)),
    r<bigint>((c) => readMaxDurationDays(c, diamond)),
    r<bigint>((c) => readGraceSeconds(c, diamond, BigInt(parsed.durationDays))),
    r<bigint>((c) => readLifBps(c, diamond)),
    r<Hex>((c) => readVault(c, diamond, account)),
    leg.kind === 'erc721'
      ? r<Erc721State>((c) => readErc721(c, pair.collateral, leg.tokenId, account, diamond))
      : leg.kind === 'erc1155'
        ? r<Erc1155State>((c) => readErc1155(c, pair.collateral, leg.tokenId, account, diamond))
        : r<WalletFunds>((c) => readWalletFunds(c, stake.asset, account, diamond)),
    // Today's share: stated as such, so a failed read is said, not guessed.
    draft.side === 'lender' ? r<bigint>((c) => readTreasuryFeeBps(c, diamond)).catch(() => null) : Promise.resolve(null),
  ]);
  let holding: Holding;
  if (leg.kind === 'erc721') {
    holding = { kind: 'erc721', tokenId: leg.tokenId, state: held as Erc721State };
  } else if (leg.kind === 'erc1155') {
    holding = { kind: 'erc1155', tokenId: leg.tokenId, quantity: leg.quantity, state: held as Erc1155State };
  } else {
    const funds = held as WalletFunds;
    const approvalSteps =
      funds.allowance >= stake.amount
        ? 0
        : (await allowanceSteps({ accepts: (amount) => r<boolean>((c) => tokenAcceptsApproval(c, stake.asset, account, diamond, amount)) }, funds.allowance, stake.amount)).length;
    holding = { kind: 'erc20', funds, approvalSteps };
  }
  const allowanceCovers = !needsApproval({ holding, draft, diamond });
  // The post exactly as it is sent: with a guard, the batch that arms it
  // (guardPost), so the protocol's verdict covers the guard too.
  const dry = await askThrough(own, async (c) => c.simulateContract({ address: diamond, ...postCall(CREATE_ABI, params, parsed.guardBps, await chainValidUntil(c)), account }));
  const verdict = judgeDryRun(dry, allowanceCovers);
  // A token is never priced, so only a liquid ERC-20 pair has a risk figure.
  const priced = leg.kind === 'erc20' && lendingClass === 'liquid' && collateralClass === 'liquid';
  // Only a request's range has a second point to read: a lending offer's
  // parts carry the same ratio as its whole amount (PostRisk).
  const lender = draft.side === 'lender';
  const ranged = !lender && isRanged(parsed);
  const ltv = (amount: bigint, coll: bigint): Promise<LtvRead> =>
    priced
      ? own
          .read((c) => readLtv(c, diamond, pair.lending, amount, pair.collateral, coll))
          .then((x) => x.value)
          .catch((e: unknown) => ({ kind: 'unread' as const, reason: refusalFromError(e).reason }))
      : Promise.resolve({ kind: 'unpriced' as const });
  const collateralRanged = parsed.collateralFloor < parsed.collateral;
  const [direct, largest, largestAtFloor, probe, start, partialFill, periodGraceSeconds, tariff, guardPriced] = await Promise.all([
    lender ? ltv(parsed.amountMax, parsed.collateral) : ltv(parsed.amount, parsed.collateralFloor),
    ranged ? ltv(parsed.amountMax, parsed.collateral) : Promise.resolve(null),
    ranged && collateralRanged ? ltv(parsed.amountMax, parsed.collateralFloor) : Promise.resolve(null),
    // The create dry run applies the limit at the largest point only; the
    // direct point is asked as a single-value request there.
    priced && ranged
      ? askThrough(own, async (c) =>
          c.simulateContract({
            address: diamond,
            abi: CREATE_ABI,
            functionName: 'createOffer',
            args: [{ ...params, amountMax: parsed.amount, collateralAmountMax: parsed.collateralFloor, fillMode: 0 }, await chainValidUntil(c)],
            account,
          }),
        )
      : Promise.resolve(null),
    priced ? r<StartGate>((c) => readStartGate(c, diamond)).catch((): StartGate => ({ kind: 'unread' })) : Promise.resolve<StartGate>({ kind: 'none' }),
    r<boolean>((c) => c.readContract({ address: diamond, abi: CONFIG, functionName: 'getPartialFillEnabled' }) as Promise<boolean>).catch(() => null),
    parsed.cadence === 0 ? Promise.resolve(null) : r<bigint>((c) => readGraceSeconds(c, diamond, BigInt(periodGraceLookupDays(parsed.cadence)))).catch(() => null),
    readPostTariff(own, diamond, parsed, pair, lendingClass),
    parsed.guardBps === null ? Promise.resolve(null) : r<boolean>((c) => readGuardPriced(c, diamond, pair.lending, pair.collateral)),
  ]);
  const probed = probe === null ? null : judgeLimit(probe, allowanceCovers);
  const risk: PostRisk = {
    direct,
    largest,
    largestAtFloor,
    directWithinLimit: probed === null ? 'not-asked' : probed.kind,
    directCeiling: probed?.kind === 'over' ? probed.ceiling : null,
    start,
    partialFill,
  };
  return {
    identity,
    account,
    diamond,
    draft,
    params,
    verdict,
    lendingClass,
    collateralClass,
    risk,
    maxDurationDays,
    graceSeconds,
    periodGraceSeconds,
    tariff,
    guardPriced,
    lifBps,
    protocolShareBps: protocolShareBps as bigint | null,
    vault,
    holding,
    readAt: Date.now(),
  };
}

/** What posting locks of an ERC-20, as the draft states it. */
export function stakeOfDraft(d: PostDraft): { asset: Hex; amount: bigint } {
  return stakeOf(d.side, d.parsed, d.pair);
}

/** Whether what posting locks needs an approval step first. */
type Standing = Pick<PostReview, 'holding' | 'draft' | 'diamond'>;

export function needsApproval(r: Standing): boolean {
  const h = r.holding;
  if (h.kind === 'erc721') return !diamondMayMove(h.state, r.diamond);
  if (h.kind === 'erc1155') return !h.state.approvedForAll;
  return h.funds.allowance < stakeOfDraft(r.draft).amount;
}

/** The wallet prompts the approval takes: one for an ERC-721 token; for an
 *  ERC-1155 collection, two (the operator approval, and taking it back
 *  once the request settles); the allowance steps for an ERC-20. */
export function approvalPrompts(r: Standing): number {
  const h = r.holding;
  if (h.kind === 'erc721') return needsApproval(r) ? 1 : 0;
  if (h.kind === 'erc1155') return needsApproval(r) ? 2 : 0;
  return h.approvalSteps;
}

/** The wallet prompts posting asks for: the approval steps when needed,
 *  the request itself, and the tariff's own transaction when chosen. */
export function promptCount(r: Standing): number {
  return 1 + approvalPrompts(r) + (r.draft.parsed.tariff !== null ? 1 : 0);
}

/** What the wallet lacks of what posting locks: an ERC-20 shortfall in
 *  base units (the collateral, or a lender's amount), for an ERC-721 token that it does not exist or is held elsewhere,
 *  or for an ERC-1155 token how many of it the wallet is short. */
export type Lack = { kind: 'none' } | { kind: 'amount'; missing: bigint } | { kind: 'no-token' } | { kind: 'not-held' } | { kind: 'units'; missing: bigint };

export function collateralLack(r: Pick<PostReview, 'holding' | 'draft' | 'account'>): Lack {
  const h = r.holding;
  if (h.kind === 'erc721') return h.state.owner === null ? { kind: 'no-token' } : holds(h.state, r.account) ? { kind: 'none' } : { kind: 'not-held' };
  if (h.kind === 'erc1155') return h.state.balance < h.quantity ? { kind: 'units', missing: h.quantity - h.state.balance } : { kind: 'none' };
  const missing = shortfall(h.funds.balance, stakeOfDraft(r.draft).amount);
  return missing > 0n ? { kind: 'amount', missing } : { kind: 'none' };
}

/**
 * Every reason the wallet must not open for this request, in the order the
 * reader should meet them; empty when the protocol reports nothing and the
 * wallet holds the collateral.
 */
export function postBlockers(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>, unit = ''): string[] {
  const out: string[] = [];
  const k = POST_KEYS[r.draft.side];
  const name = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  for (const [asset, cls] of [
    [r.draft.pair.lending, r.lendingClass],
    [r.draft.pair.collateral, r.collateralClass],
  ] as const) {
    if (cls === 'distrusted') out.push(copy.format('accept.blockDistrusted', { asset: name(asset) }));
  }
  const lack = collateralLack(r);
  const h = r.holding;
  if (lack.kind === 'amount' && h.kind === 'erc20') {
    const stake = stakeOfDraft(r.draft);
    const amt = (v: bigint) => tokenAmount(v, stake.asset, meta, copy.format);
    out.push(copy.format(k.blockShortfall, { have: amt(h.funds.balance), missing: amt(lack.missing), need: amt(stake.amount) }));
  } else if ((lack.kind === 'no-token' || lack.kind === 'not-held') && h.kind === 'erc721') {
    out.push(copy.format(lack.kind === 'no-token' ? 'request.blockNoToken' : 'request.blockNotHeld', { id: String(h.tokenId) }));
  } else if (lack.kind === 'units' && h.kind === 'erc1155') {
    out.push(copy.format('request.blockUnits', { have: String(h.state.balance), need: String(h.quantity), id: String(h.tokenId) }));
  }
  // A risk-access refusal comes before the pull, so the shortfall never
  // explains it; it is named with the step that clears it (ACC-RISK).
  const risk = postRiskNeed(r);
  const guardUnpriced = r.guardPriced === false || (r.verdict.kind === 'refused' && r.verdict.code === 'OfferPriceGuardUnpriced');
  if (risk !== null) out.push(copy.text(RISK_BLOCK_KEYS[risk]));
  // The protocol's own refusal, unless what the wallet lacks already
  // explains it (a pull from a wallet that lacks the tokens or the token).
  // The protocol's ceiling is a bound on the request itself, checked before
  // any pull, so no shortfall explains it: it is named either way. Its
  // remedy (lock more collateral) is the borrower's, so only a request
  // names it.
  else if (r.verdict.kind === 'refused' && r.verdict.ceiling !== undefined && r.draft.side === 'borrower')
    out.push(
      copy.format(isRanged(r.draft.parsed) ? 'request.blockCeilingRange' : 'request.blockCeiling', {
        ceiling: tokenAmount(r.verdict.ceiling, r.draft.pair.lending, meta, copy.format),
      }),
    );
  // A lending offer's collateral floor is a bound on the offer itself,
  // checked before the pull as well; its remedy (ask for more collateral,
  // or lend less) is the lender's, so only an offer names it.
  else if (r.verdict.kind === 'refused' && r.verdict.minCollateral !== undefined && r.draft.side === 'lender')
    out.push(
      copy.format('lendOffer.blockCollateralFloor', {
        floor: tokenAmount(r.verdict.minCollateral, r.draft.pair.collateral, meta, copy.format),
      }),
    );
  // A closed schedule is refused before any pull too, and named with why.
  // A guard on a pair that cannot be priced: read on its own while the
  // dry run still stops at the pull, or the dry run's own refusal. Its
  // remedy is to post without one.
  else if (guardUnpriced) out.push(copy.text('request.blockGuardUnpriced'));
  else if (r.verdict.kind === 'refused' && r.verdict.schedule !== undefined)
    out.push(copy.format('request.blockSchedule', { reason: cadenceRefusalText(r.verdict.schedule, unit || copy.text('home.exposureUnit'), copy) }));
  else if (r.verdict.kind === 'refused' && lack.kind === 'none') out.push(copy.format(k.blockRefused, { reason: r.verdict.reason }));
  if (r.verdict.kind === 'unreadable') out.push(copy.format(k.blockUnread, { reason: r.verdict.reason }));
  out.push(...tariffBlockers(r.tariff, copy, r.draft.side));
  return out;
}

const RISK_BLOCK_KEYS: Readonly<Record<RiskNeed, CopyKey>> = { tier: 'risk.blockTier', 'pair-consent': 'risk.blockConsent', 'mid-tier-ack': 'risk.blockAck' };

/** The risk-access step the protocol's dry run asks of this wallet, if its
 *  refusal is one (ACC-RISK). */
export function postRiskNeed(r: Pick<PostReview, 'verdict'>): RiskNeed | null {
  return r.verdict.kind === 'refused' ? needFromRefusal(r.verdict.code) : null;
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the request stands on moved. */
export function changedBetween(a: PostReview, b: PostReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (a.verdict.kind !== b.verdict.kind || (a.verdict.kind === 'refused' && b.verdict.kind === 'refused' && a.verdict.code !== b.verdict.code))
    return copy.text(POST_KEYS[a.draft.side].changedVerdict);
  if (a.lendingClass !== b.lendingClass || a.collateralClass !== b.collateralClass || riskKey(a.risk) !== riskKey(b.risk)) return copy.text('accept.changedClass');
  if (
    a.graceSeconds !== b.graceSeconds ||
    a.periodGraceSeconds !== b.periodGraceSeconds ||
    a.lifBps !== b.lifBps ||
    a.maxDurationDays !== b.maxDurationDays ||
    a.protocolShareBps !== b.protocolShareBps
  )
    return copy.text('request.changedConfig');
  if (tariffKey(a.tariff) !== tariffKey(b.tariff)) return copy.text('request.changedTariff');
  if (a.guardPriced !== b.guardPriced) return copy.text('request.changedGuardPriced');
  if (lackKey(collateralLack(a)) !== lackKey(collateralLack(b)) || needsApproval(a) !== needsApproval(b) || approvalPrompts(a) !== approvalPrompts(b))
    return copy.text(a.holding.kind === 'erc20' ? 'accept.changedFunds' : 'request.changedToken');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}

function ltvKey(l: LtvRead | null): string {
  return l === null ? '-' : l.kind === 'value' ? String(l.bps) : l.kind;
}

/** What the risk figures stand on, for the "what changed" of a re-check. */
function riskKey(r: PostRisk): string {
  const start = r.start.kind === 'hf' ? `${r.start.floor}:${r.start.tiered}` : r.start.kind;
  return [ltvKey(r.direct), ltvKey(r.largest), ltvKey(r.largestAtFloor), r.directWithinLimit, String(r.directCeiling), start, String(r.partialFill)].join('|');
}

function lackKey(l: Lack): string {
  return l.kind === 'amount' || l.kind === 'units' ? `${l.kind}:${l.missing}` : l.kind;
}

/** A loan-to-value read as the receipt states it; a worthless collateral is
 *  named as the poster's own for a request, and as the borrower's for an
 *  offer. */
export function ltvText(l: LtvRead, copy: Pick<CopyAccess, 'text' | 'format'>, side: PostSide = 'borrower'): string {
  if (l.kind === 'value') return copy.format('request.ltv', { ltv: formatBps(l.bps) });
  if (l.kind === 'worthless') return copy.text(side === 'lender' ? 'lendOffer.ltvWorthless' : 'request.ltvWorthless');
  if (l.kind === 'unpriced') return copy.text('request.ltvIlliquid');
  return copy.text('request.ltvUnread');
}

/** What the form needs before a review: the longest term open, the list
 *  fee for the live summary, and the wallet's balance of the ERC-20 posting
 *  locks (`stakeAsset`: the collateral for a request, the lending asset for
 *  an offer); none for a token leg, whose token is checked by its id. */
export interface PostFormInputs {
  maxDurationDays: bigint;
  lifBps: bigint;
  balance: bigint | null;
}

export async function readPostFormInputs(client: PublicClient, diamond: Hex, account: Hex, stakeAsset: Hex | null): Promise<PostFormInputs> {
  const [maxDurationDays, lifBps, balance] = await Promise.all([
    readMaxDurationDays(client, diamond),
    readLifBps(client, diamond),
    stakeAsset !== null ? readWalletFunds(client, stakeAsset, account, diamond).then((f) => f.balance) : Promise.resolve(null),
  ]);
  return { maxDurationDays, lifBps, balance };
}

/** The collateral as the review and the outcome name it: "NFT #7 of vRENT"
 *  for an ERC-721 token, "3 of token #5 of vMULTI" for an ERC-1155 leg;
 *  empty for an ERC-20 leg, which is named by its amount. */
export function lockedName(h: Holding, collateral: Hex, meta: TokenMetaMap | null, format: CopyAccess['format']): string {
  const asset = assetName(collateral, meta);
  if (h.kind === 'erc721') return format('asset.nft', { asset, id: String(h.tokenId) });
  if (h.kind === 'erc1155') return format('asset.nft1155', { asset, id: String(h.tokenId), amount: String(h.quantity) });
  return '';
}
