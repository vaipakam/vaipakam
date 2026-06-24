import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondRead } from "../contracts/useDiamond";

/**
 * #671 progressive risk access — frontend read hook (#728 PR-2e).
 *
 * Reads the connected vault's self-sovereign risk-access state from the Diamond:
 * the effective tier (read-time re-locked — a stale terms anchor or a pending
 * cooldown drops it back to BlueChipOnly on-chain), the raw opted-in tier, the
 * raise-cooldown unlock time, and the global gate / terms-version context.
 *
 * The progressive-risk gate is governed by an off-by-default master switch
 * (`riskAccessGateEnabled`). Per the product direction the controls are surfaced
 * regardless — every vault starts at the safest tier (BlueChipOnly) and opts UP
 * to riskier tiers only with explicit consent — but `gateEnabled` tells the UI
 * whether those choices are actually ENFORCED at origination yet.
 *
 * Wallet-specific: the reads are gated on the wallet being on a chain with a
 * deployed Diamond (`isCorrectChain`) so the page never shows another chain's /
 * a sentinel-address default for the connected address while writes can't settle.
 * In-flight reads are sequence-guarded so a wallet/network switch can't let a
 * stale result overwrite the current one. Older Diamonds that predate
 * `RiskAccessFacet` revert `FunctionDoesNotExist` ⇒ `supported = false`. Strict
 * mode is deliberately NOT read here yet — its dapp control ships with the
 * per-pair acknowledgement path in a follow-up.
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
  /** Unix seconds the current raise-cooldown elapses (0 if none pending). While
   *  `now < tierUnlockAt` a raised tier is still cooling down. */
  tierUnlockAt: bigint;
  /** Whether the master progressive-risk gate is enforced on this deployment. */
  gateEnabled: boolean;
  /** False when the gate-enabled read failed — `gateEnabled` is then unknown,
   *  not authoritative. */
  gateEnabledKnown: boolean;
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
  const [tierUnlockAt, setTierUnlockAt] = useState<bigint>(0n);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [gateEnabledKnown, setGateEnabledKnown] = useState(true);
  const [termsVersion, setTermsVersion] = useState<bigint>(0n);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(() => !!address && isCorrectChain);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request token: a refresh only applies its results while it is the
  // latest one, so a wallet/network switch mid-flight can't let an older read
  // overwrite the current vault's state (Codex #734 r3).
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!address || !isCorrectChain) {
      setLoading(false);
      return;
    }
    const myReq = ++reqRef.current;
    const live = () => myReq === reqRef.current;
    setLoading(true);
    setError(null);
    let missing = false;
    const ro = diamondRo as unknown as {
      getEffectiveRiskTier: (a: string) => Promise<number | bigint>;
      getVaultRiskTier: (a: string) => Promise<number | bigint>;
      getRiskTierUnlockAt: (a: string) => Promise<number | bigint>;
      getCurrentRiskTermsVersion: () => Promise<bigint>;
      getRiskAccessGateEnabled: () => Promise<boolean>;
    };
    // First read doubles as the "does this Diamond cut RiskAccessFacet?" probe.
    try {
      const eff = Number(await ro.getEffectiveRiskTier(address)) as RiskTier;
      if (live()) setEffectiveTier(eff);
    } catch (e) {
      if (isMissingSelector(e)) missing = true;
      else if (live()) setError((e as Error).message);
    }
    if (!missing) {
      const [rawT, unlockAt, version, gateRes] = await Promise.all([
        ro.getVaultRiskTier(address).catch((e) => {
          if (live()) setError((e as Error).message);
          return 0;
        }),
        ro.getRiskTierUnlockAt(address).catch(() => 0),
        ro.getCurrentRiskTermsVersion().catch(() => 0n),
        // Distinguish a real read failure from "off": a failure leaves
        // enforcement UNKNOWN rather than silently reporting it off
        // (Codex #734 r3).
        ro
          .getRiskAccessGateEnabled()
          .then((v) => ({ ok: true, v: Boolean(v) }))
          .catch(() => ({ ok: false, v: false })),
      ]);
      if (live()) {
        setRawTier(Number(rawT) as RiskTier);
        setTierUnlockAt(BigInt(unlockAt));
        setTermsVersion(BigInt(version));
        setGateEnabled(gateRes.v);
        setGateEnabledKnown(gateRes.ok);
      }
    }
    if (live()) {
      setSupported(!missing);
      setLoading(false);
    }
  }, [address, isCorrectChain, diamondRo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    effectiveTier,
    rawTier,
    tierUnlockAt,
    gateEnabled,
    gateEnabledKnown,
    termsVersion,
    supported,
    wrongChain: !!address && !isCorrectChain,
    loading,
    error,
    refresh,
  };
}
