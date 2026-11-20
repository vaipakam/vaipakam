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
import { getAccount, getPublicClient, readContract, waitForTransactionReceipt } from 'wagmi/actions';
import { hashTypedData, type TransactionReceipt } from 'viem';

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
 *  even when Safe marks it failed: it reached the chain, and whether the
 *  call inside it ran is read from the wallet's own execution log in that
 *  transaction (`accountExecution`), never from the outer receipt alone. */
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

/** `keccak256("ExecutionSuccess(bytes32,uint256)")`, the Safe's own event
 *  for a call that ran. */
export const SAFE_EXECUTION_SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e';
/** `keccak256("ExecutionFailure(bytes32,uint256)")`, the Safe's own event
 *  for a call that failed inside a transaction that still mined. */
export const SAFE_EXECUTION_FAILURE = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23';

/** A log as this module reads it. */
export interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

/**
 * What the wallet's own execution log in a mined transaction says about
 * its call `id`. A Safe's outer transaction can succeed while the call it
 * carries failed (a nonzero `safeTxGas` or gas price lets it), so the
 * outer receipt is not the call's result. `ran`: the wallet logged the call
 * as executed. `failed`: it logged the call as failed, so it changed
 * nothing. `unrecorded`: no execution log for this call from this wallet
 * is in the transaction, so whether the call ran is not known from it.
 * The id is read from the second topic where a wallet version indexes it,
 * else from the first data word.
 */
export function accountExecution(logs: readonly LogLike[], wallet: Hex, id: Hex): 'ran' | 'failed' | 'unrecorded' {
  const want = id.toLowerCase();
  for (const l of logs) {
    if (l.address.toLowerCase() !== wallet.toLowerCase()) continue;
    const t0 = l.topics[0]?.toLowerCase();
    if (t0 !== SAFE_EXECUTION_SUCCESS && t0 !== SAFE_EXECUTION_FAILURE) continue;
    const logged = (l.topics.length > 1 ? l.topics[1] : l.data.length >= 66 ? l.data.slice(0, 66) : '').toLowerCase();
    if (logged !== want) continue;
    return t0 === SAFE_EXECUTION_SUCCESS ? 'ran' : 'failed';
  }
  return 'unrecorded';
}

interface SafeSdkLike {
  txs: { getBySafeTxHash(id: string): Promise<SafeTxDetails> };
}

/** Whether the connected wallet is a Safe opened as a Safe App, whose sends
 *  return its own transaction ids rather than chain hashes. Read before the
 *  send, so the id is recorded by the wallet that sent it even when the
 *  connection changes while the prompt is open. */
export function sendsAccountTxIds(config: Config): boolean {
  return getAccount(config).connector?.id === 'safe';
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

/** The most queue pages one read follows before it stops and says so. */
export const QUEUE_PAGE_LIMIT = 10;

/** What one read of the wallet's queue found: the entries calling the
 *  target, and whether pages were left unread (the count is then a floor). */
export interface QueuedToRead {
  entries: QueuedToTarget[];
  partial: boolean;
}

/** The next page the gateway names, kept only while it stays on the gateway
 *  itself; anything else ends the walk (and the read is then partial). */
export function nextQueuePage(page: unknown): string | null | 'foreign' {
  const next = (page as { next?: unknown })?.next;
  if (next === null || next === undefined) return null;
  if (typeof next !== 'string') return 'foreign';
  try {
    return new URL(next).origin === new URL(SAFE_GATEWAY).origin ? next : 'foreign';
  } catch {
    return 'foreign';
  }
}

/** Reads the wallet's queue on `chainId` and keeps what calls `to`,
 *  following the gateway's pages up to `QUEUE_PAGE_LIMIT`. A walk that stops
 *  before the last page says it is partial rather than reporting a count it
 *  has not read. */
export async function readQueuedTo(chainId: number, safe: Hex, to: Hex, fetcher: typeof fetch = fetch): Promise<QueuedToRead> {
  let url: string = `${SAFE_GATEWAY}/v1/chains/${chainId}/safes/${safe}/transactions/queued`;
  const entries: QueuedToTarget[] = [];
  for (let pages = 0; pages < QUEUE_PAGE_LIMIT; pages++) {
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`queue read ${res.status}`);
    const page: unknown = await res.json();
    entries.push(...queuedTo(page, to));
    const next = nextQueuePage(page);
    if (next === null) return { entries, partial: false };
    if (next === 'foreign') return { entries, partial: true };
    url = next;
  }
  return { entries, partial: true };
}

/** A contract wallet ended a step before it reached the network. */
export class AccountTxEnded extends Error {
  readonly reason: 'cancelled' | 'failed';
  constructor(reason: 'cancelled' | 'failed') {
    super(reason === 'cancelled' ? 'The account wallet’s owners rejected this step, so it never ran.' : 'The account wallet ended this step before it reached the network, so it never ran.');
    this.name = 'AccountTxEnded';
    this.reason = reason;
  }
}

/** A step an account wallet sent whose progress this page cannot follow:
 *  the wallet that returned its id is no longer the connected one. Whether
 *  it ran is not known here, so callers state it as unverified. */
export class AccountTxUnfollowed extends Error {
  constructor() {
    super('This step was sent through an account wallet, and this page cannot follow it outside that wallet; open the app inside the wallet to follow it.');
    this.name = 'AccountTxUnfollowed';
  }
}

/** How a sent step's hash is to be read, recorded by the send before the
 *  wallet prompt opens: whether it is an account wallet's own transaction id,
 *  and the account that sent it. */
export interface SentKind {
  viaAccount: boolean;
  account: Hex | undefined;
}

const SENT_KINDS_KEPT = 256;
const sentKinds = new Map<string, SentKind>();

/** Record the kind of a step `sendWrite` sent. Only the latest few hundred
 *  are kept; a page follows its own recent steps. */
export function recordSentKind(hash: Hex, kind: SentKind): void {
  sentKinds.delete(hash.toLowerCase());
  sentKinds.set(hash.toLowerCase(), kind);
  while (sentKinds.size > SENT_KINDS_KEPT) {
    const oldest = sentKinds.keys().next().value;
    if (oldest === undefined) break;
    sentKinds.delete(oldest);
  }
}

/** The kind recorded for a sent step, if this page sent it. */
export function sentKindOf(hash: Hex): SentKind | undefined {
  return sentKinds.get(hash.toLowerCase());
}

/**
 * #3770 — the receipt of a step this app sent, whatever wallet sent it.
 * Every intermediate write (an approval, a reset, a protection step) waits
 * here, not on the bare hash: a Safe opened as a Safe App returns its own
 * transaction id, so the wait follows the wallet until it executes the step
 * and reads the receipt of the chain hash it ran under. A call the wallet
 * logged as failed inside a mined transaction is returned as `reverted`,
 * since it changed nothing; the callers read the state back either way.
 * Throws `AccountTxEnded` when the wallet ends the step unexecuted, and
 * `AccountTxUnfollowed` when an account wallet sent it but this page can no
 * longer follow that wallet. The kind is the one `sendWrite` recorded.
 */
export async function waitForSentReceipt(config: Config, hash: Hex, chainId: number): Promise<TransactionReceipt> {
  const sent = sentKindOf(hash);
  // The kind the send itself recorded decides how the hash is followed, not
  // the connection now: a wallet changed while the step was pending must not
  // turn a Safe's own id into a chain hash, or the reverse.
  const viaAccount = sent?.viaAccount ?? sendsAccountTxIds(config);
  if (!viaAccount) return waitForTransactionReceipt(config, { hash, chainId });
  const reader = await accountTxReader(config).catch(() => null);
  if (!reader) throw new AccountTxUnfollowed();
  const end = await awaitAccountTx(reader, hash, () => {}, () => {});
  if (end.kind === 'ended') throw new AccountTxEnded(end.reason);
  const receipt = await waitForTransactionReceipt(config, { hash: end.hash, chainId });
  const wallet = sent?.account ?? getAccount(config).address;
  if (receipt.status === 'success' && wallet && accountExecution(receipt.logs, wallet, hash) === 'failed') return { ...receipt, status: 'reverted' };
  return receipt;
}

// ─── #3770: a signature an account wallet has not finished approving ─────

/** EIP-1271's answer for a valid signature. */
export const ERC1271_MAGIC = '0x1626ba7e';

const ERC1271_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes4' }],
  },
] as const;

/** A Safe opened as a Safe App answers a signing request its other owners
 *  still have to approve with an empty signature (`0x`): a proposal, not a
 *  signature. */
export function isPendingSignature(signature: Hex): boolean {
  return signature.length <= 2;
}

/** The hash a Safe records a message under (its `SafeMessage` typed data
 *  over the message's own hash), which its service keys the message by. */
export function safeMessageHash(chainId: number, safe: Hex, hash: Hex): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    primaryType: 'SafeMessage',
    message: { message: hash },
  });
}

/** One read of a proposed signature: what to sign the step with, or not yet. */
export type AccountSignatureRead = { kind: 'valid'; signature: Hex } | { kind: 'pending' };

/** Reads the gateway's record of a proposed message: its combined signature
 *  once enough owners confirmed it, else pending. A shape it does not know
 *  throws rather than reading as pending. */
export function preparedSignature(body: unknown): AccountSignatureRead {
  const b = body as { status?: unknown; preparedSignature?: unknown } | null;
  if (b === null || typeof b !== 'object' || typeof b.status !== 'string') throw new Error('unrecognised message record');
  if (b.status === 'CONFIRMED' && typeof b.preparedSignature === 'string' && /^0x[0-9a-fA-F]+$/.test(b.preparedSignature)) return { kind: 'valid', signature: b.preparedSignature as Hex };
  return { kind: 'pending' };
}

/**
 * Waits until a proposed account-wallet signature is complete, and returns
 * what the step signs with: the combined signature the wallet's service
 * prepared once enough owners confirmed (an off-chain message), or `0x` once
 * the wallet itself answers that the hash is signed (an on-chain message,
 * which EIP-1271 checks with an empty signature). Each read is preceded by
 * `stillLive`, which throws when the wallet or network moved, so nothing is
 * signed for another identity. A read that fails does not end the wait.
 */
export async function awaitAccountSignature(
  reads: readonly (() => Promise<AccountSignatureRead>)[],
  stillLive: () => void,
  pause: () => Promise<void> = () => new Promise((r) => setTimeout(r, ACCOUNT_POLL_MS)),
): Promise<Hex> {
  for (;;) {
    stillLive();
    for (const read of reads) {
      try {
        const r = await read();
        if (r.kind === 'valid') return r.signature;
      } catch {
        // Unread this time: the wallet's approvals are what complete it.
      }
    }
    await pause();
  }
}

/** The signature a step signs with: `signature` itself, unless a Safe App
 *  answered with a proposal, in which case the wait above runs first. */
export async function settleAccountSignature(config: Config, chainId: number, account: Hex, hash: Hex, signature: Hex, stillLive: () => void): Promise<Hex> {
  const { connector } = getAccount(config);
  if (!isPendingSignature(signature) || !connector || connector.id !== 'safe') return signature;
  const onChain = async (): Promise<AccountSignatureRead> => {
    const answer = await readContract(config, { chainId, address: account, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hash, '0x'] });
    return answer.toLowerCase() === ERC1271_MAGIC ? { kind: 'valid', signature: '0x' } : { kind: 'pending' };
  };
  const offChain = async (): Promise<AccountSignatureRead> => {
    const res = await fetch(`${SAFE_GATEWAY}/v1/chains/${chainId}/messages/${safeMessageHash(chainId, account, hash)}`);
    if (res.status === 404) return { kind: 'pending' };
    if (!res.ok) throw new Error(`message read ${res.status}`);
    return preparedSignature(await res.json());
  };
  return awaitAccountSignature([onChain, offChain], stillLive);
}
