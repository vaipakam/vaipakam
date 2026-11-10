/**
 * ACC-41 / #3415 — the nominee's side of a signer request. Opened from the
 * link the account's Protection page shows (`?signer=<account>&chain=<id>`),
 * in the wallet that was asked: it names the account in full and the
 * network, states what a signer can and cannot do, and offers to accept
 * only when the connected wallet is the one asked, on that network, while
 * the request is waiting. Accepting moves nothing; the account still makes
 * the wallet a signer only after its delay.
 */
import { getAddress, isAddress } from 'viem';
import { useAccount } from 'wagmi';
import { getSupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { FullAddress } from '../address/AddressEntry';
import { useCopy } from '../copy/useCopy';
import { useOwnRead } from '../reads/useOwnRead';
import { formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { useNow } from '../ui/useNow';
import { SIGNER_ACCEPT_KEY, SignerActionFlow, useSignerHeld } from './SignerAction';
import { nomineeState, readSignerFacts, signerClock } from './signers';

type Hex = `0x${string}`;

export function AcceptSigner({ accountParam, chainParam }: { accountParam: string; chainParam: string | null }) {
  const { text, format } = useCopy();
  const { chainId, status } = useAccount();
  const own = useOwnStateClient();
  const held = useSignerHeld(SIGNER_ACCEPT_KEY);
  const nowMs = useNow();
  const linkChain = chainParam !== null && /^\d+$/.test(chainParam) ? getSupportedChain(Number(chainParam)) : null;
  const account = isAddress(accountParam, { strict: false }) ? (getAddress(accountParam) as Hex) : null;
  const valid = account !== null && linkChain !== null;
  const onChain = valid && status === 'connected' && chainId === linkChain.chainId && own !== null;
  const diamond = (linkChain?.diamondAddress ?? '0x0000000000000000000000000000000000000000') as Hex;
  const facts = useOwnRead(['protection', 'signerAccept', diamond, account], (c) => readSignerFacts(c, diamond, account!), { enabled: onChain });

  let body;
  if (!valid) {
    body = (
      <Notice tone="danger" tier="A">
        {text('signer.badLink')}
      </Notice>
    );
  } else if (status !== 'connected' || own === null) {
    body = <p className="tier-b">{text('signer.acceptConnect')}</p>;
  } else if (!onChain) {
    body = (
      <Notice tone="warn" tier="A">
        {format('prove.wrongChain', { chain: linkChain.name })}
      </Notice>
    );
  } else if (held.choice !== null) {
    body = (
      <SignerActionFlow
        chain={linkChain}
        own={own}
        account={account}
        storeKey={SIGNER_ACCEPT_KEY}
        choice={held.choice}
        saved={null}
        onClose={() => {
          held.open(null);
          facts.refetch();
        }}
      />
    );
  } else {
    const f = facts.data;
    const me = own.account;
    const p = f?.pending?.find((x) => x.signer.toLowerCase() === me.toLowerCase()) ?? null;
    const isSigner = f?.signers?.some((s) => s.signer.toLowerCase() === me.toLowerCase()) ?? false;
    const m = f && f.mode !== null && f.mode !== 'absent' ? f.mode : null;
    const now = f ? signerClock(f, nowMs) : null;
    const s = p !== null && m !== null && now !== null ? nomineeState(p, m.delaySeconds, now) : null;
    body =
      f === null ? (
        <p className={facts.state === 'failed' ? 'tier-a' : 'tier-b'}>
          {facts.state === 'failed' ? format('signer.failed', { reason: facts.error ?? '' }) : text('signer.reading')}
        </p>
      ) : isSigner ? (
        <p className="tier-b" data-testid="signer-accept-done">
          {text('signer.youAreSigner')}
        </p>
      ) : f.pending === null ? (
        <p className="tier-a">{text('signer.pendingUnread')}</p>
      ) : p === null ? (
        <Notice tone="warn" tier="A">
          {format('signer.notAskedYou', { signer: me })}
        </Notice>
      ) : (
        <>
          {s === 'expired' && m !== null ? (
            <Notice tone="warn" tier="A">
              {format('signer.expired', { at: formatUtc(p.maturesAt + m.delaySeconds) })}
            </Notice>
          ) : p.accepted ? (
            <p className="tier-b" data-testid="signer-accept-done">
              {format('signer.acceptedWaits', { at: formatUtc(p.maturesAt) })}
            </p>
          ) : (
            <p className="actions">
              <button type="button" className="btn btn-primary" onClick={() => held.open({ action: 'accept', signer: me })} data-testid="signer-accept">
                {text('signer.acceptButton')}
              </button>
            </p>
          )}
        </>
      );
  }
  return (
    <section className="home-section" aria-labelledby="signer-accept-title" data-testid="signer-accept-panel">
      <h2 id="signer-accept-title">{text('signer.acceptTitle')}</h2>
      {valid && (
        <>
          <p className="tier-a">{format('signer.acceptLead', { chain: linkChain.name })}</p>
          <FullAddress address={account} testId="signer-accept-account" />
          <p className="tier-b">{text('signer.powers')}</p>
          <p className="tier-b">{text('signer.limits')}</p>
        </>
      )}
      {body}
    </section>
  );
}
