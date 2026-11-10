/**
 * #3415 — the one address box for anything that receives funds or control
 * (RB-ADDRESS-GUARD). It shows the address in full with its first and last
 * digits set apart, refuses a look-alike of an address the reader already
 * uses (no override), refuses a broken checksum, and asks for an explicit
 * "I checked the full address" before a first-time address can be used.
 * The caller decides what may be done with the address `entryReady` returns.
 */
import type { ReactNode } from 'react';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { Notice } from '../ui/Notice';
import { addressParts, classifyCandidate, type AddressCandidate, type KnownAddress } from './lookalike';

type Hex = `0x${string}`;

/** The address an entry may be used as, or null while it may not: a known
 *  address at once, a new one only once the reader ticked the check. */
export function entryReady(c: AddressCandidate, checked: boolean): Hex | null {
  if (c.kind === 'known') return c.address;
  if (c.kind === 'new' && checked) return c.address;
  return null;
}

/** The address with the digits people compare set apart; never shortened. */
export function FullAddress({ address, testId }: { address: Hex; testId?: string }) {
  const p = addressParts(address);
  return (
    <code className="full-address" data-testid={testId}>
      <strong>{p.head}</strong>
      {p.middle}
      <strong>{p.tail}</strong>
    </code>
  );
}

interface Props {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (text: string) => void;
  known: readonly KnownAddress[];
  checked: boolean;
  onChecked: (checked: boolean) => void;
  testId: string;
}

export function AddressEntry({ id, label, value, onChange, known, checked, onChecked, testId }: Props) {
  const { text, format } = useCopy();
  const c = classifyCandidate(value, known);
  const knownLine = (k: KnownAddress) =>
    k.source === 'own' ? text('address.knownOwn') : k.label !== null ? format('address.knownSaved', { label: k.label }) : text('address.knownOther');
  const name = (k: KnownAddress) => (k.source === 'own' ? text('address.ownName') : (k.label ?? text('address.usedName')));
  return (
    <div className="address-entry" data-testid={testId} data-candidate={c.kind}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          onChecked(false);
        }}
        placeholder="0x…"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-invalid={c.kind === 'invalid' || c.kind === 'badChecksum' || c.kind === 'lookalike'}
      />
      <p className="tier-b">{text('address.inputHint')}</p>
      {c.kind === 'invalid' && value.trim().length >= 42 && (
        <p className="tier-b" role="status">
          {text('address.notAddress')}
        </p>
      )}
      {c.kind === 'badChecksum' && (
        <Notice tone="danger" tier="A">
          {text('address.badChecksum')}
        </Notice>
      )}
      {(c.kind === 'known' || c.kind === 'new' || c.kind === 'lookalike') && <FullAddress address={c.address} testId={`${testId}-full`} />}
      {c.kind === 'known' && <p className="tier-b">{knownLine(c.entry)}</p>}
      {c.kind === 'lookalike' && (
        <Notice tone="danger" tier="A">
          <span data-testid={`${testId}-lookalike`}>{format('address.lookalike', { name: name(c.of), address: c.of.address })}</span>
        </Notice>
      )}
      {c.kind === 'new' && (
        <>
          <Notice tone="warn" tier="A">
            {text('address.firstTime')}
          </Notice>
          <label className="address-check">
            <input type="checkbox" checked={checked} onChange={(e) => onChecked(e.target.checked)} data-testid={`${testId}-checked`} />
            <span>{text('address.checked')}</span>
          </label>
        </>
      )}
      {(c.kind === 'lookalike' || c.kind === 'new' || c.kind === 'badChecksum') && <WhyLink summaryKey="address.whySummary" detailKey="address.why" />}
    </div>
  );
}
