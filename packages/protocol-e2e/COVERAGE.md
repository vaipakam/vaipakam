# packages/protocol-e2e coverage

The protocol's own two-chain scenarios (#848). Each drives positive flows that
`contracts/script/PositiveFlows.s.sol` cannot: they need two chains, a message
lane between them and moving time. Every call is one a user or an operator
makes on a live Base/mirror pair. No keeper code runs here: the keeper is one
caller of these entry points, and its own scenarios live in `apps/keeper/e2e`.

The catalog rows are those of
[`docs/TestScopes/PositiveFlowCoverage.md`](../../docs/TestScopes/PositiveFlowCoverage.md).

## How to run

```bash
export PATH=/opt/node22/bin:$PATH        # Node 22 + pnpm
# forge and anvil on PATH (Foundry)
pnpm --filter @vaipakam/protocol-e2e run e2e:anvil
```

- **The global setup builds a fixture once** with the shared two-chain build
  in `packages/anvil-harness/src/mesh.ts`. It deploys the repository's current
  contracts from source onto two nodes: one presenting Base Sepolia (84532)
  and one presenting Sepolia (11155111). It wires them with the operator
  scripts, joins them with a local CCIP lane of real CCIP contracts, and dumps
  both states under `.state/mesh/` (gitignored). `src/fixture.ts` adds one
  setting: the address Base authorizes to remit is a development key, so a
  scenario can remit as that party.
- **Each scenario file starts both nodes from the dumps**, so no file sees
  another's transactions or clock.
- `PROTOCOL_E2E_REUSE_FIXTURE=1` keeps an existing fixture instead of
  rebuilding it. That is only safe when the contracts have not changed since
  it was built.
- CI runs the suite in `.github/workflows/protocol-e2e.yml`. It is not a
  required check yet.

Every key is an Anvil well-known development key or one the fixture mints for
the run. Nothing reads a secret or a live RPC.

## Matrix

| Rows | Scenario | What is checked |
| --- | --- | --- |
| PF-260 | `interactionRewards`: finalizes each day from both reports | Each day closes on both chains, and the mirror's report crosses the lane. Base finalizes the global pair as the sum of the two chains' own reported figures. After the broadcast the mirror knows exactly the pair Base finalized. |
| PF-120, PF-259 (Base) | `interactionRewards`: pays lender and borrower on Base | Each claim pays the wallet exactly what `simulateClaimInteractionRewards` reported, and nothing goes to the vault. The static preview never quotes more. Nothing is left to claim afterwards. |
| PF-259 (mirror), PF-260 (funding) | `interactionRewards`: remits the mirror's budget and pays its claims | Base remits one day per remittance. For each, the Base pool locks exactly the quoted budget, the mirror mints exactly that, and the mirror's supply equals what Base holds locked. The delivery funds no claim until its day is indexed. Indexing rebuilds the day list from Base's reservation with the shared wire rules, and both roots must match. Each party's first mirror claim defers and opens a staging slice. The slice is stepped home permissionlessly, then the claim pays as simulated, within what was remitted. |
| PF-261 | `crossChain`: VPFI out and back | A user sends VPFI over the real Router to the mirror and back. Balances, the Base pool, the mirror supply and the backing invariant hold at each step, and Base's supply never changes. |
| PF-257 | `crossChain`: tier push | A deposit ages past the minimum staked days, then `pokeMyTier` pushes the tier. The mirror's cache holds Base's tier and discount. The mirror's discount stays zero until the user consents on the mirror, then equals Base's. |
| PF-333 (pause) | `crossChain`: guardian pause | The owner names a guardian, who pauses the mirror's reward receiver. A remittance then stays undelivered and mints nothing. The guardian cannot unpause; the owner can. The message then lands with the quoted VPFI. |

## Not covered here

- **A remittance listing several days.** It lands as one shared batch that the
  mirror withholds while more than one of its days is open. An entry covering
  those days keeps them open until its own claim pays, so the claim is refused
  for good. The suite remits one day at a time and the defect is recorded as
  #2821.
- **PF-258**: a fee discount applied at settlement on the mirror from the
  cached tier. The suite proves the cache and the discount read, not a
  settlement priced by it.
- **PF-333**: the "approved peers only" half (a message from an unregistered
  sender is refused). The fixture's lane wires only approved peers, and a
  scenario would need a second sender to forge one.
- **PF-262**: broadcast budget accounting beyond the top-up the tier push needs.
