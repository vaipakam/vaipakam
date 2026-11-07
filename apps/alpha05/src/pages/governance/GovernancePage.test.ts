/**
 * #3237 — the queued-changes page states every state of the read, and shows
 * a call's action only when the reader proved it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM, VaipakamTimelockABI } from '@vaipakam/contracts/abis';
import type { GovernanceQueue, QueuedOperation } from '@vaipakam/lib/governanceQueue';
import '../../test/i18n';
import type { SupportedChain } from '../../chain/chains';
import { GovernanceView } from './GovernancePage';

const DIAMOND = '0x00000000000000000000000000000000000000D1' as Address;
const TIMELOCK = '0x00000000000000000000000000000000000071C0' as Address;
const ACCOUNT = '0x00000000000000000000000000000000000000AA' as Address;
const chain: SupportedChain = {
  chainId: 84532,
  name: 'Base Sepolia',
  rpcEndpoints: [],
  blockExplorer: 'https://sepolia.basescan.org',
  testnet: true,
  nativeGasSymbol: 'ETH',
  diamondAddress: DIAMOND,
  deployBlock: 1,
};
const targets = [
  { key: 'diamond', address: DIAMOND, abi: DIAMOND_ABI_VIEM },
  { key: 'timelock', address: TIMELOCK, abi: VaipakamTimelockABI as Abi },
];
const NOW = 1_900_000_000;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function queue(operations: QueuedOperation[]): GovernanceQueue {
  return { timelock: TIMELOCK, block: { number: 123_456n, timestamp: BigInt(NOW) }, minDelay: 172_800n, operations };
}
const ready = (q: GovernanceQueue, error: string | null = null) => ({ data: q, state: 'ready' as const, error, refetch: () => {} });
const html = (props: Partial<Parameters<typeof GovernanceView>[0]> & Pick<Parameters<typeof GovernanceView>[0], 'queue'>) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(GovernanceView, { chain, hasTimelock: true, targets, nowSec: NOW, ...props })));

const proved = (calls: { target: Address; value: bigint; data: Hex }[]): QueuedOperation['details'] => ({
  kind: 'proved',
  form: calls.length > 1 ? 'batch' : 'single',
  calls,
  predecessor: id(0),
  predecessorDone: null,
  salt: id(0),
  delay: 172_800n,
  scheduledBlock: 120_000n,
  scheduledTx: id(77),
});

describe('GovernanceView', () => {
  it('says when the chain has no governance timelock recorded', () => {
    const out = html({ hasTimelock: false, queue: { data: null, state: 'reading', error: null, refetch: () => {} } });
    expect(out).toContain('No governance timelock is recorded for Base Sepolia');
  });

  it('treats a failed read as unknown, never as an empty queue', () => {
    const out = html({ queue: { data: null, state: 'failed', error: 'rpc down', refetch: () => {} } });
    expect(out).toContain('could not be read, so whether any change is waiting is unknown (rpc down)');
    expect(out).not.toContain('Nothing is queued');
  });

  it('says nothing is queued only when the read returned an empty queue, with its block', () => {
    const out = html({ queue: ready(queue([])) });
    expect(out).toContain('Nothing is queued on Base Sepolia.');
    expect(out).toContain('Read at block 123456');
    expect(out).toContain('Each change waits at least 2 days after it is queued.');
  });

  it('marks the last answer as old when a re-read failed', () => {
    const out = html({ queue: ready(queue([]), 'timeout') });
    expect(out).toContain('The latest re-read failed (timeout)');
  });

  it('shows a proved change in words, with when it can run and its exact call', () => {
    const PAUSER = keccak256(toHex('PAUSER_ROLE'));
    const grant = encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'grantRole', args: [PAUSER, ACCOUNT] });
    const pause = encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'pause' });
    const out = html({
      queue: ready(
        queue([
          { id: id(1), eta: BigInt(NOW + 3_600), ready: false, details: proved([{ target: DIAMOND, value: 0n, data: grant }, { target: DIAMOND, value: 0n, data: pause }]) },
          { id: id(2), eta: BigInt(NOW - 10), ready: true, details: proved([{ target: TIMELOCK, value: 0n, data: encodeFunctionData({ abi: VaipakamTimelockABI as Abi, functionName: 'updateDelay', args: [259_200n] }) }]) },
        ]),
      ),
    });
    expect(out).toContain('2 changes queued.');
    expect(out).toContain('in 1 h');
    expect(out).toContain('2 calls, run together in this order.');
    expect(out).toContain(`Gives the PAUSER_ROLE role to ${ACCOUNT} on the protocol contract.`);
    expect(out).toContain('Pauses the protocol contract.');
    expect(out).toContain('Can run now.');
    expect(out).toContain('Sets the minimum wait for every later governance change to 3 days.');
    expect(out).toContain('Exact call');
    expect(out).toContain('https://sepolia.basescan.org/tx/');
    expect(out).toContain('does not expire');
  });

  it('does not call a change runnable while its predecessor has not run', () => {
    const pause = encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'pause' });
    const details = { ...proved([{ target: DIAMOND, value: 0n, data: pause }]), predecessor: id(5), predecessorDone: false } as QueuedOperation['details'];
    const out = html({ queue: ready(queue([{ id: id(4), eta: BigInt(NOW - 10), ready: true, details }])) });
    expect(out).not.toContain('Can run now.');
    expect(out).toContain(`It runs only after operation ${id(5)} has run, and that operation has not run yet.`);
  });

  it('names a new owner without promising the handover is done', () => {
    const owner = '0x00000000000000000000000000000000000000ab' as Address;
    const data = encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'transferOwnership', args: [owner] });
    const out = html({ queue: ready(queue([{ id: id(6), eta: BigInt(NOW + 100), ready: false, details: proved([{ target: DIAMOND, value: 0n, data }]) }])) });
    expect(out).toContain('Where ownership moves in two steps, it moves only when that address accepts.');
  });

  it('keeps the page up for a change whose time is past what a date can hold', () => {
    const pause = encodeFunctionData({ abi: DIAMOND_ABI_VIEM, functionName: 'pause' });
    const far = 10n ** 22n;
    const out = html({ queue: ready(queue([{ id: id(8), eta: far, ready: false, details: { ...proved([{ target: DIAMOND, value: 0n, data: pause }]), delay: far } as QueuedOperation['details'] }])) });
    expect(out).toContain('Unix time 10000000000000000000000 UTC');
    expect(out).toContain('Pauses the protocol contract.');
  });

  it('lists an unproved change with its id and why its action is unknown', () => {
    const out = html({
      queue: ready(queue([{ id: id(9), eta: BigInt(NOW + 100), ready: false, details: { kind: 'unknown', reason: 'unproved', searched: [] } }])),
    });
    expect(out).toContain('What this change does is unknown: the records found do not match its id, so they are not shown.');
    expect(out).toContain(`Operation id ${id(9)}`);
  });

  it('names an undecodable call as unknown, never guessed', () => {
    const stranger = '0x00000000000000000000000000000000000000EE' as Address;
    const out = html({
      queue: ready(queue([{ id: id(3), eta: BigInt(NOW + 100), ready: false, details: proved([{ target: stranger, value: 10n ** 17n, data: '0xdeadbeef' }]) }])),
    });
    expect(out).toContain(`Calls function 0xdeadbeef on unlisted contract ${stranger}. This app cannot decode it, so what it does is unknown.`);
    expect(out).toContain('Sends 0.1 ETH from the timelock with this call.');
    expect(out).toContain('Its arguments could not be decoded; the raw call data is below.');
    expect(out).not.toContain('No arguments.');
    expect(out).toContain('0xdeadbeef</dd>');
  });
});
