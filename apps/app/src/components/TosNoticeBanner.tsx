/**
 * #3734 — the notice a wallet that PASSED the Terms gate may still need.
 *
 * Two cases, decided by `tosNoticeOf` (pure, tested on its own):
 *  - A material change is announced: the version, the date it takes
 *    effect, what stops from then for a wallet that has not accepted it,
 *    and an Accept that keeps the wallet current with no gap. It can be
 *    put off until the last week before the date.
 *  - A small change made a newer version the latest: one quiet line with
 *    the link and an optional accept. Nobody has to accept it.
 *
 * Lives inside the lazily loaded `LegalGateActive`, so it adds nothing
 * to a disconnected first paint. A failed read shows nothing: the gate
 * itself fails closed, and a notice is never shown on a guess.
 */
import { useState } from 'react';
import { ExternalLink, FileText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import {
  noticeHiddenByLater,
  readLater,
  tosNoticeQueryKey,
  useTosNotice,
  writeLater,
} from '../contracts/useTosNotice';
import { formatDateTime } from '../lib/format';
import { useNowSec } from '../hooks/useNowSec';
import { termsUrlForVersion } from '../lib/legalUrls';
import { submitErrorText } from '../lib/errors';

export function TosNoticeBanner() {
  const { address, readChain, onSupportedChain } = useActiveChain();
  const notice = useTosNotice(Boolean(address));
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(null);
  // Read once per render from this browser; bumped to re-read on "later".
  const [, setLaterTick] = useState(0);
  const nowSec = useNowSec();

  if (!address) return null;

  if (acceptedVersion !== null) {
    return (
      <div className="banner banner-info" role="status">
        {copy.legalGate.accepted}
      </div>
    );
  }

  if (notice.kind === 'none') return null;
  if (noticeHiddenByLater(notice, readLater(readChain.chainId, address), nowSec)) return null;

  const accept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await write('acceptTerms', [notice.version, notice.hash]);
      setAcceptedVersion(notice.version);
      await queryClient.invalidateQueries({
        queryKey: tosNoticeQueryKey(readChain.chainId, address),
      });
    } catch (e) {
      setError(submitErrorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  const later = () => {
    writeLater(readChain.chainId, address, notice.version);
    setLaterTick((n) => n + 1);
  };

  const readLink = (
    <a
      href={termsUrlForVersion(notice.version)}
      target="_blank"
      rel="noreferrer"
      className="legal-gate-link"
    >
      <FileText size={14} aria-hidden="true" />
      {copy.legalGate.readVersion(notice.version)}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );

  if (notice.kind === 'small') {
    return (
      <div className="banner banner-info tos-notice tos-notice-small" role="status">
        <span>{copy.legalGate.smallLine(notice.version)}</span>
        <span className="tos-notice-actions">
          {readLink}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void accept()}
            disabled={submitting || !onSupportedChain}
          >
            {submitting ? copy.legalGate.signing : copy.legalGate.acceptOptional}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={later}>
            {copy.legalGate.later}
          </button>
        </span>
        {error ? (
          <div className="banner banner-danger" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="banner banner-warn tos-notice" role="status">
      <div className="banner-title">
        {copy.legalGate.materialTitle(notice.version, formatDateTime(notice.effectiveAt))}
      </div>
      <p className="banner-body">{copy.legalGate.materialBody}</p>
      <div className="tos-notice-actions">
        {readLink}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void accept()}
          disabled={submitting || !onSupportedChain}
        >
          {submitting ? copy.legalGate.signing : copy.legalGate.acceptVersion(notice.version)}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={later}>
          {copy.legalGate.later}
        </button>
      </div>
      {error ? (
        <div className="banner banner-danger" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
