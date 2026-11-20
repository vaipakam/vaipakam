/**
 * #3246 part 2 — the recovery wallet's side of a recovery address request.
 * Opened from the link the owner's safety card made, in the wallet asked:
 * it names the account and the network, finds the account's vault from the
 * protocol's contract on that network, and signs `RecoveryProof` with the
 * wallet's next proof nonce there, only when the connected wallet IS the
 * address asked, on that network. Signing moves nothing and costs nothing;
 * the answer is a link back to the owner, who sends the request.
 */
import { useState } from 'react';
import type { Abi, PublicClient } from 'viem';
import { useAccount, useConfig } from 'wagmi';
import { signTypedDataFor } from '../tx/walletGuard';
import { VaultFactoryFacetABI } from '@vaipakam/contracts/abis';
import { getSupportedChain } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { FullAddress } from '../address/AddressEntry';
import { copyText } from '../address/AddressBook';
import { useCopy } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import { useOwnRead } from '../reads/useOwnRead';
import { formatUtc } from '../ui/format';
import { Notice } from '../ui/Notice';
import { RECOVERY_PROOF_LIFETIME_SECONDS, readProofNonce, recoveryAnswerLink, recoveryProofTypedData, type RecoveryProof, type RecoveryRequest } from './recovery';

type Hex = `0x${string}`;
const ZERO = /^0x0{40}$/i;

/** What the signature names, read at one block: the account's vault (null
 *  when it has none), the signer's next proof nonce there, and the block's
 *  time the expiry counts from. */
async function readSigning(c: PublicClient, diamond: Hex, r: RecoveryRequest) {
  const block = await c.getBlock({ blockTag: 'latest' });
  const vault = (await c.readContract({
    address: diamond,
    abi: VaultFactoryFacetABI as Abi,
    functionName: 'getUserVaultAddress',
    args: [r.account],
    blockNumber: block.number,
  })) as Hex;
  if (ZERO.test(vault)) return { vault: null, nonce: 0n, now: Number(block.timestamp) };
  return { vault, nonce: await readProofNonce(c, vault, r.recovery), now: Number(block.timestamp) };
}

export function SignRecovery({ request }: { request: RecoveryRequest | null }) {
  const { text, format } = useCopy();
  const config = useConfig();
  const { address, chainId, status } = useAccount();
  const own = useOwnStateClient();
  const [answer, setAnswer] = useState<RecoveryProof | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [copied, setCopied] = useState(false);
  const chain = request ? getSupportedChain(request.chainId) : null;
  const isThat = request !== null && status === 'connected' && address !== undefined && address.toLowerCase() === request.recovery.toLowerCase();
  const onChain = request !== null && chainId === request.chainId && own !== null;
  const diamond = (chain?.diamondAddress ?? '0x0000000000000000000000000000000000000000') as Hex;
  const facts = useOwnRead(['protection', 'recoverySign', diamond, request?.account, request?.recovery], (c) => readSigning(c, diamond, request!), {
    enabled: request !== null && chain !== null && isThat && onChain,
  });

  let body;
  if (request === null || chain === null) {
    body = (
      <Notice tone="danger" tier="A">
        {text('recovery.badLink')}
      </Notice>
    );
  } else if (!isThat) {
    body = (
      <Notice tone="warn" tier="A">
        {format('recovery.connectThat', { recovery: request.recovery })}
      </Notice>
    );
  } else if (!onChain) {
    body = (
      <Notice tone="warn" tier="A">
        {format('prove.wrongChain', { chain: chain.name })}
      </Notice>
    );
  } else if (answer !== null) {
    const link = recoveryAnswerLink(answer);
    body = (
      <>
        <h3>{text('recovery.answerTitle')}</h3>
        <p className="tier-b">{format('recovery.answerLead', { account: request.account, at: formatUtc(Number(answer.expiry)) })}</p>
        <textarea readOnly value={link} rows={4} aria-label={text('recovery.answerTitle')} data-testid="recovery-answer-link" onFocus={(e) => e.currentTarget.select()} />
        <p className="actions">
          <button type="button" className="btn" onClick={() => void copyText(link).then(setCopied)}>
            {text(copied ? 'book.copied' : 'book.copyLink')}
          </button>
        </p>
      </>
    );
  } else {
    const f = facts.data;
    const sign = async () => {
      if (!f || f.vault === null || !address) return;
      setSigning(true);
      setRefused(null);
      try {
        const base = { chainId: request.chainId, vault: f.vault, account: request.account, diamond, nonce: f.nonce, expiry: BigInt(f.now + RECOVERY_PROOF_LIFETIME_SECONDS) };
        const sig = await signTypedDataFor(config, request.chainId, { account: address, ...recoveryProofTypedData(base) });
        setAnswer({ ...base, recovery: request.recovery, sig });
      } catch (e) {
        setRefused(format('prove.refused', { reason: refusalFromError(e).reason }));
      } finally {
        setSigning(false);
      }
    };
    body =
      f === null || f === undefined ? (
        <p className={facts.state === 'failed' ? 'tier-a' : 'tier-b'}>
          {facts.state === 'failed' ? format('recovery.signUnread', { reason: facts.error ?? '' }) : text('recovery.signReading')}
        </p>
      ) : f.vault === null ? (
        <Notice tone="warn" tier="A">
          {format('recovery.noVault', { account: request.account, chain: chain.name })}
        </Notice>
      ) : (
        <>
          {refused !== null && (
            <Notice tone="danger" tier="A">
              {refused}
            </Notice>
          )}
          <p className="actions">
            <button type="button" className="btn btn-primary" disabled={signing} onClick={() => void sign()} data-testid="recovery-sign">
              {signing ? text('prove.signing') : text('recovery.sign')}
            </button>
          </p>
        </>
      );
  }
  return (
    <section className="home-section" aria-labelledby="recovery-sign-title" data-testid="recovery-sign-panel">
      <h2 id="recovery-sign-title">{text('recovery.signTitle')}</h2>
      {request !== null && chain !== null && (
        <>
          <p className="tier-a">{format('recovery.signLead', { account: request.account, recovery: request.recovery, chain: chain.name })}</p>
          <FullAddress address={request.account} testId="recovery-sign-account" />
          <p className="tier-b">{text('recovery.signFree')}</p>
        </>
      )}
      {body}
    </section>
  );
}
