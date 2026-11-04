/**
 * Depository vault — deposit an asset from the wallet into the user's own
 * vault, or withdraw a FREE asset from it, for every asset kind.
 *
 * What the card states, and why:
 *   - the withdrawable amount is read from the contract's own
 *     `withdrawableNow` (the owner's depository holding, never more than
 *     tracked minus liens minus queued payouts), never computed here, so
 *     the card cannot offer more than the contract will release, and a
 *     balance the protocol keeps in the vault for a loan, offer or claim is
 *     never offered;
 *   - with protection on, a withdrawal is QUEUED and the card says so
 *     before the user signs, with the delay, rather than implying the asset
 *     arrives now. Until the protection state is read the withdraw button
 *     stays off, and the result line is taken from the receipt (paid now
 *     or queued), never assumed;
 *   - for an account the wallet manages after a replacement retired it
 *     (`account` prop), the card is withdraw-only: it reads that account
 *     and pays the connected wallet, its controller;
 *   - an asset sent to the vault outside this card is untracked and is not
 *     withdrawable until adopted; the card links the adoption page, with
 *     the asset filled in, for every kind, instead of pretending the
 *     balance is free (a replaced account, which cannot adopt, gets the
 *     note without the link). Beside it the card offers disowning, the
 *     event-only public record that the asset is not the owner's, which
 *     the adoption page's gates (oracle, signature, clean wallet) would
 *     otherwise hide where the contract allows it.
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
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  formatUnits,
  isAddress,
  type PublicClient,
} from 'viem';
import { SECOND_READ_DELAY_MS } from '../chain/receiptSync';
import { assertSettled } from '../contracts/ownReceipt';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { ensureAllowance } from '../contracts/erc20';
import { captureTxError } from '../lib/errors';
import { formatExactSpan, parseExactUnits, shortAddress } from '../lib/format';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import { assertErc20BalanceLive } from '../contracts/preflights';
import { recoverHref } from '../lib/recoverPrefill';
import { assetLabel } from '../lib/recoverAsset';
import { DisownUntracked } from './DisownUntracked';
import { ASSET_KIND, ownFundingVerdict, ownWithdrawalVerdict, payoutOutcome, useProtectedAccount, type AssetKind } from '../data/protectedAccount';

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

const NFT_HOLDING_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** The wallet holds what it is about to deposit, read live; refuses
 *  otherwise (and when the read fails), before any approval is asked for. */
async function assertWalletHolds(
  publicClient: PublicClient,
  kind: AssetKind,
  token: `0x${string}`,
  id: bigint,
  wallet: `0x${string}`,
  amount: bigint,
): Promise<void> {
  if (kind === ASSET_KIND.ERC20) {
    await assertErc20BalanceLive({ publicClient, token, owner: wallet, amount });
    return;
  }
  let held: boolean;
  try {
    held =
      kind === ASSET_KIND.ERC721
        ? (await publicClient.readContract({ address: token, abi: NFT_HOLDING_ABI, functionName: 'ownerOf', args: [id] })).toLowerCase() ===
          wallet.toLowerCase()
        : (await publicClient.readContract({ address: token, abi: NFT_HOLDING_ABI, functionName: 'balanceOf', args: [wallet, id] })) >=
          amount;
  } catch {
    throw new Error(copy.errors.checkRetry);
  }
  if (!held) throw new Error(copy.depository.nftNotHeld);
}

export function DepositoryCard({ account }: { account?: `0x${string}` } = {}) {
  const { address, walletChain } = useActiveChain();
  // The vault the card reads and withdraws from: the wallet's own, or the
  // retired account it controls. Deposits go only to the wallet's own.
  const owner = account ?? address;
  const managed = account !== undefined;
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { data: walletClient } = useWalletClient();
  const { write } = useDiamondWrite();
  const termsBlocked = useTermsBlockNonExitWrites();
  const queryClient = useQueryClient();
  const protection = useProtectedAccount(account);
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
    // `null` = the token answers but has no `decimals()` (a revert or empty
    // return): amounts are then entered and shown in raw base units, and
    // the card says so. A transport failure stays an error.
    queryFn: async (): Promise<number | null> => {
      try {
        return Number(await publicClient!.readContract({ address: tokenAddr!, abi: erc20Abi, functionName: 'decimals' }));
      } catch (err) {
        const absent =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (absent) return null;
        throw err;
      }
    },
  });
  const rawUnits = kind === ASSET_KIND.ERC20 && decimals.data === null;
  const dec = kind === ASSET_KIND.ERC20 ? (decimals.data === null ? 0 : decimals.data) : 0;

  const free = useQuery({
    queryKey: ['depository', 'free', walletChain?.chainId, owner, kind, tokenAddr, id.toString()],
    enabled: Boolean(publicClient && owner && tokenAddr && idOk && walletChain?.diamondAddress),
    // Another wallet can change this balance (a signer cancelling a queued
    // withdrawal returns it; a protocol payment credits it), and no chain
    // event refreshes it here, so it is re-read on the same cadence as the
    // account's protection state.
    refetchInterval: 30_000,
    queryFn: async () => {
      const [freeAmt, untracked] = await Promise.all([
        publicClient!.readContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'withdrawableNow',
          args: [owner, kind, tokenAddr, id],
        }) as Promise<bigint>,
        publicClient!.readContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'untrackedHolding',
          args: [owner, kind, tokenAddr, id],
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
  // Protection must be KNOWN before a withdrawal is offered: while it is
  // loading or its read failed, the card cannot say whether the withdrawal
  // pays now or queues behind the delay.
  const record = protection.data && !protection.isError && !protection.data.recordFailed ? protection.data.record : undefined;
  const protectionKnown = record !== undefined && record !== null;
  const protectedOn = record?.enabled === true;
  const delaySec = record?.delaySeconds ?? 0;
  // The escape route: after a long admin pause an unprotected owner takes
  // what is theirs to their own wallet through its own entry point (the
  // ordinary withdrawal stays paused for them). A protected account's
  // withdrawal keeps queueing through the ordinary route.
  const escape = !managed && protectionKnown && !protectedOn && protection.data?.escapeOpen === true;
  // An unprotected owner's route depends on the escape read: open means
  // the escape entry point, closed means the ordinary withdrawal. An unread
  // escape state is neither, so no route is offered until it is read.
  const escapeKnown = managed || protectedOn || typeof protection.data?.escapeOpen === 'boolean';
  const ready = Boolean(address && tokenAddr && idOk && amt !== null && !busy);
  // One verdict for whether a withdrawal can succeed now, from FRESH reads
  // only: a balance whose last refresh failed is not offered (React Query
  // keeps the old figure beside the error), and a locked account queues
  // nothing, so neither is a withdrawal the card may start.
  const balanceFresh = free.data !== undefined && !free.isError;
  // The connected wallet's own account was moved to a new wallet: the
  // contract refuses this wallet's deposits and withdrawals, so neither is
  // offered, and the card names the wallet that manages the account now.
  const funding = ownFundingVerdict(protection.data, protection.isError);
  const retiredSelf = !managed && funding.kind === 'retired';
  // The one withdrawal rule (the contract's): a locked or retired account,
  // or a full queue, is refused, so no such withdrawal is offered.
  const withdrawal = ownWithdrawalVerdict(protection.data, protection.isError, managed);
  const canWithdraw =
    ready && protectionKnown && escapeKnown && withdrawal.kind === 'open' && balanceFresh && amt !== null && amt <= free.data!.free;
  // A deposit is offered only once protection is read, so the card can say
  // whose the deposited asset becomes.
  const canDeposit = ready && protectionKnown && !retiredSelf;

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setDone(null);
    let wrote = false;
    try {
      setDone(await fn());
      wrote = true;
      // Read again after the receipt-lag window: a public RPC may still
      // serve the pre-transaction state on the first read, and the controls
      // stay off (busy) until the second read lands, so a withdrawn balance
      // is never offered again.
      for (const pass of [0, 1]) {
        if (pass === 1) await new Promise((r) => setTimeout(r, SECOND_READ_DELAY_MS));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['depository'] }),
          queryClient.invalidateQueries({ queryKey: ['protectedAccount'] }),
          queryClient.invalidateQueries({ queryKey: ['vaultAssets'] }),
        ]);
      }
    } catch (err) {
      if (!wrote) setError(captureTxError(err));
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
    // The deposit refuses a sanctioned wallet; screen it live BEFORE any
    // approval, so a refused deposit never leaves an allowance (or an
    // ERC-1155 operator grant) standing.
    await assertWalletNotSanctionedLive(publicClient, diamond, address);
    // The wallet must hold what it deposits, checked live BEFORE any
    // approval, so a deposit that cannot succeed never costs an approval
    // or leaves one standing.
    await assertWalletHolds(publicClient, kind, tokenAddr, id, address, amt);
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
        // Only a successful run of this approval lets the deposit go on.
        await assertSettled(publicClient, hash, 'The NFT approval');
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
        // Only a successful run of this approval lets the deposit go on.
        await assertSettled(publicClient, hash, 'The NFT approval');
      }
    }
    await write('depositToVault', [kind, tokenAddr, id, amt]);
    return d.depositDone;
  }

  async function withdraw(): Promise<string> {
    if (!address || !owner || !tokenAddr || amt === null) throw new Error(copy.errors.walletConnectFirst);
    if (escape) {
      await write('escapeWithdraw', [kind, tokenAddr, id, amt]);
      return d.withdrawDone;
    }
    // Paid to the connected wallet: the owner, or the controller of a
    // retired account (always an allowed recipient).
    const { receipt } = await write('withdrawFromVault', [owner, kind, tokenAddr, id, amt, address]);
    // The receipt says what happened: paid now, queued behind the delay, or
    // held in the vault. One reading for every withdrawal surface.
    const outcome = payoutOutcome(receipt.logs, owner).kind;
    return outcome === 'held' ? d.withdrawHeld : outcome === 'queued' ? d.withdrawQueued : d.withdrawDone;
  }

  const freeText =
    balanceFresh && free.data && (kind !== ASSET_KIND.ERC20 || dec !== undefined)
      ? kind === ASSET_KIND.ERC20
        ? // The exact figure, never a rounded one: it is the limit the
          // Withdraw button checks the typed amount against, so a rounded
          // display could read above what the account may take out.
          formatUnits(free.data.free, dec!)
        : free.data.free.toString()
      : null;

  return (
    <section className="card">
      <h2 className="card-title">{managed ? d.managedTitle : d.title}</h2>
      <p>{managed ? d.managedBody : d.body}</p>
      <div className="field">
        <label htmlFor="dep-kind">{copy.assetKind.label}</label>
        <select
          id="dep-kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(Number(e.target.value) as AssetKind)}
        >
          <option value={ASSET_KIND.ERC20}>{copy.assetKind.token}</option>
          <option value={ASSET_KIND.ERC721}>{copy.assetKind.nft}</option>
          <option value={ASSET_KIND.ERC1155}>{copy.assetKind.multi}</option>
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
          <label htmlFor="dep-id">{copy.assetKind.tokenId}</label>
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
      {rawUnits ? <p className="muted">{d.rawUnitsNote}</p> : null}
      {kind === ASSET_KIND.ERC20 && decimals.isError ? (
        // A failed read is not a token without decimals: no amount can be
        // checked until it succeeds, so the card says so and offers a retry.
        <p className="banner banner-warn" role="status">
          <span className="banner-body">{d.decimalsUnknown}</span>{' '}
          <button type="button" className="btn btn-secondary" onClick={() => void decimals.refetch()}>
            {d.decimalsRetry}
          </button>
        </p>
      ) : null}
      {!managed && funding.kind === 'retired' ? <p className="banner banner-warn">{d.retiredNote(shortAddress(funding.controller))}</p> : null}
      {freeText !== null ? <p className="muted">{d.freeNow(freeText)}</p> : null}
      {free.isError ? <p className="muted">{d.freeUnknown}</p> : null}
      {free.data && free.data.untracked > 0n && tokenAddr ? (
        managed || retiredSelf ? (
          // Adoption is the account's own manager's act, and a replaced
          // account has none (#3094), so no link is offered to a form
          // that would refuse it.
          <p className="muted">
            {d.untrackedNote} {d.untrackedRetiredNote}
          </p>
        ) : (
          // Every kind links to the one adoption flow (#3096), with this
          // asset filled in.
          <p className="muted">
            {d.untrackedNote} <Link to={recoverHref(kind, tokenAddr, id)}>{d.untrackedLink}</Link>
          </p>
        )
      ) : null}
      {free.data && free.data.untracked > 0n && tokenAddr && !managed && dec !== undefined ? (
        // Disowning (#3096) acts on the caller's own vault and asks for no
        // oracle, signature or clean wallet, so it is offered here, outside
        // the adoption page's gates; a replaced wallet may still disown.
        // Keyed by the asset so a different one starts with a fresh card.
        <DisownUntracked
          key={`${walletChain?.chainId ?? ''}|${owner ?? ''}|${kind}|${tokenAddr}|${id.toString()}`}
          kind={kind}
          asset={tokenAddr}
          tokenId={id}
          label={assetLabel(kind, shortAddress(tokenAddr), id)}
          decimals={dec}
        />
      ) : null}
      {escape ? <p className="banner banner-warn">{d.escapeNote}</p> : null}
      {protectedOn ? <p>{d.queuedNote(formatExactSpan(delaySec))}</p> : null}
      {protectedOn && record?.requireCosign ? <p>{d.cosignNote}</p> : null}
      {/* One note per refusal of the withdrawal rule, so a withdrawal that is
          not offered always says why (a retired wallet's note is above). */}
      {withdrawal.kind === 'locked' ? <p className="banner banner-warn">{d.lockedNote}</p> : null}
      {withdrawal.kind === 'queueFull' ? <p className="banner banner-warn">{d.queueFullNote}</p> : null}
      {withdrawal.kind === 'unread' && !protection.isLoading ? <p className="muted">{d.protectionUnknown}</p> : null}
      {protectionKnown && !escapeKnown ? <p className="muted">{d.escapeUnknown}</p> : null}
      <div className="cluster">
        {!managed ? (
          <button type="button" className="btn btn-primary" disabled={!canDeposit} onClick={() => run(deposit)}>
            {d.deposit}
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary" disabled={!canWithdraw} onClick={() => run(withdraw)}>
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
