/**
 * #2486 — signing passes that share the keeper key must not collide on a
 * nonce. Driven against a mock RPC that checks nonces the way a node does:
 * a broadcast is accepted only at the next nonce in sequence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armHeldFence } from './helpers/epochFence';
import {
  createWalletClient,
  custom,
  parseTransaction,
  type Hex,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sendInSubmissionSlot } from '../src/keeperSend';
import {
  FLOOR_TTL_MS,
  isDefinitiveRejection,
  possiblyRelayedHash,
  queuedWallet,
  resetSubmissionQueues,
  SendPastDeadline,
  isSendPastDeadline,
  reportSendError,
  SEND_DEFERRED_WORDING,
  withSubmissionSlot,
} from '../src/submissionQueue';

const FAR_DEADLINE = Number.MAX_SAFE_INTEGER;
const KEY = `0x${'11'.repeat(32)}` as Hex;
const account = privateKeyToAccount(KEY);
const CHAIN_ID = 84532;
const TO = `0x${'22'.repeat(20)}` as const;
const FEES = { gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as const;

const PING_ABI = [
  { type: 'function', name: 'ping', inputs: [], outputs: [], stateMutability: 'nonpayable' },
] as const;

const tick = () => new Promise((r) => setTimeout(r, 5));
/** A run deadline no test reaches. */
const FAR = Number.MAX_SAFE_INTEGER;

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
  /** Hold every broadcast until this settles — a send that keeps its slot. */
  hold?: Promise<void>;
  /** Hold gas estimation until this settles — a slow preparation. */
  holdEstimate?: Promise<void>;
  /** Answer the fee reads viem makes when a send names no fees. */
  serveFees?: boolean;
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
          // Fee reads, for a sender that leaves the fees to viem — opt-in, so
          // the tests built without them keep failing where they did.
          case 'eth_getBlockByNumber':
            if (!node.serveFees) throw new Error(`unexpected ${method}`);
            return { baseFeePerGas: '0x1', number: '0x1', hash: `0x${'cd'.repeat(32)}`, transactions: [] };
          case 'eth_maxPriorityFeePerGas':
            if (!node.serveFees) throw new Error(`unexpected ${method}`);
            return '0x1';
          case 'eth_estimateGas':
            if (node.holdEstimate) await node.holdEstimate;
            if (node.failNextEstimate) {
              node.failNextEstimate = false;
              throw new Error('execution reverted');
            }
            return '0x5208';
          case 'eth_sendRawTransaction': {
            if (node.hold) await node.hold;
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

beforeEach(() => {
  resetSubmissionQueues();
  armHeldFence(); // every send asserts the epoch fence (#2569 r4)
});

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
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
    // One pass through writeContract's route, one through a raw slot the
    // way graceDefault sends, started together.
    const passA = wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    const base = nodeWallet(node);
    const passB = withSubmissionSlot(base, CHAIN_ID, account.address, FAR_DEADLINE, async (nonce, signed) => {
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
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
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
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
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
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
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
        FAR_DEADLINE,
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
      withSubmissionSlot(wallet, CHAIN_ID, account.address, FAR_DEADLINE, async () => {
        throw new Error('execution reverted');
      }),
    ).rejects.toThrow();
    const nonce = await withSubmissionSlot(wallet, CHAIN_ID, account.address, FAR_DEADLINE, async (n) => n);
    expect(nonce).toBe(0);
  });

  it('a broadcast that throws AFTER signing keeps its nonce reserved', async () => {
    // The node takes the transaction but the answer is lost, and the node
    // answering the next count has not seen it.
    const node: Node = { accepted: [], rejected: [], reportedPending: () => 0, loseAnswer: true };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
    const first = wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    await expect(first).rejects.toThrow();
    // The next send must not reuse nonce 0, which would replace it.
    await wallet.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    expect(node.accepted).toEqual([0, 1]);
    expect(node.rejected).toEqual([]);
  });

  it('a broadcast whose answer was lost names the hash it may have relayed; a refused one does not (Codex #2602 r6)', async () => {
    const node: Node = { accepted: [], rejected: [], loseAnswer: true };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
    const lost = await wallet.writeContract({ account, chain: null, address: TO, abi: PING_ABI, functionName: 'ping', ...FEES } as never).catch((e: unknown) => e);
    const hash = possiblyRelayedHash(lost);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    node.refuseNext = true;
    const refused = await wallet.writeContract({ account, chain: null, address: TO, abi: PING_ABI, functionName: 'ping', ...FEES } as never).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(possiblyRelayedHash(refused)).toBeUndefined();
    expect(possiblyRelayedHash(new Error('unrelated'))).toBeUndefined();
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
    const a = withSubmissionSlot(wallet, 1, account.address, FAR_DEADLINE, async () => {
      await holding;
      order.push('chain1');
    });
    const b = withSubmissionSlot(wallet, 2, account.address, FAR_DEADLINE, async () => {
      order.push('chain2');
    });
    await b;
    releaseA();
    await a;
    expect(order).toEqual(['chain2', 'chain1']);
  });
});

describe('every send carries its run deadline (#2572)', () => {
  it('a wallet cannot be built without a finite deadline', () => {
    const node: Node = { accepted: [], rejected: [] };
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown]) {
      expect(() => queuedWallet(nodeWallet(node), CHAIN_ID, bad as number), String(bad)).toThrow(TypeError);
    }
  });

  it('a send whose turn comes after its deadline is refused before signing, and spends no nonce', async () => {
    const node: Node = { accepted: [], rejected: [] };
    let release!: () => void;
    node.hold = new Promise<void>((r) => (release = r));
    // Pass A holds the slot; pass B queues behind it with a deadline that
    // passes while it waits.
    const a = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
    const b = queuedWallet(nodeWallet(node), CHAIN_ID, Date.now() + 20);
    const sentA = a.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    const sentB = b.sendTransaction({ account, chain: null, to: TO, ...FEES } as never);
    await new Promise((r) => setTimeout(r, 60));
    node.hold = undefined;
    release();
    await expect(sentA).resolves.toBeTruthy();
    await expect(sentB).rejects.toBeInstanceOf(SendPastDeadline);
    expect(node.accepted).toEqual([0]);
    // The refused send took no nonce: the next send lands on 1.
    await expect(a.sendTransaction({ account, chain: null, to: TO, ...FEES } as never)).resolves.toBeTruthy();
    expect(node.accepted).toEqual([0, 1]);
    expect(node.rejected).toEqual([]);
  });

  it('the slot itself enforces it, for a sender that bypasses the queued wallet', async () => {
    const node: Node = { accepted: [], rejected: [] };
    const wallet = nodeWallet(node);
    let ran = false;
    await expect(
      withSubmissionSlot(wallet, CHAIN_ID, account.address, Date.now() - 1, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(SendPastDeadline);
    expect(ran, 'the send body never ran').toBe(false);
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        withSubmissionSlot(wallet, CHAIN_ID, account.address, bad as number, async () => undefined),
        String(bad),
      ).rejects.toThrow(TypeError);
    }
  });

  it('a deadline crossed while the send is prepared is refused before broadcast, and frees the nonce (r2)', async () => {
    const node: Node = { accepted: [], rejected: [] };
    let release!: () => void;
    node.holdEstimate = new Promise<void>((r) => (release = r));
    // Its turn comes at once, inside the deadline; the slow estimate then
    // carries it past. No gas limit is given, so preparation estimates it.
    const late = queuedWallet(nodeWallet(node), CHAIN_ID, Date.now() + 20);
    const sent = late.sendTransaction({ account, chain: null, to: TO, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as never);
    await new Promise((r) => setTimeout(r, 60));
    node.holdEstimate = undefined;
    release();
    await expect(sent).rejects.toSatisfy(isSendPastDeadline);
    expect(node.accepted, 'nothing broadcast').toEqual([]);
    const next = queuedWallet(nodeWallet(node), CHAIN_ID, FAR);
    await expect(next.sendTransaction({ account, chain: null, to: TO, ...FEES } as never)).resolves.toBeTruthy();
    expect(node.accepted, 'the refused send held no nonce').toEqual([0]);
  });

  it('the prepared-send helper reports such a refusal as nothing sent, not as unconfirmed (r2)', async () => {
    const node: Node = { accepted: [], rejected: [], serveFees: true };
    let release!: () => void;
    node.holdEstimate = new Promise<void>((r) => (release = r));
    const sent = sendInSubmissionSlot(nodeWallet(node), CHAIN_ID, Date.now() + 20, TO, '0x');
    await new Promise((r) => setTimeout(r, 60));
    node.holdEstimate = undefined;
    release();
    await expect(sent).rejects.toSatisfy(isSendPastDeadline);
    expect(node.accepted).toEqual([]);
  });

  it('a refusal raised inside writeContract is recognised through viem\'s wrapping', async () => {
    const node: Node = { accepted: [], rejected: [] };
    const wallet = queuedWallet(nodeWallet(node), CHAIN_ID, Date.now() - 1);
    const err = await wallet
      .writeContract({ address: TO, abi: PING_ABI, functionName: 'ping', account, chain: null, ...FEES } as never)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    expect(isSendPastDeadline(err)).toBe(true);
    expect(isSendPastDeadline(new Error('other'))).toBe(false);
    expect(node.accepted).toEqual([]);
  });

  describe('every send site reports a refusal as a deferral (r3)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a wrapped refusal is logged as deferred, never through the failure logger', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const failures: string[] = [];
      const node: Node = { accepted: [], rejected: [] };
      const err = await queuedWallet(nodeWallet(node), CHAIN_ID, Date.now() - 1)
        .writeContract({ address: TO, abi: PING_ABI, functionName: 'ping', account, chain: null, ...FEES } as never)
        .then(() => null, (e: unknown) => e);
      expect(reportSendError('[site]', err, 'broadcast failed: x', (l) => failures.push(l))).toBe(true);
      expect(failures).toEqual([]);
      expect(log).toHaveBeenCalledWith(`[site] ${SEND_DEFERRED_WORDING}`);
    });

    it('any other error keeps the site\'s own failure line and level', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const failures: string[] = [];
      expect(reportSendError('[site]', new Error('nonce too low'), 'broadcast failed: nonce too low', (l) => failures.push(l))).toBe(false);
      expect(failures).toEqual(['[site] broadcast failed: nonce too low']);
      expect(log).not.toHaveBeenCalled();
    });
  });
});
