/**
 * Interaction rewards across a canonical chain and a mirror (#848: PF-120,
 * PF-259, PF-260), on the repository's current contracts:
 *
 *   - one loan on Base and one on the mirror accrue for whole reward days,
 *     then repay;
 *   - each day closes on both chains, the mirror's report crosses the lane,
 *     and Base finalizes the global denominator from BOTH reports — the sum
 *     of the two chains' own figures, as each emitted them (PF-260);
 *   - Base broadcasts each finalized pair and the mirror then knows the same
 *     pair Base finalized (PF-260);
 *   - lender and borrower claim on Base into their wallets: the VPFI they
 *     receive is exactly what running the claim in a reverting frame said it
 *     would pay, the static preview never quoted more, and nothing is left to
 *     claim afterwards (PF-120);
 *   - Base refuses to remit all three owed days in one send, on the fee
 *     quote and on the send alike, naming the one-funded-day bound (#2821);
 *   - Base remits the mirror's budget for those days over the real VPFI
 *     pools, one remittance per day: the VPFI the Base pool locks is the
 *     budget Base quoted, the mirror mints exactly that, and the mirror's
 *     supply stays equal to what Base holds locked;
 *   - each delivery's day is indexed on the mirror (until then it funds
 *     nothing a claim can find); each party's first claim there DEFERS — it
 *     opens the staging domain of the entry's pre-arming slice and pays
 *     nothing — the domain is stepped home permissionlessly, and the next
 *     claim pays in full, out of that remitted budget (PF-259).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import { openMeshScenario, type MeshChain, type MeshScenario } from '@vaipakam/anvil-harness/meshScenario';
import { TOKEN_ABI, type Party } from '@vaipakam/anvil-harness/scenarioChain';
import { BASE_ID, MIRROR_ID } from '@vaipakam/anvil-harness/mesh';
import { protocolMesh } from '../src/fixture';
import { broadcastDays, closeDays, finalizeDays, indexDelivery, remitDays, remitRefusals } from '../src/rewardMesh';

const DAY = 86_400;
const HOUR = 3_600;
/** `LibVaipakam.RewardDelivery.Wallet`: pay the claim to the caller's wallet. */
const TO_WALLET = 1;
/** The days the loans accrue over (accepted on day 0, repaid on day 3). */
const DAYS = [0, 1, 2, 3];
/**
 * Day 0 is never remitted: the remit window starts at day 1. Base funds one
 * day per remittance (#2821): a remittance funding several days would land as
 * one epoch shared by them, and an entry covering those days could never be
 * paid from it, so Base refuses to build one and each day is sent on its own.
 */
const REMITTED_DAYS = [1, 2, 3];
const PARTIES: Party[] = ['lender', 'borrower'];

let m: MeshScenario;

beforeAll(async () => {
  m = await openMeshScenario(protocolMesh, { name: 'protocol-e2e' });
});

afterAll(async () => {
  await m?.stop();
});

/** Move both chains to `hour` hours into reward day `day`. */
async function warpToDay(day: number, hour = 1): Promise<void> {
  const target = m.fixture.interactionLaunchTimestamp + day * DAY + hour * HOUR;
  const now = Math.max(await m.base.now(), await m.mirror.now());
  if (target <= now) throw new Error(`cannot warp back to day ${day} +${hour}h`);
  await m.warp(target - now);
}

function balanceOf(sc: MeshChain, token: Address, who: Address): Promise<bigint> {
  return sc.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
}

function totalSupply(sc: MeshChain, token: Address): Promise<bigint> {
  return sc.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply', args: [] }) as Promise<bigint>;
}

/** The static preview: a lower bound on what a claim pays (the view does not
 *  run the armed pricing walk; `simulateClaimInteractionRewards` does). */
async function staticPreview(sc: MeshChain, who: Party): Promise<bigint> {
  const [amount] = await sc.read<readonly [bigint, bigint, bigint]>('previewInteractionRewards', [sc.address(who)]);
  return amount;
}

/**
 * What `who`'s claim on `sc` would pay to the wallet, by running the claim
 * itself in a frame that always reverts (`simulateClaimInteractionRewards`),
 * or null when the claim would revert for a reason of its own (nothing to
 * claim, among them).
 */
/** Why the last simulation per (chain, party) was refused, for the assertion's message. */
const lastRefusal = new Map<string, string>();

async function simulatedClaim(sc: MeshChain, who: Party): Promise<bigint | null> {
  try {
    await sc.pub.simulateContract({
      account: sc.address(who),
      address: sc.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'simulateClaimInteractionRewards',
      args: [sc.address(who), TO_WALLET],
    } as never);
  } catch (err) {
    const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'InteractionRewardsSimulation') {
      return BigInt((reverted.data.args as readonly bigint[])[0]);
    }
    lastRefusal.set(`${sc.chain.id}:${who}`, reverted instanceof ContractFunctionRevertedError ? `${reverted.data?.errorName ?? reverted.shortMessage}(${((reverted.data?.args ?? []) as readonly unknown[]).join(', ')})` : String(err));
    return null;
  }
  throw new Error('simulateClaimInteractionRewards returned instead of reverting');
}

/**
 * Claim `who`'s rewards on `sc` into the wallet and check the claim against
 * the simulation taken just before it. Returns the amount paid.
 */
async function claimToWallet(sc: MeshChain, token: Address, who: Party): Promise<bigint> {
  const simulated = await simulatedClaim(sc, who);
  expect(simulated, `${who}'s claim on chain ${sc.chain.id} is refused: ${lastRefusal.get(`${sc.chain.id}:${who}`)}`).not.toBeNull();
  expect(simulated!).toBeGreaterThan(0n);
  // The static preview never promises more than the claim pays.
  expect(await staticPreview(sc, who)).toBeLessThanOrEqual(simulated!);
  const before = await balanceOf(sc, token, sc.address(who));
  const from = await sc.blockNumber();
  await sc.diamondWrite(who, 'claimInteractionRewardsTo', [TO_WALLET]);
  const claimed = (await sc.diamondEvents('InteractionRewardsClaimed', from + 1n)).filter(
    (e) => String(e.args.user).toLowerCase() === sc.address(who).toLowerCase(),
  );
  expect(claimed.length).toBe(1);
  expect(BigInt(claimed[0].args.amount as bigint)).toBe(simulated);
  // Wallet delivery: the payout lands in the wallet, never the vault.
  expect((await sc.diamondEvents('RewardDeliveredToVault', from + 1n)).length).toBe(0);
  expect((await balanceOf(sc, token, sc.address(who))) - before).toBe(simulated);
  // Nothing is left to claim.
  expect(await simulatedClaim(sc, who)).toBeNull();
  expect(await staticPreview(sc, who)).toBe(0n);
  return simulated!;
}

/**
 * The mirror's first claim on days its transport epochs fund DEFERS: the
 * entry's pre-arming window is settled as one legacy slice, whose staging
 * domain the claim opens, and the claim pays nothing while the domain has
 * not consumed the epochs' coverage — value staged, never lost. The domain is
 * then driven home by its permissionless step (any caller; a claim that keeps
 * being called steps it too). Returns the entry ids whose slices were stepped.
 */
async function driveDeferredClaim(sc: MeshChain, who: Party): Promise<bigint[]> {
  const from = await sc.blockNumber();
  await sc.diamondWrite(who, 'claimInteractionRewardsTo', [TO_WALLET]);
  const claimed = (await sc.diamondEvents('InteractionRewardsClaimed', from + 1n)).filter(
    (e) => String(e.args.user).toLowerCase() === sc.address(who).toLowerCase(),
  );
  expect(claimed.map((e) => BigInt(e.args.amount as bigint))).toEqual([0n]);
  const opened = (await sc.diamondEvents('LegacySliceDomainOpened', from + 1n)).map((e) => BigInt(e.args.entryId as bigint));
  expect(opened.length, `${who}'s deferring claim opened no slice domain`).toBeGreaterThan(0);
  for (const entryId of opened) {
    let consumed = false;
    // Bounded: a page per call over a few days' records.
    for (let step = 0; step < 32 && !consumed; step++) {
      const { result } = await sc.pub.simulateContract({
        account: sc.address('other'),
        address: sc.diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'stepLegacySlice',
        args: [entryId],
      } as never);
      await sc.diamondWrite('other', 'stepLegacySlice', [entryId]);
      consumed = result as boolean;
    }
    expect(consumed, `entry ${entryId}'s slice domain was not consumed`).toBe(true);
  }
  return opened;
}

describe('interaction rewards on a canonical chain and a mirror', () => {
  it('finalizes each day on Base from both chains’ reports and broadcasts the pair to the mirror', async () => {
    const baseLoan = await openLoan(m.base, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 30 });
    const mirrorLoan = await openLoan(m.mirror, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 30 });
    expect(await m.base.rewardDay()).toBe(0);
    expect(await m.mirror.rewardDay()).toBe(0);

    await warpToDay(3);
    await repayInFull(m.base, 'borrower', baseLoan.loanId);
    await repayInFull(m.mirror, 'borrower', mirrorLoan.loanId);
    await warpToDay(4);

    const baseFrom = await m.base.blockNumber();
    const mirrorFrom = await m.mirror.blockNumber();
    const reports = await closeDays(m, DAYS);
    expect(reports.length).toBe(DAYS.length);
    await finalizeDays(m, DAYS);

    // Each chain's own report, as it emitted it.
    const reported = async (sc: MeshChain, from: bigint) =>
      new Map(
        (await sc.diamondEvents('ChainInterestReported', from + 1n)).map((e) => [
          Number(e.args.dayId),
          { lender: BigInt(e.args.lenderNumeraire18 as bigint), borrower: BigInt(e.args.borrowerNumeraire18 as bigint), chainId: Number(e.args.sourceChainId) },
        ]),
      );
    const baseReports = await reported(m.base, baseFrom);
    const mirrorReports = await reported(m.mirror, mirrorFrom);
    const finalized = new Map<number, { lender: bigint; borrower: bigint }>();
    for (const d of DAYS) {
      const b = baseReports.get(d);
      const r = mirrorReports.get(d);
      expect(b?.chainId).toBe(BASE_ID);
      expect(r?.chainId).toBe(MIRROR_ID);
      const [isFinal, lender, borrower] = await m.base.read<readonly [boolean, bigint, bigint]>('getDailyGlobalInterest', [BigInt(d)]);
      expect(isFinal).toBe(true);
      // The global denominator is the two chains' figures summed.
      expect(lender).toBe(b!.lender + r!.lender);
      expect(borrower).toBe(b!.borrower + r!.borrower);
      finalized.set(d, { lender, borrower });
    }
    // The days the loans were open carry interest from both chains.
    for (const d of [1, 2]) {
      expect(baseReports.get(d)!.lender).toBeGreaterThan(0n);
      expect(mirrorReports.get(d)!.lender).toBeGreaterThan(0n);
      expect(baseReports.get(d)!.borrower).toBeGreaterThan(0n);
      expect(mirrorReports.get(d)!.borrower).toBeGreaterThan(0n);
    }

    const broadcasts = await broadcastDays(m, DAYS);
    expect(broadcasts.length).toBe(DAYS.length);
    for (const d of DAYS) {
      const [lender, borrower, isSet] = await m.mirror.read<readonly [bigint, bigint, boolean]>('getKnownGlobalInterestNumeraire18', [BigInt(d)]);
      expect(isSet).toBe(true);
      expect(lender).toBe(finalized.get(d)!.lender);
      expect(borrower).toBe(finalized.get(d)!.borrower);
    }
  });

  it('pays lender and borrower on Base into their wallets, exactly what the claim simulation said', async () => {
    for (const who of PARTIES) await claimToWallet(m.base, m.fixture.vpfiToken, who);
  });

  it('refuses to fund all three owed days in one remittance (#2821)', async () => {
    const [, perDay] = await m.base.read<readonly [bigint, readonly bigint[]]>('quoteRewardBudget', [MIRROR_ID, REMITTED_DAYS.map(BigInt)]);
    expect(perDay.every((v) => v > 0n), 'every listed day owes the mirror a budget').toBe(true);
    const expected = { name: 'TransportDayFanoutExceeded', args: [BigInt(REMITTED_DAYS.length), 1n] };
    const refused = await remitRefusals(m, REMITTED_DAYS);
    expect(refused.quote).toEqual(expected);
    expect(refused.send).toEqual(expected);
    // One day at a time is admitted by the bound.
    const one = await remitRefusals(m, [REMITTED_DAYS[0]]);
    expect(one.quote).toBeNull();
    expect(one.send).toBeNull();
  });

  it('remits the mirror’s budget over the VPFI pools and pays its claims out of it', async () => {
    const basePool = m.base.fixture.artifact.vpfiTokenPool as Address;
    let remitted = 0n;
    // One remittance per day: see REMITTED_DAYS.
    for (const d of REMITTED_DAYS) {
      const supplyBefore = await totalSupply(m.mirror, m.fixture.vpfiMirror);
      const rem = await remitDays(m, [d]);
      expect(rem.quoted).toBeGreaterThan(0n);
      // Base locks exactly the budget it quoted; the mirror mints exactly that.
      expect(rem.baseLocked).toBe(rem.quoted);
      expect(rem.relayed.tokenAmounts.map((t) => t.amount)).toEqual([rem.quoted]);
      const supplyAfter = await totalSupply(m.mirror, m.fixture.vpfiMirror);
      expect(supplyAfter - supplyBefore).toBe(rem.quoted);
      // Burn/mint against lock/release: the mirror's whole supply is backed by
      // what Base's pool holds locked.
      expect(supplyAfter).toBe(await balanceOf(m.base, m.fixture.vpfiToken, basePool));
      // The delivery funds nothing a claim can find until its day is indexed.
      if (d === REMITTED_DAYS[0]) expect(await simulatedClaim(m.mirror, 'lender')).toBeNull();
      expect(await indexDelivery(m, rem)).toEqual([BigInt(d)]);
      const [, , , dayCount, indexedDays] = await m.mirror.read<readonly [Hex, bigint, bigint, number, number, boolean]>('getTransportBatch', [rem.batchId]);
      expect(Number(indexedDays)).toBe(Number(dayCount));
      remitted += rem.quoted;
    }

    let paid = 0n;
    for (const who of PARTIES) {
      await driveDeferredClaim(m.mirror, who);
      paid += await claimToWallet(m.mirror, m.fixture.vpfiMirror, who);
    }
    // The claims are paid out of the remitted budget, never beyond it.
    expect(paid).toBeLessThanOrEqual(remitted);
  });
});
