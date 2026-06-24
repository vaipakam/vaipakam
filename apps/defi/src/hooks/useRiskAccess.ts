import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondRead } from "../contracts/useDiamond";

/**
 * #671 progressive risk access — frontend read hook (#728 PR-2e).
 *
 * Reads the connected vault's self-sovereign risk-access state from the
 * Diamond: the effective tier (read-time re-locked: a stale terms anchor or a
 * pending cooldown drops it back to BlueChipOnly on-chain), the raw opted-in
 * tier, the strict-mode flag, and the global gate / terms-version context.
 *
 * The progressive-risk gate is governed by an off-by-default master switch
 * (`riskAccessGateEnabled`). Per the product direction the controls are
 * surfaced regardless — every vault starts at the safest tier (BlueChipOnly)
 * and opts UP to riskier tiers only with explicit consent — but `gateEnabled`
 * tells the UI whether those choices are actually ENFORCED at origination yet.
 *
 * Older Diamond deployments that predate `RiskAccessFacet` revert
 * `FunctionDoesNotExist`; that is detected and surfaced as `supported = false`
 * rather than a raw RPC error (mirrors `KeeperSettings`).
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
  /** Opt-in strict mode: requires an explicit per-pair ack for mid-tier pairs. */
  strictMode: boolean;
  /** Whether the master progressive-risk gate is enforced on this deployment. */
  gateEnabled: boolean;
  /** Global risk-terms version (a bump re-locks every held tier / consent). */
  termsVersion: bigint;
  /** False on a Diamond that predates `RiskAccessFacet`. */
  supported: boolean;
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
  const { address } = useWallet();
  const diamondRo = useDiamondRead();

  const [effectiveTier, setEffectiveTier] = useState<RiskTier>(0);
  const [rawTier, setRawTier] = useState<RiskTier>(0);
  const [strictMode, setStrictMode] = useState(false);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [termsVersion, setTermsVersion] = useState<bigint>(0n);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    let missing = false;
    const ro = diamondRo as unknown as {
      getEffectiveRiskTier: (a: string) => Promise<number | bigint>;
      getVaultRiskTier: (a: string) => Promise<number | bigint>;
      getRiskStrictMode: (a: string) => Promise<boolean>;
      getCurrentRiskTermsVersion: () => Promise<bigint>;
      getRiskAccessGateEnabled: () => Promise<boolean>;
    };
    try {
      setEffectiveTier(Number(await ro.getEffectiveRiskTier(address)) as RiskTier);
    } catch (e) {
      if (isMissingSelector(e)) missing = true;
      else setError((e as Error).message);
    }
    if (!missing) {
      try {
        setRawTier(Number(await ro.getVaultRiskTier(address)) as RiskTier);
      } catch (e) {
        setError((e as Error).message);
      }
      try {
        setStrictMode(Boolean(await ro.getRiskStrictMode(address)));
      } catch (e) {
        setError((e as Error).message);
      }
      try {
        setTermsVersion(BigInt(await ro.getCurrentRiskTermsVersion()));
      } catch {
        /* non-fatal — informational only */
      }
      try {
        setGateEnabled(Boolean(await ro.getRiskAccessGateEnabled()));
      } catch {
        /* non-fatal — treat as off */
      }
    }
    setSupported(!missing);
    setLoading(false);
  }, [address, diamondRo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    effectiveTier,
    rawTier,
    strictMode,
    gateEnabled,
    termsVersion,
    supported,
    loading,
    error,
    refresh,
  };
}
