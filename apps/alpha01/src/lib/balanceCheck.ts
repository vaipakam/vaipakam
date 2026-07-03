import { formatUnits, parseUnits } from 'viem';
import type { SpendableBalance } from '../hooks/useSpendableBalance';
import { trimFraction } from './formatAsset';
import type { TokenMeta } from './tokenMeta';

export interface AssetQuantity {
  amount: string;
  mode: 'human' | 'raw';
  address: string;
  meta: TokenMeta | null;
}

export interface CollateralBalanceAssessment {
  sufficient: boolean | null;
  loading: boolean;
  available: AssetQuantity | null;
  shortfall: { need: AssetQuantity; have: AssetQuantity } | null;
}

export function parseHumanAmount(amount: string, decimals: number): bigint | null {
  const trimmed = amount.trim();
  if (!trimmed || Number(trimmed) <= 0) return null;
  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return null;
  }
}

function parseRawAmount(raw: string): bigint | null {
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export function assessCollateralBalance(opts: {
  needHuman: string;
  needRaw?: string;
  balance: SpendableBalance | undefined;
  tokenAddress: string;
  meta: TokenMeta | null;
  chainId: number;
  loading: boolean;
}): CollateralBalanceAssessment {
  if (opts.loading) {
    return { sufficient: null, loading: true, available: null, shortfall: null };
  }
  if (!opts.balance) {
    return { sufficient: null, loading: false, available: null, shortfall: null };
  }

  const need =
    parseHumanAmount(opts.needHuman, opts.balance.decimals) ??
    (opts.needRaw ? parseRawAmount(opts.needRaw) : null);

  const haveHuman = trimFraction(formatUnits(opts.balance.total, opts.balance.decimals));
  const meta: TokenMeta = opts.meta ?? {
    address: opts.tokenAddress,
    symbol: opts.balance.symbol,
    decimals: opts.balance.decimals,
    chainId: opts.chainId,
  };
  const available: AssetQuantity = {
    amount: haveHuman,
    mode: 'human',
    address: opts.tokenAddress,
    meta,
  };

  if (need == null || need <= 0n) {
    return { sufficient: null, loading: false, available, shortfall: null };
  }

  if (opts.balance.total >= need) {
    return { sufficient: true, loading: false, available, shortfall: null };
  }

  const needQuantity: AssetQuantity = opts.needRaw
    ? { amount: opts.needRaw, mode: 'raw', address: opts.tokenAddress, meta: opts.meta }
    : { amount: opts.needHuman, mode: 'human', address: opts.tokenAddress, meta: opts.meta };

  return {
    sufficient: false,
    loading: false,
    available,
    shortfall: {
      need: needQuantity,
      have: { amount: haveHuman, mode: 'human', address: opts.tokenAddress, meta },
    },
  };
}