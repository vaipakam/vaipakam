import { useTranslation } from 'react-i18next';
import './RiskGauge.css';

/**
 * Visual LTV / HF indicators with tooltips explaining the liquidation
 * thresholds enforced on-chain (see LibVaipakam.MIN_HEALTH_FACTOR = 1.5e18
 * and VOLATILITY_LTV_THRESHOLD_BPS = 110%). Colour zones match the protocol
 * buckets: safe ≥ initiation min, warning between liquidation and init min,
 * danger below liquidation threshold.
 */

export const HF_LIQUIDATION_THRESHOLD = 1.0;
export const HF_INITIATION_MIN = 1.5;
export const LTV_VOLATILITY_THRESHOLD = 110;

interface HealthFactorProps {
  value: number | null;
}

function hfZone(v: number): 'safe' | 'warning' | 'danger' {
  if (v >= HF_INITIATION_MIN) return 'safe';
  if (v >= HF_LIQUIDATION_THRESHOLD) return 'warning';
  return 'danger';
}

export function HealthFactorGauge({ value }: HealthFactorProps) {
  const { t } = useTranslation();
  if (value === null) {
    return <span className="risk-gauge-empty">—</span>;
  }
  const zone = hfZone(value);
  const pct = Math.min(100, (value / 2.5) * 100);
  const label =
    zone === 'danger'
      ? t('riskGauge.hfDanger')
      : zone === 'warning'
        ? t('riskGauge.hfWarning', {
            init: HF_INITIATION_MIN.toFixed(2),
            liq: HF_LIQUIDATION_THRESHOLD.toFixed(2),
          })
        : t('riskGauge.hfSafe', {
            init: HF_INITIATION_MIN.toFixed(2),
            liq: HF_LIQUIDATION_THRESHOLD.toFixed(2),
          });

  return (
    <div className={`risk-gauge hf-${zone}`} data-tooltip={label} aria-label={label}>
      <div className="risk-gauge-track">
        <span className="risk-gauge-mark" style={{ left: `${(HF_LIQUIDATION_THRESHOLD / 2.5) * 100}%` }} data-mark="1.0" />
        <span className="risk-gauge-mark" style={{ left: `${(HF_INITIATION_MIN / 2.5) * 100}%` }} data-mark="1.5" />
        <div className="risk-gauge-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="risk-gauge-value">{value.toFixed(2)}</div>
    </div>
  );
}

interface LTVProps {
  percent: number | null;
}

function ltvZone(p: number): 'safe' | 'warning' | 'danger' {
  if (p >= LTV_VOLATILITY_THRESHOLD) return 'danger';
  if (p >= 80) return 'warning';
  return 'safe';
}

export function LTVBar({ percent }: LTVProps) {
  const { t } = useTranslation();
  if (percent === null) {
    return <span className="risk-gauge-empty">—</span>;
  }
  const zone = ltvZone(percent);
  const pct = Math.min(100, (percent / 120) * 100);
  const label =
    zone === 'danger'
      ? t('riskGauge.ltvDanger', { threshold: LTV_VOLATILITY_THRESHOLD })
      : zone === 'warning'
        ? t('riskGauge.ltvWarning', { threshold: LTV_VOLATILITY_THRESHOLD })
        : t('riskGauge.ltvSafe', { threshold: LTV_VOLATILITY_THRESHOLD });

  return (
    <div className={`risk-gauge ltv-${zone}`} data-tooltip={label} aria-label={label}>
      <div className="risk-gauge-track">
        <span className="risk-gauge-mark" style={{ left: `${(LTV_VOLATILITY_THRESHOLD / 120) * 100}%` }} data-mark={`${LTV_VOLATILITY_THRESHOLD}%`} />
        <div className="risk-gauge-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="risk-gauge-value">{percent.toFixed(2)}%</div>
    </div>
  );
}
