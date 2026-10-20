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
 *   - how a downloaded OFAC file is kept on disk, and how a state file is
 *     written;
 *   - how one transaction is simulated, signed, recorded and sent;
 *   - the ops-chat alert and the secret redaction applied to everything a run
 *     prints or posts.
 */
import { readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseError, RpcRequestError, TransactionNotFoundError, createPublicClient, createWalletClient, defineChain, http, keccak256 } from 'viem';

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

/**
 * The private key the setting `name` holds, as `0x` and 64 hex digits; throws
 * unless `value` is a usable one. The key may be written with or without its
 * `0x` prefix and with spaces around it, the forms the keeper accepts for
 * KEEPER_PRIVATE_KEY (apps/keeper/src/keeper.ts, resolveKeeperAccount), so a
 * key copied the way keeper.env holds it works here too. Every caller signs
 * with the returned value, never with `value` itself. The errors never quote
 * the value.
 */
export function readPrivateKey(name, value) {
  const trimmed = String(value ?? '').trim();
  const key = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${name} is not a 32-byte hex key (64 hex digits, with or without 0x)`);
  const scalar = BigInt(key);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) throw new Error(`${name} is not a valid secp256k1 key (zero, or not below the curve order)`);
  return key;
}

/**
 * What redaction removes for a key setting: `value` without spaces around it
 * or its `0x` prefix. Both ways of writing the key contain that, so a message
 * printing either form loses it.
 */
export function privateKeySecret(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
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

/**
 * Write one of a service's state files (its run record, its alert record, a
 * cache) as JSON, bigints as decimal strings, replacing the file whole: the
 * new content goes to a temporary file in the same directory, which is then
 * renamed over the old one, so a crash mid-write never leaves a torn file.
 * NEVER throws. Returns null when the file was written, or why it was not —
 * a full disk, a permission — so the caller records the failure in the run's
 * report instead of losing the report to it. Every state file is the
 * service's own record of its own run, never a source of truth, so a file
 * left unwritten costs work or a repeated alert, never a decision.
 */
export function writeStateFile(dir, name, value) {
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
    renameSync(tmp, path);
    return null;
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return String(e?.message ?? e);
  }
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
 * What a failed send is KNOWN to have done, set as `sendOutcome` on the error
 * {@link sendTransaction} throws. An error without it left the outcome
 * UNKNOWN: the transaction may be in a node's pool or on its way to a block.
 *   not-sent — refused before anything was signed (the simulation reverted,
 *              or preparing or signing failed);
 *   refused  — signed, but the node NAMED a reason it will not take it (see
 *              {@link REFUSAL_REASON}) AND answered a lookup of the hash with
 *              "not found": not broadcast;
 *   reverted — included in a block, and reverted.
 */
export const SEND_OUTCOMES = Object.freeze(['not-sent', 'refused', 'reverted']);
const known = (e, outcome) => Object.assign(e instanceof Error ? e : new Error(String(e)), { sendOutcome: outcome });

/**
 * A node's JSON-RPC answer that names why it will not take a transaction.
 * Only these make a failed broadcast `refused`: any other answer, a JSON-RPC
 * error included, leaves the outcome unknown, which costs one run's sends on
 * that chain and never a nonce. Nodes give no structured code for these (one
 * code covers them all), so the reason is read from the message, as viem
 * itself does; an unrecognised wording only falls back to unknown.
 */
export const REFUSAL_REASON =
  /nonce too (low|high)|insufficient funds|exceeds transaction sender account balance|intrinsic gas too (low|high)|(max fee per gas|fee cap) less than block base fee|(max priority fee per gas higher than max fee per gas|tip higher than fee cap)|replacement transaction underpriced|exceeds block gas limit|transaction type not (valid|supported)/i;
/**
 * A node's answer that it already HOLDS the transaction ("already known",
 * "already imported"). Never a refusal, whatever a lookup then says: behind a
 * load balancer the lookup may reach a node that has not seen it yet. viem
 * files "already known" under NonceTooLowError, which is why this module
 * reads the node's own words rather than viem's class.
 */
export const HELD_ANSWER = /already known|already imported|known transaction|already exists|already in (the )?(mem)?pool/i;

/** What a lookup of `hash` establishes: `held`, a conclusive `absent` (the
 *  node answered "not found"), or `unknown` (the lookup itself failed). */
async function lookUp(client, hash) {
  return client.getTransaction({ hash }).then(
    () => 'held',
    (e) => (e instanceof TransactionNotFoundError || (e instanceof BaseError && e.walk((x) => x instanceof TransactionNotFoundError)) ? 'absent' : 'unknown'),
  );
}

/**
 * Send one transaction the way both services do: SIMULATED first, so a call
 * the contract would refuse is reported with its revert reason instead of
 * spending gas; then signed locally and handed to `onSubmitted(hash)` BEFORE
 * it is broadcast, so a send whose outcome is unknown (the node accepted it
 * but the reply was lost) is still reported by hash; then broadcast and
 * waited on until INCLUDED. Returns `{ hash, blockNumber, blockHash, logs }`
 * from the receipt, so a caller never needs a second read to see what the
 * transaction did. Every error it throws says what is known (see
 * {@link SEND_OUTCOMES}); one that says nothing left the outcome unknown,
 * and carries the `hash`.
 *
 * When the broadcast call fails, the node is asked for the hash. If it has
 * the transaction, or its answer said it already does, the failure was the
 * reply's and the send goes on. The send is `refused` only when BOTH are
 * conclusive: the node's answer names a reason it will not take it, and the
 * lookup answered "not found". Anything less (a lookup that failed, a
 * timeout, a dropped connection, an answer naming no reason) and a receipt
 * that never came leave the outcome unknown.
 */
export async function sendTransaction({ client, wallet, account, to, data, value = 0n, onSubmitted = () => {}, label }) {
  let serializedTransaction;
  try {
    await client.call({ account: account.address, to, data, value });
    const request = await wallet.prepareTransactionRequest({ to, data, value });
    serializedTransaction = await wallet.signTransaction(request);
  } catch (e) {
    throw known(e, 'not-sent');
  }
  const hash = keccak256(serializedTransaction);
  onSubmitted(hash);
  try {
    try {
      await client.sendRawTransaction({ serializedTransaction });
    } catch (e) {
      const rpc = e instanceof BaseError ? e.walk((x) => x instanceof RpcRequestError) : null;
      const answer = String(rpc?.details ?? '');
      const lookup = await lookUp(client, hash);
      if (lookup !== 'held' && !HELD_ANSWER.test(answer)) {
        if (lookup === 'absent' && rpc && REFUSAL_REASON.test(answer)) {
          throw known(new Error(`the node refused ${label} (${hash}) and does not know it: ${e.shortMessage ?? e.message}`, { cause: e }), 'refused');
        }
        throw e;
      }
    }
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (receipt.status !== 'success') throw known(new Error(`${label} reverted in ${hash}`), 'reverted');
    return { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, logs: receipt.logs ?? [] };
  } catch (e) {
    if (e && typeof e === 'object' && !e.sendOutcome) e.hash = hash;
    throw e;
  }
}

/**
 * A queue per chain: one service may send on the same chain from more than
 * one place in a run (the delister relays a reply on the chain where another
 * timelock lives), and two sends from one key racing for a nonce would
 * replace or reject each other. `run(chainId, fn)` runs `fn` after every
 * earlier send on that chain has settled.
 *
 * A send whose outcome is UNKNOWN (its error carries no `sendOutcome`) halts
 * that chain's queue for the rest of the run: the transaction may still be in
 * a pool that the next nonce lookup does not see, and a later send could take
 * its nonce and replace it. Every later `run` on that chain rejects without
 * calling `fn`, with `sendOutcome: 'not-sent'`. A send known to have failed
 * (not sent, refused, reverted) leaves the queue running.
 */
export function createSendQueues() {
  const tails = new Map();
  const halted = new Map();
  return {
    run(chainId, fn) {
      const prior = tails.get(chainId) ?? Promise.resolve();
      const guarded = () => {
        const why = halted.get(chainId);
        if (why) return Promise.reject(known(new Error(`not sent: ${why}`), 'not-sent'));
        return Promise.resolve()
          .then(fn)
          .catch((e) => {
            if (!e?.sendOutcome) {
              halted.set(chainId, `an earlier transaction on chain ${chainId}${e?.hash ? ` (${e.hash})` : ''} has an unknown outcome, and another send could take its nonce; the next run sends once it has settled`);
            }
            throw e;
          });
      };
      const next = prior.then(guarded, guarded);
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
 * record and surface a failed delivery; a refusal's `reason` carries
 * Telegram's own explanation when it gives one.
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
    return res.ok ? { delivered: true } : { delivered: false, reason: `Telegram answered HTTP ${res.status}${await telegramReason(res, token)}` };
  } catch (e) {
    return { delivered: false, reason: `Telegram unreachable: ${redact(e?.message ?? e, [token])}` };
  }
}

/** Telegram's own reason for refusing a message ("Bad Request: chat not
 *  found"), so a refused alert names its cause; empty when the answer carries
 *  none. Cut short, and with the token removed should it ever appear. */
async function telegramReason(res, token) {
  try {
    const { description } = await res.json();
    return typeof description === 'string' && description ? `: ${redact(description, [token]).slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
