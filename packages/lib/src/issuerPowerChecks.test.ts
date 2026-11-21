import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, toFunctionSelector, type Address, type Hex } from 'viem';
import {
  checkAsset,
  EIP1967_ADMIN_SLOT,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  ERC1155_INTERFACE_ID,
  ERC5192_INTERFACE_ID,
  ERC721_INTERFACE_ID,
  functionsIn,
  ISSUER_CHECK_IDS_V2,
  minimalProxyTarget,
  scanCode,
  slotAddress,
  type CallOutcome,
  type Finding,
  type IssuerReadClient,
} from './issuerPowerChecks';
import { ISSUER_POWER_CHECKS } from './issuerPowers';

const A = '0x00000000000000000000000000000000000000a1' as Address;
const IMPL = '0x00000000000000000000000000000000000000b2' as Address;
const ADMIN = '0x00000000000000000000000000000000000000c3' as Address;
const VAULT1 = '0x00000000000000000000000000000000000000d4' as Address;
const VAULT2 = '0x00000000000000000000000000000000000000e5' as Address;

const sel = (sig: string) => toFunctionSelector(sig).slice(2);
/** Code that PUSH4es each selector, then STOP. */
const codeWith = (...sigs: string[]) => `0x${sigs.map((s) => `63${sel(s)}`).join('')}00` as Hex;
const word = (a: Address) => `0x${a.slice(2).padStart(64, '0')}` as Hex;
const ret = (types: string, v: unknown): CallOutcome => ({ kind: 'returned', data: encodeAbiParameters([{ type: types }], [v]) });
const REVERT: CallOutcome = { kind: 'reverted', reason: null };

type Handler = (req: { to: Address; data: Hex; from?: Address }) => CallOutcome | Error;

function client(code: Record<string, Hex>, slots: Record<string, Hex>, calls: Record<string, Handler | CallOutcome> = {}): IssuerReadClient {
  return {
    async getCode(a) {
      return code[a.toLowerCase()] ?? '0x';
    },
    async getStorageAt(a, slot) {
      return slots[`${a.toLowerCase()}:${slot}`] ?? `0x${'0'.repeat(64)}`;
    },
    async call(req) {
      const key = `${req.to.toLowerCase()}:${req.data.slice(0, 10)}`;
      const keyFull = `${req.to.toLowerCase()}:${req.data}`;
      const h = calls[keyFull] ?? calls[key];
      if (h === undefined) return REVERT;
      const out = typeof h === 'function' ? h(req) : h;
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

const iface = (id: Hex) => `0x01ffc9a7${id.slice(2)}${'0'.repeat(56)}`;
const byCheck = (f: Finding[]) => Object.fromEntries(f.map((x) => [x.check, x]));

describe('pure helpers', () => {
  it('reads PUSH4 values by walking opcodes, never inside push data', () => {
    const hidden = `0x7f63${sel('pause()')}${'00'.repeat(27)}00` as Hex; // PUSH32 carrying 63<sel>
    expect(scanCode(hidden).push4.size).toBe(0);
    expect(scanCode(codeWith('pause()')).push4.has(`0x${sel('pause()')}`)).toBe(true);
    expect(scanCode('0x60f4' as Hex).delegatecall).toBe(false); // f4 as push data
    expect(scanCode('0xf4' as Hex).delegatecall).toBe(true);
  });

  it('names the first matched signature per family', () => {
    const hits = functionsIn(scanCode(codeWith('blacklist(address)', 'unpause()')).push4);
    expect(hits.freeze?.name).toBe('blacklist(address)');
    expect(hits.pause?.name).toBe('unpause()');
    expect(hits.admin_transfer).toBeUndefined();
  });

  it('reads slot addresses and minimal proxy targets', () => {
    expect(slotAddress(word(IMPL))).toBe(IMPL);
    expect(slotAddress(`0x${'0'.repeat(64)}`)).toBeNull();
    const clone = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
    expect(minimalProxyTarget(clone)).toBe(IMPL);
  });

  it('writes the ids the shared store lists, less the conduit transfer version 2 does not run', () => {
    expect([...ISSUER_CHECK_IDS_V2, 'conduit_transfer'].sort()).toEqual(Object.keys(ISSUER_POWER_CHECKS).sort());
    expect(ISSUER_CHECK_IDS_V2).not.toContain('conduit_transfer');
  });
});

describe('checkAsset', () => {
  it('a plain ERC-20 seen whole: not_found throughout, the vault move went through', async () => {
    const c2 = client({ [A]: codeWith('transfer(address,uint256)') }, {}, { [`${A}:0x${sel('transfer(address,uint256)')}`]: ret('bool', true) });
    const r = await checkAsset(c2, A, 'erc20', { holder: VAULT1, to: VAULT2, tokenId: 0n });
    const f = byCheck(r.findings);
    expect(r.complete).toBe(true);
    expect(r.detail).toBeNull();
    expect(f.upgradeable_proxy.result).toBe('not_found');
    expect(f.pause.result).toBe('not_found');
    expect(f.freeze.result).toBe('not_found');
    expect(f.admin_transfer.result).toBe('not_found');
    expect(f.paused_now.result).toBe('not_found');
    expect(f.vault_transfer.result).toBe('not_found');
    expect(f.transfer_validator).toBeUndefined();
    expect(f.conduit_transfer).toBeUndefined();
  });

  it('follows an EIP-1967 proxy, finds functions in the implementation and names the admin', async () => {
    const c = client(
      { [A]: '0x3660f4' as Hex, [IMPL]: codeWith('pause()', 'blacklist(address)') },
      { [`${A}:${EIP1967_IMPLEMENTATION_SLOT}`]: word(IMPL), [`${A}:${EIP1967_ADMIN_SLOT}`]: word(ADMIN) },
      { [`${A}:0x${sel('paused()')}`]: ret('bool', true) },
    );
    const r = await checkAsset(c, A, 'erc20', null);
    const f = byCheck(r.findings);
    expect(f.upgradeable_proxy.result).toBe('found');
    expect(f.upgradeable_proxy.evidence).toContain(IMPL);
    expect(f.upgradeable_proxy.evidence).toContain(ADMIN);
    expect(f.pause.evidence).toContain('pause()');
    expect(f.freeze.result).toBe('found');
    expect(f.admin_transfer.result).toBe('not_found');
    expect(f.paused_now.result).toBe('found');
    expect(f.vault_transfer.result).toBe('unknown');
    expect(r.complete).toBe(false);
    expect(r.detail).toContain('vault_transfer');
  });

  it('code that delegates somewhere unfound makes the function checks unknown, never not_found', async () => {
    const c = client({ [A]: '0x6000f4' as Hex }, {});
    const r = await checkAsset(c, A, 'erc20', null);
    const f = byCheck(r.findings);
    expect(f.upgradeable_proxy.result).toBe('unknown');
    for (const k of ['pause', 'freeze', 'admin_transfer'] as const) {
      expect(f[k].result).toBe('unknown');
      expect(f[k].evidence).toContain('delegate');
    }
  });

  it('a beacon whose implementation is unread leaves the function checks unknown', async () => {
    const BEACON = '0x00000000000000000000000000000000000000f6' as Address;
    const c = client({ [A]: '0x6000f4' as Hex }, { [`${A}:${EIP1967_BEACON_SLOT}`]: word(BEACON) });
    const r = await checkAsset(c, A, 'erc20', null);
    const f = byCheck(r.findings);
    expect(f.upgradeable_proxy.result).toBe('found');
    expect(f.pause.result).toBe('unknown');
  });

  it('follows every facet a diamond lists', async () => {
    const F1 = '0x0000000000000000000000000000000000000f01' as Address;
    const F2 = '0x0000000000000000000000000000000000000f02' as Address;
    const c = client(
      { [A]: '0x6000f4' as Hex, [F1]: codeWith('pause()'), [F2]: codeWith('clawback(address,uint256)') },
      {},
      { [`${A}:0x${sel('facetAddresses()')}`]: ret('address[]', [F1, F2]) },
    );
    const f = byCheck((await checkAsset(c, A, 'erc20', null)).findings);
    expect(f.upgradeable_proxy.evidence).toContain('2 facets');
    expect(f.pause.result).toBe('found');
    expect(f.admin_transfer.result).toBe('found');
    expect(f.freeze.result).toBe('not_found');
  });

  it('an RPC that does not answer is unknown with a reason, never a refusal', async () => {
    const boom = () => new Error('https://rpc.example/KEY-SECRET failed');
    const c = client({ [A]: codeWith('transfer(address,uint256)') }, {}, { [`${A}:0x${sel('paused()')}`]: boom, [`${A}:0x${sel('transfer(address,uint256)')}`]: boom });
    const r = await checkAsset(c, A, 'erc20', { holder: VAULT1, to: VAULT2, tokenId: 0n });
    const f = byCheck(r.findings);
    expect(f.paused_now.result).toBe('unknown');
    expect(f.vault_transfer.result).toBe('unknown');
    expect(JSON.stringify(r)).not.toContain('KEY-SECRET');
  });

  it('a refused vault move is found, a false answer from an ERC-20 too', async () => {
    const reverting = client({ [A]: codeWith('transfer(address,uint256)') }, {}, { [`${A}:0x${sel('transfer(address,uint256)')}`]: { kind: 'reverted', reason: 'Blocked' } });
    const f1 = byCheck((await checkAsset(reverting, A, 'erc20', { holder: VAULT1, to: VAULT2, tokenId: 0n })).findings);
    expect(f1.vault_transfer.result).toBe('found');
    expect(f1.vault_transfer.evidence).toContain('Blocked');
    const falsy = client({ [A]: codeWith('transfer(address,uint256)') }, {}, { [`${A}:0x${sel('transfer(address,uint256)')}`]: ret('bool', false) });
    const f2 = byCheck((await checkAsset(falsy, A, 'erc20', { holder: VAULT1, to: VAULT2, tokenId: 0n })).findings);
    expect(f2.vault_transfer.result).toBe('found');
  });

  it('an ERC-721 is detected and gets the NFT checks; the move is called as the holding vault', async () => {
    let from: Address | undefined;
    const c = client(
      { [A]: codeWith('transferFrom(address,address,uint256)') },
      {},
      {
        [`${A}:${iface(ERC721_INTERFACE_ID)}`]: ret('bool', true),
        [`${A}:${iface(ERC5192_INTERFACE_ID)}`]: ret('bool', false),
        [`${A}:0x${sel('getTransferValidator()')}`]: ret('address', ADMIN),
        [`${A}:0x${sel('transferFrom(address,address,uint256)')}`]: (req) => {
          from = req.from;
          return { kind: 'returned', data: '0x' };
        },
      },
    );
    const r = await checkAsset(c, A, 'unknown', { holder: VAULT1, to: VAULT2, tokenId: 7n });
    const f = byCheck(r.findings);
    expect(r.kind).toBe('erc721');
    expect(f.transfer_validator.result).toBe('found');
    expect(f.soulbound.result).toBe('not_found');
    expect(f.vault_transfer.result).toBe('not_found');
    expect(from).toBe(VAULT1);
    expect(f.conduit_transfer).toBeUndefined();
    expect(r.complete).toBe(true);
  });

  it('detects an ERC-1155', async () => {
    const c = client({ [A]: '0x00' as Hex }, {}, { [`${A}:${iface(ERC1155_INTERFACE_ID)}`]: ret('bool', true) });
    expect((await checkAsset(c, A, 'unknown', null)).kind).toBe('erc1155');
  });

  it('an address with no code is a detail, not findings', async () => {
    const r = await checkAsset(client({}, {}), A, 'erc20', null);
    expect(r.findings).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.detail).toBe('the address holds no code');
  });
});
