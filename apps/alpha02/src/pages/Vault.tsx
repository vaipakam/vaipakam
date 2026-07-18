/**
 * Your Vaipakam Vault — the trust surface: where the user's assets
 * actually sit. Per asset: total (clamped to protocol-tracked),
 * locked (backing open offers/loans/rentals), and free.
 */
import { useState } from 'react';
import { Landmark, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useVaultAssets } from '../data/vault';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { formatTokenAmount, shortAddress } from '../lib/format';
import { LIST_WINDOW_PAGE, WindowedRowList } from '../lib/visibleWindow';
import { CopyAddress } from '../components/CopyAddress';

export function Vault() {
  const { isConnected, address, readChain } = useActiveChain();
  const { setOpen } = useModal();
  // #1247 PAG-001 rider — the scanned-candidate window (the per-token
  // reads fan out inside the vault query). Render-phase reset on the
  // wallet/chain identity, like the approvals card.
  const [scanWindow, setScanWindow] = useState(LIST_WINDOW_PAGE);
  const scanKey = `${readChain.chainId}|${address?.toLowerCase() ?? ''}`;
  const [prevScanKey, setPrevScanKey] = useState(scanKey);
  if (prevScanKey !== scanKey) {
    setPrevScanKey(scanKey);
    setScanWindow(LIST_WINDOW_PAGE);
  }
  const vault = useVaultAssets(scanWindow);
  // UX-023 — empty states point forward: on a seeded testnet the
  // natural first hop is the faucet, otherwise the guided journeys.
  const hasFaucet =
    readChain.testnet && Boolean(getDeployment(readChain.chainId)?.testnetMocks);
  const forwardCta = hasFaucet ? (
    <Link to="/faucet" className="btn btn-primary">
      {copy.vault.emptyCtaFaucet}
    </Link>
  ) : (
    <Link to="/" className="btn btn-primary">
      {copy.vault.emptyCta}
    </Link>
  );

  return (
    <div>
      <h1 className="page-title">{copy.vault.title}</h1>
      <p className="page-lede">{copy.vault.lede}</p>

      {!isConnected ? (
        <EmptyState
          icon={Landmark}
          title={copy.wallet.connectFirst}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : vault.isLoading || vault.depsLoading ? (
        <EmptyState icon={LoaderCircle} title={copy.vault.loading} />
      ) : vault.depsUnavailable || vault.isError || !vault.data ? (
        <UnavailableState body={copy.vault.unavailable} />
      ) : vault.data.vaultAddress === null ? (
        <EmptyState
          icon={Landmark}
          title={copy.vault.noVaultTitle}
          body={copy.vault.noVaultYet}
          action={forwardCta}
        />
      ) : (
        <div className="stack">
          <section className="card">
            <p className="muted" style={{ margin: 0 }}>
              {copy.vault.addressLabel}{' '}
              <CopyAddress
                address={vault.data.vaultAddress}
                explorerBase={readChain.blockExplorer}
              />{' '}
              on {readChain.name}
            </p>
          </section>

          {vault.data.unreadable.length > 0 ? (
            // A token whose reads failed this scan may hold REAL locked
            // funds — never let the list look complete without it.
            <div className="banner banner-warn" role="status">
              <span className="banner-body">
                We couldn’t read {vault.data.unreadable.length === 1 ? 'one asset' : `${vault.data.unreadable.length} assets`} just now (
                {vault.data.unreadable.map((t) => shortAddress(t)).join(', ')}
                ) — the list below may be missing balances. This usually
                clears on the next refresh.
              </span>
            </div>
          ) : null}
          {vault.data.assets.length === 0 && vault.data.moreTokens === 0 ? (
            vault.data.unreadable.length > 0 ? (
              <UnavailableState body={copy.vault.unavailable} />
            ) : (
              <EmptyState
                icon={Landmark}
                title={copy.vault.emptyTitle}
                body={copy.vault.emptyBody}
                action={forwardCta}
              />
            )
          ) : (
            <section className="card">
              {/* #1247 PAG-001 rider — the distinct-asset set grows
                  with the same 500/2000 source caps; window it like
                  every other data-fed list. An empty FIRST window with
                  candidates still unscanned must not read as "nothing
                  in your vault" (Codex #1265 r2) — the widen control
                  below stays reachable. */}
              {vault.data.assets.length === 0 ? (
                <p className="muted" style={{ marginBottom: 8 }}>
                  No balances among the first {scanWindow} tokens checked —
                  widen the scan below to keep looking.
                </p>
              ) : null}
              <WindowedRowList
                rows={vault.data.assets}
                resetKey={`${readChain.chainId}|${address?.toLowerCase() ?? ''}`}
                render={(asset) => (
                  <div key={asset.token} className="item-row">
                    <span className="row-main">
                      <span className="row-title">
                        {formatTokenAmount(asset.total, asset.decimals)} {asset.symbol}
                      </span>
                      <br />
                      <span className="row-sub">
                        {formatTokenAmount(asset.locked, asset.decimals)} locked ·{' '}
                        {formatTokenAmount(asset.free, asset.decimals)} free
                      </span>
                    </span>
                    <span
                      className={`badge ${asset.locked > 0n ? 'badge-info' : 'badge-ok'}`}
                    >
                      {asset.locked > 0n
                        ? copy.vault.badgePartlyLocked
                        : copy.vault.badgeFree}
                    </span>
                  </div>
                )}
              />
              {vault.data.moreTokens > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ marginTop: 12 }}
                  onClick={() => setScanWindow((w) => w + LIST_WINDOW_PAGE)}
                >
                  {vault.data.moreTokens > LIST_WINDOW_PAGE
                    ? copy.approvals.checkMoreUnchecked(
                        Math.min(LIST_WINDOW_PAGE, vault.data.moreTokens),
                        vault.data.moreTokens,
                      )
                    : copy.approvals.checkMore(
                        Math.min(LIST_WINDOW_PAGE, vault.data.moreTokens),
                      )}
                </button>
              ) : null}
              <p className="muted" style={{ marginTop: 12 }}>
                {copy.vault.lockedHint}
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
