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
 * said. Each has a different party to contact. The flag and the reason are
 * one read at one block, so the banner never pairs a flag with a reason from
 * another moment.
 */
import { OctagonAlert } from 'lucide-react';
import { copy } from '../content/copy';
import { useSanctionsCheck } from '../data/sanctions';
import type { SanctionsSource } from '../data/sanctionsSource';

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
  // The flag and its explanation come from one read at one block, so they
  // arrive, refresh and clear together.
  const { flagged, reasons } = useSanctionsCheck();
  if (!flagged) return null;
  return (
    <div className="banner banner-danger" role="alert">
      <OctagonAlert aria-hidden />
      <div className="banner-body">
        <div className="banner-title">{copy.sanctions.title}</div>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line1}</p>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line2}</p>
        <p style={{ margin: '6px 0 0' }}>{copy.sanctions.line3}</p>
        {reasons.map((reason) => (
          <p key={reason} style={{ margin: '6px 0 0' }}>
            {recourseLine(reason)}
          </p>
        ))}
      </div>
    </div>
  );
}
