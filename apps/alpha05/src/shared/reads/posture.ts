/**
 * The protocol's pause posture (RB-SWITCH class 2 and 4), a chain read that
 * belongs to no one: Home's status strip states it, and every action the
 * global pause closes reads it to name the pause as its refusal.
 */
import type { Abi, PublicClient } from 'viem';
import { AdminFacetABI } from '@vaipakam/contracts/abis';
import { useChainRead } from './chainRead';

const ADMIN = AdminFacetABI as Abi;

export interface ProtocolPosture {
  paused: boolean;
  /** When an automatic pause window ends (unix seconds); 0 when none runs. */
  pausedUntil: bigint;
  keepersPaused: boolean;
}

export async function readPosture(client: PublicClient, diamond: `0x${string}`): Promise<ProtocolPosture> {
  const call = (functionName: string) => client.readContract({ address: diamond, abi: ADMIN, functionName });
  const [paused, pausedUntil, keepersPaused] = await Promise.all([call('paused'), call('pausedUntil'), call('keepersPaused')]);
  return { paused: paused as boolean, pausedUntil: pausedUntil as bigint, keepersPaused: keepersPaused as boolean };
}

/** The posture on the chain the screen describes, shared by every reader. */
export function usePosture(diamond: `0x${string}`) {
  return useChainRead(['posture', diamond], (client) => readPosture(client, diamond));
}
