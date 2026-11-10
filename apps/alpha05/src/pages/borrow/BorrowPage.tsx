import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { loadLastPair, saveLastPair, suggestedAssets } from '../../shared/offers/assets';
import { useScreenChain } from '../../shared/reads/chainRead';
import { useTokenMeta } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';
import { Notice } from '../../shared/ui/Notice';
import { StepNav } from '../../shared/ui/StepNav';
import { AcceptOffer, ACCEPT_KEY } from '../../shared/accept/AcceptOffer';
import { MatchingOffers, type MatchesView } from '../../shared/offers/MatchingOffers';
import { PairPicker } from '../../shared/offers/PairPicker';
import { StandingLenders } from '../../shared/offers/StandingLenders';
import { readMatches } from '../../shared/offers/matches';
import { ArmTariff, TARIFF_CONTEXT_KEY, type ArmContext } from '../../shared/post/ArmTariff';
import { PostOffer } from '../../shared/post/PostOffer';
import { OfferForm, REQUEST_KEY } from '../../shared/post/OfferForm';
import type { PostDraft } from '../../shared/post/postReview';
import { lifecycleTerms, type PostAssets } from '../../shared/post/postModel';
import { useAssetStandard } from '../../shared/nft/useStandard';
import { indexerPositionFlowReader } from '../../shared/offers/positionFlow';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';

type Hex = `0x${string}`;

const PAIR_STORE = 'alpha05.borrow.pair';

/** The pair the page opens on: the one last used on this network, else the
 *  first two suggested tokens (RB-CLICKS: prefilled from the last pair). */
function initialPair(chainId: number, suggested: readonly { address: Hex }[]): { lending: Hex | null; collateral: Hex | null } {
  const last = loadLastPair(PAIR_STORE, chainId);
  if (last) return last;
  return {
    lending: suggested[0]?.address ?? null,
    collateral: suggested[1]?.address ?? null,
  };
}

/**
 * Borrow (rulebook §4: guided flows, review, finish). The guided path for a
 * borrower: choose what to borrow and what to lock, see the lender offers
 * open for that pair (read from the protocol through the wallet), and take
 * one whole through the shared signing flow, behind the Terms gate. When
 * no offer fits, the borrower posts their own request for the pair instead,
 * through the same review and signing flow. A request may lock an NFT as
 * collateral (NFT-13): one ERC-721 token, or a quantity of one ERC-1155
 * token, named by its id. A lender offer that asks for an NFT is named and
 * handed to the current app until its step is built. The Advanced options follow in a later
 * update; the page says so instead of hiding them.
 */
export function BorrowPage() {
  const { text, format } = useCopy();
  const { status, chainId, address } = useAccount();
  const connected = status === 'connected';
  const walletChain = getSupportedChain(chainId);
  const screenChain = useScreenChain();
  const chain = connected ? walletChain : screenChain;
  const own = useOwnStateClient();
  const terms = useTerms();
  const termsGate = useTermsGate(`${ACCEPT_KEY}.terms`, walletChain, own);
  /** The offer under review, kept in the app's store with the review and
   *  its tracker, so a navigation away and back reopens the same flow. */
  const [taking, setTaking] = useStoredValue<bigint>(`${ACCEPT_KEY}:offer`);
  /** The offer a Terms acceptance was asked for, taken once it is recorded. */
  const [pendingTake, setPendingTake] = useStoredValue<bigint>(`${ACCEPT_KEY}:pending`);
  /** The borrower's own request: the form is open (`composing`), and the
   *  confirmed draft under review, each kept like the offer above. */
  const [composing, setComposing] = useStoredValue<boolean>(`${REQUEST_KEY}:composing`);
  const [draft, setDraft] = useStoredValue<PostDraft>(`${REQUEST_KEY}:draft`);
  const [pendingDraft, setPendingDraft] = useStoredValue<PostDraft>(`${REQUEST_KEY}:pending`);
  const [, setTyped] = useStoredValue<unknown>(`${REQUEST_KEY}:input`);
  /** OFF-22: the Full tariff step for a request just posted, kept apart from
   *  the request's review so it outlives that card. */
  const [armContext, setArmContext] = useStoredValue<ArmContext>(TARIFF_CONTEXT_KEY);

  const suggested = chain ? suggestedAssets(chain) : [];
  const [pairByChain, setPairByChain] = useState<Record<number, { lending: Hex | null; collateral: Hex | null }>>({});
  const pair = chain ? (pairByChain[chain.chainId] ?? initialPair(chain.chainId, suggested)) : { lending: null, collateral: null };
  const setPair = (next: { lending: Hex | null; collateral: Hex | null }) => {
    if (!chain) return;
    setPairByChain((p) => ({ ...p, [chain.chainId]: next }));
    if (next.lending && next.collateral && next.lending.toLowerCase() !== next.collateral.toLowerCase())
      saveLastPair(PAIR_STORE, chain.chainId, {
        lending: next.lending,
        collateral: next.collateral,
      });
  };
  const ready = pair.lending !== null && pair.collateral !== null && pair.lending.toLowerCase() !== pair.collateral.toLowerCase();

  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const world = useWorldRail();
  // #3205 — the indexer's moved verdict for offers bound to a loan position.
  const flows = indexerPositionFlowReader(world.indexer, chain?.chainId ?? world.chainId);
  const lending = pair.lending ?? ('0x' as Hex);
  const collateral = pair.collateral ?? ('0x' as Hex);
  const ownMatches = useOwnRead(
    ['borrow', 'matches', lending.toLowerCase(), collateral.toLowerCase()],
    (c) => readMatches(c, diamond, lending, collateral, own!.account, 'borrower', flows),
    {
      enabled: ready && walletChain !== null,
    },
  );
  // Offers are read only once a wallet is connected on a served network
  // (owner decision 2026-11-09: no offer-book read before a wallet).
  const view: MatchesView = ownMatches;

  const assets: Hex[] = [...suggested.map((s) => s.address), ...(pair.lending ? [pair.lending] : []), ...(pair.collateral ? [pair.collateral] : [])];
  const meta = useTokenMeta(assets).data;

  const requesting = composing === true || draft !== null;
  const flowOpen = taking !== null || requesting;
  const termsOpen = termsGate.session !== null;

  // OFF-35: taking an offer is new exposure, so an unaccepted Terms version
  // is accepted first; the offer is taken once the acceptance is recorded.
  const take = (id: bigint) => {
    if (terms.data?.kind === 'needed') {
      setPendingTake(id);
      termsGate.start(terms.data);
      return;
    }
    setTaking(id);
  };

  // OFF-35 holds for a request too: it is new exposure, so an unaccepted
  // Terms version is accepted before its review opens.
  const reviewRequest = (next: PostDraft) => {
    if (terms.data?.kind === 'needed') {
      setPendingDraft(next);
      termsGate.start(terms.data);
      return;
    }
    setDraft(next);
  };

  const termsUnknown = connected && walletChain !== null && terms.state === 'failed';
  const takeDisabled = !connected || walletChain === null || terms.state !== 'ready' || termsOpen;

  const step = taking !== null || draft !== null ? 2 : ready ? 1 : 0;
  // NFT-13: what each leg's contract claims decides the request's shape. A
  // request borrows an ERC-20 (borrowing an NFT is a rental), and locks an
  // ERC-20, one ERC-721 token or a quantity of one ERC-1155 token; an
  // unread standard offers no request rather than a guessed one.
  const lendingStandard = useAssetStandard(ready ? pair.lending : null).data;
  const collateralStandard = useAssetStandard(ready ? pair.collateral : null).data;
  const requestPair: PostAssets | null =
    ready && lendingStandard === 'erc20' && collateralStandard !== null && collateralStandard !== undefined
      ? { lending: pair.lending!, collateral: pair.collateral!, standard: collateralStandard }
      : null;

  return (
    <main className="page borrow" aria-labelledby="borrow-title">
      <h1 id="borrow-title">{text('borrow.title')}</h1>
      <p className="tier-a">{text('borrow.intro')}</p>
      <WhyLink summaryKey="borrow.howSummary" detailKey="borrow.howWhy" />
      <StepNav label={text('borrow.stepsLabel')} steps={[text('borrow.stepPair'), text('borrow.stepOffer'), text('borrow.stepSign')]} current={step} />
      {!connected && <p className="tier-b">{text('borrow.connect')}</p>}
      {connected && walletChain === null && <p className="tier-b">{text('borrow.unsupported')}</p>}
      {termsUnknown && (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', {
            chain: walletChain!.name,
            reason: terms.error ?? 'no answer',
          })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {chain && connected && walletChain !== null && !flowOpen && (
        <PairPicker key={chain.chainId} role="borrower" chain={chain} meta={meta} lending={pair.lending} collateral={pair.collateral} onChange={setPair} />
      )}
      {chain && ready && !flowOpen && connected && walletChain !== null && (
        <section className="borrow-section borrow-ways" aria-labelledby="borrow-ways">
          <h2 id="borrow-ways">{text('borrow.waysTitle')}</h2>
          <div className="ways">
            <div className="way" data-way="now">
              <h3>{text('borrow.wayNow')}</h3>
              <p className="tier-b">{text('borrow.wayNowLead')}</p>
              <button type="button" className="btn btn-primary" onClick={() => document.getElementById('borrow-matches')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                {text('borrow.wayNowGo')}
              </button>
            </div>
            <div className="way request-open" data-way="own">
              <h3>{text('borrow.wayOwn')}</h3>
              <p className="tier-b">{text(requestPair === null || requestPair.standard === 'erc20' ? 'request.openLead' : 'request.openLeadNft')}</p>
              <StandingLenders diamond={diamond} lending={pair.lending!} collateral={pair.collateral!} meta={meta} account={address ?? null} />
              {armContext !== null && (
                <p className="tier-b" data-testid="request-held-for-tariff">
                  {format('request.heldForTariff', { id: armContext.offerId.toString() })}
                </p>
              )}
              <button
                type="button"
                className="btn"
                disabled={takeDisabled || requestPair === null || armContext !== null}
                onClick={() => setComposing(true)}
                data-testid="request-open"
              >
                {text('request.open')}
              </button>
            </div>
          </div>
        </section>
      )}
      {chain && ready && !flowOpen && connected && walletChain !== null && <MatchingOffers role="borrower" view={view} meta={meta} onTake={take} takeDisabled={takeDisabled} />}
      {composing === true && draft === null && armContext === null && !termsOpen && walletChain && own && requestPair && (
        <section className="borrow-section" aria-labelledby="borrow-request-form">
          <OfferForm
            side="borrower"
            flowKey={REQUEST_KEY}
            chain={walletChain}
            own={own}
            pair={requestPair}
            meta={meta}
            onReview={reviewRequest}
            onCancel={() => setComposing(null)}
            lead={(input) => (
              <StandingLenders
                diamond={diamond}
                lending={requestPair.lending}
                collateral={requestPair.collateral}
                meta={meta}
                account={address ?? null}
                request={lifecycleTerms(input)}
              />
            )}
          />
        </section>
      )}
      {termsOpen && termsGate.session && walletChain && own && (
        <TermsPrompt
          asker={text('borrow.asker')}
          gate={termsGate}
          session={termsGate.session}
          chain={walletChain}
          own={own}
          onAccepted={() => {
            termsGate.end();
            if (pendingTake !== null) setTaking(pendingTake);
            if (pendingDraft !== null) setDraft(pendingDraft);
            setPendingTake(null);
            setPendingDraft(null);
          }}
          onClose={() => {
            setPendingTake(null);
            setPendingDraft(null);
            termsGate.end();
          }}
        />
      )}
      {taking !== null && walletChain && own && (
        <section className="borrow-section" aria-labelledby="borrow-review">
          <h2 id="borrow-review" className="sr-only">
            {text('borrow.stepSign')}
          </h2>
          <AcceptOffer flowKey={ACCEPT_KEY} offerId={taking} chain={walletChain} own={own} meta={meta} terms={terms.data} onClose={() => setTaking(null)} />
        </section>
      )}
      {draft !== null && walletChain && own && (
        <section className="borrow-section" aria-labelledby="borrow-request-review">
          <h2 id="borrow-request-review" className="sr-only">
            {text('borrow.stepSign')}
          </h2>
          <PostOffer
            flowKey={REQUEST_KEY}
            draft={draft}
            chain={walletChain}
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
        </section>
      )}
      {armContext !== null && own && (
        <section className="borrow-section" aria-labelledby="arm-tariff-title">
          <ArmTariff side="borrower" flowKey={REQUEST_KEY} ctx={armContext} own={own} onDone={() => setArmContext(null)} />
        </section>
      )}
    </main>
  );
}
