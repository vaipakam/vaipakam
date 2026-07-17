/**
 * UX-042 — an address the user needs to take elsewhere gets two REAL
 * affordances: one tap copies the full address (with visible + SR
 * feedback), a second, separately-tappable target opens the explorer.
 * Replaces bare mono links whose only interaction was a ~16px glyph
 * squeezed against body text.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { copy } from '../content/copy';
import { shortAddress } from '../lib/format';

export function CopyAddress({
  address,
  explorerBase,
}: {
  address: string;
  /** Block-explorer origin; omit to render the copy chip alone. */
  explorerBase?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <span className="copy-address">
      <button
        type="button"
        className="copy-address-chip mono"
        aria-label={`Copy address ${address}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard permission denied — the chip just doesn't flip */
          }
        }}
      >
        {shortAddress(address)}
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        <span className="visually-hidden" role="status">
          {copied ? copy.copyAddress.copied : ''}
        </span>
      </button>
      {explorerBase ? (
        <a
          className="copy-address-link"
          href={`${explorerBase}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${shortAddress(address)} on the block explorer`}
        >
          <ExternalLink size={14} aria-hidden />
        </a>
      ) : null}
    </span>
  );
}
