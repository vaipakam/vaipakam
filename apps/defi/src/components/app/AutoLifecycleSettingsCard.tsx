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
 * #625 WI-1 — auto-lend was REWIRED off the legacy fixed-duration
 * offer-posting marker onto the standing LenderIntent layer and now
 * lives in its own card (`AutoLendIntentCard`). This card keeps the
 * remaining borrower-convenience toggle:
 *
 *   - **Auto-opt-in on every new loan** (`setAutoOptInOnNewLoan`) —
 *     when true, every new ERC20-principal loan auto-populates its
 *     per-loan `autoRefinanceCaps` from the user's stored defaults
 *     (set via the LoanDetails per-loan editor, separate card #521).
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

  const [optInEnabled, setOptInEnabled] = useState<boolean | null>(null);
  // The wallet `optInEnabled` was last read for — the toggle is only
  // trusted while it matches the connected wallet, so a previous wallet's
  // value can't flip the newly connected one during the pre-reload window.
  const [loadedAddr, setLoadedAddr] = useState<string>('');
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // T-092-F (#537) — two-step confirm. First Enable click sets
  // `confirming`; second click submits. Disabling never requires
  // confirmation — safe direction.
  const [confirming, setConfirming] = useState<boolean>(false);

  const reload = useCallback(async () => {
    // Return early without a synchronous reset (the card returns null
    // when there's no address; a missing diamond just leaves the panel
    // loading) so every setState lands post-await — keeps
    // react-hooks/set-state-in-effect satisfied.
    if (!address || !diamondRo) return;
    try {
      const optInCurrent = await (
        diamondRo as unknown as {
          getAutoOptInOnNewLoan: (user: string) => Promise<boolean>;
        }
      ).getAutoOptInOnNewLoan(address);
      setOptInEnabled(Boolean(optInCurrent));
      setLoadedAddr(address);
    } catch {
      // Diamond may not have the auto-lifecycle facet cut yet (old
      // testnet deploy). Leave the panel in its loading state.
    }
  }, [address, diamondRo]);

  useEffect(() => {
    // Data-sync effect: pulls the opt-in flag into React state. Writes
    // are post-await; the rule flags the call site regardless, so opt
    // out here as the other data-loading hooks do.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  // Trust the loaded opt-in only while it belongs to the connected wallet.
  const optInView = !!address && loadedAddr === address ? optInEnabled : null;

  const handleToggleOptIn = async () => {
    if (!address || !diamond || optInView == null) return;
    // T-092-F two-step: enabling requires a confirm click first.
    if (!optInView && !confirming) {
      setConfirming(true);
      return;
    }
    setError(null);
    setPending(true);
    const next = !optInView;
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
      setConfirming(false);
    } catch (err) {
      setError(autoLifecycleErrorOrRaw(err, t));
    } finally {
      setPending(false);
    }
  };

  if (!address) return null;

  // Hide entirely when the facet isn't readable for the CURRENT wallet —
  // keeps old deploys / pre-T-092 chains, and a not-yet-loaded wallet
  // switch, from showing a stale or broken card.
  if (optInView == null) return null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <Repeat
          size={22}
          style={{
            color: optInView ? 'var(--accent-green)' : 'var(--text-tertiary)',
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
                  optInView
                    ? 'btn btn-secondary btn-sm'
                    : 'btn btn-primary btn-sm'
                }
                onClick={handleToggleOptIn}
                disabled={pending || optInView == null}
              >
                {pending
                  ? t('autoLifecycleSettings.statePending')
                  : optInView
                    ? t('autoLifecycleSettings.actionDisable')
                    : confirming
                      ? t('autoLifecycleSettings.actionConfirm')
                      : t('autoLifecycleSettings.actionEnable')}
              </button>
            </div>
            {confirming && (
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
