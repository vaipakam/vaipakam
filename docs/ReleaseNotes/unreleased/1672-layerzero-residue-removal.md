## The last of the LayerZero residue, and the CCIP variables that were never written down

The cross-chain layer has been Chainlink CCIP only since T-068, and the
contracts themselves are clean — what remains of LayerZero in
`contracts/src` is commentary explaining why a thing is shaped the way it
is, and there is no LayerZero dependency left for anything to import.
The residue was all in the layer around the contracts: the deploy
scripts, the artifacts they stamp, and the file an operator copies before
a deploy.

**The operator config was the serious one.** `.env.example` still shipped
a LayerZero endpoint for six chains, a peer-setter block, and the entire
fixed-rate VPFI buy stack — receiver, adapter, executor options, refund
timeout, and per-chain payment tokens — for scripts that have all been
deleted. Nothing read any of it. Meanwhile it documented **none** of the
CCIP variables the current deploy actually needs, four of which have no
default and abort the run when unset. An operator following the template
would have carefully filled in variables that do nothing and then had
their deploy fail on ones nobody told them about. Both halves are fixed:
the dead blocks are gone, replaced by short notes naming what was removed
so a stale `.env` gets deleted rather than translated, and the CCIP
router, RMN proxy, token-admin registry, registry module owner, lane
chain ids, guardian and rate-limit knobs are now written down with their
defaults.

Two smaller traps came out of the same file. It set `REWARD_VERSION`
twice, and the second one won — since the reward-messenger proxy is
CREATE2-addressed off that value, an operator following the template
would have landed the proxy at a different address than intended. And it
named `BASE_EID` and `REWARD_EXPECTED_SOURCE_EIDS`, which nothing reads,
while omitting `BASE_CHAIN_ID` and `REWARD_EXPECTED_SOURCE_CHAIN_IDS`,
which the reward wiring genuinely requires. Chains are keyed by EVM chain
id now; an endpoint id is not a thing that can be translated.

**A LayerZero endpoint id was still being stamped into every new
deployment.** The artifact writer had an endpoint-id lookup table and
wrote the result to `addresses.json` on each deploy. It was kept as
"inert chain metadata", but nothing read it, and the typed deployment
loader that consumers import already documented the field as removed —
so the code, the data and the documentation disagreed three ways. The
resolver and the stamp are gone, the field is out of the six per-chain
artifacts and the consolidated bundle, and the loader's description now
matches. The genuinely-still-needed LayerZero-era keys are untouched and
explained: the deploy scripts still read `rewardOApp` as a fallback,
because two testnet chains were deployed under that key and their
artifacts are the record of it.

**The environment variable naming the old transport is now the old
name.** `REWARD_MESSENGER_PROXY` is what the reward wiring reads;
`REWARD_OAPP_PROXY` still works as a deprecated fallback, so nobody's
existing `.env` breaks.

Also removed: the event-category linter's allowlist for LayerZero
inherited events, which listed five contracts that no longer exist and
could never have matched anything.

**The guard that was supposed to prevent this has been widened.** A
pre-deploy check already scanned the deploy scripts for LayerZero
residue, and it worked — nothing it looked for got through. It simply
did not look at `.env.example`, which is not a deploy script but is what
an operator copies, and it deliberately tolerated the endpoint id. It now
covers both, plus the endpoint variables, the peer-setter variables and
the buy-receiver id, while still allowing a comment to *name* a retired
variable — a note that says "this is gone, do not carry it forward" has
to be able to say what it is. The widened guard was tested against a
deliberately reintroduced variable before being trusted.

The deploy runbooks were reconciled rather than rewritten. The Base
Sepolia cookbook had no status banner at all and opened by quoting an
endpoint id; it now says plainly that it is a pre-migration document and
points at the two scripts that replace it. The BNB banner already
existed but claimed the current deploy still produces a buy adapter,
which it has not since that surface was removed. The main deployment
runbook's dead reward-proxy section is now marked dead in place, so
someone arriving from the table of contents sees it without having to
scroll back to the banner at the top.

**Not addressed here, and worth stating:** the handover script still does
not rotate the CCIP stack — the messenger, the token pools and the rate
governor — to the governance timelock. That is recorded as a known
follow-up in the cutover runbook, where it remains a manual multisig
step, and it is real work rather than cleanup. It has not been made worse
by anything above, but it is the one genuine gap the sweep did not close.

**Three defects in the first cut of this change, caught in review.** All
three were in the new material rather than the removals, and two of them
would have broken a deploy:

- The CCIP variables were documented under the names the Forge scripts
  read, not the names an operator sets. `deploy-chain.sh` resolves a
  per-slug `CCIP_ROUTER_<SLUG>` and exports the bare name itself — and
  treats a hand-set bare `CCIP_ROUTER` as a hard error precisely because
  that is how one chain's router gets wired into another chain's deploy.
  The template now shows the per-slug form.
- The template pre-filled the canonical Base chain id with the testnet
  value. Mainnet only forces the real value inside its configure phase,
  so the earlier contract-deploy and lane-wiring phases would have used
  whatever was in the environment — and the mirror-chain preflight checks
  only that the value is *set*, not that it is right. A copied template
  would therefore have wired a mainnet mirror to the testnet reward hub.
  It now ships unset so the preflight stops and the operator chooses.
- The environment rename introduced a regression of its own: the deploy
  wrappers clear the old variable name before injecting the address they
  resolved from the artifact, and the new name — which takes priority —
  was not being cleared. A value left in an operator's `.env` would have
  outranked the wrapper and tripped the mismatch check on multi-chain
  runs. Both wrappers now clear and populate the current name.

A second review round found four more, again all in the new material:

- Only the router and RMN entries had been converted to per-slug names;
  the two CCT registry addresses were still documented bare, and the
  wrappers resolve all four the same way. Fixed.
- The template's advice for the reward-messenger override — "populate
  once, reuse everywhere", inherited from the CREATE2 bootstrap — is
  false today. That deploy path is gone: the messenger is created with an
  ordinary deploy, no script reads the version variable that used to salt
  it, and the committed artifacts hold a different address per chain. So
  a single reused value makes the agreement check abort. The variable is
  removed, the override is documented as best left unset, and the two
  deploy wrappers stop telling operators to bump a version that no longer
  does anything.
- The widened guard did not scan the files that can actually recreate the
  endpoint-id stamp — the artifact writer, the deploy script that calls
  it, the committed artifacts, the consumed bundle. Those two patterns
  were therefore decorative: they could never have matched, and the guard
  would have reported success for residue it structurally could not see.
  The scan set now covers them, and that was verified by putting the
  field back into an artifact and watching the gate fail.
- The runbook's "adding a new chain" checklist still told operators to
  edit the deleted endpoint-id resolver — a procedure that cannot be
  completed. It now names the CCIP selector resolver and the per-slug
  infrastructure variables that go with it.

The pattern across both rounds is worth recording: every defect was in
something newly written, not in anything removed. Deleting dead code is
low-risk; describing what replaced it is where the mistakes were.
