/**
 * #3858 — the notice every screen shows while the read chain's deployment
 * record says the network is Closed. Facts only: nothing new opens there,
 * and the ways out stay available with no end date. Renders nothing on an
 * open network.
 */
import { DoorClosed } from 'lucide-react';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';

export function ClosedNetworkBanner() {
  const { readChain } = useActiveChain();
  if (!readChain.closed) return null;
  return (
    <div className="banner banner-info" role="status" data-closed-network-banner="">
      <DoorClosed aria-hidden />
      <div className="banner-body">{copy.closedNetwork.banner(readChain.name)}</div>
    </div>
  );
}
