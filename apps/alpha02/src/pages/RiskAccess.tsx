/**
 * Risk access (#671/#728, defi /risk-access ported onto alpha02's
 * UI/UX) — the vault's self-sovereign risk controls. Every vault
 * starts at the safest level (blue-chip only) and opts UP only with
 * explicit consent, exactly as the contract requires. Lowering is
 * immediate; raising may sit out an opt-up cooldown, and a governance
 * risk-terms bump re-locks a held level until re-affirmed (both fold
 * into the on-chain EFFECTIVE tier this page renders).
 *
 * Per-pair illiquid consent and the strict-mode mid-tier
 * acknowledgement are pair-specific, so they stay contextual in the
 * create/accept flows (the accept preflights already point there).
 * This page owns the two GLOBAL controls: the vault's risk level and
 * the strict-mode opt-in.
 *
 * Trust rules (each was a review finding on the defi original):
 *   - never render the level controls over a failed critical read — a
 *     wrong default could drive a cooldown-restarting write;
 *   - a held-but-not-effective level distinguishes cooling vs
 *     terms-stale ONLY from trustworthy on-chain reads (see
 *     classifyHeldTier); stale offers an in-place re-affirm, cooling
 *     stays informational (re-submitting restarts the cooldown);
 *   - a failed strict-linger read says "couldn't check" rather than
 *     implying the linger is absent.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { ShieldCheck } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { useMode } from '../app/ModeContext';
import { formatDateTime } from '../lib/format';
import { SECOND_READ_DELAY_MS } from '../chain/receiptSync';
import {
  RISK_TIER,
  chainNowOf,
  classifyHeldTier,
  strictLingerActive,
  useRiskAccess,
  type RiskTier,
} from '../data/riskAccess';

/** Tier metadata resolves through the copy proxy in render scope — a
 *  module-level read would bake in the import-time language (see
 *  src/i18n/reactiveCopy.ts). */
const TIER_OPTIONS = (): Array<{
  level: RiskTier;
  label: string;
  hint: string;
}> => [
  { level: RISK_TIER.BlueChipOnly, ...copy.riskAccess.tiers.blueChip },
  { level: RISK_TIER.BroadLiquid, ...copy.riskAccess.tiers.broadLiquid },
  { level: RISK_TIER.IlliquidCustom, ...copy.riskAccess.tiers.illiquid },
];

const tierLabel = (level: number): string =>
  TIER_OPTIONS().find((t) => t.level === level)?.label ?? String(level);

export function RiskAccess() {
  const { address, onSupportedChain, walletChain } = useActiveChain();
  const { isAdvanced } = useMode();
  const { write } = useDiamondWrite();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const risk = useRiskAccess();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /** `fn` RETURNS the success message — flows that revalidate live
   *  state derive the right wording from what they actually read
   *  (Codex #1517 r6), rather than a caller-side guess off the cached
   *  snapshot. */
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setDone(null);
    let wrote = false;
    try {
      setDone(await fn());
      wrote = true;
      // AWAIT the refetch: the controls render from query data, so
      // dropping busy before fresh data lands re-enables a control
      // still showing the pre-write value — inviting a duplicate tx.
      await queryClient.invalidateQueries({ queryKey: ['riskAccess'] });
      // …and hold busy THROUGH the lagging-RPC window (Codex #1517
      // r7): a public RPC can serve the parent block to the immediate
      // refetch, and a click in that window would pass the live
      // revalidation against the same stale state and re-submit —
      // restarting a cooldown and charging the user twice. Re-read
      // once the receipt floor's own delayed pass has landed.
      await new Promise((r) => setTimeout(r, SECOND_READ_DELAY_MS));
      await queryClient.invalidateQueries({ queryKey: ['riskAccess'] });
    } catch (err) {
      if (!wrote) setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Live pre-write revalidation (Codex #1517 r4): the rendered state
   *  can be a poll interval old — another device/app may have moved
   *  the tier since. A same-tier re-submit RESTARTS the raise cooldown
   *  on-chain (`_applyTier`), so abort-and-refresh instead of writing
   *  when the live raw tier already equals the request (unless this is
   *  the re-affirm path and the anchor is still confirmed stale).
   *  RETURNS the success message, derived from the LIVE effective tier
   *  read in the same pinned-block batch (r6): the cached snapshot's
   *  direction can be wrong by submission time (an expired cooldown
   *  flips a "raise" into an immediate lowering and vice versa). */
  async function submitTierRevalidated(
    level: RiskTier,
    opts: { reaffirm: boolean },
  ): Promise<string> {
    if (!publicClient || !walletChain || !address) {
      throw new Error(copy.errors.walletConnectFirst);
    }
    // One pinned block for the whole revalidation — same coherence
    // rule as the snapshot hook (r3).
    const block = await publicClient.getBlock();
    const readLive = <T,>(functionName: string, args?: readonly unknown[]) =>
      publicClient.readContract({
        address: walletChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName,
        args: args as unknown[],
        blockNumber: block.number,
      }) as Promise<T>;
    const [liveRaw, liveEffective] = await Promise.all([
      readLive<number | bigint>('getVaultRiskTier', [address]).then(Number),
      readLive<number | bigint>('getEffectiveRiskTier', [address]).then(Number),
    ]);
    if (opts.reaffirm) {
      // Only re-affirm while the anchor is STILL stale live — a
      // just-landed re-affirm from another device makes this one a
      // pure cooldown-restarting no-op.
      const [anchor, terms] = await Promise.all([
        readLive<number | bigint>('getVaultRiskTierVersion', [address]).then(BigInt),
        readLive<bigint>('getCurrentRiskTermsVersion').then(BigInt),
      ]);
      if (liveRaw !== level || anchor >= terms) {
        await queryClient.invalidateQueries({ queryKey: ['riskAccess'] });
        throw new Error(copy.riskAccess.noLongerStaleAbort);
      }
    } else if (liveRaw === level) {
      await queryClient.invalidateQueries({ queryKey: ['riskAccess'] });
      throw new Error(copy.riskAccess.alreadySelectedAbort);
    }
    await write('setVaultRiskTier', [level]);
    if (opts.reaffirm) return copy.riskAccess.reaffirmedMsg;
    // Direction judged against the LIVE effective tier — the same
    // comparison `_applyTier` makes at execution.
    return level > liveEffective
      ? copy.riskAccess.raisedMsg
      : copy.riskAccess.loweredMsg;
  }

  const s = risk.data;

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">{copy.riskAccess.title}</h1>
        <p className="page-lede">{copy.riskAccess.lede}</p>
      </div>

      <section className="card">
        <div className="card-title">
          <ShieldCheck aria-hidden />
          <h2 style={{ margin: 0 }}>{copy.riskAccess.tierHeading}</h2>
        </div>

        {!address ? (
          <p className="muted">{copy.wallet.connectFirst}</p>
        ) : !onSupportedChain || !walletChain ? (
          // Reads/writes are wallet-chain-specific; a chain without a
          // deployed Diamond would show another chain's / a default
          // state while writes can't settle.
          <div className="banner banner-warn" role="alert">
            <span className="banner-body">{copy.riskAccess.wrongChain}</span>
          </div>
        ) : risk.isError && !s ? (
          <div className="banner banner-danger" role="alert">
            <span className="banner-body">{copy.riskAccess.readFailed}</span>
          </div>
        ) : !s ? (
          <p className="muted">{copy.riskAccess.loading}</p>
        ) : !s.supported ? (
          <p className="muted">{copy.riskAccess.unsupported}</p>
        ) : s.criticalReadFailed ? (
          // Never render level controls over an untrustworthy tier —
          // a wrong default could drive a cooldown-restarting write.
          <div className="stack" style={{ gap: 12 }}>
            <div className="banner banner-danger" role="alert">
              <span className="banner-body">{copy.riskAccess.readFailed}</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void risk.refetch()}
            >
              {copy.common.tryAgain}
            </button>
          </div>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            <p style={{ margin: 0 }}>
              {copy.riskAccess.currentLevel(tierLabel(s.effectiveTier))}
            </p>
            {s.rawTier !== s.effectiveTier ? (
              <p className="muted" style={{ margin: 0 }}>
                {copy.riskAccess.heldHigher(tierLabel(s.rawTier))}
              </p>
            ) : null}
            <p className="muted" style={{ margin: 0 }}>
              {!s.gateEnabledKnown
                ? copy.riskAccess.enforcementUnknown
                : s.gateEnabled
                  ? copy.riskAccess.enforcementOn
                  : copy.riskAccess.enforcementOff}
            </p>

            <div
              className="row-list"
              role="radiogroup"
              aria-label={copy.riskAccess.tierHeading}
            >
              {TIER_OPTIONS().map((opt) => {
                const selected = s.rawTier === opt.level;
                const held = selected ? classifyHeldTier(s) : null;
                return (
                  <button
                    key={opt.level}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="item-row"
                    style={{
                      textAlign: 'left',
                      width: '100%',
                      border: selected
                        ? '2px solid var(--accent)'
                        : undefined,
                      cursor: busy || selected ? 'default' : 'pointer',
                    }}
                    disabled={busy || selected}
                    onClick={() =>
                      // Success wording comes from the LIVE effective
                      // tier inside the revalidation (r5/r6) — never a
                      // caller-side guess off the cached snapshot.
                      void run(() =>
                        submitTierRevalidated(opt.level, { reaffirm: false }),
                      )
                    }
                  >
                    <span className="row-main">
                      <span className="row-title">
                        {opt.label}
                        {selected && held === 'effective' ? ' ✓' : ''}
                      </span>
                      <br />
                      <span className="row-sub">{opt.hint}</span>
                      {held === 'cooling' ? (
                        <>
                          <br />
                          <span className="row-sub muted">
                            {copy.riskAccess.coolingNote}
                          </span>
                        </>
                      ) : held === 'stale' ? (
                        <>
                          <br />
                          <span className="row-sub muted">
                            {copy.riskAccess.staleNote}
                          </span>
                        </>
                      ) : held === 'unknown' ? (
                        <>
                          <br />
                          <span className="row-sub muted">
                            {copy.riskAccess.unknownHeldNote}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>

            {classifyHeldTier(s) === 'stale' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  // Same-tier re-submit re-stamps the anchor to the
                  // live risk-terms version (#735) — how a terms-bump
                  // re-lock is cleared without lower-then-raise. Live-
                  // revalidated: only lands while still stale (r4).
                  void run(() =>
                    submitTierRevalidated(s.rawTier, { reaffirm: true }),
                  )
                }
              >
                {busy ? copy.riskAccess.reaffirming : copy.riskAccess.reaffirm}
              </button>
            ) : null}

            <p className="muted" style={{ margin: 0 }}>
              {copy.riskAccess.directionNote}
            </p>

            {isAdvanced && s.termsVersionKnown && s.tierAnchorKnown ? (
              <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                {/* The contract stamps the unlock timestamp on EVERY
                    tier write (lowers included), so a nonzero value is
                    not "cooldown pending" — only a FUTURE one is
                    (Codex #1517 r1). A FAILED unlock read is its own
                    state — claiming "no cooldown" over it would
                    contradict a cooling tier note above (r2). "Future"
                    is judged against CHAIN time, not the device clock
                    (r3) — the contract compares block.timestamp. */}
                {!s.tierUnlockKnown
                  ? copy.riskAccess.advancedCooldownUnknown(
                      String(s.termsVersion),
                      String(s.tierAnchorVersion),
                    )
                  : s.tierUnlockAt > BigInt(Math.floor(chainNowOf(s, Date.now())))
                    ? copy.riskAccess.advancedDetail(
                        String(s.termsVersion),
                        String(s.tierAnchorVersion),
                        formatDateTime(Number(s.tierUnlockAt)),
                      )
                    : copy.riskAccess.advancedNoCooldown(
                        String(s.termsVersion),
                        String(s.tierAnchorVersion),
                      )}
              </p>
            ) : null}
          </div>
        )}
      </section>

      {/* NOT gated on criticalReadFailed (Codex #1517 r2): the strict
          card renders from its own read — a strict vault must keep the
          disable recovery action even when an unrelated tier read
          failed (strictModeKnown covers its own failure). Disabling is
          risk-INCREASING per the contract's model — the disable-linger
          cooldown exists to close that window — but it does not depend
          on the tier value, so a tier-read failure is no reason to
          withhold it (r4 wording fix). */}
      {address && onSupportedChain && s?.supported ? (
        <section className="card">
          <div className="card-title">
            <ShieldCheck aria-hidden />
            <h2 style={{ margin: 0 }}>{copy.riskAccess.strict.title}</h2>
          </div>
          <p className="muted">{copy.riskAccess.strict.blurb}</p>
          {!s.strictModeKnown ? (
            <p className="muted">{copy.riskAccess.strict.unreadable}</p>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {/* ENABLE is deliberately not offered (Codex #1517 r1):
                  the per-deal mid-tier acknowledgement strict mode
                  demands has no collection surface in this app yet —
                  the accept flow hard-blocks on it — so an enable here
                  would lock the user out of their own mid-tier deals
                  once enforcement is on. DISABLE stays available as the
                  recovery path for a vault that enabled strict mode
                  elsewhere — a risk-INCREASING change under the
                  contract's model, bounded by the disable-linger
                  cooldown (r4 wording fix). */}
              {s.strictMode ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await write('setRiskStrictMode', [false]);
                      return copy.riskAccess.strict.disabledMsg;
                    })
                  }
                >
                  {busy
                    ? copy.riskAccess.strict.updating
                    : copy.riskAccess.strict.on}
                </button>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  {copy.riskAccess.strict.offLocked}
                </p>
              )}
              {!s.strictMode ? (
                s.strictModeUntilKnown ? (
                  // Chain-time anchor, not the device clock (r3) — the
                  // contract's effective-strict check compares the
                  // linger expiry with block.timestamp.
                  strictLingerActive(s, Math.floor(chainNowOf(s, Date.now()))) ? (
                    <p className="muted" style={{ margin: 0 }}>
                      {copy.riskAccess.strict.lingerNote}
                    </p>
                  ) : null
                ) : (
                  <p className="muted" style={{ margin: 0 }}>
                    {copy.riskAccess.strict.lingerUnknown}
                  </p>
                )
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {risk.isError && s ? (
        // A failed BACKGROUND refetch keeps the retained data on
        // screen — flag it as possibly incomplete instead of
        // replacing the controls.
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{copy.riskAccess.partialReadWarning}</span>
        </div>
      ) : null}
      {done ? (
        <div className="banner banner-info" role="status">
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
