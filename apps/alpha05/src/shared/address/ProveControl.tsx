/**
 * #3415 — the signing side of an address proof (RB-ADDRESS-GUARD). Opened
 * from the link a reader's Saved addresses made, in the wallet that holds
 * the address: it states what is signed (which account asks, which address
 * answers, on which network), refuses a damaged, lapsed or foreign request,
 * signs only when the connected wallet IS that address on that network, and
 * shows the signed answer as a code to paste back. Signing moves nothing.
 */
import { useState } from 'react';
import { useAccount, useConfig } from 'wagmi';
import { signTypedData } from 'wagmi/actions';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { useNow } from '../ui/useNow';
import { FullAddress } from './AddressEntry';
import { CHALLENGE_LIFETIME_S, controlTypedData, decodeChallenge, encodeProof } from './proof';

export function ProveControl({ code }: { code: string }) {
  const { text, format } = useCopy();
  const config = useConfig();
  const { address, chainId, status } = useAccount();
  const [answer, setAnswer] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [copied, setCopied] = useState(false);
  const nowMs = useNow();
  const c = decodeChallenge(code);
  const chain = c ? getSupportedChain(c.chainId) : null;
  // A request for a network or a Diamond this app does not serve is not one
  // this app made.
  const valid = c !== null && chain !== null && chain.diamondAddress.toLowerCase() === c.diamond.toLowerCase();
  const now = Math.floor(nowMs / 1000);

  let body;
  if (!valid || c === null || chain === null) {
    body = (
      <Notice tone="danger" tier="A">
        {text('prove.badLink')}
      </Notice>
    );
  } else if (now > c.issuedAt + CHALLENGE_LIFETIME_S) {
    body = (
      <Notice tone="warn" tier="A">
        {format('prove.expired', { at: formatUtc(c.issuedAt + CHALLENGE_LIFETIME_S) })}
      </Notice>
    );
  } else {
    const isThat = status === 'connected' && address !== undefined && address.toLowerCase() === c.destination.toLowerCase();
    const onChain = chainId === c.chainId;
    const sign = async () => {
      if (!address) return;
      setSigning(true);
      setRefused(null);
      try {
        const signature = await signTypedData(config, { account: address, ...controlTypedData(c) });
        setAnswer(encodeProof({ challenge: c, signature }));
      } catch (e) {
        setRefused(format('prove.refused', { reason: refusalFromError(e).reason }));
      } finally {
        setSigning(false);
      }
    };
    body = (
      <>
        <p className="tier-a">{format('prove.lead', { account: c.account, destination: c.destination, chain: chain.name })}</p>
        <FullAddress address={c.destination} testId="prove-destination" />
        {!isThat && (
          <Notice tone="warn" tier="A">
            {format('prove.connectThat', { destination: c.destination })}
          </Notice>
        )}
        {isThat && !onChain && (
          <Notice tone="warn" tier="A">
            {format('prove.wrongChain', { chain: chain.name })}
          </Notice>
        )}
        {refused !== null && (
          <Notice tone="danger" tier="A">
            {refused}
          </Notice>
        )}
        {answer === null ? (
          <p className="actions">
            <button type="button" className="btn btn-primary" disabled={!isThat || !onChain || signing} onClick={() => void sign()} data-testid="prove-sign">
              {signing ? text('prove.signing') : text('prove.sign')}
            </button>
          </p>
        ) : (
          <>
            <h3>{text('prove.codeTitle')}</h3>
            <p className="tier-b">{format('prove.codeLead', { account: c.account })}</p>
            <textarea readOnly value={answer} rows={4} aria-label={text('prove.codeTitle')} data-testid="prove-code" onFocus={(e) => e.currentTarget.select()} />
            <p className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  navigator.clipboard.writeText(answer).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? text('book.copied') : text('prove.copyCode')}
              </button>
            </p>
          </>
        )}
      </>
    );
  }
  return (
    <section className="home-section address-book" aria-labelledby="prove-title" data-testid="prove-control">
      <h2 id="prove-title">{text('prove.title')}</h2>
      {body}
    </section>
  );
}
