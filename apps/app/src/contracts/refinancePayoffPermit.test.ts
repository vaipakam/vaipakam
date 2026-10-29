/**
 * #1558 — the refinance payoff permit. The typed data the wallet signs is
 * held to the witness type string the contract hands Permit2, read from
 * the contract source itself: a wallet encodes the witness from these
 * types, so a field the two spell differently would make every signature
 * fail inside Permit2. The permit checks and the request's last fillable
 * moment are pinned too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toBytes,
  type Hex,
} from 'viem';
// The Permit2 approval step is the ERC-20 module's; the attach test drives
// the steps after it.
vi.mock('./erc20', () => ({ ensureAllowance: vi.fn(async () => undefined) }));

import {
  attachRefinancePayoffPermit,
  lastFillableMoment,
  payoffPermitTypedData,
  permitProblem,
  type RefinancePayoff,
} from './refinancePayoffPermit';
import { PERMIT2_ADDRESS } from './usePermit2Signing';

const DIAMOND = '0x000000000000000000000000000000000000d1a0' as const;
const TOKEN = '0x00000000000000000000000000000000000000a1' as const;
const HOLDER = '0x00000000000000000000000000000000000000b0' as const;

/** The contract's `WITNESS_TYPE_STRING`, joined from its source. */
function contractWitnessTypeString(): string {
  const src = readFileSync(
    fileURLToPath(
      new URL('../../../../contracts/src/libraries/LibRefinancePayoff.sol', import.meta.url),
    ),
    'utf8',
  );
  const decl = src.match(/WITNESS_TYPE_STRING\s*=\s*((?:\s*"[^"]*")+)\s*;/);
  if (!decl) throw new Error('WITNESS_TYPE_STRING not found');
  return [...decl[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
}

const u = (t: string) => keccak256(toBytes(t));

describe('payoffPermitTypedData', () => {
  it('signs the digest Permit2 builds from the contract’s witness type string', () => {
    const a = {
      chainId: 84532,
      diamond: DIAMOND,
      token: TOKEN,
      maxAmount: 1_234_567n,
      nonce: 0x1558n,
      deadline: 1_900_000_000n,
      loanId: 7n,
      offerId: 42n,
    };
    // Permit2's permitWitnessTransferFrom: its own stub, then the
    // integrator's witness type string, hashed as one type.
    const fullType =
      'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,' +
      contractWitnessTypeString();
    const tokenPermissions = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [u('TokenPermissions(address token,uint256 amount)'), a.token, a.maxAmount],
      ),
    );
    const witness = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
        [u('RefinancePayoff(uint256 loanId,uint256 offerId)'), a.loanId, a.offerId],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'uint256' },
          { type: 'bytes32' },
        ],
        [u(fullType), tokenPermissions, a.diamond, a.nonce, a.deadline, witness],
      ),
    );
    const domain = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [
          u('EIP712Domain(string name,uint256 chainId,address verifyingContract)'),
          u('Permit2'),
          BigInt(a.chainId),
          PERMIT2_ADDRESS,
        ],
      ),
    );
    const expected = keccak256(concat(['0x1901' as Hex, domain, structHash]));
    expect(hashTypedData(payoffPermitTypedData(a))).toBe(expected);
  });
});

describe('lastFillableMoment', () => {
  it('is one second before the request’s expiry, never after the grace end', () => {
    expect(lastFillableMoment(1_000n, 5_000n)).toBe(999n);
    expect(lastFillableMoment(9_000n, 5_000n)).toBe(5_000n);
    // No expiry of its own: the grace end alone bounds it.
    expect(lastFillableMoment(0n, 5_000n)).toBe(5_000n);
  });
});

describe('permitProblem', () => {
  const good: RefinancePayoff = {
    asset: TOKEN,
    payoffNow: 100n,
    payoffBy: 120n,
    signer: HOLDER,
    maxAmount: 120n,
    nonce: 1n,
    deadline: 2_000n,
    nonceSpent: false,
  };
  const check = (p: Partial<RefinancePayoff>, now = 1_000n) =>
    permitProblem({ ...good, ...p }, HOLDER, now, 2_000n, 120n);

  it('passes a permit that pays every acceptance the request allows', () => {
    expect(check({})).toBeNull();
  });

  it('names each way a permit cannot pay', () => {
    expect(check({ signer: '0x0000000000000000000000000000000000000000' })).toBe('missing');
    expect(check({ signer: '0x00000000000000000000000000000000000000c0' })).toBe('missing');
    expect(check({ nonceSpent: true })).toBe('spent');
    expect(check({}, 2_001n)).toBe('expired');
    expect(check({ deadline: 1_999n })).toBe('lapsesEarly');
    expect(check({ maxAmount: 119n })).toBe('short');
  });
});

describe('attachRefinancePayoffPermit (#1558)', () => {
  const base = (write: Parameters<typeof attachRefinancePayoffPermit>[0]['write'], receipt: () => unknown) =>
    attachRefinancePayoffPermit({
      publicClient: { getTransactionReceipt: vi.fn(async () => receipt()) } as never,
      walletClient: { signTypedData: vi.fn(async () => '0x01') } as never,
      write,
      chainId: 84532,
      diamond: DIAMOND,
      owner: HOLDER,
      token: TOKEN,
      maxAmount: 120n,
      deadline: 2_000n,
      loanId: 7n,
      offerId: 42n,
    });
  const HASH = `0x${'ab'.repeat(32)}` as const;

  it('is attached when the write returns', async () => {
    await expect(base(async () => ({}) as never, () => null)).resolves.toBe('attached');
  });

  it('is unknown, never "missing", when the attach was sent and cannot be settled', async () => {
    const write = async (_f: string, _a: readonly unknown[], o?: { onSubmitted?: (h: `0x${string}`) => void }) => {
      o?.onSubmitted?.(HASH);
      throw new Error('receipt wait timed out');
    };
    await expect(
      base(write, () => {
        throw new Error('not found');
      }),
    ).resolves.toBe('unknown');
  });

  it('is attached when the sent attach turns out to have mined', async () => {
    const write = async (_f: string, _a: readonly unknown[], o?: { onSubmitted?: (h: `0x${string}`) => void }) => {
      o?.onSubmitted?.(HASH);
      throw new Error('receipt wait timed out');
    };
    await expect(
      base(write, () => ({ status: 'success', blockNumber: 9n, logs: [] })),
    ).resolves.toBe('attached');
  });

  it('throws when the attach was never sent, or reverted', async () => {
    await expect(
      base(async () => {
        throw new Error('rejected');
      }, () => null),
    ).rejects.toThrow('rejected');
    const write = async (_f: string, _a: readonly unknown[], o?: { onSubmitted?: (h: `0x${string}`) => void }) => {
      o?.onSubmitted?.(HASH);
      throw new Error('reverted');
    };
    await expect(base(write, () => ({ status: 'reverted', blockNumber: 9n, logs: [] }))).rejects.toThrow(
      'reverted',
    );
  });
});
