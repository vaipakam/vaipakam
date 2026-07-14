# RPC read-diet PR A — signal-gated freshness (phase 1)

The main slice of the Alpha02 RPC read-diet design
(docs/DesignsAndPlans/Alpha02RpcReadDietDesign.md §4 phase 1): the app
stops paying a recurring per-block and per-30-seconds RPC cost for data
the indexer push rail already announces, without giving up update speed
anywhere speed gates a money decision.

- **Rail health decides the polling posture.** The app now judges the
  push rail by the freshness metadata PR 0 added: the socket must be
  open, the server must report its expected scan cadence, and the
  ingest cursor must keep advancing within a cadence-derived window.
  While that holds, the indexer-covered data hooks (lists, activity,
  vault, rewards, approvals, desk views) relax from 30-second polling
  to a 180-second safety net — push frames carry the actual freshness.
  The moment the rail degrades (socket drop, stalled ingest, an older
  worker without the metadata), every interval returns to today's
  cadence. A returning tab re-reads the relaxed set immediately.
- **The per-block refresh narrows to action-gating reads.** On
  WebSocket deploys the block watcher now refreshes only the roots
  where staleness could mislead an imminent decision: the position
  detail page's owner/status/risk gates, pending-offer accept gates,
  the desk's crossable band, and the shared book's ghost-strip. The
  ghost-strip itself moved into its own block-driven query (scanning
  from the same pre-walk cursor snapshot as before) so the book's
  honesty check keeps tip cadence while the book's data rides push.
- **Own actions stay instant, now across tabs.** Every confirmed write
  (Diamond calls and token approvals alike) triggers a centralized
  refresh of the standard own-state set, repeats it once ~two block
  times later for lagging public RPCs, and broadcasts it to every open
  tab of the app — a submit in one tab reflects in the others within a
  block, with no extra chain reads.
- **List rows guard themselves at click time.** Cancel and amend fired
  straight from a list row now simulate the exact call before the
  wallet prompt, so an offer a counterparty consumed moments ago
  surfaces as an inline explanation instead of a doomed signature.
- **The desk cooldown countdown stopped polling.** The cancel-cooldown
  clock reads chain time once, counts down on the offset-corrected
  local clock, and spends a single confirming read at the boundary —
  the button still only unlocks on a real chain timestamp, so a fast
  device clock can never arm a doomed cancel. Partial-filled and
  expired offers keep their immediate-cancel bypasses.
- **Claims verification runs only when candidates change.** The Claim
  Center re-verifies when the candidate set's content (loan, side,
  status, position tokens, amounts) actually changes, instead of on
  every background refresh of the loan list. Actionability stays
  chain-decided at claim time, with the full probe set intact.

Escape hatch: setting `VITE_FRESHNESS_TIMERS=legacy` at build time pins
the rail-health verdict to "down", restoring the previous timer
behaviour byte-for-byte. Ships one release behind that flag per the
design's rollout plan; the live review (design §7) gates its removal.
