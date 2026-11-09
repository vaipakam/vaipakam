/**
 * ACC-32 — the standing approvals the connected wallet gives this protocol
 * on its network: what a token, an NFT collection, one NFT, or Permit2 lets
 * the protocol move from the wallet without asking again.
 *
 * Which assets are checked: no chain read lists every approval a wallet has
 * given, so the list is built from what the chain does record for this
 * wallet here: the suggested assets, every asset its deposit record, its
 * loans, its offers and its standing offers name, and any token the reader
 * adds. Each answer is read at one block. An approval for a token outside
 * that set is not found, and the page says so; a read that failed is
 * counted and stated, never shown as "no approval".
 */
import { erc20Abi, getAddress, type Abi, type PublicClient } from 'viem';
import { LenderIntentFacetABI, LoanFacetABI, MetricsFacetABI, OfferCancelFacetABI, VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import type { SupportedChain } from '../../chain/chains';
import { NFT_ABI, readStandard, type Standard } from '../nft/nft';
import { suggestedAssets, suggestedCollateral } from '../offers/assets';
import { answerOrNull, isContractAnswer } from '../reads/answer';
import { intentAssets, loanAssets, offerLegs, readLoanLegs, readPagedList, type IntentRow, type LoanLegs, type OfferRecord } from '../vault/holdings';

type Hex = `0x${string}`;

/** A standing offer as `getLenderIntentsByOwner` returns it: the lent asset
 *  and the collateral asset it asks for (an ERC-20). */
type StandingOfferRow = IntentRow & { intent: { collateralAsset?: Hex } };

const DEPOSITORY = VaultDepositoryFacetABI as Abi;
const INTENT = LenderIntentFacetABI as Abi;
const LOAN = LoanFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;
const OFFER = OfferCancelFacetABI as Abi;
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

/** Permit2 sits at one address on every network it is deployed to. */
export const PERMIT2: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'uint48' }],
    outputs: [],
  },
] as const;

/** At or above this an allowance is stated as unlimited (half of the
 *  largest value: no amount a token could hold comes near it). */
const UNLIMITED_ERC20 = 1n << 255n;
const UNLIMITED_PERMIT2 = (1n << 159n);

/** What is checked: ERC-20 tokens, NFT collections (operator approval),
 *  and single ERC-721 tokens a position names. */
export interface ApprovalSubjects {
  erc20: Hex[];
  collections: { asset: Hex; standard: Exclude<Standard, 'erc20'> }[];
  tokens: { asset: Hex; tokenId: bigint }[];
  /** Every list the chain keeps for this wallet was read to its end. */
  complete: boolean;
}

export type ApprovalKind = 'erc20' | 'permit2' | 'collection' | 'token';

/** One standing approval to the protocol. */
export interface ApprovalRow {
  kind: ApprovalKind;
  asset: Hex;
  /** A single token's id; 0 otherwise. */
  tokenId: bigint;
  /** An ERC-20 or Permit2 allowance; 0 for an NFT approval. */
  amount: bigint;
  /** A Permit2 allowance's expiry (unix seconds); 0 otherwise. */
  expiration: bigint;
}

export interface ApprovalScan {
  rows: ApprovalRow[];
  /** How many tokens, collections and single tokens were checked. */
  checked: number;
  /** How many of those could not be read. */
  unreadable: number;
  /** Whether Permit2 is deployed on this network (its allowances are read
   *  only where it is). */
  permit2: boolean;
  complete: boolean;
  block: bigint;
  chainNow: bigint;
}

function addUnique(list: Hex[], a: Hex): void {
  if (a.toLowerCase() === ZERO) return;
  if (!list.some((x) => x.toLowerCase() === a.toLowerCase())) list.push(getAddress(a));
}

/** Every subject from the suggested assets, the wallet's own records on
 *  chain and any token the reader added. */
export async function readApprovalSubjects(c: PublicClient, diamond: Hex, account: Hex, chain: SupportedChain, added: readonly Hex[]): Promise<ApprovalSubjects> {
  const block = await c.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber: block };
  const paged = (abi: Abi, functionName: string) =>
    readPagedList<unknown>((offset, limit) => c.readContract({ address: diamond, abi, functionName, args: [account, offset, limit], ...at }) as Promise<readonly [readonly unknown[], bigint]>);
  const [deposited, loanIds, offerIds, intents] = await Promise.all([
    paged(DEPOSITORY, 'getDepositoryAssets'),
    paged(METRICS, 'getUserLoansPaginated'),
    paged(METRICS, 'getUserOffersPaginated'),
    paged(INTENT, 'getLenderIntentsByOwner'),
  ]);
  const [loans, offers] = await Promise.all([
    readLoanLegs(loanIds.assets as bigint[], (id) => answerOrNull(c.readContract({ address: diamond, abi: LOAN, functionName: 'getLoanDetails', args: [id], ...at }) as Promise<LoanLegs>)),
    readLoanLegs(offerIds.assets as bigint[], async (id) => {
      const o = await answerOrNull(c.readContract({ address: diamond, abi: OFFER, functionName: 'getOffer', args: [id], ...at }) as Promise<OfferRecord>);
      return o === null ? null : offerLegs(o);
    }),
  ]);
  const legs = loanAssets([...loans.loans, ...offers.loans]);

  const erc20: Hex[] = [];
  const collections: ApprovalSubjects['collections'] = [];
  const addCollection = (asset: Hex, standard: Exclude<Standard, 'erc20'>) => {
    if (!collections.some((x) => x.asset.toLowerCase() === asset.toLowerCase())) collections.push({ asset: getAddress(asset), standard });
  };
  for (const s of suggestedAssets(chain)) addUnique(erc20, s.address);
  for (const s of legs.erc20) addUnique(erc20, s.asset);
  // A standing offer names both its lent asset and the collateral it asks
  // for; either may carry an approval.
  for (const s of intentAssets(intents.assets as IntentRow[])) addUnique(erc20, s.asset);
  for (const r of intents.assets as StandingOfferRow[]) if (r.intent.collateralAsset) addUnique(erc20, r.intent.collateralAsset);
  const tokens: ApprovalSubjects['tokens'] = [];
  for (const n of legs.nfts) {
    addCollection(n.asset, n.standard);
    if (n.standard === 'erc721' && !tokens.some((t) => t.asset.toLowerCase() === n.asset.toLowerCase() && t.tokenId === n.tokenId)) tokens.push({ asset: getAddress(n.asset), tokenId: n.tokenId });
  }
  // The suggested NFT collections, the deposit record's assets and the
  // reader's own additions say nothing of their standard: it is read.
  const unknown: Hex[] = [];
  for (const s of suggestedCollateral(chain)) if (s.nft) addUnique(unknown, s.address);
  for (const a of deposited.assets as Hex[]) addUnique(unknown, a);
  for (const a of added) addUnique(unknown, a);
  const standards = await Promise.all(unknown.map(async (a) => ({ asset: a, standard: await readStandard(c, a) })));
  for (const { asset, standard } of standards) {
    if (standard === 'erc20') addUnique(erc20, asset);
    else addCollection(asset, standard);
  }
  for (const col of collections) {
    const i = erc20.findIndex((e) => e.toLowerCase() === col.asset.toLowerCase());
    if (i >= 0) erc20.splice(i, 1);
  }
  return { erc20, collections, tokens, complete: deposited.complete && loanIds.complete && offerIds.complete && intents.complete && loans.complete && offers.complete };
}

/** Every subject's approval to the protocol, at one block. */
export async function readApprovals(c: PublicClient, diamond: Hex, account: Hex, subjects: ApprovalSubjects, blockNumber?: bigint): Promise<ApprovalScan> {
  const block = await c.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = { blockNumber: block.number };
  const view = <T>(address: Hex, abi: Abi, functionName: string, args: readonly unknown[]) =>
    answerOrNull(c.readContract({ address, abi, functionName, args, ...at }) as Promise<T>);
  const permit2Code = await c.getCode({ address: PERMIT2, ...at });
  const permit2 = permit2Code !== undefined && permit2Code !== '0x';
  let unreadable = 0;
  const rows: ApprovalRow[] = [];
  await Promise.all([
    ...subjects.erc20.map(async (asset) => {
      const [allowance, p2] = await Promise.all([
        view<bigint>(asset, erc20Abi as Abi, 'allowance', [account, diamond]),
        permit2 ? view<readonly [bigint, number | bigint, number | bigint]>(PERMIT2, PERMIT2_ABI as Abi, 'allowance', [account, asset, diamond]) : Promise.resolve(null),
      ]);
      if (allowance === null) unreadable++;
      else if (allowance > 0n) rows.push({ kind: 'erc20', asset, tokenId: 0n, amount: allowance, expiration: 0n });
      if (p2 !== null && p2[0] > 0n && BigInt(p2[1]) > block.timestamp) rows.push({ kind: 'permit2', asset, tokenId: 0n, amount: p2[0], expiration: BigInt(p2[1]) });
    }),
    ...subjects.collections.map(async ({ asset }) => {
      const ok = await view<boolean>(asset, NFT_ABI as Abi, 'isApprovedForAll', [account, diamond]);
      if (ok === null) unreadable++;
      else if (ok) rows.push({ kind: 'collection', asset, tokenId: 0n, amount: 0n, expiration: 0n });
    }),
    ...subjects.tokens.map(async ({ asset, tokenId }) => {
      const [owner, approved] = await Promise.all([view<Hex>(asset, NFT_ABI as Abi, 'ownerOf', [tokenId]), view<Hex>(asset, NFT_ABI as Abi, 'getApproved', [tokenId])]);
      // A token that no longer exists (ownerOf reverts) or that the wallet
      // no longer owns carries no approval of its own. A token the wallet
      // owns whose approval did not answer is unknown, never "none".
      if (owner === null || owner.toLowerCase() !== account.toLowerCase()) return;
      if (approved === null) {
        unreadable++;
        return;
      }
      if (approved.toLowerCase() === diamond.toLowerCase())
        rows.push({ kind: 'token', asset, tokenId, amount: 0n, expiration: 0n });
    }),
  ]);
  rows.sort(compareRows);
  return {
    rows,
    checked: subjects.erc20.length + subjects.collections.length + subjects.tokens.length,
    unreadable,
    permit2,
    complete: subjects.complete,
    block: block.number,
    chainNow: block.timestamp,
  };
}

const ORDER: Readonly<Record<ApprovalKind, number>> = { erc20: 0, permit2: 1, collection: 2, token: 3 };

function compareRows(a: ApprovalRow, b: ApprovalRow): number {
  if (a.kind !== b.kind) return ORDER[a.kind] - ORDER[b.kind];
  if (a.asset.toLowerCase() !== b.asset.toLowerCase()) return a.asset.toLowerCase() < b.asset.toLowerCase() ? -1 : 1;
  return a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0;
}

/** A stable name for a row, to key its revoke flow and find it again. */
export function rowKey(r: Pick<ApprovalRow, 'kind' | 'asset' | 'tokenId'>): string {
  return `${r.kind}:${r.asset.toLowerCase()}:${r.tokenId.toString()}`;
}

export function isUnlimited(r: ApprovalRow): boolean {
  if (r.kind === 'erc20') return r.amount >= UNLIMITED_ERC20;
  if (r.kind === 'permit2') return r.amount >= UNLIMITED_PERMIT2;
  return false;
}

/** The call that withdraws a row's approval. */
export function revokeCall(r: ApprovalRow, diamond: Hex): { address: Hex; abi: Abi; functionName: string; args: readonly unknown[] } {
  switch (r.kind) {
    case 'erc20':
      return { address: r.asset, abi: erc20Abi as Abi, functionName: 'approve', args: [diamond, 0n] };
    case 'permit2':
      return { address: PERMIT2, abi: PERMIT2_ABI as Abi, functionName: 'approve', args: [r.asset, diamond, 0n, 0] };
    case 'collection':
      return { address: r.asset, abi: NFT_ABI as Abi, functionName: 'setApprovalForAll', args: [diamond, false] };
    case 'token':
      return { address: r.asset, abi: NFT_ABI as Abi, functionName: 'approve', args: [ZERO, r.tokenId] };
  }
}

/** One row's approval read again, at a block: null when it no longer
 *  stands (the allowance is zero, Permit2's has expired, the operator or
 *  token approval is off, or the wallet no longer owns the token). Throws
 *  when the read had no answer, so a failed read is never "withdrawn". */
export async function readRow(c: PublicClient, diamond: Hex, account: Hex, r: ApprovalRow, blockNumber?: bigint): Promise<ApprovalRow | null> {
  const block = await c.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber });
  const at = { blockNumber: block.number };
  const read = <T>(address: Hex, abi: Abi, functionName: string, args: readonly unknown[]) => c.readContract({ address, abi, functionName, args, ...at }) as Promise<T>;
  switch (r.kind) {
    case 'erc20': {
      const a = await read<bigint>(r.asset, erc20Abi as Abi, 'allowance', [account, diamond]);
      return a > 0n ? { ...r, amount: a } : null;
    }
    case 'permit2': {
      const [amount, expiration] = await read<readonly [bigint, number | bigint, number | bigint]>(PERMIT2, PERMIT2_ABI as Abi, 'allowance', [account, r.asset, diamond]);
      return amount > 0n && BigInt(expiration) > block.timestamp ? { ...r, amount, expiration: BigInt(expiration) } : null;
    }
    case 'collection':
      return (await read<boolean>(r.asset, NFT_ABI as Abi, 'isApprovedForAll', [account, diamond])) ? r : null;
    case 'token': {
      const [owner, approved] = await Promise.all([read<Hex>(r.asset, NFT_ABI as Abi, 'ownerOf', [r.tokenId]), read<Hex>(r.asset, NFT_ABI as Abi, 'getApproved', [r.tokenId])]);
      return owner.toLowerCase() === account.toLowerCase() && approved.toLowerCase() === diamond.toLowerCase() ? r : null;
    }
  }
}

/** The other approvals that let the protocol move the same asset, which
 *  withdrawing `r` leaves in place: for one NFT, its collection's operator
 *  approval; for a collection, the single-token approvals found for it; for
 *  an ERC-20, its Permit2 allowance; for a Permit2 allowance, the token's
 *  own allowance. Read at a block; `unread` when one of them did not answer,
 *  so the receipt never says nothing remains when that is unknown. */
export interface Overlap {
  rows: ApprovalRow[];
  unread: boolean;
}

export async function readOverlap(
  c: PublicClient,
  diamond: Hex,
  account: Hex,
  r: ApprovalRow,
  known: readonly ApprovalRow[],
  blockNumber: bigint,
): Promise<Overlap> {
  const same = (x: Pick<ApprovalRow, 'asset'>) => x.asset.toLowerCase() === r.asset.toLowerCase();
  const probe = async (row: ApprovalRow): Promise<ApprovalRow | null | 'unread'> => {
    try {
      return await readRow(c, diamond, account, row, blockNumber);
    } catch (e) {
      if (isContractAnswer(e)) return 'unread';
      throw e;
    }
  };
  const blank = { asset: r.asset, tokenId: 0n, amount: 0n, expiration: 0n };
  let candidates: ApprovalRow[];
  switch (r.kind) {
    case 'token':
      candidates = [{ ...blank, kind: 'collection' }];
      break;
    case 'collection':
      candidates = known.filter((x) => x.kind === 'token' && same(x));
      break;
    case 'erc20': {
      const code = await c.getCode({ address: PERMIT2, blockNumber });
      candidates = code !== undefined && code !== '0x' ? [{ ...blank, kind: 'permit2' }] : [];
      break;
    }
    case 'permit2':
      candidates = [{ ...blank, kind: 'erc20' }];
      break;
  }
  const answers = await Promise.all(candidates.map(probe));
  return {
    rows: answers.filter((a): a is ApprovalRow => a !== null && a !== 'unread'),
    unread: answers.includes('unread'),
  };
}

/** Whether two overlap readings say the same thing. */
export function sameOverlap(a: Overlap, b: Overlap): boolean {
  if (a.unread !== b.unread || a.rows.length !== b.rows.length) return false;
  return a.rows.every((x) => b.rows.some((y) => rowKey(x) === rowKey(y) && x.amount === y.amount && x.expiration === y.expiration));
}

