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
import { getAccount, getPublicClient } from 'wagmi/actions';

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

/**
 * What an address is on one network, from its code there. `key`: no code,
 * a plain key wallet. `delegated-key`: an EIP-7702 delegation (code
 * `0xef0100` + the delegate), still a key wallet: it signs with its key and
 * gets no contract-wallet handling. `contract`: any other code.
 */
export type WalletKind = 'key' | 'delegated-key' | 'contract';

export function walletKindFromCode(code: Hex | undefined): WalletKind {
  if (code === undefined || code === '0x') return 'key';
  if (code.toLowerCase().startsWith('0xef0100') && code.length === 2 + 2 * 23) return 'delegated-key';
  return 'contract';
}

/** Refused before a signed step: the account wallet has no contract on the
 *  network the step is for, so nothing it signs there can be checked or
 *  executed. */
export class AccountWithoutCode extends Error {
  readonly chainId: number;
  constructor(chainId: number) {
    super(`The account wallet has no contract on this network (chain ${chainId}), so nothing was signed or sent.`);
    this.name = 'AccountWithoutCode';
    this.chainId = chainId;
  }
}

/**
 * #3770 — before any signed step through a Safe opened as a Safe App:
 * confirms the wallet has contract code on the network in use, from that
 * network's own read, and throws `AccountWithoutCode` when it does not.
 * Any other wallet passes untouched (a key wallet, with or without a
 * delegation, is handled as a key wallet).
 */
export async function requireAccountCode(config: Config, chainId: number, account: Hex): Promise<void> {
  const { connector } = getAccount(config);
  if (!connector || connector.id !== 'safe') return;
  const client = getPublicClient(config, { chainId });
  if (!client) throw new AccountWithoutCode(chainId);
  if (walletKindFromCode(await client.getCode({ address: account })) !== 'contract') throw new AccountWithoutCode(chainId);
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

/** The Safe client gateway, the service Safe{Wallet} itself reads its queue
 *  from. The one off-chain source of the pending list; nothing it says is
 *  taken as done (completion is only ever a receipt on chain). */
export const SAFE_GATEWAY = 'https://safe-client.safe.global';

/** One transaction in the wallet's queue that calls `to`. */
export interface QueuedToTarget {
  id: string;
  confirmed: number | null;
  required: number | null;
}

/** The queue entries addressed to `to`, from the gateway's queued page.
 *  Throws on a shape it does not recognise rather than reading it as empty. */
export function queuedTo(page: unknown, to: Hex): QueuedToTarget[] {
  const results = (page as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error('unrecognised queue');
  const out: QueuedToTarget[] = [];
  for (const r of results as { type?: string; transaction?: Record<string, unknown> }[]) {
    if (r?.type !== 'TRANSACTION' || !r.transaction) continue;
    const t = r.transaction as { id?: unknown; txInfo?: { to?: { value?: unknown } }; executionInfo?: { confirmationsSubmitted?: unknown; confirmationsRequired?: unknown } };
    const target = t.txInfo?.to?.value;
    if (typeof target !== 'string' || target.toLowerCase() !== to.toLowerCase()) continue;
    out.push({
      id: typeof t.id === 'string' ? t.id : '',
      confirmed: typeof t.executionInfo?.confirmationsSubmitted === 'number' ? t.executionInfo.confirmationsSubmitted : null,
      required: typeof t.executionInfo?.confirmationsRequired === 'number' ? t.executionInfo.confirmationsRequired : null,
    });
  }
  return out;
}

/** Reads the wallet's queue on `chainId` and keeps what calls `to`. */
export async function readQueuedTo(chainId: number, safe: Hex, to: Hex, fetcher: typeof fetch = fetch): Promise<QueuedToTarget[]> {
  const res = await fetcher(`${SAFE_GATEWAY}/v1/chains/${chainId}/safes/${safe}/transactions/queued`);
  if (!res.ok) throw new Error(`queue read ${res.status}`);
  return queuedTo(await res.json(), to);
}
