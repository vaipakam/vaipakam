/**
 * #3770 — a transaction sent by a contract wallet that is the account's
 * owner (a team or family account behind a multi-signature wallet).
 *
 * Inside Safe{Wallet}, a send returns the wallet's own transaction id, not
 * a chain hash: the transaction runs only once enough of the wallet's
 * owners approve, under a hash of its own. The tracker keeps the id, reads
 * the approvals from the wallet while it waits, and follows the chain hash
 * once the wallet executes it. The wallet decides who may approve what; the
 * app only reports where the transaction stands.
 *
 * The reader is the Safe connector's own provider (`sdk.txs.getBySafeTxHash`),
 * so nothing is read from a third party the wallet does not already use.
 */
import type { Config } from 'wagmi';
import { getAccount } from 'wagmi/actions';

type Hex = `0x${string}`;

/** Where a contract-wallet transaction stands. */
export type AccountTxStatus =
  /** Approvals are still being collected, or it waits to be executed.
   *  `confirmed` / `required` are null when the wallet does not say. */
  | { kind: 'awaiting'; confirmed: number | null; required: number | null }
  /** The wallet executed it; `hash` is the chain transaction. */
  | { kind: 'executed'; hash: Hex }
  /** It will never run: the approvers rejected it, or the wallet failed it
   *  before it reached the chain. */
  | { kind: 'ended'; reason: 'cancelled' | 'failed' };

/** Reads a contract-wallet transaction's status by its id. */
export interface AccountTxReader {
  status(id: Hex): Promise<AccountTxStatus>;
}

/** The fields of Safe's transaction details this module reads. */
export interface SafeTxDetails {
  txStatus?: string;
  txHash?: string | null;
  detailedExecutionInfo?: { type?: string; confirmationsRequired?: number; confirmations?: readonly unknown[] } | null;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Safe's details as a status. A transaction with a chain hash is executed
 *  even when Safe marks it failed: it reached the chain, and the receipt and
 *  the read-back say what it did. */
export function safeStatus(d: SafeTxDetails): AccountTxStatus {
  if (typeof d.txHash === 'string' && HASH.test(d.txHash)) return { kind: 'executed', hash: d.txHash as Hex };
  if (d.txStatus === 'CANCELLED') return { kind: 'ended', reason: 'cancelled' };
  if (d.txStatus === 'FAILED') return { kind: 'ended', reason: 'failed' };
  const info = d.detailedExecutionInfo;
  const multisig = info?.type === 'MULTISIG';
  return {
    kind: 'awaiting',
    confirmed: multisig && Array.isArray(info?.confirmations) ? info!.confirmations!.length : null,
    required: multisig && typeof info?.confirmationsRequired === 'number' ? info!.confirmationsRequired! : null,
  };
}

interface SafeSdkLike {
  txs: { getBySafeTxHash(id: string): Promise<SafeTxDetails> };
}

/** The reader for the connected wallet when it is a Safe opened as a Safe
 *  App; null for any other wallet, whose sends return chain hashes. */
export async function accountTxReader(config: Config): Promise<AccountTxReader | null> {
  const { connector } = getAccount(config);
  if (!connector || connector.id !== 'safe') return null;
  const provider = (await connector.getProvider()) as { sdk?: SafeSdkLike } | undefined;
  const sdk = provider?.sdk;
  if (!sdk || typeof sdk.txs?.getBySafeTxHash !== 'function') return null;
  return { status: async (id) => safeStatus(await sdk.txs.getBySafeTxHash(id)) };
}

/** How long between two reads of the approvals. */
export const ACCOUNT_POLL_MS = 15_000;

/**
 * Waits until the wallet executes `id` or ends it, reporting each read
 * while it waits. A read that fails does not end the wait: the wallet's
 * service is only a window onto the approvals, and the step completes when
 * the wallet executes it, so the wait reports the gap and reads again.
 */
export async function awaitAccountTx(
  reader: AccountTxReader,
  id: Hex,
  onAwaiting: (s: Extract<AccountTxStatus, { kind: 'awaiting' }>) => void,
  onUnread: (e: unknown) => void,
  pause: () => Promise<void> = () => new Promise((r) => setTimeout(r, ACCOUNT_POLL_MS)),
): Promise<Exclude<AccountTxStatus, { kind: 'awaiting' }>> {
  for (;;) {
    let s: AccountTxStatus;
    try {
      s = await reader.status(id);
    } catch (e) {
      onUnread(e);
      await pause();
      continue;
    }
    if (s.kind !== 'awaiting') return s;
    onAwaiting(s);
    await pause();
  }
}
