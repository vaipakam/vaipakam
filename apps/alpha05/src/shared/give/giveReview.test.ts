import { encodeErrorResult, type Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM, PositionNFTABI } from '@vaipakam/contracts/abis';
import { checkReceiver, giveBlockers, giveChangedBetween, owedAhead, receiverDiscount, transferRefusal, type GiveReview } from './giveReview';

type Hex = `0x${string}`;
const dep = Object.values(DEPLOYMENTS as Record<string, { diamond?: Hex; positionNFT?: Hex }>).find((d) => d.diamond && d.positionNFT)!;
const DIAMOND = dep.diamond!;
const GIVER = '0x00000000000000000000000000000000000000a1' as Hex;
const TO = '0x00000000000000000000000000000000000000b2' as Hex;
/** A copy stand-in that returns the key and its values. */
const c = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v ? JSON.stringify(v) : ''}` } as never;

function revert(abi: Abi, errorName: string, args: readonly unknown[]) {
  const raw = encodeErrorResult({ abi, errorName, args });
  return Object.assign(new Error('reverted'), { cause: { raw } });
}

describe('checkReceiver', () => {
  it('takes a wallet address and refuses the rest', () => {
    expect(checkReceiver(` ${TO} `, GIVER, DIAMOND)).toEqual({ ok: true, receiver: TO });
    expect(checkReceiver('', GIVER, DIAMOND)).toEqual({ ok: false, problem: 'empty' });
    expect(checkReceiver('0x12', GIVER, DIAMOND)).toEqual({ ok: false, problem: 'invalid' });
    expect(checkReceiver('0x0000000000000000000000000000000000000000', GIVER, DIAMOND)).toEqual({ ok: false, problem: 'invalid' });
    expect(checkReceiver(GIVER.toUpperCase().replace('0X', '0x'), GIVER, DIAMOND)).toEqual({ ok: false, problem: 'self' });
    expect(checkReceiver(DIAMOND, GIVER, DIAMOND)).toEqual({ ok: false, problem: 'contract-of-platform' });
    expect(checkReceiver(dep.positionNFT!, GIVER, DIAMOND)).toEqual({ ok: false, problem: 'contract-of-platform' });
  });
});

describe('what the receiver gets and carries', () => {
  it('sums the seller claims ahead of the holder, net of the loan fee', () => {
    const o = owedAhead([{ seller: GIVER, grossOwed: 600n }, { seller: TO, grossOwed: 400n }], 1000);
    expect(o.gross).toBe(1000n);
    expect(o.net).toBe(900n);
    expect(owedAhead([], 1000).gross).toBe(0n);
  });
  it('carries the lower of the loan figure and the receiver standing', () => {
    expect(receiverDiscount(1500, 900).appliesBps).toBe(900);
    expect(receiverDiscount(0, 2000).appliesBps).toBe(0);
  });
});

describe('transferRefusal', () => {
  it('names each refusal of the transfer check with its reason', () => {
    const cool = transferRefusal(revert(DIAMOND_ABI_VIEM as Abi, 'PositionCoolingDown', [5n, 10n, 1_900_000_000n]), c);
    expect(cool.code).toBe('PositionCoolingDown');
    expect(cool.reopensAt).toBe(1_900_000_000_000);
    expect(transferRefusal(revert(DIAMOND_ABI_VIEM as Abi, 'PositionToVault', [TO]), c).reason).toBe('give.refToVault');
    expect(transferRefusal(revert(DIAMOND_ABI_VIEM as Abi, 'SanctionedAddress', [TO]), c).code).toBe('SanctionedAddress');
    expect(transferRefusal(revert(PositionNFTABI as Abi, 'HolderIsLocked', [GIVER]), c).reason).toBe('give.refLocked');
    expect(transferRefusal(revert(DIAMOND_ABI_VIEM as Abi, 'TransferFromRetiredAccount', [GIVER, TO]), c).reason).toBe('give.refReplaced');
  });
});

describe('blockers and changes', () => {
  const base = {
    identity: 'x',
    loanId: 1n,
    receiver: TO,
    loan: { status: 0n } as unknown as GiveReview['loan'],
    tokenId: 3n,
    holder: GIVER,
    owed: owedAhead([], 0),
    heldForLender: 0n,
    discount: receiverDiscount(10, 20),
    dryRun: { kind: 'passes' },
    block: 1n,
    readAt: 1,
  } as GiveReview;
  it('lets the holder of a running loan give when the dry run passes', () => {
    expect(giveBlockers(base, GIVER, c)).toEqual([]);
    expect(giveBlockers(base, TO, c)).toHaveLength(1);
    expect(giveBlockers({ ...base, dryRun: { kind: 'refused', refusal: { code: 'X', reason: 'no', reopensAt: null, remedy: null } } }, GIVER, c)[0]).toContain('give.blockRefused');
  });
  it('reopens the review when what it states changed', () => {
    expect(giveChangedBetween(base, base, c)).toBeNull();
    expect(giveChangedBetween(base, { ...base, owed: owedAhead([{ seller: GIVER, grossOwed: 1n }], 0) }, c)).not.toBeNull();
    expect(giveChangedBetween(base, { ...base, holder: TO }, c)).not.toBeNull();
  });
});
