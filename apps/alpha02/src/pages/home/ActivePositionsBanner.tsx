/**
 * Home's "you have N active positions" nudge. Split into its own lazy
 * chunk (UX2-008): it is Home's ONLY contract-read dependency — it pulls
 * `useMyLoans` → `chainPositions` → the combined Diamond ABI. Keeping it
 * out of the eager Home chunk lets the marketing hero + job grid paint
 * without waiting on the ABI chunk; this banner (and its ABI need) loads
 * after, behind a `Suspense fallback={null}` boundary. A supplementary
 * nudge rendering a beat late is invisible; the trade buys a lighter
 * first paint on the landing route.
 */
import { Link } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import { useMyLoans } from '../../data/hooks';
import { useActiveChain } from '../../chain/useActiveChain';

export default function ActivePositionsBanner() {
  const { isConnected } = useActiveChain();
  const { data: loans } = useMyLoans();

  const activeCount = Array.isArray(loans)
    ? loans.filter((l) => l.status === 'active').length
    : 0;

  if (!isConnected || activeCount === 0) return null;

  return (
    <Link to="/positions" className="banner banner-info" style={{ display: 'flex' }}>
      <ListChecks aria-hidden />
      <span className="banner-body">
        You have {activeCount} active {activeCount === 1 ? 'position' : 'positions'}.
        View them under My positions.
      </span>
    </Link>
  );
}
