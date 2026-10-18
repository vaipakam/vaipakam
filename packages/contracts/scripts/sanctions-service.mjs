/**
 * #2443 — what the two unattended sanctions services share: the sanctions
 * ADDER (sanctions-adder.mjs, lists addresses with the list's adder key) and
 * the sanctions DELISTER (sanctions-delister.mjs, proposes delistings to the
 * timelock with its proposer key). Each runs as its own systemd unit with its
 * own key and env file (ops/sanctions/); this module holds only what both
 * read the same way, so a fix to any of it reaches both:
 *
 *   - the chains a service may sign on, and the RPC variable each reads;
 *   - this release's deployments.json, the only source of contract addresses;
 *   - the private-key check;
 *   - how a downloaded OFAC file is kept on disk;
 *   - how one transaction is simulated, signed, recorded and sent;
 *   - the ops-chat alert and the secret redaction applied to everything a run
 *     prints or posts.
 */
import { readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BaseError, RpcRequestError, createPublicClient, createWalletClient, defineChain, http, keccak256 } from 'viem';

/**
 * The chains a sanctions service may sign on, with the RPC variable each
 * reads — the keeper's names, so one machine's operator learns one set.
 * Testnets only, all within the contracts' `TestnetChains.isTestnet`: a
 * mainnet service needs a hardened host, which is not decided (#2443), so no
 * mainnet has a row and none can be configured.
 */
export const SERVICE_CHAINS = Object.freeze([
  { id: 84532, slug: 'base-sepolia', name: 'Base Sepolia', rpcEnv: 'RPC_BASE_SEPOLIA' },
  { id: 421614, slug: 'arb-sepolia', name: 'Arbitrum Sepolia', rpcEnv: 'RPC_ARB_SEPOLIA' },
  { id: 11155111, slug: 'sepolia', name: 'Sepolia', rpcEnv: 'RPC_SEPOLIA' },
  { id: 11155420, slug: 'op-sepolia', name: 'Optimism Sepolia', rpcEnv: 'RPC_OP_SEPOLIA' },
  { id: 97, slug: 'bnb-testnet', name: 'BNB Testnet', rpcEnv: 'RPC_BNB_TESTNET' },
]);

/** The keeper's mainnet RPC names. A copy of keeper.env may carry them; the
 *  services ignore them and say so, since they run on testnets only. */
export const MAINNET_RPC_ENVS = Object.freeze(['RPC_BASE', 'RPC_ETH', 'RPC_ARB', 'RPC_OP', 'RPC_BNB', 'RPC_ZKEVM']);

/** This release's consolidated deployments, keyed by chain id. */
export function loadDeployments() {
  return JSON.parse(readFileSync(new URL('../src/deployments.json', import.meta.url), 'utf8'));
}

/** secp256k1's group order: a private key must be in [1, n). */
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Throws unless `value` (the setting `name`) is a usable private key. */
export function checkPrivateKey(name, value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is not a 32-byte hex key`);
  const scalar = BigInt(value);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) throw new Error(`${name} is not a valid secp256k1 key (zero, or not below the curve order)`);
}

/** The configured chains: every {@link SERVICE_CHAINS} row whose RPC is set. */
export function configuredChains(env) {
  return SERVICE_CHAINS.filter((c) => env[c.rpcEnv]).map((c) => ({ ...c, rpc: env[c.rpcEnv] }));
}

/**
 * Keep a downloaded OFAC file under a name that says what it is
 * (`<prefix>-<YYYYMMDD>-<first 12 hex of its sha256>.xml`), and prune the
 * oldest of that prefix so at most `keep` stay on disk.
 */
export function keepPublication(file, dir, publicationDate, hash, keep, prefix = 'sdn') {
  const name = `${prefix}-${publicationDate}-${hash.slice(2, 14)}.xml`;
  const kept = join(dir, name);
  renameSync(file, kept);
  const mine = new RegExp(`^${prefix}-\\d{8}-[0-9a-f]{12}\\.xml$`);
  const files = readdirSync(dir)
    .filter((f) => mine.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) if (f !== name) rmSync(join(dir, f), { force: true });
  return kept;
}

/** viem clients for one configured chain, signing as `account`. */
export function chainClients(c, account) {
  const chain = defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [c.rpc] } },
  });
  return {
    client: createPublicClient({ chain, transport: http(c.rpc) }),
    wallet: createWalletClient({ account, chain, transport: http(c.rpc) }),
  };
}

/**
 * Send one transaction the way both services do: SIMULATED first, so a call
 * the contract would refuse is reported with its revert reason instead of
 * spending gas; then signed locally and handed to `onSubmitted(hash)` BEFORE
 * it is broadcast, so a send whose outcome is unknown (the node accepted it
 * but the reply was lost) is still reported by hash; then broadcast and
 * waited on until INCLUDED. Throws if it reverts. Returns
 * `{ hash, blockNumber, blockHash }`.
 *
 * When the broadcast call fails, the node is asked for the hash first: if it
 * has the transaction, the failure was the reply's and the send goes on. If
 * it does not, and its answer was a JSON-RPC refusal (nonce, funds, gas), the
 * error carries `notBroadcast` — most likely never broadcast. Any other
 * failure (a timeout, a dropped connection) leaves the outcome unknown.
 */
export async function sendTransaction({ client, wallet, account, to, data, value = 0n, onSubmitted = () => {}, label }) {
  await client.call({ account: account.address, to, data, value });
  const request = await wallet.prepareTransactionRequest({ to, data, value });
  const serializedTransaction = await wallet.signTransaction(request);
  const hash = keccak256(serializedTransaction);
  onSubmitted(hash);
  try {
    await client.sendRawTransaction({ serializedTransaction });
  } catch (e) {
    const known = await client.getTransaction({ hash }).then(
      () => true,
      () => false,
    );
    if (!known) {
      if (e instanceof BaseError && e.walk((x) => x instanceof RpcRequestError)) {
        const refused = new Error(`the node refused ${label} (${hash}) and does not know it: ${e.shortMessage ?? e.message}`, { cause: e });
        refused.notBroadcast = true;
        throw refused;
      }
      throw e;
    }
  }
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (receipt.status !== 'success') throw new Error(`${label} reverted in ${hash}`);
  return { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}

/**
 * A queue per chain: one service may send on the same chain from more than
 * one place in a run (the delister relays a reply on the chain where another
 * timelock lives), and two sends from one key racing for a nonce would
 * replace or reject each other. `run(chainId, fn)` runs `fn` after every
 * earlier send on that chain has settled.
 */
export function createSendQueues() {
  const tails = new Map();
  return {
    run(chainId, fn) {
      const prior = tails.get(chainId) ?? Promise.resolve();
      const next = prior.then(fn, fn);
      tails.set(chainId, next.catch(() => {}));
      return next;
    },
  };
}

/**
 * `text` with every secret in `secrets` replaced. An RPC URL carries its
 * provider's API key, and viem puts the URL in its HTTP errors — which the
 * services print to the journal and post to the ops chat.
 */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('<redacted>');
    // The same URL may be printed without its query string or trailing slash.
    try {
      const u = new URL(secret);
      for (const variant of [`${u.origin}${u.pathname}`, u.pathname.length > 1 ? u.pathname : null, u.search || null]) {
        if (variant) out = out.split(variant).join('<redacted>');
      }
    } catch {}
  }
  return out;
}

/** Telegram refuses a message over 4,096 characters; a long report is cut
 *  below that, and the journal keeps it whole. */
export const TELEGRAM_MAX_TEXT = 4000;
const TELEGRAM_CUT = '\n… (cut to fit the chat; the full report is in the journal)';

/**
 * Post to the ops-internal Telegram chat, prefixed with the service's
 * `label`. Never throws and never prints the token. Returns
 * `{ skipped: true }` when the chat is not configured, `{ delivered: true }`
 * on success, and `{ delivered: false, reason }` otherwise, so the caller can
 * record and surface a failed delivery.
 */
export async function notifyOps({ label, token, chatId, text, fetchImpl = fetch }) {
  if (!token || !chatId) return { skipped: true };
  let message = `[${label}] ${text}`;
  if (message.length > TELEGRAM_MAX_TEXT) message = `${message.slice(0, TELEGRAM_MAX_TEXT - TELEGRAM_CUT.length)}${TELEGRAM_CUT}`;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    });
    return res.ok ? { delivered: true } : { delivered: false, reason: `Telegram answered HTTP ${res.status}` };
  } catch (e) {
    return { delivered: false, reason: `Telegram unreachable: ${redact(e?.message ?? e, [token])}` };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
