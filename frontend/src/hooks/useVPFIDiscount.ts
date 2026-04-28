import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { useWallet } from '../context/WalletContext';
import { useProtocolConfig } from './useProtocolConfig';
import { beginStep } from '../lib/journeyLog';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
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
  const defaultClient = useDiamondPublicClient();
  const defaultChain = useReadChain();
  const { address } = useWallet();
  const overrideClient = useMemo<PublicClient | null>(() => {
    if (!chainOverride || !chainOverride.diamondAddress) return null;
    return createPublicClient({
      transport: http(chainOverride.rpcUrl),
    }) as PublicClient;
    // Intentionally depend on the two stable primitive fields rather than
    // the `chainOverride` object reference — callers often pass a freshly
    // constructed ChainConfig each render (e.g. `getCanonicalVPFIChain()`),
    // which would otherwise invalidate the memo every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainOverride?.rpcUrl, chainOverride?.diamondAddress]);
  const publicClient = overrideClient ?? defaultClient;
  const chain =
    chainOverride && chainOverride.diamondAddress ? chainOverride : defaultChain;
  const diamondAddress = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
  // Cache key includes the wallet's ORIGIN chain (defaultChain.lzEid)
  // because the per-wallet cap bucket is keyed on the origin chain.
  // Otherwise two users on different origin chains hitting the same
  // canonical-override read would share a cached `soldToWallet` from
  // the wrong bucket.
  const cacheKey = `${chain.chainId}:${(chain.diamondAddress ?? 'none').toLowerCase()}:${(address ?? 'none').toLowerCase()}:eid${defaultChain.lzEid ?? 'na'}`;

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
      // Per-wallet cap is bucketed by **origin chain** on the canonical
      // Diamond (per docs/TokenomicsTechSpec.md §8a + the on-chain
      // {VPFIDiscountFacet._computeBuyAndDebitCaps} debit path). For a
      // mirror-chain bridged buy, the canonical Diamond debits the bucket
      // keyed on the user's ORIGIN chain eid (carried in the OFT message),
      // not on the canonical chain's local eid. The historical
      // {getVPFISoldTo(user)} returned the canonical chain's local-eid
      // bucket — wrong for mirror buys, where it can show "remaining
      // allowance" while the user's actual origin-chain bucket is already
      // exhausted, leading to a Base-side refund/revert.
      //
      // Resolve the origin eid from `defaultChain` (the wallet's connected
      // chain), regardless of any `chainOverride` used to read config from
      // the canonical Diamond. When the eid is null (e.g. testnet entry
      // without LZ wired) we read the legacy single-key getter so we don't
      // start probing eid=0 unintentionally.
      const originEid = defaultChain.lzEid ?? null;
      const soldToPromise: Promise<bigint> = !address
        ? Promise.resolve(0n)
        : originEid !== null
        ? (publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI,
            functionName: 'getVPFISoldToByEid',
            args: [address as Address, originEid],
          }) as Promise<bigint>)
        : (publicClient.readContract({
            address: diamondAddress,
            abi: DIAMOND_ABI,
            functionName: 'getVPFISoldTo',
            args: [address as Address],
          }) as Promise<bigint>);
      const [tuple, soldToWallet] = await Promise.all([
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getVPFIBuyConfig',
        }) as Promise<readonly [bigint, bigint, bigint, bigint, boolean, string]>,
        soldToPromise,
      ]);
      const [weiPerVpfi, globalCap, perWalletCap, totalSold, enabled, ethPriceAsset] = tuple;

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
  }, [publicClient, diamondAddress, cacheKey, address]);

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
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
  const [quote, setQuote] = useState<VPFIDiscountQuote | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (offerId == null) {
      setQuote(null);
      return;
    }
    setLoading(true);
    try {
      const useAcceptor = borrower && borrower !== ZERO_ADDRESS;
      const result = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: useAcceptor ? 'quoteVPFIDiscountFor' : 'quoteVPFIDiscount',
        args: useAcceptor ? [offerId, borrower as Address] : [offerId],
      })) as readonly [boolean, bigint, bigint, bigint];
      const [eligible, vpfiRequired, borrowerEscrowBal, tier] = result;
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
  }, [publicClient, diamondAddress, offerId, borrower]);

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
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
  const [data, setData] = useState<VPFIDiscountTier | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setData({ tier: 0, escrowBal: 0n, discountBps: 0 });
      return;
    }
    setLoading(true);
    try {
      const result = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: 'getVPFIDiscountTier',
        args: [user as Address],
      })) as readonly [bigint, bigint, bigint];
      const [tier, escrowBal, discountBps] = result;
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
  }, [publicClient, diamondAddress, user]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, reload: load };
}

/**
 * Per-tier metadata for the VPFI discount table. Was previously a static
 * `VPFI_TIER_TABLE` export with hardcoded 100 / 1k / 5k / 20k thresholds
 * and 10 / 15 / 20 / 24% discounts; that drifted from the on-chain values
 * the moment governance called `setVpfiTierThresholds` or
 * `setVpfiTierDiscountBps`. The hook derives every field from live
 * {@link useProtocolConfig} reads so the table always matches the
 * deployed contract.
 *
 * Returns an empty array until the protocol-config snapshot loads (the
 * first paint is briefly empty rather than showing stale defaults). UI
 * callers should treat the loading window as a no-op.
 */
export interface VpfiTierRow {
  tier: number;
  label: string;
  minVpfi: number;
  maxVpfi: number | null; // null = open-ended (Tier 4)
  discountLabel: string;
}

export function useVpfiTierTable(): ReadonlyArray<VpfiTierRow> {
  const { config } = useProtocolConfig();
  return useMemo<ReadonlyArray<VpfiTierRow>>(() => {
    if (!config) return [];
    const t = config.tierThresholds;
    const d = config.tierDiscountBps;
    // `tierThresholds` is the inclusive minimum VPFI (whole tokens) for
    // entering each tier. The previous static table used a `0.000001`
    // gap between tiers (e.g. T1 max = 999.999999, T2 min = 1000) so
    // ranges read continuously without overlap; preserve that.
    const epsilon = 0.000001;
    const tier1Min = Number(t[0]);
    const tier2Min = Number(t[1]);
    const tier3Min = Number(t[2]);
    const tier4Min = Number(t[3]);
    const fmtPct = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(2).replace(/\.?0+$/, '')}% off`;
    return [
      {
        tier: 1,
        label: 'Tier 1',
        minVpfi: tier1Min,
        maxVpfi: tier2Min - epsilon,
        discountLabel: fmtPct(d[0]),
      },
      {
        tier: 2,
        label: 'Tier 2',
        minVpfi: tier2Min,
        maxVpfi: tier3Min - epsilon,
        discountLabel: fmtPct(d[1]),
      },
      {
        tier: 3,
        label: 'Tier 3',
        minVpfi: tier3Min,
        maxVpfi: tier4Min - epsilon,
        discountLabel: fmtPct(d[2]),
      },
      {
        tier: 4,
        label: 'Tier 4',
        minVpfi: tier4Min,
        maxVpfi: null,
        discountLabel: fmtPct(d[3]),
      },
    ];
  }, [config]);
}

/**
 * Platform-level consent flag for using escrowed VPFI on fee discounts.
 * Reads `getVPFIDiscountConsent(user)` for display, mutates via
 * `setVPFIDiscountConsent(bool)` — caller supplies a write-capable ethers
 * contract (kept that way until the write-path migration lands; the hook
 * deliberately does not own write access).
 */
export function useVPFIDiscountConsent() {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
  const { address } = useWallet();
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
      const v = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: 'getVPFIDiscountConsent',
        args: [address as Address],
      })) as boolean;
      setEnabled(v);
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, [publicClient, diamondAddress, address]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Mutate the platform-level consent flag.
   * @param next         Target value (true = opt in, false = opt out).
   * @param writeDiamond Diamond handle bound to a connected wallet
   *                     (caller provides; the hook deliberately does not
   *                     own write access so callers can share a single
   *                     `useDiamondContract()` with the rest of the page).
   */
  const setConsent = useCallback(
    async (next: boolean, writeDiamond: unknown) => {
      if (!writeDiamond) return;
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
    [],
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

/**
 * Convenience: returns the VPFI balance the connected wallet currently holds
 * in its escrow on the active chain. `null` when no wallet, no escrow, or
 * the VPFI token isn't registered. Not cached — callers should gate reads
 * themselves if they need to poll.
 */
export function useEscrowVPFIBalance(user: string | null) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setBalance(null);
      return;
    }
    setLoading(true);
    try {
      const [escrow, token] = await Promise.all([
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getUserEscrow',
          args: [user as Address],
        }) as Promise<string>,
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getVPFIToken',
        }) as Promise<string>,
      ]);
      if (!escrow || escrow === ZERO_ADDRESS || !token || token === ZERO_ADDRESS) {
        setBalance(0n);
        return;
      }
      const raw = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: 'getVPFIBalanceOf',
        args: [escrow as Address],
      })) as bigint;
      setBalance(raw);
    } catch {
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, [publicClient, diamondAddress, user]);

  useEffect(() => {
    load();
  }, [load]);

  return { balance, loading, reload: load };
}
