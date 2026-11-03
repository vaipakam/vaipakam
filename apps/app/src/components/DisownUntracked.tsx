/**
 * Disowning an untracked asset (#3096) — the contract's public "this is
 * not mine" record, offered on the vault card beside the link to adopt.
 *
 * It lives on the vault card, not on the adoption page, because the
 * contract asks nothing of it that adoption needs: no sanctions oracle,
 * no wallet signature, no clean wallet (a banned vault may still disown).
 * The adoption page is gated on all three, so a control there would be
 * missing exactly where the contract deliberately allows it.
 *
 * `disownUntracked` is EVENT-ONLY: nothing moves, nothing is credited, and
 * a repeated disowning only emits a second record. What the card reports
 * is read from the receipt's `UntrackedDisowned` event. A transaction that
 * was sent but whose receipt could not be read is reported as unconfirmed,
 * with its link, never as failed: it may have mined or may still mine.
 * One the chain positively settled as not run (reverted, or cancelled or
 * replaced in the wallet) is reported as not taken, with the button back.
 * One that never returned a hash is not claimed as unsent either (a
 * wallet's reply can be lost after it sent); the card says it cannot show
 * it as recorded and where to look. A repeat only adds a second record.
 *
 * Which of those a thrown write was is decided by the app's one rule for
 * it, `settleFailedSend`, never re-derived here.
 */
import { useState } from 'react';
import { parseEventLogs, type Log } from 'viem';
import { usePublicClient } from 'wagmi';
import { copy } from '../content/copy';
import { getSupportedChain } from '../chain/chains';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { settleFailedSend } from '../contracts/ownReceipt';
import { captureTxError } from '../lib/errors';
import { exactAmountString } from '../lib/format';
import type { AssetKind } from '../data/protectedAccount';

interface Props {
  kind: AssetKind;
  asset: `0x${string}`;
  tokenId: bigint;
  /** How the card names the asset. */
  label: string;
  /** Display decimals for the observed amount (zero for an NFT). */
  decimals: number;
}

type DisownState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; observed: bigint | null }
  /** Sent, but its outcome could not be read. */
  | { kind: 'unconfirmed'; hash: `0x${string}` }
  /** Settled as not run: reverted, or cancelled or replaced in the wallet. */
  | { kind: 'notTaken'; message: string }
  /** No hash came back: refused, failed, or a reply that was lost. */
  | { kind: 'failed'; message: string };

/** The amount the contract saw at that block, from its own event. */
function observedFrom(logs: readonly Log[]): bigint | null {
  const [event] = parseEventLogs({
    abi: DIAMOND_ABI_VIEM,
    eventName: 'UntrackedDisowned',
    logs: [...logs],
  });
  const args = event?.args as { observedAmount?: unknown } | undefined;
  return typeof args?.observedAmount === 'bigint' ? args.observedAmount : null;
}

export function DisownUntracked({ kind, asset, tokenId, label, decimals }: Props) {
  const r = copy.depository;
  const { walletChain } = useActiveChain();
  const { write, ready } = useDiamondWrite();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const [state, setState] = useState<DisownState>({ kind: 'idle' });

  async function disown() {
    setState({ kind: 'busy' });
    // An object, not a `let`: a value assigned only inside a callback
    // reads as never-reassigned to TypeScript's narrowing below.
    const sent: { hash: `0x${string}` | null } = { hash: null };
    try {
      const { receipt } = await write('disownUntracked', [kind, asset, tokenId], {
        onSubmitted: (hash) => {
          sent.hash = hash;
        },
      });
      setState({ kind: 'done', observed: observedFrom(receipt.logs) });
    } catch (err) {
      // No hash: never claimed as sent or unsent. A hash: the shared rule
      // tells a settled not-run (reverted, cancelled, replaced) from a
      // send that mined after all, from one whose outcome is unknown.
      if (sent.hash === null || !publicClient) {
        setState(
          sent.hash === null
            ? { kind: 'failed', message: captureTxError(err) }
            : { kind: 'unconfirmed', hash: sent.hash },
        );
        return;
      }
      const mined = await settleFailedSend(publicClient, sent.hash, err);
      if ('logs' in mined) setState({ kind: 'done', observed: observedFrom(mined.logs) });
      else if ('failure' in mined) setState({ kind: 'notTaken', message: mined.failure });
      else setState({ kind: 'unconfirmed', hash: sent.hash });
    }
  }

  const explorer = walletChain ? getSupportedChain(walletChain.chainId)?.blockExplorer : undefined;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <strong>{r.disownTitle}</strong>
      <p className="muted" style={{ margin: 0 }}>
        {r.disownBody}
      </p>
      {state.kind === 'done' ? (
        <p role="status" style={{ margin: 0 }}>
          {state.observed === null
            ? r.disownDoneUnread(label)
            : r.disownDone(exactAmountString(state.observed, decimals), label)}
        </p>
      ) : state.kind === 'unconfirmed' ? (
        <p className="banner banner-warn" role="status" style={{ margin: 0 }}>
          <span className="banner-body">
            {r.disownUnconfirmed}{' '}
            {explorer !== undefined ? (
              <a href={`${explorer}/tx/${state.hash}`} target="_blank" rel="noreferrer noopener">
                {r.disownViewTx}
              </a>
            ) : null}
          </span>
        </p>
      ) : (
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!ready || state.kind === 'busy'}
            onClick={() => void disown()}
          >
            {state.kind === 'busy' ? r.disowning : r.disownButton}
          </button>
        </div>
      )}
      {state.kind === 'failed' || state.kind === 'notTaken' ? (
        <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>
          <span className="banner-body">
            {state.kind === 'failed' ? r.disownFailed : r.disownNotTaken} {state.message}
          </span>
        </p>
      ) : null}
    </div>
  );
}
