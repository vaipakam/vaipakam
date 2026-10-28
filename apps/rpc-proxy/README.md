# apps/rpc-proxy — read-only RPC proxy for the connected app (#1724)

The connected app reads chain state from the browser. Until this Worker, a
build that wanted a keyed provider endpoint put its URL in a `VITE_*_RPC_URL`
variable, and Vite compiles the whole `import.meta.env` object into the
bundle, so the key was readable by anyone who opened the page. This Worker
holds each chain's provider URL as a secret and forwards only the reads the
app makes. A build that sets `VITE_RPC_PROXY_ORIGIN` ships this Worker's
origin and no key.

**Off by default.** Nothing deploys this Worker on merge (it is connected to
no Workers Build), and the app reads chains exactly as before until a build
sets `VITE_RPC_PROXY_ORIGIN`.

## What it forwards

`POST /rpc/<chainId>`, a JSON-RPC call or a batch of up to 50. The rules are
one module, [`packages/lib/src/rpcProxyPolicy.ts`](../../packages/lib/src/rpcProxyPolicy.ts),
which the app also reads to size its batches:

- **Reads only.** A fixed method list: `eth_call`, `eth_estimateGas`, block,
  transaction, receipt, balance, code, storage and nonce reads, fee reads,
  and `eth_getLogs`. Nothing that sends, signs or subscribes:
  `eth_sendRawTransaction` is refused, because the app sends every
  transaction through the user's own wallet.
- **Bounded log scans.** `eth_getLogs` must name 1 to 10 contract addresses
  and either one block hash or a numeric range of at most 2,000 blocks.
  Tags such as `latest` are refused, since a tagged range's width cannot be
  known without another call.
- `eth_chainId` is answered from the route, without asking upstream.

A refused call gets its own JSON-RPC error and the rest of the batch still
goes. Every HTTP-level refusal (rate limit, missing secret, upstream down)
makes the app's transport fall back to the chain's public endpoint, so the
proxy failing degrades reads to what a build without it does today rather
than stopping them.

## What it protects, and what it does not

- **The key stays out of the bundle**, and out of every response and log.
  An upstream error's message is scrubbed of the URL's parts and of anything
  URL- or credential-shaped, and its `data` is passed on only when it is hex
  (revert data, which the app needs to name a contract error).
- **Dedicated keys.** The secrets are `RPC_PROXY_<CHAIN>`, never the
  keeper's or indexer's `RPC_*` entries, so browser traffic cannot spend the
  quota the keeper needs to act on a loan in time.
- **A mis-pointed secret is refused.** The first forwarded request per chain
  in each Worker isolate asks the upstream for its chain id
  (`@vaipakam/lib/rpcIdentity`); an upstream answering for another chain gets
  `502 upstream-chain-mismatch` and nothing is forwarded.
- **The Origin check is not authentication.** It stops another site's page
  from using the proxy through a visitor's browser. A script can send any
  `Origin`, so what bounds a script is the per-IP rate limit
  (`RPC_CALLER_RATELIMIT`, 300 requests a minute, each carrying at most 50
  calls).
- **The rate limit is per Cloudflare location.** Callers spread across many
  addresses can each spend that much. The outer bound is the provider plan
  behind each key: give each `RPC_PROXY_*` key its own plan or spending cap,
  so abuse of the proxy can exhaust only that.
- **No WebSocket.** A proxied build polls for new blocks instead of
  subscribing, so on-page updates after a transaction arrive on the next
  poll rather than at once.

## Why it waits for Workers Paid

The account is on Workers Free (100,000 requests a day across every Worker,
and 10 ms of CPU per request). An open app tab polls for new blocks every
few seconds, which is hundreds of requests an hour before any page reads,
so the free allowance would not carry a public launch.
The owner's decision on #1724 is to build the proxy now and run it on
Workers Paid at mainnet; the app's build refuses a mainnet deployment
without `VITE_RPC_PROXY_ORIGIN`, so the gate cannot be skipped. On the
testnets until then, a keyed URL should be restricted to the app's origins
in the provider's dashboard.

## Turning it on

Each step needs the owner's go-ahead.

1. Create the eight `RPC_PROXY_*` secrets in the account Secrets Store
   (`vaipakam-credentials`, the store the other Workers use), each a new
   provider key restricted to this proxy. `wrangler` validates every
   binding at deploy, so create all eight, or remove a chain's entry from
   `wrangler.jsonc`, before deploying. A chain with no secret answers
   `503 chain-not-configured`.
2. Set `FRONTEND_ORIGIN` to the app's origins if they differ from the
   committed value.
3. `pnpm --filter @vaipakam/rpc-proxy run deploy`, then bind a hostname
   (e.g. `rpc.vaipakam.com`) in the dashboard.
4. Check it: `curl -s -H 'origin: https://app.vaipakam.com' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' https://rpc.vaipakam.com/rpc/84532`
   should return a block number. Without the `origin` header the answer is
   `403`, which is correct.
5. Build the app with `VITE_RPC_PROXY_ORIGIN` set and every
   `VITE_*_RPC_URL` / `VITE_*_WSS_URL` unset (the build refuses otherwise),
   then retire the old keys that shipped in earlier bundles: they were
   public.

## Development

```bash
pnpm --filter @vaipakam/rpc-proxy typecheck
pnpm --filter @vaipakam/rpc-proxy test
```
