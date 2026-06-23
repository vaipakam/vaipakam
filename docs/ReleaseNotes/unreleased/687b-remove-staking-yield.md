## Thread — Remove the VPFI 5% staking yield (legal-surface reduction) (PR #<n>)

The protocol no longer pays a 5% APR "staking yield" on vaulted VPFI. An
issuer that pays an ongoing yield on a held token is a textbook
securities-law surface, so this is the second step of the VPFI
legal-program excision (#687, after the fixed-rate sale in #711).

What was removed: the `StakingRewardsFacet` and its `LibStakingRewards`
accrual library in full (claim, preview, reward-per-token accrual, the
staked-balance bookkeeping), the admin staking-APR knob
(`setStakingApr` / `getStakingAprBps` + the `vpfiStakingAprBps` config
field), the staking reward-per-token / paid-out / per-user accrual storage,
the `vpfiStakingPoolCap` constant, the dashboard's staking-pending read,
the two staking-only custom errors, and the connected-app staking UI
(the staking-rewards claim card, the staking-APR hooks, and the staking
rows on the rewards summary).

What was kept — unchanged: the **balance-based** VPFI fee-discount tiers
(they read the vaulted VPFI balance, never the staking accrual), the vault
deposit / withdraw mechanics that back those tiers, and the interaction
rewards. The scout confirmed zero entanglement: every vault-mutation site
already re-stamped the discount accumulator independently of the staking
checkpoint, so removing the staking call left discounts intact.

Because the platform is pre-live, the removed storage fields are dropped
outright (fresh `DeployDiamond`). The freed 24% supply allocation that
backed the staking pool is a separate owner tokenomics decision tracked
under #687 / #694, not changed here.

Part of #687. Follow-ups: #687-C confirms the treasury buyback stays
dormant (and folds in the now-orphaned `stakingPoolBuybackBudget`); the
www marketing / user-guide / whitepaper staking-yield copy + the i18n
locale-key cleanup ride the #712 copy sweep.
