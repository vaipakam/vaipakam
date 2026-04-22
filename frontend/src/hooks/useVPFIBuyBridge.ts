import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Contract,
  JsonRpcProvider,
  ZeroAddress,
  type EventLog,
  type Log,
} from 'ethers';
import { useWallet } from '../context/WalletContext';
import { VPFIBuyAdapterABI } from '../contracts/abis';
import { beginStep } from '../lib/journeyLog';
import { decodeContractError } from '../lib/decodeContractError';
import type { ChainConfig } from '../contracts/config';

/**
 * Reason codes emitted by VPFIBuyReceiver when it rejects a bridged buy
 * (`BuyRefunded.reason`). Kept inline — these are spec constants
 * (`IVPFIBuyMessages.FAIL_REASON_*`), not runtime-variable.
 */
const REFUND_REASONS: Record<number, string> = {
  0: 'Unknown failure on Base',
  1: 'Buy cap exceeded',
  2: 'Fixed-rate buy is paused or unset',
  3: 'VPFI reserve on Base is insufficient',
  4: 'Quote slipped below minVpfiOut',
  5: 'Base-side processing reverted',
};

export type BridgeStatus =
  | 'idle'
  | 'quoting'
  | 'approving'
  | 'submitting'
  | 'pending'
  | 'landed'
  | 'refunded'
  | 'timed-out'
  | 'error';

export interface BridgeQuote {
  /** Wei the buyer is committing (paymentToken unit in WETH mode). */
  ethWei: bigint;
  /** LayerZero native fee required for the send leg. */
  lzFee: bigint;
  /** `msg.value` the buyer must send. `ethWei + lzFee` in native mode,
   *  `lzFee` alone in WETH mode. */
  totalValue: bigint;
  /** Payment mode inferred from `adapter.paymentToken()`. */
  mode: 'native' | 'token';
  /** ERC20 address pulled for `amountIn` (WETH mode). `null` in native mode. */
  paymentToken: string | null;
}

export interface BridgeBuyState {
  status: BridgeStatus;
  /** requestId returned by `buy()` — tracks this specific purchase across its
   *  async lifecycle. */
  requestId: bigint | null;
  /** LayerZero GUID for the outbound BUY_REQUEST; deep-link into LZScan. */
  lzGuid: string | null;
  /** Origin-chain tx hash that initiated the buy. */
  txHash: string | null;
  /** VPFI (18-dec) landed on the user's wallet — populated when status = landed. */
  vpfiOut: bigint | null;
  /** Human-readable refund reason — populated when status = refunded. */
  refundReason: string | null;
  error: string | null;
}

const INITIAL_STATE: BridgeBuyState = {
  status: 'idle',
  requestId: null,
  lzGuid: null,
  txHash: null,
  vpfiOut: null,
  refundReason: null,
  error: null,
};

/** Shape of the on-chain `PendingBuy` struct returned by `adapter.pendingBuys`. */
type PendingBuyTuple = [string, bigint, bigint, number] & {
  buyer: string;
  amountIn: bigint;
  initiatedAt: bigint;
  status: number;
};

/** Mirrors the `BuyStatus` enum ordering in VPFIBuyAdapter.sol. */
const STATUS_NONE = 0;
const STATUS_PENDING = 1;
const STATUS_RESOLVED_SUCCESS = 2;
const STATUS_RESOLVED_REFUNDED = 3;
const STATUS_RESOLVED_TIMED_OUT = 4;

const POLL_INTERVAL_MS = 8_000;
const INITIAL_POLL_DELAY_MS = 15_000;

/**
 * Cross-chain VPFI buy bridge — wraps a chain's {@link ChainConfig.vpfiBuyAdapter}
 * so users on mirror chains can purchase VPFI without leaving their preferred
 * network.
 *
 * Flow:
 *  1. `quote(ethWei, minVpfiOut)` resolves the LayerZero native fee and the
 *     `msg.value` the buyer must send. Also discovers whether the adapter is
 *     in native-ETH or WETH mode.
 *  2. `buy(...)` submits the transaction: approves the payment token if
 *     needed, then calls `adapter.buy(...)`. Extracts `(requestId, lzGuid)`
 *     from the `BuyRequested` event and kicks off a poll loop against
 *     `pendingBuys(requestId)` until the adapter marks the request resolved.
 *  3. On `ResolvedSuccess`, status → `landed` and `vpfiOut` is hydrated from
 *     the corresponding `BuyResolvedSuccess` log. The VPFI OFT transfer lands
 *     on the user's wallet asynchronously — downstream balance hooks should
 *     reload on `landed`.
 *  4. On `ResolvedRefunded`, status → `refunded` with a decoded reason.
 *  5. On `ResolvedTimedOut` or when the caller invokes `reclaim()` past the
 *     adapter's refund window, status → `timed-out`.
 *
 * Returns `null` for the hook surface when the active chain has no adapter
 * deployed — callers should fall back to the canonical buy or show the
 * "not yet live" banner.
 */
export function useVPFIBuyBridge(chain: ChainConfig | null) {
  const { signer, address } = useWallet();
  const adapterAddress = chain?.vpfiBuyAdapter ?? null;
  const rpcUrl = chain?.rpcUrl ?? null;

  const readAdapter = useMemo(() => {
    if (!adapterAddress || !rpcUrl) return null;
    const provider = new JsonRpcProvider(rpcUrl);
    return new Contract(adapterAddress, VPFIBuyAdapterABI, provider);
  }, [adapterAddress, rpcUrl]);

  const writeAdapter = useMemo(() => {
    if (!adapterAddress || !signer) return null;
    return new Contract(adapterAddress, VPFIBuyAdapterABI, signer);
  }, [adapterAddress, signer]);

  const [state, setState] = useState<BridgeBuyState>(INITIAL_STATE);

  // Poll-loop bookkeeping. Kept in refs so we don't tear down the timer on
  // every `state` update — the only trigger for cleanup is unmount or a new buy.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRequestId = useRef<bigint | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const reset = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    activeRequestId.current = null;
    setState(INITIAL_STATE);
  }, []);

  /**
   * Preview the LayerZero fee + compute `msg.value`. Reads `paymentToken` so
   * the caller can display the right copy (native vs WETH-approval).
   */
  const quote = useCallback(
    async (ethWei: bigint, minVpfiOut: bigint): Promise<BridgeQuote | null> => {
      if (!readAdapter) return null;
      if (ethWei === 0n) return null;
      const a = readAdapter as unknown as {
        quoteBuy: (
          amt: bigint,
          min: bigint,
        ) => Promise<{ nativeFee: bigint; lzTokenFee: bigint }>;
        paymentToken: () => Promise<string>;
      };
      const [fee, paymentToken] = await Promise.all([
        a.quoteBuy(ethWei, minVpfiOut),
        a.paymentToken(),
      ]);
      const mode: 'native' | 'token' =
        paymentToken === ZeroAddress ? 'native' : 'token';
      return {
        ethWei,
        lzFee: fee.nativeFee,
        totalValue: mode === 'native' ? ethWei + fee.nativeFee : fee.nativeFee,
        mode,
        paymentToken: mode === 'token' ? paymentToken : null,
      };
    },
    [readAdapter],
  );

  /**
   * Poll the adapter's `pendingBuys(requestId)` until the buy transitions out
   * of `Pending`. Falls back to silent retry on RPC errors so a single flaky
   * request doesn't abort the loop. Populates `vpfiOut` / `refundReason` by
   * querying the matching event log on success.
   */
  const schedulePoll = useCallback(
    (requestId: bigint) => {
      if (!readAdapter || !chain) return;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      activeRequestId.current = requestId;

      const tick = async () => {
        if (activeRequestId.current !== requestId) return;
        try {
          const a = readAdapter as unknown as {
            pendingBuys: (id: bigint) => Promise<PendingBuyTuple>;
            filters: {
              BuyResolvedSuccess: (id?: bigint) => unknown;
              BuyRefunded: (id?: bigint) => unknown;
            };
            queryFilter: (
              filter: unknown,
              fromBlock?: number | string,
              toBlock?: number | string,
            ) => Promise<Array<Log | EventLog>>;
          };
          const p = await a.pendingBuys(requestId);
          if (p.status === STATUS_PENDING || p.status === STATUS_NONE) {
            pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
            return;
          }

          // Terminal state reached — hydrate details from the emitted event.
          if (p.status === STATUS_RESOLVED_SUCCESS) {
            const logs = await a.queryFilter(
              a.filters.BuyResolvedSuccess(requestId),
              chain.deployBlock || 0,
              'latest',
            );
            const ev = logs[logs.length - 1] as EventLog | undefined;
            const vpfiOut =
              ev && 'args' in ev && ev.args ? (ev.args[3] as bigint) : 0n;
            setState((s) => ({ ...s, status: 'landed', vpfiOut }));
          } else if (p.status === STATUS_RESOLVED_REFUNDED) {
            const logs = await a.queryFilter(
              a.filters.BuyRefunded(requestId),
              chain.deployBlock || 0,
              'latest',
            );
            const ev = logs[logs.length - 1] as EventLog | undefined;
            const reasonCode =
              ev && 'args' in ev && ev.args ? Number(ev.args[3]) : 0;
            setState((s) => ({
              ...s,
              status: 'refunded',
              refundReason: REFUND_REASONS[reasonCode] ?? 'Refunded',
            }));
          } else if (p.status === STATUS_RESOLVED_TIMED_OUT) {
            setState((s) => ({ ...s, status: 'timed-out' }));
          }
          activeRequestId.current = null;
        } catch {
          // Ignore transient RPC errors and keep polling.
          pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
        }
      };

      pollTimer.current = setTimeout(tick, INITIAL_POLL_DELAY_MS);
    },
    [readAdapter, chain],
  );

  /**
   * End-to-end buy flow. The caller supplies `ethWei` (what the user typed)
   * and `minVpfiOut` (slippage guard derived from the canonical-chain rate).
   */
  const buy = useCallback(
    async (ethWei: bigint, minVpfiOut: bigint) => {
      if (!writeAdapter || !signer || !address || !chain) {
        setState((s) => ({ ...s, status: 'error', error: 'Wallet not ready.' }));
        return;
      }
      const step = beginStep({
        area: 'vpfi-buy',
        flow: 'bridgedBuy',
        step: 'submit',
      });
      setState({ ...INITIAL_STATE, status: 'quoting' });
      try {
        const q = await quote(ethWei, minVpfiOut);
        if (!q) throw new Error('Quote failed — adapter not configured.');

        // WETH mode → approve the adapter to pull `amountIn` before sending.
        if (q.mode === 'token' && q.paymentToken) {
          setState((s) => ({ ...s, status: 'approving' }));
          const erc20 = new Contract(
            q.paymentToken,
            [
              'function allowance(address,address) view returns (uint256)',
              'function approve(address,uint256) returns (bool)',
            ],
            signer,
          ) as unknown as {
            allowance: (o: string, s: string) => Promise<bigint>;
            approve: (
              s: string,
              n: bigint,
            ) => Promise<{ wait: () => Promise<unknown> }>;
          };
          const existing = await erc20.allowance(
            address,
            adapterAddress as string,
          );
          if (existing < ethWei) {
            const approveTx = await erc20.approve(
              adapterAddress as string,
              ethWei,
            );
            await approveTx.wait();
          }
        }

        setState((s) => ({ ...s, status: 'submitting' }));
        const a = writeAdapter as unknown as {
          buy: (
            amt: bigint,
            min: bigint,
            opts: { value: bigint },
          ) => Promise<{
            hash: string;
            wait: () => Promise<{ logs: Array<Log | EventLog> }>;
          }>;
          interface: {
            parseLog: (
              log: { topics: readonly string[]; data: string },
            ) => { name: string; args: ReadonlyArray<unknown> } | null;
          };
        };
        const tx = await a.buy(ethWei, minVpfiOut, { value: q.totalValue });
        const receipt = await tx.wait();

        // The `buy()` return values are unavailable from a broadcast tx — we
        // decode `(requestId, lzGuid)` from the synchronously-emitted
        // `BuyRequested` log instead.
        let requestId: bigint | null = null;
        let lzGuid: string | null = null;
        for (const log of receipt.logs) {
          try {
            const parsed = a.interface.parseLog(log);
            if (parsed && parsed.name === 'BuyRequested') {
              requestId = parsed.args[0] as bigint;
              lzGuid = parsed.args[5] as string;
              break;
            }
          } catch {
            // log belongs to another contract (e.g. LZ endpoint) — skip.
          }
        }

        if (requestId == null) {
          throw new Error(
            'Buy transaction confirmed but BuyRequested log was not found.',
          );
        }

        setState({
          status: 'pending',
          requestId,
          lzGuid,
          txHash: tx.hash,
          vpfiOut: null,
          refundReason: null,
          error: null,
        });
        schedulePoll(requestId);
        step.success({ note: `requestId=${requestId}, guid=${lzGuid}` });
      } catch (err) {
        setState({
          ...INITIAL_STATE,
          status: 'error',
          error: decodeContractError(err, 'Bridged buy failed'),
        });
        step.failure(err);
      }
    },
    [writeAdapter, signer, address, chain, quote, schedulePoll, adapterAddress],
  );

  /**
   * Manual reclaim path — only valid for a pending buy whose refund window
   * has elapsed without a Base response. Most users never need this; the
   * timed-out path resolves automatically on the next poll if reclaim has
   * already run on-chain.
   */
  const reclaim = useCallback(
    async (requestId: bigint) => {
      if (!writeAdapter) return;
      try {
        const a = writeAdapter as unknown as {
          reclaimTimedOutBuy: (
            id: bigint,
          ) => Promise<{ wait: () => Promise<unknown> }>;
        };
        const tx = await a.reclaimTimedOutBuy(requestId);
        await tx.wait();
        setState((s) => ({ ...s, status: 'timed-out' }));
      } catch (err) {
        setState((s) => ({
          ...s,
          status: 'error',
          error: decodeContractError(err, 'Reclaim failed'),
        }));
      }
    },
    [writeAdapter],
  );

  return {
    /** True iff this chain has a VPFIBuyAdapter deployed. When false, the
     *  hook's action methods are no-ops and the UI should surface the
     *  canonical-chain buy instead. */
    available: !!adapterAddress,
    adapterAddress,
    state,
    quote,
    buy,
    reclaim,
    reset,
  };
}
