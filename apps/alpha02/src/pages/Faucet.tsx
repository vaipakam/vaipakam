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
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { Droplets, ExternalLink, LoaderCircle, TestTube } from 'lucide-react';
import { usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import type { Abi, Address } from 'viem';
import { parseUnits } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { EmptyState } from '../components/EmptyState';
import { captureTxError } from '../lib/errors';
import { shortAddress } from '../lib/format';

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
  const { isConnected, onSupportedChain, readChain, address, switchToSupported } =
    useActiveChain();
  const { setOpen } = useModal();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  // Which asset is minting right now — one shared lock so a user can't
  // fire two mints at once and confuse the wallet queue.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MintOutcome | null>(null);
  const [copied, setCopied] = useState(false);
  const [watched, setWatched] = useState(false);

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
  // specific ticker a click wouldn't actually mint (Codex #1109 P2).
  const liquid2Symbol =
    typeof liquid2SymbolRaw === 'string' && liquid2SymbolRaw.length > 0
      ? liquid2SymbolRaw
      : null;

  // ── Gate 1: the page only DOES anything on a testnet slug that
  // actually carries mock addresses. Both conditions must hold. ──
  if (!readChain.testnet || !mocks) {
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
            <Link to="/" className="btn btn-secondary">
              {copy.faucet.backHome}
            </Link>
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
    setCopied(false);
    setWatched(false);
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Transaction reverted (${hash})`);
      setDone({
        hash,
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
    setCopied(false);
    setWatched(false);
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Transaction reverted (${hash})`);
      setDone({
        hash,
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
            title={copy.faucet.liquid2.title(liquid2Symbol)}
            blurb={copy.faucet.liquid2.blurb}
            address={mocks.liquidToken2}
            explorer={readChain.blockExplorer}
            actionLabel={copy.faucet.liquid2.action(LIQUID_UNITS, liquid2Symbol)}
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
                        void walletClient
                          ?.watchAsset({
                            type: 'ERC20',
                            options: {
                              address: done.asset!.address,
                              symbol: done.asset!.symbol,
                              decimals: MOCK_DECIMALS,
                            },
                          })
                          .then(() => setWatched(true))
                          .catch(() => {});
                      }}
                    >
                      {watched
                        ? copy.faucet.addedToWallet
                        : copy.faucet.addToWallet(done.asset.symbol)}
                    </button>{' '}
                  </>
                ) : null}
                {done.tokenId ? (
                  <>
                    <code
                      className="mono"
                      style={{ wordBreak: 'break-all', display: 'block', margin: '4px 0' }}
                    >
                      {done.tokenId}
                    </code>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        void navigator.clipboard.writeText(done.tokenId!);
                        setCopied(true);
                      }}
                    >
                      {copied ? copy.faucet.copiedTokenId : copy.faucet.copyTokenId}
                    </button>{' '}
                  </>
                ) : null}
                <a
                  href={`${readChain.blockExplorer}/tx/${done.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {copy.faucet.viewTx} <ExternalLink size={12} aria-hidden />
                </a>
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
    <section className="card">
      <div className="item-row">
        <span className="row-main">
          <span className="row-title">{title}</span>
          <br />
          <span className="row-sub">{blurb}</span>
          <br />
          <a
            href={`${explorer}/address/${address}`}
            target="_blank"
            rel="noreferrer"
            className="mono row-sub"
          >
            {shortAddress(address)} <ExternalLink size={12} aria-hidden />
          </a>
        </span>
        <button
          type="button"
          className="btn btn-primary"
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
    </section>
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
