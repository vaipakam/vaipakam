// apps/keeper/src/collectionMatch.ts
//
// #3688 — the matcher's collection-offer step: pairs a lender's NFT
// collection offer (#3328) with posted borrower offers whose collateral token
// is in the offer's set, through `CollectionOfferFacet.matchCollectionOffer`.
//
// A collection offer is a parent lender offer that funds up to `loans` loans
// of `perLoan` each, one per token in its set (the whole collection, a range
// of ids, or a listed set proven by a Merkle root). `matchOffers` refuses it
// (`CollectionParentNotFillable`; `previewMatch` answers `CollectionParent`),
// so the ordinary walk leaves parents out and this step takes them.
//
// What the step decides before it pays for a call:
//   - which lender offers are parents (`getCollectionOffer`, batched, read
//     only for NFT-collateral lender offers naming no token, the shape every
//     parent has);
//   - which borrower offers a parent could take: the same asset pair and leg
//     types, another creator, the parent's token quantity, a term the match
//     core admits, a rate ceiling at or above the parent's rate, and room for
//     one loan of exactly `perLoan` (each fill is its own all-or-nothing loan);
//   - whether the borrower's token is in the set: by the set's own rule for a
//     whole collection or a range (exclusions win), and by a proof for a
//     listed set. A listed set's ids come from its creation event, which
//     carries them in full for up to 256 ids. The step checks the list against
//     the offer (no id twice, the stated count, the stated list hash and
//     root, by the one canonical file and tree, `@vaipakam/lib/collateralSet`) before it
//     proves anything, and leaves alone a listed set whose list it does not
//     hold or that does not check out, saying why.
//
// The contract stays the authority: every pair is simulated from the keeper's
// account before it is sent. A refusal that is about the parent (closed,
// expired, terms too fresh, no loans left) ends the parent for the run; one
// about the pair moves to the next borrower. Parents take turns, one borrower
// each per round, so one parent with many candidates cannot spend the budget
// the others need. It runs inside the match pass, after the ordinary walk and
// before the Auto-lend fills, on what is left of the pass's caps.
//
// Off unless COLLECTION_MATCH_ENABLED is set (as well as KEEPER_ENABLED).
// Ships disarmed. The caller is the matcher and earns the match share like any
// match; the fill counts against the keeper's solver capacity.

import type { Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  CollateralSetKind,
  checkPublishedList,
  setTakesWithoutProof,
  treeProof,
  type CollateralSetView,
  type ListProblem,
  type Tree,
} from '@vaipakam/lib/collateralSet';
import { summarizeFailure } from '@vaipakam/lib/errorDescription';
import { batchedRead } from './batchRead';
import { classify, revertArgs, revertName } from './callErrors';
import type { EventLedger } from './eventLedger';
import type { KeeperContext } from './keeper';
import { assetPairKey, beforeDeadline, matchReceiptTimeoutMs, termsFit, type OfferLite } from './matcher';
import { walkFrom } from './rotate';
import { reportSendError } from './submissionQueue';

/** `CollectionOfferFacet.TakeFailure`, in contract order. */
export const TakeFailure = {
  None: 0,
  NotCollectionOffer: 1,
  Closed: 2,
  Expired: 3,
  TermsTooFresh: 4,
  NoLoansLeft: 5,
  OwnOffer: 6,
  NotInSet: 7,
} as const;

/** Take refusals about the parent itself: nothing else is tried against it
 *  this run. `OwnOffer` and `NotInSet` are about the pair. */
const PARENT_REFUSALS = new Set<number>([
  TakeFailure.NotCollectionOffer,
  TakeFailure.Closed,
  TakeFailure.Expired,
  TakeFailure.TermsTooFresh,
  TakeFailure.NoLoansLeft,
]);

/** Refusals that hold for every pair this run, so the step stops. */
const STEP_STOPS = new Map<string, string>([
  ['FunctionDisabled', 'matching is switched off (partialFillEnabled)'],
  ['EnforcedPause', 'the protocol is paused'],
  ['ServiceCapacityExhausted', "this keeper's fill capacity is spent; waiting for it to refill"],
]);

/** `LibVaipakam.OfferType.Borrower`. */
const OFFER_TYPE_BORROWER = 1;
/** `LibVaipakam.FillMode.Aon`. */
const FILL_MODE_AON = 1;

/** Simulations one parent may use in a run, so a parent whose candidates all
 *  refuse cannot spend the budget of the others. */
export const MAX_TRIES_PER_PARENT = 8;

/** A collection offer the step can fill: the parent lender offer, its set and
 *  how many loans it has left. */
export interface CollectionParent {
  offer: OfferLite;
  set: CollateralSetView;
  perLoan: bigint;
  loansLeft: number;
}

/** A listed set's ids as the step holds them, or why it holds none. */
export type ListState = { ids: readonly bigint[] } | { missing: string };

/**
 * Whether `b` is a borrower offer `p` could take, apart from set membership:
 * the checks the match core makes that the step can make from what it read.
 * Pure. The simulation stays the authority.
 */
export function borrowerFitsCollection(p: CollectionParent, b: OfferLite): boolean {
  const L = p.offer;
  if (b.offerType !== OFFER_TYPE_BORROWER || b.accepted) return false;
  if (assetPairKey(L) !== assetPairKey(b)) return false;
  if (b.creator.toLowerCase() === L.creator.toLowerCase()) return false;
  if (b.collateralQuantity !== L.collateralQuantity) return false;
  if (!termsFit(L, b)) return false;
  if (b.interestRateBpsMax < L.interestRateBps) return false;
  // Each fill is one loan of exactly `perLoan`: it must sit inside the
  // borrower's window, and an all-or-nothing borrower must want exactly it.
  const remaining = b.amountMax > b.amountFilled ? b.amountMax - b.amountFilled : 0n;
  if (p.perLoan < b.amount || p.perLoan > remaining) return false;
  if (b.fillMode === FILL_MODE_AON && (b.amount !== p.perLoan || b.amountFilled !== 0n)) return false;
  return true;
}

/** The words a log line uses for a list that does not check out. */
const LIST_PROBLEM_WORDS: Record<ListProblem, string> = {
  empty: 'the published list is empty',
  duplicates: 'the published list names an id twice',
  count: 'the published list does not hold the number of ids the offer states',
  hash: "the offer's list hash is not the hash of the published list's canonical file",
  root: "the standard tree over the published list does not have the offer's root",
};

/** A listed parent's checked tree, or why there is none. */
export function checkedTree(p: CollectionParent, list: ListState | undefined): { tree: Tree } | { missing: string } {
  if (!list) return { missing: 'its list was not read' };
  if ('missing' in list) return list;
  const checked = checkPublishedList(list.ids, p.set);
  return checked.ok ? { tree: checked.tree } : { missing: LIST_PROBLEM_WORDS[checked.problem] };
}

/** The proof `b`'s token needs for `p` (`[]` for a set that needs none), or
 *  null when the token is not in the set. Pure. */
export function collectionProof(p: CollectionParent, tokenId: bigint, tree: Tree | null): Hex[] | null {
  const plain = setTakesWithoutProof(p.set, tokenId);
  if (plain !== null) return plain ? [] : null;
  // A listed set: an exclusion still wins over the list.
  if (p.set.exclusions.some((x) => x === tokenId)) return null;
  return tree ? treeProof(tree, tokenId) : null;
}

/** A simulation's verdict on one pair. */
export type CollectionSimVerdict =
  | { ok: true }
  | { refused: string; takeFailure?: number }
  | { unread: string };

/** The chain calls the step makes, passed in so it can be tested without a chain. */
export interface CollectionMatchIO {
  /** The published ids of the listed parents, keyed by offer id. */
  lists(parents: readonly CollectionParent[]): Promise<Map<bigint, ListState>>;
  /** Simulates the match from the keeper's account, by `deadlineMs`. */
  simulate(p: CollectionParent, b: OfferLite, proof: readonly Hex[], deadlineMs: number): Promise<CollectionSimVerdict>;
  /** Sends the match; false when it failed or is still uncertain at `deadlineMs`. */
  submit(p: CollectionParent, b: OfferLite, proof: readonly Hex[], deadlineMs: number): Promise<boolean>;
}

export interface CollectionMatchArgs {
  parents: readonly CollectionParent[];
  /** The hydrated borrower offers. A match updates the borrower's fill here,
   *  so the Auto-lend fills that follow size against what is left. */
  borrowers: readonly OfferLite[];
  run: number;
  /** Simulations and sends this step may use (what the pass has left). */
  maxSims: number;
  maxSubmits: number;
  passEndMs: number;
  /** Borrowers left in flight by an uncertain send this pass; the step
   *  passes over them and adds its own. */
  uncertainBorrowers: Set<string>;
  now?: () => number;
  io: CollectionMatchIO;
  log: (line: string) => void;
}

export interface CollectionMatchResult {
  sims: number;
  submits: number;
  capacitySpent: boolean;
}

/** One parent's state for the run. */
interface ParentRun {
  p: CollectionParent;
  candidates: OfferLite[];
  /** Each candidate's proof, by borrower offer id. */
  proofs: Map<string, Hex[]>;
  next: number;
  tries: number;
  done: boolean;
}

/**
 * The step over one chain's book. Parents take turns in an order that moves
 * with the run, one borrower each per round, until every parent is done or
 * the step's caps or the pass's time run out.
 */
export async function runCollectionMatches(args: CollectionMatchArgs): Promise<CollectionMatchResult> {
  const { run, io, log } = args;
  const now = args.now ?? Date.now;
  const result: CollectionMatchResult = { sims: 0, submits: 0, capacitySpent: false };
  const live = args.parents.filter((p) => p.loansLeft > 0);
  if (live.length === 0 || args.maxSims <= 0 || args.maxSubmits <= 0) return result;

  const listedParents = live.filter((p) => p.set.kind === CollateralSetKind.Listed);
  const lists = listedParents.length > 0 ? await io.lists(listedParents) : new Map<bigint, ListState>();

  const runs: ParentRun[] = [];
  for (const p of walkFrom(live, run)) {
    const proofs = new Map<string, Hex[]>();
    let tree: Tree | null = null;
    if (p.set.kind === CollateralSetKind.Listed) {
      const t = checkedTree(p, lists.get(p.offer.id));
      if ('missing' in t) {
        log(`collection offer ${p.offer.id} left alone: ${t.missing}`);
        continue;
      }
      tree = t.tree;
    }
    const candidates: OfferLite[] = [];
    for (const b of walkFrom(args.borrowers, run)) {
      if (!borrowerFitsCollection(p, b)) continue;
      const proof = collectionProof(p, b.collateralTokenId, tree);
      if (proof === null) continue;
      candidates.push(b);
      proofs.set(b.id.toString(), proof);
    }
    if (candidates.length > 0) runs.push({ p, candidates, proofs, next: 0, tries: 0, done: false });
  }

  // A borrower offer names one token, which one match locks: once matched it
  // is out of every parent's list this run.
  const matched = new Set<string>();
  for (;;) {
    let progressed = false;
    for (const r of runs) {
      if (r.done) continue;
      if (result.sims >= args.maxSims || result.submits >= args.maxSubmits || now() >= args.passEndMs) {
        return result;
      }
      const b = nextCandidate(r, matched, args.uncertainBorrowers);
      if (!b) {
        r.done = true;
        continue;
      }
      progressed = true;
      r.tries += 1;
      if (r.tries >= MAX_TRIES_PER_PARENT) r.done = true;
      const proof = r.proofs.get(b.id.toString())!;
      result.sims += 1;
      const v = await io.simulate(r.p, b, proof, args.passEndMs);
      if ('unread' in v) continue;
      if ('refused' in v) {
        const stop = STEP_STOPS.get(v.refused);
        if (stop) {
          log(`collection step stopped: ${stop}`);
          if (v.refused === 'ServiceCapacityExhausted') result.capacitySpent = true;
          return result;
        }
        if (v.takeFailure !== undefined && PARENT_REFUSALS.has(v.takeFailure)) r.done = true;
        continue;
      }
      if (now() >= args.passEndMs) return result;
      const ok = await io.submit(r.p, b, proof, args.passEndMs);
      if (ok) {
        result.submits += 1;
        matched.add(b.id.toString());
        b.amountFilled += r.p.perLoan;
        r.p.loansLeft -= 1;
        if (r.p.loansLeft <= 0) r.done = true;
      } else {
        // The send failed or is still in flight: neither side's state is
        // known, so the borrower is passed over by the rest of the pass and
        // the parent is left for the next run.
        args.uncertainBorrowers.add(b.id.toString());
        r.done = true;
      }
    }
    if (!progressed) return result;
  }
}

function nextCandidate(r: ParentRun, matched: ReadonlySet<string>, uncertain: ReadonlySet<string>): OfferLite | null {
  while (r.next < r.candidates.length) {
    const b = r.candidates[r.next++];
    const id = b.id.toString();
    if (!matched.has(id) && !uncertain.has(id)) return b;
  }
  return null;
}

// ─── Chain reads and sends ──────────────────────────────────────────────────

/** Offers read per `getCollectionOffer` batch. */
const PARENT_READ_CHUNK = 40;

/**
 * Which of `lenders` are collection offers. Only an NFT-collateral lender
 * offer naming token 0 can be one (a parent never names a token), so only
 * those are read. An offer whose read failed is not a parent here: the
 * ordinary walk's preview is the authority on it.
 */
export async function readCollectionParents(
  ctx: KeeperContext,
  lenders: readonly OfferLite[],
): Promise<CollectionParent[]> {
  const maybe = lenders.filter((o) => o.collateralAssetType !== 0 && o.collateralTokenId === 0n);
  const parents: CollectionParent[] = [];
  for (let i = 0; i < maybe.length; i += PARENT_READ_CHUNK) {
    const chunk = maybe.slice(i, i + PARENT_READ_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const results = await batchedRead(
      ctx.client,
      chunk.map((o) => ({
        address: ctx.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getCollectionOffer' as const,
        args: [o.id] as const,
      })),
      `matcher chain=${ctx.chainId} getCollectionOffer ${i}/${maybe.length}`,
    );
    results.forEach((r, j) => {
      if (r.status !== 'success') return;
      const parent = liftCollectionOffer(chunk[j], r.result);
      if (parent) parents.push(parent);
    });
  }
  return parents;
}

/** A `getCollectionOffer` answer as a parent, or null for an offer that is
 *  not a collection offer (its set's kind is None). */
export function liftCollectionOffer(offer: OfferLite, raw: unknown): CollectionParent | null {
  const [set, perLoan, loans, filled] = raw as readonly [Record<string, unknown>, bigint, number, number];
  const kind = Number(set['kind']);
  if (kind === CollateralSetKind.None) return null;
  return {
    offer,
    set: {
      kind,
      low: BigInt(set['low'] as bigint),
      high: BigInt(set['high'] as bigint),
      root: set['root'] as Hex,
      listHash: set['listHash'] as Hex,
      listCount: Number(set['listCount']),
      exclusions: ((set['exclusions'] as readonly bigint[] | undefined) ?? []).map((x) => BigInt(x)),
    },
    perLoan: BigInt(perLoan),
    loansLeft: Math.max(0, Number(loans) - Number(filled)),
  };
}

/** The ids a creation event published, as the event ledger stores them. */
export function publishedIdsFromArgs(args: Record<string, unknown>): bigint[] | null {
  const raw = args['publishedIds'];
  if (!Array.isArray(raw)) return null;
  try {
    return raw.map((x) => BigInt(x as string | number | bigint));
  } catch {
    return null;
  }
}

/** The listed parents' published ids, read from the shared indexer's event
 *  ledger (each parent's `CollectionOfferCreated`). A list too large for the
 *  event is kept as a file under the hash the offer carries; the keeper does
 *  not read those yet, and says so. */
export async function readPublishedLists(
  ledger: EventLedger,
  chainId: number,
  parents: readonly CollectionParent[],
): Promise<Map<bigint, ListState>> {
  const out = new Map<bigint, ListState>();
  const rows = await ledger.matching(
    chainId,
    ['CollectionOfferCreated'],
    'offerId',
    parents.map((p) => p.offer.id.toString()),
  );
  if (rows === null) {
    for (const p of parents) out.set(p.offer.id, { missing: 'the event ledger could not be read' });
    return out;
  }
  for (const row of rows) {
    const id = row.args['offerId'];
    if (id === undefined) continue;
    const ids = publishedIdsFromArgs(row.args);
    const offerId = BigInt(id as string);
    out.set(
      offerId,
      ids && ids.length > 0
        ? { ids }
        : { missing: 'its list is kept as a file, which the keeper does not read yet' },
    );
  }
  for (const p of parents) {
    if (!out.has(p.offer.id)) out.set(p.offer.id, { missing: 'its creation event is not in the ledger yet' });
  }
  return out;
}

/** Simulates `matchCollectionOffer` from the keeper's account. */
export async function simulateCollectionMatch(
  ctx: KeeperContext,
  p: CollectionParent,
  b: OfferLite,
  proof: readonly Hex[],
  deadlineMs: number,
): Promise<CollectionSimVerdict> {
  const account = ctx.wallet.account;
  if (!account) return { unread: 'no keeper account' };
  const call = ctx.client
    .simulateContract({
      address: ctx.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'matchCollectionOffer',
      args: [p.offer.id, b.id, proof as Hex[]],
      account,
    })
    .then((): CollectionSimVerdict => ({ ok: true }))
    .catch((err: unknown): CollectionSimVerdict => {
      const c = classify(err);
      if ('unread' in c) return c;
      const name = revertName(err) ?? c.refused;
      if (name === 'CollectionTakeRefused') {
        return { refused: name, takeFailure: Number(revertArgs(err)[2]) };
      }
      return { refused: name };
    });
  return beforeDeadline(call, deadlineMs, { unread: 'past the pass deadline' });
}

/** Sends `matchCollectionOffer` and waits for its receipt, as the walk's
 *  `submitMatch` does: true only when it landed. */
export async function submitCollectionMatch(
  ctx: KeeperContext,
  p: CollectionParent,
  b: OfferLite,
  proof: readonly Hex[],
  deadlineMs: number,
): Promise<boolean> {
  const account = ctx.wallet.account;
  if (!account) return false;
  const what = `[matcher] chain=${ctx.chainId} matchCollectionOffer offer=${p.offer.id} borrower=${b.id} token=${b.collateralTokenId}`;
  let hash: Hex;
  try {
    hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'matchCollectionOffer',
      args: [p.offer.id, b.id, proof as Hex[]],
      account,
      chain: ctx.wallet.chain,
    });
  } catch (err) {
    reportSendError(what, err, `broadcast failed: ${summarizeFailure(err)}`, console.log);
    return false;
  }
  try {
    const receipt = await ctx.client.waitForTransactionReceipt({
      hash,
      timeout: matchReceiptTimeoutMs(deadlineMs, Date.now()),
    });
    if (receipt.status !== 'success') {
      console.log(`${what} reverted on-chain tx=${hash}`);
      return false;
    }
  } catch (err) {
    console.log(`${what} receipt wait failed tx=${hash}: ${summarizeFailure(err, 200)}`);
    return false;
  }
  console.log(`${what} matched tx=${hash} perLoan=${p.perLoan} loansLeft=${p.loansLeft - 1}`);
  return true;
}

/** The step's chain calls for one chain. */
export function collectionMatchIO(ctx: KeeperContext, ledger: EventLedger): CollectionMatchIO {
  return {
    lists: (parents) => readPublishedLists(ledger, ctx.chainId, parents),
    simulate: (p, b, proof, deadlineMs) => simulateCollectionMatch(ctx, p, b, proof, deadlineMs),
    submit: (p, b, proof, deadlineMs) => submitCollectionMatch(ctx, p, b, proof, deadlineMs),
  };
}
