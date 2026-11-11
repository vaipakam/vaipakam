import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getSupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../../shared/copy/useCopy';
import { marketKey } from '../../shared/desk/markets';
import {
  balanceText,
  checkTicket,
  DEFAULT_TICKET,
  stakeField,
  TICKET_EXPIRIES,
  ticketDraft,
  type TicketBlocker,
  type TicketExpiry,
  type TicketInput,
  type TicketMarket,
} from '../../shared/desk/ticket';
import { refusalFromError } from '../../shared/eligibility/refusal';
import { readTreasuryFeeBps } from '../../shared/offers/reads';
import { PostOffer } from '../../shared/post/PostOffer';
import { FILL_MODES, lenderPostFigures, postFigures, type FillMode, type ParseError, type PostSide } from '../../shared/post/postModel';
import { readPostFormInputs, type PostDraft } from '../../shared/post/postReview';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { assetName, tokenAmount, useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';
import { useMounted } from '../../shared/tx/useReviewRefresh';
import { FormField } from '../../shared/ui/FormField';
import { formatBps } from '../../shared/ui/format';

type Hex = `0x${string}`;

const FILL_LABEL: Readonly<Record<FillMode, CopyKey>> = { partial: 'ticket.fillPartial', aon: 'ticket.fillAon', ioc: 'ticket.fillIoc' };
const EXPIRY_LABEL: Readonly<Record<TicketExpiry, CopyKey>> = {
  '1d': 'request.expiry1d',
  '7d': 'request.expiry7d',
  '30d': 'request.expiry30d',
  never: 'request.expiryNeverOption',
};
const PARSE_TEXT: Readonly<Record<Exclude<ParseError, 'decimals'>, CopyKey>> = {
  empty: 'ticket.errEmpty',
  invalid: 'ticket.errInvalid',
  zero: 'ticket.errZero',
};

/** The store key one market's ticket, its review and its tracker live
 *  under: a review belongs to the market it was typed for, so changing
 *  market never carries a consent across (RB-REVIEW). */
export function ticketKey(m: TicketMarket): string {
  return `desk.ticket:${marketKey(m)}`;
}

/**
 * OFF-74 — the desk's order ticket: a limit-rate offer (lender) or request
 * (borrower) on the market the desk shows, posted through the guided flows'
 * own review (`PostOffer`), so the Risk and Terms consent, the dry run, the
 * risk warning and the measured outcome are theirs. The ticket states the
 * terms it does not let the reader change, the fee at today's list rates,
 * and only the first thing in the way, beneath the action. "Fill to
 * balance" types the wallet's whole balance of what posting locks, exactly.
 * A ticket is posted on the chain; signed orders are named as not available
 * yet, so the mode posted is the mode shown.
 */
export function OrderTicket({
  market,
  marketLabel,
  own,
  worldChainId,
  copy,
}: {
  market: TicketMarket;
  marketLabel: string;
  own: OwnStateClient | null;
  /** The network the desk shows; the ticket posts only on that one. */
  worldChainId: number;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const key = ticketKey(market);
  const [stored, setStored] = useStoredValue<TicketInput>(`${key}:input`);
  const [draft, setDraft] = useStoredValue<PostDraft>(`${key}:draft`);
  const [pendingDraft, setPendingDraft] = useStoredValue<PostDraft>(`${key}:pending`);
  const [opening, setOpening] = useState<string | null>(null);
  const input = stored ?? DEFAULT_TICKET;
  const set = (patch: Partial<TicketInput>) => setStored({ ...input, ...patch });

  const walletChain = getSupportedChain(own?.chainId);
  const sameNetwork = walletChain !== null && own !== null && own.chainId === worldChainId;
  const diamond = (walletChain?.diamondAddress ?? '0x') as Hex;
  const lender = input.side === 'lender';
  const stakeAsset = lender ? market.lending : market.collateral;
  const inputs = useOwnRead(['deskTicket', 'inputs', stakeAsset.toLowerCase()], (c) => readPostFormInputs(c, diamond, own!.account, stakeAsset), {
    enabled: sameNetwork,
  });
  const share = useOwnRead(['deskTicket', 'share', diamond], (c) => readTreasuryFeeBps(c, diamond), { enabled: sameNetwork && lender });
  const metaRead = useTokenMeta([market.lending, market.collateral]);
  const meta: TokenMetaMap | null = metaRead.data;
  const terms = useTerms();
  const termsGate = useTermsGate(`${key}.terms`, walletChain, own);

  const lendingDecimals = meta?.[market.lending.toLowerCase()]?.decimals ?? null;
  const collateralDecimals = meta?.[market.collateral.toLowerCase()]?.decimals ?? null;
  const decimals =
    metaRead.state === 'failed'
      ? { failed: metaRead.error ?? 'no answer' }
      : metaRead.state === 'reading'
        ? null
        : lendingDecimals === null || collateralDecimals === null
          ? { failed: text('ticket.decimalsUnread') }
          : { lending: lendingDecimals, collateral: collateralDecimals };
  const config = inputs.state === 'failed' ? { failed: inputs.error ?? 'no answer' } : inputs.data ? { maxDurationDays: inputs.data.maxDurationDays } : null;
  const check = checkTicket(input, {
    connected: own !== null,
    sameNetwork,
    market,
    config,
    decimals,
    terms: terms.state === 'failed' ? { failed: terms.error ?? 'no answer' } : terms.state === 'ready' ? 'ready' : 'loading',
  });

  const lendingSymbol = assetName(market.lending, meta);
  const collateralSymbol = assetName(market.collateral, meta);
  const amountOf = (v: bigint, asset: Hex) => tokenAmount(v, asset, meta, format);
  const balance = inputs.data?.balance ?? null;
  const stakeDecimals = lender ? lendingDecimals : collateralDecimals;

  // Only the latest submission, from a ticket still on screen for the same
  // wallet and network, opens a review.
  const mounted = useMounted();
  const attempt = useRef(0);
  const identity = own ? `${own.chainId}:${own.account.toLowerCase()}` : null;
  const identityNow = useRef(identity);
  useEffect(() => {
    identityNow.current = identity;
  }, [identity]);
  const review = async (e: FormEvent) => {
    e.preventDefault();
    if (!check.ok || own === null) return;
    setOpening(null);
    const mine = ++attempt.current;
    const askedFor = identity;
    const current = () => mounted.current && attempt.current === mine && identityNow.current === askedFor;
    try {
      // The expiry is fixed from the chain's own clock now, so a re-read of
      // the review never moves the deadline under a consent.
      const block = await own.read((c) => c.getBlock({ blockTag: 'latest' }));
      if (!current()) return;
      const next = ticketDraft(input, check, market, block.value.timestamp);
      // OFF-35: an offer is new exposure, so Terms not yet accepted are
      // accepted before its review opens.
      if (terms.data?.kind === 'needed') {
        setPendingDraft(next);
        termsGate.start(terms.data);
        return;
      }
      setDraft(next);
    } catch (err) {
      if (current()) setOpening(refusalFromError(err).reason);
    }
  };

  const termsOpen = termsGate.session !== null;
  const blockerText = check.ok
    ? null
    : blockerSentence(check.blocker, { lendingSymbol, collateralSymbol, lendingDecimals, collateralDecimals, term: market.durationDays }, copy);
  const blockedField = !check.ok && check.blocker.code === 'field' ? check.blocker.field : null;
  const figures =
    check.ok && inputs.data
      ? lender
        ? share.data !== null
          ? { kind: 'lender' as const, f: lenderPostFigures(check.amount, check.rateBps, market.durationDays, inputs.data.lifBps, share.data) }
          : null
        : { kind: 'borrower' as const, f: postFigures(check.amount, check.rateBps, market.durationDays, inputs.data.lifBps) }
      : null;

  return (
    <section className="home-section" aria-labelledby="desk-ticket-title" data-testid="desk-ticket" data-market={marketKey(market)}>
      <h2 id="desk-ticket-title">{text('ticket.title')}</h2>
      <p className="tier-b">{format('ticket.lead', { market: marketLabel })}</p>
      {termsOpen && termsGate.session && walletChain && own && (
        <TermsPrompt
          asker={text('ticket.asker')}
          gate={termsGate}
          session={termsGate.session}
          chain={walletChain}
          own={own}
          onAccepted={() => {
            termsGate.end();
            if (pendingDraft !== null) setDraft(pendingDraft);
            setPendingDraft(null);
          }}
          onClose={() => {
            setPendingDraft(null);
            termsGate.end();
          }}
        />
      )}
      {draft !== null && walletChain && own && (
        <PostOffer
          flowKey={key}
          draft={draft}
          chain={walletChain}
          own={own}
          meta={meta}
          terms={terms.data}
          onEdit={() => setDraft(null)}
          onClose={(posted) => {
            setDraft(null);
            if (posted) setStored({ ...DEFAULT_TICKET, side: input.side, expiry: input.expiry, fillMode: input.fillMode });
          }}
        />
      )}
      {draft === null && !termsOpen && (
        <form className="request-form" onSubmit={review} noValidate data-testid="desk-ticket-form">
          <fieldset className="choice-group" data-testid="desk-ticket-side">
            <legend>{text('ticket.sideLabel')}</legend>
            {(['lender', 'borrower'] as const satisfies readonly PostSide[]).map((s) => (
              <label key={s} className="choice">
                <input type="radio" name="desk-ticket-side" value={s} checked={input.side === s} onChange={() => set({ side: s })} />
                <span>{text(s === 'lender' ? 'ticket.sideLend' : 'ticket.sideBorrow')}</span>
              </label>
            ))}
          </fieldset>
          <div className="request-grid">
            <FormField label={format(lender ? 'ticket.amountLend' : 'ticket.amountBorrow', { symbol: lendingSymbol })} error={null}>
              {({ id, describedBy }) => (
                <div className="input-with-action">
                  <input
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-describedby={describedBy}
                    aria-invalid={blockedField === 'amount'}
                    value={input.amount}
                    onChange={(e) => set({ amount: e.target.value })}
                    data-testid="desk-ticket-amount"
                  />
                  {stakeField(input.side) === 'amount' && (
                    <FillToBalance balance={balance} decimals={stakeDecimals} onFill={(v) => set({ amount: v })} copy={copy} />
                  )}
                </div>
              )}
            </FormField>
            <FormField label={format(lender ? 'ticket.collateralLend' : 'ticket.collateralBorrow', { symbol: collateralSymbol })} error={null}>
              {({ id, describedBy }) => (
                <div className="input-with-action">
                  <input
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-describedby={describedBy}
                    aria-invalid={blockedField === 'collateral'}
                    value={input.collateral}
                    onChange={(e) => set({ collateral: e.target.value })}
                    data-testid="desk-ticket-collateral"
                  />
                  {stakeField(input.side) === 'collateral' && (
                    <FillToBalance balance={balance} decimals={stakeDecimals} onFill={(v) => set({ collateral: v })} copy={copy} />
                  )}
                </div>
              )}
            </FormField>
            <FormField label={text(lender ? 'ticket.rateLend' : 'ticket.rateBorrow')} hint={text('request.rateHint')} error={null}>
              {({ id, describedBy }) => (
                <input
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={!check.ok && check.blocker.code === 'rate'}
                  value={input.rate}
                  onChange={(e) => set({ rate: e.target.value })}
                  data-testid="desk-ticket-rate"
                />
              )}
            </FormField>
          </div>
          {balance !== null && (
            <p className="tier-b" data-testid="desk-ticket-balance">
              {format(lender ? 'ticket.balanceLend' : 'ticket.balanceBorrow', { have: amountOf(balance, stakeAsset) })}
            </p>
          )}
          <fieldset className="choice-group" data-testid="desk-ticket-expiry">
            <legend>{text(lender ? 'ticket.expiryLend' : 'ticket.expiryBorrow')}</legend>
            {TICKET_EXPIRIES.map((x) => (
              <label key={x} className="choice">
                <input type="radio" name="desk-ticket-expiry" value={x} checked={input.expiry === x} onChange={() => set({ expiry: x })} />
                <span>{text(EXPIRY_LABEL[x])}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="choice-group" data-testid="desk-ticket-fill">
            <legend>{text('request.fillLabel')}</legend>
            {FILL_MODES.map((m) => (
              <label key={m} className="choice">
                <input type="radio" name="desk-ticket-fill" value={m} checked={input.fillMode === m} onChange={() => set({ fillMode: m })} />
                <span>{text(FILL_LABEL[m])}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="choice-group" data-testid="desk-ticket-mode">
            <legend>{text('ticket.modeLabel')}</legend>
            <label className="choice">
              <input type="radio" name="desk-ticket-mode" value="post" checked readOnly />
              <span>{text(lender ? 'ticket.modePostLend' : 'ticket.modePostBorrow')}</span>
            </label>
            <label className="choice">
              <input type="radio" name="desk-ticket-mode" value="sign" disabled />
              <span>{text('ticket.modeSign')}</span>
            </label>
          </fieldset>
          <p className="tier-b" data-testid="desk-ticket-fixed">
            {format('ticket.fixed', { days: String(market.durationDays) })}
          </p>
          {figures !== null && (
            <p className="tier-b" data-testid="desk-ticket-fees" aria-live="polite">
              {figures.kind === 'lender'
                ? format('ticket.feesLend', {
                    lif: formatBps(inputs.data!.lifBps),
                    share: formatBps(share.data!),
                    back: amountOf(figures.f.backAtDue, market.lending),
                  })
                : format('ticket.feesBorrow', {
                    lif: formatBps(inputs.data!.lifBps),
                    receive: amountOf(figures.f.received, market.lending),
                    owe: amountOf(figures.f.owedAtDue, market.lending),
                  })}
            </p>
          )}
          {check.ok && lender && share.state === 'failed' && (
            <p className="tier-a" data-testid="desk-ticket-share-unread">
              {format('ticket.shareUnread', { reason: share.error ?? 'no answer' })}
            </p>
          )}
          {opening !== null && (
            <p className="tier-a" role="alert">
              {format('flow.unreadable', { reason: opening })}
            </p>
          )}
          <div className="thumb-action">
            <div className="thumb-buttons">
              <button type="submit" className="btn btn-primary" disabled={!check.ok} data-testid="desk-ticket-review">
                {text(lender ? 'ticket.reviewLend' : 'ticket.reviewBorrow')}
              </button>
            </div>
            {blockerText !== null && (
              <p className="tier-a" data-testid="desk-ticket-blocker" data-code={check.ok ? '' : check.blocker.code} aria-live="polite">
                {blockerText}
              </p>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function FillToBalance({
  balance,
  decimals,
  onFill,
  copy,
}: {
  balance: bigint | null;
  decimals: number | null;
  onFill: (v: string) => void;
  copy: CopyAccess;
}) {
  if (balance === null || decimals === null || balance === 0n) return null;
  return (
    <button type="button" className="btn" onClick={() => onFill(balanceText(balance, decimals))} data-testid="desk-ticket-fill-balance">
      {copy.text('ticket.fillBalance')}
    </button>
  );
}

/** The first blocker as one sentence the reader can act on. */
function blockerSentence(
  b: TicketBlocker,
  t: { lendingSymbol: string; collateralSymbol: string; lendingDecimals: number | null; collateralDecimals: number | null; term: number },
  { text, format }: CopyAccess,
): string {
  switch (b.code) {
    case 'connect':
      return text('ticket.blockConnect');
    case 'network':
      return text('ticket.blockNetwork');
    case 'no-market':
      return text('ticket.blockMarket');
    case 'loading':
      return text('ticket.blockLoading');
    case 'unread':
      return format('ticket.blockUnread', { reason: b.reason });
    case 'term-closed':
      return format('ticket.blockTerm', { days: String(t.term), max: b.maxDays.toString() });
    case 'field': {
      const symbol = b.field === 'amount' ? t.lendingSymbol : t.collateralSymbol;
      const what = text(b.field === 'amount' ? 'ticket.fieldAmount' : 'ticket.fieldCollateral');
      if (b.error === 'decimals') {
        return format('request.errDecimals', { symbol, decimals: String((b.field === 'amount' ? t.lendingDecimals : t.collateralDecimals) ?? 0) });
      }
      return format(PARSE_TEXT[b.error], { what });
    }
    case 'rate':
      return text(
        b.error === 'empty'
          ? 'request.errRateEmpty'
          : b.error === 'zero'
            ? 'request.errRateZero'
            : b.error === 'decimals'
              ? 'request.errRateDecimals'
              : b.error === 'high'
                ? 'ticket.errRateHigh'
                : 'request.errInvalid',
      );
    case 'fill':
      return text('ticket.fillIocOpen');
    case 'terms-unread':
      return format('ticket.blockTerms', { reason: b.reason });
  }
}
