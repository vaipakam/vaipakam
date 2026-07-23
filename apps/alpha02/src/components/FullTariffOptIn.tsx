/**
 * #1355 (M2 PR-8) — the Full VPFI tariff opt-in control, shared by the
 * classic accept review (OfferFlow) and the desk signed-fill confirm.
 *
 * Renders NOTHING unless the fee-entitlement feature is live-enabled on
 * chain: with the kill-switch off a presented Full authorization is a
 * FAILED opt-in (revert unless the party pre-allowed a downgrade), so a
 * dark deploy must not invite one. Likewise renders nothing for a loan
 * whose tariff can't be quoted only when unchecked — once the user has
 * engaged, a quote failure is SHOWN (the opt-in disables) rather than
 * silently dropped.
 *
 * The signed `maxCStar` ceiling — not the displayed quote — is what
 * bounds the vault pull at fill; the control therefore refuses to hand
 * back `full: true` without a positive ceiling, and it defaults the
 * ceiling to the live quote plus a small headroom so an oracle move
 * between review and fill doesn't spuriously block (the user can edit
 * it to any value they actually authorize).
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { parseUnits } from 'viem';
import type { Address } from 'viem';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { isAssetIlliquidLive } from '../contracts/preflights';
import { useCStarQuote, useFeeEntitlementConfig } from '../data/tariff';
import { useVpfi, VPFI_DECIMALS } from '../data/vpfi';
import { exactAmountString, formatTokenAmount } from '../lib/format';
import { isPlainDecimal } from '../lib/errors';

export interface FullTariffChoice {
  full: boolean;
  maxCStar: bigint;
  allowDowngrade: boolean;
}

export const FULL_TARIFF_OFF: FullTariffChoice = {
  full: false,
  maxCStar: 0n,
  allowDowngrade: false,
};

/** Default ceiling headroom over the live quote: +10% (bps). */
const CEILING_HEADROOM_BPS = 1000n;

export function FullTariffOptIn({
  lendingAsset,
  principal,
  durationDays,
  value,
  onChange,
}: {
  /** Prospective loan's ERC-20 principal asset. */
  lendingAsset: Address | undefined;
  /** Prospective filled principal in lending-asset wei. */
  principal: bigint | undefined;
  /** Prospective term in days. */
  durationDays: number | undefined;
  value: FullTariffChoice;
  onChange: (v: FullTariffChoice) => void;
}) {
  const config = useFeeEntitlementConfig();
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const quote = useCStarQuote({
    lendingAsset,
    principal,
    durationDays,
    enabled: config.enabled,
  });
  // Codex #1412 r3 — the contract treats an ILLIQUID principal as a
  // failed Full opt-in even when it is priceable (`numeraireOk` true),
  // so the surface gates on the live liquidity verdict too. failClosed
  // throws on a read failure → isError → treated as blocked below (an
  // unknown must never render as "liquid, Full available").
  const liquidity = useQuery({
    queryKey: [
      'principalLiquidity',
      readChain.chainId,
      lendingAsset?.toLowerCase(),
    ],
    enabled: config.enabled && Boolean(publicClient) && Boolean(lendingAsset),
    staleTime: 30_000,
    queryFn: () =>
      isAssetIlliquidLive({
        publicClient: publicClient!,
        diamondAddress: readChain.diamondAddress,
        asset: lendingAsset!,
        failClosed: true,
      }),
  });
  const vpfi = useVpfi();
  // Full is known-unavailable for this loan: quote errored / resolved
  // unpriceable, or the principal read as illiquid (or unknowable).
  const fullBlocked =
    quote.isError ||
    (quote.data !== undefined && !quote.data.numeraireOk) ||
    liquidity.isError ||
    liquidity.data === true;
  // Both reads settled AFFIRMATIVELY — only then may Full be ticked.
  const fullOfferable =
    quote.data?.numeraireOk === true && liquidity.data === false;

  // Ceiling text field — seeded from the FIRST live quote, then owned
  // by the user (a refreshed quote must never overwrite an edit).
  const [ceilingText, setCeilingText] = useState<string | null>(null);

  const quoted = quote.data?.numeraireOk === true ? quote.data.cStar : undefined;
  const suggestedCeiling =
    quoted !== undefined
      ? quoted + (quoted * CEILING_HEADROOM_BPS) / 10000n
      : undefined;

  useEffect(() => {
    if (ceilingText === null && suggestedCeiling !== undefined) {
      setCeilingText(exactAmountString(suggestedCeiling, VPFI_DECIMALS));
    }
  }, [ceilingText, suggestedCeiling]);

  const ceiling = useMemo(() => {
    if (ceilingText === null || !isPlainDecimal(ceilingText)) return undefined;
    try {
      return parseUnits(ceilingText, VPFI_DECIMALS);
    } catch {
      return undefined;
    }
  }, [ceilingText]);

  // Codex #1412 r1/r3 — a Full choice must never outlive the
  // conditions it was made under. If the kill-switch no longer reads
  // enabled (mid-session disable, or a refetch error — the config
  // hook fails closed), or the loan becomes known-unable to complete
  // Full (unpriceable, illiquid, or those reads erroring), clear the
  // choice: otherwise the control hides while the parent still passes
  // a stale `full: true` to the signer — a hidden authorization that
  // can only revert or silently downgrade at accept time.
  useEffect(() => {
    if (!value.full) return;
    if (!config.enabled || fullBlocked) onChange(FULL_TARIFF_OFF);
  }, [config.enabled, fullBlocked, value.full, onChange, value]);

  // Keep the parent's `maxCStar` in lockstep with the edited ceiling —
  // an unparseable edit propagates as 0n, which the signer refuses, so
  // a submit can never race the user's typing into a stale ceiling.
  useEffect(() => {
    if (!value.full) return;
    const next =
      ceiling !== undefined && ceiling > 0n ? ceiling : 0n;
    if (next !== value.maxCStar) {
      onChange({ ...value, maxCStar: next });
    }
  }, [ceiling, onChange, value]);

  // Feature dark, or the control was never engaged and this loan is
  // known-unable to complete Full → no surface at all.
  if (!config.enabled) return null;
  if (!value.full && fullBlocked) return null;

  const freeVpfi = vpfi.data?.freeBalance;
  const balanceShort =
    value.full &&
    quoted !== undefined &&
    freeVpfi !== undefined &&
    freeVpfi < quoted;
  const ceilingInvalid =
    value.full && (ceiling === undefined || ceiling <= 0n);

  return (
    <div
      className="card"
      style={{ marginTop: 16, padding: 12 }}
      data-testid="full-tariff-optin"
    >
      <p style={{ margin: 0, fontWeight: 600, fontSize: '0.9rem' }}>
        {copy.tariff.optInTitle}
      </p>
      <label
        className="cluster"
        style={{ marginTop: 8, fontSize: '0.9rem', alignItems: 'flex-start' }}
      >
        <input
          type="checkbox"
          checked={value.full}
          // Codex #1412 r3 — Full can only be TICKED once both the
          // quote and the principal-liquidity read settle
          // affirmatively; unticking is always allowed.
          disabled={!value.full && !fullOfferable}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? {
                    full: true,
                    maxCStar: ceiling !== undefined && ceiling > 0n ? ceiling : 0n,
                    allowDowngrade: value.allowDowngrade,
                  }
                : { ...FULL_TARIFF_OFF, allowDowngrade: value.allowDowngrade },
            )
          }
          style={{ marginTop: 3 }}
        />
        <span>{copy.tariff.optInLabel}</span>
      </label>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.85rem' }}>
        {quote.data === undefined
          ? copy.tariff.quoteLoading
          : quote.data.numeraireOk
            ? copy.tariff.quoteLine(
                formatTokenAmount(quote.data.cStar, VPFI_DECIMALS),
              )
            : copy.tariff.quoteUnavailable}
      </p>
      {value.full ? (
        <>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.85rem' }}>
            {copy.tariff.dualFeeNote} {copy.tariff.nonRefundNote}
          </p>
          <label
            style={{
              display: 'block',
              marginTop: 8,
              fontSize: '0.85rem',
            }}
          >
            {copy.tariff.maxCStarLabel}
            <input
              type="text"
              inputMode="decimal"
              value={ceilingText ?? ''}
              onChange={(e) => setCeilingText(e.target.value)}
              aria-invalid={ceilingInvalid || undefined}
              data-testid="full-tariff-ceiling"
              style={{ display: 'block', marginTop: 4, width: '100%' }}
            />
          </label>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.8rem' }}>
            {copy.tariff.maxCStarHelp}
          </p>
          {ceilingInvalid ? (
            <p
              className="muted"
              role="alert"
              style={{ margin: '4px 0 0', fontSize: '0.85rem', color: 'var(--danger)' }}
            >
              {copy.tariff.maxCStarRequired}
            </p>
          ) : null}
          {balanceShort && quoted !== undefined && freeVpfi !== undefined ? (
            <p
              className="muted"
              role="alert"
              style={{ margin: '4px 0 0', fontSize: '0.85rem', color: 'var(--danger)' }}
            >
              {copy.tariff.balanceShort(
                formatTokenAmount(freeVpfi, VPFI_DECIMALS),
                formatTokenAmount(quoted, VPFI_DECIMALS),
              )}
            </p>
          ) : null}
          <label
            className="cluster"
            style={{ marginTop: 8, fontSize: '0.85rem', alignItems: 'flex-start' }}
          >
            <input
              type="checkbox"
              checked={value.allowDowngrade}
              onChange={(e) =>
                onChange({ ...value, allowDowngrade: e.target.checked })
              }
              style={{ marginTop: 3 }}
            />
            <span>{copy.tariff.downgradeLabel}</span>
          </label>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.8rem' }}>
            {value.allowDowngrade
              ? copy.tariff.downgradeHelpAllow
              : copy.tariff.downgradeHelpStrict}
          </p>
        </>
      ) : null}
    </div>
  );
}
