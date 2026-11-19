import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getSupportedChain, SUPPORTED_CHAINS, type SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { parsePasted, suggestedAssets } from '../../shared/offers/assets';
import {
  CURVE_TERMS,
  DEFAULT_HISTORY_RANGE,
  HISTORY_RANGES,
  NOT_ENOUGH_LOANS,
  REFERENCE_NOT_PUBLISHED,
  bpsPercent,
  readRateCurve,
  readRateHistory,
  referenceNotPublished,
  type CurveRule,
  type HistoryRange,
  type OwnFigure,
  type OwnTerm,
  type RateCurve,
  type RateHistory,
  type ReferenceTerm,
  type TermRange,
} from '../../shared/rates/curve';
import { useChainRead, useScreenChain } from '../../shared/reads/chainRead';
import { worldKey } from '../../shared/reads/identityKey';
import { assetName, readTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { IndexerUnavailable } from '../../shared/reads/world/indexerClient';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { FormField } from '../../shared/ui/FormField';
import { formatAge, formatUtc, formatUtcDate } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { useNow } from '../../shared/ui/useNow';

type Hex = `0x${string}`;
type Format = ReturnType<typeof useCopy>['format'];
type Text = ReturnType<typeof useCopy>['text'];

const OTHER = 'other';

/** The index caches the curve for five minutes; asking sooner gains nothing. */
const CURVE_STALE_MS = 5 * 60_000;

/** One read's answer as the view needs it: a failure is stated, never an empty curve. */
export interface ReadState<T> {
  status: 'off' | 'reading' | 'failed' | 'ready';
  data: T | null;
  /** Why it failed, in words. */
  reason: string | null;
  /** Whether the index refused for its request limit (429). */
  busy?: boolean;
}

export interface HistoryPick {
  days: number;
  range: HistoryRange;
  read: ReadState<RateHistory>;
}

/**
 * Observed rates (#3751, RB-RATES). A public page: no wallet, nobody's own
 * position. For one asset on one network it shows two averages of loan
 * rates by term, side by side and labelled by where they come from: the
 * term average from the outside rate source, and the figures built from the
 * platform's own repaid loans under the rule the index states with them.
 * A point the rule cannot fill says why, an unpublished source says so,
 * and the time the index computed the figures is stated. Averages of what
 * was observed: never advice, a forecast or an offer.
 */
export function RatesPage() {
  const screen = useScreenChain();
  const [params, setParams] = useSearchParams();
  const chain = getSupportedChain(Number(params.get('chain') ?? NaN)) ?? screen;
  const suggested = suggestedAssets(chain).map((c) => c.address);
  const pasted = parsePasted(params.get('asset') ?? '');
  const asset = pasted ?? suggested[0] ?? null;
  const world = useWorldRail();
  const configured = world.indexer.origin !== null;
  const curve = useQuery({
    queryKey: worldKey(chain.chainId, 'rateCurve', asset?.toLowerCase() ?? null),
    queryFn: () => readRateCurve(world.indexer, chain.chainId, asset!),
    enabled: configured && asset !== null,
    staleTime: CURVE_STALE_MS,
    retry: 1,
  });
  const [term, setTerm] = useState<number | null>(null);
  const [range, setRange] = useState<HistoryRange>(DEFAULT_HISTORY_RANGE);
  const history = useQuery({
    queryKey: worldKey(chain.chainId, 'rateHistory', asset?.toLowerCase() ?? null, term, range),
    queryFn: () => readRateHistory(world.indexer, chain.chainId, asset!, term!, range),
    enabled: configured && asset !== null && term !== null,
    staleTime: CURVE_STALE_MS,
    retry: 1,
  });
  const meta = useChainRead(['tokenMeta', chain.chainId, asset?.toLowerCase() ?? ''], (c) => readTokenMeta(c, asset ? [asset] : []), {
    chain,
    immutable: true,
    enabled: asset !== null,
  }).data;
  const nowSec = Math.floor(useNow() / 1000);
  const set = (next: { chain?: number; asset?: string | null }) => {
    const p: Record<string, string> = { chain: String(next.chain ?? chain.chainId) };
    const a = next.asset === undefined ? pasted : next.asset;
    if (a) p.asset = a;
    setTerm(null);
    setParams(p, { replace: true });
  };
  return (
    <RatesView
      chain={chain}
      asset={asset}
      suggested={suggested}
      meta={meta}
      curve={toState(configured, curve)}
      history={term === null ? null : { days: term, range, read: toState(configured, history) }}
      nowSec={nowSec}
      onPickChain={(id) => set({ chain: id, asset: null })}
      onPickAsset={(a) => set({ asset: a })}
      onPickTerm={setTerm}
      onPickRange={setRange}
      onRetry={() => void curve.refetch()}
    />
  );
}

function toState<T>(configured: boolean, q: { status: 'pending' | 'error' | 'success'; data: T | undefined; error: unknown }): ReadState<T> {
  if (!configured) return { status: 'off', data: null, reason: null };
  if (q.status === 'success' && q.data !== undefined) return { status: 'ready', data: q.data, reason: null };
  if (q.status === 'error') {
    const e = q.error;
    const reason = e instanceof Error ? e.message : String(e);
    return { status: 'failed', data: null, reason, busy: e instanceof IndexerUnavailable && e.why === 'status' && / 429 /.test(reason) };
  }
  return { status: 'reading', data: null, reason: null };
}

/** The page body for one set of reads: pure, so every state renders the
 *  same in a unit test as on the page. */
export function RatesView({
  chain,
  asset,
  suggested,
  meta,
  curve,
  history,
  nowSec,
  onPickChain,
  onPickAsset,
  onPickTerm,
  onPickRange,
  onRetry,
}: {
  chain: SupportedChain;
  asset: Hex | null;
  suggested: Hex[];
  meta: TokenMetaMap | null;
  curve: ReadState<RateCurve>;
  history: HistoryPick | null;
  nowSec: number;
  onPickChain: (chainId: number) => void;
  onPickAsset: (asset: string) => void;
  onPickTerm: (days: number | null) => void;
  onPickRange: (range: HistoryRange) => void;
  onRetry: () => void;
}) {
  const { text, format } = useCopy();
  const name = asset ? assetName(asset, meta) : '';
  let body: ReactNode;
  if (asset === null) {
    body = <p className="tier-b">{format('rates.noAsset', { chain: chain.name })}</p>;
  } else if (curve.status === 'off') {
    body = (
      <Notice tone="warn" tier="A">
        {text('rates.noIndex')}
      </Notice>
    );
  } else if (curve.status === 'reading') {
    body = <p className="tier-b">{format('rates.reading', { asset: name, chain: chain.name })}</p>;
  } else if (curve.status === 'failed' || curve.data === null) {
    body = (
      <div data-testid="rates-failed">
        <Notice tone="warn" tier="A">
          {format(curve.busy ? 'rates.busy' : 'rates.failed', { asset: name, chain: chain.name, reason: curve.reason ?? '' })}{' '}
          <button type="button" className="link" onClick={onRetry}>
            {text('rail.refresh')}
          </button>
        </Notice>
      </div>
    );
  } else {
    body = <Curve curve={curve.data} name={name} nowSec={nowSec} history={history} onPickTerm={onPickTerm} onPickRange={onPickRange} />;
  }
  return (
    <main className="page rates" aria-labelledby="rates-title">
      <h1 id="rates-title">{text('rates.title')}</h1>
      <p className="tier-a">{text('rates.intro')}</p>
      <div className="rates-pickers">
        <FormField label={text('rates.network')}>
          {({ id }) => (
            <select id={id} value={chain.chainId} onChange={(e) => onPickChain(Number(e.target.value))} data-testid="rates-network">
              {SUPPORTED_CHAINS.map((c) => (
                <option key={c.chainId} value={c.chainId}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <AssetPick key={`${chain.chainId}`} asset={asset} suggested={suggested} meta={meta} onPick={onPickAsset} />
      </div>
      {body}
      <p className="tier-b">
        <Link to={`/analytics?chain=${chain.chainId}`}>{text('rates.toAnalytics')}</Link>
      </p>
    </main>
  );
}

/** The asset: a token the network suggests, or a pasted address. */
function AssetPick({ asset, suggested, meta, onPick }: { asset: Hex | null; suggested: Hex[]; meta: TokenMetaMap | null; onPick: (a: string) => void }) {
  const { text } = useCopy();
  const isSuggested = asset !== null && suggested.some((s) => s.toLowerCase() === asset.toLowerCase());
  const [other, setOther] = useState(asset !== null && !isSuggested);
  const [typed, setTyped] = useState(asset !== null && !isSuggested ? asset : '');
  const showOther = other || (asset !== null && !isSuggested) || suggested.length === 0;
  const invalid = showOther && typed.trim() !== '' && parsePasted(typed) === null;
  return (
    <div className="rates-asset">
      <FormField label={text('rates.asset')}>
        {({ id }) => (
          <select
            id={id}
            value={showOther ? OTHER : asset!}
            onChange={(e) => {
              if (e.target.value === OTHER) setOther(true);
              else {
                setOther(false);
                onPick(e.target.value);
              }
            }}
            data-testid="rates-asset"
          >
            {suggested.map((s) => (
              <option key={s} value={s}>
                {assetName(s, meta)}
              </option>
            ))}
            <option value={OTHER}>{text('rates.assetOther')}</option>
          </select>
        )}
      </FormField>
      {showOther && (
        <FormField label={text('rates.assetAddress')} error={invalid ? text('rates.assetInvalid') : null}>
          {(f) => (
            <input
              id={f.id}
              aria-describedby={f.describedBy}
              aria-invalid={f.invalid}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                const a = parsePasted(e.target.value);
                if (a !== null) onPick(a);
              }}
              data-testid="rates-asset-address"
            />
          )}
        </FormField>
      )}
    </div>
  );
}

function Curve({
  curve,
  name,
  nowSec,
  history,
  onPickTerm,
  onPickRange,
}: {
  curve: RateCurve;
  name: string;
  nowSec: number;
  history: HistoryPick | null;
  onPickTerm: (days: number | null) => void;
  onPickRange: (range: HistoryRange) => void;
}) {
  const { text, format } = useCopy();
  const rule = curve.ownLoans.rule;
  return (
    <>
      <AsOf curve={curve} name={name} nowSec={nowSec} />
      <div data-testid="rates-notice">
        <Notice tone="info" tier="A">
          {curve.notice === 'observed-averages-not-advice-forecast-or-offer' ? text('rates.notice') : format('rates.noticeOther', { notice: curve.notice })}
        </Notice>
      </div>
      <div className="rates-halves">
        <ReferenceHalf curve={curve} />
        <OwnHalf curve={curve} />
      </div>
      <details className="rates-how" data-testid="rates-how">
        <summary>{text('rates.howTitle')}</summary>
        <h3>{text('rates.referenceTitle')}</h3>
        <p className="tier-b">{text('rates.howReference')}</p>
        <h3>{text('rates.ownTitle')}</h3>
        <RuleStatement rule={rule} />
      </details>
      <History
        terms={rule.points.length > 0 ? rule.points.map((p) => p.days) : [...CURVE_TERMS]}
        points={rule.points}
        history={history}
        onPickTerm={onPickTerm}
        onPickRange={onPickRange}
      />
    </>
  );
}

function AsOf({ curve, name, nowSec }: { curve: RateCurve; name: string; nowSec: number }) {
  const { format } = useCopy();
  if (!curve.computed || curve.asOf === null) {
    return (
      <p className="tier-b" data-testid="rates-as-of">
        {format('rates.notComputed', { asset: name })}
      </p>
    );
  }
  const age = nowSec - curve.asOf;
  return (
    <p className="tier-b" data-testid="rates-as-of">
      {age >= 0 ? format('rates.asOf', { asset: name, time: formatUtc(curve.asOf), age: formatAge(age) }) : format('rates.asOfAhead', { asset: name, time: formatUtc(curve.asOf) })}
    </p>
  );
}

function termLabel(days: number, format: Format): string {
  return format(days === 1 ? 'rates.termDay' : 'rates.termDays', { days: String(days) });
}

/** A point's range in words: "up to 14 days", "15–60 days", "over 270 days". */
export function rangeLabel(range: TermRange | null, days: number, format: Format): string {
  if (range === null) return termLabel(days, format);
  const [min, max] = range;
  if (max === null) return format('rates.rangeOver', { days: String(Math.max(0, min - 1)) });
  if (min <= 1) return format('rates.rangeUpTo', { max: String(max) });
  return format('rates.rangeBetween', { min: String(min), max: String(max) });
}

const REF_STATE: Record<string, CopyKey> = {
  [REFERENCE_NOT_PUBLISHED]: 'rates.refNotPublished',
  available: 'rates.refAvailable',
  unavailable: 'rates.refUnavailable',
  unusual: 'rates.refUnusual',
};

function refState(state: string | null, text: Text, format: Format): string {
  if (state === null) return text('rates.notAvailable');
  return REF_STATE[state] ? text(REF_STATE[state]) : format('rates.refOther', { state });
}

function pct(bps: number | null, none: string): string {
  return bps === null ? none : `${bpsPercent(bps)}%`;
}

/** The outside source's term average for each term, or its stated absence. */
function ReferenceHalf({ curve }: { curve: RateCurve }) {
  const { text } = useCopy();
  const none = text('rates.notAvailable');
  const unpublished = referenceNotPublished(curve);
  return (
    <section className="rates-half" aria-labelledby="rates-reference" data-testid="rates-reference" data-state={unpublished ? REFERENCE_NOT_PUBLISHED : 'published'}>
      <h2 id="rates-reference">{text('rates.referenceTitle')}</h2>
      <p className="tier-b">{text('rates.referenceWhat')}</p>
      {unpublished ? (
        <Notice tone="info" tier="A">
          {text('rates.referenceUnavailable')}
        </Notice>
      ) : (
        <ul className="rows rates-terms">
          {curve.reference.terms.map((t) => (
            <ReferenceRow key={t.days} t={t} none={none} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReferenceRow({ t, none }: { t: ReferenceTerm; none: string }) {
  const { text, format } = useCopy();
  return (
    <li className="card rates-term" data-testid="rates-reference-term" data-days={t.days} data-state={t.state}>
      <div className="rates-term-head">
        <strong>{termLabel(t.days, format)}</strong>
        <span className="rates-figure">{pct(t.valueBps, none)}</span>
      </div>
      <p className="tier-b">{refState(t.state, text, format)}</p>
      <dl className="rates-parts">
        <dt>{text('rates.a24')}</dt>
        <dd>{pct(t.a24Bps, none)}</dd>
        <dt>{text('rates.a90')}</dt>
        <dd>{pct(t.a90Bps, none)}</dd>
        <dt>{text('rates.weight')}</dt>
        <dd>{pct(t.weightBps, none)}</dd>
      </dl>
    </li>
  );
}

/** The platform's own loans, by point: a band, or why none is shown. */
function OwnHalf({ curve }: { curve: RateCurve }) {
  const { text } = useCopy();
  return (
    <section className="rates-half" aria-labelledby="rates-own" data-testid="rates-own">
      <h2 id="rates-own">{text('rates.ownTitle')}</h2>
      <p className="tier-b">{text('rates.ownWhat')}</p>
      {curve.ownLoans.rule.provisional && <p className="tier-b">{text('rates.provisional')}</p>}
      <ul className="rows rates-terms">
        {curve.ownLoans.terms.map((t) => (
          <OwnRow key={t.days} t={t} />
        ))}
      </ul>
    </section>
  );
}

/** The short figure for a point: its median, or the words for its absence. */
export function ownHeadline(f: OwnFigure, text: Text): string {
  if (f.state === 'shown') return pct(f.medianBps, text('rates.notAvailable'));
  if (f.state === 'not-computed') return text('rates.notComputedShort');
  return f.reason === NOT_ENOUGH_LOANS ? text('rates.notEnough') : text('rates.withheld');
}

function withheldWhy(f: OwnFigure, text: Text, format: Format): string {
  if (f.state === 'not-computed') return text('rates.notComputedWhy');
  if (f.reason === NOT_ENOUGH_LOANS) return text('rates.withheldLoans');
  if (f.reason === 'history-incomplete') return text('rates.withheldHistory');
  return format('rates.withheldOther', { reason: f.reason ?? text('rates.noReason') });
}

function OwnRow({ t }: { t: OwnTerm }) {
  const { text, format } = useCopy();
  const none = text('rates.notAvailable');
  const counts = t.loans !== null && (t.state === 'shown' || t.loans > 0);
  return (
    <li className="card rates-term" data-testid="rates-own-term" data-days={t.days} data-state={t.state} data-reason={t.reason ?? undefined}>
      <div className="rates-term-head">
        <strong>{rangeLabel(t.termRange, t.days, format)}</strong>
        <span className={t.state === 'shown' ? 'rates-figure' : 'rates-figure rates-withheld'}>{ownHeadline(t, text)}</span>
      </div>
      {t.state === 'shown' ? (
        <dl className="rates-parts">
          <dt>{text('rates.band')}</dt>
          <dd>{t.p25Bps !== null && t.p75Bps !== null ? format('rates.bandValue', { low: pct(t.p25Bps, none), high: pct(t.p75Bps, none) }) : none}</dd>
        </dl>
      ) : (
        <p className="tier-b">{withheldWhy(t, text, format)}</p>
      )}
      {counts && <p className="tier-b">{format('rates.counts', { loans: String(t.loans), lenders: String(t.lenders ?? 0), borrowers: String(t.borrowers ?? 0) })}</p>}
      <UnconfirmedLine f={t} />
      {t.lookbackDays !== null && <p className="tier-b">{format('rates.lookback', { days: String(t.lookbackDays) })}</p>}
    </li>
  );
}

/** How many loans the point left out because their agreed terms are not
 *  confirmed yet, zero included, so a gap never reads as a quiet market. */
export function unconfirmedText(f: OwnFigure, text: Text, format: Format): string | null {
  if (f.unconfirmedLeftOut !== null) return format('rates.unconfirmedLeftOut', { n: String(f.unconfirmedLeftOut) });
  return f.state === 'not-computed' ? null : text('rates.unconfirmedUnstated');
}

function UnconfirmedLine({ f }: { f: OwnFigure }) {
  const { text, format } = useCopy();
  const line = unconfirmedText(f, text, format);
  if (line === null) return null;
  return (
    <p className="tier-b" data-testid="rates-unconfirmed" data-count={f.unconfirmedLeftOut ?? undefined}>
      {line}
    </p>
  );
}

/** Settings the app has a name for; any other is listed by the index's own key. */
const RULE_LABEL: Record<string, CopyKey> = {
  lookbackMinDays: 'rates.ruleLookbackMinDays',
  lookbackTermMultiple: 'rates.ruleLookbackTermMultiple',
  minAgeDays: 'rates.ruleMinAgeDays',
  walletShareCapBps: 'rates.ruleWalletShareCap',
  minLenders: 'rates.ruleMinLenders',
  minBorrowers: 'rates.ruleMinBorrowers',
  loans: 'rates.ruleLoans',
  weight: 'rates.ruleWeight',
  figure: 'rates.ruleFigure',
};

/** The index's words for a setting's value, an exclusion or an interest source. */
const RULE_WORD: Record<string, CopyKey> = {
  'closed-by-repayment': 'rates.wordClosedByRepayment',
  'any-status': 'rates.wordAnyStatus',
  'interest-paid': 'rates.wordInterestPaid',
  'weighted-quartiles': 'rates.wordWeightedQuartiles',
  'open-loans': 'rates.wordOpenLoans',
  'defaulted-or-liquidated-loans': 'rates.wordDefaulted',
  'linked-rate-loans': 'rates.wordLinked',
  'self-trade-pairs': 'rates.wordSelfTrade',
  'unconfirmed-terms': 'rates.wordUnconfirmed',
  'lender-sale-vehicles': 'rates.wordSaleVehicles',
  'nft-legs': 'rates.wordNft',
  'loans-younger-than-min-age': 'rates.wordYoung',
  LoanSettlementBreakdown: 'rates.wordSettlements',
  InterestPaymentBooked: 'rates.wordPeriodic',
  LoanInterestPaid: 'rates.wordInterestStatements',
  'less LoanInterestUndelivered': 'rates.wordLessUndelivered',
  'refinance-payoff': 'rates.wordRefinance',
  'swap-to-repay': 'rates.wordSwapToRepay',
  'partial-repayment': 'rates.wordPartial',
  'fallback-recovery': 'rates.wordFallbackRecovery',
};

function word(w: string, text: Text): string {
  return RULE_WORD[w] ? text(RULE_WORD[w]) : w;
}

/** A setting's value in words, by the unit its name carries. */
export function ruleValue(key: string, value: string | number | boolean, text: Text, format: Format): string {
  if (typeof value === 'boolean') return text(value ? 'rates.yes' : 'rates.no');
  if (typeof value === 'string') return word(value, text);
  if (/Bps$/.test(key)) return `${bpsPercent(value)}%`;
  if (/Days$/.test(key)) return termLabel(value, format);
  if (/Multiple$/.test(key)) return format('rates.times', { n: String(value) });
  return String(value);
}

/** The rule exactly as the index stated it with these figures. */
function RuleStatement({ rule }: { rule: CurveRule }) {
  const { text, format } = useCopy();
  return (
    <div data-testid="rates-rule">
      {rule.provisional && <p className="tier-b">{text('rates.provisional')}</p>}
      {rule.settings.length === 0 ? (
        <p className="tier-b">{text('rates.ruleNone')}</p>
      ) : (
        <dl className="rates-rule">
          {rule.settings.map((s) => (
            <div key={s.key} data-key={s.key}>
              <dt>{RULE_LABEL[s.key] ? text(RULE_LABEL[s.key]) : s.key}</dt>
              <dd>{ruleValue(s.key, s.value, text, format)}</dd>
            </div>
          ))}
        </dl>
      )}
      {rule.excludes.length > 0 && <RuleList title={text('rates.ruleExcludes')} items={rule.excludes.map((w) => word(w, text))} testId="rates-rule-excludes" />}
      {rule.interestSources.length > 0 && <RuleList title={text('rates.ruleInterestSources')} items={rule.interestSources.map((w) => word(w, text))} testId="rates-rule-sources" />}
      {rule.interestNotCounted.length > 0 && (
        <RuleList title={text('rates.ruleNotCounted')} items={rule.interestNotCounted.map((w) => word(w, text))} testId="rates-rule-not-counted" />
      )}
      {rule.points.length > 0 && (
        <RuleList
          title={text('rates.rulePoints')}
          items={rule.points.map((p) =>
            p.lookbackDays === null
              ? rangeLabel(p.termRange, p.days, format)
              : format('rates.rulePoint', { range: rangeLabel(p.termRange, p.days, format), days: String(p.lookbackDays) }),
          )}
          testId="rates-rule-points"
        />
      )}
    </div>
  );
}

function RuleList({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  return (
    <>
      <p className="tier-b">{title}</p>
      <ul data-testid={testId}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </>
  );
}

const RANGE_LABEL: Record<HistoryRange, CopyKey> = { '30d': 'rates.range30', '90d': 'rates.range90', '365d': 'rates.range365' };

/** Daily figures for one point, both halves; a missing day is said to be unfilled. */
function History({
  terms,
  points,
  history,
  onPickTerm,
  onPickRange,
}: {
  terms: number[];
  points: CurveRule['points'];
  history: HistoryPick | null;
  onPickTerm: (days: number | null) => void;
  onPickRange: (range: HistoryRange) => void;
}) {
  const { text, format } = useCopy();
  const none = text('rates.notAvailable');
  const read = history?.read;
  const label = (d: number) => rangeLabel(points.find((p) => p.days === d)?.termRange ?? null, d, format);
  return (
    <section className="rates-history" aria-labelledby="rates-history" data-testid="rates-history">
      <h2 id="rates-history">{text('rates.historyTitle')}</h2>
      <div className="rates-pickers">
        <FormField label={text('rates.historyTerm')}>
          {({ id }) => (
            <select id={id} value={history?.days ?? ''} onChange={(e) => onPickTerm(e.target.value === '' ? null : Number(e.target.value))} data-testid="rates-history-term">
              <option value="">{text('rates.historyPick')}</option>
              {terms.map((d) => (
                <option key={d} value={d}>
                  {label(d)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        {history !== null && (
          <FormField label={text('rates.historyRange')}>
            {({ id }) => (
              <select id={id} value={history.range} onChange={(e) => onPickRange(e.target.value as HistoryRange)} data-testid="rates-history-range">
                {HISTORY_RANGES.map((r) => (
                  <option key={r} value={r}>
                    {text(RANGE_LABEL[r])}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        )}
      </div>
      {read?.status === 'reading' && <p className="tier-b">{text('rates.historyReading')}</p>}
      {read?.status === 'failed' && (
        <Notice tone="warn" tier="A">
          {format(read.busy ? 'rates.historyBusy' : 'rates.historyFailed', { reason: read.reason ?? '' })}
        </Notice>
      )}
      {read?.status === 'ready' && read.data !== null && (
        <>
          <p className="tier-b">{text('rates.historyGaps')}</p>
          {read.data.rows.length === 0 ? (
            <p className="tier-b" data-testid="rates-history-empty">
              {text('rates.historyEmpty')}
            </p>
          ) : (
            <div className="rates-history-table">
              <table data-testid="rates-history-rows">
                <caption className="sr-only">{format('rates.historyCaption', { term: label(read.data.days), range: text(RANGE_LABEL[history!.range]) })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{text('rates.historyDay')}</th>
                    <th scope="col">{text('rates.historyReference')}</th>
                    <th scope="col">{text('rates.historyOwn')}</th>
                    <th scope="col">{text('rates.historyUnconfirmed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {read.data.rows.map((r) => (
                    <tr key={r.day}>
                      <th scope="row">{formatUtcDate(r.day)}</th>
                      <td>
                        {r.reference.valueBps !== null ? pct(r.reference.valueBps, none) : r.reference.state === REFERENCE_NOT_PUBLISHED ? text('rates.notPublishedShort') : none}
                      </td>
                      <td>{ownHeadline(r.ownLoans, text)}</td>
                      <td>{r.ownLoans.unconfirmedLeftOut !== null ? String(r.ownLoans.unconfirmedLeftOut) : none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
