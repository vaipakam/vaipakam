/**
 * What a failed `calculateHealthFactor` read means — one rule for every pass
 * that reads health factors (the liquidator's full-book scan and the
 * subscriber watcher), so they cannot disagree about which failures are the
 * protocol working and which are a gap.
 *
 *   - `illiquid`: the loan has no oracle and deliberately reverts
 *     `IlliquidLoanNoRiskMath`. It has no health factor by design; calendar
 *     rows cover it. Expected, never an error.
 *   - `noPriceFeed`: the loan is priced, but an asset it needs has no feed
 *     (`NoPriceFeed`). Its health factor cannot be computed right now. That is
 *     a real data condition worth seeing (the loan is unevaluated), but it is
 *     the deployment's price configuration, not a keeper failure.
 *   - `other`: anything else — an RPC failure, an unknown revert. A gap.
 *
 * Named from the decoded error where viem has it, then from the raw 4-byte
 * selector (a facet ABI may not carry the error, as the watcher's RiskFacet
 * ABI does not carry `NoPriceFeed`), then from the message text.
 */
import { extractRevertName, extractRevertSelector } from '@vaipakam/lib/decodeContractError';

export type HfReadFailure = 'illiquid' | 'noPriceFeed' | 'other';

/** `IlliquidLoanNoRiskMath()` */
const ILLIQUID_SELECTOR = '0x1fb202b3';
/** `NoPriceFeed()` */
const NO_PRICE_FEED_SELECTOR = '0xfb94c4ed';

export function classifyHfReadFailure(err: unknown): HfReadFailure {
  if (err === undefined || err === null) return 'other';
  const name = extractRevertName(err);
  const selector = extractRevertSelector(err);
  const text = String(err);
  if (name === 'IlliquidLoanNoRiskMath' || selector === ILLIQUID_SELECTOR || /IlliquidLoanNoRiskMath|0x1fb202b3/.test(text)) {
    return 'illiquid';
  }
  if (name === 'NoPriceFeed' || selector === NO_PRICE_FEED_SELECTOR || /NoPriceFeed|0xfb94c4ed/.test(text)) {
    return 'noPriceFeed';
  }
  return 'other';
}
