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
  /**
   * #394 Lever A (Codex #647 round-4) — the admission HF floor this gauge
   * should colour against. Defaults to {@link HF_INITIATION_MIN} (1.5) for
   * back-compat, but callers rendering an OPEN loan should pass that loan's
   * snapshotted floor (`minHealthFactorAtInit`), and callers previewing a NEW
   * offer should pass the live floor (`getProtocolConstants().minHealthFactor`),
   * so the safe/warning boundary tracks a governance retune instead of a stale
   * hard-coded 1.5.
   */
  initMin?: number;
}

function hfZone(v: number, initMin: number): 'safe' | 'warning' | 'danger' {
  if (v >= initMin) return 'safe';
  if (v >= HF_LIQUIDATION_THRESHOLD) return 'warning';
  return 'danger';
}

export function HealthFactorGauge({ value, initMin = HF_INITIATION_MIN }: HealthFactorProps) {
  const { t } = useTranslation();
  if (value === null) {
    return <span className="risk-gauge-empty">—</span>;
  }
  const zone = hfZone(value, initMin);
  const pct = Math.min(100, (value / 2.5) * 100);
  const label =
    zone === 'danger'
      ? t('riskGauge.hfDanger')
      : zone === 'warning'
        ? t('riskGauge.hfWarning', {
            init: initMin.toFixed(2),
            liq: HF_LIQUIDATION_THRESHOLD.toFixed(2),
          })
        : t('riskGauge.hfSafe', {
            init: initMin.toFixed(2),
            liq: HF_LIQUIDATION_THRESHOLD.toFixed(2),
          });

  return (
    <div className={`risk-gauge hf-${zone}`} data-tooltip={label} aria-label={label}>
      <div className="risk-gauge-track">
        <span className="risk-gauge-mark" style={{ left: `${(HF_LIQUIDATION_THRESHOLD / 2.5) * 100}%` }} data-mark="1.0" />
        <span className="risk-gauge-mark" style={{ left: `${(initMin / 2.5) * 100}%` }} data-mark={initMin.toFixed(1)} />
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

/**
 * Compact chip variants — number-only with a coloured background per
 * zone. Use these in dense table rows where the full track + fill bar
 * eats too much horizontal space (Dashboard's loan list, Risk Watch
 * grid). The single-loan / preview surfaces keep the bar variant
 * because they have room and the threshold-mark gives users a feel
 * for "how far from liquidation am I?". Both share the same zone
 * classification + tooltip so the colour grammar is consistent across
 * compact and full views.
 */
export function HealthFactorChip({ value, initMin = HF_INITIATION_MIN }: HealthFactorProps) {
  const { t } = useTranslation();
  if (value === null) {
    return <span className="risk-gauge-empty">—</span>;
  }
  const zone = hfZone(value, initMin);
  const label =
    zone === 'danger'
      ? t('riskGauge.hfDanger')
      : zone === 'warning'
        ? t('riskGauge.hfWarning', {
            init: initMin.toFixed(2),
            liq: HF_LIQUIDATION_THRESHOLD.toFixed(2),
          })
        : t('riskGauge.hfSafe', {
            init: initMin.toFixed(2),
            liq: HF_LIQUIDATION_THRESHOLD.toFixed(2),
          });

  return (
    <span
      className={`risk-chip hf-${zone}`}
      data-tooltip={label}
      aria-label={label}
    >
      {value.toFixed(2)}
    </span>
  );
}

export function LTVChip({ percent }: LTVProps) {
  const { t } = useTranslation();
  if (percent === null) {
    return <span className="risk-gauge-empty">—</span>;
  }
  const zone = ltvZone(percent);
  const label =
    zone === 'danger'
      ? t('riskGauge.ltvDanger', { threshold: LTV_VOLATILITY_THRESHOLD })
      : zone === 'warning'
        ? t('riskGauge.ltvWarning', { threshold: LTV_VOLATILITY_THRESHOLD })
        : t('riskGauge.ltvSafe', { threshold: LTV_VOLATILITY_THRESHOLD });

  return (
    <span
      className={`risk-chip ltv-${zone}`}
      data-tooltip={label}
      aria-label={label}
    >
      {percent.toFixed(2)}%
    </span>
  );
}
