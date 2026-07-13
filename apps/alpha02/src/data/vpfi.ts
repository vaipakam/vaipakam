/**
 * VPFI snapshot for the current read chain + connected wallet, in one
 * react-query round-trip:
 *   - registration (`getVPFIToken`; zero address = the chain can't
 *     accept VPFI yet → the page's availability-first state)
 *   - wallet + vault balances
 *   - effective vs raw discount tier (the fee path applies the
 *     EFFECTIVE tier — a 30-day average behind a 3-day minimum-history
 *     gate — so raw > effective means "still warming up", and the UI
 *     must say so instead of promising the raw tier)
 *   - the platform-level discount consent flag
 *
 * VPFI is 18-decimals on every deploy (OFT-mesh requirement).
 */
import { useQuery } from '@tanstack/react-query';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';

export const VPFI_DECIMALS = 18;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface VpfiSnapshot {
  registered: boolean;
  token: `0x${string}` | null;
  /** Connected wallet's VPFI (0n when disconnected/unregistered). */
  walletBalance: bigint;
  /** Protocol-tracked VPFI in the user's vault (what discounts read). */
  vaultBalance: bigint;
  /** VPFI actually withdrawable — vault balance minus what's
   *  encumbered as loan collateral. Withdrawals above this revert. */
  freeBalance: bigint;
  /** Effective tier (0..4) — what fee settlement actually applies. */
  effectiveTier: number;
  /** Effective discount in bps (e.g. 1000 = 10%). */
  effectiveBps: number;
  /** Raw tier from the tracked vault balance, pre-history-gate. */
  rawTier: number;
  /** Platform-level consent flag; discounts are 0 while false. */
  consent: boolean;
}

export interface VpfiTierRow {
  held: string;
  discount: string;
}

/** LIVE tier table — thresholds and discount bps are admin-tunable
 *  (`setVpfiTierThresholds` / `setVpfiTierDiscountBps`), so the
 *  education table must never hardcode them. Bundle tuple indices 7
 *  (thresholds, VPFI wei) and 8 (discount bps) per apps/defi
 *  useProtocolConfig's BundleTuple. Falls back to the deploy defaults
 *  until the read lands. */
// UX-035 — tiers are `held >= threshold` bands, so the boundary number
// belongs to the HIGHER tier only. Exclusive upper bounds (999 / 4,999 /
// 19,999) keep each threshold in exactly one row instead of showing e.g.
// 5,000 as both the top of one band and the bottom of the next. Sub-100
// holdings (no discount) are called out separately in the page.
const DEFAULT_TIER_ROWS: VpfiTierRow[] = [
  { held: '100 – 999 VPFI', discount: '10%' },
  { held: '1,000 – 4,999 VPFI', discount: '15%' },
  { held: '5,000 – 19,999 VPFI', discount: '20%' },
  { held: '20,000+ VPFI', discount: '24%' },
];

export function useVpfiTierTable(): VpfiTierRow[] {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['vpfiTierTable', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<VpfiTierRow[]> => {
      const bundle = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getProtocolConfigBundle',
      })) as readonly unknown[];
      const thresholds = bundle[7] as readonly [bigint, bigint, bigint, bigint];
      const discounts = bundle[8] as readonly [bigint, bigint, bigint, bigint];
      const fmt = (wei: bigint) =>
        (Number(wei) / 10 ** VPFI_DECIMALS).toLocaleString('en-US', {
          maximumFractionDigits: 0,
        });
      const pct = (bps: bigint) => `${Number(bps) / 100}%`;
      // UX-035 — exclusive upper bound (next threshold minus one whole
      // VPFI) so a boundary value shows in one row only; matches the
      // `held >= threshold` band semantics.
      const oneVpfi = 10n ** BigInt(VPFI_DECIMALS);
      return thresholds.map((min, i) => ({
        held:
          i < 3
            ? `${fmt(min)} – ${fmt(thresholds[(i + 1) as 1 | 2 | 3] - oneVpfi)} VPFI`
            : `${fmt(min)}+ VPFI`,
        discount: pct(discounts[i as 0 | 1 | 2 | 3]),
      }));
    },
  });

  return data ?? DEFAULT_TIER_ROWS;
}

/** LIVE VPFI-token read for submit paths (fail closed with a retry
 *  message) — the cached snapshot can lag a governance registration/
 *  rotation. One helper so address casing, the zero-address meaning,
 *  and the error copy can't drift across call sites. */
export async function readVpfiTokenLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  retryMessage: string,
): Promise<string> {
  try {
    return (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getVPFIToken',
    })) as string;
  } catch {
    throw new Error(retryMessage);
  }
}

/** Cache for the VPFI token address — static in practice (it changes
 *  only via a governance registration/rotation), so re-reading it
 *  every 30s cycle was pure waste. Three escape hatches keep it
 *  honest against exactly those events (Codex rounds 1+2):
 *  - the not-registered (zero) result is NEVER cached, so a later
 *    registration surfaces on the next cycle;
 *  - the deposit path's rotation recovery calls
 *    `clearVpfiTokenCache` before invalidating ['vpfi'];
 *  - a TTL bounds EVERY other path (withdraw's encumbrance read,
 *    the rendered snapshot.token): after a rotation the stale
 *    address self-heals within one TTL without a reload — still
 *    ~10× fewer reads than the old per-cycle shape. */
const VPFI_TOKEN_TTL_MS = 5 * 60_000;

const vpfiTokenCache = new Map<number, { token: `0x${string}`; at: number }>();

export function clearVpfiTokenCache(chainId: number): void {
  vpfiTokenCache.delete(chainId);
}

export function useVpfi() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['vpfi', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(publicClient),
    refetchInterval: idleAware(30_000),
    queryFn: async (): Promise<VpfiSnapshot> => {
      if (!publicClient) throw new Error('unreachable');
      const diamond = readChain.diamondAddress;
      const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName,
          args: args as unknown[],
        }) as Promise<T>;

      // getVPFIToken is deploy-static: one successful read per chain
      // per session (RPC diet — the previous shape re-read it every
      // 30s cycle, including for disconnected visitors, where it was
      // the ONLY on-chain call of the whole cycle). Failures are not
      // cached, so a transient RPC blip can't stick.
      const cached = vpfiTokenCache.get(readChain.chainId);
      let token =
        cached && Date.now() - cached.at < VPFI_TOKEN_TTL_MS
          ? cached.token
          : undefined;
      if (token === undefined) {
        token = await read<`0x${string}`>('getVPFIToken');
        if (token.toLowerCase() !== ZERO_ADDRESS) {
          vpfiTokenCache.set(readChain.chainId, { token, at: Date.now() });
        }
      }
      const registered = token.toLowerCase() !== ZERO_ADDRESS;
      if (!registered || !address) {
        return {
          registered,
          token: registered ? token : null,
          walletBalance: 0n,
          vaultBalance: 0n,
          freeBalance: 0n,
          effectiveTier: 0,
          effectiveBps: 0,
          rawTier: 0,
          consent: false,
        };
      }

      const [walletBalance, effective, tracked, consent, encumbered] =
        await Promise.all([
          read<bigint>('getVPFIBalanceOf', [address]),
          read<readonly [number, number]>('getEffectiveDiscount', [address]),
          read<readonly [bigint, bigint, bigint]>('getTrackedVPFIDiscountTier', [
            address,
          ]),
          read<boolean>('getVPFIDiscountConsent', [address]),
          // VPFI pledged as loan collateral can't be withdrawn. Only a
          // REVERT/zero-data (selector absent on an older deploy) may
          // mean "no encumbrance tracking → 0"; a transport failure is
          // NOT knowledge — treating it as 0 would offer the full
          // balance as withdrawable and burn gas on
          // VPFIEncumberedByActiveLoan. Rethrow → snapshot unavailable.
          read<bigint>('getEncumbered', [address, token, 0n]).catch((err) => {
            const isRevert =
              err instanceof BaseError &&
              (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
                err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
            if (isRevert) return 0n;
            throw err;
          }),
        ]);
      const [effTier, effBps] = effective;
      const [trackedTier, trackedBal] = tracked;
      const freeBalance = trackedBal > encumbered ? trackedBal - encumbered : 0n;

      return {
        registered,
        token,
        walletBalance,
        vaultBalance: trackedBal,
        freeBalance,
        effectiveTier: Number(effTier),
        effectiveBps: Number(effBps),
        rawTier: Number(trackedTier),
        consent,
      };
    },
  });
}
