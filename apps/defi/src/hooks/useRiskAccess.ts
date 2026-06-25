import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { useDiamondRead, useReadChain } from "../contracts/useDiamond";

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
  /** False when the cooldown-unlock read failed — `tierUnlockAt` is then unknown
   *  and callers must treat the tier as still cooling (don't re-affirm). */
  tierUnlockKnown: boolean;
  /** Whether the master progressive-risk gate is enforced on this deployment. */
  gateEnabled: boolean;
  /** False when the gate-enabled read failed — `gateEnabled` is then unknown,
   *  not authoritative. */
  gateEnabledKnown: boolean;
  /** #735 item 3 — whether the vault has opted INTO strict mode (a fresh explicit
   *  per-pair acknowledgement is then required for every mid-tier pair too). */
  strictMode: boolean;
  /** False when the strict-mode read failed — `strictMode` is then unknown. */
  strictModeKnown: boolean;
  /** The disable-linger expiry (unix seconds): after turning strict mode OFF on a
   *  deployment with a cooldown, the mid-tier ack requirement stays in force until
   *  this timestamp. 0 = no pending linger. */
  strictModeUntil: bigint;
  /** False when the linger read failed — `strictModeUntil` is then unknown. */
  strictModeUntilKnown: boolean;
  /** Global risk-terms version (a bump re-locks every held tier / consent). */
  termsVersion: bigint;
  /** False when the terms-version read failed — `termsVersion` is then unknown,
   *  so staleness can't be asserted (a coerced `0n` would read as "not stale"). */
  termsVersionKnown: boolean;
  /** The version the vault's TIER opt-in is anchored to (`riskTierVersionAt`). The
   *  gate honours the raised tier only while this is `>= termsVersion`. */
  tierAnchorVersion: bigint;
  /** False when the tier-anchor read failed — staleness is then unknown. */
  tierAnchorKnown: boolean;
  /** #735 — true when the raised tier is held-but-not-effective specifically
   *  BECAUSE a governance terms bump made its anchor stale (not merely cooling
   *  down). The page offers an in-place re-affirm in this case. Derived from
   *  trustworthy reads only (false when any input is unknown). */
  tierStaleAfterBump: boolean;
  /** False on a Diamond that predates `RiskAccessFacet`. */
  supported: boolean;
  /** True when a critical tier read (effective or raw) failed — the displayed
   *  tier is NOT trustworthy and the controls should be disabled. */
  criticalReadFailed: boolean;
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
  const { address, isCorrectChain, activeChain } = useWallet();
  const diamondRo = useDiamondRead();
  const readChain = useReadChain();
  // `isCorrectChain` only means the wallet is on a REGISTERED chain — a
  // supported chain with no Diamond deployed still passes it, and the reads
  // would then target the zero-address sentinel and writes a dead proxy
  // (Codex #734 r4). Require an actual deployed Diamond on the wallet's chain.
  // ALSO require that the read target IS the wallet's chain: `useDiamondRead`
  // follows the public-dashboard `viewChainId` override, so without this a view
  // override could show another chain's tier for this wallet while writes are
  // bound read-only (Codex #734 r6).
  const canRead =
    isCorrectChain &&
    !!activeChain?.diamondAddress &&
    readChain.chainId === activeChain.chainId;

  const [effectiveTier, setEffectiveTier] = useState<RiskTier>(0);
  const [rawTier, setRawTier] = useState<RiskTier>(0);
  const [tierUnlockAt, setTierUnlockAt] = useState<bigint>(0n);
  const [tierUnlockKnown, setTierUnlockKnown] = useState(true);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [gateEnabledKnown, setGateEnabledKnown] = useState(true);
  const [termsVersion, setTermsVersion] = useState<bigint>(0n);
  const [termsVersionKnown, setTermsVersionKnown] = useState(true);
  const [tierAnchorVersion, setTierAnchorVersion] = useState<bigint>(0n);
  const [tierAnchorKnown, setTierAnchorKnown] = useState(true);
  const [supported, setSupported] = useState(true);
  const [criticalReadFailed, setCriticalReadFailed] = useState(false);
  // #735 item 3 — strict mode: the per-vault flag + the disable-linger expiry.
  const [strictMode, setStrictMode] = useState(false);
  const [strictModeKnown, setStrictModeKnown] = useState(true);
  const [strictModeUntil, setStrictModeUntil] = useState<bigint>(0n);
  const [strictModeUntilKnown, setStrictModeUntilKnown] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The key (vault + chain) the displayed state was loaded for. `loading` is
  // DERIVED from it (not a separate state set inside an effect), so the very
  // first render after a wallet connects already reads as loading instead of
  // briefly showing default values + enabled controls (Codex #734 r5).
  const loadKey = address && canRead ? `${address}:${activeChain?.chainId}` : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadKey !== null && loadedKey !== loadKey;

  // Monotonic request token: a refresh only applies its results while it is the
  // latest one, so a wallet/network switch mid-flight can't let an older read
  // overwrite the current vault's state (Codex #734 r3).
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!address || !canRead) {
      // The context became unreadable (disconnect / unsupported chain). Advance
      // the request token to invalidate any in-flight read, and clear the loaded
      // key so a later reconnect to the SAME context re-reads instead of
      // committing the previous context's state (Codex #734 r8).
      reqRef.current++;
      setLoadedKey(null);
      return;
    }
    const myReq = ++reqRef.current;
    const live = () => myReq === reqRef.current;
    setError(null);
    let missing = false;
    const ro = diamondRo as unknown as {
      getEffectiveRiskTier: (a: string) => Promise<number | bigint>;
      getVaultRiskTier: (a: string) => Promise<number | bigint>;
      getRiskTierUnlockAt: (a: string) => Promise<number | bigint>;
      getCurrentRiskTermsVersion: () => Promise<bigint>;
      getVaultRiskTierVersion: (a: string) => Promise<number | bigint>;
      getRiskAccessGateEnabled: () => Promise<boolean>;
      getRiskStrictMode: (a: string) => Promise<boolean>;
      getStrictModeStrictUntil: (a: string) => Promise<number | bigint>;
    };
    // A failed effective/raw TIER read must NOT leave the page showing a
    // trustworthy-looking default (BlueChip) with enabled controls — a stale /
    // wrong tier could then drive a redundant cooldown-restarting write (Codex
    // #734 r7). Track it and surface an error state instead.
    let critical = false;
    // First read doubles as the "does this Diamond cut RiskAccessFacet?" probe.
    try {
      const eff = Number(await ro.getEffectiveRiskTier(address)) as RiskTier;
      if (live()) setEffectiveTier(eff);
    } catch (e) {
      if (isMissingSelector(e)) missing = true;
      else {
        critical = true;
        if (live()) setError((e as Error).message);
      }
    }
    if (!missing) {
      const [
        rawT,
        unlockRes,
        versionRes,
        anchorRes,
        gateRes,
        strictRes,
        strictUntilRes,
      ] = await Promise.all([
        ro.getVaultRiskTier(address).catch((e) => {
          critical = true;
          if (live()) setError((e as Error).message);
          return 0;
        }),
        // A failed unlock read must NOT coerce to 0 — that would read as "not
        // cooling" and wrongly enable a re-affirm that restarts the cooldown
        // (Codex #734 r4). Keep it unknown so callers treat it as still cooling.
        ro
          .getRiskTierUnlockAt(address)
          .then((v) => ({ ok: true, v: BigInt(v) }))
          .catch(() => ({ ok: false, v: 0n })),
        // A failed terms-version read must NOT coerce to 0 for staleness: that
        // would make `tierAnchorVersion < termsVersion` false and wrongly label a
        // genuinely-stale tier as cooling (hiding re-affirm). Track success so the
        // stale predicate can require it (Codex #738 r2 P2).
        ro
          .getCurrentRiskTermsVersion()
          .then((v) => ({ ok: true, v: BigInt(v) }))
          .catch(() => ({ ok: false, v: 0n })),
        // #735 — the vault's tier anchor version. A failed read leaves staleness
        // UNKNOWN (don't wrongly offer re-affirm). A Diamond predating this getter
        // (#735 not yet deployed) also lands here ⇒ no re-affirm UI, correct.
        ro
          .getVaultRiskTierVersion(address)
          .then((v) => ({ ok: true, v: BigInt(v) }))
          .catch(() => ({ ok: false, v: 0n })),
        // Distinguish a real read failure from "off": a failure leaves
        // enforcement UNKNOWN rather than silently reporting it off
        // (Codex #734 r3).
        ro
          .getRiskAccessGateEnabled()
          .then((v) => ({ ok: true, v: Boolean(v) }))
          .catch(() => ({ ok: false, v: false })),
        // #735 item 3 — strict mode flag. A failed read leaves it UNKNOWN (don't
        // imply strict mode is off when it might be on); a Diamond predating the
        // getter lands here too ⇒ no toggle reflected, correct.
        ro
          .getRiskStrictMode(address)
          .then((v) => ({ ok: true, v: Boolean(v) }))
          .catch(() => ({ ok: false, v: false })),
        // The disable-linger expiry: while > now after a disable, the mid-tier ack
        // requirement stays in force. A failed read leaves it UNKNOWN.
        ro
          .getStrictModeStrictUntil(address)
          .then((v) => ({ ok: true, v: BigInt(v) }))
          .catch(() => ({ ok: false, v: 0n })),
      ]);
      if (live()) {
        setRawTier(Number(rawT) as RiskTier);
        setTierUnlockAt(unlockRes.v);
        setTierUnlockKnown(unlockRes.ok);
        setStrictMode(strictRes.v);
        setStrictModeKnown(strictRes.ok);
        setStrictModeUntil(strictUntilRes.v);
        setStrictModeUntilKnown(strictUntilRes.ok);
        setTermsVersion(versionRes.v);
        setTermsVersionKnown(versionRes.ok);
        setTierAnchorVersion(anchorRes.v);
        setTierAnchorKnown(anchorRes.ok);
        setGateEnabled(gateRes.v);
        setGateEnabledKnown(gateRes.ok);
      }
    }
    if (live()) {
      setCriticalReadFailed(critical);
      setSupported(!missing);
      setLoadedKey(loadKey);
    }
  }, [address, canRead, loadKey, diamondRo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // #735 — a raised tier that is held-but-not-effective is STALE-after-bump (vs
  // merely cooling) iff its anchor version is behind the live terms version. Only
  // assert it from trustworthy reads — BOTH the anchor AND the terms version must
  // have read successfully, else a coerced `0n` on either side flips the
  // comparison and offers a doomed re-affirm (anchor) or hides a needed one
  // (terms version, Codex #738 r2 P2).
  const tierStaleAfterBump =
    rawTier > effectiveTier &&
    tierAnchorKnown &&
    termsVersionKnown &&
    tierAnchorVersion < termsVersion;

  return {
    effectiveTier,
    rawTier,
    tierUnlockAt,
    tierUnlockKnown,
    gateEnabled,
    gateEnabledKnown,
    strictMode,
    strictModeKnown,
    strictModeUntil,
    strictModeUntilKnown,
    termsVersion,
    termsVersionKnown,
    tierAnchorVersion,
    tierAnchorKnown,
    tierStaleAfterBump,
    supported,
    criticalReadFailed,
    wrongChain: !!address && !canRead,
    loading,
    error,
    refresh,
  };
}
