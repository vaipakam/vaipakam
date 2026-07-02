import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ExternalLink, Search, X } from 'lucide-react';
import { platformForChain } from '@vaipakam/lib/chainPlatforms';
import type { CoinGeckoToken } from '@vaipakam/lib/coingecko';
import { shortenAddr } from '@vaipakam/lib/address';
import { useMode } from '../context/ModeContext';
import { useStablecoins, useTopTokens, useVerifyContract } from '../hooks/useCoinGecko';
import { getChainByChainId } from '../lib/chains';
import { mergeCuratedTokens } from '../lib/curatedAssets';
import { contractExplorerUrl } from '../lib/explorer';
import { AssetSymbolLink } from './AssetSymbolLink';
import { peekTokenMeta } from '../lib/tokenMeta';
import './BasicAssetPicker.css';

export type BasicAssetPickerKind = 'stablecoin' | 'collateral';

interface Props {
  kind: BasicAssetPickerKind;
  chainId: number;
  value: string;
  onChange: (address: string) => void;
  label: string;
  hint?: string;
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export function BasicAssetPicker({ kind, chainId, value, onChange, label, hint }: Props) {
  const { mode } = useMode();
  const allowCustom = mode === 'advanced';
  const platformSupported = platformForChain(chainId) !== null;

  const { tokens: topRemote, loading: topLoading } = useTopTokens(
    kind === 'collateral' && platformSupported ? chainId : null,
    30,
  );
  const { tokens: stableRemote, loading: stableLoading } = useStablecoins(
    kind === 'stablecoin' && platformSupported ? chainId : null,
  );

  const remote = kind === 'stablecoin' ? stableRemote : topRemote;
  const listLoading = kind === 'stablecoin' ? stableLoading : topLoading;

  const options = useMemo(() => mergeCuratedTokens(chainId, remote), [chainId, remote]);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const normalized = value.toLowerCase();
  const selected = useMemo(
    () => options.find((t) => t.contractAddress === normalized) ?? null,
    [options, normalized],
  );

  const displaySymbol = selected
    ? selected.symbol
    : peekTokenMeta(value, chainId)?.symbol || (value ? shortenAddr(value) : '');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.contractAddress.includes(q),
    );
  }, [options, search]);

  const shouldVerify =
    allowCustom && platformSupported && ADDR_RE.test(value) && !selected;
  const { result: verification, loading: verifying } = useVerifyContract(
    shouldVerify ? chainId : null,
    shouldVerify ? value : null,
  );

  function pick(token: CoinGeckoToken) {
    onChange(token.contractAddress);
    setOpen(false);
    setSearch('');
  }

  const notice = deriveNotice(kind, allowCustom, value, selected, verification, verifying);
  const blockExplorer = getChainByChainId(chainId)?.blockExplorer ?? '';
  const pickerMeta = selected
    ? {
        address: selected.contractAddress,
        symbol: selected.symbol,
        decimals: peekTokenMeta(selected.contractAddress, chainId)?.decimals ?? 18,
        chainId,
      }
    : peekTokenMeta(value, chainId);

  return (
    <div className="field basic-asset-picker" ref={rootRef}>
      <label>{label}</label>

      <div className="basic-asset-picker-trigger-row">
        {value && ADDR_RE.test(value) && displaySymbol ? (
          <AssetSymbolLink
            address={value}
            meta={pickerMeta}
            showIcon
            className="basic-asset-picker-symbol"
          />
        ) : (
          <span className="basic-asset-picker-symbol">{displaySymbol || 'Choose asset'}</span>
        )}
        <button
          type="button"
          className="basic-asset-picker-trigger"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {selected ? (
            <span className="basic-asset-picker-meta">{selected.name}</span>
          ) : value ? (
            <span className="basic-asset-picker-meta">{shortenAddr(value)}</span>
          ) : (
            <span className="basic-asset-picker-meta">Select from list</span>
          )}
          <ChevronDown size={18} className="basic-asset-picker-chevron" />
        </button>
      </div>

      {open ? (
        <div className="basic-asset-picker-panel">
          <div className="basic-asset-picker-search">
            <Search size={14} />
            <input
              autoFocus
              placeholder={kind === 'stablecoin' ? 'Search stablecoins…' : 'Search assets…'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {listLoading ? <p className="basic-asset-picker-empty">Loading assets…</p> : null}
          {!listLoading && filtered.length === 0 ? (
            <p className="basic-asset-picker-empty">No matches in the curated list.</p>
          ) : null}
          <div className="basic-asset-picker-list">
            {filtered.map((t) => {
              const href = contractExplorerUrl(blockExplorer, t.contractAddress);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`basic-asset-picker-option ${t.contractAddress === normalized ? 'selected' : ''}`}
                  onClick={() => pick(t)}
                >
                  <AssetSymbolLink
                    address={t.contractAddress}
                    meta={{
                      address: t.contractAddress,
                      symbol: t.symbol,
                      decimals: peekTokenMeta(t.contractAddress, chainId)?.decimals ?? 18,
                      chainId,
                    }}
                    className="basic-asset-picker-symbol"
                  />
                  <span className="basic-asset-picker-meta">{t.name}</span>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="basic-asset-picker-explorer"
                      aria-label={`View ${t.symbol} on explorer`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink size={14} />
                    </a>
                  ) : null}
                  {t.marketCapRank ? (
                    <span className="basic-asset-picker-rank">#{t.marketCapRank}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {allowCustom ? (
            <div className="basic-asset-picker-custom">
              <label>Or paste contract address</label>
              <input
                placeholder="0x…"
                value={value}
                onChange={(e) => onChange(e.target.value.trim())}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {hint ? <span className="form-hint">{hint}</span> : null}
      {notice ? (
        <div className={`basic-asset-picker-notice basic-asset-picker-notice-${notice.level}`}>
          <AlertTriangle size={14} />
          <span>{notice.message}</span>
        </div>
      ) : null}

      {value && selected ? (
        <button
          type="button"
          className="basic-asset-picker-clear"
          onClick={() => onChange('')}
          aria-label="Clear asset"
        >
          <X size={14} /> Clear
        </button>
      ) : null}
    </div>
  );
}

function deriveNotice(
  kind: BasicAssetPickerKind,
  allowCustom: boolean,
  value: string,
  selected: CoinGeckoToken | null,
  verification: ReturnType<typeof useVerifyContract>['result'],
  verifying: boolean,
): { level: 'info' | 'warning' | 'error'; message: string } | null {
  if (!value) return null;
  if (selected) return null;
  if (!allowCustom) {
    return {
      level: 'warning',
      message: 'Pick an asset from the list. Basic mode only supports widely-used blue-chip assets.',
    };
  }
  if (!ADDR_RE.test(value)) {
    return { level: 'error', message: 'Enter a valid contract address (0x…).' };
  }
  if (verifying) return { level: 'info', message: 'Checking token listing…' };
  if (!verification) return null;
  if (kind === 'stablecoin') {
    if (!verification.known || !verification.isStablecoin) {
      return { level: 'warning', message: 'This address is not a recognized stablecoin on CoinGecko.' };
    }
    return null;
  }
  if (!verification.known) {
    return { level: 'warning', message: 'Not listed on CoinGecko — verify the contract before using.' };
  }
  if (!verification.inTop200) {
    return { level: 'warning', message: 'Outside the top 200 by market cap — higher risk than blue-chip assets.' };
  }
  return null;
}