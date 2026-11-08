/**
 * RB-CONFIDENCE — what a loan claim did, read from its own transaction: the
 * Diamond's claim record for the side (`LenderFundsClaimed` /
 * `BorrowerFundsClaimed`, with the asset and amount it paid from the claim
 * row), a held surplus it paid (`BorrowerSurplusClaimed`), whether the loan
 * settled (`LoanSettled`), and the NFTs that reached the wallet. Read from
 * the logs rather than from the loan afterwards, because a later transaction
 * in the same block can move the loan on.
 */
import { erc721Abi, parseAbi, parseEventLogs, type Abi, type Log } from 'viem';
import { ClaimFacetABI, RiskMatchLiquidationFacetABI } from '@vaipakam/contracts/abis';
import { ASSET_ERC721, type ClaimSide } from './loanClaim';

type Hex = `0x${string}`;

const CLAIM = ClaimFacetABI as Abi;
const MATCH = RiskMatchLiquidationFacetABI as Abi;
const ERC1155_TRANSFER = parseAbi(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)']);

type Args = Record<string, bigint | number | string | boolean | undefined>;

function claimEvents(logs: readonly Log[], diamond: Hex, loanId: bigint, eventName: string): Args[] {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: CLAIM, logs: [...own], eventName, strict: false }) as unknown as { args: Args }[];
  return events.map((e) => e.args).filter((a) => a.loanId === loanId);
}

export interface ClaimRecord {
  asset: Hex;
  amount: bigint;
  /** The other side had already claimed (or had nothing): the loan settles. */
  bothClaimed: boolean;
}

/** The side's claim record in this transaction, or null when it made none. */
export function claimRecorded(logs: readonly Log[], diamond: Hex, loanId: bigint, side: ClaimSide): ClaimRecord | null {
  const hit = claimEvents(logs, diamond, loanId, side === 'lender' ? 'LenderFundsClaimed' : 'BorrowerFundsClaimed').at(-1);
  if (!hit || hit.amount === undefined) return null;
  return { asset: String(hit.asset) as Hex, amount: BigInt(hit.amount as bigint), bothClaimed: hit.newBothClaimed === true };
}

/** The held surplus this transaction paid, or null when it paid none. */
export function surplusPaid(logs: readonly Log[], diamond: Hex, loanId: bigint): { asset: Hex; amount: bigint } | null {
  const hit = claimEvents(logs, diamond, loanId, 'BorrowerSurplusClaimed').at(-1);
  if (!hit || hit.amount === undefined) return null;
  return { asset: String(hit.asset) as Hex, amount: BigInt(hit.amount as bigint) };
}

/** Whether this transaction settled the loan. */
export function loanSettled(logs: readonly Log[], diamond: Hex, loanId: bigint): boolean {
  return claimEvents(logs, diamond, loanId, 'LoanSettled').length > 0;
}

/** How many of NFT `tokenId` of `asset` reached `to` in these logs: 1 for an
 *  ERC-721, the quantity for an ERC-1155, 0 when none did. */
export function nftArrived(logs: readonly Log[], asset: Hex, assetType: number, tokenId: bigint, to: Hex): bigint {
  const fromAsset = logs.filter((l) => l.address.toLowerCase() === asset.toLowerCase());
  const same = (a: unknown) => typeof a === 'string' && a.toLowerCase() === to.toLowerCase();
  if (assetType === ASSET_ERC721) {
    const hits = parseEventLogs({ abi: erc721Abi, logs: fromAsset, eventName: 'Transfer', strict: false }) as unknown as { args: { to?: string; tokenId?: bigint } }[];
    return hits.some((h) => same(h.args.to) && h.args.tokenId === tokenId) ? 1n : 0n;
  }
  const hits = parseEventLogs({ abi: ERC1155_TRANSFER, logs: fromAsset, eventName: 'TransferSingle', strict: false }) as unknown as {
    args: { to?: string; id?: bigint; value?: bigint };
  }[];
  return hits.filter((h) => same(h.args.to) && h.args.id === tokenId).reduce((t, h) => t + (h.args.value ?? 0n), 0n);
}

/** One leg's matching reward in a match this transaction made: paid to the
 *  matcher in the principal token of the loan whose lender the leg paid. */
export interface MatchIncentive {
  loanId: bigint;
  amount: bigint;
}

interface MatchArgs {
  loanIdA?: bigint;
  loanIdB?: bigint;
  loanIdC?: bigint;
  matcher?: string;
  incentivePaidA?: bigint;
  incentivePaidB?: bigint;
  incentivePaidC?: bigint;
}

function matches(logs: readonly Log[], diamond: Hex, loanId: bigint): MatchArgs[] {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: MATCH, logs: [...own], eventName: 'InternalMatchExecuted', strict: false }) as unknown as { args: MatchArgs }[];
  return events.map((e) => e.args).filter((a) => a.loanIdA === loanId || a.loanIdB === loanId || (a.loanIdC !== undefined && a.loanIdC !== 0n && a.loanIdC === loanId));
}

/** Whether this transaction matched the loan (`InternalMatchExecuted`): on a
 *  loan in fallback the lender's claim runs the protocol's match first, which
 *  rewrites the claim row it then pays. */
export function matchedInTx(logs: readonly Log[], diamond: Hex, loanId: bigint): boolean {
  return matches(logs, diamond, loanId).length > 0;
}

/** The matching rewards this transaction paid `account` as the matcher of a
 *  match on the loan, one per leg that paid one (a two-way match has two
 *  legs, a three-way match three). Each leg's reward is in the principal
 *  token of that leg's loan, which the caller resolves. */
export function matchIncentives(logs: readonly Log[], diamond: Hex, loanId: bigint, account: Hex): MatchIncentive[] {
  const out: MatchIncentive[] = [];
  for (const m of matches(logs, diamond, loanId)) {
    if (typeof m.matcher !== 'string' || m.matcher.toLowerCase() !== account.toLowerCase()) continue;
    const legs: [bigint | undefined, bigint | undefined][] = [
      [m.loanIdA, m.incentivePaidA],
      [m.loanIdB, m.incentivePaidB],
      [m.loanIdC, m.incentivePaidC],
    ];
    for (const [id, amount] of legs) if (id !== undefined && id !== 0n && amount !== undefined && amount > 0n) out.push({ loanId: id, amount });
  }
  return out;
}
