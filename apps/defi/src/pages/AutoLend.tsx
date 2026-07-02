import { useCallback, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useWallet } from '../context/WalletContext';
import AutoLendIntentCard from '../components/app/AutoLendIntentCard';
import {
  MyLenderIntentsCard,
  type ManageIntentPair,
} from '../components/app/MyLenderIntentsCard';
import { invalidateLenderIntentsCache } from '../hooks/useLenderIntentsByOwner';

/**
 * #878 — dedicated Auto-lend (standing intent) page.
 *
 * The auto-lend surface (create intent + the multi-intent "Your auto-lend
 * intents" list + Manage) was lifted off the landing Dashboard, which had grown
 * crowded since #755/#758 turned a single card into a full management surface.
 * The Dashboard now shows only a compact summary widget that links here.
 *
 * All on-chain writes still flow through the single audited
 * {@link AutoLendIntentCard} (#758) — this page only relocates + hosts it; there
 * is no new mutation path. The overview list's "Manage" deep-link retargets the
 * card and scrolls it into view, exactly as it did on the Dashboard (the link is
 * same-page, so it moved here unchanged).
 *
 * Both cards self-hide when they have nothing to show — the list when the wallet
 * has no intents, the create card when the intent/auto-lend facet set isn't cut
 * on the current chain — so on an unsupported chain this page renders just its
 * header + the "not available here" note.
 */
export default function AutoLend() {
  const { address } = useWallet();

  // The overview list's "Manage" button hands the pair up to the auto-lend card
  // below (which owns every write) and scrolls it into view. The nonce fires the
  // card's apply once per click, even when the same pair is re-selected.
  const [selectedIntentPair, setSelectedIntentPair] =
    useState<ManageIntentPair | null>(null);
  const [selectedIntentNonce, setSelectedIntentNonce] = useState(0);
  // Bumped after the card mutates an intent so the overview list refetches the
  // new state (its read cache has no timer-driven refresh).
  const [intentRefreshNonce, setIntentRefreshNonce] = useState(0);
  // True while the card has a tx in flight — disables the overview's "Manage"
  // deep-links so a mid-write click can't retarget the form away from the pair
  // being signed/awaited.
  const [autoLendBusy, setAutoLendBusy] = useState(false);
  const autoLendCardRef = useRef<HTMLDivElement | null>(null);

  const handleManageIntent = useCallback((pair: ManageIntentPair) => {
    setSelectedIntentPair(pair);
    setSelectedIntentNonce((n) => n + 1);
    autoLendCardRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);
  const handleIntentChanged = useCallback(() => {
    // Clear the module-level read cache (survives a remount, unlike the local
    // nonce) AND bump the nonce so the mounted overview refetches.
    invalidateLenderIntentsCache();
    setIntentRefreshNonce((n) => n + 1);
  }, []);
  // Stable so it doesn't churn the auto-lend card's busy-report effect.
  const handleAutoLendBusyChange = useCallback((busy: boolean) => {
    setAutoLendBusy(busy);
  }, []);

  return (
    <div style={{ padding: '1.5rem', maxWidth: 720 }}>
      <h1>Auto-lend</h1>
      <p>
        Post a standing lender intent for an asset pair and let a delegated
        keeper fill matching borrower demand on your behalf — capital stays in
        your vault until a match lands. Create an intent below, and manage every
        pair you run from the list.
      </p>

      {/* Overview of every standing intent the wallet owns across pairs (incl.
          paused ones), with a "Manage" deep-link into the auto-lend card below.
          Self-hides when there are no intents. */}
      <MyLenderIntentsCard
        owner={address as Address | null}
        onManage={handleManageIntent}
        refreshSignal={intentRefreshNonce}
        manageDisabled={autoLendBusy}
      />

      {/* #625 WI-1 — auto-lend, wired to the standing LenderIntent layer
          (register -> delegate keeper -> consent -> fund). Hidden when the
          intent/auto-lend facet set isn't cut on the current chain. */}
      <div ref={autoLendCardRef}>
        <AutoLendIntentCard
          selectedPair={selectedIntentPair}
          selectedPairNonce={selectedIntentNonce}
          onIntentChanged={handleIntentChanged}
          onBusyChange={handleAutoLendBusyChange}
        />
      </div>
    </div>
  );
}
