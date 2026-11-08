import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import { depositBlockers, depositCall, depositChanged, deposited, depositPromptCount, depositShort, type DepositDraft, type DepositReview } from './deposit';
import { depositReceipt } from './depositReceipt';

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
const short = (v: bigint) => `short:${v}`;

const erc20Draft: DepositDraft = { standard: 'erc20', asset: TOKEN, tokenId: 0n, amount: 100n };
const nftDraft: DepositDraft = { standard: 'erc721', asset: NFT, tokenId: 7n, amount: 1n };
const multiDraft: DepositDraft = { standard: 'erc1155', asset: NFT, tokenId: 2n, amount: 5n };

function erc20(p: Partial<DepositReview> = {}, h: Partial<{ balance: bigint; allowance: bigint; approvalSteps: number }> = {}): DepositReview {
  return {
    identity: 'i',
    draft: erc20Draft,
    vault: VAULT,
    paused: false,
    frozen: null,
    retired: false,
    holding: { kind: 'erc20', balance: 500n, allowance: 0n, approvalSteps: 1, ...h },
    readAt: 0,
    ...p,
  };
}

function nft(owner: Hex | null, approvalSteps = 1): DepositReview {
  return { ...erc20(), draft: nftDraft, holding: { kind: 'erc721', state: { owner, approved: null, approvedForAll: false, blockNumber: 1n }, approvalSteps } };
}

function multi(balance: bigint, approvedForAll = false): DepositReview {
  return { ...erc20(), draft: multiDraft, holding: { kind: 'erc1155', state: { balance, approvedForAll, blockNumber: 1n }, approvalSteps: approvedForAll ? 0 : 2 } };
}

function depositLog(account: Hex, asset: Hex, kind: number, tokenId: bigint, amount: bigint, address: Hex = DIAMOND): Log {
  const topics = encodeEventTopics({ abi: VaultDepositoryFacetABI as Abi, eventName: 'VaultDeposited', args: { account, asset } });
  return { address, topics, data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }], [kind, tokenId, amount]) } as unknown as Log;
}

describe('depositCall', () => {
  it('passes the asset kind, a zero token id for an ERC-20 and one unit for an ERC-721', () => {
    expect(depositCall(erc20Draft).args).toEqual([0, TOKEN, 0n, 100n]);
    expect(depositCall(nftDraft).args).toEqual([1, NFT, 7n, 1n]);
    expect(depositCall(multiDraft).args).toEqual([2, NFT, 2n, 5n]);
    expect(depositCall(erc20Draft).functionName).toBe('depositToVault');
  });
});

describe('depositBlockers', () => {
  it('open when the wallet holds enough and nothing closes the deposit', () => {
    expect(depositBlockers(erc20(), ME, copy, short)).toEqual([]);
    expect(depositBlockers(nft(ME), ME, copy, short)).toEqual([]);
    expect(depositBlockers(multi(5n), ME, copy, short)).toEqual([]);
  });
  it('the pause, a flagged wallet and a retired wallet stop it, in that order', () => {
    expect(depositBlockers(erc20({ paused: true, frozen: 'flagged', retired: true }), ME, copy, short)).toEqual(['vaultDeposit.paused']);
    expect(depositBlockers(erc20({ frozen: 'flagged', retired: true }), ME, copy, short)).toEqual(['vaultDeposit.flagged']);
    expect(depositBlockers(erc20({ retired: true }), ME, copy, short)).toEqual(['vaultDeposit.retired']);
  });
  it('an unread pause, screen or retirement does not stop it: the dry run decides', () => {
    expect(depositBlockers(erc20({ paused: null, frozen: 'unknown', retired: null }), ME, copy, short)).toEqual([]);
  });
  it('states what the wallet is short of', () => {
    expect(depositBlockers(erc20({}, { balance: 40n }), ME, copy, short)).toEqual(['short:60']);
    expect(depositBlockers(multi(3n), ME, copy, short)).toEqual(['short:2']);
    expect(depositBlockers(nft(null), ME, copy, short)).toEqual(['vaultDeposit.noToken']);
    expect(depositBlockers(nft(OTHER), ME, copy, short)).toEqual(['vaultDeposit.notHeld']);
    expect(depositShort(nft(OTHER), ME)).toBe(1n);
  });
});

describe('depositPromptCount', () => {
  it('counts the approval steps, then the deposit', () => {
    expect(depositPromptCount(erc20({}, { approvalSteps: 0 }))).toBe(1);
    expect(depositPromptCount(erc20({}, { approvalSteps: 2 }))).toBe(3);
    expect(depositPromptCount(nft(ME, 0))).toBe(1);
    expect(depositPromptCount(nft(ME, 1))).toBe(2);
    // Granted for the deposit and taken back after it.
    expect(depositPromptCount(multi(5n))).toBe(3);
    expect(depositPromptCount(multi(5n, true))).toBe(1);
  });
});

describe('depositChanged', () => {
  it('nothing the review states moved', () => {
    expect(depositChanged(erc20(), erc20({}, { balance: 400n }), copy)).toBeNull();
  });
  it('a vault appearing, the pause, the screen, the approval or enough-or-not is a change', () => {
    expect(depositChanged(erc20({ vault: null }), erc20(), copy)).toBe('vaultDeposit.changedVault');
    expect(depositChanged(erc20(), erc20({ paused: true }), copy)).toBe('repay.changedVerdict');
    expect(depositChanged(erc20(), erc20({ frozen: 'flagged' }), copy)).toBe('repay.changedVerdict');
    expect(depositChanged(erc20(), erc20({}, { allowance: 10n }), copy)).toBe('repay.changedFunds');
    expect(depositChanged(erc20(), erc20({}, { balance: 10n }), copy)).toBe('repay.changedFunds');
    expect(depositChanged(nft(ME), nft(OTHER), copy)).toBe('repay.changedFunds');
    expect(depositChanged(multi(5n), multi(4n), copy)).toBe('repay.changedFunds');
  });
});

describe('deposited', () => {
  it('reads what the protocol credited this wallet for this asset', () => {
    expect(deposited([depositLog(ME, TOKEN, 0, 0n, 100n)], DIAMOND, ME, erc20Draft)).toBe(100n);
    expect(deposited([depositLog(ME, NFT, 1, 7n, 1n)], DIAMOND, ME, nftDraft)).toBe(1n);
    expect(deposited([depositLog(ME, NFT, 2, 2n, 5n)], DIAMOND, ME, multiDraft)).toBe(5n);
  });
  it('ignores another wallet, another token id, another emitter and another kind', () => {
    expect(deposited([depositLog(OTHER, TOKEN, 0, 0n, 100n)], DIAMOND, ME, erc20Draft)).toBeNull();
    expect(deposited([depositLog(ME, NFT, 1, 8n, 1n)], DIAMOND, ME, nftDraft)).toBeNull();
    expect(deposited([depositLog(ME, TOKEN, 0, 0n, 100n, OTHER)], DIAMOND, ME, erc20Draft)).toBeNull();
    expect(deposited([depositLog(ME, NFT, 2, 7n, 1n)], DIAMOND, ME, nftDraft)).toBeNull();
  });
});

describe('depositReceipt', () => {
  it('names a vault the deposit creates and every consequence it binds', () => {
    const r = depositReceipt(erc20({ vault: null }), null, copy);
    expect(r.rows.find((x) => x.label === 'vaultDeposit.rowInto')?.value).toEqual({ kind: 'text', text: 'vaultDeposit.intoNew' });
    expect(r.consequences).toContain('vaultDeposit.afterCreate');
    expect(r.consequences).toContain('vaultDeposit.afterExact');
    expect(r.consequences).toContain('vaultDeposit.noScreening');
    expect(r.consequences).toContain('vaultDeposit.approvalBack');
    expect(r.prompts).toBe(2);
  });
  it('states an unread pause or screen, and an ERC-1155 approval taken back', () => {
    const r = depositReceipt({ ...multi(5n), paused: null, frozen: 'unknown' }, null, copy);
    expect(r.consequences).toContain('vaultDeposit.pauseUnread');
    expect(r.consequences).toContain('vaultDeposit.screenUnread');
    expect(r.consequences.some((c) => typeof c === 'string' && c.startsWith('vaultDeposit.approvalOperatorBack'))).toBe(true);
    expect(r.consequences).not.toContain('vaultDeposit.afterExact');
  });
});
