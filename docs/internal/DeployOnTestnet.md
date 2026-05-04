# Autonomus deploy script end to end for Testnet

`deploy-chain.sh base-sepolia --skip-cf`

items NOT in this run (intentionally skipped per --skip-cf):

Frontend Cloudflare deploy
hf-watcher Cloudflare deploy
Follow-up steps that need separate operator action (per deploy-chain.sh banner):

ConfigureLZConfig.s.sol — set DVN policy for the new RewardOApp
WireVPFIPeers.s.sol — once mirror-chain legs are deployed
Role rotation per DeploymentRunbook §6 (testnet can defer)

---

Set up testnet DVN env vars and run ConfigureLZConfig on Base Sepolia first, then deploy Sepolia, then wire peers + DVN config on Sepolia? (full mainnet rehearsal)

---

Plan: ConfigureLZConfig must be invoked 3× per chain (one per OApp). For Base Sepolia testnet rehearsal:

OApp Address Remote EID
vpfiOftAdapter 0x7572d0bc7626D1857e81FF2C05a445b15E56AF2D 40161 (Sepolia)
vpfiBuyReceiver 0x7Cf469E36Da9fc460e6593F4E48a2656b193a46B 40161
rewardOApp 0x272459691D38dA8518BEbd1dc07F6Cd582DCc1C5 40161
DVN set for Base Sepolia (sorted ascending):

Required: Nethermind / BitGo / LayerZero Labs
Optional: P2P / Horizen
SEND_LIB / RECV_LIB derived from on-chain LZ endpoint defaults
Confirmations: 10 (per CLAUDE.md Base policy)
Broadcaster: ADMIN_PRIVATE_KEY (all 3 OApps owned by admin)

---
