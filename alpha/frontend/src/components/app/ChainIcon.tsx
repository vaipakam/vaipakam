/**
 * `<ChainIcon>` — small coloured badge representing a chain, keyed off
 * its chainId. Used inline in the wallet-address pill and the chain
 * switcher menu so users can recognise which chain a row refers to
 * without reading the name.
 *
 * Why an internal `chainId → (bg, abbr)` table instead of fields on
 * `ChainConfig`?
 *
 *   - These are pure visual concerns (brand-colour + 1-3 char glyph),
 *     orthogonal to protocol-shaped fields like Diamond address, LZ
 *     eid, etc. Keeping them out of `ChainConfig` avoids 11+ duplicate
 *     entries on every new chain and keeps the config file's focus on
 *     "what does the protocol need to know about this chain".
 *   - Adding a brand new chain with no mapping just falls through to
 *     a neutral grey badge with the chain's first letter — fine
 *     fallback while the visual treatment catches up.
 *
 * Colours match each chain's published brand identity so the badge
 * reads as familiar at a glance: Ethereum slate-blue, Base bright
 * blue, BNB yellow, Arbitrum cyan, Optimism red, Polygon purple.
 * Testnet variants reuse the mainnet colour (recognition stays
 * intact) and the chainSwitcher's own "Testnet" group label
 * disambiguates.
 */

interface ChainStyle {
  /** Hex background colour of the badge. */
  bg: string;
  /** Glyph rendered inside — 1–3 characters, uppercase. */
  abbr: string;
}

const STYLE_BY_CHAIN: Record<number, ChainStyle> = {
  1:        { bg: '#627EEA', abbr: 'E' },   // Ethereum
  11155111: { bg: '#627EEA', abbr: 'S' },   // Sepolia (Ethereum-blue)
  8453:     { bg: '#0052FF', abbr: 'B' },   // Base
  84532:    { bg: '#0052FF', abbr: 'B' },   // Base Sepolia
  56:       { bg: '#F0B90B', abbr: 'BNB' }, // BNB Chain
  97:       { bg: '#F0B90B', abbr: 'BNB' }, // BNB Testnet
  42161:    { bg: '#28A0F0', abbr: 'A' },   // Arbitrum One
  421614:   { bg: '#28A0F0', abbr: 'A' },   // Arbitrum Sepolia
  10:       { bg: '#FF0420', abbr: 'OP' },  // Optimism
  11155420: { bg: '#FF0420', abbr: 'OP' },  // OP Sepolia
  1101:     { bg: '#7B3FE4', abbr: 'P' },   // Polygon zkEVM
  2442:     { bg: '#7B3FE4', abbr: 'P' },   // Polygon zkEVM Cardona
  137:      { bg: '#7B3FE4', abbr: 'P' },   // Polygon (legacy, kept for safety)
  80002:    { bg: '#7B3FE4', abbr: 'P' },   // Polygon Amoy (legacy)
};

const FALLBACK: ChainStyle = { bg: 'var(--text-tertiary)', abbr: '?' };

export interface ChainIconProps {
  /** Numeric chainId. Falls back to a neutral badge when unknown. */
  chainId: number | null | undefined;
  /** Pixel size — defaults to 18 to match the inline x-height of
   *  0.85rem address pills. */
  size?: number;
  /** Additional class on the outer span (e.g. for margin tweaks at a
   *  specific callsite). */
  className?: string;
}

export function ChainIcon({ chainId, size = 18, className }: ChainIconProps) {
  const style = (chainId != null && STYLE_BY_CHAIN[chainId]) || FALLBACK;
  // Pick a font size proportional to the badge so 1-, 2-, and 3-char
  // abbreviations all read at roughly the same visual weight without
  // pinning them with separate breakpoints.
  const fontSize =
    style.abbr.length >= 3
      ? Math.round(size * 0.4)
      : style.abbr.length === 2
        ? Math.round(size * 0.5)
        : Math.round(size * 0.55);
  return (
    <span
      className={`chain-icon${className ? ' ' + className : ''}`}
      style={{
        width: size,
        height: size,
        background: style.bg,
        fontSize,
      }}
      aria-hidden="true"
    >
      {style.abbr}
    </span>
  );
}

export default ChainIcon;
