/**
 * #3721 — the inbox's position-token approval rows, read for display.
 *
 * The indexer files one row per GRANT on the position token, addressed to the
 * token's owner (`position_approved` for one token, `position_approved_all`
 * for an operator over every token), with the token id and the address in its
 * data bag. This module turns that bag into the row's secondary line.
 */
import { copy } from '../content/copy';
import type { IndexedNotification } from './indexer';

/** #3721 — the secondary line of a position-token approval row, from its
 *  data bag: the token and the address it was approved to (or the operator
 *  over every token). The address is shown whole, since a look-alike
 *  shortened address is exactly what an owner checking it must not be
 *  shown. Null when the bag does not carry what the line names. */
export function approvalRefOf(row: IndexedNotification): string | null {
  const d = row.data;
  const addr = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null);
  if (row.kind === 'position_approved') {
    const tokenId = typeof d?.tokenId === 'string' && /^[0-9]+$/.test(d.tokenId) ? d.tokenId : null;
    const to = addr(d?.approved);
    return tokenId && to ? copy.notifications.approvalRef(tokenId, to) : null;
  }
  if (row.kind === 'position_approved_all') {
    const to = addr(d?.operator);
    return to ? copy.notifications.approvalAllRef(to) : null;
  }
  return null;
}
