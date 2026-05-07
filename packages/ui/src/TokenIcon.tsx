import { useState } from 'react';
import { getAddress } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';

/**
 * Trust Wallet's public asset CDN slug per chain id. Trust Wallet's
 * `assets` repo is the most-broadly-mirrored token-logo source, so it
 * covers the long tail of mainstream ERC-20s on the chains we ship on.
 *
 * Testnets are intentionally absent — Trust Wallet doesn't catalog
 * testnet token logos (each fork of Anvil / Sepolia / Base Sepolia
 * spins up a unique `new ERC20Mock(...)` whose address has no
 * mainnet equivalent), so the CDN would 404 every request. The
 * component falls back to a neutral circular placeholder for any
 * chain not in this map, which is the right behaviour on a fresh
 * testnet without spamming the network with doomed image requests.
 */
/**
 * Default icon-URL template — Trust Wallet's purpose-built CDN
 * (`assets-cdn.trustwallet.com`), which mirrors the
 * `trustwallet/assets` GitHub repo with explicit asset-distribution
 * intent. Same images as the raw GitHub endpoint, but without the
 * GitHub-ToS gray area on "using GitHub.com as a CDN" that
 * `raw.githubusercontent.com` lives under — Trust Wallet built the
 * CDN host specifically for wallet / DApp icon traffic.
 *
 * Operator can override via `VITE_TOKEN_ICON_URL_TEMPLATE` to point
 * at any provider that exposes per-chain-per-address logo URLs. Two
 * placeholders supported: `{chainSlug}` (mapped via
 * `TRUST_WALLET_SLUG`) and `{address}` (checksummed).
 *
 * Override examples (paste into the deploy env / `.env` to flip
 * sources without touching code):
 *
 *   # Pull straight from the GitHub repo instead — useful if Trust
 *   # Wallet's CDN ever has propagation lag or downtime, OR for dev
 *   # work where you want the canonical repo source. Watch for
 *   # GitHub-ToS rate-limit caveats at production scale.
 *   VITE_TOKEN_ICON_URL_TEMPLATE=https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/{chainSlug}/assets/{address}/logo.png
 *
 *   # Self-hosted icon registry (Cloudflare R2 / S3 / etc.) — when
 *   # we want zero third-party dependency.
 *   VITE_TOKEN_ICON_URL_TEMPLATE=https://icons.example.com/{chainSlug}/{address}.png
 *
 *   # DefiLlama icons (chain-id keyed; would need code support — the
 *   # current template uses chain SLUG, not chainId). Listed only
 *   # to document that any new template format requires either a
 *   # chain-slug-based provider OR a code change to introduce a
 *   # `{chainId}` placeholder.
 *   # https://icons.llamao.fi/icons/tokens/{chainId}/{address}
 */
const DEFAULT_ICON_URL_TEMPLATE =
  'https://assets-cdn.trustwallet.com/blockchains/{chainSlug}/assets/{address}/logo.png';

/** Chain-agnostic operator override from the env. */
const ENV_ICON_URL_TEMPLATE: string | null =
  ((import.meta.env.VITE_TOKEN_ICON_URL_TEMPLATE as string | undefined) || '').trim() ||
  null;

/**
 * Resolve the icon URL template with three-tier precedence:
 *
 *   1. `VITE_TOKEN_ICON_URL_TEMPLATE` env var — highest priority,
 *      chain-agnostic operator override. Set this in `.env.local`
 *      or the Cloudflare build vars to flip the source for every
 *      chain at once.
 *   2. Per-chain `tokenIconUrlTemplate` from `addresses.json`
 *      (consolidated into `deployments.json` at deploy time) — lets
 *      one specific chain use a different source from the rest
 *      without polluting a global env var. Useful when a chain
 *      has a self-hosted icon registry.
 *   3. Hardcoded `DEFAULT_ICON_URL_TEMPLATE` (Trust Wallet CDN) —
 *      production-grade default that requires zero configuration.
 *
 * The three-tier order matters: env var is the deployment-wide
 * "I'm overriding everywhere" knob, the per-chain field is the
 * "this one chain is special" knob, and the default catches the
 * empty-config case. Resolved per-call (not memoised) because the
 * lookup is O(1) and Vite inlines the env var at build time.
 */
function resolveIconUrlTemplate(chainId: number): string {
  if (ENV_ICON_URL_TEMPLATE) return ENV_ICON_URL_TEMPLATE;
  const dep = getDeployment(chainId);
  if (dep?.tokenIconUrlTemplate && dep.tokenIconUrlTemplate.trim().length > 0) {
    return dep.tokenIconUrlTemplate.trim();
  }
  return DEFAULT_ICON_URL_TEMPLATE;
}

const TRUST_WALLET_SLUG: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  137: 'polygon',
  1101: 'polygonzkevm',
  42161: 'arbitrum',
  10: 'optimism',
  56: 'smartchain',
};

interface Props {
  chainId: number;
  address: string;
  /** Icon size in px. Default 16 — sized for inline use next to a
   *  `<TokenAmount>` cell. Bump for hero / detail surfaces. */
  size?: number;
  className?: string;
}

/**
 * Renders a small circular token icon next to a symbol cell. Source
 * is Trust Wallet's CDN keyed by `(chain-slug, checksumAddress)`. On
 * load failure (testnet mock, unrecognised chain, or token missing
 * from Trust Wallet's index) we render a neutral placeholder rather
 * than nothing — the placeholder occupies the same horizontal space
 * so rows with and without icons share a column rhythm and don't
 * jitter as load events resolve.
 *
 * Loaded icons are cached by the browser indefinitely (Trust Wallet
 * serves long-cache headers on the CDN), so per-row cost amortises
 * to zero across page navigations on the same chain.
 */
export function TokenIcon({ chainId, address, size = 16, className }: Props) {
  const [errored, setErrored] = useState(false);
  const placeholder = (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--bg-card-hover)',
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  );

  const slug = TRUST_WALLET_SLUG[chainId];
  if (!slug || errored) return placeholder;

  // viem's `getAddress` throws on a malformed address; defensively
  // swallow the throw and render the placeholder instead of crashing
  // the surrounding row (a row would otherwise blank out on a single
  // bad address upstream).
  let checksum: string;
  try {
    checksum = getAddress(address);
  } catch {
    return placeholder;
  }

  // URL template is operator-configurable via
  // `VITE_TOKEN_ICON_URL_TEMPLATE`. Supports two placeholders:
  //
  //   {chainSlug}    Trust Wallet chain slug from `TRUST_WALLET_SLUG`
  //                  (e.g. `ethereum`, `base`, `arbitrum`).
  //   {address}      Checksummed token contract address.
  //
  // Default points at Trust Wallet's `trustwallet/assets` GitHub repo
  // (the canonical source — `assets-cdn.trustwallet.com` is just a
  // mirror). Override examples:
  //
  //   # Use the CDN mirror instead
  //   VITE_TOKEN_ICON_URL_TEMPLATE=https://assets-cdn.trustwallet.com/blockchains/{chainSlug}/assets/{address}/logo.png
  //
  //   # Self-hosted icon registry
  //   VITE_TOKEN_ICON_URL_TEMPLATE=https://icons.example.com/{chainSlug}/{address}.png
  //
  //   # DefiLlama (different placeholder shape — would need code
  //   # support; current template uses chain SLUG, not chainId)
  //
  // The chain map is consulted regardless — chains absent from
  // `TRUST_WALLET_SLUG` short-circuit before the template fetch
  // (testnets default-fall through to the placeholder UI).
  const url = resolveIconUrlTemplate(chainId)
    .replace('{chainSlug}', slug)
    .replace('{address}', checksum);
  // No localStorage layer — relying on the browser's HTTP image
  // cache. Trust Wallet's GitHub raw endpoint is fronted by
  // CloudFlare with long-lived cache headers, so subsequent loads
  // (same browser, same address) hit the disk cache near-instantly.
  // On `onError` (404 for testnet mocks, network failure) we swap
  // to the placeholder for the rest of this mount; the browser
  // remembers the 404 status in its own cache for the cache lifetime,
  // so a re-render of the same row doesn't re-fire the request
  // either. Trade-off vs. an explicit localStorage status cache:
  // simpler code, no cache-invalidation logic to own, and the
  // browser's HTTP cache eviction is the right primitive for binary
  // assets — at the cost of negative-result caching being less
  // durable than localStorage would be (private browsing / Safari
  // ITP can evict aggressively, in which case the 404 fires again).
  // Acceptable for our use case; revisit if real-world telemetry
  // shows excessive repeat 404s.
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setErrored(true)}
      className={className}
      style={{
        borderRadius: '50%',
        flexShrink: 0,
        // Neutral background while the image decodes — prevents the
        // brief "broken image" Chrome icon flash on first load.
        background: 'var(--bg-card-hover)',
        objectFit: 'cover',
      }}
    />
  );
}
