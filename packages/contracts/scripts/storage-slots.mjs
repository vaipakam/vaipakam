/**
 * storage-slots.mjs — the census's view of the pinned storage layout (#1566,
 * design §7/§7a): the HEAD slots the forge probe wrote and the pin test
 * asserts (`contracts/deployments/storage-slots.json`), the era table the
 * era tool wrote (`storage-slot-eras.json`), and the ONE row-slot arithmetic
 * every read uses — `keccak256(abi.encode(uint256 loanId, bytes32 slot))`
 * plus a member offset — pinned by test against rows the compiler loaded.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, keccak256 } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SLOTS_PATH = join(HERE, '..', '..', '..', 'contracts', 'deployments', 'storage-slots.json');
export const ERAS_PATH = join(HERE, '..', '..', '..', 'contracts', 'deployments', 'storage-slot-eras.json');

export function loadSlots(path = SLOTS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function loadEras(path = ERAS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The slot of `mapping[loanId]`'s first member: keccak256(abi.encode(loanId, mappingSlot)). */
export function rowSlot(loanId, mappingSlot) {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [BigInt(loanId), mappingSlot]));
}

/** `rowSlot` plus a member offset, as a 32-byte hex slot. */
export function memberSlot(loanId, mappingSlot, offset) {
  return '0x' + (BigInt(rowSlot(loanId, mappingSlot)) + BigInt(offset)).toString(16).padStart(64, '0');
}
