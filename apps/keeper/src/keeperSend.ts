/**
 * apps/keeper — the send shape shared by the keeper's previewed sends: the
 * close-out (`closeOut.ts`) and the internal-match liquidation
 * (`matchLiquidation.ts`).
 *
 * Both decide on a preview and then send one transaction whose outcome the
 * log must state truthfully. Two things make that possible, and they live
 * here once:
 *
 *  - {@link keeperTxPending} — the hold. A send from an earlier run may
 *    still be unmined; the loan then still reads the way it did, and a
 *    second send would queue behind the first only to revert once it
 *    lands. Nothing persists between runs, so the chain is asked.
 *  - {@link sendInSubmissionSlot} — prepared and signed, then broadcast
 *    separately, in the account's submission slot (#2486). A failure up to
 *    the signature means nothing was sent; a failure of the broadcast
 *    itself leaves the outcome unknown, because the RPC may have relayed
 *    the transaction and lost the answer. The hash is known from the
 *    signed bytes either way, so the log can name it.
 */

import { keccak256, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { isDefinitiveRejection, withSubmissionSlot } from './submissionQueue';

/** Null when the keeper has no unmined transaction; otherwise the reason
 *  to hold this send. */
export async function keeperTxPending(
  client: Pick<PublicClient, 'getTransactionCount'>,
  keeper: Address,
): Promise<string | null> {
  const [pendingNonce, minedNonce] = await Promise.all([
    client.getTransactionCount({ address: keeper, blockTag: 'pending' }),
    client.getTransactionCount({ address: keeper, blockTag: 'latest' }),
  ]);
  return pendingNonce > minedNonce
    ? `keeper-tx-pending (${pendingNonce - minedNonce} unmined)`
    : null;
}

/** What one broadcast came to. `unconfirmed`: the signed bytes went to the
 *  RPC and no answer came back, so it may be in the mempool or may never
 *  have arrived; the next run's {@link keeperTxPending} settles it. */
export type SendOutcome =
  | { kind: 'submitted'; tx: Hex }
  | { kind: 'unconfirmed'; tx: Hex; reason: string };

/**
 * Send `data` to `to` from the wallet's account, in that account's
 * submission slot on `chainId`. Throws when nothing was sent: a failure
 * before the signature, the subrequest budget's refusal (which comes before
 * any network call), or a node's coded refusal of the broadcast such as
 * insufficient funds, judged by the slot's own `isDefinitiveRejection`.
 * Any other broadcast failure may have been relayed, so its nonce stays
 * reserved and the outcome is `unconfirmed`.
 */
export async function sendInSubmissionSlot(
  wallet: WalletClient,
  chainId: number,
  to: Address,
  data: Hex,
): Promise<SendOutcome> {
  const account = wallet.account;
  if (!account) throw new Error('no keeper account');
  let tx: Hex | undefined;
  try {
    await withSubmissionSlot(wallet, chainId, account.address, async (nonce, signed) => {
      const request = await wallet.prepareTransactionRequest({
        account,
        to,
        data,
        nonce,
        chain: undefined,
      } as never);
      // `chain: null`: the client is chainless, and the chain id the request
      // was prepared with (read from the RPC) is the one signed over.
      const serialized = await wallet.signTransaction({ ...(request as object), chain: null } as never);
      tx = keccak256(serialized);
      signed();
      await wallet.sendRawTransaction({ serializedTransaction: serialized });
    });
  } catch (err) {
    // Failed before signing, or the node answered with a refusal (or the
    // subrequest budget refused before any network call): nothing was
    // relayed, and the slot has already released the nonce. Only a
    // broadcast nobody saw the answer to is unconfirmed.
    if (tx === undefined || isDefinitiveRejection(err)) throw err;
    return { kind: 'unconfirmed', tx, reason: describeFailure(err) };
  }
  return { kind: 'submitted', tx: tx! };
}
