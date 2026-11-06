/**
 * The approval half of a flow that pledges one ERC-721 token (RB-FUNDS):
 * the wallet lets the protocol move that one token, never the collection.
 * The approval read back is the truth: a step counts only when the token's
 * approved address reads the protocol after it, at the block its receipt
 * mined in, whatever the receipt says. When what it was for does not go
 * through, the approval is put back, but only while it still reads the
 * protocol and the wallet still holds the token; anything else is stated,
 * never overwritten. A token the protocol takes clears its own approval
 * (ERC-721 resets it on every transfer), so a pledge that lands leaves
 * nothing standing.
 */
import type { Config } from 'wagmi';
import { waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { NFT_ABI, readErc721, type Erc721State } from '../nft/nft';

type Hex = `0x${string}`;

export const NO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';

export interface NftApprovalDeps {
  own: OwnStateClient;
  config: Config;
  chainId: number;
  diamond: Hex;
  copy: Pick<CopyAccess, 'text' | 'format'>;
  /** The token as the page names it ("Test NFT #7"). */
  tokenName: string;
  setStep: (what: string | null) => void;
}

export interface NftApproval {
  read: (block?: bigint) => Promise<Erc721State>;
  /** Approves the protocol for the token, overwriting `prior` (the approved
   *  address read just before; the caller names the prompt). Throws a stated refusal when the approval or
   *  the holder moved meanwhile or the step did not land. */
  approve: (prior: Hex | null) => Promise<void>;
  /** Puts the approval back to `prior`, only while it still reads the
   *  protocol and the wallet still holds the token, and says what happened. */
  putBack: (prior: Hex | null) => Promise<{ ok: boolean; sentence: string }>;
}

function same(a: Hex | null, b: Hex | null): boolean {
  return (a ?? NO_ADDRESS).toLowerCase() === (b ?? NO_ADDRESS).toLowerCase();
}

export function nftApproval(d: NftApprovalDeps, asset: Hex, tokenId: bigint): NftApproval {
  const { own, config, chainId, diamond, copy } = d;
  const { text, format } = copy;
  const account = own.account;

  // The newest block this flow saw its own approval step mine in. A later
  // read without a named block never describes the token as it stood before
  // that block, whichever node answers: put-back would otherwise read the
  // approval as already restored and leave the protocol approved.
  let floor = 0n;
  const read = (block?: bigint) =>
    own
      .read(async (c) => {
        const head = block ?? (await c.getBlockNumber({ cacheTime: 0 }));
        return readErc721(c, asset, tokenId, account, diamond, head < floor ? floor : head);
      })
      .then((x) => x.value);

  async function setTo(to: Hex): Promise<{ landed: boolean; hash: Hex | null; now: Erc721State | null }> {
    const hash = await writeContract(config, { address: asset, abi: NFT_ABI, functionName: 'approve', args: [to, tokenId], chainId, account });
    let block: bigint;
    try {
      block = (await waitForTransactionReceipt(config, { hash, chainId })).blockNumber;
    } catch {
      return { landed: false, hash, now: null };
    }
    if (block > floor) floor = block;
    // A read-back that fails is missing evidence, not a failure: the hash is
    // kept, so the caller states the step as unverified (it may have landed).
    const now = await read(block).catch(() => null);
    return { landed: now !== null && same(now.approved, to), hash: now === null ? hash : null, now };
  }

  async function approve(prior: Hex | null): Promise<void> {
    const before = await read();
    if (before.owner === null || !same(before.owner, account) || !same(before.approved, prior)) {
      throw new StatedRefusal({ code: 'NftApprovalChanged', reason: text('nftApproval.moved'), reopensAt: null, remedy: null });
    }
    // The caller names this prompt in its own step count.
    const r = await setTo(diamond);
    if (r.landed) return;
    throw new StatedRefusal({
      code: r.hash !== null ? 'NftApprovalUnverified' : 'NftApprovalNotSet',
      reason: r.hash !== null ? format('nftApproval.unread', { hash: r.hash }) : format('nftApproval.notSet', { token: d.tokenName }),
      reopensAt: null,
      remedy: null,
    });
  }

  async function putBack(prior: Hex | null): Promise<{ ok: boolean; sentence: string }> {
    try {
      const now = await read();
      if (now.owner === null || !same(now.owner, account)) return { ok: true, sentence: text('nftApproval.notHeld') };
      if (same(now.approved, prior)) return { ok: true, sentence: text('nftApproval.restored') };
      if (!same(now.approved, diamond)) return { ok: false, sentence: text('nftApproval.restoreChanged') };
      d.setStep(text('nftApproval.stepRestore'));
      const r = await setTo(prior ?? NO_ADDRESS);
      if (r.landed) return { ok: true, sentence: text('nftApproval.restored') };
      return { ok: false, sentence: r.hash !== null ? format('nftApproval.restorePending', { hash: r.hash }) : text('nftApproval.restoreNotLanded') };
    } catch (e) {
      return { ok: false, sentence: format('nftApproval.restoreFailed', { reason: refusalFromError(e).reason }) };
    } finally {
      d.setStep(null);
    }
  }

  return { read, approve, putBack };
}
