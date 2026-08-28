/**
 * Diamond access for app.
 *
 * The Vaipakam Diamond (EIP-2535) exposes every facet function at one
 * address per chain; `DIAMOND_ABI_VIEM` is the combined ABI from
 * @vaipakam/contracts. app keeps the call surface deliberately
 * explicit — a small set of named read/write helpers instead of a
 * dynamic proxy — so it is greppable which protocol calls the naive-
 * user app actually makes.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { usePublicClient, useWalletClient } from 'wagmi';
import type { TransactionReceipt } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { assertSettled } from './ownReceipt';
import { useActiveChain } from '../chain/useActiveChain';
import { publishReceiptInvalidation } from '../chain/receiptSync';
import { isExitWrite } from './tosWriteGate';
import { tosQueryKey, isVerdictStale, type TosVerdictData } from './tosGate';

export { DIAMOND_ABI_VIEM };

export interface DiamondWriteResult {
  hash: `0x${string}`;
  /** The mined receipt — for flows that need an id out of the logs
   *  (e.g. the offer id a createOffer minted). */
  receipt: TransactionReceipt;
}

/**
 * Write-side handle. `write` submits a Diamond call on the wallet's
 * active (supported) chain and resolves after the tx is MINED with
 * success status — callers can refresh reads immediately after.
 * Throws with the wallet/RPC error otherwise.
 */
/**
 * Would a non-exit Diamond write be refused right now (#1961, review
 * round 5 P2)?
 *
 * `useDiamondWrite` refuses at submission, which is the right place for
 * ENFORCEMENT and the wrong place to find out. A flow with a
 * prerequisite — `/vpfi`'s classic deposit mines an ERC-20 approval
 * first — would charge the user for that approval and only then reject
 * the deposit, leaving them out of pocket with a standing allowance and
 * nothing to show for it.
 *
 * So flows that spend gas before their Diamond call ask this first. It
 * is deliberately the same predicate the write path applies, read from
 * the same cache under the same key: a second, looser copy would tell
 * users they may proceed and then refuse them.
 */
/**
 * What the cached Terms verdict says about proceeding right now.
 *
 * `unknown` is separate from `blocked` on purpose (review round 6 P2).
 * Both stop a write — enforcement fails closed either way — but only
 * `blocked` means the wallet was ASKED and has not accepted. A cached
 * `accepted: true` whose refresh expired or failed is not a refusal; it
 * is an answer we could not re-confirm, and telling that user to accept
 * terms they already accepted is both false and unactionable.
 */
export type TermsWriteVerdict = 'ok' | 'unknown' | 'blocked';

/**
 * The one place the cached Terms verdict is interpreted.
 *
 * Three states, not two: an in-flight read is not a refusal. Both
 * `pending` and `blocked` stop a write — the gate fails closed either
 * way — but they are told to the user differently, because saying "you
 * need to accept the terms" to somebody whose read simply has not
 * landed accuses them of declining something they were never shown.
 */
export function readTermsWriteVerdict(
  queryClient: ReturnType<typeof useQueryClient>,
  chainId: number,
  address: string,
): TermsWriteVerdict {
  const key = tosQueryKey(chainId, address);
  const verdict = queryClient.getQueryData<TosVerdictData>(key);
  const state = queryClient.getQueryState(key);
  // Never read, still reading, read failed, or read too old to trust:
  // all of these are "we do not know", never "you declined".
  if (verdict === undefined || state === undefined) return 'unknown';
  if (state.status !== 'success') return 'unknown';
  if (isVerdictStale(state.dataUpdatedAt, Date.now())) return 'unknown';
  // Only a FRESH, SUCCESSFUL read may say the user has not accepted.
  return verdict.accepted ? 'ok' : 'blocked';
}

export function useTermsBlockNonExitWrites(): () => TermsWriteVerdict {
  // `readChain`, not `walletChain` (review round 9 P1). Two reasons,
  // and they are the same reason from either end:
  //
  //   - It is the key the verdict is actually STORED under.
  //     `useTosAcceptance` reads and caches on `readChain.chainId`, so
  //     looking it up by anything else asks for a row nothing writes.
  //     On a supported chain the two are equal, which is why the
  //     mismatch was invisible.
  //   - On an UNSUPPORTED chain `walletChain` is null while `address`
  //     is still set, and the old guard answered `ok` — unconditional
  //     permission, from the one state where nothing had been checked.
  //     That is not hypothetical: `AlertsCard` calls this on the exempt
  //     `/settings` route and scopes its enrolment to `readChain`, so a
  //     wallet on the wrong network could link Telegram and enable
  //     alerts against the default chain without accepting the Terms in
  //     force there. Nothing downstream would have caught it — neither
  //     the agent nor the indexer carries a Terms check.
  //
  // Reading `readChain` answers the question that was actually asked:
  // has this wallet accepted the Terms of the chain this action is
  // scoped to. `useDiamondWrite` below keys on `walletChain` and stays
  // correct because it refuses everything unless `onSupportedChain`,
  // where the two chains are the same one.
  const { readChain, address } = useActiveChain();
  const queryClient = useQueryClient();
  // A CALLBACK, not a rendered boolean. Two reasons, and the second is
  // the one that matters: `react-hooks/purity` rightly rejects reading
  // the clock during render, and the answer is only meaningful at the
  // moment the user acts — a verdict that was fresh when the page
  // painted can be three minutes old by the time they press the button.
  return useCallback(() => {
    // No wallet is not a permitted state, it is an absent one: every
    // caller separately requires an address before it does anything.
    if (!address) return 'ok';
    return readTermsWriteVerdict(queryClient, readChain.chainId, address);
  }, [readChain, address, queryClient]);
}

export function useDiamondWrite() {
  const { walletChain, onSupportedChain, address } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();

  const write = useCallback(
    async (
      functionName: string,
      args: readonly unknown[],
      /** `onSubmitted` fires the moment the transaction has a hash,
       *  BEFORE the receipt wait. A caller that unwinds on failure needs
       *  it to tell "never sent" from "sent, outcome unknown": the
       *  receipt wait can time out on a transaction that mined perfectly
       *  well, and undoing a side effect of a write that actually landed
       *  is worse than leaving it (#1529 review round 8). */
      opts?: { onSubmitted?: (hash: `0x${string}`) => void },
    ): Promise<DiamondWriteResult> => {
      if (!onSupportedChain || !walletChain || !walletClient || !address) {
        throw new Error(copy.errors.walletConnectFirst);
      }
      if (!publicClient) throw new Error(copy.errors.noRpcClient);
      // #1961 review round 2 P1 — the Terms gate ENFORCES here, not at
      // the route. Exempting a route exempts every control on it, and
      // `/vpfi` and `/positions/:loanId` carry deposits and a refinance
      // that originates a new loan alongside their exit controls.
      //
      // The verdict is read out of the query cache rather than through
      // `useTosAcceptance`, which imports this module — a direct call
      // would be a cycle. Both sides use `tosQueryKey`, so there is one
      // spelling of the key.
      //
      // Absent or stale cache is treated as NOT accepted, the same
      // fail-closed rule the gate uses: this must not become a bypass
      // for whoever loads the page and acts before the read lands.
      if (!isExitWrite(functionName, args)) {
        const termsVerdict = readTermsWriteVerdict(
          queryClient,
          walletChain.chainId,
          address,
        );
        // Review round 4 P1: STATUS as well as age. A failed background
        // refetch leaves TanStack holding the old `data` and
        // `dataUpdatedAt` while flipping status to 'error' — so the
        // route gate closed (it reads `isSuccess`) while this check,
        // looking only at age, kept permitting writes for the rest of
        // the 180s window. If the Terms changed just before that failed
        // refresh, the wallet could open a position without accepting
        // them. The two halves of one gate have to agree about what
        // counts as knowing.
        if (termsVerdict !== 'ok') {
          throw new Error(
            termsVerdict === 'unknown'
              ? copy.errors.termsCheckUnavailable
              : copy.errors.termsNotAccepted,
          );
        }
      }
      const hash = await walletClient.writeContract({
        address: walletChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName,
        args: args as unknown[],
        account: address,
        chain: walletClient.chain,
      });
      opts?.onSubmitted?.(hash);
      // Not just "did a transaction succeed" but "did OUR CALL run":
      // viem follows replacements, so a cancelled write resolves with the
      // replacement's successful receipt and would otherwise be reported
      // as a completed call (#1529 review round 11). This covers every
      // Diamond write in the app, `createOffer` among them — where
      // treating a cancel as success announced a refinance request that
      // does not exist and left its payoff approval standing.
      //
      // A Speed Up is NOT such a case: viem classifies it `repriced` only
      // when `to`, `value` and `input` all match, so it is this very call
      // at a higher gas price and it succeeds normally. What it does
      // change is the hash — so the receipt has to come back from the
      // wait rather than be re-fetched by the submitted hash, which for a
      // sped-up transaction has no receipt at all (#1529 review round 12).
      const receipt = await assertSettled(
        publicClient,
        hash,
        `The ${functionName} transaction`,
      );
      // RPC read-diet PR A (§4.1.4) — the centralized post-receipt
      // floor: every confirmed Diamond write dirties the standard
      // own-state set (here, in every other tab via broadcast, and
      // once more after ~2 block times for lagging public RPCs).
      // ADDITIVE: flows keep their surface-specific invalidations on
      // top of this — the floor is what no future flow can forget.
      publishReceiptInvalidation(queryClient);
      // The MINED hash, not the submitted one. On a Speed Up they differ,
      // and callers put this straight into an explorer link on the
      // success panel — the submitted hash never mined, so the link goes
      // nowhere (#1529 review round 13). Callers that need the SUBMITTED
      // hash for reconciliation (RefinanceFlow, deciding whether an offer
      // might exist after a failure) take it from `onSubmitted`, which is
      // exactly why that callback exists.
      return { hash: receipt.transactionHash, receipt };
    },
    [
      onSupportedChain,
      walletChain,
      walletClient,
      publicClient,
      address,
      queryClient,
    ],
  );

  return { write, ready: onSupportedChain && Boolean(walletClient) };
}
