import { useState } from 'react';
import { useSwitchChain } from 'wagmi';
import { useOwnStateClient } from '../../chain/ownRail';
import { useCopy } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { useStoredValue } from '../tx/txStore';
import { formatUtcDate } from '../ui/format';
import { listedForNotice, useOtherNetworksTerms, type OtherNetworkRow } from './otherNetworks';
import { CONNECT_TERMS_KEY } from './TermsAtConnect';
import { useTerms } from './useTerms';

/**
 * #3734 design section 7, "Another network": during the notice of a
 * material change, the other networks where the wallet is current, has not
 * accepted the change, and has something that would stop on its date (an
 * open offer, an active Auto-lend). They are walked one at a time: switch
 * to the network, where the acceptance is asked as on any network, then the
 * next. Each network's standing and announced status are read from that
 * network alone and shown apart. A step put off changes nothing before the
 * date; one whose network could not be read says so. Only reached once the
 * network the wallet is on is settled.
 */
export function OtherNetworksTerms() {
  const { text, format } = useCopy();
  const own = useOwnStateClient();
  const here = useTerms();
  const settledHere = own !== null && here.data !== null && here.data.kind !== 'needed';
  const rows = useOtherNetworksTerms(settledHere ? own.account : null, own?.chainId ?? null);
  const { switchChainAsync, isPending } = useSwitchChain();
  const [skipped, setSkipped] = useState<readonly number[]>([]);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [later, setLater] = useStoredValue<string>(`${CONNECT_TERMS_KEY}:networks-later`);

  const listed = rows.filter((r) => r.data !== null && listedForNotice(r.data));
  const failed = rows.filter((r) => r.state === 'failed');
  const key = own ? `${own.account.toLowerCase()}:${listed.map((r) => `${r.chain.chainId}@${r.data!.due!.effectiveAt}`).join(',')}` : null;
  if (!settledHere || listed.length === 0 || later === key) return null;
  const step = listed.find((r) => !skipped.includes(r.chain.chainId)) ?? null;

  const go = async (r: OtherNetworkRow) => {
    setSwitchError(null);
    try {
      await switchChainAsync({ chainId: r.chain.chainId });
    } catch (e) {
      setSwitchError(refusalFromError(e).reason);
    }
  };

  return (
    <section className="card terms-networks" data-testid="terms-networks" aria-labelledby="terms-networks-title">
      <h2 id="terms-networks-title">{text('termsNetworks.title')}</h2>
      <p className="tier-b">{text('termsNetworks.lead')}</p>
      <ol className="terms-networks-list">
        {listed.map((r) => {
          const n = r.data!;
          const due = n.due!;
          return (
            <li key={r.chain.chainId} data-testid="terms-network" data-chain={r.chain.chainId} data-current={step?.chain.chainId === r.chain.chainId ? 'yes' : 'no'}>
              <h3>{r.chain.name}</h3>
              <p className="tier-b">{text('termsNetworks.currentNow')}</p>
              <p className="tier-b">
                {due.newVersion
                  ? format('termsNetworks.notYetVersion', { version: String(due.version), date: formatUtcDate(due.effectiveAt) })
                  : format('termsNetworks.notYetMinimum', { version: String(due.minVersion), date: formatUtcDate(due.effectiveAt) })}
              </p>
              <p className="tier-b">{format('termsNetworks.stops', { offers: String(n.openOffers), autoLend: String(n.autoLend) })}</p>
              {!n.complete && <p className="tier-b">{text('termsNetworks.incomplete')}</p>}
              {step?.chain.chainId === r.chain.chainId && (
                <>
                  <p className="tier-b">{format('termsNetworks.fee', { chain: r.chain.name, gas: r.chain.nativeGasSymbol })}</p>
                  <p className="actions">
                    <button type="button" className="btn btn-primary" disabled={isPending} onClick={() => void go(r)} data-testid="terms-network-switch">
                      {format('termsNetworks.switch', { chain: r.chain.name })}
                    </button>
                    <button type="button" className="btn" onClick={() => setSkipped((s) => [...s, r.chain.chainId])} data-testid="terms-network-skip">
                      {text('termsNetworks.skip')}
                    </button>
                  </p>
                  {switchError !== null && <p className="tier-a">{format('termsNetworks.switchFailed', { reason: switchError })}</p>}
                </>
              )}
            </li>
          );
        })}
      </ol>
      {failed.map((r) => (
        <p key={r.chain.chainId} className="tier-b" data-testid="terms-network-failed">
          {format('termsNetworks.failed', { chain: r.chain.name, reason: refusalFromError(new Error(r.error ?? '')).reason })}{' '}
          <button type="button" className="btn" onClick={r.refetch}>
            {text('connectTerms.retry')}
          </button>
        </p>
      ))}
      <p className="tier-b">{text('termsNetworks.notChecked')}</p>
      <p className="actions">
        <button type="button" className="btn" onClick={() => setLater(key)} data-testid="terms-networks-later">
          {text('connectTerms.later')}
        </button>
      </p>
    </section>
  );
}
