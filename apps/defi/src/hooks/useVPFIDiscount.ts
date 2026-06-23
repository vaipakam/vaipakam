import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { useWallet } from '../context/WalletContext';
import { useProtocolConfig } from './useProtocolConfig';
import { beginStep } from '../lib/journeyLog';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Default decimals scale used when a caller hasn't threaded the live
 *  `vpfiDecimals` from `useProtocolConfig` yet. Every Vaipakam VPFI
 *  deploy uses 18 by OFT-mesh requirement, so the fallback matches
 *  contract truth on every chain. Hooks that have access to the live
 *  config should pass `decimals` explicitly. */
const VPFI_DECIMALS_DEFAULT = 18;

function decimalsScale(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

export interface VPFIDiscountQuote {
  /** True iff the diamond could produce a full quote for this offer. */
  eligible: boolean;
  /** VPFI (18-dec) the borrower must hold in vault for the discount. */
  vpfiRequired: bigint;
  /**
   * Known-borrower vault VPFI balance. Only meaningful for borrower-side
   * offers (creator is the borrower). Zero for lender-side offers — the
   * borrower isn't known until acceptance.
   */
  borrowerVaultBal: bigint;
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
      const [eligible, vpfiRequired, borrowerVaultBal, tier] = result;
      setQuote({
        eligible,
        vpfiRequired,
        borrowerVaultBal,
        tier: Number(tier),
      });
    } catch {
      setQuote({
        eligible: false,
        vpfiRequired: 0n,
        borrowerVaultBal: 0n,
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
  /** Effective tier (post-min-history-gate). 0..4. 0 = no discount. */
  tier: number;
  /** T-087 Sub 4 round-1 P2 #1 — RAW tier from VAULT balance
   *  (`tierOf(vaultBal)`), pre-min-history gate. */
  rawTier: number;
  /** T-087 Sub 4 round-3 P2 #1 — RAW tier from TRACKED balance
   *  (`tierOf(trackedBal)`), pre-min-history gate. This is the
   *  load-bearing signal for the min-history-pending check —
   *  excludes direct-transfer dust the accumulator ignores. */
  trackedTier: number;
  /** User's current VPFI vault balance (18-dec). */
  vaultBal: bigint;
  /** T-087 Sub 4 round-2 P2 — protocol-tracked VPFI balance. */
  trackedBal: bigint;
  /** Discount basis points (e.g. 1000 = 10% off the normal fee). */
  discountBps: number;
}

/**
 * Discount tier for `user` — reads `VPFIDiscountFacet.getEffectiveDiscount`
 * for the post-gate EFFECTIVE_TIER + EFFECTIVE_BPS the fee path actually
 * applies (T-087 Sub 1.D), AND `getVPFIDiscountTier` for the vault VPFI
 * balance display. Returns tier 0 when no wallet is connected.
 *
 * Codex Sub 1.D round-2 P2 caught that the previous `getVPFIDiscountTier`
 * read (raw vault-balance tier) let `BuyVPFI`'s `DiscountStatusCard`
 * promise a discount the user could not yet claim during the min-history
 * window. Reading via `getEffectiveDiscount` keeps the displayed tier
 * aligned with the on-chain settlement behaviour.
 */
export function useVPFIDiscountTier(user: string | null) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
  const [data, setData] = useState<VPFIDiscountTier | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setData({
        tier: 0,
        rawTier: 0,
        trackedTier: 0,
        vaultBal: 0n,
        trackedBal: 0n,
        discountBps: 0,
      });
      return;
    }
    setLoading(true);
    try {
      const [effective, raw, tracked] = await Promise.all([
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getEffectiveDiscount',
          args: [user as Address],
        }) as Promise<readonly [number, number]>,
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getVPFIDiscountTier',
          args: [user as Address],
        }) as Promise<readonly [bigint, bigint, bigint]>,
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getTrackedVPFIDiscountTier',
          args: [user as Address],
        }) as Promise<readonly [bigint, bigint, bigint]>,
      ]);
      const [effTier, effBps] = effective;
      const [rawTier, vaultBal] = raw;
      const [trackedTier, trackedBal] = tracked;
      setData({
        tier: Number(effTier),
        rawTier: Number(rawTier),
        trackedTier: Number(trackedTier),
        vaultBal,
        trackedBal,
        discountBps: Number(effBps),
      });
    } catch {
      setData({
        tier: 0,
        rawTier: 0,
        trackedTier: 0,
        vaultBal: 0n,
        trackedBal: 0n,
        discountBps: 0,
      });
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
    const t = config.tierThresholdsTokens;
    const d = config.tierDiscountBps;
    // `tierThresholdsTokens` is the inclusive minimum VPFI (whole tokens)
    // for entering each tier — already divided down from the on-chain
    // wei representation by `useProtocolConfig` so we don't render an
    // 18-decimal-too-large number here.
    //
    // The previous static table used a `0.000001` gap between tiers
    // (e.g. T1 max = 999.999999, T2 min = 1000) so ranges read
    // continuously without overlap; preserve that.
    const epsilon = 0.000001;
    const tier1Min = t[0];
    const tier2Min = t[1];
    const tier3Min = t[2];
    const tier4Min = t[3];
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
 * T-087 Sub 4 round-3 P2 #3 — consent reader for an ARBITRARY user
 * address. The connected-wallet variant `useVPFIDiscountConsent`
 * isn't safe to mix with another user's tier data: after a position
 * NFT transfer, the holder's wallet differs from the loan's lender,
 * and gating the lender-discount banner on the holder's consent
 * surfaces the wrong promise. Use this hook whenever you need the
 * consent for a specific user (not "me").
 */
export function useVPFIDiscountConsentFor(user: string | null) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setEnabled(null);
      return;
    }
    setLoading(true);
    try {
      const v = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: 'getVPFIDiscountConsent',
        args: [user as Address],
      })) as boolean;
      setEnabled(v);
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, [publicClient, diamondAddress, user]);

  useEffect(() => {
    load();
  }, [load]);

  return { enabled, loading, reload: load };
}

/**
 * Platform-level consent flag for using vaulted VPFI on fee discounts.
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

/** Convert a VPFI wei amount to a JS number using the supplied
 *  `decimals`. Defaults to 18 (matches every Vaipakam VPFI deploy on
 *  every chain — see `useProtocolConfig.vpfiDecimals` for the live
 *  read; pass that value explicitly when available so a hypothetical
 *  future redeploy with different decimals flows through). */
export function formatVpfiUnits(
  v: bigint | null | undefined,
  decimals: number = VPFI_DECIMALS_DEFAULT,
): number {
  if (v == null) return 0;
  return Number(v) / Number(decimalsScale(decimals));
}

/**
 * Convenience: returns the VPFI balance the connected wallet currently holds
 * in its vault on the active chain. `null` when no wallet, no vault, or
 * the VPFI token isn't registered. Not cached — callers should gate reads
 * themselves if they need to poll.
 */
export function useVaultVPFIBalance(user: string | null) {
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
      const [vault, token] = await Promise.all([
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getUserVault',
          args: [user as Address],
        }) as Promise<string>,
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI,
          functionName: 'getVPFIToken',
        }) as Promise<string>,
      ]);
      if (!vault || vault === ZERO_ADDRESS || !token || token === ZERO_ADDRESS) {
        setBalance(0n);
        return;
      }
      const raw = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: 'getVPFIBalanceOf',
        args: [vault as Address],
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
