import { useEffect, useRef } from 'react';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { guideUrl } from '../help/guide';
import type { Receipt } from '../receipt/types';
import { simulateCall } from '../tx/simulate';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { formatUtc } from '../ui/format';
import { LEGAL_ABI, PRIVACY_URL, fingerprint, readTerms, termsUrl } from './terms';
import { inFlight } from '../tx/txStore';
import type { TermsGate, TermsSession } from './useTermsGate';

/**
 * ACC-15 — the Terms prompt, opened at the first value-creating action and
 * never at connect. It names the action that asked, the version in force on
 * the action's network, its fingerprint, the version's permanent address and
 * the privacy notice; accepting records that one version and fingerprint
 * against the wallet, once. Before the wallet opens the Terms are read
 * again: a newer version replaces the one shown, and an acceptance recorded
 * meanwhile (another tab) lets the action continue without a second one.
 * Declining costs nothing: no approval or other step runs before it.
 *
 * A view of the asking section's `TermsGate`: the session and its tracker
 * live there, so unmounting this prompt (a wallet or network switch) loses
 * nothing, and a review opened under one identity is never signed, or
 * continued, under another.
 */
export function TermsPrompt({
  asker,
  gate,
  session,
  chain,
  own,
  onAccepted,
  onClose,
}: {
  /** The action that asked, as a phrase ("Turning on the fee discount"). */
  asker: string;
  gate: TermsGate;
  session: TermsSession;
  chain: SupportedChain;
  own: OwnStateClient;
  onAccepted: () => void;
  onClose: () => void;
}) {
  const { text, format } = useCopy();
  const { mode } = useMode();
  const dialog = useRef<HTMLDialogElement>(null);
  const { tx } = gate;
  const reviewed = session.terms;
  const diamond = chain.diamondAddress;
  const identity = reviewIdentity(own);
  const moved = identity !== session.identity;

  // Shown as a modal whenever mounted; the review itself was opened by the
  // asking section, so a remount never starts a second one.
  useEffect(() => {
    const el = dialog.current;
    if (el && typeof el.showModal === 'function' && !el.open) el.showModal();
  }, []);

  const recheck = async (): Promise<Recheck> => {
    const fresh = (await own.read((c) => readTerms(c, diamond, own.account))).value;
    if (fresh.kind !== 'needed') {
      gate.update({ settled: true, readAt: Date.now() });
      return { kind: 'changed', what: text('terms.changedSettled') };
    }
    if (fresh.version !== reviewed.version || fresh.hash !== reviewed.hash) {
      gate.update({ terms: fresh, readAt: Date.now() });
      return { kind: 'changed', what: text('terms.changedVersion') };
    }
    gate.update({ readAt: Date.now() });
    return simulateCall(own, { address: diamond, abi: LEGAL_ABI, functionName: 'acceptTerms', args: [reviewed.version, reviewed.hash] });
  };

  const receipt: Receipt = {
    title: text('terms.receiptTitle'),
    rows: [
      { label: text('terms.rowVersion'), value: { kind: 'text', text: String(reviewed.version) }, binding: true },
      { label: text('terms.rowFingerprint'), value: { kind: 'text', text: fingerprint(reviewed.hash) }, binding: true },
      { label: text('terms.rowNetwork'), value: { kind: 'text', text: chain.name }, binding: true },
      { label: text('terms.rowFunds'), value: { kind: 'text', text: text('terms.funds') }, binding: false },
    ],
    consequences: [],
    prompts: 1,
    readAt: session.readAt,
  };

  const close = () => {
    dialog.current?.close();
    onClose();
  };

  const proceed = moved ? (
    <Notice tone="warn" tier="A">
      {text('flow.identityChanged')}
    </Notice>
  ) : (
    <button type="button" className="btn btn-primary" onClick={onAccepted}>
      {format('terms.continue', { asker })}
    </button>
  );

  return (
    <dialog
      ref={dialog}
      className="terms-prompt"
      aria-labelledby="terms-title"
      onCancel={(e) => {
        // Escape never closes while the wallet or the chain is still working.
        if (inFlight(tx.phase)) e.preventDefault();
        else onClose();
      }}
    >
      <h2 id="terms-title">{text('terms.title')}</h2>
      <p className="tier-a">{format('terms.asks', { asker, chain: chain.name, version: String(reviewed.version) })}</p>
      {reviewed.previous && (
        <p className="tier-b">{format('terms.newer', { previous: String(reviewed.previous.version), when: formatUtc(reviewed.previous.acceptedAt) })}</p>
      )}
      <ul className="terms-links">
        <li>
          <a href={termsUrl(reviewed.version)} target="_blank" rel="noreferrer">
            {format('terms.read', { version: String(reviewed.version) })}
          </a>
        </li>
        <li>
          <a href={guideUrl(mode, 'terms-gate')} target="_blank" rel="noreferrer">
            {text('terms.guide')}
          </a>
        </li>
        <li>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            {text('terms.privacy')}
          </a>
        </li>
      </ul>
      <p className="tier-b">{text('terms.english')}</p>
      {session.settled ? (
        <>
          <p className="actions">{proceed}</p>
          <p className="actions">
            <button type="button" className="btn" onClick={close}>
              {text('flow.close')}
            </button>
          </p>
        </>
      ) : (
        <ActionFlow
          tx={tx}
          identity={identity}
          reviewedFor={session.identity}
          receipt={receipt}
          recheck={recheck}
          describeAsset={() => null}
          explorer={chain.blockExplorer}
          next={null}
          after={(outcome) => (outcome.verdict === 'done' ? <p className="actions">{proceed}</p> : null)}
          onClose={close}
        />
      )}
    </dialog>
  );
}
