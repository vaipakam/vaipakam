/**
 * Per-chain config: maps an Env into the full `ChainCtx` object the
 * watchers consume. Every chain row resolves the LZ endpoint, the
 * ULN302 send/receive libraries, the Vaipakam OApp roles deployed on
 * that chain, and the LZ V2 eid (the cross-chain "endpoint id" that
 * the OApp peer table is keyed by).
 *
 * A chain is included only if its RPC URL is populated AND the
 * endpoint+libraries are non-empty. OApp slots that are empty are
 * silently dropped from that chain's OApp list — useful when bringing
 * the mesh up incrementally.
 *
 * Eids reference LZ V2 mainnet endpoints. Testnet eids differ; for
 * a Sepolia-only dev run, override `LZ_ENDPOINT_*` to point at the
 * testnet endpoint and add the testnet eids to `EID_BY_CHAIN_ID`.
 */

import type { Address } from 'viem';
import type { Env } from './env';

export type OAppRole =
  | 'vpfi_oft_adapter'
  | 'vpfi_mirror'
  | 'vpfi_buy_adapter'
  | 'vpfi_buy_receiver'
  | 'reward_oapp';

export interface OAppEntry {
  role: OAppRole;
  address: Address;
}

export interface ChainCtx {
  chainId: number;
  name: string;
  shortKey: 'BASE' | 'ETH' | 'ARB' | 'OP' | 'ZKEVM' | 'BNB';
  lzEid: number;
  rpc: string;
  endpoint: Address;
  uln302SendLib: Address;
  uln302ReceiveLib: Address;
  oapps: OAppEntry[];
  vpfiToken?: Address;
  isCanonical: boolean;
}

const EID_BY_CHAIN_ID: Record<number, number> = {
  1: 30101, // Ethereum
  8453: 30184, // Base
  42161: 30110, // Arbitrum One
  10: 30111, // Optimism
  1101: 30267, // Polygon zkEVM
  56: 30102, // BNB Chain
};

const NAME_BY_CHAIN_ID: Record<number, string> = {
  1: 'Ethereum',
  8453: 'Base',
  42161: 'Arbitrum',
  10: 'Optimism',
  1101: 'Polygon zkEVM',
  56: 'BNB Chain',
};

function isHexAddress(value: string | undefined): value is `0x${string}` {
  return !!value && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function pushOApp(
  list: OAppEntry[],
  role: OAppRole,
  address: string | undefined,
): void {
  if (isHexAddress(address)) {
    list.push({ role, address: address as Address });
  }
}

export function getChainContexts(env: Env): ChainCtx[] {
  const out: ChainCtx[] = [];

  // Each block resolves a single chain. Identical shape — kept inline
  // rather than data-driven because TypeScript narrows env-key access
  // better when the keys are literal.

  // ── Base (canonical) ───────────────────────────────────────────────
  if (
    env.RPC_BASE &&
    isHexAddress(env.LZ_ENDPOINT_BASE) &&
    isHexAddress(env.ULN302_SEND_LIB_BASE) &&
    isHexAddress(env.ULN302_RECV_LIB_BASE)
  ) {
    const oapps: OAppEntry[] = [];
    pushOApp(oapps, 'vpfi_oft_adapter', env.OAPP_VPFI_OFT_ADAPTER_BASE);
    pushOApp(oapps, 'vpfi_buy_receiver', env.OAPP_VPFI_BUY_RECEIVER_BASE);
    pushOApp(oapps, 'reward_oapp', env.OAPP_REWARD_BASE);
    out.push({
      chainId: 8453,
      name: NAME_BY_CHAIN_ID[8453]!,
      shortKey: 'BASE',
      lzEid: EID_BY_CHAIN_ID[8453]!,
      rpc: env.RPC_BASE,
      endpoint: env.LZ_ENDPOINT_BASE as Address,
      uln302SendLib: env.ULN302_SEND_LIB_BASE as Address,
      uln302ReceiveLib: env.ULN302_RECV_LIB_BASE as Address,
      oapps,
      vpfiToken: isHexAddress(env.VPFI_TOKEN_BASE)
        ? (env.VPFI_TOKEN_BASE as Address)
        : undefined,
      isCanonical: true,
    });
  }

  // ── Ethereum ───────────────────────────────────────────────────────
  if (
    env.RPC_ETH &&
    isHexAddress(env.LZ_ENDPOINT_ETH) &&
    isHexAddress(env.ULN302_SEND_LIB_ETH) &&
    isHexAddress(env.ULN302_RECV_LIB_ETH)
  ) {
    const oapps: OAppEntry[] = [];
    pushOApp(oapps, 'vpfi_mirror', env.OAPP_VPFI_MIRROR_ETH);
    pushOApp(oapps, 'vpfi_buy_adapter', env.OAPP_VPFI_BUY_ADAPTER_ETH);
    pushOApp(oapps, 'reward_oapp', env.OAPP_REWARD_ETH);
    out.push({
      chainId: 1,
      name: NAME_BY_CHAIN_ID[1]!,
      shortKey: 'ETH',
      lzEid: EID_BY_CHAIN_ID[1]!,
      rpc: env.RPC_ETH,
      endpoint: env.LZ_ENDPOINT_ETH as Address,
      uln302SendLib: env.ULN302_SEND_LIB_ETH as Address,
      uln302ReceiveLib: env.ULN302_RECV_LIB_ETH as Address,
      oapps,
      isCanonical: false,
    });
  }

  // ── Arbitrum ───────────────────────────────────────────────────────
  if (
    env.RPC_ARB &&
    isHexAddress(env.LZ_ENDPOINT_ARB) &&
    isHexAddress(env.ULN302_SEND_LIB_ARB) &&
    isHexAddress(env.ULN302_RECV_LIB_ARB)
  ) {
    const oapps: OAppEntry[] = [];
    pushOApp(oapps, 'vpfi_mirror', env.OAPP_VPFI_MIRROR_ARB);
    pushOApp(oapps, 'vpfi_buy_adapter', env.OAPP_VPFI_BUY_ADAPTER_ARB);
    pushOApp(oapps, 'reward_oapp', env.OAPP_REWARD_ARB);
    out.push({
      chainId: 42161,
      name: NAME_BY_CHAIN_ID[42161]!,
      shortKey: 'ARB',
      lzEid: EID_BY_CHAIN_ID[42161]!,
      rpc: env.RPC_ARB,
      endpoint: env.LZ_ENDPOINT_ARB as Address,
      uln302SendLib: env.ULN302_SEND_LIB_ARB as Address,
      uln302ReceiveLib: env.ULN302_RECV_LIB_ARB as Address,
      oapps,
      isCanonical: false,
    });
  }

  // ── Optimism ───────────────────────────────────────────────────────
  if (
    env.RPC_OP &&
    isHexAddress(env.LZ_ENDPOINT_OP) &&
    isHexAddress(env.ULN302_SEND_LIB_OP) &&
    isHexAddress(env.ULN302_RECV_LIB_OP)
  ) {
    const oapps: OAppEntry[] = [];
    pushOApp(oapps, 'vpfi_mirror', env.OAPP_VPFI_MIRROR_OP);
    pushOApp(oapps, 'vpfi_buy_adapter', env.OAPP_VPFI_BUY_ADAPTER_OP);
    pushOApp(oapps, 'reward_oapp', env.OAPP_REWARD_OP);
    out.push({
      chainId: 10,
      name: NAME_BY_CHAIN_ID[10]!,
      shortKey: 'OP',
      lzEid: EID_BY_CHAIN_ID[10]!,
      rpc: env.RPC_OP,
      endpoint: env.LZ_ENDPOINT_OP as Address,
      uln302SendLib: env.ULN302_SEND_LIB_OP as Address,
      uln302ReceiveLib: env.ULN302_RECV_LIB_OP as Address,
      oapps,
      isCanonical: false,
    });
  }

  // ── Polygon zkEVM ──────────────────────────────────────────────────
  if (
    env.RPC_ZKEVM &&
    isHexAddress(env.LZ_ENDPOINT_ZKEVM) &&
    isHexAddress(env.ULN302_SEND_LIB_ZKEVM) &&
    isHexAddress(env.ULN302_RECV_LIB_ZKEVM)
  ) {
    const oapps: OAppEntry[] = [];
    pushOApp(oapps, 'vpfi_mirror', env.OAPP_VPFI_MIRROR_ZKEVM);
    pushOApp(oapps, 'vpfi_buy_adapter', env.OAPP_VPFI_BUY_ADAPTER_ZKEVM);
    pushOApp(oapps, 'reward_oapp', env.OAPP_REWARD_ZKEVM);
    out.push({
      chainId: 1101,
      name: NAME_BY_CHAIN_ID[1101]!,
      shortKey: 'ZKEVM',
      lzEid: EID_BY_CHAIN_ID[1101]!,
      rpc: env.RPC_ZKEVM,
      endpoint: env.LZ_ENDPOINT_ZKEVM as Address,
      uln302SendLib: env.ULN302_SEND_LIB_ZKEVM as Address,
      uln302ReceiveLib: env.ULN302_RECV_LIB_ZKEVM as Address,
      oapps,
      isCanonical: false,
    });
  }

  // ── BNB Chain ──────────────────────────────────────────────────────
  if (
    env.RPC_BNB &&
    isHexAddress(env.LZ_ENDPOINT_BNB) &&
    isHexAddress(env.ULN302_SEND_LIB_BNB) &&
    isHexAddress(env.ULN302_RECV_LIB_BNB)
  ) {
    const oapps: OAppEntry[] = [];
    pushOApp(oapps, 'vpfi_mirror', env.OAPP_VPFI_MIRROR_BNB);
    pushOApp(oapps, 'vpfi_buy_adapter', env.OAPP_VPFI_BUY_ADAPTER_BNB);
    pushOApp(oapps, 'reward_oapp', env.OAPP_REWARD_BNB);
    out.push({
      chainId: 56,
      name: NAME_BY_CHAIN_ID[56]!,
      shortKey: 'BNB',
      lzEid: EID_BY_CHAIN_ID[56]!,
      rpc: env.RPC_BNB,
      endpoint: env.LZ_ENDPOINT_BNB as Address,
      uln302SendLib: env.ULN302_SEND_LIB_BNB as Address,
      uln302ReceiveLib: env.ULN302_RECV_LIB_BNB as Address,
      oapps,
      isCanonical: false,
    });
  }

  return out;
}

/** Lookup helper used by the DVN-count drift watcher: given the source
 *  chain context, return every other chain's eid as a candidate peer.
 *  The watcher will skip eids whose `peers(oapp, eid)` returns 0. */
export function peerEidCandidates(self: ChainCtx, all: ChainCtx[]): number[] {
  return all
    .filter((c) => c.chainId !== self.chainId)
    .map((c) => c.lzEid);
}
