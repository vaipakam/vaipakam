import { Link, useParams } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { PAGES, currentAppHref } from '../../routes/pageMap';
import { AcceptOffer } from '../../shared/accept/AcceptOffer';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { CancelOffer, useCancelOfferHeld } from '../../shared/offers/CancelOffer';
import { roleTerms } from '../../shared/offers/acceptTerms';
import { detailAction, readOfferDetail, type OfferDetail } from '../../shared/offers/offerDetail';
import { collateralWords } from '../../shared/offers/collateralWords';
import { offerAmount, offerLine } from '../../shared/offers/offerLine';
import type { OfferState } from '../../shared/offers/reads';
import { ASSET_ERC20, OFFER_TYPE_LENDER } from '../../shared/positions/model';
import { useChainRead, useScreenChain } from '../../shared/reads/chainRead';
import { tokenAmount, useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';
import { formatAge, formatUtc, shortAddress } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { useNow } from '../../shared/ui/useNow';
import { Fact, Facts } from '../position/Facts';

type Hex = `0x${string}`;

/** The store key an acceptance from this page keeps its state under: its
 *  own, so an acceptance in flight on Borrow or Lend never shows here. */
export const OFFERS_ACCEPT_KEY = 'offers.accept';

const STATE_KEY: Record<OfferState, CopyKey> = {
  open: 'offers.stateOpen',
  accepted: 'offers.stateAccepted',
  'sale-consumed': 'offers.stateSaleConsumed',
  expired: 'offers.stateExpired',
  cancelled: 'offers.stateCancelled',
};

const ELSEWHERE_KEY = {
  rental: 'offerPage.elsewhereRental',
  nft: 'offerPage.elsewhereNft',
  'loan-sale': 'offerPage.elsewhereLoanSale',
  offset: 'offerPage.elsewhereOffset',
} as const satisfies Record<string, CopyKey>;

/** An offer number from the address bar, or null when it is not one. */
/**
 * The flows open or in flight for an offer on this page: its cancel (or
 * clean-up) and its take, including a take waiting on the Terms prompt. A
 * held flow keeps its panel whatever the offer's latest read says: its own
 * transaction changes the offer (a take fills it, a cancel ends it and may
 * clear its terms), and the creator may cancel under a reader's open review,
 * so the panel stays, with its Close, until the reader closes it.
 */
function useHeldFlows(id: bigint | null): { cancel: boolean; take: boolean; closeCancel: () => void } {
  const cancel = useCancelOfferHeld(id ?? 0n);
  const [taking] = useStoredValue<string>(`${OFFERS_ACCEPT_KEY}:offer`);
  const [pending] = useStoredValue<string>(`${OFFERS_ACCEPT_KEY}:pending`);
  const key = id?.toString() ?? null;
  return { cancel: id !== null && cancel.held, take: key !== null && (taking === key || pending === key), closeCancel: () => cancel.setOpen(null) };
}

export function parseOfferId(raw: string | undefined): bigint | null {
  if (raw === undefined || !/^\d{1,30}$/.test(raw)) return null;
  const id = BigInt(raw);
  return id > 0n ? id : null;
}

/**
 * One offer (OFF-41, OFF-45, OFF-49, OFF-50): read from the chain at one
 * block, whoever is looking, with or without a wallet, so its state and
 * terms are the protocol's and never the index's. What the reader may do
 * follows from that read: take an open offer whole (the shared acceptance
 * flow, behind the Terms gate), cancel their own, clean up an expired one
 * whoever created it, or be told where a kind of offer this app does not
 * take yet is taken. An ended offer says how it ended.
 */
export function OfferPage() {
  const { text, format } = useCopy();
  const params = useParams();
  const id = parseOfferId(params.id);
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const walletChain = getSupportedChain(chainId);
  const screenChain = useScreenChain();
  const own = useOwnStateClient();
  const chain = connected && walletChain ? walletChain : screenChain;
  const diamond = chain.diamondAddress as Hex;
  const parts = ['offerDetail', diamond, id?.toString() ?? ''];
  const ownRead = useOwnRead(parts, (c) => readOfferDetail(c, diamond, id!), { enabled: id !== null && connected && walletChain !== null });
  const publicRead = useChainRead(parts, (c) => readOfferDetail(c, diamond, id!), { enabled: id !== null && !(connected && walletChain !== null) });
  const read = connected && walletChain !== null ? ownRead : publicRead;
  const d = read.data;
  const meta = useTokenMeta(d?.kind === 'offer' ? [d.offer.lendingAsset, d.offer.collateralAsset, d.offer.prepayAsset] : []).data;
  const now = useNow();
  // A held flow renders here when the read finds no terms (a cancel cleared
  // them), and inside the offer's body otherwise.
  const held = useHeldFlows(id);
  const heldOwn = connected && walletChain ? own : null;

  return (
    <main className="page offer" aria-labelledby="offer-title">
      <p className="tier-b">
        <Link to="/offers">{text('offerPage.back')}</Link>
      </p>
      <h1 id="offer-title">{format('offerPage.title', { id: params.id ?? '' })}</h1>
      {id === null ? (
        <p className="tier-a">{text('offerPage.badId')}</p>
      ) : (
        <>
          {connected && walletChain === null && <p className="tier-b">{format('offerPage.unsupported', { chain: chain.name })}</p>}
          {connected && walletChain !== null ? (
            <OwnStamp reads={[ownRead]} />
          ) : (
            publicRead.readAt !== null && <p className="tier-b stamp">{format('offerPage.readAt', { age: formatAge((now - publicRead.readAt) / 1000), chain: chain.name })}</p>
          )}
          {read.state === 'failed' && <p className="tier-a notice-warn">{format('offerPage.failed', { reason: read.error ?? '' })}</p>}
          {read === publicRead && read.state === 'ready' && read.error !== null && (
            <p className="tier-a notice-warn" data-testid="offer-refresh-failed">
              {format('offerPage.refreshFailed', { reason: read.error, chain: chain.name })}
            </p>
          )}
          {d === null && read.state !== 'failed' && <p className="tier-b">{text('offerPage.reading')}</p>}
          {d?.kind === 'no-terms' && (
            <p className="tier-a" data-testid="offer-no-terms">
              {format('offerPage.noTerms', { id: id.toString(), chain: chain.name })}
            </p>
          )}
          {d?.kind !== 'offer' && (held.cancel || held.take) && walletChain && heldOwn && (
            <section className="home-section" data-testid="offer-action">
              {held.cancel && <CancelOffer id={id} chain={walletChain} own={heldOwn} onClose={held.closeCancel} />}
              {held.take && <TakeAction id={id} chain={walletChain} own={heldOwn} meta={meta} lend />}
            </section>
          )}
          {d?.kind === 'offer' && <OfferBody detail={d} walletChain={connected ? walletChain : null} own={connected && walletChain ? own : null} meta={meta} />}
        </>
      )}
    </main>
  );
}

function OfferBody({
  detail: d,
  walletChain,
  own,
  meta,
}: {
  detail: Extract<OfferDetail, { kind: 'offer' }>;
  walletChain: SupportedChain | null;
  own: OwnStateClient | null;
  meta: TokenMetaMap | null;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const o = d.offer;
  const viewer = own?.account ?? null;
  const mine = viewer !== null && o.creator.toLowerCase() === viewer.toLowerCase();
  const action = detailAction(d, viewer);
  const held = useHeldFlows(d.id);
  const lend = o.offerType === OFFER_TYPE_LENDER;
  const erc20 = o.assetType === ASSET_ERC20;
  const erc20Collateral = o.collateralAssetType === ASSET_ERC20;
  const unknown = text('receipt.unknown');
  const amt = (v: bigint) => offerAmount(o, v, meta, format);
  const collateral = collateralWords(o, meta, format);
  const terms = roleTerms(o);
  const offersPage = PAGES.find((p) => p.path === '/offers/:id');
  const currentHref = offersPage ? currentAppHref(offersPage, { id: d.id.toString() }) : null;

  return (
    <>
      <p className="row-head">
        {offerLine(o, meta, copy)}{' '}
        <span className="badge" data-testid="offer-state">
          {text(STATE_KEY[d.state])}
        </span>
      </p>
      <Facts title={text('offerPage.factsTitle')} id="offer-facts" testId="offer-facts">
        <Fact label={text('offerPage.factSide')} value={text(lend ? 'offerPage.sideLender' : 'offerPage.sideBorrower')} unknown={unknown} />
        <Fact label={text('offerPage.factCreator')} value={mine ? text('offerBook.byYou') : shortAddress(o.creator)} unknown={unknown} />
        {erc20 && (
          <Fact
            label={text('offerPage.factAmount')}
            value={o.amountMax > o.amount ? format('home.rateRange', { min: amt(o.amount), max: amt(o.amountMax) }) : amt(terms.amount)}
            unknown={unknown}
          />
        )}
        {erc20 && o.amountFilled > 0n && <Fact label={text('offerPage.factFilled')} value={amt(o.amountFilled)} unknown={unknown} />}
        <Fact label={text(lend ? 'offerPage.factCollateralAsked' : 'offerPage.factCollateralPledged')} value={collateral} unknown={unknown} />
        {!lend && erc20Collateral && o.collateralAmountFilled > 0n && (
          <Fact label={text('offerPage.factCollateralFilled')} value={tokenAmount(o.collateralAmountFilled, o.collateralAsset, meta, format)} unknown={unknown} />
        )}
        <Fact label={text('offerPage.factDuration')} value={format('offerPage.days', { days: o.durationDays.toString() })} unknown={unknown} />
        <Fact label={text('offerPage.factExpires')} value={o.expiresAt > 0n ? formatUtc(Number(o.expiresAt)) : text('offerPage.never')} unknown={unknown} />
      </Facts>
      {d.purpose === 'refinance' && <p className="tier-a">{format('offerPage.refinanceNote', { loan: o.refinanceTargetLoanId.toString() })}</p>}
      {d.purpose === 'loan-sale' && <p className="tier-a">{format('offerPage.loanSaleNote', { loan: d.linkedLoanId.toString() })}</p>}
      {d.purpose === 'offset' && <p className="tier-a">{format('offerPage.offsetNote', { loan: d.linkedLoanId.toString() })}</p>}
      {d.state === 'accepted' && <p className="tier-b">{text(mine ? 'offers.filledNote' : 'offerPage.filledOther')}</p>}
      {d.state === 'sale-consumed' && <p className="tier-a">{text('offers.soldNote')}</p>}
      {d.state === 'cancelled' && <p className="tier-b">{text('offerPage.cancelledNote')}</p>}
      {d.state === 'expired' && <p className="tier-a">{text('offers.expiredHolds')}</p>}
      <section className="home-section" aria-labelledby="offer-action" data-testid="offer-action">
        <h2 id="offer-action" className="sr-only">
          {text('offerPage.actionTitle')}
        </h2>
        {action.kind === 'connect' && <p className="tier-b">{text(d.state === 'expired' ? 'offerPage.connectCleanUp' : 'offerPage.connectTake')}</p>}
        {action.kind === 'elsewhere' && (
          <p className="tier-b" data-testid="offer-elsewhere">
            {text(ELSEWHERE_KEY[action.why])}{' '}
            {currentHref !== null && (
              <a href={currentHref} target="_blank" rel="noreferrer">
                {text('vault.openCurrent')}
              </a>
            )}
          </p>
        )}
        {(action.kind === 'cancel' || action.kind === 'clean-up' || held.cancel) && walletChain && own && (
          <CancelAction id={d.id} cleanUp={action.kind === 'clean-up'} chain={walletChain} own={own} />
        )}
        {(action.kind === 'accept' || held.take) && walletChain && own && <TakeAction id={d.id} chain={walletChain} own={own} meta={meta} lend={lend} />}
      </section>
      <WhyLink summaryKey="offerPage.whySummary" detailKey="offerPage.why" />
    </>
  );
}

function CancelAction({ id, cleanUp, chain, own }: { id: bigint; cleanUp: boolean; chain: SupportedChain; own: OwnStateClient }) {
  const { text } = useCopy();
  const cancel = useCancelOfferHeld(id);
  if (cancel.held) return <CancelOffer id={id} chain={chain} own={own} onClose={() => cancel.setOpen(null)} />;
  return (
    <button type="button" className="btn" onClick={() => cancel.setOpen(true)} data-testid="offer-page-cancel">
      {text(cleanUp ? 'offers.cleanUp' : 'offers.cancel')}
    </button>
  );
}

/** OFF-50 from the book: the shared acceptance flow, behind the Terms gate
 *  (OFF-35), kept in this page's own store so a navigation away and back
 *  reopens the same review. */
function TakeAction({ id, chain, own, meta, lend }: { id: bigint; chain: SupportedChain; own: OwnStateClient; meta: TokenMetaMap | null; lend: boolean }) {
  const { text, format } = useCopy();
  const terms = useTerms();
  const termsGate = useTermsGate(`${OFFERS_ACCEPT_KEY}.terms`, chain, own);
  const [taking, setTaking] = useStoredValue<string>(`${OFFERS_ACCEPT_KEY}:offer`);
  const [pending, setPending] = useStoredValue<string>(`${OFFERS_ACCEPT_KEY}:pending`);
  const key = id.toString();
  const open = taking === key;
  const termsOpen = termsGate.session !== null;
  const take = () => {
    if (terms.data?.kind === 'needed') {
      setPending(key);
      termsGate.start(terms.data);
      return;
    }
    setTaking(key);
  };
  if (taking !== null && !open) {
    return (
      <p className="tier-b" data-testid="offer-page-taking-other">
        {format('offerPage.takingOther', { id: taking })} <Link to={`/offers/${taking}`}>{text('offerPage.openTaking')}</Link>
      </p>
    );
  }
  return (
    <>
      {terms.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', { chain: chain.name, reason: terms.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {!open && !termsOpen && (
        <button type="button" className="btn btn-primary" disabled={terms.state !== 'ready'} onClick={take} data-testid="offer-page-take">
          {text(lend ? 'offerPage.takeLoan' : 'offerPage.fundRequest')}
        </button>
      )}
      {termsOpen && termsGate.session && (
        <TermsPrompt
          asker={text('offerPage.asker')}
          gate={termsGate}
          session={termsGate.session}
          chain={chain}
          own={own}
          onAccepted={() => {
            termsGate.end();
            if (pending !== null) setTaking(pending);
            setPending(null);
          }}
          onClose={() => {
            setPending(null);
            termsGate.end();
          }}
        />
      )}
      {open && <AcceptOffer flowKey={OFFERS_ACCEPT_KEY} offerId={id} chain={chain} own={own} meta={meta} terms={terms.data} onClose={() => setTaking(null)} />}
    </>
  );
}
