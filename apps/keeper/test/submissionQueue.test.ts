/**
 * #2486 — signing passes that share the keeper key must not collide on a
 * nonce. Driven against a mock RPC that checks nonces the way a node does:
 * a broadcast is accepted only at the next nonce in sequence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWalletClient,
  custom,
  parseTransaction,
  type Hex,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FLOOR_TTL_MS,
  isDefinitiveRejection,
  queuedWallet,
  resetSubmissionQueues,
  withSubmissionSlot,
} from '../src/submissionQueue';

const KEY = `0x${'11'.repeat(32)}` as Hex;
const account = privateKeyToAccount(KEY);
const CHAIN_ID = 84532;
const TO = `0x${'22'.repeat(20)}` as const;
const FEES = { gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as const;

const PING_ABI = [
  { type: 'function', name: 'ping', inputs: [], outputs: [], stateMutability: 'nonpayable' },
] as const;

const tick = () => new Promise((r) => setTimeout(r, 5));

interface Node {
  accepted: number[];
  rejected: string[];
  /** What `eth_getTransactionCount` reports; defaults to the true count. */
  reportedPending?: () => number;
  /** Fail gas estimation for the next call. */
  failNextEstimate?: boolean;
  /** Accept the next broadcast, then throw as if its answer was lost. */
  loseAnswer?: boolean;
  /** Refuse the next broadcast with a JSON-RPC error, as a node does. */
  refuseNext?: boolean;
}

function nodeWallet(node: Node): WalletClient {
  return createWalletClient({
    account,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        // Every answer takes a moment, so concurrent sends genuinely overlap.
        await tick();
        switch (method) {
          case 'eth_chainId':
            return `0x${CHAIN_ID.toString(16)}`;
          case 'eth_getTransactionCount':
            return `0x${(node.reportedPending?.() ?? node.accepted.length).toString(16)}`;
          case 'eth_estimateGas':
            if (node.failNextEstimate) {
              node.failNextEstimate = false;
              throw new Error('execution reverted');
            }
            return '0x5208';
          case 'eth_sendRawTransaction': {
            const tx = parseTransaction((params as Hex[])[0]);
            if (node.refuseNext) {
              node.refuseNext = false;
              throw Object.assign(new Error('insufficient funds for gas * price + value'), {
                code: -32000,
              });
            }
            if (tx.nonce !== node.accepted.length) {
              node.rejected.push(`nonce ${tx.nonce} expected ${node.accepted.length}`);
              throw new Error('nonce too low');
            }
            node.accepted.push(tx.nonce);
            if (node.loseAnswer) {
              node.loseAnswer = false;
              throw new Error('request timed out');
            }
            return `0x${'ab'.repeat(32)}`;
          }
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
    }),
  });
}

beforeEach(() => resetSubmissionQueues());

describe('submission queue (#2486)', () => {
  it('the mock catches a collision when sends are NOT queued', async () => {
    const node: Node = { accepted: [], rejected: [] };
    const wallet = nodeWallet(node);
    const send = () => wallet.sendTransaction({ account, chain: null, to: TO, ...FEES });
    await Promise.allSettled([send(), send()]);
    expect(node.rejected.length).toBe(1);
  });

  it('two passes sending at once on one chain both land, in sequence', async () => {
    const node: Node = { accepted: [], rejected: [] };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID);
    // One pass through writeContract's route, one through a raw slot the
    // way graceDefault sends, started together.
    const passA = wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    const base = nodeWallet(node);
    const passB = withSubmissionSlot(base, CHAIN_ID, account.address, async (nonce, signed) => {
      const signedTx = await base.signTransaction({
        account,
        chain: null,
        chainId: CHAIN_ID,
        to: TO,
        nonce,
        ...FEES,
      } as never);
      signed();
      return base.sendRawTransaction({ serializedTransaction: signedTx });
    });
    await Promise.all([passA, passB]);
    expect(node.rejected).toEqual([]);
    expect(node.accepted).toEqual([0, 1]);
  });

  it('two writeContract calls at once both land, in sequence', async () => {
    const node: Node = { accepted: [], rejected: [] };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID);
    const call = () =>
      wallet.writeContract({
        account,
        chain: null,
        address: TO,
        abi: PING_ABI,
        functionName: 'ping',
        ...FEES,
      } as never);
    await Promise.all([call(), call()]);
    expect(node.rejected).toEqual([]);
    expect(node.accepted).toEqual([0, 1]);
  });

  it('a send the node refuses outright leaves its nonce free', async () => {
    // The node answering the count is the one that refused, so it is right.
    const node: Node = { accepted: [], rejected: [], reportedPending: () => 0, refuseNext: true };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID);
    await expect(
      wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never),
    ).rejects.toThrow();
    // A floor here would push the next send to nonce 1 and strand it behind a gap.
    await wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    expect(node.accepted).toEqual([0]);
    expect(node.rejected).toEqual([]);
  });

  it('a send whose estimate reverts leaves no gap', async () => {
    const node: Node = { accepted: [], rejected: [], failNextEstimate: true };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID);
    // No explicit gas, so the first send estimates and fails before signing.
    const failing = wallet.sendTransaction({ account, chain: null, to: TO } as never);
    const ok = wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    await expect(failing).rejects.toThrow();
    await ok;
    expect(node.accepted).toEqual([0]);
    expect(node.rejected).toEqual([]);
  });

  it('outranks a lagging pending count with the last accepted nonce, until it expires', async () => {
    // The node answering the count has not seen any broadcast.
    const node: Node = { accepted: [], rejected: [], reportedPending: () => 0 };
    let now = 1_000;
    const wallet = nodeWallet(node);
    const slot = () =>
      withSubmissionSlot(
        wallet,
        CHAIN_ID,
        account.address,
        async (nonce, signed) => {
          signed();
          return nonce;
        },
        () => now,
      );
    expect(await slot()).toBe(0);
    expect(await slot()).toBe(1);
    now += FLOOR_TTL_MS;
    // Expired: the RPC's answer is trusted again.
    expect(await slot()).toBe(0);
  });

  it('a send that throws BEFORE signing records no nonce', async () => {
    const node: Node = { accepted: [], rejected: [], reportedPending: () => 0 };
    const wallet = nodeWallet(node);
    await expect(
      withSubmissionSlot(wallet, CHAIN_ID, account.address, async () => {
        throw new Error('execution reverted');
      }),
    ).rejects.toThrow();
    const nonce = await withSubmissionSlot(wallet, CHAIN_ID, account.address, async (n) => n);
    expect(nonce).toBe(0);
  });

  it('a broadcast that throws AFTER signing keeps its nonce reserved', async () => {
    // The node takes the transaction but the answer is lost, and the node
    // answering the next count has not seen it.
    const node: Node = { accepted: [], rejected: [], reportedPending: () => 0, loseAnswer: true };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID);
    const first = wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    await expect(first).rejects.toThrow();
    // The next send must not reuse nonce 0, which would replace it.
    await wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    expect(node.accepted).toEqual([0, 1]);
    expect(node.rejected).toEqual([]);
  });

  it('reads only a coded node answer that leaves the nonce free as definitive', () => {
    const coded = (message: string, code: number) => Object.assign(new Error(message), { code });
    const wrapped = (inner: unknown) => Object.assign(new Error('wrapped'), { code: -1, cause: inner });
    expect(isDefinitiveRejection(coded('insufficient funds', -32000))).toBe(true);
    // viem's "unknown" placeholder, and an uncoded error, are not answers.
    expect(isDefinitiveRejection(wrapped(new Error('socket hang up')))).toBe(false);
    // The nonce is held: possibly by this very transaction, via a retry.
    expect(isDefinitiveRejection(coded('nonce too low', -32000))).toBe(false);
    expect(isDefinitiveRejection(wrapped(coded('already known', -32000)))).toBe(false);
  });

  it('queues per chain: another chain does not wait', async () => {
    const node: Node = { accepted: [], rejected: [] };
    const wallet = nodeWallet(node);
    const order: string[] = [];
    let releaseA!: () => void;
    const holding = new Promise<void>((r) => (releaseA = r));
    const a = withSubmissionSlot(wallet, 1, account.address, async () => {
      await holding;
      order.push('chain1');
    });
    const b = withSubmissionSlot(wallet, 2, account.address, async () => {
      order.push('chain2');
    });
    await b;
    releaseA();
    await a;
    expect(order).toEqual(['chain2', 'chain1']);
  });
});
