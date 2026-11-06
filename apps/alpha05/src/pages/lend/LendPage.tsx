import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { AcceptOffer, LEND_ACCEPT_KEY } from '../../shared/accept/AcceptOffer';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { loadLastPair, saveLastPair, suggestedAssets } from '../../shared/offers/assets';
import { readMatches } from '../../shared/offers/matches';
import { MatchingOffers, type MatchesView } from '../../shared/offers/MatchingOffers';
import { PairPicker } from '../../shared/offers/PairPicker';
import { useChainRead, useScreenChain } from '../../shared/reads/chainRead';
import { useTokenMeta } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';
import { Notice } from '../../shared/ui/Notice';
import { StepNav } from '../../shared/ui/StepNav';
import { currentAppHref, PAGES } from '../../routes/pageMap';

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
 * Terms gate. Posting one's own lending offer, a request that locks an NFT,
 * and the Advanced options follow in later updates; the page says so and
 * links to the current app instead of hiding them.
 */
export function LendPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
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

  const suggested = chain ? suggestedAssets(chain) : [];
  const [pairByChain, setPairByChain] = useState<Record<number, { lending: Hex | null; collateral: Hex | null }>>({});
  const pair = chain ? (pairByChain[chain.chainId] ?? initialPair(chain.chainId, suggested)) : { lending: null, collateral: null };
  const setPair = (next: { lending: Hex | null; collateral: Hex | null }) => {
    if (!chain) return;
    setPairByChain((p) => ({ ...p, [chain.chainId]: next }));
    if (next.lending && next.collateral && next.lending.toLowerCase() !== next.collateral.toLowerCase())
      saveLastPair(PAIR_STORE, chain.chainId, { lending: next.lending, collateral: next.collateral });
  };
  const ready = pair.lending !== null && pair.collateral !== null && pair.lending.toLowerCase() !== pair.collateral.toLowerCase();

  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const lending = pair.lending ?? ('0x' as Hex);
  const collateral = pair.collateral ?? ('0x' as Hex);
  const ownMatches = useOwnRead(['lend', 'matches', lending.toLowerCase(), collateral.toLowerCase()], (c) => readMatches(c, diamond, lending, collateral, own!.account, 'lender'), {
    enabled: ready && walletChain !== null,
  });
  const publicMatches = useChainRead(['lend', 'matches', diamond, lending.toLowerCase(), collateral.toLowerCase()], (c) => readMatches(c, diamond, lending, collateral, null, 'lender'), {
    enabled: ready && !connected,
  });
  const view: MatchesView = connected ? ownMatches : publicMatches;

  const assets: Hex[] = [...suggested.map((s) => s.address), ...(pair.lending ? [pair.lending] : []), ...(pair.collateral ? [pair.collateral] : [])];
  const meta = useTokenMeta(assets).data;

  const termsOpen = termsGate.session !== null;

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

  const termsUnknown = connected && walletChain !== null && terms.state === 'failed';
  const takeDisabled = !connected || walletChain === null || terms.state !== 'ready' || termsOpen;
  const step = taking !== null ? 2 : ready ? 1 : 0;
  // Posting one's own lending offer is not built here yet: the current
  // app's Lend page does it, and the page says so rather than hiding it.
  const lendPage = PAGES.find((p) => p.path === '/lend');
  const postHref = lendPage ? currentAppHref(lendPage, {}) : null;

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
      {chain && taking === null && <PairPicker key={chain.chainId} role="lender" chain={chain} meta={meta} lending={pair.lending} collateral={pair.collateral} onChange={setPair} />}
      {chain && ready && taking === null && (
        <MatchingOffers role="lender" view={view} meta={meta} connected={connected && walletChain !== null} onTake={take} takeDisabled={takeDisabled} />
      )}
      {chain && taking === null && (
        <section className="borrow-section lend-post-later" aria-labelledby="lend-post-later">
          <h2 id="lend-post-later" className="sr-only">
            {text('lend.postLaterLink')}
          </h2>
          <p className="tier-b">{text('lend.postLater')}</p>
          {postHref !== null && (
            <a className="btn" href={postHref} target="_blank" rel="noreferrer" data-testid="lend-post-current">
              {text('lend.postLaterLink')}
            </a>
          )}
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
            setPendingTake(null);
          }}
          onClose={() => {
            setPendingTake(null);
            termsGate.end();
          }}
        />
      )}
      {taking !== null && walletChain && own && (
        <section className="borrow-section" aria-labelledby="lend-review">
          <h2 id="lend-review" className="sr-only">
            {text('lend.stepSign')}
          </h2>
          <AcceptOffer flowKey={LEND_ACCEPT_KEY} offerId={taking} chain={walletChain} own={own} meta={meta} terms={terms.data} onClose={() => setTaking(null)} />
        </section>
      )}
    </main>
  );
}
