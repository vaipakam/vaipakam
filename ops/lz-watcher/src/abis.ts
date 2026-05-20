/**
 * Minimal ABI shards — just the selectors the three watchers read. Not
 * importing per-facet JSONs from the contracts repo: this Worker only
 * cares about LZ V2 standard surface (`endpoint.getConfig` /
 * `oapp.peers`) plus ERC20 reads, none of which live in the Vaipakam
 * Diamond ABI. Decouples the Worker from the contracts ABI export
 * pipeline that hf-watcher / keeper-bot rely on.
 */

import { parseAbi } from 'viem';

export const ENDPOINT_V2_ABI = parseAbi([
  'function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) view returns (bytes config)',
]);

export const OAPP_CORE_ABI = parseAbi([
  'function peers(uint32 _eid) view returns (bytes32 peer)',
]);

export const ERC20_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** ULN config-type tag — mirror of `SendUln302.CONFIG_TYPE_ULN`.
 *  Pinned to 2 to match what `ConfigureLZConfig.s.sol` writes. */
export const CONFIG_TYPE_ULN = 2;

/** UlnConfig tuple decoder argument for `decodeAbiParameters`. The
 *  on-chain layout (from `@layerzerolabs/lz-evm-messagelib-v2/.../UlnBase.sol`):
 *    struct UlnConfig {
 *        uint64 confirmations;
 *        uint8  requiredDVNCount;
 *        uint8  optionalDVNCount;
 *        uint8  optionalDVNThreshold;
 *        address[] requiredDVNs;
 *        address[] optionalDVNs;
 *    }
 */
export const ULN_CONFIG_DECODE_TYPE = [
  {
    type: 'tuple',
    components: [
      { type: 'uint64', name: 'confirmations' },
      { type: 'uint8', name: 'requiredDVNCount' },
      { type: 'uint8', name: 'optionalDVNCount' },
      { type: 'uint8', name: 'optionalDVNThreshold' },
      { type: 'address[]', name: 'requiredDVNs' },
      { type: 'address[]', name: 'optionalDVNs' },
    ],
  },
] as const;
