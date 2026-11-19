import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyAccess } from '../../shared/copy/useCopy';
import { refusalFromError, StatedRefusal } from '../../shared/eligibility/refusal';
import {
  cashLogs,
  directSaleCall,
  listingCall,
  quoteListing,
  readGetCash,
  takeoverCall,
  type CashLoan,
  type GetCash as GetCashRead,
  type RouteState,
} from '../../shared/exit/getCash';
import type { LoanView } from '../../shared/positions/loanView';
import { parseDays, parseRateBps } from '../../shared/post/postModel';
import type { Receipt, ReceiptRow } from '../../shared/receipt/types';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { chainValidUntil, readValidUntil } from '../../shared/tx/deadline';
import type { LegOutcome } from '../../shared/tx/outcome';
import { sendWrite } from '../../shared/tx/send';
import { askThrough } from '../../shared/tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry } from '../../shared/tx/txStore';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { FormField } from '../../shared/ui/FormField';
import { Notice } from '../../shared/ui/Notice';
import { formatBps, formatUtc, shortAddress } from '../../shared/ui/format';

type Hex = `0x${string}`;
type Route = 'handover' | 'sale' | 'list';

/** The store key a loan's cash-out door keeps its state under. */
export function getCashKey(loanId: bigint): string {
  return `position.getCash.${loanId.toString()}`;
}

interface GetCashProps {
  loanId: bigint;
  view: LoanView;
  own: OwnStateClient;
  chain: SupportedChain;
  meta: TokenMetaMap | null;
  /** Whether this wallet may open a new cash-out now (it holds the lender
   *  position of a live loan). A flow already under way stays on screen to
   *  its finish card either way. */
  canOpen?: boolean;
}

/**
 * Whether a cash-out flow for this loan is under way or awaiting its finish
 * card. A sale or handover moves the lender position away, so the page keeps
 * the flow on screen by this, not by who holds the position now.
 */
export function useCashFlowHeld(loanId: bigint): boolean {
  const key = getCashKey(loanId);
  const [route] = useStoredValue<Route>(`${key}:route`);
  const entry = useTxEntry(key);
  return route !== null || holdsFlow(entry.phase);
}

/** The loan facts the door's reads stand on. */
export function cashLoanOf(loanId: bigint, v: LoanView): CashLoan {
  const l = v.loan;
  return {
    loanId,
    lending: l.principalAsset as Hex,
    collateral: l.collateralAsset as Hex,
    principal: l.principal,
    rateBps: l.interestRateBps,
    fullTermInterest: l.useFullTermInterest,
    borrower: (v.holders.borrower ?? null) as Hex | null,
  };
}

/**
 * #3763 / #3760 — "Get cash from this loan" on a live ERC-20 loan, for the
 * lender position's holder. The entry always opens: Leave it comes first,
 * then Sell now (a handover at face value, or a sale into a standing buy
 * offer) and Sell at my price (a listing). A route that is not open says
 * why and from when, in the protocol's words. Each signing route is a
 * review of exactly one call, dry-run from the wallet before it opens, and
 * measured from the transaction's own log.
 */
export function GetCash(props: GetCashProps) {
  const { loanId, view: v, own, chain, meta } = props;
  const copy = useCopy();
  const { text, format } = copy;
  const key = getCashKey(loanId);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  const [route, setRoute] = useStoredValue<Route>(`${key}:route`);
  const entry = useTxEntry(key);
  const [read, setRead] = useState<GetCashRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loan = cashLoanOf(loanId, v);
  const inFlow = route !== null || holdsFlow(entry.phase);

  useEffect(() => {
    if (open !== true || inFlow) return;
    let live = true;
    readGetCash(own, chain.diamondAddress, loan).then(
      (x) => {
        if (!live) return;
        setError(null);
        setRead(x);
      },
      (e: unknown) => live && setError(refusalFromError(e).reason),
    );
    return () => {
      live = false;
    };
    // Read when opened, and again on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inFlow, nonce, own, chain.diamondAddress, loanId]);

  const amount = (x: bigint) => tokenAmount(x, loan.lending, meta, format);
  const close = () => {
    setRoute(null);
    setNonce((n) => n + 1);
  };

  if (inFlow && route !== null) {
    return (
      <section className="get-cash" aria-labelledby="get-cash-title" data-testid="get-cash">
        <h3 id="get-cash-title">{text('getCash.title')}</h3>
        <CashFlow {...props} route={route} read={read} onClose={close} />
      </section>
    );
  }

  if (props.canOpen === false) return null;

  if (open !== true)
    return (
      <section className="get-cash" aria-labelledby="get-cash-title" data-testid="get-cash">
        <h3 id="get-cash-title">{text('getCash.title')}</h3>
        <p className="actions">
          <button type="button" className="btn" onClick={() => setOpen(true)} data-testid="get-cash-open">
            {text('getCash.open')}
          </button>
        </p>
      </section>
    );

  const closedLines = (s: Extract<RouteState, { kind: 'closed' }>, lead: string, id: string) => (
    <div data-testid={id} data-reopens={s.reopensAt ?? ''}>
      <p className="tier-a">{lead}</p>
      <ul>
        {s.refusals.map((r) => (
          <li key={r.code} className="tier-a" data-code={r.code}>
            {r.reason}
          </li>
        ))}
      </ul>
      <p className="tier-b">{s.reopensAt !== null && s.reopensAt > 0 ? format('getCash.reopensAt', { when: formatUtc(s.reopensAt) }) : text('getCash.reopensNoTime')}</p>
    </div>
  );

  const due = v.deadlines?.maturity ?? null;
  return (
    <section className="get-cash" aria-labelledby="get-cash-title" data-testid="get-cash">
      <h3 id="get-cash-title">{text('getCash.title')}</h3>
      <p className="tier-b">{text('getCash.lead')}</p>
      <ol className="get-cash-routes">
        <li data-testid="get-cash-leave">
          <h4>{text('getCash.leaveTitle')}</h4>
          <p className="tier-a">{due === null ? text('getCash.leaveBodyNoDate') : format('getCash.leaveBody', { due: formatUtc(Number(due)) })}</p>
        </li>
        <li data-testid="get-cash-now">
          <h4>{text('getCash.nowTitle')}</h4>
          {read === null && error === null && <p className="tier-b">{text('getCash.reading')}</p>}
          {read !== null && read.direct.kind === 'closed' && closedLines(read.direct, text('getCash.nowClosed'), 'get-cash-now-closed')}
          {read !== null && read.direct.kind === 'open' && read.handover.kind === 'ready' && (
            <div data-testid="get-cash-handover" data-receives={read.handover.receives.toString()}>
              <p className="tier-a">{format('getCash.handoverValue', { amount: amount(read.handover.receives) })}</p>
              <p className="tier-a">{text('getCash.interestStays')}</p>
              <button type="button" className="btn btn-primary" onClick={() => setRoute('handover')} data-testid="get-cash-handover-go">
                {text('getCash.handoverGo')}
              </button>
            </div>
          )}
          {read !== null && read.direct.kind === 'open' && read.handover.kind !== 'ready' && read.sale.kind === 'ready' && (
            <div data-testid="get-cash-sale" data-net={read.sale.net.toString()} data-offer={read.sale.offerId.toString()}>
              <p className="tier-a">{format('getCash.saleValue', { rate: formatBps(read.sale.rateBps), amount: amount(read.sale.net) })}</p>
              {read.sale.net < read.principal && <p className="tier-a">{format('getCash.saleCost', { cost: amount(read.principal - read.sale.net) })}</p>}
              <p className="tier-a">{text('getCash.interestStays')}</p>
              <button type="button" className="btn btn-primary" onClick={() => setRoute('sale')} data-testid="get-cash-sale-go">
                {text('getCash.saleGo')}
              </button>
            </div>
          )}
          {read !== null && read.direct.kind === 'open' && read.handover.kind !== 'ready' && read.sale.kind !== 'ready' && (
            <p className="tier-a" data-testid="get-cash-now-none">
              {text('getCash.nowNone')}
            </p>
          )}
        </li>
        <li data-testid="get-cash-list">
          <h4>{text('getCash.listTitle')}</h4>
          {read === null && error === null && <p className="tier-b">{text('getCash.reading')}</p>}
          {read !== null && read.listing.kind === 'closed' && closedLines(read.listing, text('getCash.listClosed'), 'get-cash-list-closed')}
          {read !== null && read.listing.kind === 'open' && (
            <>
              <p className="tier-a">{text('getCash.listLead')}</p>
              <button type="button" className="btn" onClick={() => setRoute('list')} data-testid="get-cash-list-go">
                {text('getCash.listGo')}
              </button>
            </>
          )}
        </li>
      </ol>
      {error !== null && (
        <Notice tone="warn" tier="A">
          {format('getCash.unreadable', { reason: error })}{' '}
          <button type="button" className="btn" onClick={() => setNonce((n) => n + 1)}>
            {text('getCash.retry')}
          </button>
        </Notice>
      )}
      <p className="actions">
        <button type="button" className="btn btn-link" onClick={() => (setOpen(null), setRead(null))} data-testid="get-cash-hide">
          {text('getCash.hide')}
        </button>
      </p>
    </section>
  );
}

/** The listing's form: the rate the buyer earns and how long it stays open,
 *  with what it pays the lender quoted by the protocol as typed. */
function ListForm({ loanId, own, chain, meta, loan, onChosen, onCancel }: GetCashProps & { loan: CashLoan; onChosen: (c: ListChoice) => void; onCancel: () => void }) {
  const { text, format } = useCopy();
  const key = getCashKey(loanId);
  const [rate, setRate] = useStoredValue<string>(`${key}:rate`);
  const [days, setDays] = useStoredValue<string>(`${key}:days`);
  const [asked, setAsked] = useState(false);
  const [quoted, setQuoted] = useState<{ key: string; value: { minNet: bigint; maxHeld: bigint } | string } | null>(null);
  const r = parseRateBps(rate ?? '');
  const d = parseDays(days ?? '', 30);
  const ready = r.ok && r.value > 0n && d.ok;
  const rateBps = r.ok ? r.value : null;
  const dayCount = d.ok ? d.value : null;

  const quoteKey = rateBps === null || dayCount === null || rateBps === 0n ? null : `${rateBps}:${dayCount}`;
  const quote: { minNet: bigint; maxHeld: bigint } | 'reading' | string | null = quoteKey === null ? null : quoted?.key === quoteKey ? quoted.value : 'reading';

  useEffect(() => {
    if (rateBps === null || dayCount === null || rateBps === 0n) return;
    const k = `${rateBps}:${dayCount}`;
    let live = true;
    own
      .read(async (c) => {
        const block = await c.getBlock({ blockTag: 'latest' });
        return quoteListing(c, chain.diamondAddress, loanId, rateBps, block.timestamp + BigInt(dayCount) * 86_400n);
      })
      .then(
        (x) => live && setQuoted({ key: k, value: x.value }),
        (e: unknown) => live && setQuoted({ key: k, value: refusalFromError(e).reason }),
      );
    return () => {
      live = false;
    };
  }, [own, chain.diamondAddress, loanId, rateBps, dayCount]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && rateBps !== null && dayCount !== null) onChosen({ rateBps, days: dayCount });
  };
  const rateError = (asked || (rate ?? '') !== '') && !(r.ok && r.value > 0n) ? text('getCash.errRate') : null;
  const daysError = (asked || (days ?? '') !== '') && !d.ok ? text('getCash.errDays') : null;

  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="get-cash-list-form">
      <h4>{text('getCash.listTitle')}</h4>
      <p className="tier-a">{text('getCash.listLead')}</p>
      <FormField label={text('getCash.rateLabel')} hint={format('getCash.rateHint', { rate: formatBps(loan.rateBps) })} error={rateError}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={rate ?? ''}
            onChange={(e) => setRate(e.target.value)}
            data-testid="get-cash-rate"
          />
        )}
      </FormField>
      <FormField label={text('getCash.daysLabel')} hint={text('getCash.daysHint')} error={daysError}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            inputMode="numeric"
            autoComplete="off"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={days ?? ''}
            onChange={(e) => setDays(e.target.value)}
            data-testid="get-cash-days"
          />
        )}
      </FormField>
      {quote === 'reading' && <p className="tier-b">{text('getCash.quoteReading')}</p>}
      {quote !== null && typeof quote === 'object' && (
        <p className="tier-b" data-testid="get-cash-quote" data-min-net={quote.minNet.toString()}>
          {format('getCash.quote', { amount: tokenAmount(quote.minNet, loan.lending, meta, format) })}
        </p>
      )}
      {typeof quote === 'string' && quote !== 'reading' && (
        <Notice tone="warn" tier="A">
          {format('getCash.quoteUnreadable', { reason: quote })}
        </Notice>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!ready} data-testid="get-cash-list-review">
          {text('getCash.listGo')}
        </button>
        <button type="button" className="btn" onClick={() => (setRate(null), setDays(null), onCancel())}>
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}

interface ListChoice {
  rateBps: bigint;
  days: number;
}

/** The figures a route's review was built from, read again before signing. */
export type Plan =
  | { route: 'handover'; owner: Hex; slot: number; receives: bigint }
  | { route: 'sale'; offerId: bigint; rateBps: bigint; net: bigint; maxHeld: bigint; principal: bigint }
  | { route: 'list'; rateBps: bigint; days: number; minNet: bigint; maxHeld: bigint };

function planKey(p: Plan): string {
  if (p.route === 'handover') return `h:${p.owner}:${p.slot}:${p.receives}`;
  if (p.route === 'sale') return `s:${p.offerId}:${p.net}:${p.maxHeld}:${p.principal}`;
  return `l:${p.rateBps}:${p.days}:${p.minNet}:${p.maxHeld}`;
}

/**
 * Whether a fresh read of the plan still honours the one under review: the
 * same route and counterparty, at least as much for the lender, and no more
 * of the held payments swept. A listing's floor and a sale's net move with
 * every block when the rate differs from the loan's, so an improvement keeps
 * the reviewed figures (the transaction is sent with them) and only an
 * adverse change asks for a fresh review.
 */
export function planHolds(reviewed: Plan, next: Plan): boolean {
  if (reviewed.route === 'handover')
    return next.route === 'handover' && next.owner.toLowerCase() === reviewed.owner.toLowerCase() && next.slot === reviewed.slot && next.receives >= reviewed.receives;
  if (reviewed.route === 'sale')
    return next.route === 'sale' && next.offerId === reviewed.offerId && next.rateBps === reviewed.rateBps && next.net >= reviewed.net && next.maxHeld <= reviewed.maxHeld;
  return next.route === 'list' && next.rateBps === reviewed.rateBps && next.days === reviewed.days && next.minNet >= reviewed.minNet && next.maxHeld <= reviewed.maxHeld;
}

/** One route's review and transaction. */
function CashFlow(props: GetCashProps & { route: Route; read: GetCashRead | null; onClose: () => void }) {
  const { loanId, view: v, own, chain, meta, route, read, onClose } = props;
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const key = getCashKey(loanId);
  const loan = cashLoanOf(loanId, v);
  const [list, setList] = useStoredValue<ListChoice>(`${key}:list`);
  const [plan, setPlan] = useStoredValue<Plan>(`${key}:plan`);
  const [planFor, setPlanFor] = useStoredValue<string>(`${key}:planFor`);
  /** The wallet and network the review was opened for, kept with it: a
   *  review opened for one wallet is never sent for another. */
  const [openedFor, setOpenedFor] = useStoredValue<string>(`${key}:openedFor`);
  const [error, setError] = useState<string | null>(null);
  const entry = useTxEntry(key);

  /** The plan for the chosen route, read now. */
  const readPlan = useCallback(async (): Promise<Plan> => {
    if (route === 'list') {
      if (!list) throw new Error('no listing chosen');
      const q = (
        await own.read(async (c) => {
          const block = await c.getBlock({ blockTag: 'latest' });
          return quoteListing(c, diamond, loanId, list.rateBps, block.timestamp + BigInt(list.days) * 86_400n);
        })
      ).value;
      return { route: 'list', rateBps: list.rateBps, days: list.days, minNet: q.minNet, maxHeld: q.maxHeld };
    }
    const g = await readGetCash(own, diamond, loan);
    if (g.direct.kind === 'closed') throw new StatedRefusal({ ...g.direct.refusals[0]!, reason: format('getCash.refused', { reason: g.direct.refusals[0]!.reason }) });
    if (route === 'handover') {
      if (g.handover.kind !== 'ready') throw new StatedRefusal({ code: 'NoHandover', reason: text('getCash.nowNone'), reopensAt: null, remedy: null });
      return { route: 'handover', owner: g.handover.owner, slot: g.handover.slot, receives: g.handover.receives };
    }
    if (g.sale.kind !== 'ready') throw new StatedRefusal({ code: 'NoBuyOffer', reason: text('getCash.nowNone'), reopensAt: null, remedy: null });
    const held = v.heldForLender;
    if (held === null) throw new StatedRefusal({ code: 'HeldUnread', reason: text('frozen.reservedUnread'), reopensAt: null, remedy: null });
    return { route: 'sale', offerId: g.sale.offerId, rateBps: g.sale.rateBps, net: g.sale.net, maxHeld: held, principal: g.principal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, list, own, diamond, loanId, v.heldForLender]);

  const callOf = (p: Plan, validUntil: bigint) =>
    p.route === 'handover'
      ? takeoverCall(loanId, p.owner, p.slot, validUntil)
      : p.route === 'sale'
        ? directSaleCall(loanId, p.offerId, p.net, p.maxHeld, validUntil)
        : listingCall(loanId, p.rateBps, true, BigInt(p.days) * 86_400n, p.minNet, p.maxHeld, validUntil);

  const tx = useTrackedTx({
    key,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!plan) throw new Error('nothing under review');
      const validUntil = await readValidUntil(own, 'getCashPlan');
      const call = callOf(plan, validUntil);
      const asked = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
      if (asked.kind === 'reverted')
        throw new StatedRefusal({ ...refusalFromError(asked.error), reason: format('getCash.refused', { reason: refusalFromError(asked.error).reason }) });
      if (asked.kind === 'unreadable') throw new StatedRefusal({ code: 'Unreadable', reason: format('flow.unreadable', { reason: asked.reason }), reopensAt: null, remedy: null });
      return sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
    },
    unwind: async () => null,
    measure: async (receipt): Promise<LegOutcome[]> => {
      const got = cashLogs(receipt.logs, diamond, loanId);
      if (!plan) return [];
      if (plan.route === 'handover') {
        const label = format('getCash.legHandover', { amount: tokenAmount(got.takenOverPaid ?? plan.receives, loan.lending, meta, format) });
        return [got.takenOverPaid !== null ? { status: 'done', label } : { status: 'not-done', label, reason: text('getCash.legMissing') }];
      }
      if (plan.route === 'sale') {
        const label = text('getCash.legSold');
        return [got.sold ? { status: 'done', label } : { status: 'not-done', label, reason: text('getCash.legMissing') }];
      }
      const label = text('getCash.legListed');
      return [got.listed ? { status: 'done', label } : { status: 'not-done', label, reason: text('getCash.legMissing') }];
    },
  });

  // The plan is read once per route (and listing choice), then kept with the
  // review; a re-check reads it again before the wallet opens.
  const subject = route === 'list' ? (list ? `list:${list.rateBps}:${list.days}` : null) : route;
  useEffect(() => {
    if (subject === null || holdsFlow(entry.phase)) return;
    if (plan !== null && planFor === subject) return;
    let live = true;
    readPlan().then(
      (p) => {
        if (!live) return;
        setError(null);
        setPlan(p);
        setPlanFor(subject);
        if (openedFor === null) setOpenedFor(identity);
        if (tx.phase.kind === 'idle') tx.review();
      },
      (e: unknown) => live && setError(refusalFromError(e).reason),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);

  const finish = () => {
    tx.reset();
    setPlan(null);
    setPlanFor(null);
    setOpenedFor(null);
    setList(null);
    onClose();
  };

  if (route === 'list' && !list && !holdsFlow(entry.phase)) return <ListForm {...props} loan={loan} onChosen={setList} onCancel={finish} />;

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!plan) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: Plan;
    try {
      next = await readPlan();
    } catch (e) {
      const r = refusalFromError(e);
      return e instanceof StatedRefusal ? { kind: 'refused', refusal: r } : { kind: 'unreadable', reason: r.reason };
    }
    if (planKey(next) !== planKey(plan) && !planHolds(plan, next)) {
      if (current()) setPlan(next);
      return { kind: 'changed', what: text('getCash.changed') };
    }
    // The reviewed figures are the ones sent, so they are the ones asked.
    const asked = await askThrough(own, async (c) => c.simulateContract({ address: diamond, ...callOf(plan, await chainValidUntil(c, 'getCashPlan')), account }));
    if (asked.kind === 'reverted') return { kind: 'refused', refusal: refusalFromError(asked.error) };
    if (asked.kind === 'unreadable') return { kind: 'unreadable', reason: asked.reason };
    return { kind: 'ok' };
  };

  const receipt = plan && (planFor === subject || holdsFlow(entry.phase)) ? cashReceipt(plan, loan, meta, copy) : null;
  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  return (
    <div className="repay-loan" data-testid={`get-cash-${route}-panel`}>
      {error !== null && (
        <Notice tone="warn" tier="A">
          {error}{' '}
          <button type="button" className="btn" onClick={finish}>
            {text('getCash.hide')}
          </button>
        </Notice>
      )}
      {read === null && plan === null && error === null && <p className="tier-b">{text('getCash.reading')}</p>}
      <ActionFlow
        tx={tx}
        identity={identity}
        reviewedFor={openedFor ?? tx.frozen?.identity ?? identity}
        publicQueue
        receipt={receipt}
        recheck={recheck}
        describeAsset={describeAsset}
        explorer={chain.blockExplorer}
        next={null}
        onClose={finish}
      />
    </div>
  );
}

/** The review of one route: what moves, where, and what the lender gives up. */
// `getCash.loseRewards` states the deployed rule: every hand-on of a lender
// position closes the outgoing lender's reward entry as forfeited. #3670
// (decided, not yet built) splits the entry at the sale day instead; the
// line changes when that reaches the contracts.
export function cashReceipt(p: Plan, loan: CashLoan, meta: TokenMetaMap | null, copy: CopyAccess): Receipt {
  const { text, format } = copy;
  const exact = (x: bigint) => exactTokenAmount(x, loan.lending, meta, format);
  const rows: ReceiptRow[] = [{ label: text('getCash.rowLoan'), value: { kind: 'text', text: format('getCash.loanValue', { id: loan.loanId.toString() }) }, binding: true }];
  const consequences: string[] = [];
  if (p.route === 'handover') {
    rows.push(
      { label: text('getCash.rowTo'), value: { kind: 'text', text: format('getCash.toValue', { owner: p.owner }) }, binding: true },
      { label: text('getCash.rowReceive'), value: { kind: 'amount', asset: loan.lending, amount: p.receives }, binding: true },
      { label: text('getCash.rowWhere'), value: { kind: 'text', text: text('getCash.whereVault') }, binding: true },
      { label: text('getCash.rowFee'), value: { kind: 'text', text: text('getCash.feeNone') }, binding: true },
      { label: text('getCash.rowEarned'), value: { kind: 'text', text: text('getCash.earnedValue') }, binding: false },
    );
    consequences.push(text('getCash.loseLoan'), text('getCash.loseRewards'), text('getCash.loseFirst'));
  } else if (p.route === 'sale') {
    rows.push(
      { label: text('getCash.rowOffer'), value: { kind: 'text', text: format('getCash.offerValue', { id: p.offerId.toString(), rate: formatBps(p.rateBps) }) }, binding: true },
      { label: text('getCash.rowReceive'), value: { kind: 'amount', asset: loan.lending, amount: p.net }, binding: true },
      { label: text('getCash.rowWhere'), value: { kind: 'text', text: text('getCash.whereVault') }, binding: true },
      { label: text('getCash.rowCost'), value: { kind: 'text', text: exact(p.principal > p.net ? p.principal - p.net : 0n) }, binding: true },
      { label: text('getCash.rowEarned'), value: { kind: 'text', text: text('getCash.earnedValue') }, binding: false },
    );
    if (p.maxHeld > 0n) rows.push({ label: text('getCash.rowMaxHeld'), value: { kind: 'amount', asset: loan.lending, amount: p.maxHeld }, binding: true });
    consequences.push(text('getCash.loseLoan'), text('getCash.loseRewards'), text('getCash.loseFirst'));
  } else {
    rows.push(
      { label: text('getCash.rowRate'), value: { kind: 'text', text: formatBps(p.rateBps) }, binding: true },
      { label: text('getCash.rowOpenFor'), value: { kind: 'text', text: format('getCash.openForValue', { days: String(p.days) }) }, binding: true },
      { label: text('getCash.rowReceiveListed'), value: { kind: 'amount', asset: loan.lending, amount: p.minNet }, binding: true },
      { label: text('getCash.rowWhere'), value: { kind: 'text', text: text('getCash.whereVault') }, binding: true },
      { label: text('getCash.rowEarned'), value: { kind: 'text', text: text('getCash.earnedValue') }, binding: false },
    );
    if (p.maxHeld > 0n) rows.push({ label: text('getCash.rowMaxHeld'), value: { kind: 'amount', asset: loan.lending, amount: p.maxHeld }, binding: true });
    consequences.push(text('getCash.loseListing'), text('getCash.loseListingFloor'), text('getCash.loseLoan'), text('getCash.loseRewards'));
  }
  const title = text(p.route === 'handover' ? 'getCash.handoverTitle' : p.route === 'sale' ? 'getCash.saleTitle' : 'getCash.listingTitle');
  return { title, rows, consequences, prompts: 1, readAt: Date.now() };
}
