import { useCallback, useEffect, useState } from 'react';
import { Repeat, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../../context/WalletContext';
import { useDiamondContract, useDiamondRead } from '../../contracts/useDiamond';
import { autoLifecycleErrorOrRaw } from '../../lib/autoLifecycleErrors';
import { CardInfo } from '../CardInfo';

/**
 * T-092 #511 sub (#520) — per-user auto-lifecycle opt-in surface.
 *
 * Two toggles:
 *   - **Auto-lend opt-in** (`setAutoLendConsent`) — when true, the
 *     dapp may auto-post standing offers from vault deposits, and
 *     keepers may match those offers. Disabled when the admin kill
 *     switch (`getAutoLendEnabled`) is off.
 *   - **Auto-opt-in on every new loan** (`setAutoOptInOnNewLoan`) —
 *     borrower convenience. When true, every new loan auto-populates
 *     its per-loan `autoRefinanceCaps` from the user's stored
 *     defaults (set via the LoanDetails per-loan editor, separate
 *     card #521).
 *
 * Per-loan refinance / extend cap editors live on the LoanDetails
 * page (separate sub-card #521). The default-caps editor (rate +
 * expiry inputs) is also deferred to the LoanDetails follow-up —
 * the per-user storage primitive
 * (`setDefaultAutoRefinanceCaps(enabled, maxRateBps, maxNewExpiry)`)
 * is already on-chain, awaiting form wiring.
 */
export default function AutoLifecycleSettingsCard() {
  const { t } = useTranslation();
  const { address } = useWallet();
  const diamond = useDiamondContract();
  const diamondRo = useDiamondRead();

  const [lendEnabled, setLendEnabled] = useState<boolean | null>(null);
  const [optInEnabled, setOptInEnabled] = useState<boolean | null>(null);
  // Admin kill-switch state — when false, the auto-lend toggle is
  // disabled because `setAutoLendConsent(true)` would revert with
  // `AutoLendDisabled`. Users can still revoke (set to false).
  const [adminAllowsLend, setAdminAllowsLend] = useState<boolean | null>(null);
  const [pending, setPending] = useState<'lend' | 'optIn' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // T-092-F (#537) — two-step confirm state. First Enable click sets
  // `confirming`; second click submits the actual setter. Clicking
  // a different toggle, or any non-Enable interaction, clears it.
  // Disabling never requires confirmation — safe direction.
  const [confirming, setConfirming] = useState<'lend' | 'optIn' | null>(null);

  const reload = useCallback(async () => {
    if (!address || !diamondRo) {
      setLendEnabled(null);
      setOptInEnabled(null);
      setAdminAllowsLend(null);
      return;
    }
    try {
      const [lendCurrent, optInCurrent, adminCurrent] = await Promise.all([
        (
          diamondRo as unknown as {
            getAutoLendConsent: (user: string) => Promise<boolean>;
          }
        ).getAutoLendConsent(address),
        (
          diamondRo as unknown as {
            getAutoOptInOnNewLoan: (user: string) => Promise<boolean>;
          }
        ).getAutoOptInOnNewLoan(address),
        (
          diamondRo as unknown as {
            getAutoLendEnabled: () => Promise<boolean>;
          }
        ).getAutoLendEnabled(),
      ]);
      setLendEnabled(Boolean(lendCurrent));
      setOptInEnabled(Boolean(optInCurrent));
      setAdminAllowsLend(Boolean(adminCurrent));
    } catch {
      // Diamond may not have the auto-lifecycle facet cut yet (old
      // testnet deploy). Leave the panel in its loading state.
    }
  }, [address, diamondRo]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggleLend = async () => {
    if (!address || !diamond || lendEnabled == null) return;
    // T-092-F two-step: if currently disabled AND not yet in
    // confirmation, switch to confirmation state instead of
    // submitting. Disabling is the safe direction → no confirmation.
    if (!lendEnabled && confirming !== 'lend') {
      setConfirming('lend');
      return;
    }
    setError(null);
    setPending('lend');
    const next = !lendEnabled;
    try {
      const tx = await (
        diamond as unknown as {
          setAutoLendConsent: (
            enabled: boolean,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).setAutoLendConsent(next);
      await tx.wait();
      setLendEnabled(next);
      setConfirming(null);
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
    } finally {
      setPending(null);
    }
  };

  const handleToggleOptIn = async () => {
    if (!address || !diamond || optInEnabled == null) return;
    // T-092-F two-step (see handleToggleLend).
    if (!optInEnabled && confirming !== 'optIn') {
      setConfirming('optIn');
      return;
    }
    setError(null);
    setPending('optIn');
    const next = !optInEnabled;
    try {
      const tx = await (
        diamond as unknown as {
          setAutoOptInOnNewLoan: (
            enabled: boolean,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).setAutoOptInOnNewLoan(next);
      await tx.wait();
      setOptInEnabled(next);
      setConfirming(null);
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
    } finally {
      setPending(null);
    }
  };

  if (!address) return null;

  // Hide entirely when the facet isn't readable — keeps old deploys
  // and pre-T-092 chains from showing a broken card.
  if (lendEnabled == null && optInEnabled == null && adminAllowsLend == null) {
    return null;
  }

  const adminBlocksNewLendOptIn = adminAllowsLend === false;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Repeat
          size={22}
          style={{
            color: lendEnabled || optInEnabled
              ? 'var(--accent-green)'
              : 'var(--text-tertiary)',
            flexShrink: 0,
            marginTop: 2,
          }}
        />
        <div style={{ flex: 1 }}>
          <div className="card-title" style={{ marginBottom: 4 }}>
            {t('autoLifecycleSettings.title')}
            <CardInfo id="dashboard.auto-lifecycle-settings" />
          </div>
          <p className="stat-label" style={{ margin: '0 0 10px' }}>
            {t('autoLifecycleSettings.body')}
          </p>

          {adminBlocksNewLendOptIn && (
            <div
              className="alert alert-info"
              role="status"
              style={{ marginBottom: 10 }}
            >
              <AlertTriangle size={14} />
              <div>{t('autoLifecycleSettings.adminDisabled')}</div>
            </div>
          )}

          {/* Auto-lend toggle */}
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1 }}>
                <strong>{t('autoLifecycleSettings.autoLendLabel')}</strong>
                <div className="stat-label">
                  {t('autoLifecycleSettings.autoLendHint')}
                </div>
              </div>
              <button
                className={
                  lendEnabled ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'
                }
                onClick={handleToggleLend}
                disabled={
                  pending !== null ||
                  lendEnabled == null ||
                  (!lendEnabled && adminBlocksNewLendOptIn)
                }
              >
                {pending === 'lend'
                  ? t('autoLifecycleSettings.statePending')
                  : lendEnabled
                    ? t('autoLifecycleSettings.actionDisable')
                    : confirming === 'lend'
                      ? t('autoLifecycleSettings.actionConfirm')
                      : t('autoLifecycleSettings.actionEnable')}
              </button>
            </div>
            {confirming === 'lend' && (
              <div
                className="alert alert-warning"
                role="alert"
                style={{ marginTop: 8 }}
              >
                <AlertTriangle size={14} />
                <div>{t('autoLifecycleSettings.bestEffortWarning')}</div>
              </div>
            )}
          </div>

          {/* Auto-opt-in-on-new-loan toggle */}
          <div>
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1 }}>
                <strong>{t('autoLifecycleSettings.optInLabel')}</strong>
                <div className="stat-label">
                  {t('autoLifecycleSettings.optInHint')}
                </div>
              </div>
              <button
                className={
                  optInEnabled
                    ? 'btn btn-secondary btn-sm'
                    : 'btn btn-primary btn-sm'
                }
                onClick={handleToggleOptIn}
                disabled={pending !== null || optInEnabled == null}
              >
                {pending === 'optIn'
                  ? t('autoLifecycleSettings.statePending')
                  : optInEnabled
                    ? t('autoLifecycleSettings.actionDisable')
                    : confirming === 'optIn'
                      ? t('autoLifecycleSettings.actionConfirm')
                      : t('autoLifecycleSettings.actionEnable')}
              </button>
            </div>
            {confirming === 'optIn' && (
              <div
                className="alert alert-warning"
                role="alert"
                style={{ marginTop: 8 }}
              >
                <AlertTriangle size={14} />
                <div>{t('autoLifecycleSettings.bestEffortWarning')}</div>
              </div>
            )}
          </div>

          {error && (
            <div
              className="alert alert-warning"
              role="status"
              style={{ marginTop: 10 }}
            >
              <AlertTriangle size={14} />
              <div>{error}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
