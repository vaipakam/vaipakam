/**
 * #2437 — the VPFI token and treasury-fee figures on /analytics, read from
 * the platform contract (restoring the two sections the retired dashboard
 * carried and `apps/defi`'s removal took with it).
 *
 * WHY A CONTRACT READ ON A WALLET-FREE PAGE. These figures are view calls
 * on the Diamond, and the indexer does not republish them; reading them
 * through the app's public RPC keeps the page wallet-free and keeps each
 * figure traceable to a named view, which the section lists. Every figure
 * is read at ONE block, and the section states that block and its age, so
 * a reading that has gone stale says so.
 *
 * ── COPY GATE (RL-6 / VPFITokenomicsRedesignResearch.md §A.4) ──────────
 * Supply and fee-flow transparency only: what the supply is, where it may
 * be minted and up to what cap, what fees were recorded and where they go.
 * No price, return, scarcity or purchase framing.
 *
 * ── HONESTY GATE ──────────────────────────────────────────────────────
 *  - a view that could not be read SAYS so, never zero;
 *  - a chain VPFI reaches by bridge shows its own supply, and says the cap
 *    and minter belong to the issuing chain rather than showing zeros;
 *  - every reason a fee figure can understate the truth is stated beside
 *    it (unvalued fees, the window scan bound, a changed currency);
 *  - the "held" figure is shown only when the contract IS the treasury,
 *    with what it leaves out; an external treasury is named and linked,
 *    and no balance is invented for it;
 *  - amounts truncate, and a positive amount below the shown precision is
 *    labelled, never shown as 0.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { ExternalLink, FileCode2 } from 'lucide-react';
import { copy } from '../../content/copy';
import {
  readOnChainTransparency,
  type OnChainTransparency,
  type TreasuryFeesView,
  type TreasuryView,
  type VpfiTokenView,
} from '../../data/onChainTransparency';
import { localeDecimalString, localeNumber } from '../../lib/format';
import { idleAware } from '../../lib/idle';
import { formatVpfiWei } from '../../lib/recyclingFormat';
import { useNowSec } from '../../hooks/useNowSec';
import { ageLabel } from './ageLabel';

/** The view functions this section reads, named on the page. */
export const CHAIN_FIGURE_VIEWS = [
  'getVPFISnapshot',
  'getTreasuryMetrics',
  'getTreasury',
  'getNumeraireSymbol',
] as const;

/** Fee values are 1e18-scaled; the page shows two fractional digits. */
const FEE_SCALE = 10n ** 18n;
const FEE_DIGITS = 2;
const FEE_UNIT = FEE_SCALE / 10n ** BigInt(FEE_DIGITS);

/**
 * A 1e18-scaled reference-currency value, TRUNCATED to two fractional
 * digits (the safe error for a figure the platform states about itself is
 * the one that understates). A positive value below 0.01 is labelled, never
 * shown as 0.
 */
export function formatFeeValue(value: bigint, locale: string | undefined): string {
  if (value > 0n && value < FEE_UNIT) {
    return copy.chainFigures.belowPrecision(localeDecimalString('0.01', locale));
  }
  const whole = value / FEE_SCALE;
  const fraction = ((value % FEE_SCALE) / FEE_UNIT).toString().padStart(FEE_DIGITS, '0').replace(/0+$/, '');
  return localeDecimalString(fraction ? `${whole}.${fraction}` : whole.toString(), locale);
}

export type ChainFiguresState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; data: OnChainTransparency };

export function ChainFigures({
  chainId,
  diamond,
  explorer,
}: {
  chainId: number;
  diamond: Address;
  explorer: string;
}) {
  const { i18n } = useTranslation();
  const publicClient = usePublicClient({ chainId });
  const nowSec = useNowSec();
  const query = useQuery({
    queryKey: ['analytics-chain-figures', chainId, diamond],
    enabled: publicClient !== undefined,
    // The page's `cool` tier, like its indexer reads.
    refetchInterval: idleAware(180_000),
    queryFn: () => readOnChainTransparency(publicClient!, diamond),
  });
  const state: ChainFiguresState =
    publicClient === undefined || query.isError
      ? { status: 'unavailable' }
      : query.data
        ? { status: 'ready', data: query.data }
        : { status: 'loading' };
  return (
    <ChainFiguresView state={state} locale={i18n.resolvedLanguage} nowSec={nowSec} explorer={explorer} />
  );
}

function AddressLink({ address, explorer, testId }: { address: Address; explorer: string; testId: string }) {
  return (
    <a
      className="an-addr"
      href={`${explorer}/address/${address}`}
      target="_blank"
      rel="noreferrer noopener"
      data-testid={testId}
    >
      {address} <ExternalLink aria-hidden="true" />
    </a>
  );
}

/**
 * The presentational half — pure, so each honesty rule is testable without
 * a network. `#contract-figures` is on the section in every state, so a
 * deep link resolves on the first render.
 */
export function ChainFiguresView({
  state,
  locale,
  nowSec,
  explorer,
}: {
  state: ChainFiguresState;
  locale: string | undefined;
  nowSec: number;
  explorer: string;
}) {
  return (
    <section
      className="an-section"
      id="contract-figures"
      aria-labelledby="cf-title"
      aria-busy={state.status === 'loading'}
    >
      <h2 id="cf-title">
        <FileCode2 aria-hidden="true" /> {copy.chainFigures.heading}
      </h2>
      <p className="rc-lede">{copy.chainFigures.intro}</p>
      {state.status === 'ready' && (
        <dl className="rc-figures" data-testid="cf-reading">
          <div>
            <dt>{copy.chainFigures.readAt}</dt>
            <dd data-testid="cf-block">{localeNumber(Number(state.data.blockNumber), locale)}</dd>
          </div>
          <div>
            <dt>{copy.chainFigures.readAge}</dt>
            <dd data-testid="cf-age">{ageLabel(state.data.blockTimestamp, nowSec)}</dd>
          </div>
          <div>
            <dt>{copy.chainFigures.views}</dt>
            <dd className="rc-wrap">
              <code>{CHAIN_FIGURE_VIEWS.join(', ')}</code>
            </dd>
          </div>
        </dl>
      )}
      {/* Both subsection headings carry their anchors in EVERY state, so
          `#vpfi-token` and `#treasury-fees` resolve on the first render
          like the page's other deep links; the state is said under each. */}
      <h3 className="rc-subheading" id="vpfi-token">
        {copy.chainFigures.tokenHeading}
      </h3>
      {state.status === 'ready' ? (
        <VpfiToken view={state.data.vpfi} locale={locale} explorer={explorer} />
      ) : (
        <Pending status={state.status} />
      )}
      <h3 className="rc-subheading" id="treasury-fees">
        {copy.chainFigures.feesHeading}
      </h3>
      {state.status === 'ready' ? (
        <Fees
          fees={state.data.fees}
          treasury={state.data.treasury}
          unit={state.data.numeraire?.symbol ?? null}
          locale={locale}
          explorer={explorer}
        />
      ) : (
        <Pending status={state.status} />
      )}
    </section>
  );
}

/** Loading is its own posture and says only that; an unread contract says
 *  it could not be read, never that a figure is zero. */
function Pending({ status }: { status: 'loading' | 'unavailable' }) {
  return status === 'loading' ? (
    <p className="muted" role="status">
      {copy.chainFigures.loading}
    </p>
  ) : (
    <p className="muted" role="status" data-testid="cf-unavailable">
      {copy.chainFigures.unreachable}
    </p>
  );
}

function VpfiToken({
  view,
  locale,
  explorer,
}: {
  view: VpfiTokenView;
  locale: string | undefined;
  explorer: string;
}) {
  const amt = (v: bigint) => formatVpfiWei(v.toString(), locale);
  return (
    <>
      {view.kind === 'unread' && (
        <p className="rc-refusal" data-testid="cf-token-unread">
          {copy.chainFigures.tokenUnread}
        </p>
      )}
      {view.kind === 'unbound' && (
        <p className="muted" data-testid="cf-token-unbound">
          {copy.chainFigures.unbound}
        </p>
      )}
      {(view.kind === 'canonical' || view.kind === 'mirror') && (
        <>
          <dl className="rc-figures" data-testid={`cf-token-${view.kind}`}>
            <div>
              <dt>{copy.chainFigures.tokenAddress}</dt>
              <dd className="rc-wrap">
                <AddressLink address={view.token} explorer={explorer} testId="cf-token-address" />
              </dd>
            </div>
            <div>
              <dt>{copy.chainFigures.totalSupply}</dt>
              <dd data-testid="cf-supply">{amt(view.totalSupply)} VPFI</dd>
            </div>
            {view.kind === 'canonical' && (
              <>
                <div>
                  <dt>{copy.chainFigures.cap}</dt>
                  <dd data-testid="cf-cap">{amt(view.cap)} VPFI</dd>
                </div>
                <div>
                  <dt>{copy.chainFigures.headroom}</dt>
                  <dd data-testid="cf-headroom">{amt(view.headroom)} VPFI</dd>
                </div>
                <div>
                  <dt>{copy.chainFigures.minter}</dt>
                  <dd className="rc-wrap">
                    {view.minter ? (
                      <AddressLink address={view.minter} explorer={explorer} testId="cf-minter" />
                    ) : (
                      <span className="rc-refusal" data-testid="cf-minter-none">
                        {copy.chainFigures.noMinter}
                      </span>
                    )}
                  </dd>
                </div>
              </>
            )}
          </dl>
          <p className="an-note">
            {view.kind === 'canonical' ? copy.chainFigures.canonicalNote : copy.chainFigures.mirrorNote}
          </p>
        </>
      )}
    </>
  );
}

function Fees({
  fees,
  treasury,
  unit,
  locale,
  explorer,
}: {
  fees: TreasuryFeesView;
  treasury: TreasuryView;
  unit: string | null;
  locale: string | undefined;
  explorer: string;
}) {
  const val = (v: bigint) => (unit ? `${formatFeeValue(v, locale)} ${unit}` : formatFeeValue(v, locale));
  return (
    <>
      {fees.kind === 'unread' ? (
        <p className="rc-refusal" data-testid="cf-fees-unread">
          {copy.chainFigures.feesUnread}
        </p>
      ) : (
        <>
          <dl className="rc-figures" data-testid="cf-fees">
            <div>
              <dt>{copy.chainFigures.feesTotal}</dt>
              <dd data-testid="cf-fees-total">{val(fees.total)}</dd>
            </div>
            <div>
              <dt>{copy.chainFigures.fees24h}</dt>
              <dd data-testid="cf-fees-24h">{val(fees.last24h)}</dd>
            </div>
            <div>
              <dt>{copy.chainFigures.fees7d}</dt>
              <dd data-testid="cf-fees-7d">{val(fees.last7d)}</dd>
            </div>
          </dl>
          <p className="an-note">
            {unit ? copy.chainFigures.feesUnit(unit) : copy.chainFigures.feesUnitUnknown}
          </p>
          <p className="an-note">{copy.chainFigures.feesLowerBound}</p>
        </>
      )}
      <dl className="rc-figures" data-testid={`cf-treasury-${treasury.kind}`}>
        <div>
          <dt>{copy.chainFigures.treasury}</dt>
          <dd className="rc-wrap">
            {treasury.kind === 'diamond' || treasury.kind === 'external' ? (
              <AddressLink address={treasury.address} explorer={explorer} testId="cf-treasury-address" />
            ) : (
              <span className="rc-refusal">
                {treasury.kind === 'unset' ? copy.chainFigures.treasuryUnset : copy.chainFigures.treasuryUnread}
              </span>
            )}
          </dd>
        </div>
        {/* The held figure only means "fees held" when the contract is the
            treasury; anywhere else it would be a number with no referent. */}
        {treasury.kind === 'diamond' && fees.kind === 'read' && (
          <div>
            <dt>{copy.chainFigures.held}</dt>
            <dd data-testid="cf-held">{val(fees.held)}</dd>
          </div>
        )}
      </dl>
      {treasury.kind === 'external' && <p className="an-note">{copy.chainFigures.treasuryExternal}</p>}
      {treasury.kind === 'diamond' && (
        <p className="an-note">
          {copy.chainFigures.treasuryDiamond}
          {fees.kind === 'read' ? ` ${copy.chainFigures.heldNote}` : ''}
        </p>
      )}
    </>
  );
}
