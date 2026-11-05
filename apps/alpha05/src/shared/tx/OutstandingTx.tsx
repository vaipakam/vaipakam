import { Link } from 'react-router-dom';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { inFlight, useTxEntries } from './txStore';

/**
 * RB-CONFIDENCE — a transaction handed to the wallet is never out of sight:
 * while no page shows a flow that is still out (or whose receipt could not
 * be read), the shell says so on every page, names what was confirmed and on
 * which network and from which wallet, links the hash, and points back to
 * the page that owns it,
 * where the flow is shown in full and can be checked again.
 */
export function OutstandingTx() {
  const { text, format } = useCopy();
  const entries = useTxEntries();
  const unseen = entries.filter(([, e]) => e.shown === 0 && e.frozen !== null && (inFlight(e.phase) || e.phase.kind === 'receipt-unknown'));
  if (unseen.length === 0) return null;
  return (
    <div className="outstanding-tx" role="status">
      {unseen.map(([key, e]) => {
        const frozen = e.frozen!;
        const chain = getSupportedChain(frozen.chainId)?.name ?? String(frozen.chainId);
        const title = frozen.receipt?.title ?? key;
        const hash = 'hash' in e.phase ? e.phase.hash : null;
        return (
          <Notice key={key} tone="warn" tier="A">
            {format(e.phase.kind === 'receipt-unknown' ? 'shell.txUnknown' : 'shell.txOut', { title, chain, account: shortAddress(frozen.identity.split(':')[1] as `0x${string}`) })}{' '}
            {hash && (
              <a href={`${frozen.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
                {shortAddress(hash)}
              </a>
            )}{' '}
            <Link to={frozen.where}>{text('shell.txOpen')}</Link>
          </Notice>
        );
      })}
    </div>
  );
}
