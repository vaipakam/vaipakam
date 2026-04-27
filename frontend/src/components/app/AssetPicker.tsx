import { useMemo, useState, useEffect, useRef } from 'react';
import { AlertTriangle, Info, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTopTokens, useStablecoins, useVerifyContract } from '../../hooks/useCoinGecko';
import { platformForChain } from '../../lib/chainPlatforms';
import type { CoinGeckoToken } from '../../lib/coingecko';
import './AssetPicker.css';

export type AssetPickerMode = 'top' | 'stablecoin';

interface AssetPickerProps {
  mode: AssetPickerMode;
  chainId: number | null | undefined;
  value: string;
  onChange: (address: string) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export function AssetPicker({
  mode,
  chainId,
  value,
  onChange,
  label,
  placeholder = '0x...',
  required = false,
  hint,
  disabled = false,
}: AssetPickerProps) {
  const { t } = useTranslation();
  const platformSupported = platformForChain(chainId) !== null;

  const { tokens: topTokens, loading: topLoading } = useTopTokens(
    mode === 'top' && platformSupported ? chainId : null,
    50,
  );
  const { tokens: stableTokens, loading: stableLoading } = useStablecoins(
    mode === 'stablecoin' && platformSupported ? chainId : null,
  );

  const curatedList = mode === 'stablecoin' ? stableTokens : topTokens;
  const listLoading = mode === 'stablecoin' ? stableLoading : topLoading;

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mountedOnce, setMountedOnce] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Defer the flip by a microtask so the setState isn't the synchronous
    // body of the effect (react-hooks/set-state-in-effect). Semantically
    // unchanged: mountedOnce stays false for the first paint, true after.
    const id = setTimeout(() => setMountedOnce(true), 0);
    return () => clearTimeout(id);
  }, []);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const normalizedValue = value.toLowerCase();
  const selectedInList = useMemo(
    () => curatedList.find((t) => t.contractAddress === normalizedValue) ?? null,
    [curatedList, normalizedValue],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return curatedList;
    return curatedList.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.contractAddress.includes(q),
    );
  }, [curatedList, search]);

  // For verification: only run when the address is well-formed, not in the
  // curated list, and the platform is supported.
  const shouldVerify =
    platformSupported &&
    ADDR_RE.test(value) &&
    !selectedInList &&
    (mountedOnce || false);
  const { result: verification, loading: verifying } = useVerifyContract(
    shouldVerify ? chainId : null,
    shouldVerify ? value : null,
  );

  const pickToken = (token: CoinGeckoToken) => {
    onChange(token.contractAddress);
    setDropdownOpen(false);
    setSearch('');
  };

  const clearSelection = () => {
    onChange('');
    setSearch('');
  };

  // Warning/error messaging derived from mode + verification.
  const notice = deriveNotice(mode, platformSupported, value, selectedInList, verification, verifying, t);

  return (
    <div className="asset-picker" ref={rootRef}>
      {label && (
        <label className="form-label">
          {label}
          {required && <span className="asset-picker-required">*</span>}
        </label>
      )}

      {platformSupported ? (
        <>
          <div className="asset-picker-trigger-wrap">
            {selectedInList ? (
              <button
                type="button"
                className="asset-picker-selected"
                onClick={() => !disabled && setDropdownOpen(true)}
                disabled={disabled}
              >
                {selectedInList.image && (
                  <img src={selectedInList.image} alt="" className="asset-picker-logo" />
                )}
                <span className="asset-picker-symbol">{selectedInList.symbol}</span>
                <span className="asset-picker-name">{selectedInList.name}</span>
                {selectedInList.marketCapRank && (
                  <span className="asset-picker-rank">#{selectedInList.marketCapRank}</span>
                )}
                <span className="asset-picker-addr-short">
                  {shortenAddress(selectedInList.contractAddress)}
                </span>
                <button
                  type="button"
                  className="asset-picker-clear"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearSelection();
                  }}
                  aria-label="Clear selection"
                >
                  <X size={14} />
                </button>
              </button>
            ) : (
              <input
                className="form-input"
                placeholder={placeholder}
                value={value}
                onChange={(e) => onChange(e.target.value.trim())}
                onFocus={() => setDropdownOpen(true)}
                required={required}
                disabled={disabled}
              />
            )}
          </div>

          {dropdownOpen && !disabled && (
            <div className="asset-picker-dropdown">
              <div className="asset-picker-search">
                <Search size={14} />
                <input
                  autoFocus
                  placeholder={
                    mode === 'stablecoin'
                      ? 'Search stablecoins…'
                      : 'Search top 50 tokens…'
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {listLoading && <div className="asset-picker-empty">Loading…</div>}
              {!listLoading && filtered.length === 0 && (
                <div className="asset-picker-empty">
                  No matches. You can still paste a contract address below.
                </div>
              )}
              <div className="asset-picker-list">
                {filtered.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="asset-picker-option"
                    onClick={() => pickToken(t)}
                  >
                    {t.image && <img src={t.image} alt="" className="asset-picker-logo" />}
                    <span className="asset-picker-symbol">{t.symbol}</span>
                    <span className="asset-picker-name">{t.name}</span>
                    {t.marketCapRank && (
                      <span className="asset-picker-rank">#{t.marketCapRank}</span>
                    )}
                    <span className="asset-picker-addr-short">
                      {shortenAddress(t.contractAddress)}
                    </span>
                  </button>
                ))}
              </div>
              <div className="asset-picker-custom">
                <label>Or paste a contract address:</label>
                <input
                  className="form-input"
                  placeholder="0x..."
                  value={value}
                  onChange={(e) => onChange(e.target.value.trim())}
                />
              </div>
            </div>
          )}
        </>
      ) : (
        <input
          className="form-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          required={required}
          disabled={disabled}
        />
      )}

      {hint && <span className="form-hint">{hint}</span>}
      {notice && (
        <div className={`asset-picker-notice asset-picker-notice-${notice.level}`}>
          {notice.level === 'warning' || notice.level === 'error' ? (
            <AlertTriangle size={14} />
          ) : (
            <Info size={14} />
          )}
          <span>{notice.message}</span>
        </div>
      )}
    </div>
  );
}

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface Notice {
  level: 'info' | 'warning' | 'error';
  message: string;
}

function deriveNotice(
  mode: AssetPickerMode,
  platformSupported: boolean,
  value: string,
  selectedInList: CoinGeckoToken | null,
  verification: ReturnType<typeof useVerifyContract>['result'],
  verifying: boolean,
  t: TFunction,
): Notice | null {
  if (!platformSupported) {
    if (!value) {
      return {
        level: 'info',
        message: t('assetPicker.tokenDiscoveryUnavailable'),
      };
    }
    return null;
  }

  if (!value) return null;
  if (!ADDR_RE.test(value)) {
    return { level: 'error', message: t('assetPicker.invalidAddress') };
  }
  if (selectedInList) return null;
  if (verifying) return { level: 'info', message: t('assetPicker.verifying') };
  if (!verification) return null;

  if (mode === 'stablecoin') {
    if (!verification.known) {
      return {
        level: 'error',
        message: t('assetPicker.stablecoinNotRecognized'),
      };
    }
    if (!verification.isStablecoin) {
      return {
        level: 'error',
        message: t('assetPicker.notStablecoin', {
          symbol: verification.symbol ?? t('assetPicker.fallbackThis'),
        }),
      };
    }
    return {
      level: 'info',
      message: t('assetPicker.stablecoinRecognized', {
        symbol: verification.symbol ?? t('assetPicker.fallbackToken'),
      }),
    };
  }

  // mode === 'top'
  if (!verification.known) {
    return {
      level: 'warning',
      message: t('assetPicker.tokenNotListed'),
    };
  }
  const rankSuffix = verification.marketCapRank ? ` (rank #${verification.marketCapRank})` : '';
  if (!verification.inTop200) {
    return {
      level: 'warning',
      message: t('assetPicker.tokenOutsideTop200', {
        symbol: verification.symbol ?? t('assetPicker.fallbackThis'),
        rankSuffix,
      }),
    };
  }
  return {
    level: 'info',
    message: t('assetPicker.tokenRecognized', {
      symbol: verification.symbol ?? t('assetPicker.fallbackToken'),
      rankSuffix,
    }),
  };
}
