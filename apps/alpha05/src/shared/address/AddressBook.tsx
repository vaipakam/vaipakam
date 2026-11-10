/**
 * #3415 — Saved addresses (RB-ADDRESS-GUARD): the reader's own list of
 * addresses a payout may be sent to, on this network, for this wallet. A
 * wallet joins only after it signs to prove the reader controls it (the
 * request travels as a link to the wallet that holds the address, and the
 * signed answer comes back as a code to paste). An exchange deposit
 * address, which cannot sign, joins unverified under the exchange's name,
 * after the reader acknowledges its three risks. Every address is shown in
 * full; a look-alike of one the reader already uses is refused.
 */
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { AddressEntry, entryReady, FullAddress } from './AddressEntry';
import { addPending, bookSnapshot, bookStored, dropPending, LABEL_MAX, removeEntry, saveEntry, subscribeBook, type AddressBook, type PendingProof } from './book';
import { classifyCandidate, type KnownAddresses } from './lookalike';
import { CHALLENGE_LIFETIME_S, decodeProof, encodeChallenge, newChallenge, verifyProof } from './proof';

type Hex = `0x${string}`;

/** The reader's saved book on this network, kept current across tabs. */
export function useAddressBook(chainId: number, account: Hex): AddressBook {
  return useSyncExternalStore(
    subscribeBook,
    () => bookSnapshot(chainId, account),
    () => bookSnapshot(chainId, account),
  );
}

/** The link that asks the wallet holding an address to sign. */
export function proveLink(p: PendingProof): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/protection?prove=${encodeChallenge(p.challenge)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface Props {
  chain: SupportedChain;
  own: OwnStateClient;
  /** Every address the reader already uses, the book's own included. */
  known: KnownAddresses;
}

export function AddressBookSection({ chain, own, known }: Props) {
  const { text, format } = useCopy();
  const book = useAddressBook(chain.chainId, own.account);
  const stored = bookStored(chain.chainId, own.account);
  return (
    <section className="home-section address-book" aria-labelledby="book-title" data-testid="address-book">
      <h2 id="book-title">{text('book.title')}</h2>
      <p className="tier-b">{text('book.lead')}</p>
      <p className="tier-b">{text('book.perBrowser')}</p>
      {!stored && (
        <Notice tone="warn" tier="A">
          {text('book.notStored')}
        </Notice>
      )}
      {book.entries.length === 0 ? (
        <p className="tier-b" data-testid="address-book-empty">
          {text('book.empty')}
        </p>
      ) : (
        <ul>
          {book.entries.map((e) => (
            <li key={e.address} data-testid="address-book-entry" data-kind={e.kind} data-address={e.address.toLowerCase()}>
              <p className="row-head">{e.label}</p>
              <FullAddress address={e.address} />
              <p className="tier-b">{e.kind === 'exchange' ? format('book.exchangeOf', { exchange: e.exchange ?? '' }) : text('book.kindWallet')}</p>
              {e.proof !== null && <p className="tier-b">{format('book.verifiedAt', { at: formatUtc(Math.floor(e.proof.at / 1000)) })}</p>}
              <p className="tier-b">{text('book.removeNote')}</p>
              <p className="actions">
                <button type="button" className="btn" onClick={() => removeEntry(chain.chainId, own.account, e.address)}>
                  {text('book.remove')}
                </button>
              </p>
            </li>
          ))}
        </ul>
      )}
      {book.pending.map((p) => (
        <PendingRow key={p.challenge.destination} chain={chain} own={own} pending={p} />
      ))}
      <AddAddress chain={chain} own={own} known={known} />
      <WhyLink summaryKey="address.whySummary" detailKey="address.why" />
    </section>
  );
}

function PendingRow({ chain, own, pending }: { chain: SupportedChain; own: OwnStateClient; pending: PendingProof }) {
  const { text, format } = useCopy();
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = proveLink(pending);
  const destination = pending.challenge.destination;
  const check = async () => {
    const proof = decodeProof(code);
    if (proof === null) {
      setNote(text('book.proofBadCode'));
      return;
    }
    setChecking(true);
    try {
      const verdict = await own.read((c) => verifyProof(c, proof, pending.challenge)).then((x) => x.value);
      if (verdict.ok) {
        saveEntry(chain.chainId, own.account, {
          address: destination,
          label: pending.label,
          kind: 'wallet',
          proof: { at: Date.now(), purpose: pending.challenge.purpose },
          exchange: null,
          savedAt: Date.now(),
        });
        return;
      }
      setNote(
        verdict.reason === 'mismatch'
          ? text('book.proofMismatch')
          : verdict.reason === 'expired'
            ? text('book.proofExpired')
            : format('book.proofBadSignature', { address: destination }),
      );
    } catch (e) {
      setNote(format('book.proofUnread', { reason: (e as Error).message }));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="home-section" data-testid="address-book-pending" data-address={destination.toLowerCase()}>
      <h3>{text('book.pendingTitle')}</h3>
      <p className="row-head">{pending.label}</p>
      <FullAddress address={destination} />
      <p className="tier-a">{format('book.pendingSteps', { address: destination, at: formatUtc(pending.challenge.issuedAt + CHALLENGE_LIFETIME_S) })}</p>
      <textarea readOnly value={link} rows={3} aria-label={text('book.copyLink')} data-testid="address-book-link" onFocus={(e) => e.currentTarget.select()} />
      <p className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void copyText(link).then(setCopied);
          }}
        >
          {copied ? text('book.copied') : text('book.copyLink')}
        </button>
      </p>
      <label htmlFor={`proof-${destination}`}>{text('book.pasteField')}</label>
      <textarea
        id={`proof-${destination}`}
        value={code}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setCode(e.target.value);
          setNote(null);
        }}
        data-testid="address-book-proof"
      />
      {note !== null && (
        <Notice tone="danger" tier="A">
          <span data-testid="address-book-proof-note">{note}</span>
        </Notice>
      )}
      <p className="actions">
        <button type="button" className="btn btn-primary" disabled={code.trim() === '' || checking} onClick={() => void check()} data-testid="address-book-check">
          {text('book.checkProof')}
        </button>
        <button type="button" className="btn" onClick={() => dropPending(chain.chainId, own.account, destination)}>
          {text('book.cancelRequest')}
        </button>
      </p>
    </div>
  );
}

function AddAddress({ chain, own, known }: Props) {
  const { text } = useCopy();
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [checked, setChecked] = useState(false);
  const [kind, setKind] = useState<'wallet' | 'exchange'>('wallet');
  const [exchange, setExchange] = useState('');
  const [ack, setAck] = useState(false);
  const candidate = classifyCandidate(value, known.list);
  const ready = entryReady(candidate, checked, known);
  // Your own wallet needs no entry, and one already saved needs no second.
  const usable = ready !== null && !(candidate.kind === 'known' && (candidate.entry.source === 'own' || candidate.entry.source === 'book'));
  const named = label.trim() !== '';
  const exchangeNamed = exchange.trim() !== '';
  const canSave = usable && named && (kind === 'wallet' || (exchangeNamed && ack));
  const reset = () => {
    setLabel('');
    setValue('');
    setChecked(false);
    setExchange('');
    setAck(false);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || ready === null) return;
    if (kind === 'wallet') {
      addPending(chain.chainId, own.account, {
        label: label.trim().slice(0, LABEL_MAX),
        challenge: newChallenge({ chainId: chain.chainId, diamond: chain.diamondAddress, account: own.account, destination: ready, purpose: 'destination' }),
      });
    } else {
      saveEntry(chain.chainId, own.account, {
        address: ready,
        label: label.trim().slice(0, LABEL_MAX),
        kind: 'exchange',
        proof: null,
        exchange: exchange.trim().slice(0, LABEL_MAX),
        savedAt: Date.now(),
      });
    }
    reset();
  };
  return (
    <form className="approval-add" onSubmit={onSubmit} data-testid="address-book-add">
      <h3>{text('book.addTitle')}</h3>
      <label htmlFor="book-label">{text('book.labelField')}</label>
      <input id="book-label" type="text" value={label} maxLength={LABEL_MAX} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
      <AddressEntry
        id="book-address"
        label={text('book.addressField')}
        value={value}
        onChange={setValue}
        known={known}
        checked={checked}
        onChecked={setChecked}
        testId="address-book-entry-input"
      />
      <fieldset className="keeper-actions">
        <legend>{text('book.kindField')}</legend>
        <label className="keeper-action">
          <input type="radio" name="book-kind" checked={kind === 'wallet'} onChange={() => setKind('wallet')} data-testid="address-book-kind-wallet" />
          <span>{text('book.kindWalletChoice')}</span>
        </label>
        <label className="keeper-action">
          <input type="radio" name="book-kind" checked={kind === 'exchange'} onChange={() => setKind('exchange')} data-testid="address-book-kind-exchange" />
          <span>{text('book.kindExchangeChoice')}</span>
        </label>
      </fieldset>
      {kind === 'exchange' && (
        <>
          <label htmlFor="book-exchange">{text('book.exchangeField')}</label>
          <input id="book-exchange" type="text" value={exchange} maxLength={LABEL_MAX} onChange={(e) => setExchange(e.target.value)} autoComplete="off" />
          <Notice tone="danger" tier="A">
            {text('book.exchangeLost')}
          </Notice>
          <Notice tone="warn" tier="A">
            {text('book.exchangeContract')}
          </Notice>
          <Notice tone="warn" tier="A">
            {text('book.exchangeReassign')}
          </Notice>
          <label className="address-check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="address-book-exchange-ack" />
            <span>{text('book.exchangeAck')}</span>
          </label>
        </>
      )}
      {!named && value.trim() !== '' && <p className="tier-b">{text('book.labelNeeded')}</p>}
      {kind === 'exchange' && !exchangeNamed && value.trim() !== '' && <p className="tier-b">{text('book.exchangeNeeded')}</p>}
      <p className="actions">
        <button type="submit" className="btn btn-primary" disabled={!canSave} data-testid="address-book-save">
          {text(kind === 'wallet' ? 'book.askProof' : 'book.exchangeSave')}
        </button>
      </p>
    </form>
  );
}
