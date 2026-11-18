import { useEffect, useId, useRef, useState } from 'react';
import type { Hex, PublicClient } from 'viem';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { guideUrl } from '../help/guide';
import { useChainRead, useScreenChain } from '../reads/chainRead';
import { KeyRiskList } from '../risk/KeyRiskList';
import { refusalFromError } from '../eligibility/refusal';
import { Notice } from '../ui/Notice';
import { LEGAL_ABI, PRIVACY_URL, fingerprint, termsUrl } from './terms';
import { noteTermsTicked } from './connectIntent';

/** The Terms in force on a network, read with no wallet: version 0 means
 *  none are in force there. */
async function readCurrentTos(client: PublicClient, diamond: Hex): Promise<{ version: number; hash: Hex }> {
  const [version, hash] = (await client.readContract({ address: diamond, abi: LEGAL_ABI, functionName: 'getCurrentTos' })) as readonly [number, Hex];
  return { version: Number(version), hash };
}

/**
 * #3734 — the Terms come before the wallet. Pressing Connect opens this step
 * instead of the wallet list: the Terms in force on the network the screen
 * describes (version, fingerprint, the address pinned to that version), the
 * privacy notice and the key risks, with a box to tick. The wallet list
 * opens only once the box is ticked. Where no Terms are in force the list
 * opens at once, since there is nothing to accept. A read that fails is
 * "cannot show the Terms", never "none in force", so no wallet is connected
 * on a guess.
 *
 * Ticking the box is not the acceptance: the wallet's signature is, asked
 * as soon as it connects (`connectIntent` carries what was ticked to that
 * step). The step never closes the wallet list itself; it hands over.
 */
export function ConnectTerms({ onChoose, onClose }: { onChoose: () => void; onClose: () => void }) {
  const { text, format } = useCopy();
  const { mode } = useMode();
  const chain = useScreenChain();
  const dialog = useRef<HTMLDialogElement>(null);
  const tickId = useId();
  // The pair the box was ticked for: a different version or text read while
  // the step is open leaves the box unticked, since that is not what is in force.
  const [tickedKey, setTickedKey] = useState<string | null>(null);
  const terms = useChainRead(['terms-current', chain.diamondAddress], (c) => readCurrentTos(c, chain.diamondAddress));
  const none = terms.state === 'ready' && terms.data?.version === 0;

  useEffect(() => {
    const el = dialog.current;
    if (el && typeof el.showModal === 'function' && !el.open) el.showModal();
  }, []);

  // Nothing to accept on this network: straight to the wallet list.
  useEffect(() => {
    if (!none) return;
    dialog.current?.close();
    onChoose();
  }, [none, onChoose]);

  const key = terms.data ? `${terms.data.version}:${terms.data.hash}` : null;
  const ticked = key !== null && tickedKey === key;

  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const choose = () => {
    if (!terms.data || terms.data.version === 0) return;
    noteTermsTicked({ chainId: chain.chainId, version: terms.data.version, hash: terms.data.hash });
    dialog.current?.close();
    onChoose();
  };

  return (
    <dialog ref={dialog} className="terms-prompt" aria-labelledby="connect-terms-title" data-testid="connect-terms" onCancel={() => onClose()}>
      <h2 id="connect-terms-title">{text('connectTerms.title')}</h2>
      {terms.state === 'reading' && (
        <p className="tier-b" role="status">
          {format('connectTerms.reading', { chain: chain.name })}
        </p>
      )}
      {terms.state === 'failed' && (
        <>
          <Notice tone="danger" tier="A">
            {format('connectTerms.failed', { chain: chain.name, reason: refusalFromError(new Error(terms.error ?? '')).reason })}
          </Notice>
          <p className="actions">
            <button type="button" className="btn" onClick={terms.refetch}>
              {text('connectTerms.retry')}
            </button>
          </p>
        </>
      )}
      {terms.data && terms.data.version > 0 && (
        <>
          <p className="tier-a" data-testid="connect-terms-lead">
            {format('connectTerms.lead', { chain: chain.name, version: String(terms.data.version) })}
          </p>
          <ul className="terms-links">
            <li>
              <a href={termsUrl(terms.data.version)} target="_blank" rel="noreferrer">
                {format('terms.read', { version: String(terms.data.version) })}
              </a>
            </li>
            <li>
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                {text('terms.privacy')}
              </a>
            </li>
            <li>
              <a href={guideUrl(mode, 'terms-gate')} target="_blank" rel="noreferrer">
                {text('connectTerms.guide')}
              </a>
            </li>
          </ul>
          <p className="tier-b">{text('terms.english')}</p>
          <p className="tier-b connect-terms-fingerprint" data-testid="connect-terms-fingerprint">
            {text('terms.rowFingerprint')}: {fingerprint(terms.data.hash)}
          </p>
          <h3>{text('keyRisks.title')}</h3>
          <p className="tier-b">{text('keyRisks.lead')}</p>
          <KeyRiskList testId="connect-terms-key-risks" />
          <p className="connect-terms-tick">
            <input id={tickId} type="checkbox" checked={ticked} onChange={(e) => setTickedKey(e.target.checked ? key : null)} data-testid="connect-terms-tick" />
            <label htmlFor={tickId}>{format('connectTerms.tick', { version: String(terms.data.version) })}</label>
          </p>
          <p className="tier-a">{text('connectTerms.next')}</p>
        </>
      )}
      <p className="actions">
        {terms.data && terms.data.version > 0 && (
          <button type="button" className="btn btn-primary" disabled={!ticked} onClick={choose} data-testid="connect-terms-choose">
            {text('connectTerms.choose')}
          </button>
        )}
        <button type="button" className="btn" onClick={close}>
          {text('connectTerms.cancel')}
        </button>
      </p>
    </dialog>
  );
}
