import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConfig } from 'wagmi';
import { watchAsset, writeContract } from 'wagmi/actions';
import { useOwnStateClient } from '../../chain/ownRail';
import { getSupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { ERC20_MINT_UNITS, FAUCET_ERC20_ABI, FAUCET_NFT_ABI, faucetAssets, freshTokenId, type FaucetAsset } from '../../shared/faucet/faucet';
import { WhyLink } from '../../shared/help/WhyLink';
import type { Receipt } from '../../shared/receipt/types';
import { assetName, useTokenMeta } from '../../shared/reads/tokens';
import { refusalFromError } from '../../shared/eligibility/refusal';
import { askThrough, simulateCall } from '../../shared/tx/simulate';
import { holdsFlow } from '../../shared/tx/txStore';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { shortAddress } from '../../shared/ui/format';

type Hex = `0x${string}`;

/** The mint the open review was built for. */
type MintPick =
  | { kind: 'erc20'; asset: Extract<FaucetAsset, { kind: 'erc20' }>; amount: bigint; readAt: number; identity: string }
  | { kind: 'nft'; asset: Extract<FaucetAsset, { kind: 'nft' }>; tokenId: bigint; readAt: number; identity: string };

/** The moment a review's inputs were read (called from event handlers). */
const readNow = () => Date.now();

const NEXT_STEPS = [
  { to: '/borrow', key: 'home.intentBorrow' },
  { to: '/lend', key: 'home.intentLend' },
  { to: '/rent', key: 'home.intentRent' },
  { to: '/positions', key: 'home.intentManage' },
] as const;

/**
 * ACC-63 — "Get test assets", shown only on a testnet whose deployment record
 * publishes them. Each mint is an ordinary write with its receipt, progress
 * and measured outcome (the balance or the NFT's owner read back), and it
 * says plainly that the test token contract mints, not the protocol. A
 * successful mint offers the next jobs and, for a token, a wallet prompt to
 * show it.
 */
export function Faucet() {
  const { text, format } = useCopy();
  const config = useConfig();
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId);
  const assets = chain ? faucetAssets(chain) : null;
  const meta = useTokenMeta(assets?.map((a) => a.address) ?? []).data;
  const [pick, setPick] = useState<MintPick | null>(null);
  const [watch, setWatch] = useState<'idle' | 'asked' | 'declined'>('idle');
  /** The ERC-20 balance read right before the wallet opened. */
  const before = useRef<bigint | null>(null);
  const account = (own?.account ?? '0x') as Hex;

  const tx = useTrackedTx({
    key: 'home.faucet',
    chainId: chain?.chainId ?? 0,
    account,
    send: () => {
      if (!pick || !chain) throw new Error('no mint under review');
      return pick.kind === 'erc20'
        ? writeContract(config, { address: pick.asset.address, abi: FAUCET_ERC20_ABI, functionName: 'mint', args: [account, pick.amount], chainId: chain.chainId, account })
        : writeContract(config, { address: pick.asset.address, abi: FAUCET_NFT_ABI, functionName: 'mint', args: [account, pick.tokenId], chainId: chain.chainId, account });
    },
    measure: async () => {
      if (!pick || !own) return [];
      if (pick.kind === 'erc20') {
        const amount = pick.amount;
        const label = format('faucet.legToken', { symbol: assetName(pick.asset.address, meta ?? null) });
        const after = (await own.read((c) => c.readContract({ address: pick.asset.address, abi: FAUCET_ERC20_ABI, functionName: 'balanceOf', args: [account] }))).value;
        if (before.current === null) return [{ status: 'unknown', label, reason: text('faucet.noBefore') }];
        const rose = after - before.current;
        if (rose >= amount) return [{ status: 'done', label }];
        return [{ status: 'not-done', label, reason: format('faucet.roseBy', { amount: rose.toString() }) }];
      }
      const tokenId = pick.tokenId;
      const label = format('faucet.legNft', { symbol: assetName(pick.asset.address, meta ?? null), id: tokenId.toString() });
      // Only the contract's own refusal says "not minted"; a read no source
      // could run says nothing about the chain, so the leg stays unknown.
      const owner = await askThrough(own, (c) => c.readContract({ address: pick.asset.address, abi: FAUCET_NFT_ABI, functionName: 'ownerOf', args: [tokenId] }));
      if (owner.kind === 'unreadable') return [{ status: 'unknown', label, reason: format('faucet.ownerUnknown', { reason: owner.reason }) }];
      if (owner.kind === 'reverted') return [{ status: 'not-done', label, reason: text('faucet.notMinted') }];
      return owner.value.toLowerCase() === account.toLowerCase() ? [{ status: 'done', label }] : [{ status: 'not-done', label, reason: text('faucet.notYours') }];
    },
  });

  if (!own || !chain || !assets) return null;

  const decimalsOf = (a: Hex) => meta?.[a.toLowerCase()]?.decimals ?? null;

  const start = (asset: FaucetAsset) => {
    setWatch('idle');
    before.current = null;
    if (asset.kind === 'erc20') {
      const decimals = decimalsOf(asset.address);
      if (decimals === null) return;
      setPick({ kind: 'erc20', asset, amount: ERC20_MINT_UNITS * 10n ** BigInt(decimals), readAt: readNow(), identity: reviewIdentity(own) });
    } else {
      setPick({ kind: 'nft', asset, tokenId: freshTokenId(), readAt: readNow(), identity: reviewIdentity(own) });
    }
    // A review left open when this page last unmounted has lost its inputs.
    if (tx.phase.kind !== 'idle') tx.reset();
    tx.review();
  };

  const recheck = async (): Promise<Recheck> => {
    if (!pick) return { kind: 'unreadable', reason: text('flow.reading') };
    if (pick.kind === 'erc20') {
      try {
        before.current = (await own.read((c) => c.readContract({ address: pick.asset.address, abi: FAUCET_ERC20_ABI, functionName: 'balanceOf', args: [account] }))).value;
      } catch (e) {
        return { kind: 'unreadable', reason: refusalFromError(e).reason };
      }
      return simulateCall(own, { address: pick.asset.address, abi: FAUCET_ERC20_ABI, functionName: 'mint', args: [account, pick.amount] });
    }
    // An NFT number already minted is replaced before the wallet opens.
    const tokenId = pick.tokenId;
    const owner = await askThrough(own, (c) => c.readContract({ address: pick.asset.address, abi: FAUCET_NFT_ABI, functionName: 'ownerOf', args: [tokenId] }));
    if (owner.kind === 'unreadable') return { kind: 'unreadable', reason: owner.reason };
    if (owner.kind === 'answered') {
      setPick({ ...pick, tokenId: freshTokenId(), readAt: readNow() });
      return { kind: 'changed', what: text('faucet.changedId') };
    }
    return simulateCall(own, { address: pick.asset.address, abi: FAUCET_NFT_ABI, functionName: 'mint', args: [account, tokenId] });
  };

  const receipt: Receipt | null = pick
    ? {
        title: format('faucet.receiptTitle', { symbol: assetName(pick.asset.address, meta ?? null) }),
        rows: [
          {
            label: text('faucet.rowReceive'),
            value:
              pick.kind === 'erc20'
                ? { kind: 'amount', asset: pick.asset.address, amount: pick.amount }
                : { kind: 'text', text: format('asset.nft', { id: pick.tokenId.toString(), asset: assetName(pick.asset.address, meta ?? null) }) },
            binding: true,
          },
          { label: text('faucet.rowFrom'), value: { kind: 'text', text: format('faucet.from', { address: pick.asset.address }) }, binding: false },
          { label: text('faucet.rowValue'), value: { kind: 'text', text: text('faucet.value') }, binding: false },
        ],
        consequences: [],
        prompts: 1,
        readAt: pick.readAt,
      }
    : null;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  const askWallet = async () => {
    if (!pick || pick.kind !== 'erc20') return;
    const m = meta?.[pick.asset.address.toLowerCase()];
    if (!m || m.decimals === null || !m.symbol) return;
    try {
      const ok = await watchAsset(config, { type: 'ERC20', options: { address: pick.asset.address, symbol: m.symbol, decimals: m.decimals } });
      setWatch(ok ? 'asked' : 'declined');
    } catch {
      setWatch('declined');
    }
  };

  return (
    <section className="home-section faucet" id="faucet" aria-labelledby="faucet-title">
      <h2 id="faucet-title">
        {text('faucet.title')} <span className="badge">{text('faucet.testBadge')}</span>
      </h2>
      <p className="tier-a">{format('faucet.noValue', { chain: chain.name })}</p>
      <WhyLink summaryKey="faucet.summary" detailKey="faucet.why" />
      {pick === null && !holdsFlow(tx.phase) ? (
        <ul className="faucet-assets">
          {assets.map((a) => {
            const name = assetName(a.address, meta ?? null);
            const kindKey = a.kind === 'nft' ? 'faucet.kindNft' : a.priced ? 'faucet.kindPriced' : 'faucet.kindUnpriced';
            const unreadable = a.kind === 'erc20' && meta !== null && decimalsOf(a.address) === null;
            return (
              <li key={a.key} data-asset={a.key}>
                <span className="faucet-info">
                  <span className="faucet-name">{name}</span> <span className="badge">{text('faucet.testBadge')}</span>
                  <span className="faucet-kind tier-b">{text(kindKey)}</span>
                </span>{' '}
                {unreadable ? (
                  <span className="tier-b">{text('faucet.decimalsUnknown')}</span>
                ) : (
                  <button type="button" className="btn" disabled={a.kind === 'erc20' && meta === null} onClick={() => start(a)}>
                    {a.kind === 'erc20' ? format('faucet.getToken', { amount: ERC20_MINT_UNITS.toString() }) : text('faucet.getNft')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <ActionFlow
          tx={tx}
          identity={reviewIdentity(own)}
          reviewedFor={pick?.identity ?? tx.frozen?.identity ?? ''}
          receipt={receipt}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={null}
          after={(outcome) =>
            outcome.verdict === 'done' ? (
              <div className="faucet-next">
                {pick?.kind === 'erc20' && (
                  <p className="tier-b">
                    {watch === 'idle' && (
                      <button type="button" className="btn" onClick={() => void askWallet()}>
                        {text('faucet.watch')}
                      </button>
                    )}
                    {watch === 'asked' && text('faucet.watchAsked')}
                    {watch === 'declined' && text('faucet.watchDeclined')}
                  </p>
                )}
                <p className="tier-b">{text('faucet.nextTitle')}</p>
                <ul className="faucet-next-steps">
                  {NEXT_STEPS.map((s) => (
                    <li key={s.to}>
                      <Link to={s.to}>{text(s.key)}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          }
          onClose={() => setPick(null)}
        />
      )}
    </section>
  );
}
