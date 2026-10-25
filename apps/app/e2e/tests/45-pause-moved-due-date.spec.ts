/** A pause moves an open loan's due date, and the app says so (#2808).
 *
 *  Under owner decision D2 (#668 / #935) the paused time is added to every
 *  open loan's due date and grace end. The contracts enforce the moved
 *  dates; this guards the app against stating the original ones. A
 *  borrower who reads the original date after a pause sees a deadline
 *  earlier than the one the chain holds them to, which is the failure
 *  #2808 exists to prevent.
 *
 *  The spec opens a loan, pauses the protocol for two days and lifts the
 *  pause, then checks three things against the chain's own
 *  `getLoanDeadlines`:
 *
 *  - the loan page states the moved date, the original one, and how far
 *    and why it moved;
 *  - the positions row dates the loan rather than calling its due date
 *    unknown (the list reads its rows from the chain, which carry no
 *    dates of their own, so this covers the chain-read dating path);
 *  - while a pause is in force, both say the date is still moving instead
 *    of naming one.
 *
 *  The pause is chain-global. Every write that pauses is followed, in a
 *  `finally`, by an unpause if the chain is still paused, so a failure here
 *  cannot leave later specs running against a paused protocol. */
import { test, expect } from "../lib/wallet-fixture";
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
} from "../lib/flows";
import { increaseTime, mine } from "../lib/anvil";
import { sendAsAdmin } from "../lib/admin";
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from "../lib/chain";

const DAY = 86_400;
const PAUSE_SECONDS = 2 * DAY;

const isPaused = () =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: "paused",
  }) as Promise<boolean>;

async function unpauseIfPaused() {
  if (await isPaused()) await sendAsAdmin("unpause");
}

test("a pause moves the due date, and the loan page and list say so", async ({
  launchWallet,
}) => {
  const lender = await launchWallet("lender");
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrower = await launchWallet("borrower");
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, "borrower");
  await borrower.ctx.close();

  // The chain must start from a live protocol and an unmoved loan, or the
  // assertions below would measure some earlier spec's pause.
  expect(await isPaused()).toBe(false);
  const readDeadlines = async () => {
    const [originalMaturity, pauseCredit, maturity] = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: "getLoanDeadlines",
      args: [loanId],
    })) as readonly [bigint, bigint, bigint, bigint];
    return { originalMaturity, pauseCredit, maturity };
  };
  expect((await readDeadlines()).pauseCredit).toBe(0n);

  try {
    // ---- A pause in force: the date is still moving ----
    await sendAsAdmin("pause");
    await increaseTime(PAUSE_SECONDS);
    await mine();

    const during = await launchWallet("borrower");
    await during.page.goto("/positions", { waitUntil: "domcontentloaded" });
    await expect(
      during.page
        .locator(`a[href="/positions/${loanId}"]`)
        .getByTestId("loan-row-state"),
    ).toHaveAttribute("data-state-key", "duePaused", { timeout: 30_000 });
    await during.page.goto(`/positions/${loanId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(during.page.getByTestId("position-terms")).toContainText(
      /the protocol is paused, so the date is still moving/i,
      { timeout: 30_000 },
    );
    await during.ctx.close();

    // ---- The pause lifted: the moved date is fixed and stated ----
    await sendAsAdmin("unpause");
  } finally {
    await unpauseIfPaused();
  }

  const d = await readDeadlines();
  // The credit is the paused time, which the warp makes at least two days
  // and the few seconds of block time around it keep under a minute more.
  expect(d.pauseCredit).toBeGreaterThanOrEqual(BigInt(PAUSE_SECONDS));
  expect(d.pauseCredit).toBeLessThan(BigInt(PAUSE_SECONDS + 60));
  expect(d.maturity).toBe(d.originalMaturity + d.pauseCredit);

  const after = await launchWallet("borrower");
  await after.page.goto("/positions", { waitUntil: "domcontentloaded" });
  const rowState = after.page
    .locator(`a[href="/positions/${loanId}"]`)
    .getByTestId("loan-row-state");
  // Dated on the loan clock: neither "unknown" nor still "paused".
  await expect(rowState).toHaveAttribute(
    "data-state-key",
    /^(dueInDays|dueToday)$/,
    {
      timeout: 30_000,
    },
  );

  await after.page.goto(`/positions/${loanId}`, {
    waitUntil: "domcontentloaded",
  });
  const moved = after.page.getByTestId("position-due-moved");
  await expect(moved).toBeVisible({ timeout: 30_000 });
  await expect(moved).toContainText(/Originally due/);
  await expect(moved).toContainText(
    /Moved 2 days later because the protocol was paused/,
  );
  await expect(after.page.getByTestId("position-terms")).not.toContainText(
    /paused/i,
  );
  await after.ctx.close();
});
