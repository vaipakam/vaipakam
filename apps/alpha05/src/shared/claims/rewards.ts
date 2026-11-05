/**
 * RW-24, RW-25, RW-27, RW-33, RW-36 — the interaction-reward reads and the
 * reward legs of the shared claim flow (RB-CLAIM).
 *
 * The headline is the claim ITSELF, run as a preview: the protocol's
 * simulation entry performs the claim and always reverts, carrying what it
 * would pay in its revert data, so the figure cannot drift from what a claim
 * pays. Any other revert is the claim's own refusal, which is the preview's
 * answer too (nothing to claim, a day still waiting, the pause, the
 * sanctions screen). Only when no source can run the preview at all does the
 * page fall back to the protocol's conservative lower bound, labelled as
 * such. Rewards are usage rebates paid in VPFI; nothing here frames them as
 * yield (RL-6).
 */
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { InteractionRewardsLensFacetABI, RewardClaimFacetABI, VPFIDiscountFacetABI, VPFITokenFacetABI, ConfigFacetABI, VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import { extractRevertData } from '@vaipakam/lib/decodeContractError';
import type { AtBlock } from '../tx/anchored';

type Hex = `0x${string}`;

export const REWARD_CLAIM_ABI = RewardClaimFacetABI as Abi;
const LENS = InteractionRewardsLensFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;
const DISCOUNT = VPFIDiscountFacetABI as Abi;
const VPFI_TOKEN = VPFITokenFacetABI as Abi;
const VAULT_FACTORY = VaultFactoryFacetABI as Abi;

/** The protocol's delivery venue argument, chosen explicitly: Vault credits
 *  the claimant's vault for every kind of account, and falls back to the
 *  wallet only when the credit cannot complete (no vault yet, a vault
 *  upgrade pending). The protocol's Default venue is not used: it resolves
 *  by account shape and pays a contract wallet straight to the wallet, which
 *  would make the receipt's destination depend on something the receipt
 *  does not show. The preview, the re-check and the claim all pass this. */
export const VENUE_VAULT = 2;

/** The days the protocol counts from when it ends the final notice. */
export const FINAL_NOTICE_DAYS = 90;

/** What a claim made now would do, as the protocol answers it. */
export type PendingRewards =
  /** The simulated claim: exactly what it pays. */
  | { kind: 'exact'; amount: bigint; fromDay: bigint; toDay: bigint }
  /** Nothing to claim on this chain, every entry read. */
  | { kind: 'none' }
  /** A day the claim needs is not ready yet: its global figures have not
   *  landed (`global`) or its funding has not been delivered (`delivery`). */
  | { kind: 'waiting'; day: bigint; why: 'global' | 'delivery' }
  /** The programme has not started on this chain. */
  | { kind: 'not-started' }
  /** The global pause stops every claim. */
  | { kind: 'paused' }
  /** The sanctions screen refuses this wallet's claim. */
  | { kind: 'barred' }
  /** Any other refusal, named by its error. */
  | { kind: 'refused'; code: string };

/** The revert a read answered with: its error name and arguments. */
export interface Reverted {
  errorName: string;
  args: readonly unknown[];
}

/** The errors the preview can answer with: the claim facet's own, plus the
 *  pause and the sanctions screen, which it raises through shared code. */
const PREVIEW_ERRORS = [...REWARD_CLAIM_ABI, ...parseAbi(['error SanctionedAddress(address who)', 'error EnforcedPause()'])] as Abi;

/**
 * The decoded revert, when `e` is a contract revert at all; null when the
 * call never reached the contract (a source outage). The revert bytes are
 * read wherever the provider put them (a structured field, or quoted in the
 * wallet's message text, as some wallets do), so a wallet that drops the
 * structured field still yields the figure.
 */
export function revertOf(e: unknown): Reverted | null {
  const data = extractRevertData(e) as Hex | undefined;
  if (data) {
    // A wallet's text can name the selector before it quotes the whole
    // payload, so every hex run it reported is tried, longest first.
    for (const candidate of [data, ...quotedHex(e)]) {
      try {
        const d = decodeErrorResult({ abi: PREVIEW_ERRORS, data: candidate });
        return { errorName: d.errorName, args: (d.args ?? []) as readonly unknown[] };
      } catch {
        /* not a whole payload of a known error */
      }
    }
    return { errorName: data.slice(0, 10), args: [] };
  }
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r) return null;
  return { errorName: r.data?.errorName ?? r.signature ?? 'Unrecognised', args: (r.data?.args ?? []) as readonly unknown[] };
}

/** Every ABI-shaped hex run in the error's messages along its causes,
 *  longest first. */
function quotedHex(e: unknown): Hex[] {
  const found: Hex[] = [];
  let node: unknown = e;
  for (let depth = 0; node && typeof node === 'object' && depth < 6; depth++) {
    const n = node as { message?: unknown; details?: unknown; cause?: unknown };
    for (const t of [n.message, n.details]) {
      if (typeof t !== 'string') continue;
      for (const m of t.match(/0x[0-9a-fA-F]+/g) ?? []) if (m.length > 10 && (m.length - 10) % 64 === 0) found.push(m as Hex);
    }
    node = n.cause;
  }
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

/** The simulation's answer, from its revert. Pure, so the rule is tested once. */
export function pendingFromRevert(r: Reverted): PendingRewards {
  const [a, b, c] = r.args as readonly bigint[];
  switch (r.errorName) {
    case 'InteractionRewardsSimulation':
      return { kind: 'exact', amount: a!, fromDay: b!, toDay: c! };
    case 'NoInteractionRewardsToClaim':
      return { kind: 'none' };
    case 'InteractionDayGlobalNotFinalized':
      return { kind: 'waiting', day: a!, why: 'global' };
    case 'InteractionDayAwaitingDelivery':
      return { kind: 'waiting', day: a!, why: 'delivery' };
    case 'InteractionEmissionsNotStarted':
    case 'VPFITokenNotSet':
      return { kind: 'not-started' };
    case 'EnforcedPause':
      return { kind: 'paused' };
    case 'SanctionedAddress':
      return { kind: 'barred' };
    default:
      return { kind: 'refused', code: r.errorName };
  }
}

/**
 * Run the claim as a preview through `client`. A revert is the answer; a
 * source that could not run the call at all throws, so the own rail moves
 * to its next source and, when none can, the read fails (and the page falls
 * back to the labelled lower bound).
 */
export async function readPendingRewards(client: PublicClient, diamond: Hex, account: Hex): Promise<PendingRewards> {
  try {
    await client.simulateContract({ address: diamond, abi: REWARD_CLAIM_ABI, functionName: 'simulateClaimInteractionRewards', args: [account, VENUE_VAULT], account });
  } catch (e) {
    const r = revertOf(e);
    if (r) return pendingFromRevert(r);
    throw e;
  }
  // The entry always reverts; a success means this is not that entry.
  throw new Error('the claim preview returned instead of answering');
}

/** The protocol's on-chain LOWER bound (it may understate, never overstate). */
export interface LowerBound {
  amount: bigint;
  fromDay: bigint;
  toDay: bigint;
}

export async function readRewardLowerBound(client: PublicClient, diamond: Hex, account: Hex): Promise<LowerBound> {
  const [amount, fromDay, toDay] = (await client.readContract({ address: diamond, abi: LENS, functionName: 'previewInteractionRewards', args: [account] })) as readonly [bigint, bigint, bigint];
  return { amount, fromDay, toDay };
}

/** Reward set apart for this wallet under the sanctions rule, and whether it
 *  can be taken now. */
export interface HeldRewards {
  held: bigint;
  /** The screen's verdict: deliver (not barred: the held balance is ready),
   *  hold (a flag under observation) or confirmed (a confirmed flag). */
  decision: 'deliver' | 'hold' | 'confirmed';
}

const DECISIONS = ['deliver', 'hold', 'confirmed'] as const;

export async function readHeldRewards(client: PublicClient, diamond: Hex, account: Hex): Promise<HeldRewards> {
  const [held, status] = await Promise.all([
    client.readContract({ address: diamond, abi: LENS, functionName: 'getSanctionsHeldReward', args: [account] }) as Promise<readonly [bigint, bigint]>,
    client.readContract({ address: diamond, abi: LENS, functionName: 'getRewardSanctionsStatus', args: [account] }) as Promise<readonly [number, ...unknown[]]>,
  ]);
  const decision = DECISIONS[Number(status[0])];
  if (!decision) throw new Error(`unrecognised sanctions decision ${String(status[0])}`);
  return { held: held[0], decision };
}

/** The soonest removal estimate across the wallet's live rewards (RW-33). */
export type SoonestExpiry =
  /** The claim window is off on this chain: no date exists. */
  | { kind: 'dark' }
  /** Every live reward read; none has a removal estimate. */
  | { kind: 'none' }
  /** The earliest estimate, unix seconds; `complete` false when not every
   *  reward could be read, so a later date must not be trusted as the
   *  soonest. */
  | { kind: 'date'; at: number; complete: boolean }
  /** Not every reward could be read and none read had a date. */
  | { kind: 'incomplete' };

/** Index positions and live rewards one page reads, and the pages read at
 *  most; beyond that the check says it is incomplete. */
const PAGE_POSITIONS = 200n;
const PAGE_LIVE = 50n;
const MAX_PAGES = 10;

/** One page's answer: (soonestId, soonestExpiresAt, nextOffset, total). */
export type ExpiryPage = readonly [bigint, bigint, bigint, bigint];

/** Fold the pages read into the answer. Pure, so the rule is tested once. */
export function soonestFrom(pages: readonly ExpiryPage[], finished: boolean): SoonestExpiry {
  let at = 0n;
  for (const [, expiresAt] of pages) if (expiresAt !== 0n && (at === 0n || expiresAt < at)) at = expiresAt;
  if (at !== 0n) return { kind: 'date', at: Number(at), complete: finished };
  return finished ? { kind: 'none' } : { kind: 'incomplete' };
}

/** Every page read at ONE block, so the answer is as of one moment. */
export async function readSoonestExpiry(client: PublicClient, diamond: Hex, account: Hex): Promise<SoonestExpiry> {
  const blockNumber = await client.getBlockNumber();
  const horizon = (await client.readContract({ address: diamond, abi: CONFIG, functionName: 'getRewardClaimHorizonDays', blockNumber })) as number;
  if (Number(horizon) === 0) return { kind: 'dark' };
  const pages: ExpiryPage[] = [];
  let offset = 0n;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = (await client.readContract({
      address: diamond,
      abi: LENS,
      functionName: 'getUserSoonestRewardExpiry',
      args: [account, offset, PAGE_POSITIONS, PAGE_LIVE],
      blockNumber,
    })) as ExpiryPage;
    pages.push(page);
    const [, , next, total] = page;
    if (next >= total) return soonestFrom(pages, true);
    if (next <= offset) break;
    offset = next;
  }
  return soonestFrom(pages, false);
}

/** RW-27: whether the reads now show reward days past the ones a finished
 *  claim covered, so the remainder is offered as "claim again". A read still
 *  showing the claimed window (not yet refreshed) does not count. A
 *  remainder that pays nothing still counts: the protocol answers with an
 *  exact zero only when the claim makes progress (it moves past reward days
 *  that paid nothing, toward the ones behind them), and refuses otherwise.
 *  Pure, so the rule is tested once. */
export function moreRemains(now: PendingRewards | null, claimedToDay: bigint): boolean {
  return now?.kind === 'exact' && now.fromDay > claimedToDay;
}

/** Within the final notice before the estimate (unix seconds). */
export function inFinalNotice(at: number, nowSeconds: number): boolean {
  return at - nowSeconds <= FINAL_NOTICE_DAYS * 86_400;
}

/** The fee-discount tier the protocol applies to this wallet's fees now:
 *  the public getter the fee path agrees with, so it is 0 while the wallet's
 *  fee-discount setting is off. */
export async function readEffectiveTier(client: PublicClient, diamond: Hex, account: Hex): Promise<number> {
  const [tier] = (await client.readContract({ address: diamond, abi: DISCOUNT, functionName: 'getEffectiveDiscount', args: [account] })) as readonly [number, number];
  return Number(tier);
}

export async function readVpfiToken(client: PublicClient, diamond: Hex): Promise<Hex> {
  return (await client.readContract({ address: diamond, abi: VPFI_TOKEN, functionName: 'getVPFIToken' })) as Hex;
}

/** What a reward claim's own logs record for `account`. */
export interface ClaimRecord {
  /** VPFI the claim paid (InteractionRewardsClaimed), null when no such log. */
  paid: bigint | null;
  /** Of it, VPFI credited to the vault (RewardDeliveredToVault). */
  toVault: bigint;
}

const CLAIM_EVENTS = parseAbi([
  'event InteractionRewardsClaimed(address indexed user, uint256 fromDay, uint256 toDay, uint256 amount)',
  'event RewardDeliveredToVault(address indexed user, uint256 amount, uint256 claimDayId)',
]);

export function claimRecord(logs: readonly Log[], diamond: Hex, account: Hex): ClaimRecord {
  let paid: bigint | null = null;
  let toVault = 0n;
  for (const l of parseEventLogs({ abi: CLAIM_EVENTS, logs: [...logs], strict: false })) {
    if (l.address.toLowerCase() !== diamond.toLowerCase()) continue;
    if (l.args.user?.toLowerCase() !== account.toLowerCase()) continue;
    if (l.eventName === 'InteractionRewardsClaimed') paid = (paid ?? 0n) + (l.args.amount ?? 0n);
    else toVault += l.args.amount ?? 0n;
  }
  return { paid, toVault };
}

const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

/** The wallet's and the vault's VPFI arrivals inside ONE transaction, from
 *  the token's own Transfer logs in its receipt. Transaction-local, so
 *  another transfer in the same block cannot be mistaken for the claim's.
 *  `vault` is the account's vault address (none: the zero address). */
export function vpfiArrivals(logs: readonly Log[], token: Hex, account: Hex, vault: Hex): { wallet: bigint; vault: bigint } {
  let wallet = 0n;
  let toVault = 0n;
  const zero = '0x0000000000000000000000000000000000000000';
  for (const l of parseEventLogs({ abi: TRANSFER, logs: [...logs], strict: false })) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue;
    const to = l.args.to?.toLowerCase();
    const value = l.args.value ?? 0n;
    if (to === account.toLowerCase()) wallet += value;
    else if (vault.toLowerCase() !== zero && to === vault.toLowerCase()) toVault += value;
  }
  return { wallet, vault: toVault };
}

/** The account's vault address at a block (the zero address: none). */
export async function readVaultAddress(client: PublicClient, diamond: Hex, account: Hex, at: AtBlock): Promise<Hex> {
  return (await client.readContract({ address: diamond, abi: VAULT_FACTORY, functionName: 'getUserVaultAddress', args: [account], ...at })) as Hex;
}

/** Where a claim's payment landed, from the VPFI the claim's own
 *  transaction delivered to the wallet and to the vault. `done` only when
 *  those arrivals add up to exactly what the claim logged it paid; any other
 *  total leaves the destination `unknown` rather than inferring one. The
 *  place is read from the arrivals rather than from the claim's own events,
 *  so a delivery the protocol redirects (a protected wallet credited in its
 *  vault) is described where the VPFI actually went. Pure, so the rule is
 *  tested once. */
export function deliveryOutcome(paid: bigint, toWallet: bigint, toVault: bigint): { where: 'vault' | 'wallet' | 'split' | 'unknown'; verdict: 'done' | 'unknown' } {
  if (toWallet + toVault !== paid) return { where: 'unknown', verdict: 'unknown' };
  return { where: toWallet === 0n ? 'vault' : toVault === 0n ? 'wallet' : 'split', verdict: 'done' };
}
