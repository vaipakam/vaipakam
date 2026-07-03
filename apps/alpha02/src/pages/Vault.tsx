/**
 * Your Vaipakam Vault — the trust surface: where the user's assets
 * actually sit. Per asset: total (clamped to protocol-tracked),
 * locked (backing open offers/loans/rentals), and free.
 */
import { Landmark, LoaderCircle } from 'lucide-react';
import { useModal } from 'connectkit';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useVaultAssets } from '../data/vault';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { formatTokenAmount, shortAddress } from '../lib/format';

export function Vault() {
  const { isConnected, readChain } = useActiveChain();
  const { setOpen } = useModal();
  const vault = useVaultAssets();

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
        <EmptyState icon={LoaderCircle} title="Reading your vault…" />
      ) : vault.depsUnavailable || vault.isError || !vault.data ? (
        <UnavailableState body={copy.vault.unavailable} />
      ) : vault.data.vaultAddress === null ? (
        <EmptyState icon={Landmark} title="No vault yet" body={copy.vault.noVaultYet} />
      ) : (
        <div className="stack">
          <section className="card">
            <p className="muted" style={{ margin: 0 }}>
              Vault address:{' '}
              <a
                href={`${readChain.blockExplorer}/address/${vault.data.vaultAddress}`}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {shortAddress(vault.data.vaultAddress)}
              </a>{' '}
              on {readChain.name}
            </p>
          </section>

          {vault.data.assets.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="Nothing in your vault yet"
              body="Assets appear here when you post offers, open loans, or deposit VPFI."
            />
          ) : (
            <section className="card">
              <div className="row-list">
                {vault.data.assets.map((asset) => (
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
                      {asset.locked > 0n ? 'Partly locked' : 'Free'}
                    </span>
                  </div>
                ))}
              </div>
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
