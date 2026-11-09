import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { PAGES, currentAppHref } from '../../routes/pageMap';
import { useCopy } from '../../shared/copy/useCopy';
import { faucetAssets } from '../../shared/faucet/faucet';
import { WhyLink } from '../../shared/help/WhyLink';
import { OfferBook } from '../../shared/offers/OfferBook';
import { useTokenMeta } from '../../shared/reads/tokens';
import type { ListDraft } from '../../shared/rent/listModel';
import { ListForRent, RENT_LIST_KEY } from '../../shared/rent/ListForRent';
import { RentListForm } from '../../shared/rent/RentListForm';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';
import { Notice } from '../../shared/ui/Notice';

/**
 * Rent (NFT-01, NFT-02, NFT-03, NFT-38): the rental book on the wallet's
 * network, the rentals tab alone, owners' listings first; each row opens the
 * offer's page, which reads it from the chain and offers the rental review
 * for an owner's listing. An empty book on a test network offers the faucet
 * as the next step. An owner lists an NFT for rent here, through its own
 * form and review, behind the Terms gate. Posting a renter's request is not
 * built here yet, and the page says where it is done today.
 */
export function RentPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId ?? chainId);
  const connected = status === 'connected';
  const served = connected && chain !== null && own !== null;
  const testAssets = chain ? (faucetAssets(chain) ?? []) : [];
  const testNfts = testAssets.some((a) => a.kind === 'nft' || a.kind === 'multi');
  const page = PAGES.find((p) => p.path === '/rent');
  const listHref = page ? currentAppHref(page, {}) : null;

  const terms = useTerms();
  const termsGate = useTermsGate(`${RENT_LIST_KEY}.terms`, chain, own);
  /** The owner's listing: the form is open (`composing`), and the confirmed
   *  draft under review, each kept in the app's store with its tracker. */
  const [composing, setComposing] = useStoredValue<boolean>(`${RENT_LIST_KEY}:composing`);
  const [draft, setDraft] = useStoredValue<ListDraft>(`${RENT_LIST_KEY}:draft`);
  const [pendingDraft, setPendingDraft] = useStoredValue<ListDraft>(`${RENT_LIST_KEY}:pending`);
  const [, setTyped] = useStoredValue<unknown>(`${RENT_LIST_KEY}:input`);
  const meta = useTokenMeta(draft ? [draft.nft, draft.payment] : []).data;
  const termsOpen = termsGate.session !== null;
  const termsUnknown = served && terms.state === 'failed';
  const listing = composing === true || draft !== null;

  // OFF-35: a listing is new exposure, so an unaccepted Terms version is
  // accepted before its review opens.
  const review = (next: ListDraft) => {
    if (terms.data?.kind === 'needed') {
      setPendingDraft(next);
      termsGate.start(terms.data);
      return;
    }
    setDraft(next);
  };

  return (
    <main className="page rent" aria-labelledby="rent-title">
      <h1 id="rent-title">{text('rentPage.title')}</h1>
      <p className="tier-b">{text('rentPage.lead')}</p>
      {!connected && (
        <p className="tier-b" data-testid="rent-connect">
          {text('rentPage.connect')}
        </p>
      )}
      {connected && chain === null && <p className="tier-b">{text('rentPage.unsupported')}</p>}
      {termsUnknown && (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', { chain: chain.name, reason: terms.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {served && !listing && (
        <OfferBook
          viewer={own.account}
          rentals
          empty={
            <div className="card" data-testid="rent-empty">
              <p className="tier-b">{format('rentPage.empty', { chain: chain.name })}</p>
              {testNfts && (
                <p className="tier-b">
                  {text('rentPage.emptyFaucet')}{' '}
                  <Link to="/#faucet" data-testid="rent-faucet">
                    {text('rentPage.faucetLink')}
                  </Link>
                </p>
              )}
            </div>
          }
        />
      )}
      <section className="home-section" aria-labelledby="rent-list-title" data-testid="rent-list">
        <h2 id="rent-list-title">{text('rentPage.listTitle')}</h2>
        {served && !listing && (
          <>
            <p className="tier-b">{text('rentPage.listLead')}</p>
            <p>
              <button type="button" className="btn" disabled={termsOpen || terms.state !== 'ready'} onClick={() => setComposing(true)} data-testid="rent-list-open">
                {text('rentPage.listButton')}
              </button>
            </p>
          </>
        )}
        {served && composing === true && draft === null && !termsOpen && (
          <RentListForm formKey={RENT_LIST_KEY} chain={chain} own={own} onReview={review} onCancel={() => setComposing(null)} />
        )}
        {termsOpen && termsGate.session && served && (
          <TermsPrompt
            asker={text('rentList.title')}
            gate={termsGate}
            session={termsGate.session}
            chain={chain}
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
        {draft !== null && served && (
          <ListForRent
            draft={draft}
            chain={chain}
            own={own}
            meta={meta}
            terms={terms.data}
            onEdit={() => setDraft(null)}
            onClose={(posted) => {
              setDraft(null);
              setComposing(null);
              if (posted) setTyped(null);
            }}
          />
        )}
        <p className="tier-b" data-testid="rent-request-later">
          {text('rentPage.requestLater')}{' '}
          {listHref !== null && (
            <a href={listHref} target="_blank" rel="noreferrer">
              {text('vault.openCurrent')}
            </a>
          )}
        </p>
      </section>
      <WhyLink summaryKey="rentPage.whySummary" detailKey="rentPage.why" />
    </main>
  );
}
