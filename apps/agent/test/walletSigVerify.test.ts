/**
 * The shared chain-aware signature verifier (#2009).
 *
 * What the family's endpoints delegate here: plain ECDSA stays an
 * RPC-free fast path, a smart account verifies through the injected
 * chain checker (ERC-1271/6492 in production via viem's
 * `verifyMessage`), and the three verdicts — yes, definitive no,
 * cannot-check — never bleed into each other: a Worker that cannot
 * reach a chain must not call a signature INVALID.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Env } from '../src/env';
import {
  MAX_SIGNATURE_BYTES,
  isValidSignatureShape,
  verifyOnChain,
  verifyWalletSignature,
  type ChainSigChecker,
} from '../src/walletSigVerify';

const ACCOUNT_A = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const ACCOUNT_B = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const MESSAGE = 'Vaipakam test message\n\nWallet: 0xabc';

/** An env with one configured chain (Base Sepolia — present in the
 *  consolidated deployments, so getChainConfigs keeps it). */
const ENV_ONE_CHAIN = { RPC_BASE_SEPOLIA: 'http://rpc.test' } as Env;
/** No chains at all — the natural pre-deploy state. */
const ENV_NO_CHAINS = {} as Env;

const YES: ChainSigChecker = async () => true;
const NO: ChainSigChecker = async () => false;
const DOWN: ChainSigChecker = async () => {
  throw new Error('rpc down');
};
/** Fails the test loudly if the fast path ever consults a chain. */
const NEVER: ChainSigChecker = async () => {
  throw new Error('unexpected chain consult');
};

describe('isValidSignatureShape', () => {
  it('accepts a 65-byte ECDSA signature and a long 6492-style blob', () => {
    expect(isValidSignatureShape(`0x${'ab'.repeat(65)}`)).toBe(true);
    // A realistic ERC-6492 wrapper is hundreds of bytes.
    expect(isValidSignatureShape(`0x${'cd'.repeat(900)}`)).toBe(true);
  });

  it('rejects odd length, non-hex, missing prefix and the oversize cap', () => {
    expect(isValidSignatureShape(`0x${'ab'.repeat(65)}f`)).toBe(false);
    expect(isValidSignatureShape('0xnot-hex')).toBe(false);
    expect(isValidSignatureShape('ab'.repeat(65))).toBe(false);
    expect(
      isValidSignatureShape(`0x${'ab'.repeat(MAX_SIGNATURE_BYTES + 1)}`),
    ).toBe(false);
  });
});

describe('verifyWalletSignature', () => {
  it('plain ECDSA verifies on the fast path — no chain is consulted', async () => {
    const signature = await ACCOUNT_A.signMessage({ message: MESSAGE });
    const v = await verifyWalletSignature(
      ENV_NO_CHAINS, // even with zero chains configured
      ACCOUNT_A.address,
      MESSAGE,
      signature,
      undefined,
      NEVER,
    );
    expect(v).toEqual({ ok: true, via: 'ecdsa' });
  });

  it('a 65-byte signature by the WRONG key falls to the chain path — a 1271 owner-key signature is not a mismatch until a chain says so', async () => {
    const signature = await ACCOUNT_B.signMessage({ message: MESSAGE });
    // The chain confirms (a smart account at A whose owner is B).
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        signature,
        84532,
        YES,
      ),
    ).toEqual({ ok: true, via: 'chain', chainId: 84532 });
    // The chain denies: NOW it is a mismatch.
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        signature,
        84532,
        NO,
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('a long non-ECDSA signature (6492 shape) verifies via the chain', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        84532,
        YES,
      ),
    ).toEqual({ ok: true, via: 'chain', chainId: 84532 });
  });

  it('an RPC failure is UNAVAILABLE, never a mismatch', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        84532,
        DOWN,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a named chain this Worker has no RPC for is UNAVAILABLE', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        1, // Ethereum — not configured in ENV_ONE_CHAIN
        YES,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('with no chains configured at all, a non-fast-path signature is UNAVAILABLE', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_NO_CHAINS,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        YES,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('omitted chainId tries every configured chain and takes the first yes', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    // Both chains must exist in the consolidated deployments for
    // getChainConfigs to keep them — Base Sepolia + Arbitrum Sepolia.
    const env = {
      RPC_BASE_SEPOLIA: 'http://a.test',
      RPC_ARB_SEPOLIA: 'http://b.test',
    } as Env;
    const consulted: string[] = [];
    const secondYes: ChainSigChecker = async (rpcUrl) => {
      consulted.push(rpcUrl);
      return rpcUrl === 'http://b.test';
    };
    expect(
      await verifyWalletSignature(
        env,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        secondYes,
      ),
      // The verdict NAMES the confirming chain (#2013 r5): scoped
      // authority downstream needs to know which contract vouched.
    ).toEqual({ ok: true, via: 'chain', chainId: 421614 });
    expect(consulted).toContain('http://b.test');
  });

  it('a refused rate gate is LIMITED — before any chain is consulted (#2013)', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        84532,
        NEVER, // the gate must refuse before this could fire
        async () => false,
      ),
    ).toEqual({ ok: false, reason: 'limited' });
  });

  it('the gate never charges the ECDSA fast path (#2013)', async () => {
    const signature = await ACCOUNT_A.signMessage({ message: MESSAGE });
    let gateAsked = false;
    expect(
      await verifyWalletSignature(
        ENV_ONE_CHAIN,
        ACCOUNT_A.address,
        MESSAGE,
        signature,
        84532,
        NEVER,
        async () => {
          gateAsked = true;
          return false;
        },
      ),
    ).toEqual({ ok: true, via: 'ecdsa' });
    expect(gateAsked).toBe(false);
  });

  it('the fan-out cap bounds consultation, and capped-and-denied is UNAVAILABLE, never mismatch (#2013)', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    // Three configured chains, cap of two: only two consulted, and
    // since the third might have confirmed, an all-deny outcome is
    // "cannot fully check" rather than a false mismatch.
    const env = {
      RPC_BASE_SEPOLIA: 'http://a.test',
      RPC_ARB_SEPOLIA: 'http://b.test',
      RPC_BNB_TESTNET: 'http://c.test',
    } as Env;
    const consulted: string[] = [];
    const denyAll: ChainSigChecker = async (rpcUrl) => {
      consulted.push(rpcUrl);
      return false;
    };
    expect(
      await verifyWalletSignature(
        env,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        denyAll,
        undefined,
        2,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(consulted).toHaveLength(2);
  });

  it('one chain erroring while another denies is UNAVAILABLE — the down chain might have confirmed (#2013 r3)', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    const env = {
      RPC_BASE_SEPOLIA: 'http://a.test',
      RPC_ARB_SEPOLIA: 'http://b.test',
    } as Env;
    const oneDownOneNo: ChainSigChecker = async (rpcUrl) => {
      if (rpcUrl === 'http://a.test') throw new Error('down');
      return false;
    };
    expect(
      await verifyWalletSignature(
        env,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        oneDownOneNo,
      ),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a mismatch requires EVERY relevant chain to answer no (#2013 r3)', async () => {
    const blob = `0x${'ab'.repeat(700)}`;
    const env = {
      RPC_BASE_SEPOLIA: 'http://a.test',
      RPC_ARB_SEPOLIA: 'http://b.test',
    } as Env;
    expect(
      await verifyWalletSignature(
        env,
        ACCOUNT_A.address,
        MESSAGE,
        blob,
        undefined,
        NO,
      ),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('verifyOnChain (the real checker, stubbed JSON-RPC)', () => {
  // #2013 rounds 1–2 P1: this primitive was beaten twice in review —
  // first viem's verifyMessage swallowing transport failures into
  // `false`, then a liveness probe defeated by an RPC that 429s
  // eth_call while serving eth_chainId. It now owns the verification
  // call, so these tests drive it over a stubbed JSON-RPC transport
  // and pin every answer class.
  const CHAIN_HEX = '0x14a34'; // 84532
  const YES_WORD = `0x${'0'.repeat(63)}1`;
  const NO_WORD = `0x${'0'.repeat(64)}`;

  function stubRpc(onCall: () => Response | { result: string }) {
    const fetchStub = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      if (body.method === 'eth_chainId') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: CHAIN_HEX }),
          { status: 200 },
        );
      }
      if (body.method === 'eth_call') {
        const r = onCall();
        if (r instanceof Response) return r;
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: r.result }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method ${body.method}`);
    };
    vi.stubGlobal('fetch', fetchStub);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SIG = `0x${'ab'.repeat(700)}` as `0x${string}`;

  it('accepts a validator YES and denies a validator NO', async () => {
    stubRpc(() => ({ result: YES_WORD }));
    await expect(
      verifyOnChain('http://rpc.test', 84532, ACCOUNT_A.address, MESSAGE, SIG),
    ).resolves.toBe(true);
    stubRpc(() => ({ result: NO_WORD }));
    await expect(
      verifyOnChain('http://rpc.test', 84532, ACCOUNT_A.address, MESSAGE, SIG),
    ).resolves.toBe(false);
  });

  it('throws when the RPC serves a DIFFERENT chain than configured', async () => {
    stubRpc(() => ({ result: YES_WORD }));
    await expect(
      verifyOnChain('http://rpc.test', 1, ACCOUNT_A.address, MESSAGE, SIG),
    ).rejects.toThrow('different chain');
  });

  it('an eth_call the RPC REFUSES (429) throws — never a definitive no', async () => {
    // The exact reproduction that beat the liveness-probe design:
    // eth_chainId answered, eth_call rate-limited.
    stubRpc(() => new Response('rate limited', { status: 429 }));
    await expect(
      verifyOnChain('http://rpc.test', 84532, ACCOUNT_A.address, MESSAGE, SIG),
    ).rejects.toThrow();
  });

  it('a genuine execution revert is a definitive NO', async () => {
    stubRpc(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: { code: 3, message: 'execution reverted' },
          }),
          { status: 200 },
        ),
    );
    await expect(
      verifyOnChain('http://rpc.test', 84532, ACCOUNT_A.address, MESSAGE, SIG),
    ).resolves.toBe(false);
  });
});
