import { NavLink } from 'react-router-dom';
import { useCopy } from '../copy/useCopy';
import { PlaceIcon } from '../ui/Icon';
import { useSeen } from './seen';
import { useInbox, useInboxNewer } from './useInbox';

/**
 * The header's way to Alerts (RB-INBOX): the bell beside its word, and the
 * count of alerts the index wrote after the newest one this browser has
 * recorded as seen, counted by the index over every row. Shown only while a
 * wallet is connected on a served network and the build reads an index. A
 * count is drawn only from the latest read succeeding; when the latest read
 * failed, the link's name says the alerts could not be read and no count is
 * shown, even if an earlier count is in hand.
 */
export function InboxBell() {
  const { text, format } = useCopy();
  const { chain, account, indexed } = useInbox();
  const seen = useSeen(chain?.chainId ?? null, account);
  const newer = useInboxNewer(chain && account ? seen : null);
  if (chain === null || account === null || !indexed) return null;
  const failed = newer.status === 'error' || newer.isRefetchError;
  const n = !failed && newer.data ? newer.data : null;
  const count = n && n.count > 0 ? `${n.count}${n.capped ? '+' : ''}` : null;
  const name = failed ? text('inbox.bellUnread') : count ? `${text('inbox.bell')}, ${format('inbox.bellNew', { count })}` : text('inbox.bell');
  return (
    <NavLink to="/alerts" className="inbox-bell" aria-label={name} title={name} data-testid="inbox-bell" data-unread={count ?? '0'} data-failed={failed}>
      <PlaceIcon place="/alerts" />
      <span className="inbox-bell-word" aria-hidden="true">
        {text('inbox.bell')}
      </span>
      {count && (
        <span className="inbox-bell-count" aria-hidden="true" data-testid="inbox-bell-count">
          {count}
        </span>
      )}
    </NavLink>
  );
}
