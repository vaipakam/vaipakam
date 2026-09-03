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
import { useLatestAttempt } from '../lib/useLatestAttempt';

export function CopyAddress({
  address,
  explorerBase,
}: {
  address: string;
  /** Block-explorer origin; omit to render the copy chip alone. */
  explorerBase?: string;
}) {
  // THE CONFIRMATION CARRIES THE ADDRESS IT IS ABOUT (#2044 round 2 P2), not
  // a bare `true`. Ordering settles which ATTEMPT may report; it says nothing
  // about which SUBJECT the report is for, and this chip is reused across rows
  // — the faucet's asset list re-renders the same instance with a new
  // `address` when the testnet changes. A bare boolean then made two false
  // claims: a write still in flight settled and flipped the chip for an
  // address whose value was never on the clipboard, and an already-visible
  // "Copied" outlived the address it was earned by until its timer expired.
  //
  // Keying the state on the address answers both WITHOUT a reset: a late
  // settlement stores the address its closure captured, which no longer
  // matches the rendered one, so the claim simply does not apply. Nothing has
  // to remember to clear it, which is the property a reset effect lacks.
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copied = copiedFor === address;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyAttempt = useLatestAttempt();
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
        aria-label={copy.copyAddress.copyAria(address)}
        onClick={async () => {
          // ORDERED (#2044). Two rapid clicks leave two writes in flight and
          // the last to settle wins regardless of which started last. Lower
          // stakes than the buttons #2043 fixed — the value is the same
          // address every time and a refusal is deliberately silent, so the
          // worst case is a confirmation appearing or clearing at the wrong
          // moment rather than a false claim. Fixed anyway because leaving
          // the last instance of a pattern behind is exactly how it kept
          // coming back: each round of #2043 fixed the site it was shown.
          const attempt = copyAttempt.begin();
          // CLEAR THE CONFIRMATION, NOT JUST THE TIMER (#2044 round 1 P2).
          // Cancelling the pending reset without also dropping `copied` left
          // the chip stuck: a successful copy followed within 1.5s by one
          // that FAILS took away the only thing that would ever have
          // un-flipped it, and the silent catch installs no replacement. The
          // chip then read "Copied" indefinitely over a failed attempt —
          // this fix introducing, in miniature, the false-success defect the
          // whole #2043/#2044 line of work is about.
          //
          // Resetting both at the start also makes the chip describe the
          // LATEST attempt rather than the best one so far, which is the
          // property the rest of this change is enforcing.
          if (timer.current) clearTimeout(timer.current);
          setCopiedFor(null);
          try {
            await navigator.clipboard.writeText(address);
            if (!attempt.isCurrent()) return;
            setCopiedFor(address);
            timer.current = setTimeout(() => setCopiedFor(null), 1500);
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
          aria-label={copy.copyAddress.viewAria(shortAddress(address))}
        >
          <ExternalLink size={14} aria-hidden />
        </a>
      ) : null}
    </span>
  );
}
