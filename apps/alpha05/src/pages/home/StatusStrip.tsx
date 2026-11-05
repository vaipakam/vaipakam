import type { ReactNode } from 'react';
import { useCopy } from '../../shared/copy/useCopy';
import { SWITCH_EFFECTS } from '../../shared/eligibility/switchClasses';
import { WhyLink } from '../../shared/help/WhyLink';
import { useScreenChain } from '../../shared/reads/chainRead';
import { usePosture } from '../../shared/reads/posture';
import { formatUtc } from '../../shared/ui/format';
import { Notice } from '../../shared/ui/Notice';
import { useNow } from '../../shared/ui/useNow';

/**
 * ACC-31's Home strip: the protocol's pause posture on the chain the screen
 * describes, stated in every case (running, paused, keeper service paused,
 * or not readable), never by silence. A pause, a keeper pause or an
 * unreadable status is URGENT and goes to the top of the page; a running
 * protocol is one quiet line at the bottom, so a newcomer meets the job
 * chooser before any protocol construct (ACC-05).
 *
 * Whether a paused Diamond has ever been launched is not readable from the
 * Diamond's views, so a pause is never called an incident nor "not yet
 * launched": it is stated as a pause, with what stays open.
 */
export function useStatusStrip(): { urgent: boolean; node: ReactNode } {
  const chain = useScreenChain();
  const { format } = useCopy();
  const posture = usePosture(chain.diamondAddress);
  const name = chain.name;
  const nowSec = Math.floor(useNow() / 1000);

  if (posture.state === 'reading') {
    return { urgent: false, node: <p className="tier-b home-status">{format('home.statusReading', { chain: name })}</p> };
  }
  // A re-read that failed after an earlier answer is treated as unread: a
  // pause that began since then would otherwise be shown as running.
  if (posture.state === 'failed' || !posture.data || posture.error !== null) {
    return {
      urgent: true,
      node: (
        <Notice tone="warn" tier="A">
          <WhyLink summaryKey="home.statusUnknown" detailKey="home.statusWhy" vars={{ chain: name, reason: posture.error ?? 'no answer' }} />
        </Notice>
      ),
    };
  }
  const p = posture.data;
  const lines: ReactNode[] = [];
  if (p.paused) {
    lines.push(
      <Notice key="paused" tone="danger" tier="A">
        <WhyLink summaryKey="home.statusPaused" detailKey="home.statusWhy" vars={{ chain: name, staysOpen: SWITCH_EFFECTS['2'].staysOpen }} />
        {p.pausedUntil > BigInt(nowSec) && <p className="tier-b">{format('home.statusPausedUntil', { when: formatUtc(Number(p.pausedUntil)) })}</p>}
      </Notice>,
    );
  }
  if (p.keepersPaused) {
    lines.push(
      <Notice key="keepers" tone="warn" tier="A">
        <WhyLink summaryKey="home.statusKeepers" detailKey="home.statusWhy" vars={{ chain: name, staysOpen: SWITCH_EFFECTS['4'].staysOpen }} />
      </Notice>,
    );
  }
  if (lines.length > 0) return { urgent: true, node: <div className="home-status">{lines}</div> };
  return {
    urgent: false,
    node: (
      <div className="home-status">
        <WhyLink summaryKey="home.statusRunning" detailKey="home.statusWhy" vars={{ chain: name }} />
      </div>
    ),
  };
}
