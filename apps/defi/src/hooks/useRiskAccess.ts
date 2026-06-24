import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondRead } from "../contracts/useDiamond";

/**
 * #671 progressive risk access — frontend read hook (#728 PR-2e).
 *
 * Reads the connected vault's self-sovereign risk-access state from the Diamond:
 * the effective tier (read-time re-locked — a stale terms anchor or a pending
 * cooldown drops it back to BlueChipOnly on-chain), the raw opted-in tier, and
 * the global gate / terms-version context.
 *
 * The progressive-risk gate is governed by an off-by-default master switch
 * (`riskAccessGateEnabled`). Per the product direction the controls are surfaced
 * regardless — every vault starts at the safest tier (BlueChipOnly) and opts UP
 * to riskier tiers only with explicit consent — but `gateEnabled` tells the UI
 * whether those choices are actually ENFORCED at origination yet.
 *
 * Wallet-specific: the reads are gated on the wallet being on a chain with a
 * deployed Diamond (`isCorrectChain`, Codex #734 P2) so the page never shows
 * another chain's / a sentinel-address default for the connected address while
 * writes can't settle. Older Diamonds that predate `RiskAccessFacet` revert
 * `FunctionDoesNotExist`; that is detected and surfaced as `supported = false`
 * (mirrors `KeeperSettings`). Strict mode is deliberately NOT read here yet — its
 * dapp control ships with the per-pair acknowledgement path in a follow-up.
 */

export const RISK_TIER = {
  BlueChipOnly: 0,
  BroadLiquid: 1,
  IlliquidCustom: 2,
} as const;

export type RiskTier = (typeof RISK_TIER)[keyof typeof RISK_TIER];

export const RISK_TIER_LABEL: Record<number, string> = {
  0: "Blue-chip only",
  1: "Broad liquid",
  2: "Illiquid / custom",
};

export interface RiskAccessState {
  /** Tier the gate actually honours right now (post read-time re-lock). */
  effectiveTier: RiskTier;
  /** The raw opted-in tier (may exceed `effectiveTier` while cooling down /
   *  stale after a terms bump). */
  rawTier: RiskTier;
  /** Whether the master progressive-risk gate is enforced on this deployment. */
  gateEnabled: boolean;
  /** Global risk-terms version (a bump re-locks every held tier / consent). */
  termsVersion: bigint;
  /** False on a Diamond that predates `RiskAccessFacet`. */
  supported: boolean;
  /** True when the wallet is on a chain without a deployed Diamond — the reads
   *  are skipped and the displayed state is NOT trustworthy. */
  wrongChain: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const isMissingSelector = (e: unknown): boolean => {
  const msg = String(
    (e as { data?: string; message?: string })?.data ??
      (e as Error)?.message ??
      "",
  );
  return /function does not exist|functionnotfound|0xa9ad62f8/i.test(msg);
};

export function useRiskAccess(): RiskAccessState {
  const { address, isCorrectChain } = useWallet();
  const diamondRo = useDiamondRead();

  const [effectiveTier, setEffectiveTier] = useState<RiskTier>(0);
  const [rawTier, setRawTier] = useState<RiskTier>(0);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [termsVersion, setTermsVersion] = useState<bigint>(0n);
  const [supported, setSupported] = useState(true);
  // Start loading whenever there's a connected vault on a deployed Diamond to
  // read for, so the page shows a spinner from first paint instead of flashing
  // default values (Claude review #734 P3).
  const [loading, setLoading] = useState(() => !!address && isCorrectChain);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Only read for a connected wallet on a chain with a deployed Diamond — never
    // fall back to another chain's / the sentinel-address state (Codex #734 P2).
    if (!address || !isCorrectChain) {
      setLoading(false);
      return;
    }
    // Set synchronously before the first await so a wallet that connects after
    // mount immediately shows the loading guard, not the default values
    // (Codex #734 P2 — the once-only useState initializer can't do this).
    setLoading(true);
    setError(null);
    let missing = false;
    const ro = diamondRo as unknown as {
      getEffectiveRiskTier: (a: string) => Promise<number | bigint>;
      getVaultRiskTier: (a: string) => Promise<number | bigint>;
      getCurrentRiskTermsVersion: () => Promise<bigint>;
      getRiskAccessGateEnabled: () => Promise<boolean>;
    };
    // The first read doubles as the "does this Diamond cut RiskAccessFacet?"
    // probe — keep it sequential so a missing-selector revert switches to the
    // unsupported state before the others run.
    try {
      setEffectiveTier(Number(await ro.getEffectiveRiskTier(address)) as RiskTier);
    } catch (e) {
      if (isMissingSelector(e)) missing = true;
      else setError((e as Error).message);
    }
    if (!missing) {
      // The remaining three reads are independent — batch them (Claude review
      // #734 P2). Each keeps its own fallback so one failure doesn't blank the
      // rest; the tier read surfaces an error, version/gate are informational.
      const [rawT, version, gateOn] = await Promise.all([
        ro.getVaultRiskTier(address).catch((e) => {
          setError((e as Error).message);
          return 0;
        }),
        ro.getCurrentRiskTermsVersion().catch(() => 0n),
        ro.getRiskAccessGateEnabled().catch(() => false),
      ]);
      setRawTier(Number(rawT) as RiskTier);
      setTermsVersion(BigInt(version));
      setGateEnabled(Boolean(gateOn));
    }
    setSupported(!missing);
    setLoading(false);
  }, [address, isCorrectChain, diamondRo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    effectiveTier,
    rawTier,
    gateEnabled,
    termsVersion,
    supported,
    wrongChain: !!address && !isCorrectChain,
    loading,
    error,
    refresh,
  };
}
