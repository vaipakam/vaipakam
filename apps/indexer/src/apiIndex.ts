/**
 * `GET /` — self-describing index of the indexer's PUBLIC read API.
 *
 * Why: the root URL previously answered `404 Not found`, which is a
 * dead end for the growing class of programmatic consumers (AI
 * agents, aggregators, integrators) that discover the API via
 * vaipakam.com/llms.txt. A machine-readable endpoint catalog at the
 * root turns "scrape the dapp" into "call the supported interface"
 * — the same discoverability convention the llms.txt file follows.
 *
 * Static JSON only — no D1/RPC reads, so it can never add load or
 * leak state; long CDN cache since it changes only on deploy.
 * Documents ONLY the public keyless GET surface (the webhook and
 * signed-offer POST paths are deliberately absent — this is a
 * discovery page for readers, not a full spec).
 */

const API_INDEX = {
  service: 'vaipakam-indexer',
  description:
    'Public read-only JSON API for Vaipakam — decentralized P2P lending, borrowing and NFT rental. Data is indexed from the on-chain Diamond contract. All endpoints are keyless GETs with open CORS.',
  docs: 'https://vaipakam.com/llms.txt',
  website: 'https://vaipakam.com/',
  app: 'https://alpha02.vaipakam.com/',
  conventions: {
    chainParam:
      "Most endpoints accept ?chain=<chainId> (e.g. 84532 for Base Sepolia). Amounts are decimal strings in the asset's smallest unit unless a field says otherwise.",
  },
  endpoints: [
    { method: 'GET', path: '/offers/stats', description: 'Open-offer counts and totals per chain.' },
    { method: 'GET', path: '/offers/active', description: 'The live offer book (paginated).' },
    { method: 'GET', path: '/offers/markets', description: 'Quotable (lending asset, collateral asset, tenor) markets with per-market aggregates.' },
    { method: 'GET', path: '/offers/recent', description: 'Recently created offers.' },
    { method: 'GET', path: '/offers/{id}', description: 'One offer by id.' },
    { method: 'GET', path: '/loans/stats', description: 'Loan counts by status.' },
    { method: 'GET', path: '/loans/active', description: 'Active loans (paginated).' },
    { method: 'GET', path: '/loans/recent', description: 'Recently initiated loans.' },
    { method: 'GET', path: '/loans/timeseries', description: 'Historical loan-activity series.' },
    { method: 'GET', path: '/loans/rate-candles', description: 'Executed-rate OHLC series per market.' },
    { method: 'GET', path: '/loans/{id}', description: 'One loan by id.' },
    { method: 'GET', path: '/activity', description: 'Recent protocol activity feed.' },
    { method: 'GET', path: '/config/{chainId}', description: 'Protocol display-config snapshot for a chain.' },
  ],
} as const;

export function handleApiIndex(req: Request): Response {
  const headers: HeadersInit = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=3600',
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify(API_INDEX, null, 2), { headers });
}
