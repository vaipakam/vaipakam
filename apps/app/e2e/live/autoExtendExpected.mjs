/**
 * THE EXPECTED PAYLOADS AND PAGE TEXT FOR THE AUTO-EXTEND LIVE DRIVE (#2814).
 *
 * `live-auto-extend.mjs` signs on two dev wallets through one ordered write
 * plan (`writePlan.mjs`). Each step here is the WHOLE request the app must
 * ask to sign, built from the drive's own intent (the limits it types, the
 * reserve it adds) and the chain's facts, never from what the page sends:
 *
 *   borrower  setAutoExtendBorrowerCaps(loanId, true, 0, maxRate, latestEnd)
 *   lender    setAutoExtendLenderCaps(loanId, true, minRate, MAX_INTEREST_BPS, latestEnd)
 *   borrower  approve(Diamond, 0)?  approve(Diamond, exactly amount)?  fundExtendReserve(loanId, amount)
 *   borrower  withdrawExtendReserve(borrower, loanId, amount)
 *
 * The caps mirror the app's `capsArgs` (src/data/autoExtend.ts): the side a
 * party does not bound is left open, 0 below and the protocol's maximum
 * above. The approvals mirror erc20.ts `ensureAllowance`: none when the
 * allowance already covers the deposit, a reset to 0 only for a smaller
 * leftover, then exactly the deposit.
 *
 * The text helpers mirror the app's own formatting (src/lib/format.ts) and
 * fill the en catalogue's templates, so the drive compares what the page
 * states with what the chain and the catalogue say it should state.
 *
 * Pure; `autoExtendExpected.test.mjs` pins it.
 */
import { formatUnits } from 'viem';
import { approvalBetween, expectedApproveCall, expectedTx } from './refinanceExpected.mjs';

/** src/lib/offerSchema.ts MAX_INTEREST_BPS — the lender's open upper bound. */
export const MAX_INTEREST_BPS = 10_000;

/** The setter call the app sends for one side's limits (`capsArgs`). */
export function expectedCapsCall({ side, loanId, rateBps, latestEnd }) {
  if (side !== 'borrower' && side !== 'lender') throw new Error(`not a side: ${side}`);
  return {
    functionName: side === 'borrower' ? 'setAutoExtendBorrowerCaps' : 'setAutoExtendLenderCaps',
    args: {
      loanId: BigInt(loanId),
      enabled: true,
      minRateBps: side === 'borrower' ? 0 : rateBps,
      maxRateBps: side === 'borrower' ? rateBps : MAX_INTEREST_BPS,
      maxNewExpiry: BigInt(latestEnd),
    },
  };
}

/** The caps a getter must return after that call, from `setter`. */
export function capsMismatches({ side, rateBps, latestEnd, setter }, caps) {
  const want = {
    enabled: true,
    minRateBps: side === 'borrower' ? 0 : rateBps,
    maxRateBps: side === 'borrower' ? rateBps : MAX_INTEREST_BPS,
    maxNewExpiry: BigInt(latestEnd),
    setter: String(setter).toLowerCase(),
  };
  const got = {
    enabled: caps?.enabled,
    minRateBps: Number(caps?.minRateBps),
    maxRateBps: Number(caps?.maxRateBps),
    maxNewExpiry: BigInt(caps?.maxNewExpiry ?? -1),
    setter: String(caps?.setter).toLowerCase(),
  };
  return Object.keys(want)
    .filter((k) => got[k] !== want[k])
    .map((k) => `${k} ${String(got[k])} (want ${String(want[k])})`);
}

/**
 * One reserve deposit's steps: the optional approval pair, then the deposit.
 * `suffix` keeps a second deposit's ids distinct from the first's.
 */
export function fundSteps({ suffix = '', borrower, diamond, asset, loanId, amount, chainId }) {
  const tx = (to, call) => expectedTx({ from: borrower, to, call, chainId });
  const why = 'the reserve deposit';
  return [
    {
      id: `b-approve-reset${suffix}`,
      role: 'borrower',
      kind: 'tx',
      optional: true,
      requires: `b-approve-set${suffix}`,
      purpose: `approve(Diamond, 0) on ${why} — reset of a leftover allowance`,
      expected: tx(asset, expectedApproveCall({ spender: diamond, why, reset: true })),
    },
    {
      id: `b-approve-set${suffix}`,
      role: 'borrower',
      kind: 'tx',
      optional: true,
      purpose: `approve(Diamond, exactly ${amount}) on ${why}`,
      expected: tx(asset, { functionName: 'approve', args: { spender: diamond, amount: approvalBetween(amount, amount, why) } }),
    },
    {
      id: `b-fund${suffix}`,
      role: 'borrower',
      kind: 'tx',
      purpose: `fundExtendReserve(${loanId}, ${amount})`,
      expected: tx(diamond, { functionName: 'fundExtendReserve', args: { loanId: BigInt(loanId), amount } }),
    },
  ];
}

/** The withdrawal of the whole reserve, as the app sends it. */
export function withdrawStep({ suffix = '', borrower, diamond, loanId, amount, chainId, where }) {
  return {
    id: `b-withdraw${suffix}`,
    role: 'borrower',
    kind: 'tx',
    purpose: `withdrawExtendReserve(borrower, ${loanId}, ${amount}) from ${where}`,
    expected: expectedTx({
      from: borrower,
      to: diamond,
      call: { functionName: 'withdrawExtendReserve', args: { account: borrower, loanId: BigInt(loanId), amount } },
      chainId,
    }),
  };
}

/** The drive's whole plan, in order. */
export function autoExtendPlanSteps({ borrower, lender, diamond, asset, loanId, amount, chainId, borrowerCaps, lenderCaps }) {
  const capsStep = (side, who, caps) => ({
    id: side === 'borrower' ? 'b-caps' : 'l-caps',
    role: side,
    kind: 'tx',
    purpose: `${side === 'borrower' ? 'setAutoExtendBorrowerCaps' : 'setAutoExtendLenderCaps'}(${loanId}, …) — the ${side}'s limits`,
    expected: expectedTx({ from: who, to: diamond, call: expectedCapsCall({ side, loanId, ...caps }), chainId }),
  });
  const common = { borrower, diamond, loanId, amount, chainId };
  return [
    capsStep('borrower', borrower, borrowerCaps),
    capsStep('lender', lender, lenderCaps),
    ...fundSteps({ ...common, asset }),
    withdrawStep({ ...common, where: 'the loan page' }),
    ...fundSteps({ ...common, asset, suffix: '-2' }),
    withdrawStep({ ...common, suffix: '-2', where: 'Claims' }),
  ];
}

// ── The app's formatting, mirrored ───────────────────────────────────────

/** src/lib/format.ts formatBpsAsPercent. */
export function formatBpsAsPercent(bps) {
  return `${Number((Number(bps) / 100).toFixed(2))}%`;
}

/** src/lib/format.ts formatTokenAmount (maxFraction 4). */
export function formatTokenAmount(raw, decimals) {
  const asString = formatUnits(BigInt(raw), decimals);
  const num = Number(asString);
  if (!Number.isFinite(num)) return asString;
  if (num !== 0 && Math.abs(num) < 1) return num.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** src/lib/format.ts formatTokenAmountExact. */
export function formatTokenAmountExact(raw, decimals) {
  const value = BigInt(raw);
  if (value < 0n) return `-${formatTokenAmountExact(-value, decimals)}`;
  const [int, frac = ''] = formatUnits(value, decimals).split('.');
  const intText = BigInt(int).toLocaleString('en-US');
  return frac ? `${intText}.${frac}` : intText;
}

/** Fill an i18next `{{name}}` template. A placeholder with no value throws,
 *  so a renamed key cannot quietly compare against a half-filled line. */
export function fill(template, values = {}) {
  if (typeof template !== 'string') throw new Error(`not a template: ${JSON.stringify(template)}`);
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`template value "${k}" missing for: ${template}`);
    return String(values[k]);
  });
}

/** Whitespace-collapsed text, as the page's innerText is compared. */
export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The reserve panel's four figure lines, each against the template it is
 * built from. `candidates` maps a figure to EVERY value the chain gave it
 * across the reads that bracket the page read (an accruing charge can move
 * between two reads), and a line passes when it equals the template filled
 * with any one of them. Returns the lines that match none.
 */
export function reserveFigureMismatches(lines, templates, candidates, decimals, symbol) {
  const text = lines.map(squash);
  const out = [];
  for (const key of ['reserved', 'otherFree', 'chargeNow', 'chargeAtEnd']) {
    const options = [...new Set((candidates[key] ?? []).map((v) => fill(templates[key], { amount: `${formatTokenAmount(v, decimals)} ${symbol}` })))];
    if (!options.some((o) => text.includes(squash(o)))) {
      out.push(`${key}: want one of ${options.map((o) => JSON.stringify(o)).join(' / ')}; the panel lists ${JSON.stringify(text)}`);
    }
  }
  return out;
}

/**
 * The one indexer row a deposit must produce: kind ExtendReserveFunded,
 * this loan, filed under the depositor, from the deposit's own transaction.
 */
export function fundedRowFor(events, { loanId, txHash, holder }) {
  return (Array.isArray(events) ? events : []).find(
    (e) =>
      e?.kind === 'ExtendReserveFunded' &&
      Number(e.loanId) === Number(loanId) &&
      String(e.txHash).toLowerCase() === String(txHash).toLowerCase() &&
      String(e.actor ?? '').toLowerCase() === String(holder).toLowerCase(),
  ) ?? null;
}
