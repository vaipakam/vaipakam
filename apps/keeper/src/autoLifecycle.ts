/**
 * apps/keeper — T-092 auto-lifecycle pass (#512).
 *
 * Per cron tick, per chain with `AdminFacet.getAutoExtendEnabled() ==
 * true`, walks active loans looking for both-side-consented auto-
 * extend candidates and submits `extendLoanInPlace`. The on-chain
 * contract enforces every safety guard (caps, staleness, grace
 * window, sub-day floor, sanctions); this pass is a thin discovery +
 * fire layer.
 *
 *   1. `AdminFacet.getAutoExtendEnabled` — admin kill switch. Skip
 *      the chain entirely when false; users' consent storage stays
 *      in place but no executor calls are made.
 *
 *   2. `getActiveLoansCount` (O(1)); short-circuit when zero.
 *
 *   3. Page `getActiveLoansPaginated` for the loan ids.
 *
 *   4. For each loanId, read both
 *      `AutoLifecycleFacet.getAutoExtendBorrowerCaps(loanId)` AND
 *      `getAutoExtendLenderCaps(loanId)`. The getters self-apply the
 *      staleness fence (post-NFT-transfer the cap returns
 *      `enabled: false`), so we only need to check the post-fence
 *      `enabled` flag.
 *
 *   5. When both sides are enabled + fresh, pick `newRateBps` at the
 *      lender's floor (most conservative for the borrower) and
 *      `newDurationDays` to fit inside `min(borrower.maxNewExpiry,
 *      lender.maxNewExpiry)`, capped at 30 days per extension so the
 *      borrower's consent doesn't roll forward indefinitely without
 *      a re-affirmation. Submit `extendLoanInPlace`.
 *
 *   6. Only inside the extension window (#2738), as the contract states
 *      it for the loan: `getAutoExtendWindow(loanId)`, from three days
 *      before the loan's effective due date to the end of its grace. A
 *      window that cannot be read leaves that loan for the next run. The
 *      term rules are the contract's too (`ExtensionMustExtend`,
 *      `ExtensionShortensGrace`): a term that does not move the due date
 *      later, or makes the loan defaultable sooner, is refused at the
 *      send's gas estimate, so nothing is broadcast. (The keeper's interim
 *      copy of these rules, for Diamonds deployed before #2738's contract
 *      half, was removed at the all-waves fresh deploy, #2921.)
 *
 *   7. Only when the extension is funded (#2814): the borrower-position
 *      holder's reserve for the loan plus their other free vault balance of
 *      the principal asset must cover what an extension now would charge
 *      (`getExtendFunding`). The holder is the borrower-cap setter, which
 *      the cap's staleness fence guarantees is the current holder. A loan
 *      that falls short is skipped with the three figures named, rather than
 *      left to a generic refusal at the gas estimate. A loan whose funding
 *      cannot be read waits for the next run. (The loupe check that let a
 *      Diamond predating the view skip the pre-check was removed once every
 *      chain was fresh-deployed with it, #2952.)
 *
 *   7b. Within the borrower's fee limit (#3649 stage 2): an extension adds
 *      initiation fee for the term it adds (`quoteExtensionFee`), refused
 *      above the borrower cap's `maxExtensionFee`. The term is shortened to
 *      the longest one the limit admits, and named in the line; a loan whose
 *      one-day fee is already above it is skipped with both figures.
 *
 *   8. Soft per-tick cap so one rogue chain can't burn the keeper's
 *      gas budget.
 *
 * Auto-refinance is NOT in this pass, and needs no pass of its own: a
 * refinance completes inside the accept or the match that fills the
 * borrower's refinance-tagged request (#3042 retired the separate
 * `refinanceLoan` step), so the existing `runMatcher` already drives it
 * whenever a compatible lender offer exists.
 *
 * Gating: the keeper-level gate only (no pass flag of its own) — same as the
 * matcher / liquidator. Goes through `passIsArmed`, so the skip line now names
 * which of `KEEPER_ENABLED` / `KEEPER_PRIVATE_KEY` stopped it instead of the
 * older ambiguous "keeper disabled" (#1475).
 */

import {
  createPublicClient,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import {
  AdminFacetABI,
  AutoLifecycleFacetABI,
  AutoLifecycleSettingsFacetABI,
  FeeLevelsFacetABI,
  MetricsFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import type { PassTick } from './passSchedule';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { reportSendError } from './submissionQueue';
import { runIndex } from './runWindow';
import { pagedWalk } from './rotate';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { revertErrorName } from '@vaipakam/lib/contractRevert';
import { stepPublisher } from './stepStatus';

const ADMIN_ABI: Abi = AdminFacetABI as Abi;
const AUTO_LIFECYCLE_ABI: Abi = AutoLifecycleFacetABI as Abi;
/** #3410 — the consent and caps readers, split out of AutoLifecycleFacet. */
const AUTO_LIFECYCLE_SETTINGS_ABI: Abi = AutoLifecycleSettingsFacetABI as Abi;
const METRICS_ABI: Abi = MetricsFacetABI as Abi;
/** #3649 — the extension's added initiation fee (`quoteExtensionFee`). */
const FEE_LEVELS_ABI: Abi = FeeLevelsFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;

/** Soft per-tick / per-chain cap. Five auto-extends per tick gives
 *  the keeper a predictable upper bound on gas spend; the rest are
 *  picked up next tick (loans don't lose their consent state by
 *  waiting). */
const MAX_EXTENDS_PER_TICK = 5;

/** Default per-extension window in days. The contract enforces
 *  `newDurationDays <= cfgMaxOfferDurationDays()` (typically 365) and
 *  the per-side `maxNewExpiry` caps. We use a much smaller default
 *  here so a single keeper-fired extension doesn't roll the
 *  borrower's loan term forward by a year on caps that allow it —
 *  forces the borrower to re-affirm consent periodically. */
const DEFAULT_EXTEND_DAYS = 30n;

const SECONDS_PER_DAY = 86_400n;

/** What the holder has ready for a loan's next extension, and what it would
 *  charge now (`getExtendFunding`, #2814), all in `asset`. */
export interface ExtendFunding {
  asset: Address;
  reserved: bigint;
  otherFree: bigint;
  chargeNow: bigint;
}

/** Null when the holder can pay an extension now; otherwise the shortfall,
 *  with the three figures it was judged on. The reserve is drawn first, then
 *  the other free balance, as `extendLoanInPlace` draws them. */
export function fundingVerdict(f: ExtendFunding): string | null {
  if (f.reserved + f.otherFree >= f.chargeNow) return null;
  return `unfunded: reserve ${f.reserved} + other free ${f.otherFree} < charge ${f.chargeNow} (asset ${f.asset})`;
}

/** The funding verdict for `holder`'s extension of `loanId`; a read that
 *  fails leaves the funding unknown, and the loan waits for the next run. */
export async function readFundingVerdict(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  loanId: bigint,
  holder: Address,
): Promise<string | null> {
  let out: readonly [Address, bigint, bigint, bigint, bigint];
  try {
    out = (await client.readContract({
      address: diamond,
      abi: AUTO_LIFECYCLE_ABI,
      functionName: 'getExtendFunding',
      args: [loanId, holder],
    })) as readonly [Address, bigint, bigint, bigint, bigint];
  } catch (err) {
    return `funding unread — ${redactedError(err, { stack: false })}`;
  }
  return fundingVerdict({ asset: out[0], reserved: out[1], otherFree: out[2], chargeNow: out[3] });
}

/**
 * Whether `now` is inside the window the contract published for a loan
 * (`getAutoExtendWindow`, both bounds inclusive, as `extendLoanInPlace`
 * applies them); null when it is, otherwise the reason it is not.
 */
export function contractWindowVerdict(opensAt: bigint, closesAt: bigint, now: bigint): string | null {
  if (now < opensAt) return `window opens at ${opensAt}`;
  if (now > closesAt) return `past grace (ended ${closesAt})`;
  return null;
}

interface ExtendCaps {
  enabled: boolean;
  minRateBps: bigint;
  maxRateBps: bigint;
  maxNewExpiry: bigint;
  setter: Address;
  /** #3649 — the borrower's limit on the added initiation fee one extension
   *  may charge, in the lending asset (the lender's side carries 0). */
  maxExtensionFee: bigint;
}

/**
 * #3649 stage 2 — the longest extension, at most `days`, whose added
 * initiation fee is within the borrower's limit `cap`, or why there is none.
 * `feeFor(d)` is the fee an extension of `d` days would charge now
 * (`quoteExtensionFee`, after the holder's discount); it does not fall as
 * the term grows, so the longest fitting term is found by halving. A fee that
 * cannot be read throws, and the loan waits for the next run. Exported for
 * tests.
 */
export async function fitExtensionFee(
  feeFor: (days: bigint) => Promise<bigint>,
  days: bigint,
  cap: bigint,
): Promise<{ days: bigint; fee: bigint } | string> {
  const full = await feeFor(days);
  if (full <= cap) return { days, fee: full };
  const one = await feeFor(1n);
  if (one > cap) return `the added initiation fee of even a one-day extension (${one}) is above the borrower's limit of ${cap}`;
  let lo = 1n; // fits
  let loFee = one;
  let hi = days; // does not fit
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const fee = await feeFor(mid);
    if (fee <= cap) {
      lo = mid;
      loFee = fee;
    } else {
      hi = mid;
    }
  }
  return { days: lo, fee: loFee };
}

/**
 * The step the app reads (#3763, `DefaultPathsDesign.md` rule 7), published
 * to `keeper_step_status` as pass `autoLifecycle`:
 *
 *   - `extend` — loans whose two sides both consented are extended
 *     (`extendLoanInPlace`).
 *
 * The app shows auto-extend as run by the platform only where `extend` reads
 * as running. It is armed on a chain when this pass is armed and the chain's
 * own switch (`getAutoExtendEnabled`) reads on; a switch that cannot be read
 * publishes it as not armed, since the pass then extends nothing there.
 */
export const AUTO_LIFECYCLE_STEPS = ['extend'] as const;
export type AutoLifecycleStep = (typeof AUTO_LIFECYCLE_STEPS)[number];

const stepStatus = stepPublisher('autoLifecycle', AUTO_LIFECYCLE_STEPS);
/** Forget what was published (tests). */
export const resetAutoLifecycleSteps = stepStatus.reset;

/** Publish `extend` for one chain: armed only when the pass is armed and the
 *  chain's switch read on. */
export async function publishAutoLifecycleStep(
  db: D1Database,
  chain: { id: number; diamond: string },
  armed: boolean,
  nowSec: number,
): Promise<void> {
  await stepStatus.publish(db, [chain], new Set<AutoLifecycleStep>(armed ? ['extend'] : []), nowSec);
}

export async function runAutoLifecycle(env: Env, tick: PassTick): Promise<void> {
  const passOn = passIsArmed(env, 'autoLifecycle');
  const chains = getChainConfigs(env);
  if (!passOn) {
    // #3763 — stated, never assumed: published armed or not.
    const nowSec = Math.floor(Date.now() / 1000);
    for (const c of chains) {
      if (c.diamond) await publishAutoLifecycleStep(env.DB, { id: c.id, diamond: c.diamond }, false, nowSec);
    }
    return;
  }
  // Chains side by side, loans from a moving start (#2572 r5/r7, `runWindow.ts`).
  const run = runIndex(tick, 60_000);
  await Promise.all(
    chains.map(async (chain) => {
      try {
        await processChain(env, chain, tick.deadlineMs, run);
      } catch (err) {
        console.error(
          `[keeper] autoLifecycle chain=${chain.id} failed:`,
          redactedError(err),
        );
      }
    }),
  );
}

async function processChain(env: Env, chain: ChainConfig, deadlineMs: number, run: number): Promise<void> {
  if (!chain.diamond) return;
  const publicClient = createPublicClient({
    transport: http(chain.rpc),
  }) as PublicClient;

  // Admin kill switch. Its reading is what the app is told (#3763): a switch
  // that cannot be read is published as not armed before the error ends the
  // chain's run.
  let adminEnabled: boolean;
  try {
    adminEnabled = (await publicClient.readContract({
      address: chain.diamond as Address,
      abi: ADMIN_ABI,
      functionName: 'getAutoExtendEnabled',
    })) as boolean;
  } catch (err) {
    await publishAutoLifecycleStep(env.DB, { id: chain.id, diamond: chain.diamond }, false, Math.floor(Date.now() / 1000));
    throw err;
  }
  await publishAutoLifecycleStep(env.DB, { id: chain.id, diamond: chain.diamond }, adminEnabled, Math.floor(Date.now() / 1000));
  if (!adminEnabled) {
    console.log(`[keeper] autoLifecycle chain=${chain.id} skipped: kill switch off`);
    return;
  }

  // Enumerate active loans.
  const total = (await publicClient.readContract({
    address: chain.diamond as Address,
    abi: METRICS_ABI,
    functionName: 'getActiveLoansCount',
  })) as bigint;
  if (total === 0n) return;

  const ctx = buildKeeperContext(env, chain, publicClient, { notAfterMs: deadlineMs });
  if (!ctx) return;

  // Read a page, act on it, read the next (#2572 r5): the scan never spends
  // the window before the first extension. The walk starts at a loan that
  // moves each run (`pagedWalk`, #2572 r7), not at a page, so a run the
  // deadline stops partway through its first page does not leave that page's
  // tail unreached run after run.
  let scanned = 0;
  let submitted = 0;
  let stopped = false;
  for (const { cursor, limit } of pagedWalk(total, SCAN_PAGE, run)) {
    if (stopped || submitted >= MAX_EXTENDS_PER_TICK) break;
    const page = (await publicClient.readContract({
      address: chain.diamond as Address,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansPaginated',
      args: [cursor, limit],
    })) as bigint[];
    for (const loanIdBig of page) {
      if (submitted >= MAX_EXTENDS_PER_TICK) break;
      // #2572 — past the run's deadline every extension would be refused at
      // its turn in the send queue; the rest wait for the next run.
      if (Date.now() >= deadlineMs) {
        console.log(`[keeper] autoLifecycle chain=${chain.id} run deadline reached; remaining loans left for the next run`);
        stopped = true;
        break;
      }
      scanned += 1;
      const fired = await tryExtend(
        publicClient,
        ctx.wallet,
        chain.diamond as Address,
        loanIdBig,
      );
      if (fired) submitted++;
    }
  }
  console.log(
    `[keeper] autoLifecycle chain=${chain.id} scanned=${scanned} extended=${submitted}`,
  );
}

/**
 * The extension's length in whole days inside both parties' expiry caps, or
 * why there is none. A cap of 0 means "not set", never "no limit": the
 * executor refuses it (AutoExtendExpiryExceedsCap), so the loan is not
 * eligible. Pure; exported for tests.
 */
export function extensionDays(lenderCap: bigint, borrowerCap: bigint, nowSec: bigint): bigint | string {
  if (lenderCap === 0n || borrowerCap === 0n) return 'an expiry cap is not set';
  const cap = lenderCap < borrowerCap ? lenderCap : borrowerCap;
  if (nowSec >= cap) return 'the expiry cap has passed';
  const remaining = (cap - nowSec) / SECONDS_PER_DAY;
  const days = remaining < DEFAULT_EXTEND_DAYS ? remaining : DEFAULT_EXTEND_DAYS;
  return days === 0n ? 'no whole day fits inside the expiry cap' : days;
}

async function tryExtend(
  publicClient: PublicClient,
  wallet: import('viem').WalletClient,
  diamond: Address,
  loanIdBig: bigint,
): Promise<boolean> {
  // Read both-side caps. Each getter self-applies the staleness
  // fence: if the NFT transferred since the setter wrote the cap,
  // `enabled` is returned as `false` and we skip without firing.
  const borrowerCaps = (await publicClient.readContract({
    address: diamond,
    abi: AUTO_LIFECYCLE_SETTINGS_ABI,
    functionName: 'getAutoExtendBorrowerCaps',
    args: [loanIdBig],
  })) as ExtendCaps;
  if (!borrowerCaps.enabled) return false;

  const lenderCaps = (await publicClient.readContract({
    address: diamond,
    abi: AUTO_LIFECYCLE_SETTINGS_ABI,
    functionName: 'getAutoExtendLenderCaps',
    args: [loanIdBig],
  })) as ExtendCaps;
  if (!lenderCaps.enabled) return false;

  // Pick rate at the lender's floor — most conservative for the
  // borrower while still respecting the lender's minimum. The
  // contract enforces `minRateBps <= newRateBps <= ceiling`.
  const ceiling =
    lenderCaps.maxRateBps < borrowerCaps.maxRateBps
      ? lenderCaps.maxRateBps
      : borrowerCaps.maxRateBps;
  const newRateBps = lenderCaps.minRateBps;
  if (newRateBps > ceiling) return false; // no intersection

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const fit = extensionDays(lenderCaps.maxNewExpiry, borrowerCaps.maxNewExpiry, nowSec);
  if (typeof fit === 'string') {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} not extended: ${fit}`);
    return false;
  }
  // #2738 — only inside the window. Read after the caps: most loans carry
  // no consent and never reach this read.
  const outside = await readContractWindow(publicClient, diamond, loanIdBig, nowSec);
  if (outside !== null) {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} not extended: ${outside}`);
    return false;
  }

  // #2814 — only a funded extension. The holder whose vault pays is the
  // borrower-cap setter: an enabled cap is one the current holder set.
  const unfunded = await readFundingVerdict(publicClient, diamond, loanIdBig, borrowerCaps.setter);
  if (unfunded !== null) {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} not extended: ${unfunded}`);
    return false;
  }

  // #3649 stage 2 — the extension adds initiation fee for the term it adds,
  // refused above the borrower's limit (ExtensionFeeAboveCap). Shorten the
  // term to the longest one the limit admits rather than send a refusal.
  // (The funding check above already counts the fee, bounded by the limit.)
  let fitted: { days: bigint; fee: bigint } | string;
  try {
    fitted = await fitExtensionFee(
      async (days) => {
        const [, fee] = (await publicClient.readContract({
          address: diamond,
          abi: FEE_LEVELS_ABI,
          functionName: 'quoteExtensionFee',
          args: [loanIdBig, nowSec + days * SECONDS_PER_DAY],
        })) as readonly [bigint, bigint, bigint, bigint];
        return fee;
      },
      fit,
      borrowerCaps.maxExtensionFee,
    );
  } catch (err) {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} not extended: extension fee unread — ${redactedError(err, { stack: false })}`);
    return false;
  }
  if (typeof fitted === 'string') {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} not extended: ${fitted}`);
    return false;
  }
  const newDurationDays = fitted.days;
  if (newDurationDays < fit) {
    console.log(`[keeper] autoLifecycle loan=${loanIdBig} extension shortened to ${newDurationDays} days: ${fit} days would add an initiation fee above the borrower's limit of ${borrowerCaps.maxExtensionFee}`);
  }

  // Submit `extendLoanInPlace`. Contract reverts on every safety
  // guard (sub-day-since-start, grace expired, sanctions, a term that
  // does not extend or shortens grace, etc.) — those failures bubble
  // up at the gas estimate, before anything is broadcast, and we log +
  // continue.
  try {
    const hash = await wallet.writeContract({
      address: diamond,
      abi: AUTO_LIFECYCLE_ABI,
      functionName: 'extendLoanInPlace',
      args: [loanIdBig, Number(newRateBps), newDurationDays],
      chain: undefined,
      account: wallet.account ?? null,
    } as never);
    console.log(
      `[keeper] autoLifecycle extended loan=${loanIdBig} rate=${newRateBps}bps days=${newDurationDays} extension-fee=${fitted.fee} tx=${hash}`,
    );
    return true;
  } catch (err) {
    // Most reverts here are benign (loan in last day, grace
    // expired, both-side consent flipped between read + write).
    // Log at info, not error.
    reportSendError(`[keeper] autoLifecycle extend loan=${loanIdBig}`, err, `skipped: ${redactedError(err, { stack: false })}`, console.log);
    return false;
  }
}

/** The contract's window for one loan, judged at `now`; null when open,
 *  otherwise the reason the loan is not extended. A loan that left Active
 *  since its page was read answers `LoanNotActive`; any other failure leaves
 *  the window unknown, and the loan waits for the next run. */
export async function readContractWindow(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  loanId: bigint,
  now: bigint,
): Promise<string | null> {
  let window: readonly [bigint, bigint];
  try {
    window = (await client.readContract({
      address: diamond,
      abi: AUTO_LIFECYCLE_ABI,
      functionName: 'getAutoExtendWindow',
      args: [loanId],
    })) as readonly [bigint, bigint];
  } catch (err) {
    if (revertErrorName(err) === 'LoanNotActive') return 'no longer active';
    return `window unread — ${redactedError(err, { stack: false })}`;
  }
  return contractWindowVerdict(window[0], window[1], now);
}
