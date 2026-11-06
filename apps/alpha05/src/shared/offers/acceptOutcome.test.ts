import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Abi, type Log } from 'viem';
import { LoanFacetABI } from '@vaipakam/contracts/abis';
import { deliverySplit, legVerdict, moved, openedLoan } from './acceptOutcome';
import { BORROWER, LENDER, TLIQ, WETH } from './testOffer';

type Hex = `0x${string}`;

const DIAMOND: Hex = '0x9999999999999999999999999999999999999999';
const VAULT: Hex = '0x8888888888888888888888888888888888888888';
const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

function log(address: Hex, topics: readonly Hex[], data: Hex): Log {
  return { address, topics: topics as [Hex, ...Hex[]], data, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false };
}

function loanInitiated(loanId: bigint, offerId: bigint, borrower: Hex, at: Hex = DIAMOND): Log {
  const topics = encodeEventTopics({ abi: LoanFacetABI as Abi, eventName: 'LoanInitiated', args: { loanId, offerId, lender: LENDER } }) as Hex[];
  return log(at, topics, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [borrower, 2n, 5n]));
}

function transfer(token: Hex, from: Hex, to: Hex, value: bigint): Log {
  const topics = encodeEventTopics({ abi: TRANSFER, eventName: 'Transfer', args: { from, to } }) as Hex[];
  return log(token, topics, encodeAbiParameters([{ type: 'uint256' }], [value]));
}

describe('what an acceptance opened', () => {
  it('reads the loan from the Diamond’s own log for this offer and borrower', () => {
    const logs = [loanInitiated(3n, 7n, BORROWER, WETH), loanInitiated(4n, 8n, BORROWER), loanInitiated(5n, 7n, BORROWER)];
    expect(openedLoan(logs, DIAMOND, 7n, BORROWER)).toEqual({ loanId: 5n, principal: 2n, collateralAmount: 5n });
    expect(openedLoan(logs, DIAMOND, 7n, LENDER)).toBeNull();
    expect(openedLoan([], DIAMOND, 7n, BORROWER)).toBeNull();
  });

  it('sums the token that moved between the named sides only', () => {
    const logs = [transfer(WETH, VAULT, BORROWER, 10n), transfer(WETH, DIAMOND, BORROWER, 2n), transfer(TLIQ, BORROWER, VAULT, 7n), transfer(TLIQ, BORROWER, LENDER, 1n)];
    expect(moved(logs, WETH, null, BORROWER)).toBe(12n);
    expect(moved(logs, TLIQ, BORROWER, VAULT)).toBe(7n);
    expect(moved(logs, TLIQ, VAULT, BORROWER)).toBe(0n);
  });

  it('splits the principal into what reached the wallet and the fee left at the same source', () => {
    const TREASURY: Hex = '0x7777777777777777777777777777777777777777';
    const logs = [transfer(WETH, VAULT, BORROWER, 992n), transfer(WETH, VAULT, TREASURY, 8n), transfer(WETH, LENDER, TREASURY, 50n), transfer(TLIQ, VAULT, TREASURY, 3n)];
    expect(deliverySplit(logs, WETH, BORROWER)).toEqual({ received: 992n, fee: 8n });
    expect(deliverySplit([transfer(WETH, VAULT, TREASURY, 8n)], WETH, BORROWER)).toBeNull();
  });

  it('calls a leg done only at the expected figure', () => {
    expect(legVerdict(5n, 5n)).toBe('done');
    expect(legVerdict(4n, 5n)).toBe('unknown');
    expect(legVerdict(0n, 5n)).toBe('not-done');
  });
});
