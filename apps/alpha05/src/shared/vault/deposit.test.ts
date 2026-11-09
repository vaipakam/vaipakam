import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import { VaultDepositoryFacetABI, VPFIDiscountFacetABI } from '@vaipakam/contracts/abis';
import {
  depositBlockers,
  depositCall,
  depositChanged,
  deposited,
  depositPromptCount,
  depositRoute,
  depositShort,
  permitDepositCall,
  signOffered,
  vpfiDeposited,
  type DepositDraft,
  type DepositReview,
} from './deposit';
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

const OPEN = { enabled: false, locked: false, delaySeconds: 0, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
const PROTECTED = {
  enabled: true,
  locked: false,
  delaySeconds: 3 * 86_400,
  requireCosign: false,
  retired: false,
  controller: '0x0000000000000000000000000000000000000000' as const,
};

const erc20Draft: DepositDraft = { standard: 'erc20', asset: TOKEN, tokenId: 0n, amount: 100n };
const nftDraft: DepositDraft = { standard: 'erc721', asset: NFT, tokenId: 7n, amount: 1n };
const multiDraft: DepositDraft = { standard: 'erc1155', asset: NFT, tokenId: 2n, amount: 5n };

function erc20(p: Partial<DepositReview> = {}, h: Partial<{ balance: bigint; allowance: bigint; approvalSteps: number }> = {}): DepositReview {
  return {
    identity: 'i',
    vpfi: null,
    permit: null,
    draft: erc20Draft,
    vault: VAULT,
    paused: false,
    frozen: null,
    retired: false,
    protection: OPEN,
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
  it('protected mode turning on, a lock, a new delay or a secondary signer is a change', () => {
    expect(depositChanged(erc20(), erc20({ protection: PROTECTED }), copy)).toBe('payout.changed');
    expect(depositChanged(erc20({ protection: PROTECTED }), erc20({ protection: { ...PROTECTED, locked: true } }), copy)).toBe('payout.changed');
    expect(depositChanged(erc20({ protection: PROTECTED }), erc20({ protection: { ...PROTECTED, delaySeconds: 86_400 } }), copy)).toBe('payout.changed');
    expect(depositChanged(erc20({ protection: PROTECTED }), erc20({ protection: { ...PROTECTED, requireCosign: true } }), copy)).toBe('payout.changed');
    expect(depositChanged(erc20(), erc20({ protection: null }), copy)).toBe('payout.changed');
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
  it('states how the deposit can leave again under the account’s protected mode', () => {
    const later = (p: DepositReview['protection']) => {
      const r = depositReceipt(erc20({ protection: p }), null, copy);
      return { row: r.rows.find((x) => x.label === 'vaultDeposit.rowLater')?.value, consequences: r.consequences };
    };
    const open = later(OPEN);
    expect(open.row).toEqual({ kind: 'text', text: 'vaultDeposit.laterWallet' });
    expect(open.consequences).toContain('vaultDeposit.afterCounted');
    const queued = later(PROTECTED);
    expect(queued.row).toEqual({ kind: 'text', text: 'vaultDeposit.laterQueued:{"delay":"3 days"}' });
    expect(queued.consequences).toContain('vaultDeposit.afterQueued:{"delay":"3 days"}');
    expect(queued.consequences).not.toContain('vaultDeposit.afterCounted');
    expect(later({ ...PROTECTED, requireCosign: true }).consequences).toContain('vaultDeposit.afterCosign');
    const locked = later({ ...PROTECTED, locked: true });
    expect(locked.row).toEqual({ kind: 'text', text: 'vaultDeposit.laterLocked' });
    expect(locked.consequences).toContain('vaultDeposit.afterLocked');
    expect(locked.consequences).not.toContain('vaultDeposit.afterCounted');
    const unread = later(null);
    expect(unread.row).toEqual({ kind: 'text', text: 'vaultDeposit.laterUnread' });
    expect(unread.consequences).toContain('vaultDeposit.afterUnread');
  });
});

describe('signing instead of approving (RW-03)', () => {
  const VPFI = { tracked: 0n, consent: true, home: true };
  const vpfi = (allowance: bigint | null, deployed = true, h: Partial<{ balance: bigint; allowance: bigint; approvalSteps: number }> = {}) =>
    erc20({ vpfi: VPFI, permit: { deployed, allowance: deployed ? allowance : null } }, h);

  it('is offered for VPFI only where Permit2 is here and the wallet’s approval for it covers the amount', () => {
    expect(signOffered(vpfi(100n))).toBe(true);
    expect(signOffered(vpfi(99n))).toBe(false);
    expect(signOffered(vpfi(null))).toBe(false);
    expect(signOffered(vpfi(10n ** 30n, false))).toBe(false);
    // Any other asset carries no route, whatever was read.
    expect(signOffered(erc20({ permit: { deployed: true, allowance: 10n ** 30n } }))).toBe(false);
  });
  it('takes the chosen route only when it is offered; the approval is always there', () => {
    expect(depositRoute(vpfi(100n), 'sign')).toBe('sign');
    expect(depositRoute(vpfi(100n), null)).toBe('approve');
    expect(depositRoute(vpfi(99n), 'sign')).toBe('approve');
  });
  it('asks for one signature and the deposit, whatever the approval would have taken', () => {
    expect(depositPromptCount(vpfi(100n, true, { approvalSteps: 2 }), 'sign')).toBe(2);
    expect(depositPromptCount(vpfi(100n, true, { approvalSteps: 2 }))).toBe(3);
  });
  it('on the signed route, a change to the protocol’s approval is not one; losing the route is', () => {
    expect(depositChanged(vpfi(100n), vpfi(100n, true, { allowance: 50n, approvalSteps: 0 }), copy, 'sign')).toBeNull();
    expect(depositChanged(vpfi(100n), vpfi(100n, true, { allowance: 50n, approvalSteps: 0 }), copy)).toBe('repay.changedFunds');
    expect(depositChanged(vpfi(100n), vpfi(10n), copy, 'sign')).toBe('vpfiPermit.changed');
  });
  it('calls the VPFI entry with the amount, the signed transfer and the signature', () => {
    const permit = { permitted: { token: TOKEN, amount: 100n }, nonce: 7n, deadline: 99n };
    const call = permitDepositCall(100n, permit, '0xab');
    expect(call.functionName).toBe('depositVPFIToVaultWithPermit');
    expect(call.args).toEqual([100n, permit, '0xab']);
  });
  it('reads the credit from the VPFI entry’s own event, for this wallet only', () => {
    const log = (user: Hex, address: Hex = DIAMOND): Log => {
      const topics = encodeEventTopics({ abi: VPFIDiscountFacetABI as Abi, eventName: 'VPFIDepositedToVault', args: { user } });
      return { address, topics, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [100n, 300n]) } as unknown as Log;
    };
    expect(vpfiDeposited([log(ME)], DIAMOND, ME)).toBe(100n);
    expect(vpfiDeposited([log(OTHER)], DIAMOND, ME)).toBeNull();
    expect(vpfiDeposited([log(ME, OTHER)], DIAMOND, ME)).toBeNull();
  });
  it('the receipt names the signature in place of the approval, how long it lasts and that nothing is put back', () => {
    const r = depositReceipt(vpfi(100n), null, copy, 'sign');
    const row = r.rows.find((x) => x.label === 'vpfiPermit.row');
    expect(row).toBeDefined();
    expect(r.rows.some((x) => x.label === 'repay.rowApproval')).toBe(false);
    expect(r.prompts).toBe(2);
    expect(r.consequences.some((c) => typeof c === 'string' && c.startsWith('vpfiPermit.after:'))).toBe(true);
    expect(r.consequences).toContain('vpfiPermit.kept');
    expect(r.consequences).not.toContain('vaultDeposit.approvalBack');
  });
});
