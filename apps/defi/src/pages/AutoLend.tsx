import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wallet, Repeat } from 'lucide-react';
import type { Address } from 'viem';
import { useWallet } from '../context/WalletContext';
import AutoLendIntentCard from '../components/app/AutoLendIntentCard';
import { SanctionsBanner } from '../components/app/SanctionsBanner';
import {
  MyLenderIntentsCard,
  type ManageIntentPair,
} from '../components/app/MyLenderIntentsCard';
import { invalidateLenderIntentsCache } from '../hooks/useLenderIntentsByOwner';
import { useAutoLendFacetAvailable } from '../hooks/useAutoLendFacetAvailable';

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
  const { t } = useTranslation();
  const { address } = useWallet();
  const facetAvailable = useAutoLendFacetAvailable();

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

  // #886 Codex P3 — both child cards return null without a connected wallet, so
  // guard the whole page with the connect prompt (mirrors the Dashboard state
  // this surface was lifted from) instead of rendering a header over an empty
  // "create an intent below" body.
  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>{t('autoLend.connectTitle')}</h3>
        <p>{t('autoLend.connectBody')}</p>
      </div>
    );
  }

  // #886 Codex P3 — on a supported Diamond whose auto-lend/intent facets aren't
  // cut, both child cards self-hide and the list read returns empty, so the
  // "create an intent below" copy would point at nothing. When the facet probe
  // says the feature is DEFINITIVELY absent (not merely a transient/unknown
  // read — see {useAutoLendFacetAvailable}), show an explicit unavailable state
  // instead. `null` (unknown) falls through to the normal render, where the
  // card handles its own transient-retry state.
  if (facetAvailable === false) {
    return (
      <div style={{ padding: '1.5rem', maxWidth: 720 }}>
        <h1>Auto-lend</h1>
        <div className="empty-state" style={{ minHeight: '40vh' }}>
          <div className="empty-state-icon">
            <Repeat size={28} />
          </div>
          <h3>{t('autoLend.unavailableTitle')}</h3>
          <p>{t('autoLend.unavailableBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 720 }}>
      <h1>Auto-lend</h1>
      <p>
        Post a standing lender intent for an asset pair and let a delegated
        keeper fill matching borrower demand on your behalf — capital stays in
        your vault until a match lands. Create an intent below, and manage every
        pair you run from the list.
      </p>

      {/* #886 Codex P2 — the auto-lend write paths (setLenderIntent /
          fundLenderIntent / withdrawal) are sanctions-gated and revert for a
          flagged wallet. Surface the same pre-sign banner the Dashboard showed
          above these cards before they moved here. */}
      <SanctionsBanner
        address={address as `0x${string}`}
        label={t('banners.sanctionsLabelWallet')}
      />

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
