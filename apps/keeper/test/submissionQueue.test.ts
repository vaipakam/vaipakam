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
  queuedWallet,
  resetSubmissionQueues,
  withSubmissionSlot,
} from '../src/submissionQueue';

const KEY = `0x${'11'.repeat(32)}` as Hex;
const account = privateKeyToAccount(KEY);
const CHAIN_ID = 84532;
const TO = `0x${'22'.repeat(20)}` as const;
const FEES = { gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as const;

const tick = () => new Promise((r) => setTimeout(r, 5));

interface Node {
  accepted: number[];
  rejected: string[];
  /** What `eth_getTransactionCount` reports; defaults to the true count. */
  reportedPending?: () => number;
  /** Fail gas estimation for the next call. */
  failNextEstimate?: boolean;
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
            if (tx.nonce !== node.accepted.length) {
              node.rejected.push(`nonce ${tx.nonce} expected ${node.accepted.length}`);
              throw new Error('nonce too low');
            }
            node.accepted.push(tx.nonce);
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
    const passB = withSubmissionSlot(base, CHAIN_ID, account.address, async (nonce) => {
      const signed = await base.signTransaction({
        account,
        chain: null,
        chainId: CHAIN_ID,
        to: TO,
        nonce,
        ...FEES,
      } as never);
      return base.sendRawTransaction({ serializedTransaction: signed });
    });
    await Promise.all([passA, passB]);
    expect(node.rejected).toEqual([]);
    expect(node.accepted).toEqual([0, 1]);
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
        async (nonce) => nonce,
        () => now,
      );
    expect(await slot()).toBe(0);
    expect(await slot()).toBe(1);
    now += FLOOR_TTL_MS;
    // Expired: the RPC's answer is trusted again.
    expect(await slot()).toBe(0);
  });

  it('a send that throws records no nonce', async () => {
    const node: Node = { accepted: [], rejected: [], reportedPending: () => 0 };
    const wallet = nodeWallet(node);
    await expect(
      withSubmissionSlot(wallet, CHAIN_ID, account.address, async () => {
        throw new Error('request timed out');
      }),
    ).rejects.toThrow();
    const nonce = await withSubmissionSlot(wallet, CHAIN_ID, account.address, async (n) => n);
    expect(nonce).toBe(0);
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
