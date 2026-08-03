/**
 * #671/#728 progressive risk access — alpha02 read hook + pure state
 * classification (port of apps/defi's useRiskAccess, reshaped onto
 * alpha02's react-query idiom).
 *
 * Reads the connected vault's self-sovereign risk-access state from
 * the Diamond on the WALLET's chain (writes settle there — reading a
 * view-override chain could show another chain's tier for this wallet;
 * the defi port learned this in Codex #734 r6): the effective tier
 * (read-time re-locked — a stale terms anchor or a pending raise
 * cooldown drops it back to the safest tier on-chain), the raw
 * opted-in tier, the cooldown unlock time, strict mode + its
 * disable-linger, and the global gate / terms-version context.
 *
 * Trust semantics carried over verbatim from the defi hook (each was
 * a review finding there):
 *   - a failed NON-critical read leaves its value UNKNOWN (`*Known`
 *     false) instead of coercing to a default — a coerced 0 reads as
 *     "not cooling" / "terms never bumped" and drives wrong UI;
 *   - a failed CRITICAL read (effective/raw tier) marks the whole
 *     result untrustworthy — controls must not render over it;
 *   - the missing-selector probe on the first read distinguishes "this
 *     Diamond predates RiskAccessFacet" from a transport failure.
 *
 * Race safety (the defi hook's manual request tokens) comes free from
 * react-query: results key on (chainId, address), so a wallet/network
 * switch mid-flight can never commit a stale vault's state.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { isMissingSelectorError } from '../contracts/preflights';

/** `LibVaipakam.RiskAccessLevel` ordinals. */
export const RISK_TIER = {
  BlueChipOnly: 0,
  BroadLiquid: 1,
  IlliquidCustom: 2,
} as const;

export type RiskTier = (typeof RISK_TIER)[keyof typeof RISK_TIER];

export interface RiskAccessSnapshot {
  /** False on a Diamond that predates `RiskAccessFacet` — every other
   *  field is then meaningless. */
  supported: boolean;
  /** True when a critical tier read (effective or raw) failed — the
   *  tier values are NOT trustworthy and controls must not render. */
  criticalReadFailed: boolean;
  /** Tier the gate actually honours right now (post read-time re-lock). */
  effectiveTier: RiskTier;
  /** The raw opted-in tier (may exceed `effectiveTier` while cooling
   *  down / stale after a terms bump). */
  rawTier: RiskTier;
  /** Unix seconds the current raise-cooldown elapses (0 = none). */
  tierUnlockAt: bigint;
  tierUnlockKnown: boolean;
  /** Whether the master progressive-risk gate is enforced here. */
  gateEnabled: boolean;
  gateEnabledKnown: boolean;
  strictMode: boolean;
  strictModeKnown: boolean;
  /** Disable-linger expiry (unix seconds); while in the future a prior
   *  strict-mode disable keeps the mid-tier ack requirement in force. */
  strictModeUntil: bigint;
  strictModeUntilKnown: boolean;
  /** Global risk-terms version (a bump re-locks every held tier). */
  termsVersion: bigint;
  termsVersionKnown: boolean;
  /** The version the vault's tier opt-in is anchored to. */
  tierAnchorVersion: bigint;
  tierAnchorKnown: boolean;
  /** CHAIN time (the pinned block's timestamp) — time comparisons
   *  against contract state (cooldown future/past, strict linger) must
   *  use this, never the device clock (Codex #1517 r3; same lesson as
   *  the Permit2 chain-time deadline). */
  chainNowSec: bigint;
  /** Device-clock ms when the snapshot was fetched — lets the UI
   *  advance `chainNowSec` locally between refetches. */
  fetchedAtMs: number;
}

/** Chain-anchored "now" (unix seconds): the pinned block's timestamp
 *  advanced by the device-measured time since the fetch. Device clock
 *  skew cancels out — only its RATE matters across ≤60s. */
export function chainNowOf(
  s: Pick<RiskAccessSnapshot, 'chainNowSec' | 'fetchedAtMs'>,
  deviceNowMs: number,
): number {
  return Number(s.chainNowSec) + Math.max(0, (deviceNowMs - s.fetchedAtMs) / 1000);
}

/** How a SELECTED (raw) tier relates to the effective one — drives the
 *  per-option note and whether the in-place re-affirm is offered.
 *
 *  - 'effective':  selected AND honoured right now.
 *  - 'cooling':    held but re-locked by the raise cooldown — a
 *                  re-submit would RESTART the cooldown, so the UI
 *                  stays informational.
 *  - 'stale':      held but re-locked because a governance risk-terms
 *                  bump outdated its anchor — an in-place re-affirm
 *                  (same-tier re-submit) restores it.
 *  - 'unknown':    held-not-effective but the anchor/terms reads are
 *                  untrustworthy — we can't tell stale from cooling,
 *                  so neither promise applies (Codex #738 r1/r2 in the
 *                  defi port: a coerced 0 on either side flips the
 *                  comparison and offers a doomed re-affirm or hides a
 *                  needed one).
 */
export type HeldTierState = 'effective' | 'cooling' | 'stale' | 'unknown';

export function classifyHeldTier(s: {
  effectiveTier: number;
  rawTier: number;
  tierAnchorKnown: boolean;
  termsVersionKnown: boolean;
  tierAnchorVersion: bigint;
  termsVersion: bigint;
}): HeldTierState {
  if (s.rawTier <= s.effectiveTier) return 'effective';
  if (!s.tierAnchorKnown || !s.termsVersionKnown) return 'unknown';
  return s.tierAnchorVersion < s.termsVersion ? 'stale' : 'cooling';
}

/** True while a prior strict-mode DISABLE still keeps the mid-tier
 *  acknowledgement requirement in force (raw flag off, linger in the
 *  future). `nowSec` is a parameter for testability. */
export function strictLingerActive(
  s: Pick<RiskAccessSnapshot, 'strictMode' | 'strictModeUntilKnown' | 'strictModeUntil'>,
  nowSec: number,
): boolean {
  return (
    !s.strictMode && s.strictModeUntilKnown && s.strictModeUntil > BigInt(nowSec)
  );
}

export function useRiskAccess() {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  // Reads target the WALLET's chain, where the writes settle.
  const walletClientChainId = walletChain?.chainId;
  const publicClient = usePublicClient({ chainId: walletClientChainId });

  return useQuery({
    queryKey: ['riskAccess', walletClientChainId, address?.toLowerCase()],
    enabled:
      Boolean(publicClient) &&
      Boolean(address) &&
      onSupportedChain &&
      Boolean(walletChain?.diamondAddress),
    // UNSTRETCHED interval (Codex #1517 r2): signalAware's stretch
    // assumes the push rail covers the root, but riskAccess has no
    // push key / LiveChainSync root — a cooldown expiry, governance
    // terms bump, or a write made from the reference app arrives only
    // via this poll (own writes are receipt-floored separately).
    refetchInterval: 60_000,
    queryFn: async (): Promise<RiskAccessSnapshot> => {
      const diamond = walletChain!.diamondAddress;
      // Pin EVERY read to one block (Codex #1517 r3): the probe read
      // resolves before the batch starts, so without the pin a
      // governance terms bump mining in between yields an incoherent
      // snapshot — old (higher) effective tier beside the new terms
      // version — which classifyHeldTier would read as "effective"
      // and withhold the re-affirm the vault actually needs. The
      // block's timestamp doubles as the chain-time anchor for the
      // cooldown / linger comparisons.
      const block = await publicClient!.getBlock();
      const fetchedAtMs = Date.now();
      const read = <T,>(functionName: string, args?: readonly unknown[]) =>
        publicClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName,
          args: args as unknown[],
          blockNumber: block.number,
        }) as Promise<T>;

      const unsupported: RiskAccessSnapshot = {
        chainNowSec: block.timestamp,
        fetchedAtMs,
        supported: false,
        criticalReadFailed: false,
        effectiveTier: 0,
        rawTier: 0,
        tierUnlockAt: 0n,
        tierUnlockKnown: false,
        gateEnabled: false,
        gateEnabledKnown: false,
        strictMode: false,
        strictModeKnown: false,
        strictModeUntil: 0n,
        strictModeUntilKnown: false,
        termsVersion: 0n,
        termsVersionKnown: false,
        tierAnchorVersion: 0n,
        tierAnchorKnown: false,
      };

      // First read doubles as the "does this Diamond cut
      // RiskAccessFacet?" probe.
      let effectiveTier: RiskTier = 0;
      let critical = false;
      try {
        effectiveTier = Number(
          await read<number | bigint>('getEffectiveRiskTier', [address!]),
        ) as RiskTier;
      } catch (err) {
        if (isMissingSelectorError(err)) return unsupported;
        critical = true;
      }

      const known = <T,>(p: Promise<T>, fallback: T) =>
        p.then((v) => ({ ok: true, v })).catch(() => ({ ok: false, v: fallback }));

      const [rawT, unlock, terms, anchor, gate, strict, strictUntil] =
        await Promise.all([
          read<number | bigint>('getVaultRiskTier', [address!]).catch(() => {
            critical = true;
            return 0;
          }),
          known(
            read<number | bigint>('getRiskTierUnlockAt', [address!]).then(BigInt),
            0n,
          ),
          known(read<bigint>('getCurrentRiskTermsVersion').then(BigInt), 0n),
          known(
            read<number | bigint>('getVaultRiskTierVersion', [address!]).then(
              BigInt,
            ),
            0n,
          ),
          known(read<boolean>('getRiskAccessGateEnabled').then(Boolean), false),
          known(read<boolean>('getRiskStrictMode', [address!]).then(Boolean), false),
          known(
            read<number | bigint>('getStrictModeStrictUntil', [address!]).then(
              BigInt,
            ),
            0n,
          ),
        ]);

      return {
        chainNowSec: block.timestamp,
        fetchedAtMs,
        supported: true,
        criticalReadFailed: critical,
        effectiveTier,
        rawTier: Number(rawT) as RiskTier,
        tierUnlockAt: unlock.v,
        tierUnlockKnown: unlock.ok,
        gateEnabled: gate.v,
        gateEnabledKnown: gate.ok,
        strictMode: strict.v,
        strictModeKnown: strict.ok,
        strictModeUntil: strictUntil.v,
        strictModeUntilKnown: strictUntil.ok,
        termsVersion: terms.v,
        termsVersionKnown: terms.ok,
        tierAnchorVersion: anchor.v,
        tierAnchorKnown: anchor.ok,
      };
    },
  });
}
