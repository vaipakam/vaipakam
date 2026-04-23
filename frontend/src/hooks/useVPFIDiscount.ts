import { useCallback, useEffect, useMemo, useState } from 'react';
import { Contract, JsonRpcProvider } from 'ethers';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { useWallet } from '../context/WalletContext';
import { beginStep } from '../lib/journeyLog';
import { DIAMOND_ABI } from '../contracts/abis';
import type { ChainConfig } from '../contracts/config';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SCALE_18 = 1_000_000_000_000_000_000n;
const STALE_MS = 30_000;

/**
 * Current VPFI buy-side config + running totals, plus the caller's
 * per-wallet purchased tally. Mirrors `VPFIDiscountFacet.getVPFIBuyConfig`
 * with wallet-scoped additions.
 */
export interface VPFIBuyConfig {
  /** ETH wei accepted per 1 VPFI (18-dec). 0 when rate is unset. */
  weiPerVpfi: bigint;
  /**
   * Effective global cap on VPFI sold at fixed rate (18-dec). Always a
   * positive value — the on-chain getter resolves a stored zero to the
   * 2.3M spec default (docs/TokenomicsTechSpec.md §8). No "uncapped" mode.
   */
  globalCap: bigint;
  /**
   * Effective per-wallet cap on VPFI buys (18-dec). Always a positive
   * value — the on-chain getter resolves a stored zero to the 30k spec
   * default (docs/TokenomicsTechSpec.md §8a).
   */
  perWalletCap: bigint;
  /** Cumulative VPFI sold at fixed rate. */
  totalSold: bigint;
  /** True iff the buy path is currently open. */
  enabled: boolean;
  /** ERC-20 used as the ETH/USD reference asset for discount quotes. */
  ethPriceAsset: string;
  /** Cumulative VPFI the connected wallet has purchased. 0 when no wallet. */
  soldToWallet: bigint;
  /** Remaining headroom for this wallet (perWalletCap - soldToWallet, clamped ≥0). */
  walletHeadroom: bigint;
  /** Remaining headroom globally (globalCap - totalSold, clamped ≥0). */
  globalHeadroom: bigint;
  /** True iff buy path is live (enabled AND rate set AND headroom remains). */
  canBuy: boolean;
  fetchedAt: number;
}

interface CacheEntry {
  data: VPFIBuyConfig;
  at: number;
  key: string;
}

let cached: CacheEntry | null = null;

/**
 * Wallet-aware view over the VPFI fixed-rate buy mechanism. Used by the
 * Buy VPFI page and by CreateOffer / LoanDetails banners to decide whether
 * to show the discount CTA. Safe to call without a wallet connected —
 * `soldToWallet` will be zero.
 *
 * Caches under chainId + diamond + wallet for {@link STALE_MS} so multiple
 * consumers on the same page don't thrash the RPC.
 *
 * @param chainOverride When set, read the buy config from this chain's
 *   Diamond instead of the wallet's active chain. Required for the bridged
 *   buy flow: the fixed-rate and caps are stored only on the canonical
 *   chain's Diamond, so a Sepolia-origin user who wants to bridge-buy must
 *   read the canonical (Base Sepolia) state to see a non-zero `weiPerVpfi`.
 *   When omitted, the active chain's Diamond is used (the historical
 *   behavior, correct for the direct canonical-chain buy).
 */
export function useVPFIDiscount(chainOverride?: ChainConfig | null) {
  const defaultDiamond = useDiamondRead();
  const defaultChain = useReadChain();
  const { address } = useWallet();
  const overrideDiamond = useMemo(() => {
    if (!chainOverride || !chainOverride.diamondAddress) return null;
    const provider = new JsonRpcProvider(chainOverride.rpcUrl);
    return new Contract(chainOverride.diamondAddress, DIAMOND_ABI, provider);
    // Intentionally depend on the two stable primitive fields rather than
    // the `chainOverride` object reference — callers often pass a freshly
    // constructed ChainConfig each render (e.g. `getCanonicalVPFIChain()`),
    // which would otherwise invalidate the memo every render and recreate
    // the Contract/provider on every call. The primitive deps ARE the
    // invariant we actually care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainOverride?.rpcUrl, chainOverride?.diamondAddress]);
  const diamond = overrideDiamond ?? defaultDiamond;
  const chain =
    chainOverride && chainOverride.diamondAddress ? chainOverride : defaultChain;
  const cacheKey = `${chain.chainId}:${(chain.diamondAddress ?? 'none').toLowerCase()}:${(address ?? 'none').toLowerCase()}`;

  const [config, setConfig] = useState<VPFIBuyConfig | null>(() =>
    cached && cached.key === cacheKey ? cached.data : null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (cached && cached.key === cacheKey && Date.now() - cached.at < STALE_MS) {
      setConfig(cached.data);
      setLoading(false);
      return;
    }
    // Clear any config belonging to a different cacheKey so a stale
    // zero-rate from the previous chain/wallet doesn't flash a false
    // "not configured" banner while the fresh fetch is in flight.
    setConfig(null);
    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'vpfi-buy', flow: 'useVPFIDiscount', step: 'readConfig' });
    try {
      const d = diamond as unknown as {
        getVPFIBuyConfig: () => Promise<
          [bigint, bigint, bigint, bigint, boolean, string]
        >;
        getVPFISoldTo: (user: string) => Promise<bigint>;
      };
      const [tuple, soldToWallet] = await Promise.all([
        d.getVPFIBuyConfig(),
        address ? d.getVPFISoldTo(address) : Promise.resolve(0n),
      ]);
      const [weiPerVpfi, globalCap, perWalletCap, totalSold, enabled, ethPriceAsset] =
        tuple;

      // Caps arrive pre-resolved (stored zero → spec default) from
      // VPFIDiscountFacet.getVPFIBuyConfig, so we can compute headroom
      // unconditionally.
      const globalHeadroom =
        globalCap > totalSold ? globalCap - totalSold : 0n;
      const walletHeadroom =
        perWalletCap > soldToWallet ? perWalletCap - soldToWallet : 0n;
      const canBuy =
        enabled &&
        weiPerVpfi > 0n &&
        globalHeadroom > 0n &&
        walletHeadroom > 0n;

      const next: VPFIBuyConfig = {
        weiPerVpfi,
        globalCap,
        perWalletCap,
        totalSold,
        enabled,
        ethPriceAsset,
        soldToWallet,
        walletHeadroom,
        globalHeadroom,
        canBuy,
        fetchedAt: Date.now(),
      };
      cached = { data: next, at: Date.now(), key: cacheKey };
      setConfig(next);
      step.success({
        note: `rate=${weiPerVpfi}, enabled=${enabled}, sold=${totalSold}, wallet=${soldToWallet}`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, cacheKey, address]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cached = null;
    await load();
  }, [load]);

  return { config, loading, error, reload };
}

export interface VPFIDiscountQuote {
  /** True iff the diamond could produce a full quote for this offer. */
  eligible: boolean;
  /** VPFI (18-dec) the borrower must hold in escrow for the discount. */
  vpfiRequired: bigint;
  /**
   * Known-borrower escrow VPFI balance. Only meaningful for borrower-side
   * offers (creator is the borrower). Zero for lender-side offers — the
   * borrower isn't known until acceptance.
   */
  borrowerEscrowBal: bigint;
  /** Resolved tier 0..4. 0 means no discount / quote unavailable. */
  tier: number;
}

/**
 * Pre-flight quote helper wrapping `VPFIDiscountFacet.quoteVPFIDiscount` (or
 * the acceptor-aware `quoteVPFIDiscountFor` when `borrower` is supplied, which
 * is how LENDER offers surface a tier-aware quote for the connected wallet).
 * Never throws — returns an ineligible quote when the view reverts or the
 * offer is unknown.
 */
export function useVPFIDiscountQuote(
  offerId: bigint | null,
  borrower?: string | null,
) {
  const diamond = useDiamondRead();
  const [quote, setQuote] = useState<VPFIDiscountQuote | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (offerId == null) {
      setQuote(null);
      return;
    }
    setLoading(true);
    try {
      const d = diamond as unknown as {
        quoteVPFIDiscount: (
          id: bigint,
        ) => Promise<[boolean, bigint, bigint, bigint]>;
        quoteVPFIDiscountFor: (
          id: bigint,
          user: string,
        ) => Promise<[boolean, bigint, bigint, bigint]>;
      };
      const [eligible, vpfiRequired, borrowerEscrowBal, tier] =
        borrower && borrower !== ZERO_ADDRESS
          ? await d.quoteVPFIDiscountFor(offerId, borrower)
          : await d.quoteVPFIDiscount(offerId);
      setQuote({
        eligible,
        vpfiRequired,
        borrowerEscrowBal,
        tier: Number(tier),
      });
    } catch {
      setQuote({
        eligible: false,
        vpfiRequired: 0n,
        borrowerEscrowBal: 0n,
        tier: 0,
      });
    } finally {
      setLoading(false);
    }
  }, [diamond, offerId, borrower]);

  useEffect(() => {
    load();
  }, [load]);

  return { quote, loading, reload: load };
}

export interface VPFIDiscountTier {
  /** 0..4. 0 means no discount. */
  tier: number;
  /** User's current VPFI escrow balance (18-dec). */
  escrowBal: bigint;
  /** Discount basis points (e.g. 1000 = 10% off the normal fee). */
  discountBps: number;
}

/**
 * Discount tier for `user` — reads `VPFIDiscountFacet.getVPFIDiscountTier`.
 * Pure VPFI-escrow-balance lookup, no oracle dependency. Returns tier 0 when
 * no wallet is connected.
 */
export function useVPFIDiscountTier(user: string | null) {
  const diamond = useDiamondRead();
  const [data, setData] = useState<VPFIDiscountTier | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setData({ tier: 0, escrowBal: 0n, discountBps: 0 });
      return;
    }
    setLoading(true);
    try {
      const d = diamond as unknown as {
        getVPFIDiscountTier: (
          u: string,
        ) => Promise<[bigint, bigint, bigint]>;
      };
      const [tier, escrowBal, discountBps] = await d.getVPFIDiscountTier(user);
      setData({
        tier: Number(tier),
        escrowBal,
        discountBps: Number(discountBps),
      });
    } catch {
      setData({ tier: 0, escrowBal: 0n, discountBps: 0 });
    } finally {
      setLoading(false);
    }
  }, [diamond, user]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, reload: load };
}

/**
 * Tier metadata (label + thresholds) so UI can render the tier table without
 * re-encoding the on-chain constants. Bounds are VPFI (18-dec), inclusive
 * unless noted.
 */
export const VPFI_TIER_TABLE: ReadonlyArray<{
  tier: number;
  label: string;
  minVpfi: number;
  maxVpfi: number | null; // null = open-ended (Tier 4)
  discountLabel: string;
  borrowerFeeLabel: string;
  lenderFeeLabel: string;
}> = [
  {
    tier: 1,
    label: 'Tier 1',
    minVpfi: 100,
    maxVpfi: 999.999999,
    discountLabel: '10% off',
    borrowerFeeLabel: '0.09% loan fee',
    lenderFeeLabel: '0.9% yield fee',
  },
  {
    tier: 2,
    label: 'Tier 2',
    minVpfi: 1_000,
    maxVpfi: 4_999.999999,
    discountLabel: '15% off',
    borrowerFeeLabel: '0.085% loan fee',
    lenderFeeLabel: '0.85% yield fee',
  },
  {
    tier: 3,
    label: 'Tier 3',
    minVpfi: 5_000,
    maxVpfi: 20_000,
    discountLabel: '20% off',
    borrowerFeeLabel: '0.08% loan fee',
    lenderFeeLabel: '0.8% yield fee',
  },
  {
    tier: 4,
    label: 'Tier 4',
    minVpfi: 20_000.000001,
    maxVpfi: null,
    discountLabel: '24% off',
    borrowerFeeLabel: '0.076% loan fee',
    lenderFeeLabel: '0.76% yield fee',
  },
];

/**
 * Convenience: returns the VPFI balance the connected wallet currently holds
 * in its escrow on the active chain. `null` when no wallet, no escrow, or
 * the VPFI token isn't registered. Not cached — callers should gate reads
 * themselves if they need to poll.
 */
export function useEscrowVPFIBalance(user: string | null) {
  const diamond = useDiamondRead();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setBalance(null);
      return;
    }
    setLoading(true);
    try {
      const d = diamond as unknown as {
        getUserEscrow: { staticCall: (user: string) => Promise<string> };
        getVPFIToken: () => Promise<string>;
      };
      const [escrow, token] = await Promise.all([
        d.getUserEscrow.staticCall(user),
        d.getVPFIToken(),
      ]);
      if (!escrow || escrow === ZERO_ADDRESS || !token || token === ZERO_ADDRESS) {
        setBalance(0n);
        return;
      }
      const d2 = diamond as unknown as {
        getVPFIBalanceOf: (a: string) => Promise<bigint>;
      };
      const raw = await d2.getVPFIBalanceOf(escrow);
      setBalance(raw);
    } catch {
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, [diamond, user]);

  useEffect(() => {
    load();
  }, [load]);

  return { balance, loading, reload: load };
}

/**
 * Read + write the platform-level VPFI-discount consent flag for the caller.
 * When enabled, the protocol automatically applies borrower Loan Initiation
 * Fee and lender Yield Fee discounts whenever the caller's escrow holds
 * sufficient VPFI. One consent governs both legs — there is no per-offer or
 * per-loan opt-in.
 *
 * The hook hydrates from `getVPFIDiscountConsent(address)` and exposes a
 * `setConsent(enabled)` helper that submits the mutating tx and refreshes
 * local state on confirmation.
 */
export function useVPFIDiscountConsent() {
  const diamond = useDiamondRead();
  const { signer, address } = useWallet();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address) {
      setEnabled(null);
      return;
    }
    setLoading(true);
    try {
      const d = diamond as unknown as {
        getVPFIDiscountConsent: (u: string) => Promise<boolean>;
      };
      const v = await d.getVPFIDiscountConsent(address);
      setEnabled(v);
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, [diamond, address]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Mutate the platform-level consent flag.
   * @param next         Target value (true = opt in, false = opt out).
   * @param writeDiamond Write-capable diamond contract instance bound to
   *                     the connected signer (caller provides; the hook
   *                     deliberately does not own write access).
   */
  const setConsent = useCallback(
    async (next: boolean, writeDiamond: unknown) => {
      if (!signer || !writeDiamond) return;
      setError(null);
      setSaving(true);
      const step = beginStep({
        area: 'vpfi-buy',
        flow: 'setVPFIDiscountConsent',
        step: 'submit',
      });
      try {
        const d = writeDiamond as unknown as {
          setVPFIDiscountConsent: (
            v: boolean,
          ) => Promise<{ wait: () => Promise<unknown> }>;
        };
        const tx = await d.setVPFIDiscountConsent(next);
        await tx.wait();
        setEnabled(next);
        step.success({ note: `enabled=${next}` });
      } catch (err) {
        setError((err as Error)?.message ?? 'Consent update failed');
        step.failure(err);
      } finally {
        setSaving(false);
      }
    },
    [signer],
  );

  return { enabled, loading, saving, error, reload: load, setConsent };
}

/** Convert VPFI wei amount (18-dec) to a JS number. */
export function formatVpfiUnits(v: bigint | null | undefined): number {
  if (v == null) return 0;
  return Number(v) / 1e18;
}

/** Compute ETH wei needed to receive exactly `vpfiOut` VPFI at `weiPerVpfi`. */
export function vpfiToEthWei(vpfiOut: bigint, weiPerVpfi: bigint): bigint {
  if (weiPerVpfi === 0n) return 0n;
  return (vpfiOut * weiPerVpfi) / SCALE_18;
}

/** Compute VPFI out (18-dec) received for `ethWei` at `weiPerVpfi`. */
export function ethWeiToVpfi(ethWei: bigint, weiPerVpfi: bigint): bigint {
  if (weiPerVpfi === 0n) return 0n;
  return (ethWei * SCALE_18) / weiPerVpfi;
}

/** Test-only: clear the module-scoped cache. */
export function __clearVPFIDiscountCache() {
  cached = null;
}
