/**
 * A rate curve answer in the index's shape (indexer `rateCurveRoutes.ts`,
 * #3751): five points, the reference half not published, the own-loans
 * rule as the index states it. Tests change only what each one checks.
 */
export const RULE = {
  lookbackMinDays: 90,
  lookbackTermMultiple: 2,
  minAgeDays: 3,
  walletShareCapBps: 2000,
  minLenders: 5,
  minBorrowers: 5,
  loans: 'closed-by-repayment',
  weight: 'interest-paid',
  figure: 'weighted-quartiles',
  provisional: true,
  excludes: [
    'open-loans',
    'defaulted-or-liquidated-loans',
    'linked-rate-loans',
    'self-trade-pairs',
    'unconfirmed-terms',
    'lender-sale-vehicles',
    'nft-legs',
    'loans-younger-than-min-age',
  ],
  interestSources: ['LoanSettlementBreakdown', 'InterestPaymentBooked'],
  interestNotYetCounted: ['refinance-payoff', 'swap-to-repay', 'partial-repayment'],
  points: [
    { days: 7, termRange: [1, 14], lookbackDays: 90 },
    { days: 30, termRange: [15, 60], lookbackDays: 90 },
    { days: 90, termRange: [61, 135], lookbackDays: 180 },
    { days: 180, termRange: [136, 270], lookbackDays: 360 },
    { days: 365, termRange: [271, null], lookbackDays: 730 },
  ],
};

const TERMS = RULE.points;

export function curveAnswer(chainId: number, asset: string, asOf: number) {
  return {
    chainId,
    asset: asset.toLowerCase(),
    notice: 'observed-averages-not-advice-forecast-or-offer',
    computed: true,
    day: Math.floor(asOf / 86_400),
    asOf,
    reference: {
      source: 'outside-rate-reference',
      terms: TERMS.map(({ days }) => ({ days, state: 'not-published', valueBps: null, a24Bps: null, a90Bps: null, weightBps: null })),
    },
    ownLoans: {
      source: 'platform-repaid-loans',
      rule: RULE,
      terms: TERMS.map(({ days, termRange, lookbackDays }) =>
        days === 30
          ? { days, termRange, lookbackDays, state: 'shown', reason: null, p25Bps: 480, medianBps: 520, p75Bps: 575, loans: 14, lenders: 6, borrowers: 9 }
          : days === 365
            ? { days, termRange, lookbackDays, state: 'withheld', reason: 'history-incomplete', p25Bps: null, medianBps: null, p75Bps: null, loans: 0, lenders: 0, borrowers: 0 }
            : { days, termRange, lookbackDays, state: 'withheld', reason: 'not-enough-loans', p25Bps: null, medianBps: null, p75Bps: null, loans: 2, lenders: 1, borrowers: 2 },
      ),
    },
  };
}

export function historyAnswer(chainId: number, asset: string, days: number, today: number) {
  const point = TERMS.find((t) => t.days === days)!;
  return {
    chainId,
    asset: asset.toLowerCase(),
    days,
    termRange: point.termRange,
    lookbackDays: point.lookbackDays,
    notice: 'observed-averages-not-advice-forecast-or-offer',
    rule: RULE,
    // Oldest first, as the index orders them; one day missing (today - 1).
    rows: [today - 3, today - 2, today].map((day, i) => ({
      day,
      reference: { state: 'not-published', valueBps: null, a24Bps: null, a90Bps: null, weightBps: null },
      ownLoans:
        i === 0
          ? { state: 'withheld', reason: 'not-enough-loans', p25Bps: null, medianBps: null, p75Bps: null, loans: 3, lenders: 3, borrowers: 3 }
          : { state: 'shown', reason: null, p25Bps: 470 + i, medianBps: 510 + i, p75Bps: 560 + i, loans: 12, lenders: 6, borrowers: 8 },
    })),
  };
}
