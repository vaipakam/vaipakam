import { useCallback, useEffect, useState } from 'react';
import { Repeat, AlertTriangle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDiamondContract, useDiamondRead } from '../../contracts/useDiamond';
import { autoLifecycleErrorOrRaw } from '../../lib/autoLifecycleErrors';

interface RefinanceCaps {
  enabled: boolean;
  maxRateBps: number;
  maxNewExpiry: bigint;
  setter: string;
}

interface ExtendCaps {
  enabled: boolean;
  minRateBps: number;
  maxRateBps: number;
  maxNewExpiry: bigint;
  setter: string;
}

interface Props {
  loanId: bigint;
  isBorrower: boolean;
  isLender: boolean;
  /** T-092-B (#531) — when true, the loan's collateral is an NFT
   *  (ERC721 / ERC1155). Default-time outcome is asymmetric: the
   *  WHOLE NFT transfers to the lender, no swap, borrower loses
   *  100%. The card surfaces a stark warning before enabling caps
   *  so the user consciously consents to that tail-risk. */
  collateralIsNft?: boolean;
  /** #545 — fired after the borrower saves their refinance caps, so a parent
   *  (the LoanDetails pre-grace banner) can re-read `getAutoRefinanceCaps` and
   *  reflect an enable/disable immediately instead of waiting for a reload. */
  onCapsChanged?: () => void;
  /** #799 — `true` when the connected holder's keeper can't act on this loan
   *  (keeper master switch off, or no keeper approved). Auto-refinance /
   *  auto-extend are keeper-executed, so an enabled cap is INERT in this state.
   *  Surfaces the kill-switch as a card-level warning so the user knows the
   *  automation they're configuring cannot fire until they fix keeper access. */
  keeperCannotAct?: boolean;
}

/** Format unix-seconds to "yyyy-mm-dd" for the date input. */
function unixToDateInput(unix: bigint): string {
  if (unix === 0n) return '';
  const d = new Date(Number(unix) * 1000);
  return d.toISOString().slice(0, 10);
}

/** Parse "yyyy-mm-dd" back to unix-seconds (UTC midnight). */
function dateInputToUnix(s: string): bigint {
  if (!s) return 0n;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return 0n;
  return BigInt(Math.floor(ms / 1000));
}

/** BPS ↔ percent helpers. 1500 → "15", 100 → "1", 575 → "5.75". */
function bpsToPctStr(bps: number): string {
  if (bps % 100 === 0) return (bps / 100).toString();
  return (bps / 100).toFixed(2).replace(/\.?0+$/, '');
}

function pctStrToBps(s: string): number {
  const n = Number(s);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/**
 * T-092 #511 sub (#521) — per-loan auto-refinance + auto-extend
 * caps editor. Renders three sections depending on which side(s)
 * of the loan the connected wallet holds:
 *
 *   - Borrower side (when `isBorrower`):
 *       * Refinance caps (`setAutoRefinanceCaps`)
 *       * Auto-extend caps (`setAutoExtendBorrowerCaps`)
 *
 *   - Lender side (when `isLender`):
 *       * Auto-extend caps (`setAutoExtendLenderCaps`)
 *
 * Each section shows the current on-chain state via the matching
 * getter (which applies the staleness fence internally — if the
 * NFT changed hands since the setter wrote the cap, `enabled`
 * returns false and we render a "caps stale — re-set to
 * reactivate" banner).
 */
export default function AutoLifecycleLoanCapsCard({
  loanId,
  isBorrower,
  isLender,
  collateralIsNft = false,
  onCapsChanged,
  keeperCannotAct = false,
}: Props) {
  const { t } = useTranslation();
  const diamond = useDiamondContract();
  const diamondRo = useDiamondRead();

  const [refinanceCaps, setRefinanceCaps] = useState<RefinanceCaps | null>(null);
  const [extendBorrowerCaps, setExtendBorrowerCaps] = useState<ExtendCaps | null>(null);
  const [extendLenderCaps, setExtendLenderCaps] = useState<ExtendCaps | null>(null);

  const reload = useCallback(async () => {
    if (!diamondRo) return;
    try {
      if (isBorrower) {
        const [refi, ext] = await Promise.all([
          (diamondRo as unknown as {
            getAutoRefinanceCaps: (id: bigint) => Promise<RefinanceCaps>;
          }).getAutoRefinanceCaps(loanId),
          (diamondRo as unknown as {
            getAutoExtendBorrowerCaps: (id: bigint) => Promise<ExtendCaps>;
          }).getAutoExtendBorrowerCaps(loanId),
        ]);
        setRefinanceCaps(refi);
        setExtendBorrowerCaps(ext);
      }
      if (isLender) {
        const ext = await (diamondRo as unknown as {
          getAutoExtendLenderCaps: (id: bigint) => Promise<ExtendCaps>;
        }).getAutoExtendLenderCaps(loanId);
        setExtendLenderCaps(ext);
      }
    } catch {
      // Facet not deployed on this chain — render nothing.
    }
  }, [diamondRo, loanId, isBorrower, isLender]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!isBorrower && !isLender) return null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-title" style={{ marginBottom: 8 }}>
        <Repeat size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
        {t('autoLifecycleLoanCaps.title')}
      </div>
      <p className="stat-label" style={{ margin: '0 0 12px' }}>
        {t('autoLifecycleLoanCaps.body')}
      </p>

      {/* #799 — keeper kill-switch visibility: auto-refinance / auto-extend are
          keeper-executed, so they cannot fire while the holder's keeper master
          switch is off or no keeper is approved. Show it as a card-level
          warning so an enabled cap isn't mistaken for active protection. */}
      {keeperCannotAct && (
        <div className="alert alert-warning" role="alert" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} />
          <div>{t('autoLifecycleLoanCaps.keeperOffWarning')}</div>
        </div>
      )}

      {collateralIsNft && (
        <div
          className="alert alert-warning"
          role="alert"
          style={{ marginBottom: 12 }}
        >
          <AlertTriangle size={14} />
          <div>{t('autoLifecycleLoanCaps.nftCollateralWarning')}</div>
        </div>
      )}

      {/* #545 — the pre-grace warning now lives as a prominent banner near the
          loan title on LoanDetails (with "Tighten refinance caps" + "Repay now"
          CTAs, the latter scrolling here). The earlier in-card duplicate was
          removed to avoid two identical warnings on the same page. */}

      {isBorrower && refinanceCaps && (
        <RefinanceCapsEditor
          loanId={loanId}
          current={refinanceCaps}
          diamond={diamond}
          onSaved={() => {
            void reload();
            onCapsChanged?.(); // #545 — let the LoanDetails banner re-read caps
          }}
        />
      )}

      {isBorrower && extendBorrowerCaps && (
        <ExtendCapsEditor
          loanId={loanId}
          current={extendBorrowerCaps}
          diamond={diamond}
          variant="borrower"
          onSaved={() => void reload()}
        />
      )}

      {/* T-092 (#546) — alerts subscription CTA. When the borrower
          has refinance caps enabled, surface a banner suggesting
          they set up TG / Push alerts so the keeper's pre-grace
          watcher (#532) can warn them if no match is found in
          time. Mirrors the pre-grace warning banner above but
          serves a different purpose: that one is a "your loan is
          approaching grace now" alert; this one is a "set up your
          notification channel so you'll be warned next time"
          nudge.

          Static for v1 — doesn't query actual subscription state
          (would require an extra fetch to the apps/agent's
          subscriptions endpoint). Future enhancement: hide the
          banner when the user has already subscribed for this
          chain. */}
      {isBorrower && refinanceCaps?.enabled && (
        <div
          className="alert alert-info"
          role="status"
          style={{ marginTop: 12 }}
        >
          <AlertTriangle size={14} />
          <div>
            {t('autoLifecycleLoanCaps.alertsSubscriptionCTA')}{' '}
            <a href="/alerts">{t('autoLifecycleLoanCaps.alertsLinkText')}</a>
          </div>
        </div>
      )}

      {isLender && extendLenderCaps && (
        <ExtendCapsEditor
          loanId={loanId}
          current={extendLenderCaps}
          diamond={diamond}
          variant="lender"
          onSaved={() => void reload()}
        />
      )}
    </div>
  );
}

// ─── Refinance caps editor (borrower side) ──────────────────────────

interface RefinanceCapsEditorProps {
  loanId: bigint;
  current: RefinanceCaps;
  diamond: unknown;
  onSaved: () => void;
}

function RefinanceCapsEditor({
  loanId,
  current,
  diamond,
  onSaved,
}: RefinanceCapsEditorProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(current.enabled);
  const [maxRatePct, setMaxRatePct] = useState(bpsToPctStr(current.maxRateBps));
  const [maxExpiryDate, setMaxExpiryDate] = useState(unixToDateInput(current.maxNewExpiry));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setPending(true);
    try {
      const tx = await (diamond as {
        setAutoRefinanceCaps: (
          id: bigint, enabled: boolean, maxRateBps: number, maxNewExpiry: bigint,
        ) => Promise<{ wait: () => Promise<unknown> }>;
      }).setAutoRefinanceCaps(
        loanId,
        enabled,
        pctStrToBps(maxRatePct),
        dateInputToUnix(maxExpiryDate),
      );
      await tx.wait();
      onSaved();
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
      <strong>{t('autoLifecycleLoanCaps.refinanceTitle')}</strong>
      <div className="stat-label" style={{ marginBottom: 8 }}>
        {t('autoLifecycleLoanCaps.refinanceHint')}
      </div>
      {/* #799 — best-effort warning is now PERSISTENT while caps are enabled,
          not only during the false → true transition (T-092/#543). Auto-refinance
          is best-effort, not default protection: a lender/borrower must keep
          seeing that while the cap is on, so they don't read an enabled cap as a
          guaranteed rescue. Shows whenever the box is checked (pending or saved);
          hides only when the user un-checks it. */}
      {enabled && (
        <div className="alert alert-warning" role="alert" style={{ marginBottom: 8 }}>
          <AlertTriangle size={14} />
          <div>{t('autoLifecycleLoanCaps.bestEffortWarning')}</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('autoLifecycleLoanCaps.enabled')}
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="stat-label">{t('autoLifecycleLoanCaps.maxRatePct')}</span>
          <input
            type="number" step="0.01" min="0"
            value={maxRatePct}
            onChange={(e) => setMaxRatePct(e.target.value)}
            style={{ width: 80 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="stat-label">{t('autoLifecycleLoanCaps.maxExpiryDate')}</span>
          <input
            type="date"
            value={maxExpiryDate}
            onChange={(e) => setMaxExpiryDate(e.target.value)}
          />
        </label>
        <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={pending}>
          {pending ? t('autoLifecycleLoanCaps.statePending') : t('autoLifecycleLoanCaps.actionSave')}
        </button>
      </div>
      {current.enabled && (
        <div className="stat-label" style={{ marginTop: 6, color: 'var(--accent-green)' }}>
          <Check size={12} /> {t('autoLifecycleLoanCaps.stateActive')}
        </div>
      )}
      {error && (
        <div className="alert alert-warning" role="status" style={{ marginTop: 8 }}>
          <AlertTriangle size={14} />
          <div>{error}</div>
        </div>
      )}
    </div>
  );
}

// ─── Extend caps editor (borrower OR lender side) ───────────────────

interface ExtendCapsEditorProps {
  loanId: bigint;
  current: ExtendCaps;
  diamond: unknown;
  variant: 'borrower' | 'lender';
  onSaved: () => void;
}

function ExtendCapsEditor({
  loanId, current, diamond, variant, onSaved,
}: ExtendCapsEditorProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(current.enabled);
  const [minRatePct, setMinRatePct] = useState(bpsToPctStr(current.minRateBps));
  const [maxRatePct, setMaxRatePct] = useState(bpsToPctStr(current.maxRateBps));
  const [maxExpiryDate, setMaxExpiryDate] = useState(unixToDateInput(current.maxNewExpiry));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setPending(true);
    try {
      const fn = variant === 'borrower'
        ? 'setAutoExtendBorrowerCaps'
        : 'setAutoExtendLenderCaps';
      const tx = await (diamond as Record<string, (
        id: bigint, enabled: boolean,
        minRateBps: number, maxRateBps: number, maxNewExpiry: bigint,
      ) => Promise<{ wait: () => Promise<unknown> }>>)[fn](
        loanId,
        enabled,
        pctStrToBps(minRatePct),
        pctStrToBps(maxRatePct),
        dateInputToUnix(maxExpiryDate),
      );
      await tx.wait();
      onSaved();
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
    } finally {
      setPending(false);
    }
  };

  const titleKey = variant === 'borrower'
    ? 'autoLifecycleLoanCaps.extendBorrowerTitle'
    : 'autoLifecycleLoanCaps.extendLenderTitle';
  const hintKey = variant === 'borrower'
    ? 'autoLifecycleLoanCaps.extendBorrowerHint'
    : 'autoLifecycleLoanCaps.extendLenderHint';

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
      <strong>{t(titleKey)}</strong>
      <div className="stat-label" style={{ marginBottom: 8 }}>{t(hintKey)}</div>
      {/* #799 — PERSISTENT while enabled (was transition-only, T-092/#543).
          Extend is best-effort: it only fires if BOTH sides have consent AND
          the keeper fires within grace, so the warning stays up the whole time
          the cap is on. */}
      {enabled && (
        <div className="alert alert-warning" role="alert" style={{ marginBottom: 8 }}>
          <AlertTriangle size={14} />
          <div>{t('autoLifecycleLoanCaps.bestEffortWarning')}</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('autoLifecycleLoanCaps.enabled')}
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="stat-label">{t('autoLifecycleLoanCaps.minRatePct')}</span>
          <input
            type="number" step="0.01" min="0"
            value={minRatePct}
            onChange={(e) => setMinRatePct(e.target.value)}
            style={{ width: 80 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="stat-label">{t('autoLifecycleLoanCaps.maxRatePct')}</span>
          <input
            type="number" step="0.01" min="0"
            value={maxRatePct}
            onChange={(e) => setMaxRatePct(e.target.value)}
            style={{ width: 80 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="stat-label">{t('autoLifecycleLoanCaps.maxExpiryDate')}</span>
          <input
            type="date"
            value={maxExpiryDate}
            onChange={(e) => setMaxExpiryDate(e.target.value)}
          />
        </label>
        <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={pending}>
          {pending ? t('autoLifecycleLoanCaps.statePending') : t('autoLifecycleLoanCaps.actionSave')}
        </button>
      </div>
      {current.enabled && (
        <div className="stat-label" style={{ marginTop: 6, color: 'var(--accent-green)' }}>
          <Check size={12} /> {t('autoLifecycleLoanCaps.stateActive')}
        </div>
      )}
      {error && (
        <div className="alert alert-warning" role="status" style={{ marginTop: 8 }}>
          <AlertTriangle size={14} />
          <div>{error}</div>
        </div>
      )}
    </div>
  );
}
