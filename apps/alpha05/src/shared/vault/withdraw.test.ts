import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { VaultDepositoryFacetABI, VaultPayoutFacetABI } from '@vaipakam/contracts/abis';
import {
  escapeRequested,
  pauseStops,
  withdrawAmount,
  withdrawBlockers,
  withdrawCall,
  withdrawChanged,
  withdrawRequested,
  withdrawVia,
  type WithdrawDraft,
  type WithdrawReview,
} from './withdraw';
import { withdrawReceipt } from './withdrawReceipt';

type Hex = `0x${string}`;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Hex;
const ME = '0x00000000000000000000000000000000000000e1' as Hex;
const OTHER = '0x00000000000000000000000000000000000000e2' as Hex;
const TOKEN = '0x00000000000000000000000000000000000000a1' as Hex;
const NFT = '0x00000000000000000000000000000000000000b1' as Hex;
const VAULT = '0x00000000000000000000000000000000000000f1' as Hex;

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`,
};
const amountText = (v: bigint) => `${v}`;

const OPEN = { enabled: false, locked: false, delaySeconds: 0, requireCosign: false };
const PROTECTED = { enabled: true, locked: false, delaySeconds: 2 * 86_400, requireCosign: false };

const erc20Draft: WithdrawDraft = { standard: 'erc20', asset: TOKEN, tokenId: 0n, amount: 100n };
const nftDraft: WithdrawDraft = { standard: 'erc721', asset: NFT, tokenId: 7n, amount: 1n };

function review(p: Partial<WithdrawReview> = {}): WithdrawReview {
  const protection = p.protection === undefined ? OPEN : p.protection;
  const route = p.route ?? (protection === null ? 'unknown' : !protection.enabled ? 'wallet' : protection.locked ? 'held' : 'queued');
  return {
    identity: 'i',
    draft: erc20Draft,
    vault: VAULT,
    paused: false,
    escapeOpen: false,
    frozen: null,
    retired: false,
    withdrawable: 500n,
    dryRun: null,
    readAt: 0,
    ...p,
    protection,
    route,
    via: p.via === undefined ? withdrawVia({ paused: 'paused' in p ? p.paused! : false, escapeOpen: 'escapeOpen' in p ? p.escapeOpen! : false, protection }) : p.via,
  };
}

function requestLog(account: Hex, asset: Hex, kind: number, tokenId: bigint, amount: bigint, recipient: Hex, queued: boolean, address: Hex = DIAMOND): Log {
  const topics = encodeEventTopics({ abi: VaultDepositoryFacetABI as Abi, eventName: 'VaultWithdrawRequested', args: { account, asset } });
  const data = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bool' }],
    [kind, tokenId, amount, recipient, queued],
  );
  return { address, topics, data } as unknown as Log;
}

describe('withdrawCall', () => {
  it('withdraws from the wallet’s own vault to the wallet itself, one unit for an ERC-721', () => {
    expect(withdrawCall(erc20Draft, ME).args).toEqual([ME, 0, TOKEN, 0n, 100n, ME]);
    expect(withdrawCall({ ...nftDraft, amount: 9n }, ME).args).toEqual([ME, 1, NFT, 7n, 1n, ME]);
    expect(withdrawCall({ standard: 'erc1155', asset: NFT, tokenId: 2n, amount: 3n }, ME).args).toEqual([ME, 2, NFT, 2n, 3n, ME]);
    expect(withdrawAmount({ ...nftDraft, amount: 9n })).toBe(1n);
  });
  it('through the escape route: the asset, its token and amount, paid to the caller itself', () => {
    expect(withdrawCall(erc20Draft, ME, 'escape')).toMatchObject({ functionName: 'escapeWithdraw', args: [0, TOKEN, 0n, 100n] });
    expect(withdrawCall({ ...nftDraft, amount: 9n }, ME, 'escape').args).toEqual([1, NFT, 7n, 1n]);
  });
});

describe('pauseStops and withdrawVia', () => {
  it('a pause stops it until the escape route opens', () => {
    expect(pauseStops(review())).toBe(false);
    expect(pauseStops(review({ paused: true }))).toBe(true);
    expect(pauseStops(review({ paused: true, escapeOpen: true }))).toBe(false);
    expect(pauseStops(review({ paused: true, escapeOpen: true, protection: PROTECTED }))).toBe(false);
    expect(pauseStops(review({ paused: null }))).toBeNull();
    expect(pauseStops(review({ paused: true, escapeOpen: null, protection: PROTECTED }))).toBeNull();
    expect(pauseStops(review({ paused: true, escapeOpen: true, protection: null }))).toBeNull();
  });
  it('under an open escape route a wallet without protected mode goes through it; a protected one withdraws as usual', () => {
    expect(withdrawVia({ paused: false, escapeOpen: false, protection: OPEN })).toBe('withdraw');
    expect(withdrawVia({ paused: true, escapeOpen: false, protection: OPEN })).toBe('withdraw');
    expect(withdrawVia({ paused: true, escapeOpen: true, protection: OPEN })).toBe('escape');
    expect(withdrawVia({ paused: true, escapeOpen: true, protection: PROTECTED })).toBe('withdraw');
    expect(withdrawVia({ paused: null, escapeOpen: null, protection: OPEN })).toBe('withdraw');
    expect(withdrawVia({ paused: true, escapeOpen: true, protection: null })).toBeNull();
    expect(withdrawVia({ paused: true, escapeOpen: null, protection: OPEN })).toBeNull();
  });
});

describe('withdrawBlockers', () => {
  it('nothing stops a withdrawal within what is free', () => {
    expect(withdrawBlockers(review(), copy, amountText)).toEqual([]);
  });
  it('names the most fundamental stop first', () => {
    expect(withdrawBlockers(review({ vault: null, retired: true }), copy, amountText)).toEqual(['vaultWithdraw.noVault']);
    expect(withdrawBlockers(review({ retired: true, frozen: 'flagged' }), copy, amountText)).toEqual(['vaultWithdraw.retired']);
    expect(withdrawBlockers(review({ frozen: 'flagged', paused: true }), copy, amountText)).toEqual(['vaultWithdraw.flagged']);
    expect(withdrawBlockers(review({ paused: true }), copy, amountText)).toEqual(['vaultWithdraw.paused']);
    expect(withdrawBlockers(review({ paused: true, escapeOpen: true }), copy, amountText)).toEqual([]);
    expect(withdrawBlockers(review({ paused: true, escapeOpen: null }), copy, amountText)).toEqual(['vaultWithdraw.routeUnread']);
    expect(withdrawBlockers(review({ protection: { ...PROTECTED, locked: true } }), copy, amountText)).toEqual(['vaultWithdraw.locked']);
  });
  it('an amount over what is free is refused, with the free figure', () => {
    expect(withdrawBlockers(review({ withdrawable: 40n }), copy, amountText)).toEqual(['vaultWithdraw.overFree:{"free":"40"}']);
    expect(withdrawBlockers(review({ withdrawable: 0n }), copy, amountText)).toEqual(['vaultWithdraw.nothingFree']);
  });
  it('the protocol’s dry-run refusal stops it; an unread dry run does not', () => {
    const refusal = { code: 'TooManyPendingRows', reason: 'queue full', reopensAt: null, remedy: null };
    expect(withdrawBlockers(review({ dryRun: refusal }), copy, amountText)).toEqual(['vaultWithdraw.dryRunRefused:{"reason":"queue full"}']);
    expect(withdrawBlockers(review({ dryRun: 'unread' }), copy, amountText)).toEqual([]);
  });
});

describe('withdrawChanged', () => {
  it('nothing the review states moved', () => {
    expect(withdrawChanged(review(), review(), copy)).toBeNull();
  });
  it('the vault, the pause, the mode, the free figure or the dry run is a change', () => {
    expect(withdrawChanged(review(), review({ vault: null }), copy)).toBe('vaultWithdraw.changedVault');
    expect(withdrawChanged(review(), review({ paused: true }), copy)).toBe('repay.changedVerdict');
    expect(withdrawChanged(review(), review({ protection: PROTECTED }), copy)).toBe('payout.changed');
    expect(withdrawChanged(review({ protection: PROTECTED }), review({ protection: { ...PROTECTED, delaySeconds: 1 } }), copy)).toBe('payout.changed');
    expect(withdrawChanged(review(), review({ withdrawable: 50n }), copy)).toBe('repay.changedFunds');
    expect(withdrawChanged(review(), review({ withdrawable: 400n }), copy)).toBe('vaultWithdraw.changedFree');
    expect(withdrawChanged(review(), review({ dryRun: 'unread' }), copy)).toBe('repay.changedVerdict');
  });
});

describe('withdrawRequested', () => {
  it('reads what the protocol recorded for this wallet and whether it queued it', () => {
    expect(withdrawRequested([requestLog(ME, TOKEN, 0, 0n, 100n, ME, false)], DIAMOND, ME, erc20Draft)).toEqual({ amount: 100n, queued: false });
    expect(withdrawRequested([requestLog(ME, NFT, 1, 7n, 1n, ME, true)], DIAMOND, ME, nftDraft)).toEqual({ amount: 1n, queued: true });
  });
  it('ignores another wallet, another recipient, another token id and another emitter', () => {
    expect(withdrawRequested([requestLog(OTHER, TOKEN, 0, 0n, 100n, OTHER, false)], DIAMOND, ME, erc20Draft)).toBeNull();
    expect(withdrawRequested([requestLog(ME, TOKEN, 0, 0n, 100n, OTHER, false)], DIAMOND, ME, erc20Draft)).toBeNull();
    expect(withdrawRequested([requestLog(ME, NFT, 1, 8n, 1n, ME, false)], DIAMOND, ME, nftDraft)).toBeNull();
    expect(withdrawRequested([requestLog(ME, TOKEN, 0, 0n, 100n, ME, false, OTHER)], DIAMOND, ME, erc20Draft)).toBeNull();
  });
});

describe('escapeRequested', () => {
  it('reads the escape withdrawal the protocol recorded for this wallet and token', () => {
    const topics = encodeEventTopics({ abi: VaultPayoutFacetABI as Abi, eventName: 'EscapeWithdrawal', args: { account: ME, asset: TOKEN } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, 100n]);
    const log = { address: DIAMOND, topics, data } as unknown as Log;
    expect(escapeRequested([log], DIAMOND, ME, erc20Draft)).toBe(100n);
    expect(escapeRequested([log], DIAMOND, OTHER, erc20Draft)).toBeNull();
    expect(escapeRequested([{ ...log, address: OTHER } as Log], DIAMOND, ME, erc20Draft)).toBeNull();
  });
});

describe('withdrawReceipt', () => {
  it('pays this wallet at once without protected mode, from the stated vault', () => {
    const r = withdrawReceipt(review(), null, copy);
    expect(r.rows.find((x) => x.label === 'vaultWithdraw.rowTo')?.value).toEqual({ kind: 'text', text: 'vaultWithdraw.toWallet' });
    expect(r.rows.find((x) => x.label === 'vaultWithdraw.rowFrom')?.value).toEqual({ kind: 'text', text: VAULT });
    expect(r.rows.find((x) => x.label === 'vaultWithdraw.rowFreeAfter')?.value).toEqual({ kind: 'amount', asset: TOKEN, amount: 400n });
    expect(r.consequences).toContain('vaultWithdraw.onlyFree');
    expect(r.consequences).toContain('vaultWithdraw.onlyThisWallet');
    expect(r.consequences).toContain('vaultWithdraw.noApproval');
    expect(r.consequences).not.toContain('vaultWithdraw.queueCancel');
    expect(r.prompts).toBe(1);
  });
  it('with protected mode, the payout queue for the delay and how to cancel it', () => {
    const r = withdrawReceipt(review({ protection: { ...PROTECTED, requireCosign: true } }), null, copy);
    expect(r.rows.find((x) => x.label === 'vaultWithdraw.rowTo')?.value).toEqual({ kind: 'text', text: 'payout.toQueuedCosign:{"delay":"2 days"}' });
    expect(r.consequences).toContain('payout.queuedNote');
    expect(r.consequences).toContain('payout.cosignNote');
    expect(r.consequences).toContain('vaultWithdraw.queueCancel');
  });
  it('states an open escape route, an unread mode, pause, screen, free figure and dry run', () => {
    expect(withdrawReceipt(review({ paused: true, escapeOpen: true, protection: PROTECTED }), null, copy).consequences).toContain('vaultWithdraw.escapeOpen');
    const escape = withdrawReceipt(review({ paused: true, escapeOpen: true }), null, copy);
    expect(escape.consequences).toContain('vaultWithdraw.escapeRoute');
    expect(escape.rows.find((x) => x.label === 'vaultWithdraw.rowTo')?.value).toEqual({ kind: 'text', text: 'vaultWithdraw.toWalletEscape' });
    const r = withdrawReceipt(review({ protection: null, paused: null, frozen: 'unknown', withdrawable: null, dryRun: 'unread' }), null, copy);
    expect(r.rows.find((x) => x.label === 'vaultWithdraw.rowTo')?.value.kind).toBe('unknown');
    expect(r.consequences).toEqual(
      expect.arrayContaining(['payout.protectionUnread', 'vaultWithdraw.pauseUnread', 'vaultDeposit.screenUnread', 'vaultWithdraw.freeUnread', 'vaultWithdraw.dryRunUnread']),
    );
  });
});
