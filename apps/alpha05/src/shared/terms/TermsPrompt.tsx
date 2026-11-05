import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { guideUrl } from '../help/guide';
import type { Receipt } from '../receipt/types';
import { simulateCall } from '../tx/simulate';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { formatUtc } from '../ui/format';
import { LEGAL_ABI, PRIVACY_URL, fingerprint, readTerms, termsUrl, type TermsState } from './terms';

type Needed = Extract<TermsState, { kind: 'needed' }>;

const IN_FLIGHT = new Set(['signing', 'submitted', 'mined']);

/**
 * ACC-15 — the Terms prompt, opened at the first value-creating action and
 * never at connect. It names the action that asked, the version in force on
 * the action's network, its fingerprint, the version's permanent address and
 * the privacy notice; accepting records that one version and fingerprint
 * against the wallet, once. Before the wallet opens the Terms are read
 * again: a newer version replaces the one shown, and an acceptance recorded
 * meanwhile (another tab) lets the action continue without a second one.
 * Declining costs nothing: no approval or other step runs before it.
 */
export function TermsPrompt({
  asker,
  terms,
  chain,
  own,
  onAccepted,
  onClose,
}: {
  /** The action that asked, as a phrase ("Turning on the fee discount"). */
  asker: string;
  terms: Needed;
  chain: SupportedChain;
  own: OwnStateClient;
  onAccepted: () => void;
  onClose: () => void;
}) {
  const { text, format } = useCopy();
  const config = useConfig();
  const { mode } = useMode();
  const dialog = useRef<HTMLDialogElement>(null);
  const [reviewed, setReviewed] = useState<Needed>(terms);
  const [settled, setSettled] = useState(false);
  /** When the Terms shown were read: at opening, then at each re-check. */
  const [readAt, setReadAt] = useState(() => Date.now());
  /** The identity the prompt opened under; the caller renders it only while
   *  that identity holds, and a switch while it is open withholds signing. */
  const [reviewedFor] = useState(() => reviewIdentity(own));
  const diamond = chain.diamondAddress;

  const tx = useTrackedTx({
    chainId: chain.chainId,
    account: own.account,
    send: () =>
      writeContract(config, {
        address: diamond,
        abi: LEGAL_ABI,
        functionName: 'acceptTerms',
        args: [reviewed.version, reviewed.hash],
        chainId: chain.chainId,
        account: own.account,
      }),
    measure: async () => {
      const after = (await own.read((c) => readTerms(c, diamond, own.account))).value;
      const label = format('terms.legAccepted', { version: String(reviewed.version) });
      if (after.kind === 'accepted' && after.version === reviewed.version && after.hash === reviewed.hash) return [{ status: 'done', label }];
      return [{ status: 'not-done', label, reason: text('terms.legMissing') }];
    },
  });

  // Open as a modal at once, in review: the prompt IS the review.
  // The ref survives React's development double-run of mount effects, so the
  // review starts exactly once.
  const started = useRef(false);
  useEffect(() => {
    const el = dialog.current;
    if (el && typeof el.showModal === 'function' && !el.open) el.showModal();
    if (!started.current) {
      started.current = true;
      tx.review();
    }
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recheck = async (): Promise<Recheck> => {
    const fresh = (await own.read((c) => readTerms(c, diamond, own.account))).value;
    setReadAt(Date.now());
    if (fresh.kind !== 'needed') {
      setSettled(true);
      return { kind: 'changed', what: text('terms.changedSettled') };
    }
    if (fresh.version !== reviewed.version || fresh.hash !== reviewed.hash) {
      setReviewed(fresh);
      return { kind: 'changed', what: text('terms.changedVersion') };
    }
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
    readAt,
  };

  const close = () => {
    dialog.current?.close();
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="terms-prompt"
      aria-labelledby="terms-title"
      onCancel={(e) => {
        // Escape never closes while the wallet or the chain is still working.
        if (IN_FLIGHT.has(tx.phase.kind)) e.preventDefault();
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
      {settled ? (
        <p className="actions">
          <button type="button" className="btn btn-primary" onClick={onAccepted}>
            {format('terms.continue', { asker })}
          </button>
          <button type="button" className="btn" onClick={close}>
            {text('flow.close')}
          </button>
        </p>
      ) : (
        <ActionFlow
          tx={tx}
          identity={reviewIdentity(own)}
          reviewedFor={reviewedFor}
          receipt={receipt}
          recheck={recheck}
          describeAsset={() => null}
          explorer={chain.blockExplorer}
          next={null}
          after={(outcome) =>
            outcome.verdict === 'done' ? (
              <p className="actions">
                <button type="button" className="btn btn-primary" onClick={onAccepted}>
                  {format('terms.continue', { asker })}
                </button>
              </p>
            ) : null
          }
          onClose={close}
        />
      )}
    </dialog>
  );
}
