/**
 * Env types for the LZ-watcher Worker. All chain-specific addresses
 * (LZ endpoint, ULN302 libraries, our OApp suite) come through `vars`
 * in `wrangler.jsonc`; RPC URLs + the Telegram bot token come through
 * `secrets`. The chain config helper in `chains.ts` reads this Env
 * once per cron tick and filters to chains with both an RPC and at
 * least one OApp populated.
 */

export interface Env {
  DB: D1Database;

  // ── Per-chain RPC URLs (secrets) ──────────────────────────────────
  RPC_BASE?: string;
  RPC_ETH?: string;
  RPC_ARB?: string;
  RPC_OP?: string;
  RPC_ZKEVM?: string;
  RPC_BNB?: string;

  // ── Telegram (bot token: secret; chat id: var) ────────────────────
  TG_BOT_TOKEN?: string;
  TG_OPS_CHAT_ID?: string;

  // ── Per-chain LZ endpoint + ULN302 send/receive libraries ─────────
  LZ_ENDPOINT_BASE?: string;
  ULN302_SEND_LIB_BASE?: string;
  ULN302_RECV_LIB_BASE?: string;
  LZ_ENDPOINT_ETH?: string;
  ULN302_SEND_LIB_ETH?: string;
  ULN302_RECV_LIB_ETH?: string;
  LZ_ENDPOINT_ARB?: string;
  ULN302_SEND_LIB_ARB?: string;
  ULN302_RECV_LIB_ARB?: string;
  LZ_ENDPOINT_OP?: string;
  ULN302_SEND_LIB_OP?: string;
  ULN302_RECV_LIB_OP?: string;
  LZ_ENDPOINT_ZKEVM?: string;
  ULN302_SEND_LIB_ZKEVM?: string;
  ULN302_RECV_LIB_ZKEVM?: string;
  LZ_ENDPOINT_BNB?: string;
  ULN302_SEND_LIB_BNB?: string;
  ULN302_RECV_LIB_BNB?: string;

  // ── Per-chain OApp suite (only populated where deployed) ──────────
  OAPP_VPFI_OFT_ADAPTER_BASE?: string;
  OAPP_VPFI_BUY_RECEIVER_BASE?: string;
  OAPP_REWARD_BASE?: string;
  VPFI_TOKEN_BASE?: string;

  OAPP_VPFI_MIRROR_ETH?: string;
  OAPP_VPFI_BUY_ADAPTER_ETH?: string;
  OAPP_REWARD_ETH?: string;

  OAPP_VPFI_MIRROR_ARB?: string;
  OAPP_VPFI_BUY_ADAPTER_ARB?: string;
  OAPP_REWARD_ARB?: string;

  OAPP_VPFI_MIRROR_OP?: string;
  OAPP_VPFI_BUY_ADAPTER_OP?: string;
  OAPP_REWARD_OP?: string;

  OAPP_VPFI_MIRROR_ZKEVM?: string;
  OAPP_VPFI_BUY_ADAPTER_ZKEVM?: string;
  OAPP_REWARD_ZKEVM?: string;

  OAPP_VPFI_MIRROR_BNB?: string;
  OAPP_VPFI_BUY_ADAPTER_BNB?: string;
  OAPP_REWARD_BNB?: string;

  // ── Oversized-flow threshold (VPFI base units, 18 decimals) ───────
  FLOW_THRESHOLD_VPFI?: string;
}
