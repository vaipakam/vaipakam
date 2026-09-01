/**
 * Testnet faucet — mint the mock assets the review/demo flows need
 * without hunting for a deployer. Deliberately DOUBLE-GATED: rendered
 * as a working tool only when the read chain is a testnet AND the
 * consolidated deployments bundle carries a `testnetMocks` block for
 * it (the mock ERC-20s expose an unrestricted `mint`, so this surface
 * must be impossible to reach on a mainnet slug). On any other chain
 * the page explains itself and points back home instead of 404-ing.
 *
 * Writes go straight to the mock token contracts (not the Diamond) —
 * `mint(to, amount)` on the two ERC-20s, `mint(to, tokenId)` on the
 * ERC-4907 NFT with a client-random 256-bit id (collision-safe).
 */
import { useState } from 'react';
import { assertSettled } from '../contracts/ownReceipt';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { Droplets, ExternalLink, LoaderCircle, TestTube } from 'lucide-react';
import { usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import type { Abi, Address } from 'viem';
import { parseUnits } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useLatestAttempt } from '../lib/useLatestAttempt';
import { SUPPORTED_CHAINS } from '../chain/chains';
import { EmptyState } from '../components/EmptyState';
import { captureTxError } from '../lib/errors';
import { CopyAddress } from '../components/CopyAddress';
import { resolveMintSymbol } from '../lib/mintSymbol';

const ERC20_MINT_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

// #1095 — read the token's REAL on-chain symbol so watch-asset / the toast
// never mislabel it. The bundled deployment may briefly point a relabelled
// slot (e.g. liquidToken2 → mUSDC) at the pre-relabel token until the
// operator reruns the mock deploy + deployment sync; resolving the symbol
// live keeps MetaMask honest across that window.
const ERC20_SYMBOL_ABI = [
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const satisfies Abi;

const ERC721_MINT_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** How much each token faucet dispenses per click (whole units). */
const LIQUID_UNITS = 10_000;
const ILLIQUID_UNITS = 1_000;
const MOCK_DECIMALS = 18;

interface MintOutcome {
  hash: `0x${string}`;
  label: string;
  /** Full minted NFT token id — shown whole + copyable because the
   *  rental listing form needs the exact value (a random 256-bit id
   *  can't be retyped from a truncated preview). */
  tokenId?: string;
  /** Minted ERC-20 — lets the banner offer wallet_watchAsset so the
   *  token shows up in MetaMask without hand-adding the address. */
  asset?: { address: Address; symbol: string };
}

export function Faucet() {
  const {
    isConnected,
    onSupportedChain,
    readChain,
    address,
    switchToSupported,
    switchPending,
  } = useActiveChain();
  const { setOpen } = useModal();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  // Which asset is minting right now — one shared lock so a user can't
  // fire two mints at once and confuse the wallet queue.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MintOutcome | null>(null);
  // ONE state, not two booleans (#2043 round 1 P2). The first version added
  // `copyFailed` beside `copied` and never cleared it, so a retry that
  // succeeded rendered "Copied." AND the failure line together, and the next
  // mint inherited the stale failure because the mint paths reset only
  // `copied`. Two flags for one outcome can disagree; a single state cannot.
  // This is the same three-state shape the Diagnostics drawer got in the same
  // change — applied there and not here, which is the miss.
  // TIED TO THE TOKEN IT DESCRIBES (#2043 round 2 P2). A bare state was still
  // wrong across mints: a clipboard write for token A can settle AFTER the
  // user has minted B, and its callback would relabel B's card — at worst
  // telling them B's id was copied while the clipboard holds A's. The mint
  // reset cannot help, because the stale settlement happens after it. Carrying
  // the id makes a late result identify itself, so the card can decline one
  // that is not about the token on screen.
  const [copyResult, setCopyResult] = useState<{
    tokenId: string;
    attempt: number;
    state: 'copied' | 'failed';
  } | null>(null);
  // ATTEMPT NUMBER as well as token id (#2043 round 3 P2). The id alone
  // cannot order two writes for the SAME token: a double-click or a retry
  // starts a second write, and if the newer one succeeds while the older
  // rejects afterwards, the older callback overwrote a true "Copied." with
  // "failed" — the clipboard holding the id while the page said it did not.
  // Shared with the other three call sites through `useLatestAttempt` (#2044).
  const copyAttempt = useLatestAttempt();
  // The watch-asset prompt needs its own ordering (#2044). It is a separate
  // control with a separate outcome, so one counter for both would let a
  // copy supersede a pending watch and vice versa.
  const watchAttempt = useLatestAttempt();
  // KEYED LIKE `copyResult`, for the reason stated above it (#2044 round 2).
  // This flag was the one reporter in the file still holding a bare `true`,
  // and it was left that way because the mint handlers reset it — which is a
  // reset that covers the trigger it was written for and no other. `done`
  // survives an account or chain switch, so "Added to your wallet" stood over
  // a wallet that had never been asked, and a prompt open across the switch
  // was still legitimately the latest attempt.
  //
  // Not flagged in review; fixed here because it is the same defect as the
  // two that were, and shipping the fix only where it was pointed out is
  // precisely the habit #2044 exists to end.
  const [watchedKey, setWatchedKey] = useState<string | null>(null);
  const watchKeyFor = (asset: Address) =>
    `${address?.toLowerCase() ?? ''}:${readChain.chainId}:${asset.toLowerCase()}`;

  const mocks = getDeployment(readChain.chainId)?.testnetMocks;

  // #1103 — the second liquid slot is the one that gets RELABELLED (tLQ2 →
  // mUSDC), so its row/button label is the one that can advertise the wrong
  // ticker during the window where the bundled deployment still points at the
  // pre-relabel token. Resolve its live on-chain symbol() and label the row
  // from that.
  const { data: liquid2SymbolRaw } = useReadContract({
    chainId: readChain.chainId,
    address: mocks?.liquidToken2,
    abi: ERC20_SYMBOL_ABI,
    functionName: 'symbol',
    query: { enabled: Boolean(mocks?.liquidToken2) },
  });
  // `null` (NOT a hard-coded "mUSDC") until the read resolves — the row then
  // shows a GENERIC label, so a slow or failed read can never advertise a
  // specific ticker a click wouldn't actually mint (Codex #1109 P2). Pure
  // helper so the resolution is unit-tested (#1111).
  const liquid2Symbol = resolveMintSymbol(liquid2SymbolRaw);

  // ── Gate 1: the page only DOES anything on a testnet slug that
  // actually carries mock addresses. Both conditions must hold. ──
  if (!readChain.testnet || !mocks) {
    // UX2-005 — the empty state used to NAME the remedy ("try a
    // different test network") without offering it. When another
    // supported testnet carries the mocks, hand over the one-click
    // switch instead of leaving the user to work the wallet menu.
    const mocksChain = SUPPORTED_CHAINS.find(
      (c) =>
        c.testnet &&
        c.chainId !== readChain.chainId &&
        getDeployment(c.chainId)?.testnetMocks,
    );
    return (
      <div>
        <h1 className="page-title">{copy.faucet.title}</h1>
        <p className="page-lede">{copy.faucet.lede}</p>
        <EmptyState
          icon={TestTube}
          title={copy.faucet.notTestnetTitle}
          body={
            readChain.testnet
              ? copy.faucet.noMocksBody(readChain.name)
              : copy.faucet.notTestnetBody(readChain.name)
          }
          action={
            <div className="cluster" style={{ justifyContent: 'center' }}>
              {isConnected && mocksChain ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={switchPending}
                  onClick={() => switchToSupported(mocksChain.chainId)}
                >
                  {copy.wallet.switchToChain(mocksChain.name)}
                </button>
              ) : null}
              <Link to="/" className="btn btn-secondary">
                {copy.faucet.backHome}
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  const canWrite = onSupportedChain && Boolean(walletClient) && Boolean(address);

  async function mintErc20(token: Address, units: number, symbolHint: string) {
    if (!walletClient || !address || !publicClient) return;
    // #1095 (Codex): engage the mint lock BEFORE any await. The on-chain
    // symbol read below is async, and the mint button only disables once
    // `busy` is set — so setting it after the read left a window where a
    // rapid second click slipped past the guard and fired a duplicate
    // mint. `busy` also short-circuits a re-entrant call outright.
    if (busy) return;
    setBusy(token);
    setError(null);
    setDone(null);
    setCopyResult(null);
    copyAttempt.supersede();
    // No `watched` reset any more: the flag is keyed on the asset, so minting
    // a DIFFERENT token stops matching on its own, and re-minting the same one
    // correctly keeps "Added" — it is still in the wallet. `supersede` stays,
    // because a prompt outstanding across the mint must not report at all.
    watchAttempt.supersede();
    // Resolve the REAL on-chain symbol; fall back to the hint if the read
    // fails (#1095 — never label the minted/watched token as something the
    // deployed contract isn't).
    let symbol = symbolHint;
    try {
      symbol = (await publicClient.readContract({
        address: token,
        abi: ERC20_SYMBOL_ABI,
        functionName: 'symbol',
      })) as string;
    } catch {
      /* keep the hint — a symbol read failure must not block minting */
    }
    try {
      const hash = await walletClient.writeContract({
        address: token,
        abi: ERC20_MINT_ABI,
        functionName: 'mint',
        args: [address, parseUnits(String(units), MOCK_DECIMALS)],
        account: address,
        chain: walletClient.chain,
      });
      // The MINED hash: on a Speed Up the submitted one never mined, and
      // the success panel links straight to it (#1529 review round 13).
      const receipt = await assertSettled(publicClient, hash, 'The faucet transaction');
      setDone({
        hash: receipt.transactionHash,
        label: copy.faucet.mintedTokens(units, symbol),
        asset: { address: token, symbol },
      });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(null);
    }
  }

  async function mintNft(nft: Address) {
    if (!walletClient || !address || !publicClient) return;
    setBusy(nft);
    setError(null);
    setDone(null);
    setCopyResult(null);
    copyAttempt.supersede();
    watchAttempt.supersede();
    try {
      const tokenId = randomTokenId();
      const hash = await walletClient.writeContract({
        address: nft,
        abi: ERC721_MINT_ABI,
        functionName: 'mint',
        args: [address, tokenId],
        account: address,
        chain: walletClient.chain,
      });
      const receipt = await assertSettled(publicClient, hash, 'The faucet transaction');
      setDone({
        hash: receipt.transactionHash,
        label: copy.faucet.mintedNft,
        tokenId: tokenId.toString(),
      });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 className="page-title">{copy.faucet.title}</h1>
      <p className="page-lede">{copy.faucet.lede}</p>

      <div className="banner banner-info" role="note" style={{ marginBottom: 16 }}>
        <TestTube aria-hidden />
        <span className="banner-body">{copy.faucet.testnetNote(readChain.name)}</span>
      </div>

      {!isConnected ? (
        <EmptyState
          icon={Droplets}
          title={copy.wallet.connectFirst}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : !onSupportedChain ? (
        <EmptyState
          icon={Droplets}
          title={copy.faucet.switchTitle(readChain.name)}
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => switchToSupported(readChain.chainId)}
            >
              {copy.wallet.switchNetwork}
            </button>
          }
        />
      ) : (
        <div className="stack">
          {/* UX-048 — all faucet rows in ONE card (a row-list), flat, so
              the mint buttons form a single aligned column. */}
          <section className="card">
          <div className="row-list">
          <FaucetRow
            title={copy.faucet.liquid.title}
            blurb={copy.faucet.liquid.blurb}
            address={mocks.liquidToken}
            explorer={readChain.blockExplorer}
            actionLabel={copy.faucet.liquid.action(LIQUID_UNITS)}
            busy={busy === mocks.liquidToken}
            disabled={!canWrite || busy !== null}
            onClick={() =>
              mocks.liquidToken && void mintErc20(mocks.liquidToken, LIQUID_UNITS, 'tLIQ')
            }
          />
          <FaucetRow
            title={
              liquid2Symbol
                ? copy.faucet.liquid2.title(liquid2Symbol)
                : copy.faucet.liquid2.titleGeneric
            }
            blurb={copy.faucet.liquid2.blurb}
            address={mocks.liquidToken2}
            explorer={readChain.blockExplorer}
            actionLabel={
              liquid2Symbol
                ? copy.faucet.liquid2.action(LIQUID_UNITS, liquid2Symbol)
                : copy.faucet.liquid2.actionGeneric(LIQUID_UNITS)
            }
            busy={busy === mocks.liquidToken2}
            disabled={!canWrite || busy !== null}
            onClick={() =>
              mocks.liquidToken2 &&
              // `mintErc20` re-reads the live symbol at mint time; the hint is
              // only the toast/watch-asset fallback, so pass "mUSDC" when the
              // row-level read hasn't resolved.
              void mintErc20(mocks.liquidToken2, LIQUID_UNITS, liquid2Symbol ?? 'mUSDC')
            }
          />
          <FaucetRow
            title={copy.faucet.mweth.title}
            blurb={copy.faucet.mweth.blurb}
            address={mocks.mWeth}
            explorer={readChain.blockExplorer}
            actionLabel={copy.faucet.mweth.action(LIQUID_UNITS)}
            busy={busy === mocks.mWeth}
            disabled={!canWrite || busy !== null}
            onClick={() =>
              mocks.mWeth && void mintErc20(mocks.mWeth, LIQUID_UNITS, 'mWETH')
            }
          />
          <FaucetRow
            title={copy.faucet.illiquid.title}
            blurb={copy.faucet.illiquid.blurb}
            address={mocks.illiquidToken}
            explorer={readChain.blockExplorer}
            actionLabel={copy.faucet.illiquid.action(ILLIQUID_UNITS)}
            busy={busy === mocks.illiquidToken}
            disabled={!canWrite || busy !== null}
            onClick={() =>
              mocks.illiquidToken &&
              void mintErc20(mocks.illiquidToken, ILLIQUID_UNITS, 'tILQ')
            }
          />
          <FaucetRow
            title={copy.faucet.illiquid2.title}
            blurb={copy.faucet.illiquid2.blurb}
            address={mocks.illiquidToken2}
            explorer={readChain.blockExplorer}
            actionLabel={copy.faucet.illiquid2.action(ILLIQUID_UNITS)}
            busy={busy === mocks.illiquidToken2}
            disabled={!canWrite || busy !== null}
            onClick={() =>
              mocks.illiquidToken2 &&
              void mintErc20(mocks.illiquidToken2, ILLIQUID_UNITS, 'tILQ2')
            }
          />
          <FaucetRow
            title={copy.faucet.nft.title}
            blurb={copy.faucet.nft.blurb}
            address={mocks.rentalNft}
            explorer={readChain.blockExplorer}
            actionLabel={copy.faucet.nft.action}
            busy={busy === mocks.rentalNft}
            disabled={!canWrite || busy !== null}
            onClick={() => mocks.rentalNft && void mintNft(mocks.rentalNft)}
          />
          <FaucetRow
            title={copy.faucet.nft2.title}
            blurb={copy.faucet.nft2.blurb}
            address={mocks.rentalNft2}
            explorer={readChain.blockExplorer}
            actionLabel={copy.faucet.nft2.action}
            busy={busy === mocks.rentalNft2}
            disabled={!canWrite || busy !== null}
            onClick={() => mocks.rentalNft2 && void mintNft(mocks.rentalNft2)}
          />
          </div>
          </section>

          {done ? (
            <div className="banner banner-info" role="status">
              <span className="banner-body">
                {done.label}{' '}
                {done.asset ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        // wallet_watchAsset — MetaMask shows an
                        // add-token prompt; rejection is not an error.
                        //
                        // ORDERED, and tied to the asset it was approved for
                        // (#2044). A wallet prompt is exactly the kind of
                        // thing a person leaves open while they carry on, so
                        // this settlement can land after a SECOND mint has
                        // reset the flag — marking the new token as added to
                        // the wallet when what they approved was the previous
                        // asset. The mint handlers supersede any prompt still
                        // outstanding, so a late approval cannot label a token
                        // it was never about.
                        //
                        // The silent `catch` STAYS, and that is a decision
                        // rather than an oversight: the common rejection here
                        // is the user declining the prompt, which they already
                        // know about. Reporting "could not add" over their own
                        // decline would be noise, and this call cannot
                        // distinguish a decline from a genuine failure. That
                        // makes it unlike the clipboard buttons beside it,
                        // where a refusal is never something the user chose.
                        const attempt = watchAttempt.begin();
                        const forKey = watchKeyFor(done.asset!.address);
                        void walletClient
                          ?.watchAsset({
                            type: 'ERC20',
                            options: {
                              address: done.asset!.address,
                              symbol: done.asset!.symbol,
                              decimals: MOCK_DECIMALS,
                            },
                          })
                          .then(() => {
                            if (attempt.isCurrent()) setWatchedKey(forKey);
                          })
                          .catch(() => {});
                      }}
                    >
                      {watchedKey === watchKeyFor(done.asset.address)
                        ? copy.faucet.addedToWallet
                        : copy.faucet.addToWallet(done.asset.symbol)}
                    </button>{' '}
                  </>
                ) : null}
                {done.tokenId ? (
                  <>
                    {/* A READ-ONLY INPUT, not a `<code>` (#2043 round 3 P2).
                        The failure line below tells the reader to select the
                        id above — and a `<code>` is not in the tab order, so
                        a keyboard-only user could not reach the very thing
                        they had just been pointed at. Same defect the
                        Diagnostics drawer's `<pre>` had one round earlier,
                        in the sibling file, unfixed until now. `readOnly`
                        rather than `disabled`: a disabled control is skipped
                        by the tab order too. */}
                    <input
                      className="mono"
                      readOnly
                      value={done.tokenId}
                      aria-label={copy.faucet.copyTokenId}
                      style={{
                        width: '100%',
                        display: 'block',
                        margin: '4px 0',
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      // #2023, second site — this claimed success
                      // UNCONDITIONALLY. `writeText` rejects in an insecure
                      // context, a hardened browser, or on a denied
                      // permission, and the fire-and-forget `void` meant the
                      // label flipped to "Copied" regardless. That is worse
                      // than the drawer's silent no-op it was found beside:
                      // a user told the token id is on their clipboard stops
                      // looking at the `<code>` block above, and pastes
                      // whatever was there before.
                      onClick={() => {
                        // GUARDED, not just caught (round 1 P2, first
                        // finding). In an insecure context — or a browser
                        // that disables the API — `navigator.clipboard` is
                        // undefined, so reading `.writeText` off it throws
                        // SYNCHRONOUSLY, before any `.catch()` is attached.
                        // The promise chain alone therefore stayed silent in
                        // one of the exact environments this fix exists for.
                        // (The drawer's equivalent is already safe: its call
                        // sits inside a try/catch, which a synchronous throw
                        // does reach.)
                        const forToken = done.tokenId!;
                        const attempt = copyAttempt.begin();
                        // Only the LATEST attempt may report. A settlement
                        // from a superseded one is discarded rather than
                        // allowed to contradict it.
                        const report = (state: 'copied' | 'failed') => {
                          if (!attempt.isCurrent()) return;
                          setCopyResult({
                            tokenId: forToken,
                            attempt: attempt.id,
                            state,
                          });
                        };
                        setCopyResult(null);
                        try {
                          void navigator.clipboard
                            .writeText(forToken)
                            .then(() => report('copied'))
                            .catch(() => report('failed'));
                        } catch {
                          report('failed');
                        }
                      }}
                    >
                      {copyResult?.tokenId === done.tokenId &&
                      copyResult.state === 'copied'
                        ? copy.faucet.copiedTokenId
                        : copy.faucet.copyTokenId}
                    </button>{' '}
                    {copyResult?.tokenId === done.tokenId &&
                    copyResult.state === 'failed' ? (
                      // The id is already rendered in the `<code>` above, so
                      // saying the copy failed is enough — it points at text
                      // that is on screen rather than at a dead end.
                      <span className="muted" role="status" style={{ fontSize: 13 }}>
                        {copy.faucet.copyTokenIdFailed}
                      </span>
                    ) : null}
                  </>
                ) : null}
                <a
                  href={`${readChain.blockExplorer}/tx/${done.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {copy.faucet.viewTx} <ExternalLink size={12} aria-hidden />
                </a>
                {/* UX-023 — the guided faucet→first-offer path used to
                    break after hop one: carry the next hop here. NFT
                    mints route to the rental flow (Codex #1168 r1). */}
                <span style={{ display: 'block', marginTop: 8 }}>
                  {copy.faucet.nextSteps}{' '}
                  {done.tokenId ? (
                    <Link to="/rent">{copy.faucet.nextRent}</Link>
                  ) : (
                    <>
                      <Link to="/borrow">{copy.faucet.nextBorrow}</Link>
                      {' · '}
                      <Link to="/lend">{copy.faucet.nextLend}</Link>
                    </>
                  )}
                </span>
              </span>
            </div>
          ) : null}
          {error ? (
            <div className="banner banner-danger" role="alert">
              <span className="banner-body">{error}</span>
            </div>
          ) : null}

          <p className="muted">{copy.faucet.footer}</p>
        </div>
      )}
    </div>
  );
}

function FaucetRow({
  title,
  blurb,
  address,
  explorer,
  actionLabel,
  busy,
  disabled,
  onClick,
}: {
  title: string;
  blurb: string;
  address: Address | undefined;
  explorer: string;
  actionLabel: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  // A mock that isn't in this chain's bundle (e.g. NFT not yet
  // deployed on Arb Sepolia) hides its own row rather than offering a
  // dead button.
  if (!address) return null;
  return (
    // UX-048 — a plain row, not a card-per-row: the parent wraps all
    // rows in ONE card, so the faucet reads as a single list instead of
    // a stack of nested cards.
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">{title}</span>
        <br />
        <span className="row-sub">{blurb}</span>
        <br />
        <CopyAddress address={address} explorerBase={explorer} />
      </span>
      <button
        type="button"
        className="btn btn-primary faucet-mint-btn"
        disabled={disabled}
        onClick={onClick}
      >
        {busy ? (
          <>
            <LoaderCircle className="spin" size={16} aria-hidden /> {copy.faucet.minting}
          </>
        ) : (
          actionLabel
        )}
      </button>
    </div>
  );
}

/** A 256-bit random token id — the ERC-4907 mock reverts on a
 *  duplicate id, so a full-width random keeps collisions negligible
 *  even across every reviewer minting into the shared contract. */
function randomTokenId(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
