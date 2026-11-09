import { NavLink } from 'react-router-dom';
import { useCopy } from '../copy/useCopy';
import { PlaceIcon } from '../ui/Icon';
import { unreadOf } from './inbox';
import { useSeen } from './seen';
import { useInbox } from './useInbox';

/**
 * The header's way to Alerts (RB-INBOX): the bell beside its word, and the
 * count of alerts newer than the last ones the Alerts page showed in this
 * browser. Shown only while a wallet is connected on a served network and
 * the build reads an index. A count is drawn only from a successful read; a
 * failed one says so in the link's name instead of showing a zero.
 */
export function InboxBell() {
  const { text, format } = useCopy();
  const { chain, account, indexed, query } = useInbox();
  const seen = useSeen(chain?.chainId ?? null, account);
  if (chain === null || account === null || !indexed) return null;
  const first = query.data?.pages[0];
  const unread = first ? unreadOf(first, seen) : null;
  const count = unread && unread.count > 0 ? `${unread.count}${unread.more ? '+' : ''}` : null;
  const failed = query.status === 'error' && !first;
  const name = failed ? text('inbox.bellUnread') : count ? `${text('inbox.bell')}, ${format('inbox.bellNew', { count })}` : text('inbox.bell');
  return (
    <NavLink to="/alerts" className="inbox-bell" aria-label={name} title={name} data-testid="inbox-bell" data-unread={count ?? '0'}>
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
