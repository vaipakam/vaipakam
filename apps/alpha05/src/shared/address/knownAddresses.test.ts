import {
  ContractFunctionExecutionError,
  getAddress,
  ContractFunctionRevertedError,
  HttpRequestError,
  encodeErrorResult,
  parseAbi,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { entryReady } from './AddressEntry';
import type { AddressBook } from './book';
import { knownAddresses, readUsedAddresses, type UsedAddresses } from './knownAddresses';
import { classifyCandidate } from './lookalike';

type Hex = `0x${string}`;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const KEEPER = getAddress('0xabc0000000000000000000000000000000000def');
const SIGNER = getAddress('0x1230000000000000000000000000000000000456');
const DEST = getAddress('0x7770000000000000000000000000000000000888');
const NOMINEE = getAddress('0x4440000000000000000000000000000000000555');
const EMPTY: AddressBook = { entries: [], pending: [] } as unknown as AddressBook;

const NO_ROUTE = parseAbi(['error FunctionDoesNotExist()']);
const noRoute = (functionName: string) =>
  new ContractFunctionRevertedError({ abi: NO_ROUTE, data: encodeErrorResult({ abi: NO_ROUTE, errorName: 'FunctionDoesNotExist' }), functionName });
const otherRevert = (functionName: string) => new ContractFunctionRevertedError({ abi: [], functionName });
const outage = (functionName: string) =>
  new ContractFunctionExecutionError(new HttpRequestError({ url: 'https://rpc.example', status: 429 }), { abi: [], functionName });

function client(answers: Record<string, unknown | ((fn: string) => Error)>): PublicClient {
  return {
    getBlockNumber: async () => 7n,
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
      expect(blockNumber).toBe(7n);
      const a = answers[functionName];
      if (typeof a === 'function') throw (a as (fn: string) => Error)(functionName);
      return a;
    },
  } as unknown as PublicClient;
}

const VAULT = getAddress('0x00000000000000000000000000000000000000f1');

// #3379 B2: the Diamond names the vault; destinations and signers are its record.
const ALL = {
  getProtection: [VAULT, false, 0n],
  protectionState: [true, false, 2 * 86_400, 0n, '0x0000000000000000000000000000000000000000', [SIGNER], [DEST]],
  pendingAdditions: [[], [NOMINEE]],
  getApprovedKeepers: [KEEPER],
};

describe('readUsedAddresses', () => {
  it('reads every on-chain list at one block, the protected ones from the vault', async () => {
    await expect(readUsedAddresses(client(ALL), DIAMOND, ME)).resolves.toEqual({
      destinations: [DEST],
      pending: [],
      signers: [SIGNER],
      nominees: [NOMINEE],
      keepers: [KEEPER],
    });
  });

  it('reads a feature the Diamond does not route, or an account without a vault, as holding no address', async () => {
    const empty = { destinations: [], pending: [], signers: [], nominees: [], keepers: [KEEPER] };
    await expect(readUsedAddresses(client({ ...ALL, getProtection: noRoute }), DIAMOND, ME)).resolves.toEqual(empty);
    await expect(
      readUsedAddresses(client({ ...ALL, getProtection: ['0x0000000000000000000000000000000000000000', false, 0n] }), DIAMOND, ME),
    ).resolves.toEqual(empty);
  });

  it('leaves a list unread on any other refusal, and throws a failed source so the rail moves on', async () => {
    await expect(readUsedAddresses(client({ ...ALL, protectionState: otherRevert }), DIAMOND, ME)).resolves.toMatchObject({ signers: null, destinations: null });
    await expect(readUsedAddresses(client({ ...ALL, getApprovedKeepers: outage }), DIAMOND, ME)).rejects.toBeInstanceOf(ContractFunctionExecutionError);
  });
});

describe('knownAddresses', () => {
  const used: UsedAddresses = { destinations: [DEST], pending: [], signers: [SIGNER], nominees: [NOMINEE], keepers: [KEEPER] };

  it('refuses a look-alike of an approved keeper, a signer and a destination, wherever the box is', () => {
    const k = knownAddresses(ME, EMPTY, null, used, 'ready');
    expect(k.state).toBe('complete');
    expect(classifyCandidate('0xabc1111111111111111111111111111111111def', k.list)).toMatchObject({ kind: 'lookalike', of: { source: 'keeper' } });
    expect(classifyCandidate('0x1239999999999999999999999999999999999456', k.list)).toMatchObject({ kind: 'lookalike', of: { source: 'signer' } });
    expect(classifyCandidate('0x7771111111111111111111111111111111111888', k.list)).toMatchObject({ kind: 'lookalike', of: { source: 'destination' } });
    expect(classifyCandidate('0x4442222222222222222222222222222222222555', k.list)).toMatchObject({ kind: 'lookalike', of: { source: 'signer' } });
  });

  it('names the network keeper', () => {
    const k = knownAddresses(ME, EMPTY, { address: KEEPER, label: 'Network keeper' }, used, 'ready');
    expect(k.list.find((x) => x.address === KEEPER)).toMatchObject({ source: 'keeper', label: 'Network keeper' });
  });

  it('lets no address be used until every source has answered', () => {
    const fresh = '0x9990000000000000000000000000000000000111';
    const c = classifyCandidate(fresh, []);
    expect(entryReady(c, true, knownAddresses(ME, EMPTY, null, null, 'reading'))).toBeNull();
    expect(knownAddresses(ME, EMPTY, null, null, 'reading').state).toBe('reading');
    expect(knownAddresses(ME, EMPTY, null, null, 'failed').state).toBe('failed');
    const partial = knownAddresses(ME, EMPTY, null, { ...used, signers: null }, 'ready');
    expect(partial.state).toBe('failed');
    expect(knownAddresses(ME, EMPTY, null, { ...used, nominees: null }, 'ready').state).toBe('failed');
    expect(entryReady(c, true, partial)).toBeNull();
    expect(entryReady(c, true, knownAddresses(ME, EMPTY, null, used, 'ready'))).toBe(fresh);
  });
});
