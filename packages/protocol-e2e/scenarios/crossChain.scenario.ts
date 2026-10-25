/**
 * The cross-chain positive flows (#848: PF-261, PF-257, PF-333) on a
 * canonical chain and a mirror joined by a local CCIP lane of real CCIP
 * contracts, on the repository's current contracts:
 *
 *   - VPFI out and back (PF-261): a holder sends VPFI from Base to the mirror
 *     through the CCIP router and back again. Base's lock/release pool locks
 *     and releases, the mirror's burn/mint pool mints and burns, the holder
 *     ends where they started, Base's supply never moves, and the mirror's
 *     supply always equals what Base's pool holds locked;
 *   - the tier push (PF-257): a holder who deposits VPFI into their vault and
 *     keeps it there past the minimum staked duration pokes their tier on
 *     Base, Base pays the broadcast from its protocol budget, and the mirror's
 *     cache then holds the tier and discount Base resolved;
 *   - the guardian pause (PF-333): with the guardian a different address from
 *     the owner, as on a live deployment, the guardian pauses the mirror's
 *     reward-remittance receiver; a remittance Base sends then cannot land
 *     and stays waiting, the guardian cannot unpause, and once the owner
 *     unpauses the same message lands with its VPFI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEther, type Abi, type Address, type Hex } from 'viem';
import { openMeshScenario, type MeshChain, type MeshScenario } from '@vaipakam/anvil-harness/meshScenario';
import { TOKEN_ABI, type Party } from '@vaipakam/anvil-harness/scenarioChain';
import { BASE_ID, MIRROR_ID } from '@vaipakam/anvil-harness/mesh';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import { protocolMesh } from '../src/fixture';
import { broadcastDays, closeDays, finalizeDays, REMIT_LANE_CAP } from '../src/rewardMesh';

const DAY = 86_400;
const HOUR = 3_600;

/** The CCIP router's send surface (`Router.sol`, `Client.EVM2AnyMessage`). */
const MESSAGE = {
  type: 'tuple',
  components: [
    { name: 'receiver', type: 'bytes' },
    { name: 'data', type: 'bytes' },
    { name: 'tokenAmounts', type: 'tuple[]', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] },
    { name: 'feeToken', type: 'address' },
    { name: 'extraArgs', type: 'bytes' },
  ],
} as const;
const ROUTER_ABI = [
  { type: 'function', name: 'getFee', stateMutability: 'view', inputs: [{ name: 'destinationChainSelector', type: 'uint64' }, { name: 'message', ...MESSAGE }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ccipSend', stateMutability: 'payable', inputs: [{ name: 'destinationChainSelector', type: 'uint64' }, { name: 'message', ...MESSAGE }], outputs: [{ type: 'bytes32' }] },
] as const satisfies Abi;

/** `GuardianPausable` (owner + guardian pause, owner-only unpause). */
const PAUSABLE_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'guardian', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setGuardian', stateMutability: 'nonpayable', inputs: [{ name: 'newGuardian', type: 'address' }], outputs: [] },
  { type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const satisfies Abi;

let m: MeshScenario;

beforeAll(async () => {
  m = await openMeshScenario(protocolMesh, { name: 'protocol-e2e' });
});

afterAll(async () => {
  await m?.stop();
});

function balanceOf(sc: MeshChain, token: Address, who: Address): Promise<bigint> {
  return sc.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
}

function totalSupply(sc: MeshChain, token: Address): Promise<bigint> {
  return sc.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply', args: [] }) as Promise<bigint>;
}

/** Base's lock/release pool, and the VPFI it holds locked. */
function basePool(): Address {
  return m.base.fixture.artifact.vpfiTokenPool as Address;
}

/** Give `who` `amount` canonical VPFI from the Base admin (who holds the initial supply). */
async function fundVpfi(who: Party, amount: bigint): Promise<void> {
  await m.base.write('admin', m.fixture.vpfiToken, TOKEN_ABI, 'transfer', [m.base.address(who), amount]);
}

/** Send `amount` of `token` from `who` on `from` to the same address on the
 *  other chain through the router, at the router's quoted fee. */
async function bridge(from: MeshChain, token: Address, who: Party, amount: bigint): Promise<void> {
  const router = from.fixture.lane.router;
  const message = {
    receiver: `0x${from.address(who).slice(2).toLowerCase().padStart(64, '0')}` as Hex,
    data: '0x' as Hex,
    tokenAmounts: [{ token, amount }],
    feeToken: '0x0000000000000000000000000000000000000000' as Address,
    extraArgs: '0x' as Hex,
  };
  const dest = BigInt(from.fixture.lane.remoteChainSelector);
  const fee = (await from.pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'getFee', args: [dest, message] })) as bigint;
  await from.write(who, token, TOKEN_ABI, 'approve', [router, amount]);
  await from.write(who, router, ROUTER_ABI, 'ccipSend', [dest, message], fee);
}

describe('cross-chain flows on a canonical chain and a mirror', () => {
  it('moves VPFI from Base to the mirror and back with the mirror supply backed by what Base locks', async () => {
    const out = parseEther('100');
    const back = parseEther('40');
    await fundVpfi('other', out);
    const holder = m.base.address('other');
    const baseSupply = await totalSupply(m.base, m.fixture.vpfiToken);
    const lockedBefore = await balanceOf(m.base, m.fixture.vpfiToken, basePool());
    const mirrorSupplyBefore = await totalSupply(m.mirror, m.fixture.vpfiMirror);
    const backed = async () => expect(await totalSupply(m.mirror, m.fixture.vpfiMirror)).toBe(await balanceOf(m.base, m.fixture.vpfiToken, basePool()));
    await backed();

    // Out: Base locks, the mirror mints to the same holder.
    await bridge(m.base, m.fixture.vpfiToken, 'other', out);
    expect(await balanceOf(m.base, m.fixture.vpfiToken, holder)).toBe(0n);
    expect(await balanceOf(m.base, m.fixture.vpfiToken, basePool())).toBe(lockedBefore + out);
    // Nothing exists on the mirror until the message lands.
    expect(await totalSupply(m.mirror, m.fixture.vpfiMirror)).toBe(mirrorSupplyBefore);
    const outbound = await m.relay.deliver(BASE_ID, MIRROR_ID);
    expect(outbound.map((r) => r.tokenAmounts.map((t) => t.amount))).toEqual([[out]]);
    expect(await balanceOf(m.mirror, m.fixture.vpfiMirror, holder)).toBe(out);
    await backed();

    // Back: the mirror burns, Base releases.
    await bridge(m.mirror, m.fixture.vpfiMirror, 'other', back);
    expect(await balanceOf(m.mirror, m.fixture.vpfiMirror, holder)).toBe(out - back);
    expect(await totalSupply(m.mirror, m.fixture.vpfiMirror)).toBe(mirrorSupplyBefore + out - back);
    const inbound = await m.relay.deliver(MIRROR_ID, BASE_ID);
    expect(inbound.map((r) => r.tokenAmounts.map((t) => t.amount))).toEqual([[back]]);
    expect(await balanceOf(m.base, m.fixture.vpfiToken, holder)).toBe(back);
    expect(await balanceOf(m.base, m.fixture.vpfiToken, basePool())).toBe(lockedBefore + out - back);
    await backed();
    // Canonical VPFI is never minted or burned by a crossing.
    expect(await totalSupply(m.base, m.fixture.vpfiToken)).toBe(baseSupply);
  });

  it('pushes the tier Base resolves for a staker into the mirror cache', async () => {
    const stake = parseEther('1500'); // tier 2 (>= 1,000)
    const who: Party = 'lender';
    const user = m.base.address(who);
    // The broadcast is protocol-funded and fails closed on an empty budget.
    await m.base.diamondWrite('admin', 'topUpBroadcastBudget', [], parseEther('1'));
    await fundVpfi(who, stake);
    await m.base.diamondWrite(who, 'setVPFIDiscountConsent', [true]);
    await m.base.write(who, m.fixture.vpfiToken, TOKEN_ABI, 'approve', [m.base.diamond, stake]);
    await m.base.diamondWrite(who, 'depositVPFIToVault', [stake]);
    // Whatever the deposit pushed (no tier yet: the stake has no tenure) lands first.
    await m.relay.deliver(BASE_ID, MIRROR_ID);

    // Past the minimum staked duration, the poke resolves the tier. The
    // scenario pins that minimum to its lower bound (2 days; the setter
    // admits 2–14) so the warp below is a known distance past it.
    const minDays = 2;
    await m.base.diamondWrite('admin', 'setTwaMinStakedDays', [minDays]);
    await m.warp((minDays + 1) * DAY + HOUR);
    const [effTier, effBps] = await m.base.read<readonly [number, number]>('getEffectiveDiscount', [user]);
    expect(Number(effTier)).toBe(2);
    const from = await m.base.blockNumber();
    await m.base.diamondWrite(who, 'pokeMyTier');
    const sent = (await m.base.diamondEvents('ProtocolTierBroadcastSent', from + 1n)).filter((e) => String(e.args.user).toLowerCase() === user.toLowerCase());
    expect(sent.length).toBe(1);
    expect(Number(sent[0].args.effectiveTier)).toBe(Number(effTier));
    expect(Number(sent[0].args.effectiveBps)).toBe(Number(effBps));

    const landed = await m.relay.deliver(BASE_ID, MIRROR_ID);
    expect(landed.length).toBe(1);
    const cache = await m.mirror.read<{ effectiveTier: number; effectiveBps: number; lastNonce: bigint }>('getUserTierCache', [user]);
    expect(Number(cache.effectiveTier)).toBe(Number(effTier));
    expect(Number(cache.effectiveBps)).toBe(Number(effBps));
    expect(BigInt(cache.lastNonce)).toBe(BigInt(sent[0].args.nonce as bigint));
    // The mirror's effective discount is Base's, read from that cache: the
    // holder has no VPFI on the mirror at all. Consent is per chain, so the
    // holder gives it on the mirror too (without it the mirror applies none).
    expect(await balanceOf(m.mirror, m.fixture.vpfiMirror, user)).toBe(0n);
    expect(await m.mirror.read<readonly [number, number]>('getEffectiveDiscount', [user])).toEqual([0, 0]);
    await m.mirror.diamondWrite(who, 'setVPFIDiscountConsent', [true]);
    const [mirrorTier, mirrorBps] = await m.mirror.read<readonly [number, number]>('getEffectiveDiscount', [user]);
    expect([Number(mirrorTier), Number(mirrorBps)]).toEqual([Number(effTier), Number(effBps)]);
  });

  it('holds a remittance at a guardian-paused mirror receiver and lands it once the owner unpauses', async () => {
    const receiver = m.mirror.fixture.artifact.rewardRemittanceReceiver as Address;
    const owner = (await m.mirror.pub.readContract({ address: receiver, abi: PAUSABLE_ABI, functionName: 'owner' })) as Address;
    // The fixture is admin-owned, as every testnet is.
    expect(owner.toLowerCase()).toBe(m.mirror.address('admin').toLowerCase());
    // A live deployment's guardian is not its owner: install one that is not.
    await m.mirror.write('admin', receiver, PAUSABLE_ABI, 'setGuardian', [m.mirror.address('other')]);

    // A finalized day with mirror interest, so Base owes the mirror a budget.
    const loan = await openLoan(m.mirror, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 30 });
    const startDay = await m.mirror.rewardDay();
    const launch = m.fixture.interactionLaunchTimestamp;
    const nowMax = Math.max(await m.base.now(), await m.mirror.now());
    await m.warp(launch + (startDay + 3) * DAY + HOUR - nowMax);
    await repayInFull(m.mirror, 'borrower', loan.loanId);
    await m.warp(DAY);
    const today = await m.base.rewardDay();
    const days = Array.from({ length: today }, (_, d) => d);
    await closeDays(m, days);
    await finalizeDays(m, days);
    await broadcastDays(m, days);
    const owed = [startDay + 1, startDay + 2];
    const [quoted] = await m.base.read<readonly [bigint, readonly bigint[]]>('quoteRewardBudget', [MIRROR_ID, owed.map(BigInt)]);
    expect(quoted).toBeGreaterThan(0n);

    // The guardian pauses the receiver; the owner did not have to.
    await m.mirror.write('other', receiver, PAUSABLE_ABI, 'pause');
    expect(await m.mirror.pub.readContract({ address: receiver, abi: PAUSABLE_ABI, functionName: 'paused' })).toBe(true);

    const [fee] = await m.base.read<readonly [bigint, bigint]>('quoteRemittanceFee', [MIRROR_ID, owed.map(BigInt)]);
    await m.base.diamondWrite('keeper', 'remitRewardBudget', [MIRROR_ID, owed.map(BigInt), REMIT_LANE_CAP], fee);
    const mirrorSupply = await totalSupply(m.mirror, m.fixture.vpfiMirror);
    // The paused receiver refuses it: nothing mints, and the message waits.
    await expect(m.relay.deliver(BASE_ID, MIRROR_ID)).rejects.toThrow();
    expect((await m.relay.pending(BASE_ID, MIRROR_ID)).length).toBe(1);
    expect(await totalSupply(m.mirror, m.fixture.vpfiMirror)).toBe(mirrorSupply);

    // Only the owner unpauses.
    await expect(m.mirror.write('other', receiver, PAUSABLE_ABI, 'unpause')).rejects.toThrow();
    await m.mirror.write('admin', receiver, PAUSABLE_ABI, 'unpause');
    const landed = await m.relay.deliver(BASE_ID, MIRROR_ID);
    expect(landed.length).toBe(1);
    expect(landed[0].tokenAmounts.map((t) => t.amount)).toEqual([quoted]);
    expect(await totalSupply(m.mirror, m.fixture.vpfiMirror)).toBe(mirrorSupply + quoted);
    expect((await m.relay.pending(BASE_ID, MIRROR_ID)).length).toBe(0);
  });
});
