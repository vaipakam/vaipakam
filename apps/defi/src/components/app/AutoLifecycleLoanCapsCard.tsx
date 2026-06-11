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

      {isBorrower && refinanceCaps && (
        <RefinanceCapsEditor
          loanId={loanId}
          current={refinanceCaps}
          diamond={diamond}
          onSaved={() => void reload()}
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
