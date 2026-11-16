## Keeper — runs borrowers' standing instructions (#3681)

A borrower can leave three standing instructions on a loan, each paid from their own reserve for that loan: top up the collateral when the health factor falls under their trigger, repay in full from a chosen time before the due date, and pay each interest period when it ends. Anyone may submit them, and the caller chooses and receives nothing. The keeper now has a pass, `standingInstructions`, that submits them, with one arming flag per instruction (`STANDING_TOPUP_ENABLED`, `STANDING_REPAY_ENABLED`, `STANDING_INTEREST_ENABLED`). All three ship unset, so nothing runs until an owner arms them.

The pass runs every minute, because a top-up answers a falling health factor. The indexer's record of instructions being set names the loans. For each one the keeper reads the loan's own reserve view and deadlines and sends a call only when that view shows it would move something. So the keeper pays no gas for a skip the view can already see, such as a moved position, an empty or short reserve, or a missing price. A due repayment takes the loan alone, because it closes the loan. Top-ups go first.

Some skips the view cannot see, such as a live sale or refinance, a locked account or a paused asset. These still land on chain and change nothing. The keeper reads the contract's skip event from the receipt, states the reason, and holds that instruction for 30 minutes before trying again. A paused platform is checked once per run, before any send.

The design says a switch the borrower turns on is not a promise that someone will act. The keeper therefore publishes which of its steps are armed on each chain, every few minutes, armed or not. It writes them to a new shared table (migration 0098), and the indexer serves them on `GET /keeper/steps?chainId=`. A row older than 15 minutes reads as not running. The app's instruction panel can use this to say "No automatic runner is active for this instruction here" where that is so, and the same when the state cannot be read.

The three executors move from a recorded gap to keeper-backed in the permissionless-steps ledger.

> Caveat: the borrower alerts the design asks for (a reserve too low for the next payment, a top-up that ran, an instruction skipped) are not sent yet; they need their own alert kinds in the agent and are a follow-up.
> Caveat: this depends on the #3681 contract work, which lands with the contract batch; until then the pass names no loans.
