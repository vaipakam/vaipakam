/**
 * #3727 — the inviter's page and the invite link (ReferralFeeShareDesign.md
 * section 6.1), read through the indexer's `/referrals/by-inviter/:address`.
 *
 * The page states only what the two referral events state: each wallet's
 * end time comes from its binding event, each redirect's reason from the
 * share event, and amounts are totalled per asset by the indexer, never
 * across assets. This module validates the body (the indexer is a cache,
 * and a malformed row must not render as a figure) and holds the pure
 * rules the page applies to it: the invite link, an end time compared
 * with CHAIN time, and how far behind the chain the record is.
 */
import { getJson, indexerConfigured } from './indexer';

export type ReferralOutcome =
  | 'paid'
  | 'no-share'
  | 'inviter-flagged'
  | 'payment-failed'
  | 'delivered-short';

const OUTCOMES: readonly ReferralOutcome[] = [
  'paid',
  'no-share',
  'inviter-flagged',
  'payment-failed',
  'delivered-short',
];

export interface InvitedWallet {
  wallet: `0x${string}`;
  boundAt: number;
  boundTx: string;
  endsAt: number;
  loansWithShare: number;
}

export interface ReferralShareRow {
  loanId: string;
  offerId: string;
  newUser: `0x${string}`;
  asset: `0x${string}`;
  share: string;
  outcome: ReferralOutcome;
  blockNumber: number;
  txHash: string;
  settledAt: number;
}

export interface InviterReferrals {
  chainId: number;
  inviter: string;
  indexedThroughBlock: number | null;
  invited: { rows: InvitedWallet[]; truncated: boolean };
  received: {
    rows: ReferralShareRow[];
    truncated: boolean;
    /** Null when the indexer could not sum every row in one read. */
    totals: { asset: `0x${string}`; amount: string }[] | null;
  };
  sentToReserve: { rows: ReferralShareRow[]; truncated: boolean };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DEC_RE = /^\d+$/;

const isAddr = (v: unknown): v is `0x${string}` => typeof v === 'string' && ADDRESS_RE.test(v);
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isDec = (v: unknown): v is string => typeof v === 'string' && DEC_RE.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function parseInvited(v: unknown): InvitedWallet | null {
  if (!isObj(v)) return null;
  const { wallet, boundAt, boundTx, endsAt, loansWithShare } = v;
  if (!isAddr(wallet) || !isNat(boundAt) || typeof boundTx !== 'string' || !HASH_RE.test(boundTx)) return null;
  if (!isNat(endsAt) || !isNat(loansWithShare)) return null;
  return { wallet, boundAt, boundTx, endsAt, loansWithShare };
}

function parseShare(v: unknown): ReferralShareRow | null {
  if (!isObj(v)) return null;
  const { loanId, offerId, newUser, asset, share, outcome, blockNumber, txHash, settledAt } = v;
  if (!isDec(loanId) || !isDec(offerId) || !isAddr(newUser) || !isAddr(asset) || !isDec(share)) return null;
  if (!OUTCOMES.includes(outcome as ReferralOutcome)) return null;
  if (!isNat(blockNumber) || typeof txHash !== 'string' || !HASH_RE.test(txHash) || !isNat(settledAt)) return null;
  return {
    loanId,
    offerId,
    newUser,
    asset,
    share,
    outcome: outcome as ReferralOutcome,
    blockNumber,
    txHash,
    settledAt,
  };
}

/** Every row, or nothing: a page that silently dropped an unreadable row
 *  would understate what was paid, so one bad row fails the whole list. */
function parseList<T>(raw: unknown, parse: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const r of raw) {
    const p = parse(r);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

/** Validate the indexer's body. Pure; tested on its own. */
export function parseInviterReferrals(raw: unknown, chainId: number): InviterReferrals | null {
  if (!isObj(raw) || raw.chainId !== chainId || typeof raw.inviter !== 'string') return null;
  const indexed = raw.indexedThroughBlock;
  if (indexed !== null && !isNat(indexed)) return null;
  const { invited, received, sentToReserve } = raw;
  if (!isObj(invited) || !isObj(received) || !isObj(sentToReserve)) return null;
  const invitedRows = parseList(invited.rows, parseInvited);
  const receivedRows = parseList(received.rows, parseShare);
  const reserveRows = parseList(sentToReserve.rows, parseShare);
  if (!invitedRows || !receivedRows || !reserveRows) return null;
  // A paid list must hold only paid rows, and the reserve list only redirects.
  if (receivedRows.some((r) => r.outcome !== 'paid')) return null;
  if (reserveRows.some((r) => r.outcome === 'paid' || r.outcome === 'no-share')) return null;
  let totals: InviterReferrals['received']['totals'] = null;
  if (received.totals !== null) {
    const t = parseList(received.totals, (v) =>
      isObj(v) && isAddr(v.asset) && isDec(v.amount) ? { asset: v.asset, amount: v.amount } : null,
    );
    if (!t) return null;
    totals = t;
  }
  return {
    chainId,
    inviter: raw.inviter,
    indexedThroughBlock: indexed as number | null,
    invited: { rows: invitedRows, truncated: invited.truncated === true },
    received: { rows: receivedRows, truncated: received.truncated === true, totals },
    sentToReserve: { rows: reserveRows, truncated: sentToReserve.truncated === true },
  };
}

/** `null` = unconfigured, unreachable, or a body that did not validate. */
export async function fetchInviterReferrals(
  chainId: number,
  inviter: string,
): Promise<InviterReferrals | null> {
  if (!indexerConfigured()) return null;
  const raw = await getJson<unknown>(`/referrals/by-inviter/${inviter.toLowerCase()}?chainId=${chainId}`);
  return raw === null ? null : parseInviterReferrals(raw, chainId);
}

/** The link an inviter shares. It carries the address only: the binding
 *  is the new user's own transaction, and nothing about a visit is kept. */
export function inviteLink(origin: string, inviter: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${inviter}`;
}

const DAY = 86_400;

/**
 * Where a binding stands against CHAIN time. The binding applies until its
 * end time inclusive, so it has ended only once chain time is past it.
 * `daysLeft` rounds up: a binding with an hour left still has a day in it.
 */
export function bindingWindow(
  endsAt: number,
  chainNowSec: number,
): { ended: boolean; daysLeft: number } {
  if (chainNowSec > endsAt) return { ended: true, daysLeft: 0 };
  return { ended: false, daysLeft: Math.ceil((endsAt - chainNowSec) / DAY) };
}

/** A record more than this far behind the chain says so. */
export const REFERRAL_LAG_NOTE_SEC = 10 * 60;

/**
 * How far the record trails the chain, in seconds, from the timestamps of
 * the chain's latest block and of the block the record is current to.
 * `null` when either is unknown: the page then states only the block.
 */
export function recordLagSec(
  headTimestamp: number | null,
  indexedTimestamp: number | null,
): number | null {
  if (headTimestamp === null || indexedTimestamp === null) return null;
  return Math.max(0, headTimestamp - indexedTimestamp);
}
