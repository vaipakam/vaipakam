/**
 * #2814 — automatic extension of an active loan, as the loan page shows it.
 *
 * An extension (`AutoLifecycleFacet.extendLoanInPlace`) rolls the loan
 * forward in place: it settles the interest accrued so far (plus any late
 * fee), then restarts the loan at a new rate and term. It runs only when the
 * protocol's auto-extend switch is on, inside the loan's extension window,
 * and when BOTH current position holders have limits in force whose
 * intersection admits the new terms. The charge is drawn from the current
 * borrower-position holder's vault: their extension reserve for the loan
 * first, then their other free balance of the loan's asset.
 *
 * Every figure here is the contract's own: the switch, both sides' limits
 * (their getters already drop limits an earlier holder set), the window,
 * and what an extension would charge now and at the end of the window
 * (`getExtendFunding`). This module adds no rule of its own beyond reading
 * those together, at one block, and saying what they mean.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Address, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { signalAware } from '../chain/railHealth';
import { fetchActivity } from './indexer';
import { isRevert } from './liveLoanRow';
import { freshData } from '../lib/freshData';
import { loanEndTimeOf, readLoanLive } from '../contracts/loanLive';

const REFRESH_MS = 60_000;

/** One side's auto-extend limits, as its getter returns them: `enabled` is
 *  already false when the limits were set by an earlier holder. */
export interface ExtendCaps {
  enabled: boolean;
  minRateBps: number;
  maxRateBps: number;
  /** Unix seconds: the latest end an extension may give the loan. */
  maxNewExpiry: number;
  /** Who set these limits (zero when never set). */
  setter: Address;
}

export interface AutoExtendState {
  /** The protocol is paused: nothing runs, no limit can be set. */
  paused: boolean;
  /** The protocol's auto-extend switch. Off blocks every extension. */
  switchOn: boolean;
  /** Every delegated keeper is paused protocol-wide. */
  keepersPaused: boolean;
  borrower: ExtendCaps;
  lender: ExtendCaps;
  /** The extension window; null when the loan is not active. */
  window: { opensAt: number; closesAt: number } | null;
  /** The loan's current end (its effective maturity, a pause included) at
   *  the read block; null when the loan is not active. An extension's new
   *  end must fall after it. */
  currentEnd: number | null;
  /** The timestamp of the block these were read at. */
  now: number;
}

/** What a wallet has ready for the loan's next extension, and what that
 *  extension would charge (`getExtendFunding`), all in `asset`. */
export interface ExtendFunding {
  asset: Address;
  /** The wallet's reserve for this loan. */
  reserved: bigint;
  /** The wallet's other free vault balance of the asset. */
  otherFree: bigint;
  /** What an extension now would charge: interest so far plus any late fee. */
  chargeNow: bigint;
  /** What it would charge at the end of the window: the most an extension
   *  of the current term can charge. */
  chargeAtGraceEnd: bigint;
}

/**
 * What both sides' limits leave open, or why they leave nothing.
 *
 * Only a NEGATIVE here is a verdict. `overlap` says the limits admit some
 * terms, never that an extension will succeed: the executor applies further
 * rules when it runs (the new grace end may not fall before today's, among
 * others) that this module does not restate, so the page words it as limits,
 * not as a promise. `noOverlap` and `endTooEarly` are proven from the limits
 * and the loan's current end alone.
 */
export type ConsentBand =
  | { kind: 'overlap'; minRateBps: number; maxRateBps: number; latestEnd: number }
  /** Both sides have limits in force, and they admit no rate. */
  | { kind: 'noOverlap'; minRateBps: number; maxRateBps: number; latestEnd: number }
  /** The rates overlap, but no new end both accept is after the loan's
   *  current end: limits still "in force" by their getters can have run
   *  out, after an earlier extension or simply with time. */
  | { kind: 'endTooEarly'; latestEnd: number; currentEnd: number }
  | { kind: 'missing'; borrower: boolean; lender: boolean };

const DAY = 86_400;

/** The executor's rule: lender's minimum ≤ rate ≤ the lower of both
 *  maximums, and a new end — `now` plus a whole number of days, at least
 *  one — after the loan's current end and no later than the earlier of
 *  both latest ends. `now` and `currentEnd` are the read block's; with no
 *  current end (the loan is not active) the end test is not made. */
export function consentBand(
  borrower: ExtendCaps,
  lender: ExtendCaps,
  at: { now: number; currentEnd: number | null } = { now: 0, currentEnd: null },
): ConsentBand {
  if (!borrower.enabled || !lender.enabled) {
    return { kind: 'missing', borrower: !borrower.enabled, lender: !lender.enabled };
  }
  const minRateBps = lender.minRateBps;
  const maxRateBps = Math.min(lender.maxRateBps, borrower.maxRateBps);
  const latestEnd = Math.min(lender.maxNewExpiry, borrower.maxNewExpiry);
  if (minRateBps > maxRateBps) return { kind: 'noOverlap', minRateBps, maxRateBps, latestEnd };
  if (at.currentEnd !== null) {
    const days = Math.floor((latestEnd - at.now) / DAY);
    if (days < 1 || at.now + days * DAY <= at.currentEnd) {
      return { kind: 'endTooEarly', latestEnd, currentEnd: at.currentEnd };
    }
  }
  return { kind: 'overlap', minRateBps, maxRateBps, latestEnd };
}

/** Whether limits a wallet sees for its own side were set by someone else
 *  (an earlier holder), so they are not in force for it. */
export function setByEarlierHolder(caps: ExtendCaps, viewer: string | undefined): boolean {
  const zero = /^0x0{40}$/i.test(caps.setter);
  return !zero && !!viewer && caps.setter.toLowerCase() !== viewer.toLowerCase();
}

/** Where `now` sits against the window. */
export function windowPhase(
  now: number,
  w: { opensAt: number; closesAt: number },
): 'before' | 'open' | 'closed' {
  if (now < w.opensAt) return 'before';
  if (now > w.closesAt) return 'closed';
  return 'open';
}

/** Whether the reserve and other free balance together cover the charge
 *  now and at the end of the window, and the shortfall against the second. */
export function fundingCover(f: ExtendFunding): {
  available: bigint;
  coversNow: boolean;
  coversWindow: boolean;
  shortWindow: bigint;
} {
  const available = f.reserved + f.otherFree;
  return {
    available,
    coversNow: available >= f.chargeNow,
    coversWindow: available >= f.chargeAtGraceEnd,
    shortWindow: f.chargeAtGraceEnd > available ? f.chargeAtGraceEnd - available : 0n,
  };
}

/** The setter's arguments for a side. The borrower bounds the rate from
 *  above, the lender from below; the bound a side does not use is left
 *  open (0 below, the protocol's maximum above), which is what the
 *  executor's intersection expects. */
export function capsArgs(
  side: 'borrower' | 'lender',
  loanId: number,
  next: { enabled: boolean; rateBps: number; latestEnd: number },
  maxInterestBps: number,
): readonly [bigint, boolean, number, number, bigint] {
  if (!next.enabled) return [BigInt(loanId), false, 0, 0, 0n];
  return side === 'borrower'
    ? [BigInt(loanId), true, 0, next.rateBps, BigInt(next.latestEnd)]
    : [BigInt(loanId), true, next.rateBps, maxInterestBps, BigInt(next.latestEnd)];
}

type Ctx = { client: PublicClient; diamond: Address };

function caps(raw: unknown): ExtendCaps {
  const c = raw as {
    enabled: boolean;
    minRateBps: number | bigint;
    maxRateBps: number | bigint;
    maxNewExpiry: number | bigint;
    setter: Address;
  };
  return {
    enabled: Boolean(c.enabled),
    minRateBps: Number(c.minRateBps),
    maxRateBps: Number(c.maxRateBps),
    maxNewExpiry: Number(c.maxNewExpiry),
    setter: c.setter,
  };
}

/** The loan's auto-extend posture, read at one block. */
export async function readAutoExtendState(ctx: Ctx, loanId: number): Promise<AutoExtendState> {
  const { client, diamond } = ctx;
  const block = await client.getBlock({ blockTag: 'latest' });
  const read = (functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName,
      args: args as unknown[],
      blockNumber: block.number,
    });
  const id = BigInt(loanId);
  const [paused, switchOn, keepersPaused, borrower, lender, window, live] = await Promise.all([
    read('paused') as Promise<boolean>,
    read('getAutoExtendEnabled') as Promise<boolean>,
    read('keepersPaused') as Promise<boolean>,
    read('getAutoExtendBorrowerCaps', [id]),
    read('getAutoExtendLenderCaps', [id]),
    // The window exists only for an active loan; the view refuses the rest.
    (read('getAutoExtendWindow', [id]) as Promise<readonly [bigint, bigint]>).then(
      ([o, c]) => ({ opensAt: Number(o), closesAt: Number(c) }),
      (err: unknown) => {
        if (isRevert(err)) return null;
        throw err;
      },
    ),
    readLoanLive(client, diamond, id, block.number),
  ]);
  return {
    paused,
    switchOn,
    keepersPaused,
    borrower: caps(borrower),
    lender: caps(lender),
    window,
    currentEnd: window ? Number(loanEndTimeOf(live)) : null,
    now: Number(block.timestamp),
  };
}

/** `holder`'s funding for the loan's next extension. */
export async function readExtendFunding(
  ctx: Ctx,
  loanId: number,
  holder: Address,
  blockNumber?: bigint,
): Promise<ExtendFunding> {
  const [asset, reserved, otherFree, chargeNow, chargeAtGraceEnd] = (await ctx.client.readContract({
    address: ctx.diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getExtendFunding',
    args: [BigInt(loanId), holder],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  })) as readonly [Address, bigint, bigint, bigint, bigint];
  return { asset, reserved, otherFree, chargeNow, chargeAtGraceEnd };
}

/** The loan's auto-extend posture. Polled while mounted: governance flips
 *  the switch and the other side sets its limits with no action here. */
export function useAutoExtendState(loanId: number, enabled: boolean) {
  const { readChain } = useActiveChain();
  const client = usePublicClient({ chainId: readChain.chainId });
  // A failed refresh is an unknown, not the last answer (`freshData`): a
  // cached "both sides consent" could outlive a side turning it off.
  const q = useQuery({
    queryKey: ['autoExtend', readChain.chainId, loanId],
    enabled: enabled && Boolean(client),
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: () =>
      readAutoExtendState({ client: client as PublicClient, diamond: readChain.diamondAddress as Address }, loanId),
  });
  return { ...q, data: freshData(q) };
}

/** The connected wallet's funding for the loan's next extension. */
export function useExtendFunding(loanId: number) {
  const { readChain, address } = useActiveChain();
  const client = usePublicClient({ chainId: readChain.chainId });
  // Same rule: a cached reserve or cover verdict behind a failed refresh
  // may already have been drawn or spent.
  const q = useQuery({
    queryKey: ['extendReserve', readChain.chainId, loanId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(client),
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: () =>
      readExtendFunding(
        { client: client as PublicClient, diamond: readChain.diamondAddress as Address },
        loanId,
        address as Address,
      ),
  });
  return { ...q, data: freshData(q) };
}

/** `LibVaipakam.KEEPER_ACTION_EXTEND`. */
export const KEEPER_ACTION_EXTEND = 0x20;

/**
 * Whether a keeper the borrower allows could send the extension: keeper
 * access on, and at least one approved keeper with the extend permission
 * that is switched on for this loan. A keeper whose permission read failed
 * (`actions: null`) is an unknown, never a "no": unless another keeper is
 * already confirmed ready, the verdict is `unknown` while any keeper switched
 * on for the loan has an unread permission.
 */
export function keeperVerdict(
  config: { enabled: boolean; keepers: readonly { keeper: string; actions: number | null }[] },
  loanEnables: Readonly<Record<string, boolean>>,
): 'ready' | 'none' | 'unknown' {
  if (!config.enabled) return 'none';
  const onForLoan = config.keepers.filter((k) => loanEnables[k.keeper.toLowerCase()] === true);
  if (onForLoan.some((k) => k.actions !== null && (k.actions & KEEPER_ACTION_EXTEND) !== 0)) return 'ready';
  if (onForLoan.some((k) => k.actions === null)) return 'unknown';
  return 'none';
}

// ─── Withdrawal outcomes ───────────────────────────────────────────────

const OUTCOME_ROOT = 'extendReserveOutcome';

/**
 * What each of this wallet's reserve withdrawals did, by loan, for this
 * session. Kept in the query cache under its own root, never fetched and never
 * invalidated by the reserve rails, so the outcome (including a protected
 * account's queued or held payout) outlives the surface that sent it: a whole
 * withdrawal clears the reserve, and every reserve surface unmounts when it
 * reads zero.
 */
export function useReserveOutcomes(): Readonly<Record<number, string>> {
  const { readChain, address } = useActiveChain();
  const q = useQuery({
    queryKey: [OUTCOME_ROOT, readChain.chainId, address?.toLowerCase()],
    queryFn: () => ({}) as Record<number, string>,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return q.data ?? {};
}

/** Records a withdrawal's outcome where {@link useReserveOutcomes} reads it. */
export function useRecordReserveOutcome(): (loanId: number, text: string) => void {
  const { readChain, address } = useActiveChain();
  const queryClient = useQueryClient();
  return (loanId, text) =>
    queryClient.setQueryData<Record<number, string>>(
      [OUTCOME_ROOT, readChain.chainId, address?.toLowerCase()],
      (prev) => ({ ...(prev ?? {}), [loanId]: text }),
    );
}

// ─── Unused reserves, for the Claims page ────────────────────────────────

/** Every reserve starts with a funding, so the funding rows name every loan
 *  a wallet may hold a reserve on. */
export const RESERVE_DISCOVERY_KINDS = ['ExtendReserveFunded'] as const;
const PAGE = 200;
const MAX_PAGES = 5;

/** Why nothing, something, or the holder's next extension can draw a
 *  reserve. */
export type ReserveUse =
  /** The loan is still active and the wallet holds its borrower position:
   *  its extensions draw this reserve. */
  | 'kept'
  /** The loan has ended: nothing will draw it. */
  | 'ended'
  /** The wallet no longer holds the borrower position: an extension draws
   *  only the current holder's reserve. */
  | 'notHolder';

export interface ReserveRow {
  loanId: number;
  asset: Address;
  reserved: bigint;
  use: ReserveUse;
}

export interface UnusedReserves {
  rows: ReserveRow[];
  /** Loans found but not read, named rather than dropped. */
  unread: number[];
  /** The funding records ran past the pages read, so older loans were not
   *  checked. */
  truncated: boolean;
}

/** The loans a wallet funded a reserve on, newest first. `null` when the
 *  indexer could not answer. */
export async function reserveLoanIds(
  chainId: number,
  holder: string,
): Promise<{ loanIds: number[]; truncated: boolean } | null> {
  const seen = new Set<number>();
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetchActivity(chainId, { actor: holder, kinds: RESERVE_DISCOVERY_KINDS, limit: PAGE, before });
    if (!res) return null;
    for (const e of res.events) if (typeof e.loanId === 'number') seen.add(e.loanId);
    if (!res.nextBefore) return { loanIds: [...seen], truncated: false };
    before = res.nextBefore;
  }
  return { loanIds: [...seen], truncated: true };
}

/** One loan's reserve for `holder`, read at one block; `null` when nothing
 *  is reserved. Throws when a read fails. */
export async function readReserveRow(ctx: Ctx, loanId: number, holder: Address): Promise<ReserveRow | null> {
  const block = await ctx.client.getBlockNumber();
  const id = BigInt(loanId);
  const [funding, details] = await Promise.all([
    readExtendFunding(ctx, loanId, holder, block),
    ctx.client.readContract({
      address: ctx.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getLoanDetails',
      args: [id],
      blockNumber: block,
    }) as Promise<{ status: number; borrowerTokenId: bigint }>,
  ]);
  if (funding.reserved === 0n) return null;
  let use: ReserveUse = 'ended';
  if (Number(details.status) === 0) {
    // A burned position reads as no holder.
    const owner = await (
      ctx.client.readContract({
        address: ctx.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'ownerOf',
        args: [details.borrowerTokenId],
        blockNumber: block,
      }) as Promise<Address>
    ).catch((err: unknown) => {
      if (isRevert(err)) return null;
      throw err;
    });
    use = owner && owner.toLowerCase() === holder.toLowerCase() ? 'kept' : 'notHolder';
  }
  return { loanId, asset: funding.asset, reserved: funding.reserved, use };
}

/** Every loan the connected wallet has an extension reserve on. `null` =
 *  the indexer could not list them. */
export function useMyExtendReserves() {
  const { readChain, address } = useActiveChain();
  const client = usePublicClient({ chainId: readChain.chainId });
  const diamond = readChain.diamondAddress as Address;
  const q = useQuery({
    queryKey: ['extendReserve', readChain.chainId, 'mine', address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(client),
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<UnusedReserves | null> => {
      if (!address || !client) return null;
      const found = await reserveLoanIds(readChain.chainId, address);
      if (!found) return null;
      const ctx: Ctx = { client: client as PublicClient, diamond };
      const rows: ReserveRow[] = [];
      const unread: number[] = [];
      await Promise.all(
        found.loanIds.map(async (loanId) => {
          try {
            const row = await readReserveRow(ctx, loanId, address as Address);
            if (row) rows.push(row);
          } catch {
            unread.push(loanId);
          }
        }),
      );
      rows.sort((a, b) => b.loanId - a.loanId);
      unread.sort((a, b) => b - a);
      return { rows, unread, truncated: found.truncated };
    },
  });
  return { ...q, data: freshData(q) };
}

/** Withdraw the whole of `account`'s unused reserve for the loan, read live
 *  just before signing (an extension may have drawn it since the card's
 *  read). Tier-1: the wallet is re-screened first. Returns the receipt's
 *  logs, for where the payment went, or `null` when nothing is left. */
export async function withdrawWholeReserve(opts: {
  client: PublicClient;
  diamond: Address;
  account: Address;
  loanId: number;
  write: (fn: string, args: readonly unknown[]) => Promise<{ receipt: { logs: readonly unknown[] } }>;
  screen: () => Promise<void>;
}): Promise<readonly unknown[] | null> {
  await opts.screen();
  const live = await readExtendFunding({ client: opts.client, diamond: opts.diamond }, opts.loanId, opts.account);
  if (live.reserved === 0n) return null;
  const { receipt } = await opts.write('withdrawExtendReserve', [opts.account, BigInt(opts.loanId), live.reserved]);
  return receipt.logs;
}
