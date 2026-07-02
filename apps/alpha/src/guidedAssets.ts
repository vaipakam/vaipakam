import { getDeployment } from '@vaipakam/contracts/deployments';

export const BASE_SEPOLIA_CHAIN_ID = '0x14a34';
export const BASE_SEPOLIA_CHAIN_ID_DECIMAL = 84532;
export const BASE_SEPOLIA_DEPLOYMENT = getDeployment(BASE_SEPOLIA_CHAIN_ID_DECIMAL);

type GuidedAssetEnv = {
  address?: string;
  decimals?: string;
};

export type GuidedAssetOverride = { address: string; decimals: string };

export type GuidedAssetResolution = {
  symbol: string;
  display: string;
  address: string | null;
  decimals: number | null;
  source: 'deployment' | 'environment' | 'missing';
};

export const GUIDED_ASSET_OVERRIDE_STORAGE_KEY = 'vaipakam-app-guided-asset-overrides';
export const GUIDED_CONFIGURABLE_ASSETS = ['mUSDC', 'mWETH', 'mWBTC'] as const;

const GUIDED_ASSET_ENV: Record<string, GuidedAssetEnv> = {
  mUSDC: { address: import.meta.env.VITE_BASE_SEPOLIA_MUSDC_ADDRESS, decimals: import.meta.env.VITE_BASE_SEPOLIA_MUSDC_DECIMALS },
  mWETH: { address: import.meta.env.VITE_BASE_SEPOLIA_WETH_ADDRESS, decimals: import.meta.env.VITE_BASE_SEPOLIA_WETH_DECIMALS },
  mWBTC: { address: import.meta.env.VITE_BASE_SEPOLIA_WBTC_ADDRESS, decimals: import.meta.env.VITE_BASE_SEPOLIA_WBTC_DECIMALS },
};

const GUIDED_ASSET_DECIMALS: Record<string, number> = {
  mUSDC: 6,
  mWETH: 18,
  mWBTC: 8,
  VPFI: 18,
};

export function isGuidedAssetAddress(value: string | undefined): value is string {
  return /^0x[a-fA-F0-9]{40}$/.test(value ?? '');
}

function parseAssetDecimals(value: string | undefined, symbol: string) {
  if (!value) return GUIDED_ASSET_DECIMALS[symbol] ?? null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36 ? parsed : null;
}

export function shortAddress(address: string) {
  return address.slice(0, 6) + '...' + address.slice(-4);
}

export function guidedDefaultAssetDecimals(symbol: string) {
  return GUIDED_ASSET_DECIMALS[symbol] ?? null;
}

function isGuidedAssetOverride(value: unknown): value is GuidedAssetOverride {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as GuidedAssetOverride).address === 'string' &&
    typeof (value as GuidedAssetOverride).decimals === 'string',
  );
}

export function readGuidedAssetOverrides(): Record<string, GuidedAssetOverride> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(GUIDED_ASSET_OVERRIDE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, GuidedAssetOverride] => isGuidedAssetOverride(entry[1])),
    );
  } catch {
    return {};
  }
}

export function writeGuidedAssetOverrides(overrides: Record<string, GuidedAssetOverride>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(GUIDED_ASSET_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
}

function resolvedAsset(symbol: string, address: string, decimals: number | null, source: GuidedAssetResolution['source']): GuidedAssetResolution {
  return {
    symbol,
    address,
    decimals,
    source,
    display: symbol + ' · ' + shortAddress(address) + (decimals === null ? ' · decimals needed' : ''),
  };
}

export function resolveGuidedAsset(symbol: string, overrides: Record<string, GuidedAssetOverride> = readGuidedAssetOverrides()): GuidedAssetResolution {
  if (symbol === 'VPFI' && BASE_SEPOLIA_DEPLOYMENT?.vpfiToken) {
    return resolvedAsset(symbol, BASE_SEPOLIA_DEPLOYMENT.vpfiToken, GUIDED_ASSET_DECIMALS.VPFI, 'deployment');
  }

  if (symbol === 'mWETH' && BASE_SEPOLIA_DEPLOYMENT?.weth) {
    return resolvedAsset(symbol, BASE_SEPOLIA_DEPLOYMENT.weth, GUIDED_ASSET_DECIMALS.mWETH, 'deployment');
  }

  const configured = GUIDED_ASSET_ENV[symbol];
  const override = overrides[symbol];
  if (isGuidedAssetAddress(override?.address)) {
    return resolvedAsset(symbol, override.address, parseAssetDecimals(override.decimals, symbol), 'environment');
  }

  if (isGuidedAssetAddress(configured?.address)) {
    return resolvedAsset(symbol, configured.address, parseAssetDecimals(configured.decimals, symbol), 'environment');
  }

  return {
    symbol,
    address: null,
    decimals: null,
    source: 'missing',
    display: symbol + ' · address needed',
  };
}
