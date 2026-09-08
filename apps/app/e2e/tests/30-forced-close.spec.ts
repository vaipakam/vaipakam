/** Lender forced close-out of an overdue loan (`triggerDefault`).
 *
 *  The capability was on-chain from the start and had no surface, so
 *  the regression this guards is INVISIBILITY: a lender whose borrower
 *  stopped paying seeing nothing to press. A spec that only checked the
 *  card exists once, on a loan already past grace, would not catch the
 *  card silently freezing in one state — so this drives the SAME loan
 *  across the grace boundary and asserts it changes.
 *
 *  Two preconditions are asserted from the chain rather than assumed,
 *  and both fail the test loudly if the harness moves:
 *
 *  - the collateral really is LIQUID (`checkLiquidity`), which is what
 *    makes `ready-needs-route` the correct expectation here. `flows.ts`
 *    posts against `MOCKS.liquidToken`; if that ever changes to an
 *    illiquid asset the expected UI flips to the one WITH a button, and
 *    this test must fail rather than quietly assert the wrong arm.
 *  - the loan really is defaultable after the warp
 *    (`isLoanDefaultable`), so a grace bucket longer than the warp
 *    fails here instead of downstream as a confusing UI mismatch.
 *
 *  What this does NOT cover, and the attempt that established why: the
 *  in-kind SUBMIT path, the only case where the app actually sends
 *  `triggerDefault(loanId, [])`. Reaching it needs unpriced collateral,
 *  since liquid collateral is precisely the arm with no button. A test
 *  posting against `MOCKS.illiquidToken` got as far as the LENDER
 *  successfully publishing the offer, then failed on CI at the
 *  BORROWER's accept: "Borrow this now" never enabled inside
 *  `consentAndWaitEnabled`'s 60s, so it is not the late-disclosure
 *  re-consent reset that helper already handles.
 *
 *  `canSign` in `OfferFlow.tsx` is the gate, and `securityGateOk`
 *  (`securityBlocked.length === 0`) is the likeliest of its conjuncts to
 *  reject a bare faucet mock — stated as the leading suspect, NOT as a
 *  diagnosis: the run proves the button stayed disabled, not which
 *  conjunct held it. Whether an illiquid-collateral offer should be
 *  acceptable in-app at all is a product question, not a test bug, and
 *  it is tracked rather than worked around here.
 */
import { test, expect } from '../lib/wallet-fixture';
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
} from '../lib/flows';
import { increaseTime } from '../lib/anvil';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, MOCKS } from '../lib/chain';

/** How far past maturity to step, and how many steps to allow.
 *
 *  The first version of this spec warped a flat 2 days on the reasoning
 *  that a 9-day loan draws the compiled 1-day bucket. `isLoanDefaultable`
 *  was still false, so that reasoning was wrong somewhere — most likely
 *  because the fork carries REAL Base Sepolia state and `s.graceBuckets`
 *  is whatever THAT deployment configured rather than the compiled
 *  ladder. Stated as the likely cause rather than the established one:
 *  the run proves the warp was insufficient, not why.
 *
 *  Which is the point of stepping instead of computing — the loop is
 *  correct under either explanation, and if the loan is somehow not
 *  Active at all it exhausts and fails on the same clear assertion. The
 *  precondition caught this rather than letting the UI assertions run
 *  against a still-in-grace loan, which is what it was put there for.
 *
 *  Reading the buckets and reimplementing `gracePeriod`'s walk here
 *  would put a second copy of that rule in the test — the exact mistake
 *  the production code refuses to make. So the spec steps forward and
 *  asks `isLoanDefaultable` after each step, which is the chain's own
 *  answer. The ceiling covers the longest compiled bucket (30 days) with
 *  room to spare; beyond it the assertion below fails loudly. */
const WARP_STEP_SECONDS = 86_400;
const MAX_WARP_STEPS = 40;

test('the close-out card tracks the grace boundary for the lender', async ({
  launchWallet,
}) => {
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrower = await launchWallet('borrower');
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, 'borrower');
  await borrower.ctx.close();

  // Precondition 1 — the collateral is liquid, so the contract will
  // demand a swap try-list and the app must NOT offer a submit button.
  const liquidity = await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'checkLiquidity',
    args: [MOCKS!.liquidToken as `0x${string}`],
  });
  expect(Number(liquidity)).toBe(0); // 0 = Liquid

  // ---- Before the grace period expires ----
  const beforeWarp = await launchWallet('lender', { advanced: true });
  await beforeWarp.page.goto(`/positions/${loanId}`, {
    waitUntil: 'domcontentloaded',
  });
  const cardBefore = beforeWarp.page.getByTestId('forced-close-card');
  await expect(cardBefore).toBeVisible({ timeout: 30_000 });
  // Visible but explicitly NOT actionable, and not claiming the loan is
  // overdue when it is not.
  await expect(
    cardBefore.getByText(/borrower still has time/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    beforeWarp.page.getByTestId('forced-close-submit'),
  ).toHaveCount(0);
  await beforeWarp.ctx.close();

  // ---- Warp past maturity AND grace ----
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { startTime: bigint; durationDays: bigint };
  const endTime = loan.startTime + loan.durationDays * 86_400n;
  const now = (await pub.getBlock()).timestamp;
  // Step to maturity first, then one day at a time until the CHAIN says
  // the loan is closable. Asking beats recomputing: this cannot drift
  // from `gracePeriod` because it never models it.
  await increaseTime(Number(endTime - now) + 60);

  const readDefaultable = () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isLoanDefaultable',
      args: [loanId],
    }) as Promise<boolean>;

  let defaultable = await readDefaultable();
  for (let i = 0; i < MAX_WARP_STEPS && !defaultable; i++) {
    await increaseTime(WARP_STEP_SECONDS);
    defaultable = await readDefaultable();
  }

  // Precondition 2 — the loan really is closable now. A grace schedule
  // longer than the ceiling above fails HERE, with an obvious cause,
  // rather than downstream as a puzzling UI mismatch.
  expect(defaultable).toBe(true);

  // ---- After grace: the same card, a different answer ----
  const afterWarp = await launchWallet('lender', { advanced: true });
  await afterWarp.page.goto(`/positions/${loanId}`, {
    waitUntil: 'domcontentloaded',
  });
  const cardAfter = afterWarp.page.getByTestId('forced-close-card');
  await expect(cardAfter).toBeVisible({ timeout: 30_000 });

  // The state actually moved — the waiting line is gone.
  await expect(
    cardAfter.getByText(/borrower still has time/i),
  ).toHaveCount(0);
  // Liquid collateral: the card says the position is closable and that
  // the sale needs routing, and offers NO button. A button here would
  // spend the lender's gas reaching `NoEnabledSwapRoute`.
  await expect(
    cardAfter.getByText(/sold on an exchange/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    afterWarp.page.getByTestId('forced-close-submit'),
  ).toHaveCount(0);
  // Never promises exclusivity — a keeper may close it first.
  await expect(
    cardAfter.getByText(/anyone can close out an overdue loan/i),
  ).toBeVisible({ timeout: 30_000 });
  await afterWarp.ctx.close();

  // ---- The borrower is not offered their own default ----
  const borrowerView = await launchWallet('borrower', { advanced: true });
  await borrowerView.page.goto(`/positions/${loanId}`, {
    waitUntil: 'domcontentloaded',
  });
  // Wait for the page to settle on something before asserting absence,
  // so an empty shell cannot pass as "correctly hidden".
  await expect(
    borrowerView.page.locator('section.card').first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    borrowerView.page.getByTestId('forced-close-card'),
  ).toHaveCount(0);
  await borrowerView.ctx.close();
});

