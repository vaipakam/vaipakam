/**
 * #3761 — the "Borrow now" review's read: the standing sources on the pair,
 * the collateral the wallet supplies, and what `borrowInstant` gives in this
 * block, asked of the protocol itself from the borrower's wallet.
 */
import { erc20Abi, type PublicClient, type StateOverride } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import { refusalFromError } from '../eligibility/refusal';
import { readLenderIntents } from '../offers/intents';
import { METRICS, READY_BALANCE, readOffer, readPairOfferIds, readVault, tokenAcceptsApproval } from '../offers/reads';
import { readInstantSlot } from '../autolend/preset';
import { readRiskNeed } from '../risk/riskNeed';
import { readLifTerms } from '../offers/initiationFee';
import { allowanceSteps } from '../tx/approval';
import { findAllowanceOverride } from '../tx/allowanceOverride';
import { chainValidUntil } from '../tx/deadline';
import { askThrough } from '../tx/simulate';
import {
  borrowNowCall,
  instantRequest,
  offerCandidate,
  orderSources,
  planFrom,
  readInstantConfig,
  slotCandidates,
  walletDrawCeiling,
  type BorrowNowReview,
  type BorrowNowState,
  type BorrowNowTerms,
  type Candidate,
  type InstantSource,
} from './borrowNow';

type Hex = `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';

/** How many of the pair's offers are looked at as sources. */
const OFFER_PAGE = 20;

/** The standing sources for this borrow, cheapest first, and whether the
 *  search saw every one. A source the read cannot place is left out while
 *  others remain; the protocol judges every source it is given. When none
 *  remains and a source could not be read, the answer is unknown, not "no
 *  source", so the read throws and the review offers a retry instead of
 *  saying nothing is available. The search is bounded (the network's
 *  Auto-lend list up to its view cap, the pair's first offers), so
 *  `complete` is false when either list is longer than what was read: the
 *  review then never says no lender can take the borrow. */
export async function readSources(c: PublicClient, diamond: Hex, t: BorrowNowTerms, borrower: Hex): Promise<{ sources: InstantSource[]; complete: boolean }> {
  const [intents, offers] = await Promise.all([readLenderIntents(c, diamond), readPairOfferIds(c, diamond, t.lending, t.collateral, OFFER_PAGE)]);
  const slots = slotCandidates(intents.intents, t.lending, t.collateral, intents.at, borrower, t.termDays, t.maxRateBps);
  let unread = 0;
  const failed = () => {
    unread += 1;
    return null;
  };
  const consented = await Promise.all(
    slots.map((s) => readInstantSlot(c, diamond, s.source.owner, t.lending, t.collateral, s.source.slot).then((r) => (r.fills ? s : null), failed)),
  );
  const fromOffers = await Promise.all(
    offers.ids.map((id) => readOffer(c, diamond, id).then((o) => offerCandidate(id, o, t.lending, t.collateral, borrower, t.maxRateBps, t), failed)),
  );
  const found = [...consented, ...fromOffers].filter((x): x is Candidate => x !== null);
  if (found.length === 0 && unread > 0) throw new Error(`${unread} borrow source(s) could not be read`);
  const complete = BigInt(intents.scanned) >= intents.total && BigInt(offers.ids.length) >= offers.total;
  return { sources: orderSources(found).map((x) => x.source), complete };
}

/** The collateral the vault can supply now, as the instant fill draws it:
 *  the free balance, capped by what the account may spend at once (all of
 *  it, or a protected account's Ready balance, #3344). */
export async function readFreeCollateral(c: PublicClient, diamond: Hex, account: Hex, asset: Hex): Promise<bigint> {
  const vault = (await readVault(c, diamond, account)) as Hex;
  if (vault.toLowerCase() === ZERO) return 0n;
  const held = (await c.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })) as bigint;
  if (held === 0n) return 0n;
  const [free, spendable] = await Promise.all([
    c.readContract({ address: diamond, abi: METRICS, functionName: 'getFreeBalance', args: [account, asset, 0n, held] }) as Promise<bigint>,
    c.readContract({ address: diamond, abi: READY_BALANCE, functionName: 'readySpendable', args: [account, asset] }) as Promise<bigint>,
  ]);
  return spendable < free ? spendable : free;
}

/** What `borrowInstant` gives in this block, asked with `minTotal` 0 so the
 *  answer is the fills themselves. `override` puts the wallet's approval in
 *  place for the question only. */
export async function askPlan(
  own: Pick<OwnStateClient, 'sources' | 'account'>,
  diamond: Hex,
  t: BorrowNowTerms,
  sources: readonly InstantSource[],
  override: StateOverride | undefined,
  blockNumber?: bigint,
): Promise<BorrowNowState> {
  const asked = await askThrough(own, async (c) => {
    const req = instantRequest(t, 0n, await chainValidUntil(c));
    return c.simulateContract({ address: diamond, ...borrowNowCall(req, sources), account: own.account, stateOverride: override, blockNumber });
  });
  if (asked.kind === 'answered') {
    const plan = planFrom(asked.value.result, sources);
    return plan.total === 0n ? { kind: 'no-source' } : { kind: 'plan', plan };
  }
  if (asked.kind === 'reverted') {
    const r = refusalFromError(asked.error);
    if (r.code === 'InstantMarketDisabled') return { kind: 'market-off' };
    return { kind: 'refused', code: r.code, reason: r.reason };
  }
  throw new Error(asked.reason);
}

export async function readBorrowNowReview(own: OwnStateClient, diamond: Hex, t: BorrowNowTerms, identity: string): Promise<BorrowNowReview> {
  const account = own.account;
  const [config, found, free, allowance, walletHas, risk, lif] = await Promise.all([
    own.read((c) => readInstantConfig(c, diamond)).then((x) => x.value),
    own.read((c) => readSources(c, diamond, t, account)).then((x) => x.value),
    own.read((c) => readFreeCollateral(c, diamond, account, t.collateral)).then((x) => x.value),
    own.read((c) => c.readContract({ address: t.collateral, abi: erc20Abi, functionName: 'allowance', args: [account, diamond] }) as Promise<bigint>).then((x) => x.value),
    own.read((c) => c.readContract({ address: t.collateral, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>).then((x) => x.value),
    readRiskNeed(own, diamond, t.lending, t.collateral),
    own.read((c) => readLifTerms(c, diamond)).then(
      (x) => x.value,
      () => null,
    ),
  ]);
  const { sources, complete: searchComplete } = found;
  const fromVault = free < t.collateralOffered ? free : t.collateralOffered;
  const walletPart = t.collateralOffered - fromVault;
  const approvalNeeded = walletPart > 0n && allowance < walletPart;
  // The prompts the approval takes: one, or two where the token must be set
  // to zero first.
  const approvalSteps = approvalNeeded
    ? (await allowanceSteps({ accepts: (amount) => own.read((c) => tokenAcceptsApproval(c, t.collateral, account, diamond, amount)).then((x) => x.value) }, allowance, walletPart))
        .length
    : 0;
  const base = { terms: t, sources, searchComplete, walletPart, allowance, approvalNeeded, approvalSteps, identity, risk, lif, readAt: Date.now() };
  if (!config.enabled) return { ...base, state: { kind: 'market-off' } };
  if (sources.length === 0) return { ...base, state: { kind: searchComplete ? 'no-source' : 'none-found' } };
  // A wallet short of the whole collateral may still cover a part fill: each
  // fill draws only its own share, so the simulation decides, and the
  // shortfall is the answer only where it refuses.
  const short = walletHas < walletPart ? ({ kind: 'short-collateral', have: walletHas, need: walletPart } as const) : null;
  let override: StateOverride | undefined;
  if (approvalNeeded) {
    const found = await own.read((c) => findAllowanceOverride(c, t.collateral, account, diamond, walletPart)).then((x) => x.value);
    // Without a way to ask before the approval exists, the approval comes
    // first, unless the wallet holds none of the collateral at all.
    if (found === null) return { ...base, state: short !== null && walletHas === 0n ? short : { kind: 'needs-approval' } };
    override = found;
  }
  const asked = await askPlan(own, diamond, t, sources, override);
  // Nothing filled from what was read is "none known" only when the search
  // saw every source.
  const state: BorrowNowState = asked.kind === 'no-source' && !searchComplete ? { kind: 'none-found' } : asked;
  return { ...base, state: short !== null && state.kind !== 'plan' ? short : state };
}

/** What a review shows, as one key: a re-read that differs is a change. */
export function borrowNowKey(r: BorrowNowReview): string {
  const s = r.state;
  const state = s.kind === 'plan' ? `plan:${s.plan.total}:${s.plan.collateralLocked}:${s.plan.fills.map((f) => `${f.amount}@${f.rateBps}`).join(',')}` : s.kind;
  const lif = r.lif === null ? 'lif?' : `lif:${r.lif.baseBps}:${r.lif.baseTermDays}:${r.lif.yearlyBps}:${r.lif.yearDays}`;
  return [state, r.walletPart, walletDrawCeiling(r), r.approvalSteps, r.sources.length, r.searchComplete ? 'all' : 'some', r.risk ?? '', lif].join('|');
}
