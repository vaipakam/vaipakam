import { type FC } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBps, type FormatBpsOptions } from '../../lib/bpsFormat';

/**
 * Props for {@link BpsValue}.
 */
export interface BpsValueProps extends FormatBpsOptions {
  /** Basis-points value (the protocol's stored shape). */
  bps: number;
  /** Optional className passthrough for layout-side styling hooks. */
  className?: string;
  /**
   * When true (default), the rendered element is a `<span>` with the
   * tooltip text in `title=`. Set to false to render the display-only
   * variant (no title attribute) — useful inside tooltip-capable
   * higher-level components that already manage their own surface.
   */
  withTitle?: boolean;
}

/**
 * `BpsValue` — the canonical React surface for a basis-points value
 * per the UX direction ADR Tier A.6 (PR #201). Renders the percent
 * display in the visible slot + the `"X.XX % (Y bps)"` tooltip on
 * hover.
 *
 * Replaces ad-hoc `${(bps / 100).toFixed(2)} %` inline expressions
 * scattered across `Dashboard`, `LenderEarlyWithdrawal`, `NftVerifier`,
 * `PublicDashboard`, and `OfferBook`. Consuming sub-cards migrate
 * those call sites to `<BpsValue bps={x} />` in their respective
 * reworks; this card ships the component + helpers alone.
 *
 * @example
 * <BpsValue bps={505} />
 * // renders: <span title="5.05 % (505 bps)">5.05 %</span>
 *
 * <BpsValue bps={offer.interestRateBpsMax} precision={1} />
 * // renders the same shape at 1-decimal precision
 *
 * <BpsValue bps={treasuryFeeBps} withBpsHint={false} />
 * // no BPS qualifier in the tooltip; tooltip == display
 */
export const BpsValue: FC<BpsValueProps> = ({
  bps,
  precision,
  withBpsHint,
  className,
  withTitle = true,
}) => {
  // Pull the active i18n locale so percent / digit formatting tracks
  // the user's language. Codex round-1 P2 caught the pre-locale shape
  // would have shown English punctuation in every locale.
  const { i18n } = useTranslation();
  const { display, tooltip } = formatBps(bps, {
    precision,
    withBpsHint,
    locale: i18n.language,
  });
  return (
    <span
      className={className}
      // The tooltip is the BPS-grounded version of the value. Browsers
      // surface `title=` as a native tooltip on hover; mobile + AT
      // pick it up via the accessible-name fallback chain — no extra
      // wiring needed.
      {...(withTitle ? { title: tooltip } : {})}
    >
      {display}
    </span>
  );
};
