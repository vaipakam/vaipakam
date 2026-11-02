/**
 * Depository vault — deposit an asset from the wallet into the user's own
 * vault, or withdraw a FREE asset from it, for every asset kind.
 *
 * What the card states, and why:
 *   - the free amount is read from the contract's own `freeHolding`
 *     (tracked minus liens minus queued payouts), never computed here, so
 *     the card cannot offer more than the contract will release;
 *   - with protection on, a withdrawal is QUEUED and the card says so
 *     before the user signs, with the delay, rather than implying the asset
 *     arrives now;
 *   - an asset sent to the vault outside this card is untracked and is not
 *     withdrawable until adopted; the card links the adoption page instead
 *     of pretending the balance is free.
 *
 * Approvals: the Diamond pulls the deposit, so an ERC-20 needs an allowance
 * (the shared `ensureAllowance`), an ERC-721 an approval of that token and an
 * ERC-1155 an operator approval. Each is read first and requested only when
 * missing, and the Terms verdict is checked BEFORE any approval, so a user
 * the gate would refuse is never left holding a standing approval.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { usePublicClient, useWalletClient } from 'wagmi';
import { erc20Abi, isAddress } from 'viem';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { ensureAllowance } from '../contracts/erc20';
import { captureTxError } from '../lib/errors';
import { formatTokenAmount, parseExactUnits } from '../lib/format';
import { ASSET_KIND, useProtectedAccount, type AssetKind } from '../data/protectedAccount';

const NFT_APPROVAL_ABI = [
  {
    type: 'function',
    name: 'getApproved',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

export function DepositoryCard() {
  const { address, walletChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { data: walletClient } = useWalletClient();
  const { write } = useDiamondWrite();
  const termsBlocked = useTermsBlockNonExitWrites();
  const queryClient = useQueryClient();
  const protection = useProtectedAccount();
  const d = copy.depository;

  const [kind, setKind] = useState<AssetKind>(ASSET_KIND.ERC20);
  const [asset, setAsset] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const assetOk = isAddress(asset.trim());
  const tokenAddr = assetOk ? (asset.trim() as `0x${string}`) : undefined;
  const idOk = kind === ASSET_KIND.ERC20 || /^\d+$/.test(tokenId.trim());
  const id = kind === ASSET_KIND.ERC20 || !idOk ? 0n : BigInt(tokenId.trim());

  // Decimals for an ERC-20; whole units for an NFT.
  const decimals = useQuery({
    queryKey: ['depository', 'decimals', walletChain?.chainId, tokenAddr],
    enabled: Boolean(publicClient && tokenAddr && kind === ASSET_KIND.ERC20),
    staleTime: Infinity,
    queryFn: async () =>
      Number(await publicClient!.readContract({ address: tokenAddr!, abi: erc20Abi, functionName: 'decimals' })),
  });
  const dec = kind === ASSET_KIND.ERC20 ? decimals.data : 0;

  const free = useQuery({
    queryKey: ['depository', 'free', walletChain?.chainId, address, kind, tokenAddr, id.toString()],
    enabled: Boolean(publicClient && address && tokenAddr && idOk && walletChain?.diamondAddress),
    queryFn: async () => {
      const [freeAmt, untracked] = await Promise.all([
        publicClient!.readContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'freeHolding',
          args: [address, kind, tokenAddr, id],
        }) as Promise<bigint>,
        publicClient!.readContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'untrackedHolding',
          args: [address, kind, tokenAddr, id],
        }) as Promise<bigint>,
      ]);
      return { free: freeAmt, untracked };
    },
  });

  const parsed =
    kind === ASSET_KIND.ERC721
      ? 1n
      : dec === undefined
        ? 'invalid'
        : parseExactUnits(amount, dec);
  const amt = typeof parsed === 'bigint' && parsed > 0n ? parsed : null;
  const protectedOn = protection.data?.record?.enabled === true;
  const delaySec = protection.data?.record?.delaySeconds ?? 0;
  const ready = Boolean(address && tokenAddr && idOk && amt !== null && !busy);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
      await queryClient.invalidateQueries({ queryKey: ['depository'] });
      await queryClient.invalidateQueries({ queryKey: ['protectedAccount'] });
      await queryClient.invalidateQueries({ queryKey: ['vaultAssets'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  async function deposit(): Promise<string> {
    if (!publicClient || !walletClient || !walletChain || !address || !tokenAddr || amt === null) {
      throw new Error(copy.errors.walletConnectFirst);
    }
    const verdict = termsBlocked();
    if (verdict !== 'ok') {
      throw new Error(verdict === 'unknown' ? copy.errors.termsCheckUnavailable : copy.errors.termsNotAccepted);
    }
    const diamond = walletChain.diamondAddress;
    if (kind === ASSET_KIND.ERC20) {
      await ensureAllowance({ publicClient, walletClient, token: tokenAddr, owner: address, spender: diamond, amount: amt });
    } else if (kind === ASSET_KIND.ERC721) {
      const approved = await publicClient.readContract({
        address: tokenAddr,
        abi: NFT_APPROVAL_ABI,
        functionName: 'getApproved',
        args: [id],
      });
      const all = await publicClient.readContract({
        address: tokenAddr,
        abi: NFT_APPROVAL_ABI,
        functionName: 'isApprovedForAll',
        args: [address, diamond],
      });
      if (approved.toLowerCase() !== diamond.toLowerCase() && !all) {
        const hash = await walletClient.writeContract({
          address: tokenAddr,
          abi: NFT_APPROVAL_ABI,
          functionName: 'approve',
          args: [diamond, id],
          account: address,
          chain: walletClient.chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
    } else {
      const all = await publicClient.readContract({
        address: tokenAddr,
        abi: NFT_APPROVAL_ABI,
        functionName: 'isApprovedForAll',
        args: [address, diamond],
      });
      if (!all) {
        const hash = await walletClient.writeContract({
          address: tokenAddr,
          abi: NFT_APPROVAL_ABI,
          functionName: 'setApprovalForAll',
          args: [diamond, true],
          account: address,
          chain: walletClient.chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
    }
    await write('depositToVault', [kind, tokenAddr, id, amt]);
    return d.depositDone;
  }

  async function withdraw(): Promise<string> {
    if (!address || !tokenAddr || amt === null) throw new Error(copy.errors.walletConnectFirst);
    await write('withdrawFromVault', [address, kind, tokenAddr, id, amt, address]);
    return protectedOn ? d.withdrawQueued : d.withdrawDone;
  }

  const freeText =
    free.data && (kind !== ASSET_KIND.ERC20 || dec !== undefined)
      ? kind === ASSET_KIND.ERC20
        ? formatTokenAmount(free.data.free, dec!)
        : free.data.free.toString()
      : null;

  return (
    <section className="card">
      <h2 className="card-title">{d.title}</h2>
      <p>{d.body}</p>
      <div className="field">
        <label htmlFor="dep-kind">{d.kindLabel}</label>
        <select
          id="dep-kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(Number(e.target.value) as AssetKind)}
        >
          <option value={ASSET_KIND.ERC20}>{d.kindToken}</option>
          <option value={ASSET_KIND.ERC721}>{d.kindNft}</option>
          <option value={ASSET_KIND.ERC1155}>{d.kindMulti}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="dep-asset">{d.assetLabel}</label>
        <input
          id="dep-asset"
          className="input"
          value={asset}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setAsset(e.target.value)}
        />
      </div>
      {kind !== ASSET_KIND.ERC20 ? (
        <div className="field">
          <label htmlFor="dep-id">{d.tokenIdLabel}</label>
          <input
            id="dep-id"
            className="input"
            inputMode="numeric"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value)}
          />
        </div>
      ) : null}
      {kind !== ASSET_KIND.ERC721 ? (
        <div className="field">
          <label htmlFor="dep-amount">{d.amountLabel}</label>
          <input
            id="dep-amount"
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {parsed === 'too-precise' ? <span className="field-hint">{d.tooPrecise}</span> : null}
        </div>
      ) : null}
      {freeText !== null ? <p className="muted">{d.freeNow(freeText)}</p> : null}
      {free.isError ? <p className="muted">{d.freeUnknown}</p> : null}
      {free.data && free.data.untracked > 0n ? (
        <p className="muted">
          {d.untrackedNote} <Link to="/recover">{d.untrackedLink}</Link>
        </p>
      ) : null}
      {protectedOn ? <p>{d.queuedNote(copy.protection.delayDays(Math.round(delaySec / 86_400)))}</p> : null}
      <div className="cluster">
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => run(deposit)}>
          {d.deposit}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!ready || (free.data !== undefined && amt !== null && amt > free.data.free)}
          onClick={() => run(withdraw)}
        >
          {protectedOn ? d.withdrawQueue : d.withdraw}
        </button>
      </div>
      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
      {done ? (
        <p className="muted" role="status">
          {done}
        </p>
      ) : null}
    </section>
  );
}
