## Apps and Workers follow the 2026-11-16 fresh testnet deploy

Base Sepolia, Arbitrum Sepolia and BNB Testnet were fresh-deployed on 2026-11-16 from `main`. The new Diamonds are Base Sepolia `0x2c300b26bc15359E7948dA61a1960303772b0335`, Arbitrum Sepolia `0x0EBd0536a698707958e1c327Ba1EB2b4f329A119` and BNB Testnet `0xBc839c06Ee431d50EA6B087E0f26e80fb022564E`. This change commits their deployment records and the consolidated address bundle every app and Worker reads, so the connected app, alpha05, the indexer, the keeper and the agent all point at the new Diamonds once they redeploy.

The 2026-11-03 Diamonds are retired. They are listed in the archive manifest, so the indexer starts a new epoch for each chain from the new deploy block. Open offers and loans on the old Diamonds are abandoned, as decided for this deploy.

The new Diamonds are still paused when this lands. Nothing can be opened on them until the owner runs the first unpause (the launch step). Reward accrual starts later, once the Base reward pool is funded and rewards are launched.
