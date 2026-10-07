/**
 * Sanctions-screening banner — renders ONLY when the connected wallet
 * is flagged by Vaipakam's sanctions screen — the configured on-chain
 * oracle, applied to the wallet and its declared recovery sender
 * (fail-open otherwise).
 * Per the retail-deploy policy this is the one place the full
 * three-line message appears; marketing surfaces never mention it.
 *
 * #2439 — the recourse depends on WHY the wallet is flagged: a test
 * network's own test list, the list it extends, the list the deployment
 * screens against, or the sender the wallet declared during token recovery —
 * and the last can hold alongside any of the others, in which case both are
 * said. Each has a different party to contact. What is already known (blocked
 * actions, close-outs that stay open) shows at once; only the recourse waits
 * for the attribution, rather than being guessed, and says so while it does.
 */
import { OctagonAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { copy } from '../content/copy';
import { useSanctionsCheck } from '../data/sanctions';
import { readSanctionsSource, type SanctionsSource } from '../data/sanctionsSource';
import { useActiveChain } from '../chain/useActiveChain';

/** How often a shown banner re-reads which list flagged the wallet. */
const ATTRIBUTION_REFRESH_MS = 30_000;

function useSanctionsSource(flagged: boolean): SanctionsSource[] | undefined {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data } = useQuery({
    queryKey: ['sanctionsSource', readChain.chainId, address?.toLowerCase()],
    enabled: flagged && Boolean(address) && Boolean(publicClient),
    // Attribution is live state, not configuration: the operator can clear
    // a test-list flag and a list's provider can delist a wallet while the
    // overall flag stays up. Re-read on a short cycle for as long as the banner
    // shows, so a stale answer cannot keep naming a list that has let go.
    staleTime: ATTRIBUTION_REFRESH_MS,
    refetchInterval: ATTRIBUTION_REFRESH_MS,
    queryFn: () => readSanctionsSource(publicClient!, readChain.diamondAddress, address!),
  });
  return data;
}

/** One line of the settled explanation — the only part of the banner that
 *  depends on why the wallet is flagged. A flag that comes from the declared
 *  recovery sender takes two lines: that the sender is the cause, then which
 *  list flags the sender and so whom to contact. */
export function recourseLine(source: SanctionsSource): string {
  switch (source) {
    case 'testList':
      return copy.sanctions.recourseTestList;
    case 'both':
      return copy.sanctions.recourseBoth;
    case 'testListUpstreamUnread':
      return copy.sanctions.recourseTestListUpstreamUnread;
    case 'otherList':
      return copy.sanctions.recourseOtherList;
    case 'bannedSource':
      return copy.sanctions.recourseBannedSource;
    case 'alsoBannedSource':
      return copy.sanctions.recourseAlsoBannedSource;
    case 'bannedSourceWalletUnread':
      return copy.sanctions.recourseBannedSourceWalletUnread;
    case 'senderTestList':
      return copy.sanctions.recourseSenderTestList;
    case 'senderBoth':
      return copy.sanctions.recourseSenderBoth;
    case 'senderTestListUpstreamUnread':
      return copy.sanctions.recourseSenderTestListUpstreamUnread;
    case 'senderOtherList':
      return copy.sanctions.recourseSenderOtherList;
    case 'bannedSourceUnread':
      return copy.sanctions.recourseBannedSourceUnread;
    case 'senderLookupUnread':
      return copy.sanctions.recourseSenderLookupUnread;
    case 'unknown':
      return copy.sanctions.recourseUnknown;
  }
}

export function SanctionsBanner() {
  const { flagged } = useSanctionsCheck();
  const reasons = useSanctionsSource(flagged);
  if (!flagged) return null;
  return (
    <div className="banner banner-danger" role="alert">
      <OctagonAlert aria-hidden />
      <div className="banner-body">
        <div className="banner-title">{copy.sanctions.title}</div>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line1}</p>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line2}</p>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line3}</p>
        {reasons === undefined ? (
          <p style={{ margin: '6px 0 0' }}>{copy.sanctions.recoursePending}</p>
        ) : (
          reasons.map((reason) => (
            <p key={reason} style={{ margin: '6px 0 0' }}>
              {recourseLine(reason)}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
