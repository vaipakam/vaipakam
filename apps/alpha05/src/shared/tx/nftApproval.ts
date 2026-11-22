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
import { waitForTransactionReceipt } from 'wagmi/actions';
import { sendWrite } from './send';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import type { CleanUpResult } from './cleanUp';
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
   *  address read just before; the caller names the prompt), and resolves
   *  with the block the approval mined in. Throws a stated refusal when the
   *  approval or the holder moved meanwhile or the step did not land. An
   *  approval that mined but could not be read back is put back before it
   *  throws, so no ending leaves it standing unstated. */
  approve: (prior: Hex | null) => Promise<bigint>;
  /** Puts the approval back to `prior`, only while it still reads the
   *  protocol and the wallet still holds the token, and says what happened.
   *  `since` is the block the approval mined in: the token is never read as
   *  it stood before it, whichever node answers, so a reset is never skipped
   *  as already done. */
  putBack: (prior: Hex | null, since: bigint) => Promise<CleanUpResult>;
}

function same(a: Hex | null, b: Hex | null): boolean {
  return (a ?? NO_ADDRESS).toLowerCase() === (b ?? NO_ADDRESS).toLowerCase();
}

export function nftApproval(d: NftApprovalDeps, asset: Hex, tokenId: bigint): NftApproval {
  const { own, config, chainId, diamond, copy } = d;
  const { text, format } = copy;
  const account = own.account;

  const read = (block?: bigint) => own.read((c) => readErc721(c, asset, tokenId, account, diamond, block)).then((x) => x.value);
  /** The token now, but never as it stood before block `since`. */
  const readSince = (since: bigint) =>
    own
      .read(async (c) => {
        const head = await c.getBlockNumber({ cacheTime: 0 });
        return readErc721(c, asset, tokenId, account, diamond, head < since ? since : head);
      })
      .then((x) => x.value);

  async function setTo(to: Hex): Promise<{ landed: boolean; hash: Hex | null; now: Erc721State | null; at: bigint | null }> {
    const hash = await sendWrite(config, { address: asset, abi: NFT_ABI, functionName: 'approve', args: [to, tokenId], chainId, account });
    let block: bigint;
    try {
      block = (await waitForTransactionReceipt(config, { hash, chainId })).blockNumber;
    } catch {
      return { landed: false, hash, now: null, at: null };
    }
    // A read-back that fails is missing evidence, not a failure: the hash is
    // kept, so the caller states the step as unverified (it may have landed).
    const now = await read(block).catch(() => null);
    return { landed: now !== null && same(now.approved, to), hash: now === null ? hash : null, now, at: block };
  }

  async function approve(prior: Hex | null): Promise<bigint> {
    const before = await read();
    if (before.owner === null || !same(before.owner, account) || !same(before.approved, prior)) {
      throw new StatedRefusal({ code: 'NftApprovalChanged', reason: text('nftApproval.moved'), reopensAt: null, remedy: null });
    }
    // The caller names this prompt in its own step count.
    const r = await setTo(diamond);
    if (r.landed && r.at !== null) return r.at;
    if (r.hash !== null && r.at !== null) {
      // Mined, but what it set could not be read: the caller holds nothing
      // to put back yet, so it is put back here (read no earlier than the
      // block it mined in) and the outcome is stated.
      const back = await putBack(prior, r.at);
      throw new StatedRefusal({
        code: 'NftApprovalUnverified',
        reason: `${format('nftApproval.unreadMined', { hash: r.hash })} ${back.sentence}`,
        reopensAt: null,
        remedy: null,
      });
    }
    throw new StatedRefusal({
      code: r.hash !== null ? 'NftApprovalUnverified' : 'NftApprovalNotSet',
      reason: r.hash !== null ? format('nftApproval.unread', { hash: r.hash }) : format('nftApproval.notSet', { token: d.tokenName }),
      reopensAt: null,
      remedy: null,
    });
  }

  async function putBack(prior: Hex | null, since: bigint): Promise<CleanUpResult> {
    try {
      const now = await readSince(since);
      if (now.owner === null || !same(now.owner, account)) return { status: 'done', sentence: text('nftApproval.notHeld') };
      if (same(now.approved, prior)) return { status: 'done', sentence: text('nftApproval.restored') };
      if (!same(now.approved, diamond)) return { status: 'not-done', sentence: text('nftApproval.restoreChanged') };
      d.setStep(text('nftApproval.stepRestore'));
      const r = await setTo(prior ?? NO_ADDRESS);
      if (r.landed) return { status: 'done', sentence: text('nftApproval.restored') };
      // A reset that was sent but whose effect could not be read may have landed.
      return r.hash !== null
        ? { status: 'unknown', sentence: format('nftApproval.restorePending', { hash: r.hash }) }
        : { status: 'not-done', sentence: text('nftApproval.restoreNotLanded') };
    } catch (e) {
      // Thrown before anything landed: the read before, or the wallet's refusal.
      return { status: 'not-done', sentence: format('nftApproval.restoreFailed', { reason: refusalFromError(e).reason }) };
    } finally {
      d.setStep(null);
    }
  }

  return { read, approve, putBack };
}
