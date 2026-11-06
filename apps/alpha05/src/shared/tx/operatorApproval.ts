/**
 * The approval half of a flow that pledges a quantity of one ERC-1155 token
 * (RB-NFT-APPROVAL). ERC-1155 has no approval for one token: the only way to
 * let the protocol move it is an operator approval over the whole
 * collection. So the flow grants it for the action alone and takes it back
 * on every ending, the action's success included, unless the wallet had
 * already granted it before (then it is left exactly as the wallet set it).
 * The approval read back is the truth: a step counts only when
 * `isApprovedForAll` reads what it set at the block its receipt mined in,
 * and a read after the approval never looks at a block before it, whichever
 * node answers, so a revoke is never skipped as already done.
 */
import type { Config } from 'wagmi';
import { waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { NFT_ABI, readErc1155, type Erc1155State } from '../nft/nft';

type Hex = `0x${string}`;

export interface OperatorApprovalDeps {
  own: OwnStateClient;
  config: Config;
  chainId: number;
  diamond: Hex;
  copy: Pick<CopyAccess, 'text' | 'format'>;
  /** The collection as the page names it ("vMULTI"). */
  collection: string;
  setStep: (what: string | null) => void;
}

export interface OperatorApproval {
  read: (block?: bigint) => Promise<Erc1155State>;
  /** Grants the protocol the operator approval (the caller names the
   *  prompt) and resolves with the block it mined in. Throws a stated
   *  refusal when it was granted meanwhile, or the step did not land. */
  grant: () => Promise<bigint>;
  /** Takes the approval back, only while it still reads granted, reading
   *  no earlier than `since` (the block the grant mined in), and says what
   *  happened. */
  revoke: (since: bigint) => Promise<{ ok: boolean; sentence: string }>;
}

export function operatorApproval(d: OperatorApprovalDeps, asset: Hex, tokenId: bigint): OperatorApproval {
  const { own, config, chainId, diamond, copy } = d;
  const { text, format } = copy;
  const account = own.account;

  const read = (block?: bigint) => own.read((c) => readErc1155(c, asset, tokenId, account, diamond, block)).then((x) => x.value);
  const readSince = (since: bigint) =>
    own
      .read(async (c) => {
        const head = await c.getBlockNumber({ cacheTime: 0 });
        return readErc1155(c, asset, tokenId, account, diamond, head < since ? since : head);
      })
      .then((x) => x.value);

  async function setTo(on: boolean): Promise<{ landed: boolean; hash: Hex | null; at: bigint | null }> {
    const hash = await writeContract(config, { address: asset, abi: NFT_ABI, functionName: 'setApprovalForAll', args: [diamond, on], chainId, account });
    let block: bigint;
    try {
      block = (await waitForTransactionReceipt(config, { hash, chainId })).blockNumber;
    } catch {
      return { landed: false, hash, at: null };
    }
    // A read-back that fails is missing evidence: the hash is kept, so the
    // caller states the step as unverified (it may have landed).
    const now = await read(block).catch(() => null);
    return { landed: now !== null && now.approvedForAll === on, hash: now === null ? hash : null, at: block };
  }

  async function grant(): Promise<bigint> {
    const before = await read();
    if (before.approvedForAll) throw new StatedRefusal({ code: 'OperatorApprovalChanged', reason: text('operatorApproval.moved'), reopensAt: null, remedy: null });
    const r = await setTo(true);
    if (r.landed && r.at !== null) return r.at;
    throw new StatedRefusal({
      code: r.hash !== null ? 'OperatorApprovalUnverified' : 'OperatorApprovalNotSet',
      reason: r.hash !== null ? format('operatorApproval.unread', { hash: r.hash, collection: d.collection }) : format('operatorApproval.notSet', { collection: d.collection }),
      reopensAt: null,
      remedy: null,
    });
  }

  async function revoke(since: bigint): Promise<{ ok: boolean; sentence: string }> {
    try {
      const now = await readSince(since);
      if (!now.approvedForAll) return { ok: true, sentence: format('operatorApproval.revoked', { collection: d.collection }) };
      d.setStep(format('operatorApproval.stepRevoke', { collection: d.collection }));
      const r = await setTo(false);
      if (r.landed) return { ok: true, sentence: format('operatorApproval.revoked', { collection: d.collection }) };
      return {
        ok: false,
        sentence: r.hash !== null ? format('operatorApproval.revokePending', { hash: r.hash, collection: d.collection }) : format('operatorApproval.revokeNotLanded', { collection: d.collection }),
      };
    } catch (e) {
      return { ok: false, sentence: format('operatorApproval.revokeFailed', { collection: d.collection, reason: refusalFromError(e).reason }) };
    } finally {
      d.setStep(null);
    }
  }

  return { read, grant, revoke };
}
