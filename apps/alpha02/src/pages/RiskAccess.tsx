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
import { ShieldCheck } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { useMode } from '../app/ModeContext';
import {
  RISK_TIER,
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

/** Cooldown-end stamp for the advanced detail line — date+time, since
 *  a cooldown routinely ends later the same day. */
function dateTime(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function RiskAccess() {
  const { address, onSupportedChain, walletChain } = useActiveChain();
  const { isAdvanced } = useMode();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const risk = useRiskAccess();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, doneMsg: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(doneMsg);
      // AWAIT the refetch: the controls render from query data, so
      // dropping busy before fresh data lands re-enables a control
      // still showing the pre-write value — inviting a duplicate tx.
      await queryClient.invalidateQueries({ queryKey: ['riskAccess'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
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
                      void run(async () => {
                        await write('setVaultRiskTier', [opt.level]);
                      }, opt.level > s.rawTier
                        ? copy.riskAccess.raisedMsg
                        : copy.riskAccess.loweredMsg)
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
                  void run(async () => {
                    // Same-tier re-submit re-stamps the anchor to the
                    // live risk-terms version (#735) — how a terms-bump
                    // re-lock is cleared without lower-then-raise.
                    await write('setVaultRiskTier', [s.rawTier]);
                  }, copy.riskAccess.reaffirmedMsg)
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
                {s.tierUnlockKnown && s.tierUnlockAt > 0n
                  ? copy.riskAccess.advancedDetail(
                      String(s.termsVersion),
                      String(s.tierAnchorVersion),
                      dateTime(s.tierUnlockAt),
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

      {address && onSupportedChain && s?.supported && !s.criticalReadFailed ? (
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
              <button
                type="button"
                role="switch"
                aria-checked={s.strictMode}
                className={`btn ${s.strictMode ? 'btn-primary' : 'btn-secondary'}`}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await write('setRiskStrictMode', [!s.strictMode]);
                  }, s.strictMode
                    ? copy.riskAccess.strict.disabledMsg
                    : copy.riskAccess.strict.enabledMsg)
                }
              >
                {busy
                  ? copy.riskAccess.strict.updating
                  : s.strictMode
                    ? copy.riskAccess.strict.on
                    : copy.riskAccess.strict.off}
              </button>
              {!s.strictMode ? (
                s.strictModeUntilKnown ? (
                  strictLingerActive(s, Math.floor(Date.now() / 1000)) ? (
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
