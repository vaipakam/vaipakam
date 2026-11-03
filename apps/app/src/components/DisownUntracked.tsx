/**
 * Disowning an untracked asset (#3096) — the contract's public "this is
 * not mine" record, offered beside adoption on the recovery page for
 * every asset kind.
 *
 * `disownUntracked` is EVENT-ONLY: nothing moves, nothing is credited,
 * and no declaration or signature is asked for, so this needs none of
 * the adoption flow's machinery (declared source, typed confirmation,
 * pending-attempt record). A repeated disowning only emits a second
 * record. What the card reports is read from the receipt's
 * `UntrackedDisowned` event (the amount the contract observed), never
 * assumed from the form.
 */
import { useState } from 'react';
import { parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { captureTxError } from '../lib/errors';
import { exactAmountString } from '../lib/format';
import type { AssetKind } from '../data/protectedAccount';

interface Props {
  kind: AssetKind;
  asset: `0x${string}`;
  tokenId: bigint;
  /** How the page names the asset (symbol, or collection and token id). */
  label: string;
  /** Display decimals for the observed amount (zero for an NFT). */
  decimals: number;
}

type DisownState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; observed: bigint | null }
  | { kind: 'failed'; message: string };

export function DisownUntracked({ kind, asset, tokenId, label, decimals }: Props) {
  const r = copy.recover;
  const { write, ready } = useDiamondWrite();
  const [state, setState] = useState<DisownState>({ kind: 'idle' });

  async function disown() {
    setState({ kind: 'busy' });
    try {
      const { receipt } = await write('disownUntracked', [kind, asset, tokenId]);
      // The amount the contract saw at that block, from its own event.
      const [event] = parseEventLogs({
        abi: DIAMOND_ABI_VIEM,
        eventName: 'UntrackedDisowned',
        logs: receipt.logs,
      });
      const observed = event?.args as { observedAmount?: unknown } | undefined;
      setState({
        kind: 'done',
        observed: typeof observed?.observedAmount === 'bigint' ? observed.observedAmount : null,
      });
    } catch (err) {
      setState({ kind: 'failed', message: captureTxError(err) });
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3 style={{ margin: 0 }}>{r.disownTitle}</h3>
      <p className="muted" style={{ margin: 0 }}>
        {r.disownBody}
      </p>
      {state.kind === 'done' ? (
        <p role="status" style={{ margin: 0 }}>
          {state.observed === null
            ? r.disownDoneUnread(label)
            : r.disownDone(exactAmountString(state.observed, decimals), label)}
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
      {state.kind === 'failed' ? (
        <p className="banner banner-danger" role="alert" style={{ margin: 0 }}>
          <span className="banner-body">
            {r.disownFailed} {state.message}
          </span>
        </p>
      ) : null}
    </div>
  );
}
