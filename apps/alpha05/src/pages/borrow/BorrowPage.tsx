import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { loadLastPair, saveLastPair, suggestedAssets } from '../../shared/offers/assets';
import { useChainRead, useScreenChain } from '../../shared/reads/chainRead';
import { useTokenMeta } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';
import { Notice } from '../../shared/ui/Notice';
import { StepNav } from '../../shared/ui/StepNav';
import { AcceptOffer, ACCEPT_KEY } from './AcceptOffer';
import { MatchingOffers, type MatchesView } from './MatchingOffers';
import { PairPicker } from './PairPicker';
import { readMatches } from './matches';

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
 * one whole through the shared signing flow, behind the Terms gate. Posting
 * one's own borrow request, NFT collateral and the Advanced options follow
 * in the next updates; the page says so instead of hiding them.
 */
export function BorrowPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
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
  const lending = pair.lending ?? ('0x' as Hex);
  const collateral = pair.collateral ?? ('0x' as Hex);
  const ownMatches = useOwnRead(['borrow', 'matches', lending.toLowerCase(), collateral.toLowerCase()], (c) => readMatches(c, diamond, lending, collateral, own!.account), {
    enabled: ready && walletChain !== null,
  });
  const publicMatches = useChainRead(['borrow', 'matches', diamond, lending.toLowerCase(), collateral.toLowerCase()], (c) => readMatches(c, diamond, lending, collateral, null), {
    enabled: ready && !connected,
  });
  const view: MatchesView = connected ? ownMatches : publicMatches;

  const assets: Hex[] = [...suggested.map((s) => s.address), ...(pair.lending ? [pair.lending] : []), ...(pair.collateral ? [pair.collateral] : [])];
  const meta = useTokenMeta(assets).data;

  const flowOpen = taking !== null;
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

  const termsUnknown = connected && walletChain !== null && terms.state === 'failed';
  const takeDisabled = !connected || walletChain === null || terms.state !== 'ready' || termsOpen;

  const step = flowOpen ? 2 : ready ? 1 : 0;

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
      {chain && !flowOpen && <PairPicker key={chain.chainId} chain={chain} meta={meta} lending={pair.lending} collateral={pair.collateral} onChange={setPair} />}
      {chain && ready && !flowOpen && <MatchingOffers view={view} meta={meta} connected={connected && walletChain !== null} onTake={take} takeDisabled={takeDisabled} />}
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
            setPendingTake(null);
          }}
          onClose={() => {
            setPendingTake(null);
            termsGate.end();
          }}
        />
      )}
      {taking !== null && walletChain && own && (
        <section className="borrow-section" aria-labelledby="borrow-review">
          <h2 id="borrow-review" className="sr-only">
            {text('borrow.stepSign')}
          </h2>
          <AcceptOffer offerId={taking} chain={walletChain} own={own} meta={meta} terms={terms.data} onClose={() => setTaking(null)} />
        </section>
      )}
    </main>
  );
}
