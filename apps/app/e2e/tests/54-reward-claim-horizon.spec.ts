/**
 * RL-3 claim horizon (#1956) — both ratified user safeguards, proven on a
 * REAL reward entry with a non-zero horizon (#3207).
 *
 * GovernanceRunbook Step 6 requires the free in-app pre-expiry notice and the
 * Claim Center countdown before `setRewardClaimHorizonDays` is set. Neither can
 * appear on a live chain before that knob is set, so this drive is where they
 * are proven before arming. The runbook re-verifies them live right after
 * arming, on the first touched entry. Everything below happens on this
 * suite's Anvil chain, through the protocol's own entry points:
 *
 *   1. The chain becomes a single-chain CANONICAL reward deployment by the
 *      same forge script the keeper's Anvil scenarios use
 *      (`ConfigureKeeperRewardsFixture`: VPFI token, canonical reward role
 *      with this chain as the only reporter, interaction launch, reward
 *      custody, a funded pool, the testnet sanctions overlay), broadcast as
 *      the fixture admin.
 *   2. A real loan between two wallets no other spec uses accrues reward days
 *      and is repaid; the days are closed and finalized (`closeDay` /
 *      `finalizeDay`, permissionless), which makes each side's interaction
 *      reward entry claimable.
 *   3. The admin sets a 180-day horizon. A keeper-style touch
 *      (`sweepExpiredInteractionRewards`) starts each entry's clock, and the
 *      Claim Center shows the countdown: the `getRewardEntryExpiry` estimate,
 *      as a date, in the app's own copy.
 *   4. Touches every six days (inside the contract's seven-day maximum
 *      observation gap) accrue the horizon until the sweep emits
 *      `RewardEntryExpiryArmed`. The bell then shows the final-notice row,
 *      and the countdown switches to its final-notice wording.
 *   5. Touches across the 90-day notice reach `RewardEntryExpiryBegun`, and
 *      the bell shows the removal row.
 *
 * WHERE THE BELL'S ROWS COME FROM. The indexer stub serves a wallet that the
 * chain has addressed claim-horizon events to the rows the indexer's OWN
 * planner (`@vaipakam/lib/rewardOwnerNotifications`, which
 * `apps/indexer/src/notifications.ts` re-exports) derives from those real
 * logs. Nothing here writes a row. The spec checks the feed against the
 * sweep receipts' own decoded logs (entry, notice start, block, log index),
 * then checks that the bell renders it.
 *
 * ISOLATION. Step 1 cannot be undone through the protocol (custody activation
 * is one-way), and steps 3 to 5 move the clock about 300 days. So the whole
 * drive runs between an `evm_snapshot` and an `evm_revert`, and the next spec
 * finds the chain, its clock included, exactly as this one found it. A
 * Playwright retry starts again from that same state.
 */
import { decodeEventLog, parseEther, type Account, type Hex, type Log } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { compileScript, runForgeScript } from '@vaipakam/anvil-harness/fixture';
import { planOwnerNotifications } from '@vaipakam/lib/rewardOwnerNotifications';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { ANVIL_URL, anvilRpc, increaseTime, setBalance } from '../lib/anvil';
import { sendAsAdmin } from '../lib/admin';
import { loadAdminKey } from '../lib/artifacts';
import {
  CHAIN_ID,
  DIAMOND,
  DIAMOND_ABI_VIEM,
  ERC20_MIN_ABI,
  WETH,
  confirm,
  forkChain,
  pub,
  walletFor,
} from '../lib/chain';
import { acceptOfferDirect, repayLoanInFull, seedDeskOffer } from '../lib/desk';
import { accountFor, type Role } from '../lib/wallets';
import { copySource as copy } from '../../src/content/copy';

const DAY = 86_400;
const HORIZON_DAYS = 180;
const NOTICE_DAYS = 90;
/** Inside the contract's seven-day maximum observation gap, with margin. */
const STEP_SEC = 6 * DAY;
const REWARDS_SCRIPT = 'script/e2e/ConfigureKeeperRewardsFixture.s.sol';
/** VPFI behind the pool's live fresh row: far above what one loan's few
 *  reward days can owe, so funding never gates the claim. */
const REWARD_POOL_FUND = 1_000_000n * 10n ** 18n;
/** `isDayReadyToFinalize`'s reason for a day already finalized. */
const ALREADY_FINALIZED = 1;
const STUB_ORIGIN = `http://127.0.0.1:${Number(process.env.APP_E2E_STUB_PORT ?? 8788)}`;
const ZERO = '0x0000000000000000000000000000000000000000';

const LENDER: Role = 'rewardLender';
const BORROWER: Role = 'rewardBorrower';

const read = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI_VIEM, functionName, args } as never) as Promise<T>;

async function chainNow(): Promise<number> {
  return Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
}

/** A Diamond write from `account`, required to land. */
async function diamondWrite(account: Account, functionName: string, args: readonly unknown[], label: string) {
  const hash = await walletFor(account).writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName,
    args,
    account,
    chain: forkChain,
  } as never);
  return confirm(hash, label);
}

interface HorizonLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
}

/** The Diamond's claim-horizon events in a receipt, decoded by the ABI. */
function horizonLogs(logs: readonly Log[]): HorizonLog[] {
  const out: HorizonLog[] = [];
  for (const l of logs) {
    if (l.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: DIAMOND_ABI_VIEM, data: l.data, topics: l.topics as never, strict: false });
      if (!String(ev.eventName).startsWith('RewardEntry')) continue;
      out.push({
        eventName: String(ev.eventName),
        args: (ev.args ?? {}) as Record<string, unknown>,
        blockNumber: l.blockNumber as bigint,
        logIndex: l.logIndex as number,
      });
    } catch {
      /* not a Diamond event this spec reads */
    }
  }
  return out;
}

/** Close and finalize every reward day from 0 through `lastDay` — the
 *  canonical chain is its own only reporter, so a reported day finalizes on
 *  full coverage (`@vaipakam/anvil-harness/rewardDays`, the keeper suite's
 *  `finalizeThrough`, on this suite's clients). */
async function finalizeThrough(caller: Account, launch: number, lastDay: number): Promise<void> {
  const today = Math.floor(((await chainNow()) - launch) / DAY);
  if (lastDay >= today) throw new Error(`day ${lastDay} has not elapsed (today is day ${today})`);
  for (let d = 0; d <= lastDay; d++) {
    const [, reason] = await read<readonly [boolean, number]>('isDayReadyToFinalize', [BigInt(d)]);
    if (Number(reason) === ALREADY_FINALIZED) continue;
    if ((await read<bigint>('getChainReportSentAt', [BigInt(d)])) === 0n) {
      await diamondWrite(caller, 'closeDay', [BigInt(d)], `closeDay(${d})`);
    }
    await diamondWrite(caller, 'finalizeDay', [BigInt(d)], `finalizeDay(${d})`);
  }
}

/** The date as the app writes it (`formatDate`, en-US before and after the
 *  i18n default, in the browser's — this machine's — time zone). */
function appDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The soonest-expiry read the Claim Center makes, for a wallet with one entry. */
async function soonestExpiry(owner: `0x${string}`): Promise<{ entryId: bigint; expiresAt: number }> {
  const [entryId, expiresAt, nextOffset, total] = await read<readonly [bigint, bigint, bigint, bigint]>(
    'getUserSoonestRewardExpiry',
    [owner, 0n, 1_000n, 100n],
  );
  expect(nextOffset, 'one page covers the wallet').toBe(total);
  return { entryId, expiresAt: Number(expiresAt) };
}

interface FeedRow {
  id: number;
  kind: string;
  loanId: number | null;
  offerId: number | null;
  eventKind: string | null;
  data: { entryId?: string; finalNoticeFrom?: number } | null;
  createdAt: number;
  blockNumber: number;
  logIndex: number;
}

async function stubFeed(owner: `0x${string}`): Promise<FeedRow[]> {
  const res = await fetch(`${STUB_ORIGIN}/notifications/${owner}?chainId=${CHAIN_ID}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { notifications: FeedRow[] }).notifications;
}

/** What the feed must carry for `log`, from the receipt alone. */
function expectedFeedFields(log: HorizonLog, at: number) {
  const data: Record<string, unknown> = { entryId: String(log.args.entryId) };
  if (log.args.finalNoticeFrom !== undefined) data.finalNoticeFrom = Number(log.args.finalNoticeFrom);
  return {
    loanId: null,
    offerId: null,
    eventKind: log.eventName,
    data,
    createdAt: at,
    blockNumber: Number(log.blockNumber),
    logIndex: log.logIndex,
  };
}

test('the claim horizon: countdown, final notice and removal on a real reward entry', async ({ launchWallet }) => {
  // Compile (cached after the first run), configure, a loan, ~300 days of
  // touches and three page visits.
  test.setTimeout(900_000);
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    const lender = accountFor(LENDER).address;
    const borrower = accountFor(BORROWER).address;
    // The permissionless touches come from a fresh account, as the platform
    // keeper's would.
    const keeper = privateKeyToAccount(generatePrivateKey());
    await setBalance(keeper.address, 10n ** 19n);

    // ---- 1. The canonical reward posture, by the operator's script ----
    expect(await read<`0x${string}`>('getVPFIToken'), 'the fixture starts with no VPFI token').toBe(ZERO);
    compileScript(REWARDS_SCRIPT);
    runForgeScript(REWARDS_SCRIPT, ANVIL_URL, {
      ADMIN_PRIVATE_KEY: loadAdminKey(),
      DIAMOND_ADDRESS: DIAMOND,
      REWARD_POOL_FUND_WEI: REWARD_POOL_FUND.toString(),
    });
    expect(await read<boolean>('rewardCustodyActivated')).toBe(true);
    const launch = Number(await read<bigint>('getInteractionLaunchTimestamp'));
    expect(launch).toBeGreaterThan(0);

    // ---- 2. A real loan accrues reward days, closes, and its days finalize ----
    for (const role of [LENDER, BORROWER]) {
      const account = accountFor(role);
      await confirm(
        await walletFor(account).writeContract({
          address: WETH,
          abi: ERC20_MIN_ABI,
          functionName: 'deposit',
          value: parseEther('1'),
          account,
          chain: forkChain,
        }),
        `deposit (${role} WETH)`,
      );
    }
    const offerId = await seedDeskOffer({
      role: LENDER,
      side: 'lend',
      rateBps: 1000,
      amountWeth: '1',
      minAmountWeth: '1',
      collateralTliq: '5',
      days: 30,
    });
    const loanId = await acceptOfferDirect(BORROWER, offerId);
    await increaseTime(3 * DAY);
    await repayLoanInFull(BORROWER, loanId);
    await increaseTime(DAY + 60);
    await finalizeThrough(keeper, launch, Math.floor(((await chainNow()) - launch) / DAY) - 1);

    const lenderIds = await read<readonly bigint[]>('getUserRewardEntryIds', [lender]);
    const borrowerIds = await read<readonly bigint[]>('getUserRewardEntryIds', [borrower]);
    expect(lenderIds, 'one entry per side').toHaveLength(1);
    expect(borrowerIds, 'one entry per side').toHaveLength(1);
    const entryId = lenderIds[0];
    const entries = [entryId, borrowerIds[0]];

    // Dark: a touch starts no clock while the horizon is zero.
    expect(await read<number>('getRewardClaimHorizonDays')).toBe(0);
    const dark = await diamondWrite(keeper, 'sweepExpiredInteractionRewards', [entries], 'sweep (dark)');
    expect(horizonLogs(dark.logs), 'no clock while dark').toEqual([]);
    expect((await read<readonly [bigint, bigint]>('getRewardEntryExpiry', [entryId]))[1]).toBe(0n);

    // ---- 3. Arm the horizon; the first touch starts each clock ----
    await sendAsAdmin('setRewardClaimHorizonDays', [HORIZON_DAYS]);
    expect(await read<number>('getRewardClaimHorizonDays')).toBe(HORIZON_DAYS);
    await increaseTime(12 * 3600);
    const first = await diamondWrite(keeper, 'sweepExpiredInteractionRewards', [entries], 'sweep (stamp)');
    const stamped = horizonLogs(first.logs).filter((l) => l.eventName === 'RewardEntryHorizonStamped');
    expect(stamped.map((l) => l.args.entryId as bigint).sort()).toEqual([...entries].sort());
    const stampAt = Number((await pub.getBlock({ blockNumber: first.blockNumber })).timestamp);

    const [firstClaimableAt, estimate] = await read<readonly [bigint, bigint]>('getRewardEntryExpiry', [entryId]);
    expect(firstClaimableAt).toBeGreaterThan(0n);
    // Nothing accrued yet, so the earliest removal is a full horizon plus the
    // notice from now (the view's block, which is the stamping one or later).
    const lead = Number(estimate) - stampAt;
    expect(lead).toBeGreaterThanOrEqual((HORIZON_DAYS + NOTICE_DAYS) * DAY);
    expect(lead).toBeLessThan((HORIZON_DAYS + NOTICE_DAYS) * DAY + DAY);
    // The Claim Center reads the wallet-wide soonest estimate; with one entry
    // it is that entry's estimate.
    const soon = await soonestExpiry(lender);
    expect(soon.entryId).toBe(entryId);
    expect(soon.expiresAt).toBe(Number(estimate));

    {
      const { page } = await launchWallet(LENDER);
      // The visitor's clock agrees with the chain's, as on a live chain (the
      // final-notice wording compares the estimate with the browser's clock).
      await page.clock.setFixedTime(new Date((await chainNow()) * 1000));
      await page.goto('/claims', { waitUntil: 'domcontentloaded' });
      await connectWallet(page);
      const countdown = page.getByTestId('reward-expiry-countdown');
      await expect(countdown).toBeVisible({ timeout: 30_000 });
      await expect(countdown).toHaveText(copy.rewards.expiryCountdown(appDate(soon.expiresAt)));
      await page.context().close();
    }

    // ---- 4. Touches across the horizon arm the final notice ----
    let armed: HorizonLog | undefined;
    const armedAll: HorizonLog[] = [];
    for (let step = 0; !armed && step < Math.ceil((HORIZON_DAYS * DAY) / STEP_SEC) + 5; step++) {
      await increaseTime(STEP_SEC);
      const r = await diamondWrite(keeper, 'sweepExpiredInteractionRewards', [entries], `sweep (horizon step ${step})`);
      const logs = horizonLogs(r.logs);
      expect(logs.filter((l) => l.eventName === 'RewardEntryExpiryBegun'), 'no removal before the notice').toEqual([]);
      armedAll.push(...logs.filter((l) => l.eventName === 'RewardEntryExpiryArmed'));
      armed = armedAll.find((l) => (l.args.entryId as bigint) === entryId);
    }
    expect(armed, 'the final notice armed within the horizon').toBeDefined();
    const armedLog = armed!;
    expect((armedLog.args.user as string).toLowerCase()).toBe(lender.toLowerCase());
    // Every interval was observed inside the gap, so the notice starts a full
    // horizon of executable time after the clock started.
    expect(Number(armedLog.args.finalNoticeFrom) - stampAt).toBe(HORIZON_DAYS * DAY);
    const armedAt = Number((await pub.getBlock({ blockNumber: armedLog.blockNumber })).timestamp);

    // The feed the bell reads is the indexer's planning of that log, and
    // nothing else for this wallet.
    const afterArm = await stubFeed(lender);
    expect(afterArm).toHaveLength(1);
    expect(afterArm[0]).toMatchObject({ kind: 'reward_final_notice', ...expectedFeedFields(armedLog, armedAt) });
    const [planned] = planOwnerNotifications(CHAIN_ID, [armedLog], new Map([[armedLog.blockNumber, armedAt]]), 0);
    expect(planned.kind).toBe(afterArm[0].kind);
    expect(JSON.parse(planned.dataJson)).toEqual(afterArm[0].data);

    {
      const { page } = await launchWallet(LENDER);
      await page.clock.setFixedTime(new Date((await chainNow()) * 1000));
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await connectWallet(page);
      const bell = page.getByTestId('notif-bell');
      await expect(bell).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('notif-badge')).toHaveText('1');
      await bell.click();
      const rows = page.getByTestId('notif-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(copy.notifications.line.reward_final_notice);
      await expect(rows.first()).toContainText(copy.notifications.rewardRef(String(entryId)));
      await expect(rows.first()).not.toContainText('Loan #');
      // The row opens the Claim Center, whose countdown is now the final notice.
      await rows.first().click();
      await expect(page).toHaveURL(/\/claims$/);
      const finalSoon = await soonestExpiry(lender);
      expect(finalSoon.expiresAt - (await chainNow())).toBeLessThanOrEqual(NOTICE_DAYS * DAY);
      await expect(page.getByTestId('reward-expiry-countdown')).toHaveText(
        copy.rewards.expiryFinalNotice(appDate(finalSoon.expiresAt)),
        { timeout: 30_000 },
      );
      await page.context().close();
    }

    // ---- 5. Touches across the notice reach the removal point ----
    let begun: HorizonLog | undefined;
    for (let step = 0; !begun && step < Math.ceil((NOTICE_DAYS * DAY) / STEP_SEC) + 5; step++) {
      await increaseTime(STEP_SEC);
      const r = await diamondWrite(keeper, 'sweepExpiredInteractionRewards', [entries], `sweep (notice step ${step})`);
      begun = horizonLogs(r.logs).find(
        (l) => l.eventName === 'RewardEntryExpiryBegun' && (l.args.entryId as bigint) === entryId,
      );
    }
    expect(begun, 'removal began after the notice').toBeDefined();
    const begunLog = begun!;
    const begunAt = Number((await pub.getBlock({ blockNumber: begunLog.blockNumber })).timestamp);
    expect(begunAt - Number(armedLog.args.finalNoticeFrom)).toBeGreaterThanOrEqual(NOTICE_DAYS * DAY);

    const afterRemoval = await stubFeed(lender);
    expect(afterRemoval).toHaveLength(2);
    expect(afterRemoval[0]).toMatchObject({ kind: 'reward_expired', ...expectedFeedFields(begunLog, begunAt) });
    expect(afterRemoval[1]).toMatchObject({ kind: 'reward_final_notice', ...expectedFeedFields(armedLog, armedAt) });

    {
      const { page } = await launchWallet(LENDER);
      await page.clock.setFixedTime(new Date((await chainNow()) * 1000));
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await connectWallet(page);
      const bell = page.getByTestId('notif-bell');
      await expect(bell).toBeVisible({ timeout: 15_000 });
      await bell.click();
      const rows = page.getByTestId('notif-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toContainText(copy.notifications.line.reward_expired);
      await expect(rows.first()).toContainText(copy.notifications.rewardRef(String(entryId)));
      await expect(rows.nth(1)).toContainText(copy.notifications.line.reward_final_notice);
      await page.context().close();
    }
  } finally {
    // Back to the chain (and clock) the spec found — see ISOLATION above.
    const reverted = await anvilRpc<boolean>('evm_revert', [snapshot]);
    if (!reverted) throw new Error(`evm_revert(${snapshot}) refused: later specs would inherit this drive's chain`);
  }
});
