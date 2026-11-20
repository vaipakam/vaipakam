/**
 * #3770 / #3836 — a signature an account wallet has not finished approving.
 *
 * A Safe opened as a Safe App answers a message-signing request its other
 * owners still have to approve with an empty signature (`0x`): a proposal,
 * not a signature. What the request is finally signed with is one of two
 * things, and only the wallet's approvals decide which:
 *
 *   - the combined signature the Safe's service prepares once enough owners
 *     confirmed the message (an off-chain message), or
 *   - `0x` itself, once the Safe answers on chain that the message's hash is
 *     signed (an on-chain message, which EIP-1271 checks with an empty
 *     signature).
 *
 * This module holds the pure rule both apps use: how to recognise a
 * proposal, the hash the Safe's service keys the message by, how to read its
 * record, and the wait. Each app supplies its own reads (its RPC client, its
 * fetch), so nothing here holds a connection.
 */
import { hashTypedData, type Hex } from 'viem';

/** EIP-1271's answer for a valid signature. */
export const ERC1271_MAGIC = '0x1626ba7e';

/** The one EIP-1271 entry the on-chain read calls. */
export const ERC1271_ABI = [
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

/** The Safe client gateway, the service Safe{Wallet} itself reads from. */
export const SAFE_CLIENT_GATEWAY = 'https://safe-client.safe.global';

/** How long between two reads of the approvals. */
export const ACCOUNT_SIGNATURE_POLL_MS = 15_000;

/** True for a proposal: the empty signature a Safe App answers with while
 *  its other owners still have to approve. */
export function isPendingSignature(signature: string): boolean {
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

/** The gateway address of the Safe's record of a message. */
export function safeMessageUrl(chainId: number, safe: Hex, hash: Hex, gateway: string = SAFE_CLIENT_GATEWAY): string {
  return `${gateway}/v1/chains/${chainId}/messages/${safeMessageHash(chainId, safe, hash)}`;
}

/** One read of a proposed signature: what to sign with, or not yet. */
export type AccountSignatureRead = { kind: 'valid'; signature: Hex } | { kind: 'pending' };

/** Reads the gateway's record of a proposed message: its combined signature
 *  once enough owners confirmed it, else pending. A shape it does not know
 *  throws rather than reading as pending. */
export function preparedSignature(body: unknown): AccountSignatureRead {
  const b = body as { status?: unknown; preparedSignature?: unknown } | null;
  if (b === null || typeof b !== 'object' || typeof b.status !== 'string') throw new Error('unrecognised message record');
  if (b.status === 'CONFIRMED' && typeof b.preparedSignature === 'string' && /^0x[0-9a-fA-F]+$/.test(b.preparedSignature)) {
    return { kind: 'valid', signature: b.preparedSignature as Hex };
  }
  return { kind: 'pending' };
}

/** Reads the wallet's own EIP-1271 answer for `hash` with an empty
 *  signature: valid (`0x`) once it says the hash is signed on chain. */
export function onChainRead(isValidSignature: () => Promise<string>): () => Promise<AccountSignatureRead> {
  return async () => ((await isValidSignature()).toLowerCase() === ERC1271_MAGIC ? { kind: 'valid', signature: '0x' } : { kind: 'pending' });
}

/** Reads the gateway's record of the message (a 404 is not proposed yet). */
export function gatewayRead(
  fetchRecord: () => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>,
): () => Promise<AccountSignatureRead> {
  return async () => {
    const res = await fetchRecord();
    if (res.status === 404) return { kind: 'pending' };
    if (!res.ok) throw new Error(`message read ${res.status}`);
    return preparedSignature(await res.json());
  };
}

/**
 * Waits until a proposed account-wallet signature is complete, and returns
 * what the request signs with. Each round is preceded by `stillLive`, which
 * throws when the wallet or network moved (or the person gave up), and it is
 * asked again after a read that completes the signature, before it is
 * returned, so nothing is signed for another identity. A read that fails does not end the
 * wait: the wallet's approvals are what complete it.
 */
export async function awaitAccountSignature(
  reads: readonly (() => Promise<AccountSignatureRead>)[],
  stillLive: () => void,
  pause: () => Promise<void> = () => new Promise((r) => setTimeout(r, ACCOUNT_SIGNATURE_POLL_MS)),
): Promise<Hex> {
  for (;;) {
    stillLive();
    for (const read of reads) {
      let r: AccountSignatureRead | null = null;
      try {
        r = await read();
      } catch {
        // Unread this time.
      }
      if (r?.kind === 'valid') {
        // The wallet or network may have moved while the read was out:
        // check again before the signature is handed back, outside the
        // catch above, so a move is never read as an unread round.
        stillLive();
        return r.signature;
      }
    }
    await pause();
  }
}
