import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { getSupportedChain, SUPPORTED_CHAINS, type SupportedChain } from '../../chain/chains';
import {
  FEE_WINDOW_SCAN_LIMIT,
  headlineParts,
  rateOrNone,
  readProtocolFigures,
  type AssetLifetime,
  type AssetValue,
  type Figure,
  type ProtocolFigures,
} from '../../shared/analytics/figures';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { useChainRead, useScreenChain, type ChainRead } from '../../shared/reads/chainRead';
import { assetName, tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { FormField } from '../../shared/ui/FormField';
import { formatAge, formatBps, formatFigureText, formatUtc, shortAddress } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { useNow } from '../../shared/ui/useNow';
import { VpfiToken } from './VpfiToken';

type Hex = `0x${string}`;

/**
 * Analytics (RW-74, RW-75; RB-ANALYTICS). A public page: no wallet, nobody's
 * own state. It reads the protocol's own figures on one network, all at one
 * block, through the network's read-only proxy or its public endpoint, and
 * states that block and its age. The reader may point it at any network the
 * app serves (`?chain=`); without a choice it describes the screen's chain.
 *
 * Each group of figures is stated on its own: a view that failed says so in
 * place, a ratio with nothing to divide by says there is none, and a
 * headline valued by the protocol is shown beside the parts it is made of,
 * with the assets the protocol cannot value named as the remainder.
 */
export function AnalyticsPage() {
  const screen = useScreenChain();
  const [params, setParams] = useSearchParams();
  const picked = getSupportedChain(Number(params.get('chain') ?? NaN));
  const chain = picked ?? screen;
  const figures = useChainRead(['analytics', chain.diamondAddress], (c) => readProtocolFigures(c, chain), { chain });
  const nowSec = Math.floor(useNow() / 1000);
  return <AnalyticsView chain={chain} figures={figures} nowSec={nowSec} onPick={(id) => setParams({ chain: String(id) }, { replace: true })} />;
}

/** The page body for one read: pure, so every state renders the same in a
 *  unit test as on the page. */
export function AnalyticsView({
  chain,
  figures,
  nowSec,
  onPick,
}: {
  chain: SupportedChain;
  figures: Pick<ChainRead<ProtocolFigures>, 'data' | 'state' | 'error' | 'refetch'>;
  nowSec: number;
  onPick: (chainId: number) => void;
}) {
  const { text, format } = useCopy();
  let body: ReactNode;
  if (figures.state === 'reading') {
    body = <p className="tier-b">{format('analytics.reading', { chain: chain.name })}</p>;
  } else if (figures.state === 'failed' || figures.data === null) {
    body = (
      <Notice tone="warn" tier="A">
        {format('analytics.failed', { chain: chain.name, reason: figures.error ?? 'no answer' })}{' '}
        <button type="button" className="link" onClick={figures.refetch}>
          {text('rail.refresh')}
        </button>
      </Notice>
    );
  } else {
    body = <Figures chain={chain} f={figures.data} rereadError={figures.error} nowSec={nowSec} />;
  }
  return (
    <main className="page analytics" aria-labelledby="analytics-title">
      <h1 id="analytics-title">{text('analytics.title')}</h1>
      <p className="tier-a">{format('analytics.intro', { chain: chain.name })}</p>
      <FormField label={text('analytics.network')}>
        {({ id }) => (
          <select id={id} value={chain.chainId} onChange={(e) => onPick(Number(e.target.value))} data-testid="analytics-network">
            {SUPPORTED_CHAINS.map((c) => (
              <option key={c.chainId} value={c.chainId}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {body}
    </main>
  );
}

/** The reference currency's name for a figure: its name, the stated lack of
 *  one when the protocol answered with none, or the stated failure when the
 *  name could not be read (never conflated with "not set"). */
function useUnit(f: ProtocolFigures) {
  const { text, format } = useCopy();
  // Significant digits below one, "≈" when any digit was dropped, so a
  // small real amount never reads as zero (RB-FUNDS).
  if (!f.symbol.ok) {
    return {
      unit: format('analytics.unitUnread', { reason: f.symbol.reason }),
      value: (v: bigint) => format('analytics.valueUnread', { value: formatFigureText(v, 18) }),
    };
  }
  const symbol = f.symbol.value;
  if (symbol === null) {
    return { unit: text('analytics.unitUnnamed'), value: (v: bigint) => format('analytics.valueUnnamed', { value: formatFigureText(v, 18) }) };
  }
  return { unit: symbol, value: (v: bigint) => `${formatFigureText(v, 18)} ${symbol}` };
}

/**
 * The pause, as read at the page's block. An unread pause state is said,
 * never shown as not paused. Under a pause, withdrawals of free holdings
 * follow the protocol's escape route: the notice says whether it is open,
 * when it opens, or that none is scheduled, and points to the Vault page,
 * which states the route for the reader's own account.
 */
function PauseNotice({ chain, f }: { chain: SupportedChain; f: ProtocolFigures }) {
  const { text, format } = useCopy();
  if (!f.health.ok) {
    return (
      <div data-testid="analytics-paused-unread">
        <Notice tone="warn" tier="A">
          {format('analytics.pausedUnread', { chain: chain.name, reason: f.health.reason })}
        </Notice>
      </div>
    );
  }
  if (!f.health.value.paused) return null;
  const e = f.escape;
  const escape = !e.ok
    ? format('analytics.escapeUnread', { reason: e.reason })
    : e.value.open
      ? text('analytics.escapeOpen')
      : e.value.opensAt > 0n
        ? format('analytics.escapeOpensAt', { time: formatUtc(Number(e.value.opensAt)) })
        : text('analytics.escapeNone');
  return (
    <div data-testid="analytics-paused">
      <Notice tone="warn" tier="A">
        {format('analytics.paused', { chain: chain.name })} {escape} <Link to="/vault">{text('analytics.escapeVault')}</Link>
      </Notice>
    </div>
  );
}

function Figures({ chain, f, rereadError, nowSec }: { chain: SupportedChain; f: ProtocolFigures; rereadError: string | null; nowSec: number }) {
  const { text, format } = useCopy();
  const at = Number(f.block.timestamp);
  // A block time ahead of the device clock, by any margin, is an unknown age.
  const known = at > 0 && at <= nowSec;
  return (
    <>
      <p className="tier-b stamp" data-testid="analytics-read-at">
        {known
          ? format('analytics.readAt', { block: f.block.number.toString(), time: formatUtc(at), age: formatAge(nowSec - at) })
          : format('analytics.readAtUndated', { block: f.block.number.toString() })}
      </p>
      {rereadError !== null && (
        <Notice tone="warn" tier="A">
          {format('analytics.rereadFailed', { reason: rereadError })}
        </Notice>
      )}
      <p className="tier-b" data-testid="analytics-since">
        {f.deployedAt.ok
          ? format('analytics.since', { block: String(chain.deployBlock), time: formatUtc(f.deployedAt.value) })
          : format('analytics.sinceUnread', { reason: f.deployedAt.reason })}
      </p>
      <p className="tier-b">
        {format('analytics.source', { address: shortAddress(chain.diamondAddress) })}{' '}
        <a href={`${chain.blockExplorer}/address/${chain.diamondAddress}`} target="_blank" rel="noreferrer">
          {text('analytics.explorer')}
        </a>{' '}
        {text('analytics.noIndexer')}
      </p>
      <PauseNotice chain={chain} f={f} />
      <WhyLink summaryKey="analytics.whySummary" detailKey="analytics.why" />
      <Activity f={f} />
      <OpenLoans f={f} />
      <Lifetime f={f} />
      <FeesAndTreasury chain={chain} f={f} />
      <VpfiToken chain={chain} vpfi={f.vpfi} />
    </>
  );
}

/** One fact row: the figure, or why it was not read. */
function Row({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="value-amount" data-testid={testId}>
        {children}
      </dd>
    </>
  );
}

function useUnread() {
  const { format } = useCopy();
  return (fig: Figure<unknown>) => (fig.ok ? null : format('analytics.unread', { reason: fig.reason }));
}

function Activity({ f }: { f: ProtocolFigures }) {
  const { text, format } = useCopy();
  const unread = useUnread();
  const s = f.stats.ok ? f.stats.value : null;
  const rate = (bps: bigint, key: CopyKey) => {
    const r = rateOrNone(bps, s!.loansOpened);
    return r.kind === 'none' ? text('analytics.noLoansYet') : format(key, { rate: formatBps(r.bps) });
  };
  return (
    <section aria-labelledby="analytics-activity">
      <h2 id="analytics-activity">{text('analytics.activityTitle')}</h2>
      <dl className="facts" data-testid="analytics-activity">
        <Row label={text('analytics.openLoans')} testId="analytics-open-loans">
          {s ? s.activeLoans.toString() : unread(f.stats)}
        </Row>
        <Row label={text('analytics.bookOffers')}>{s ? s.activeOffers.toString() : unread(f.stats)}</Row>
        <Row label={text('analytics.loansOpened')} testId="analytics-loans-opened">
          {s ? s.loansOpened.toString() : unread(f.stats)}
        </Row>
        <Row label={text('analytics.offersPosted')}>{f.offersPosted.ok ? f.offersPosted.value.toString() : unread(f.offersPosted)}</Row>
        <Row label={text('analytics.users')}>{s ? s.users.toString() : unread(f.stats)}</Row>
        <Row label={text('analytics.averageRate')} testId="analytics-average-rate">
          {s ? rate(s.averageRateBps, 'analytics.rate') : unread(f.stats)}
        </Row>
      </dl>
      <p className="tier-b">{text('analytics.usersWhat')}</p>
      <p className="tier-a" data-testid="analytics-no-default-rate">
        {text('analytics.noDefaultRate')}
      </p>
    </section>
  );
}

function OpenLoans({ f }: { f: ProtocolFigures }) {
  const { text, format } = useCopy();
  const unread = useUnread();
  const { unit, value } = useUnit(f);
  const l = f.locked.ok ? f.locked.value : null;
  const h = f.health.ok ? f.health.value : null;
  let ratio: string | null = null;
  if (h) {
    const r = rateOrNone(h.utilizationBps, h.collateral);
    ratio = r.kind === 'none' ? text('analytics.utilizationNone') : format('analytics.rate', { rate: formatBps(r.bps) });
  }
  return (
    <section aria-labelledby="analytics-open">
      <h2 id="analytics-open">{text('analytics.openTitle')}</h2>
      <p className="tier-a">{format('analytics.openValuedNow', { unit })}</p>
      <dl className="facts" data-testid="analytics-locked">
        <Row label={text('analytics.lockedTotal')} testId="analytics-locked-total">
          {l ? value(l.total) : unread(f.locked)}
        </Row>
        <Row label={text('analytics.lockedPrincipal')}>{l ? value(l.total - l.erc20Collateral) : unread(f.locked)}</Row>
        <Row label={text('analytics.lockedCollateral')}>{l ? value(l.erc20Collateral) : unread(f.locked)}</Row>
        <Row label={text('analytics.nftLoans')} testId="analytics-nft-loans">
          {l ? l.nftCollateralLoans.toString() : unread(f.locked)}
        </Row>
        <Row label={text('analytics.utilization')} testId="analytics-utilization">
          {ratio ?? unread(f.health)}
        </Row>
      </dl>
      <p className="tier-b">{text('analytics.nftNote')}</p>
    </section>
  );
}

function Lifetime({ f }: { f: ProtocolFigures }) {
  const { text, format } = useCopy();
  const unread = useUnread();
  const { unit, value } = useUnit(f);
  const s = f.stats.ok ? f.stats.value : null;
  const a = f.assets.ok ? f.assets.value : null;
  return (
    <section aria-labelledby="analytics-lifetime">
      <h2 id="analytics-lifetime">{text('analytics.lifetimeTitle')}</h2>
      <p className="tier-a">{format('analytics.lifetimeValuedNow', { unit })}</p>
      <dl className="facts" data-testid="analytics-lifetime">
        <Row label={text('analytics.lifetimeLent')} testId="analytics-lifetime-lent">
          {s ? value(s.volumeLent) : unread(f.stats)}
        </Row>
        <Row label={text('analytics.lifetimeInterest')} testId="analytics-lifetime-interest">
          {s ? value(s.interestPaid) : unread(f.stats)}
        </Row>
      </dl>
      {s && a && <Parts rows={a.rows} meta={a.meta} lent={s.volumeLent} interest={s.interestPaid} />}
      <p className="tier-a">{text('analytics.inKind')}</p>
      {a === null ? (
        <Notice tone="warn" tier="A">
          {format('analytics.assetsUnread', { reason: f.assets.ok ? '' : f.assets.reason })}
        </Notice>
      ) : a.rows.length === 0 ? (
        <p className="tier-b" data-testid="analytics-no-assets">
          {text('analytics.noAssets')}
        </p>
      ) : (
        <ul className="rows analytics-assets" data-testid="analytics-assets">
          {a.rows.map((r) => (
            <AssetCard key={r.asset} r={r} meta={a.meta} value={value} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** How the two lifetime headlines are made up of the assets listed below. */
function Parts({ rows, meta, lent, interest }: { rows: readonly AssetLifetime[]; meta: TokenMetaMap; lent: bigint; interest: bigint }) {
  const { text, format } = useCopy();
  const names = (list: readonly Hex[]) => list.map((x) => assetName(x, meta)).join(', ');
  const lines: { key: string; node: ReactNode }[] = [];
  for (const [which, headline] of [
    ['lent', lent],
    ['interest', interest],
  ] as const) {
    const p = headlineParts(rows, which, headline);
    const label = text(which === 'lent' ? 'analytics.lifetimeLent' : 'analytics.lifetimeInterest');
    if (p.refused.length > 0) lines.push({ key: `${which}-refused`, node: format('analytics.partsRefused', { figure: label, list: names(p.refused) }) });
    if (p.unread.length > 0) lines.push({ key: `${which}-unread`, node: format('analytics.partsUnread', { figure: label, list: names(p.unread) }) });
    if (p.matches === false) lines.push({ key: `${which}-mismatch`, node: format('analytics.partsMismatch', { figure: label }) });
  }
  if (lines.length === 0) return <p className="tier-b">{text('analytics.partsWhole')}</p>;
  return (
    <>
      {lines.map((l) => (
        <p key={l.key} className="tier-a" data-testid="analytics-parts">
          {l.node}
        </p>
      ))}
    </>
  );
}

function AssetCard({ r, meta, value }: { r: AssetLifetime; meta: TokenMetaMap; value: (v: bigint) => string }) {
  const { text, format } = useCopy();
  const valued = (v: AssetValue) =>
    v.kind === 'value' ? value(v.value) : v.kind === 'refused' ? text('analytics.assetRefused') : format('analytics.unread', { reason: v.reason });
  return (
    <li className="card" data-testid="analytics-asset">
      <h3>{assetName(r.asset, meta)}</h3>
      <dl className="facts">
        <Row label={text('analytics.assetLent')}>{tokenAmount(r.principalLent, r.asset, meta, format)}</Row>
        <Row label={text('analytics.assetLentValue')} testId="analytics-asset-value">
          {valued(r.lentValue)}
        </Row>
        <Row label={text('analytics.assetInterest')}>{tokenAmount(r.interestPaid, r.asset, meta, format)}</Row>
        <Row label={text('analytics.assetInterestValue')}>{r.interestPaid === 0n ? text('analytics.nothingPaid') : valued(r.interestValue)}</Row>
      </dl>
      <p className="tier-b analytics-address">{r.asset}</p>
    </li>
  );
}

function FeesAndTreasury({ chain, f }: { chain: SupportedChain; f: ProtocolFigures }) {
  const { text, format } = useCopy();
  const unread = useUnread();
  const { unit, value } = useUnit(f);
  const rates = f.feeRates.ok ? f.feeRates.value : null;
  const t = f.treasury.ok ? f.treasury.value : null;
  const custody = f.custody.ok ? f.custody.value : null;
  const record = (getDeployment(chain.chainId) as { treasury?: string } | undefined)?.treasury ?? null;
  const link = (address: Hex) => (
    <a href={`${chain.blockExplorer}/address/${address}`} target="_blank" rel="noreferrer">
      {address}
    </a>
  );
  return (
    <section aria-labelledby="analytics-fees">
      <h2 id="analytics-fees">{text('analytics.feesTitle')}</h2>
      <dl className="facts" data-testid="analytics-fee-rates">
        <Row label={text('analytics.treasuryShare')} testId="analytics-treasury-share">
          {rates ? format('analytics.rate', { rate: formatBps(rates.treasuryShareBps) }) : unread(f.feeRates)}
        </Row>
        <Row label={text('analytics.loanStartFee')}>{rates ? format('analytics.rate', { rate: formatBps(rates.loanStartFeeBps) }) : unread(f.feeRates)}</Row>
      </dl>
      <p className="tier-a">{format('analytics.feesValued', { unit })}</p>
      <dl className="facts" data-testid="analytics-fees-collected">
        <Row label={text('analytics.feesSince')} testId="analytics-fees-since">
          {t ? value(t.feesSinceStart) : unread(f.treasury)}
        </Row>
        <Row label={text('analytics.feesDay')}>{t ? value(t.feesLastDay) : unread(f.treasury)}</Row>
        <Row label={text('analytics.feesWeek')}>{t ? value(t.feesLastWeek) : unread(f.treasury)}</Row>
      </dl>
      <p className="tier-b">{format('analytics.feesWindowCap', { limit: FEE_WINDOW_SCAN_LIMIT.toLocaleString('en-US') })}</p>
      <WhyLink summaryKey="analytics.feesWhySummary" detailKey="analytics.feesWhy" />
      <h3>{text('analytics.treasuryTitle')}</h3>
      {custody === null ? (
        <Notice tone="warn" tier="A">
          {format('analytics.custodyUnread', { reason: f.custody.ok ? '' : f.custody.reason })}
        </Notice>
      ) : custody.kind === 'unset' ? (
        <p className="tier-a" data-testid="analytics-custody">
          {format('analytics.custodyUnset', { chain: chain.name })}
        </p>
      ) : (
        <p className="tier-a" data-testid="analytics-custody">
          {text(custody.kind === 'external' ? 'analytics.custodyExternalLead' : 'analytics.custodyDiamondLead')} {link(custody.address)}.
        </p>
      )}
      {/* Whatever the current code names, a vault on older code pays the
          treasury its own code names, and fees that reached the protocol
          contract earlier stay there: the held figure is always shown. */}
      <p className="tier-a" data-testid="analytics-held-why">
        {text('analytics.heldWhy')}
      </p>
      <dl className="facts" data-testid="analytics-held">
        <Row label={text('analytics.held')} testId="analytics-held-value">
          {t ? value(t.heldOnOpenLoanAssets) : unread(f.treasury)}
        </Row>
        <Row label={text('analytics.lastConversion')}>
          {f.convert.ok
            ? f.convert.value.lastConversionAt === 0n
              ? text('analytics.neverConverted')
              : formatUtc(f.convert.value.lastConversionAt)
            : unread(f.convert)}
        </Row>
        <Row label={text('analytics.conversionTargets')}>{f.convert.ok ? String(f.convert.value.targets.length) : unread(f.convert)}</Row>
      </dl>
      <p className="tier-a">{text('analytics.heldNote')}</p>
      {custody !== null && custody.kind !== 'unset' && record !== null && record.toLowerCase() !== custody.address.toLowerCase() && (
        <Notice tone="warn" tier="A">
          <span data-testid="analytics-record-differs">{format('analytics.recordDiffers', { record })}</span>
        </Notice>
      )}
      <p className="tier-a">{text('analytics.noYield')}</p>
    </section>
  );
}
