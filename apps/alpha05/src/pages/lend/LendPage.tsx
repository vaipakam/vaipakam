import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { AcceptOffer, LEND_ACCEPT_KEY } from '../../shared/accept/AcceptOffer';
import { storedSource } from '../../shared/accept/acceptSource';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { loadLastPair, saveLastPair, suggestedAssets } from '../../shared/offers/assets';
import { readMatches } from '../../shared/offers/matches';
import { MatchingOffers, type MatchesView } from '../../shared/offers/MatchingOffers';
import { PairPicker } from '../../shared/offers/PairPicker';
import { useScreenChain } from '../../shared/reads/chainRead';
import { useTokenMeta } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';
import { Notice } from '../../shared/ui/Notice';
import { StepNav } from '../../shared/ui/StepNav';
import { useAssetStandard } from '../../shared/nft/useStandard';
import { TakeNowChoice } from '../../shared/post/TakeNowChoice';
import { takeNowPicks } from '../../shared/post/takeNow';
import { LEND_OFFER_KEY, OfferForm } from '../../shared/post/OfferForm';
import { PostOffer } from '../../shared/post/PostOffer';
import { KitNotice, useIntegratorLines, useKitUse } from '../../shared/kit/KitNotice';
import { ReceiptAddendum } from '../../shared/receipt/addendum';
import { ArmTariff, tariffStoreKeys, type ArmContext } from '../../shared/post/ArmTariff';
import type { PostAssets } from '../../shared/post/postModel';
import type { PostDraft } from '../../shared/post/postReview';
import { indexerPositionFlowReader } from '../../shared/offers/positionFlow';
import { LendChoice } from '../../shared/autolend/LendChoice';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { AUTOLEND_KEY, AutoLendForm } from '../../shared/autolend/AutoLendForm';
import { lendConsentForm } from '../../shared/autolend/consentForm';
import { loadRemembered, rememberRuns, type LendPreset } from '../../shared/autolend/preset';
import { AutoLendSetup } from '../../shared/autolend/AutoLendSetup';
import { readLendChoice, type LendChoiceFacts } from '../../shared/autolend/lendChoice';
import type { AutoLendDraft, AutoLendInput } from '../../shared/autolend/autoLend';

type Hex = `0x${string}`;

const PAIR_STORE = 'alpha05.lend.pair';

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
 * Lend (rulebook §4: guided flows, review, finish). The guided path for a
 * lender: choose what to lend and what collateral to accept, see the
 * borrow requests open for that pair (read from the protocol through the
 * wallet), and fund one whole through the shared signing flow, behind the
 * Terms gate. When no request fits, the lender posts their own offer for
 * the pair instead (OFF-06), through the shared posting flow the Borrow
 * page's request uses, from the other side: the amount lent is what locks.
 * In Advanced the lender may lend in parts, choose a fill mode, an interest
 * schedule and the Full fee tariff, which is set by its own step here after
 * posting. #3624: one choice decides what the lender's own lend creates: a
 * one-time offer, or Auto-lend ("keep lending when repaid"), a funded
 * standing instruction a matching service fills and that lends repaid money
 * again (shared/autolend). A request that locks an NFT and an offer that
 * asks for one follow in later updates; the page says so instead of hiding
 * them.
 */
export function LendPage() {
  const { text, format } = useCopy();
  const { status, chainId, address } = useAccount();
  const connected = status === 'connected';
  const walletChain = getSupportedChain(chainId);
  const screenChain = useScreenChain();
  const chain = connected ? walletChain : screenChain;
  const own = useOwnStateClient();
  const terms = useTerms();
  const termsGate = useTermsGate(`${LEND_ACCEPT_KEY}.terms`, walletChain, own);
  /** The request under review, kept in the app's store with the review and
   *  its tracker, so a navigation away and back reopens the same flow. */
  const [taking, setTaking] = useStoredValue<bigint>(`${LEND_ACCEPT_KEY}:offer`);
  /** The request a Terms acceptance was asked for, taken once it is recorded. */
  const [pendingTake, setPendingTake] = useStoredValue<bigint>(`${LEND_ACCEPT_KEY}:pending`);
  /** The lender's own offer: the form is open (`composing`), and the
   *  confirmed draft under review, each kept like the request above. */
  const [composing, setComposing] = useStoredValue<boolean>(`${LEND_OFFER_KEY}:composing`);
  const [draft, setDraft] = useStoredValue<PostDraft>(`${LEND_OFFER_KEY}:draft`);
  const [pendingDraft, setPendingDraft] = useStoredValue<PostDraft>(`${LEND_OFFER_KEY}:pending`);
  /** #3622 B1: a confirmed draft that an open borrow request already fits,
   *  waiting on the reader's choice between funding that request and posting. */
  const [choice, setChoice] = useStoredValue<PostDraft>(`${LEND_OFFER_KEY}:choice`);
  const [, setTyped] = useStoredValue<unknown>(`${LEND_OFFER_KEY}:input`);
  /** OFF-22: the Full tariff step for an offer just posted, kept apart from
   *  the offer's review so it outlives that card. */
  const [armContext, setArmContext] = useStoredValue<ArmContext>(tariffStoreKeys(LEND_OFFER_KEY).ctx);
  /** #3624: how the lender's own lend runs (a one-time offer, or Auto-lend),
   *  and the Auto-lend form and its confirmed draft, kept like the offer's. */
  const [runs, setRuns] = useStoredValue<'once' | 'keep'>(`${AUTOLEND_KEY}:runs`);
  const [autoComposing, setAutoComposing] = useStoredValue<boolean>(`${AUTOLEND_KEY}:composing`);
  const [autoDraft, setAutoDraft] = useStoredValue<AutoLendDraft>(`${AUTOLEND_KEY}:draft`);
  const [pendingAuto, setPendingAuto] = useStoredValue<AutoLendDraft>(`${AUTOLEND_KEY}:pending`);
  const [, setAutoTyped] = useStoredValue<AutoLendInput>(`${AUTOLEND_KEY}:input`);
  const [, setAutoPreset] = useStoredValue<LendPreset>(`${AUTOLEND_KEY}:preset`);
  const [, setAutoConfirm] = useStoredValue<string>(`${AUTOLEND_KEY}:keeperConfirm`);
  /** #3761 — the form this deployment asks with, and the choice it opens on:
   *  the lender's last one on this device, else Auto-lend (pre-selected), or
   *  nothing in the "choose one" form. */
  const consentForm = lendConsentForm();
  const rememberedRuns = own && walletChain ? (loadRemembered(walletChain.chainId, own.account)?.runs ?? null) : null;
  const openingRuns = runs ?? rememberedRuns ?? (consentForm === 'choose' ? null : 'keep');
  const chooseRuns = (r: 'once' | 'keep') => {
    setRuns(r);
    if (own && walletChain) rememberRuns(walletChain.chainId, own.account, r);
  };

  const suggested = chain ? suggestedAssets(chain) : [];
  const [pairByChain, setPairByChain] = useState<Record<number, { lending: Hex | null; collateral: Hex | null }>>({});
  // #3773 — a kit link's "lend this" opens on its asset, on the link's own
  // network only.
  const kit = useKitUse('lend', walletChain, address ?? null);
  // A posting review states the integrator its own draft signs in, not the
  // current hand-off's, which another link may have replaced since.
  const draftKitLines = useIntegratorLines('lend', walletChain, draft?.integrator ?? null, address ?? null);
  const kitPair = (base: { lending: Hex | null; collateral: Hex | null }) => (kit.handoff?.request.action === 'lend' ? { ...base, lending: kit.handoff.request.asset } : base);
  const pair = chain ? (pairByChain[chain.chainId] ?? kitPair(initialPair(chain.chainId, suggested))) : { lending: null, collateral: null };
  const setPair = (next: { lending: Hex | null; collateral: Hex | null }) => {
    if (!chain) return;
    setPairByChain((p) => ({ ...p, [chain.chainId]: next }));
    if (next.lending && next.collateral && next.lending.toLowerCase() !== next.collateral.toLowerCase())
      saveLastPair(PAIR_STORE, chain.chainId, { lending: next.lending, collateral: next.collateral });
  };
  const ready = pair.lending !== null && pair.collateral !== null && pair.lending.toLowerCase() !== pair.collateral.toLowerCase();

  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const world = useWorldRail();
  // #3205 — the indexer's moved verdict for offers bound to a loan position.
  const flows = indexerPositionFlowReader(world.indexer, chain?.chainId ?? world.chainId);
  const lending = pair.lending ?? ('0x' as Hex);
  const collateral = pair.collateral ?? ('0x' as Hex);
  const ownMatches = useOwnRead(
    ['lend', 'matches', lending.toLowerCase(), collateral.toLowerCase()],
    (c) => readMatches(c, diamond, lending, collateral, own!.account, 'lender', flows),
    {
      enabled: ready && walletChain !== null,
    },
  );
  // Offers are read only once a wallet is connected on a served network
  // (owner decision 2026-11-09: no offer-book read before a wallet).
  const view: MatchesView = ownMatches;

  const assets: Hex[] = [...suggested.map((s) => s.address), ...(pair.lending ? [pair.lending] : []), ...(pair.collateral ? [pair.collateral] : [])];
  const meta = useTokenMeta(assets).data;

  const termsOpen = termsGate.session !== null;
  const autoOpen = autoComposing === true || autoDraft !== null;
  const offering = composing === true || draft !== null || choice !== null || autoOpen;
  const flowOpen = taking !== null || offering;
  // #3624: whether Auto-lend can run on this network and whether the wallet
  // already has one on this pair, read before the choice is offered.
  const lendChoice = useOwnRead<LendChoiceFacts>(
    ['lend', 'choice', lending.toLowerCase(), collateral.toLowerCase()],
    (c) => readLendChoice(c, diamond, own!.account, lending, collateral),
    { enabled: ready && walletChain !== null },
  );

  // OFF-35: funding a request is new exposure, so an unaccepted Terms
  // version is accepted first; the request is taken once that is recorded.
  const take = (id: bigint) => {
    if (terms.data?.kind === 'needed') {
      setPendingTake(id);
      termsGate.start(terms.data);
      return;
    }
    setTaking(id);
  };

  // OFF-35 holds for an offer too: it is new exposure, so an unaccepted
  // Terms version is accepted before its review opens.
  const reviewOffer = (typed: PostDraft) => {
    // #3773 — the integrator a kit link named and the reader kept is
    // recorded on the offer (attribution only on a lending offer).
    const next: PostDraft = kit.integrator !== null ? { ...typed, integrator: kit.integrator } : typed;
    if (terms.data?.kind === 'needed') {
      setPendingDraft(next);
      termsGate.start(terms.data);
      return;
    }
    openReview(next);
  };
  // #3622 B1: an open request that already fits the offer is offered first.
  const openReview = (next: PostDraft) => (takeNowPicks(next, view.data).length > 0 ? setChoice(next) : setDraft(next));

  const termsUnknown = connected && walletChain !== null && terms.state === 'failed';
  const takeDisabled = !connected || walletChain === null || terms.state !== 'ready' || termsOpen;
  // Auto-lend is new exposure too (OFF-35): Terms are accepted first.
  const reviewAuto = (next: AutoLendDraft) => {
    if (terms.data?.kind === 'needed') {
      setPendingAuto(next);
      termsGate.start(terms.data);
      return;
    }
    setAutoDraft(next);
  };
  const step = taking !== null || draft !== null || choice !== null || autoDraft !== null ? 2 : ready ? 1 : 0;
  // OFF-06: an offer lends an ERC-20 against ERC-20 collateral here; what
  // each leg's contract claims is read, and an unread standard offers no
  // offer rather than a guessed one.
  const lendingStandard = useAssetStandard(ready ? pair.lending : null).data;
  const collateralStandard = useAssetStandard(ready ? pair.collateral : null).data;
  const offerPair: PostAssets | null =
    ready && lendingStandard === 'erc20' && collateralStandard === 'erc20' ? { lending: pair.lending!, collateral: pair.collateral!, standard: 'erc20' } : null;

  return (
    <main className="page lend" aria-labelledby="lend-title">
      <h1 id="lend-title">{text('lend.title')}</h1>
      <p className="tier-a">{text('lend.intro')}</p>
      <WhyLink summaryKey="lend.howSummary" detailKey="lend.howWhy" />
      <StepNav label={text('lend.stepsLabel')} steps={[text('lend.stepPair'), text('lend.stepOffer'), text('lend.stepSign')]} current={step} />
      {!connected && <p className="tier-b">{text('lend.connect')}</p>}
      {connected && walletChain === null && <p className="tier-b">{text('lend.unsupported')}</p>}
      {termsUnknown && (
        <Notice tone="warn" tier="A">
          {format('consent.termsUnknown', { chain: walletChain!.name, reason: terms.error ?? 'no answer' })}{' '}
          <button type="button" className="btn" onClick={terms.refetch}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {!flowOpen && <KitNotice action="lend" chain={walletChain} />}
      {chain && connected && walletChain !== null && !flowOpen && (
        <PairPicker key={chain.chainId} role="lender" chain={chain} meta={meta} lending={pair.lending} collateral={pair.collateral} onChange={setPair} />
      )}
      {chain && ready && !flowOpen && connected && walletChain !== null && <MatchingOffers role="lender" view={view} meta={meta} onTake={take} takeDisabled={takeDisabled} />}
      {chain && ready && !flowOpen && connected && walletChain !== null && (
        <section className="borrow-section request-open" aria-labelledby="lend-offer-open">
          <h2 id="lend-offer-open" className="sr-only">
            {text('lend.postOpen')}
          </h2>
          <p className="tier-b">{text('lend.postLead')}</p>
          {armContext !== null && (
            <p className="tier-b" data-testid="lend-offer-held-for-tariff">
              {format('lendOffer.heldForTariff', { id: armContext.offerId.toString() })}
            </p>
          )}
          <LendChoice
            runs={openingRuns}
            form={consentForm}
            onRuns={chooseRuns}
            facts={lendChoice.data}
            failed={lendChoice.state === 'failed'}
            disabled={takeDisabled || offerPair === null || armContext !== null}
            onOpen={(chosen) => {
              chooseRuns(chosen);
              if (chosen === 'keep') setAutoComposing(true);
              else setComposing(true);
            }}
          />
        </section>
      )}
      {autoComposing === true && autoDraft === null && !termsOpen && walletChain && own && offerPair && (
        <section className="borrow-section" aria-labelledby="autolend-form-title">
          <AutoLendForm
            chain={walletChain}
            own={own}
            lending={offerPair.lending}
            collateral={offerPair.collateral}
            meta={meta}
            onReview={reviewAuto}
            onCancel={() => setAutoComposing(null)}
            onOneTime={() => {
              setAutoComposing(null);
              chooseRuns('once');
              setComposing(true);
            }}
          />
        </section>
      )}
      {autoDraft !== null && walletChain && own && (
        <section className="borrow-section" aria-labelledby="lend-autolend-review">
          <h2 id="lend-autolend-review" className="sr-only">
            {text('lend.stepSign')}
          </h2>
          <AutoLendSetup
            draft={autoDraft}
            chain={walletChain}
            own={own}
            meta={meta}
            terms={terms.data}
            onEdit={() => setAutoDraft(null)}
            onClose={(recorded) => {
              setAutoDraft(null);
              setAutoComposing(null);
              if (recorded) {
                setAutoTyped(null);
                setAutoPreset(null);
                setAutoConfirm(null);
                lendChoice.refetch();
              }
            }}
          />
        </section>
      )}
      {composing === true && draft === null && choice === null && !termsOpen && walletChain && own && offerPair && (
        <section className="borrow-section" aria-labelledby="lend-offer-form">
          <OfferForm side="lender" flowKey={LEND_OFFER_KEY} chain={walletChain} own={own} pair={offerPair} meta={meta} onReview={reviewOffer} onCancel={() => setComposing(null)} />
        </section>
      )}
      {termsOpen && termsGate.session && walletChain && own && (
        <TermsPrompt
          asker={text('lend.asker')}
          gate={termsGate}
          session={termsGate.session}
          chain={walletChain}
          own={own}
          onAccepted={() => {
            termsGate.end();
            if (pendingTake !== null) setTaking(pendingTake);
            if (pendingDraft !== null) openReview(pendingDraft);
            if (pendingAuto !== null) setAutoDraft(pendingAuto);
            setPendingTake(null);
            setPendingDraft(null);
            setPendingAuto(null);
          }}
          onClose={() => {
            setPendingTake(null);
            setPendingDraft(null);
            setPendingAuto(null);
            termsGate.end();
          }}
        />
      )}
      {choice !== null && draft === null && taking === null && (
        <section className="borrow-section">
          <TakeNowChoice
            side="lender"
            picks={takeNowPicks(choice, view.data)}
            stale={view.error !== null}
            matcher={view.data?.matcher ?? null}
            meta={meta}
            takeDisabled={takeDisabled}
            onTake={(id) => {
              setChoice(null);
              setComposing(null);
              take(id);
            }}
            onPost={() => {
              setDraft(choice);
              setChoice(null);
            }}
            onBack={() => setChoice(null)}
          />
        </section>
      )}
      {taking !== null && walletChain && own && (
        <section className="borrow-section" aria-labelledby="lend-review">
          <h2 id="lend-review" className="sr-only">
            {text('lend.stepSign')}
          </h2>
          <AcceptOffer flowKey={LEND_ACCEPT_KEY} source={storedSource(taking)} chain={walletChain} own={own} meta={meta} terms={terms.data} onClose={() => setTaking(null)} />
        </section>
      )}
      {draft !== null && walletChain && own && (
        <section className="borrow-section" aria-labelledby="lend-offer-review">
          <h2 id="lend-offer-review" className="sr-only">
            {text('lend.stepSign')}
          </h2>
          <ReceiptAddendum lines={draftKitLines}>
            <PostOffer
              flowKey={LEND_OFFER_KEY}
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
          </ReceiptAddendum>
        </section>
      )}
      {armContext !== null && own && (
        <section className="borrow-section" aria-labelledby="arm-tariff-title">
          <ArmTariff side="lender" flowKey={LEND_OFFER_KEY} ctx={armContext} own={own} onDone={() => setArmContext(null)} />
        </section>
      )}
    </main>
  );
}
