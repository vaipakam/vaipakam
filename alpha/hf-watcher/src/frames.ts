/**
 * Phase 9.B — Farcaster Frames.
 *
 * Embeddable interactive cards for the Farcaster network. Lets users
 * check any wallet's active Vaipakam loans across every supported
 * chain without leaving their feed.
 *
 * Routes (added to the existing hf-watcher worker):
 *
 *   GET  /frames/active-loans         — initial Frame: text input + Check button
 *   POST /frames/active-loans         — handle button click; render result Frame
 *   GET  /frames/active-loans/image   — SVG image for the result Frame
 *
 * Frame spec: https://docs.farcaster.xyz/learn/what-is-farcaster/frames
 *
 * Reference UX: paste a wallet address → see "X active loans, lowest
 * HF: Y" + a deep-link to the Vaipakam dApp's NFT Verifier (which is
 * the existing per-token verification surface this Frame complements
 * with a per-wallet aggregate view).
 */

import { createPublicClient, http, parseAbi, type Address } from 'viem';
import type { Env } from './env';
import { getChainConfigs } from './env';

// Minimal ABI — same selectors the watcher already uses.
const DIAMOND_FRAME_ABI = parseAbi([
  'function getActiveLoansByUser(address user) view returns (uint256[] memory)',
  'function calculateHealthFactor(uint256 loanId) view returns (uint256)',
]);

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

interface FramePostBody {
  untrustedData?: {
    inputText?: string;
    buttonIndex?: number;
    fid?: number;
  };
}

/**
 * GET /frames/active-loans — initial Frame card with a text input
 * for the wallet address and a single Check button.
 */
export function handleActiveLoansFrameInitial(
  req: Request,
  env: Env,
): Response {
  const baseUrl = _baseUrl(req);
  const html = _frameHtml({
    title: 'Vaipakam — Active Loans Check',
    description: 'Paste any wallet to see its active Vaipakam loans + lowest Health Factor across every supported chain.',
    image: `${baseUrl}/frames/active-loans/image?state=initial`,
    inputPlaceholder: 'Wallet address (0x...)',
    buttons: [{ label: 'Check loans' }],
    postUrl: `${baseUrl}/frames/active-loans`,
    frontendOrigin: env.FRONTEND_ORIGIN.split(',')[0] ?? 'https://vaipakam.com',
  });
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * POST /frames/active-loans — handle the button click. Read cross-
 * chain active loans for the address in `inputText`; render a result
 * Frame with the count, lowest HF, and a "View on Vaipakam" link.
 */
export async function handleActiveLoansFramePost(
  req: Request,
  env: Env,
): Promise<Response> {
  const baseUrl = _baseUrl(req);
  let body: FramePostBody;
  try {
    body = (await req.json()) as FramePostBody;
  } catch {
    return _errorFrame(baseUrl, env, 'Invalid Frame payload.');
  }
  const inputText = (body.untrustedData?.inputText ?? '').trim();
  if (!HEX_ADDR.test(inputText)) {
    return _errorFrame(
      baseUrl,
      env,
      'Address must be a 0x-prefixed 40-character hex string.',
    );
  }
  const wallet = inputText as Address;

  // Read across every configured chain in parallel. Bounded by the
  // worker's CPU time budget (~50ms / chain on a paid RPC).
  const chains = getChainConfigs(env);
  const summaries = await Promise.all(
    chains.map(async (chain) => {
      const client = createPublicClient({ transport: http(chain.rpc) });
      try {
        const loanIds = (await client.readContract({
          address: chain.diamond as Address,
          abi: DIAMOND_FRAME_ABI,
          functionName: 'getActiveLoansByUser',
          args: [wallet],
        })) as readonly bigint[];
        if (loanIds.length === 0) {
          return { chain: chain.name, count: 0, lowestHf: null as number | null };
        }
        // HF reads are individual calls — for typical wallets this
        // is small; for whales we'd want multicall.
        let lowestHf: number | null = null;
        for (const id of loanIds) {
          try {
            const hfRaw = (await client.readContract({
              address: chain.diamond as Address,
              abi: DIAMOND_FRAME_ABI,
              functionName: 'calculateHealthFactor',
              args: [id],
            })) as bigint;
            const hf = Number(hfRaw) / 1e18;
            if (lowestHf === null || hf < lowestHf) lowestHf = hf;
          } catch {
            // Loan with illiquid collateral reverts on HF calc —
            // skip for this aggregate but still count it as an
            // active loan.
          }
        }
        return { chain: chain.name, count: loanIds.length, lowestHf };
      } catch (err) {
        console.error(
          `[frames] chain=${chain.name} err=${String(err).slice(0, 200)}`,
        );
        return { chain: chain.name, count: 0, lowestHf: null as number | null };
      }
    }),
  );

  const totalLoans = summaries.reduce((acc, s) => acc + s.count, 0);
  const lowestHfs = summaries
    .map((s) => s.lowestHf)
    .filter((x): x is number => x !== null);
  const minHf = lowestHfs.length === 0 ? null : Math.min(...lowestHfs);

  const imageQs = new URLSearchParams({
    state: 'result',
    addr: wallet,
    count: String(totalLoans),
  });
  if (minHf !== null) imageQs.set('hf', minHf.toFixed(2));
  // Encode chain breakdown as `chain:count|chain:count|...` for the
  // image renderer.
  const breakdown = summaries
    .filter((s) => s.count > 0)
    .map((s) => `${s.chain}:${s.count}`)
    .join('|');
  if (breakdown) imageQs.set('breakdown', breakdown);

  const frontendOrigin =
    env.FRONTEND_ORIGIN.split(',')[0] ?? 'https://vaipakam.com';

  const buttons = totalLoans === 0
    ? [
        { label: 'Check another wallet' },
        { label: 'Open Vaipakam', action: `${frontendOrigin}/app` },
      ]
    : [
        { label: 'Check another wallet' },
        // The public NFT Verifier is the natural drill-in for this
        // Frame's wallet aggregate — its per-token detail view
        // complements the per-wallet count we render here. Points
        // users at the page so they can paste a Vaipakam-NFT
        // contract + tokenId from the wallet's holdings to see
        // each loan's full state (HF, LTV, role, fallback split).
        {
          label: 'Open NFT Verifier',
          action: `${frontendOrigin}/nft-verifier`,
        },
      ];

  const html = _frameHtml({
    title: 'Vaipakam — Active Loans Result',
    description: `Wallet ${wallet.slice(0, 6)}…${wallet.slice(-4)} has ${totalLoans} active loan${totalLoans === 1 ? '' : 's'}${
      minHf !== null ? `; lowest HF: ${minHf.toFixed(2)}` : ''
    }.`,
    image: `${baseUrl}/frames/active-loans/image?${imageQs.toString()}`,
    // Keep the input visible so users can paste another address
    // without restarting from the initial Frame.
    inputPlaceholder: 'Another wallet address (0x...)',
    buttons,
    postUrl: `${baseUrl}/frames/active-loans`,
    frontendOrigin,
  });
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * GET /frames/active-loans/image — SVG image for the Frame card.
 * Stateless: renders from the query string passed by the Frame's
 * own metadata. Most Farcaster clients accept image/svg+xml.
 */
export function handleActiveLoansFrameImage(req: Request): Response {
  const url = new URL(req.url);
  const state = url.searchParams.get('state') ?? 'initial';
  const addr = url.searchParams.get('addr') ?? '';
  const count = parseInt(url.searchParams.get('count') ?? '0', 10);
  const hf = url.searchParams.get('hf');
  const breakdown = url.searchParams.get('breakdown') ?? '';
  const errMsg = url.searchParams.get('err') ?? '';

  let svg: string;
  if (state === 'error') {
    svg = _errorSvg(errMsg);
  } else if (state === 'initial') {
    svg = _initialSvg();
  } else {
    svg = _resultSvg({
      address: addr,
      count,
      lowestHf: hf,
      breakdown,
    });
  }

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

// ─── HTML / SVG renderers ────────────────────────────────────────

interface FrameHtmlInput {
  title: string;
  description: string;
  image: string;
  inputPlaceholder?: string;
  buttons: Array<{ label: string; action?: string }>;
  postUrl: string;
  frontendOrigin: string;
}

function _frameHtml(input: FrameHtmlInput): string {
  const buttonTags = input.buttons
    .map((b, i) => {
      const idx = i + 1;
      const labelTag = `<meta property="fc:frame:button:${idx}" content="${_esc(b.label)}"/>`;
      if (b.action) {
        return (
          labelTag +
          `<meta property="fc:frame:button:${idx}:action" content="link"/>` +
          `<meta property="fc:frame:button:${idx}:target" content="${_esc(b.action)}"/>`
        );
      }
      return labelTag;
    })
    .join('\n    ');
  const inputTag = input.inputPlaceholder
    ? `<meta property="fc:frame:input:text" content="${_esc(input.inputPlaceholder)}"/>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta property="og:title" content="${_esc(input.title)}" />
    <meta property="og:description" content="${_esc(input.description)}" />
    <meta property="og:image" content="${_esc(input.image)}" />
    <meta property="fc:frame" content="vNext" />
    <meta property="fc:frame:image" content="${_esc(input.image)}" />
    <meta property="fc:frame:image:aspect_ratio" content="1.91:1" />
    ${inputTag}
    ${buttonTags}
    <meta property="fc:frame:post_url" content="${_esc(input.postUrl)}" />
    <title>${_esc(input.title)}</title>
  </head>
  <body>
    <p>${_esc(input.description)}</p>
    <p><a href="${_esc(input.frontendOrigin)}/app">Open Vaipakam</a></p>
  </body>
</html>`;
}

function _initialSvg(): string {
  return _svgFrame([
    { y: 100, size: 36, weight: 700, text: 'Vaipakam', color: '#ffffff' },
    { y: 160, size: 28, weight: 600, text: 'Active Loans Check', color: '#a5b4fc' },
    { y: 280, size: 20, weight: 400, text: 'Paste any wallet address.', color: '#e5e7eb' },
    { y: 320, size: 20, weight: 400, text: 'See active Vaipakam loans across every chain', color: '#e5e7eb' },
    { y: 350, size: 20, weight: 400, text: 'plus the lowest Health Factor.', color: '#e5e7eb' },
    { y: 530, size: 16, weight: 400, text: 'P2P lending fully on-chain.', color: '#9ca3af' },
  ]);
}

function _errorSvg(msg: string): string {
  return _svgFrame([
    { y: 140, size: 32, weight: 700, text: 'Vaipakam — Error', color: '#ef4444' },
    { y: 280, size: 22, weight: 400, text: _truncate(msg, 60), color: '#e5e7eb' },
    { y: 350, size: 20, weight: 400, text: 'Try again with a 0x-prefixed wallet address.', color: '#9ca3af' },
  ]);
}

interface ResultSvgInput {
  address: string;
  count: number;
  lowestHf: string | null;
  breakdown: string;
}

function _resultSvg(input: ResultSvgInput): string {
  const short = `${input.address.slice(0, 6)}…${input.address.slice(-4)}`;
  const lines: SvgLine[] = [
    { y: 90, size: 28, weight: 700, text: 'Vaipakam — Active Loans', color: '#ffffff' },
    { y: 145, size: 20, weight: 500, text: short, color: '#a5b4fc' },
  ];
  if (input.count === 0) {
    lines.push({
      y: 280,
      size: 30,
      weight: 700,
      text: 'No active loans',
      color: '#10b981',
    });
    lines.push({
      y: 340,
      size: 18,
      weight: 400,
      text: 'This wallet has no open Vaipakam positions.',
      color: '#e5e7eb',
    });
  } else {
    lines.push({
      y: 230,
      size: 56,
      weight: 800,
      text: `${input.count} active loan${input.count === 1 ? '' : 's'}`,
      color: '#ffffff',
    });
    if (input.lowestHf) {
      const hfNum = parseFloat(input.lowestHf);
      const color = hfNum < 1 ? '#ef4444' : hfNum < 1.5 ? '#f59e0b' : '#10b981';
      lines.push({
        y: 310,
        size: 24,
        weight: 600,
        text: `Lowest Health Factor: ${input.lowestHf}`,
        color,
      });
    }
    if (input.breakdown) {
      const parts = input.breakdown.split('|').slice(0, 4);
      let y = 380;
      for (const p of parts) {
        const [chain, count] = p.split(':');
        if (!chain || !count) continue;
        lines.push({
          y,
          size: 18,
          weight: 400,
          text: `${chain}: ${count} loan${count === '1' ? '' : 's'}`,
          color: '#9ca3af',
        });
        y += 28;
      }
    }
  }
  lines.push({
    y: 565,
    size: 14,
    weight: 400,
    text: 'vaipakam.com — P2P lending fully on-chain',
    color: '#6b7280',
  });
  return _svgFrame(lines);
}

interface SvgLine {
  y: number;
  size: number;
  weight: number;
  text: string;
  color: string;
}

function _svgFrame(lines: SvgLine[]): string {
  // 1.91:1 aspect ratio at 1146×600 — Farcaster's recommended size.
  const w = 1146;
  const h = 600;
  const textTags = lines
    .map(
      (l) =>
        `<text x="50%" y="${l.y}" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="${l.size}" font-weight="${l.weight}" fill="${l.color}">${_esc(l.text)}</text>`,
    )
    .join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0f0f"/>
      <stop offset="100%" stop-color="#1a1a2e"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${w}" height="6" fill="#4f46e5"/>
  ${textTags}
</svg>`;
}

// ─── Helpers ─────────────────────────────────────────────────────

function _baseUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function _errorFrame(baseUrl: string, env: Env, msg: string): Response {
  const html = _frameHtml({
    title: 'Vaipakam — Error',
    description: msg,
    image: `${baseUrl}/frames/active-loans/image?state=error&err=${encodeURIComponent(msg)}`,
    inputPlaceholder: 'Try again — 0x address',
    buttons: [{ label: 'Retry' }],
    postUrl: `${baseUrl}/frames/active-loans`,
    frontendOrigin: env.FRONTEND_ORIGIN.split(',')[0] ?? 'https://vaipakam.com',
  });
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function _esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
