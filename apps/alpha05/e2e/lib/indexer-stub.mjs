// The stand-in for the two Workers alpha05 reads (plain .mjs: global setup
// spawns it with the stock `node`, no TS loader in the child):
//
//  - the indexer's `GET /health/ingest`, hydrated from the local chain on
//    every request (its cursor is the chain's head, scanned "now"), so the
//    freshness stamp reads a real block and a real age, and the posture
//    control lets a spec put the index into `stale` (cursor half an hour
//    behind), `down` (503) or `other-diamond` (an index describing a
//    protocol contract this build does not bind to) — the three states
//    RB-RAILS says the stamp must tell apart;
//  - the indexer's push rail, `GET /ws/chain/:chainId`: refused with 503,
//    the indexer's own answer while push is off, so the stamp's "push
//    unavailable, polling" line is exercised rather than mocked;
//  - the read-only RPC proxy's `POST /rpc/:chainId`, forwarded to Anvil
//    verbatim (alpha05 refuses a per-chain RPC URL, so this is the ONLY
//    way the dev server's reads reach the fixture chain).
//
// Everything a world read would need beyond health lands with the route
// that reads it (the Home PR adds the position views, the Offers PR the
// book), hydrated from the chain the same way apps/app's stub does.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAIN_ID = 84532;
const ANVIL_URL = process.env.ALPHA05_E2E_ANVIL_URL ?? 'http://127.0.0.1:8546';
const PORT = Number(process.env.ALPHA05_E2E_STUB_PORT ?? 8789);
const STALE_SECONDS = 30 * 60 + 5;
const OTHER_DIAMOND = '0x00000000000000000000000000000000000000ff';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The e2e bundle global setup writes after deploying the fixture (never the
// committed one, whose 84532 entry is the live testnet).
const DEPLOYMENT = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '.state', 'deployments.json'), 'utf8'))[String(CHAIN_ID)];

/** @type {'live' | 'stale' | 'down' | 'other-diamond'} */
let posture = 'live';

async function anvil(method, params = []) {
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function ingestHealth() {
  const head = Number(await anvil('eth_blockNumber'));
  const now = Math.floor(Date.now() / 1000);
  const scannedAt = posture === 'stale' ? now - STALE_SECONDS : now;
  return {
    checkedAt: now,
    schema: { state: 'current', pending: [] },
    chains: [
      {
        chainId: CHAIN_ID,
        deployment: {
          diamond: posture === 'other-diamond' ? OTHER_DIAMOND : DEPLOYMENT.diamond,
          deployBlock: DEPLOYMENT.deployBlock ?? 0,
          adoptedAt: now - 3600,
          resetPending: false,
          adoptedBlind: false,
        },
        lastBlock: head,
        scannedAt,
        ageSeconds: now - scannedAt,
      },
    ],
    configured: { chains: [CHAIN_ID], basis: 'e2e stand-in: the fixture chain' },
    lifecycle: null,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store');
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/') {
      json(res, 200, { service: 'alpha05 e2e stand-in', routes: ['/health/ingest', '/ws/chain/:chainId (503)', '/rpc/:chainId', '/__stub/index-posture'] });
      return;
    }
    if (url.pathname === '/__stub/index-posture' && req.method === 'POST') {
      const { posture: next } = JSON.parse(await readBody(req));
      if (!['live', 'stale', 'down', 'other-diamond'].includes(next)) {
        json(res, 400, { error: `unknown posture ${String(next)}` });
        return;
      }
      posture = next;
      json(res, 200, { posture });
      return;
    }
    if (url.pathname === '/health/ingest') {
      if (posture === 'down') {
        json(res, 503, { error: 'e2e stand-in: index posture is down' });
        return;
      }
      json(res, 200, await ingestHealth());
      return;
    }
    const rpc = url.pathname.match(/^\/rpc\/(\d+)$/);
    if (rpc && req.method === 'POST') {
      // The proxy serves the chains it is bound to; every other id is a 404,
      // as the real Worker answers, so a read for another chain fails loudly
      // here instead of landing on Anvil's single chain.
      if (Number(rpc[1]) !== CHAIN_ID) {
        json(res, 404, { error: `chain ${rpc[1]} is not served` });
        return;
      }
      const body = await readBody(req);
      const upstream = await fetch(ANVIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
      return;
    }
    json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

// The push rail: an upgrade request is refused the way the indexer refuses
// one while push is off. The app's rail then reports unavailable and keeps
// polling, which is the degradable-by-construction behaviour under test.
server.on('upgrade', (req, socket) => {
  socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 42\r\n\r\n{"error":"e2e stand-in: push rail is off"}\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] stand-in Worker on http://127.0.0.1:${PORT} (indexer health + push refusal, proxy route → ${ANVIL_URL})`);
});
