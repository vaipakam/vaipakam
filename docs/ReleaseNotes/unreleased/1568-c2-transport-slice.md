# Planned-surplus repatriation — the transport goes live end-to-end (#1568, part 2)

Part 1 shipped the books; this change ships the movement. The recycling
programme's "Mode A" repatriation can now actually carry a mirror chain's
surplus recycled value back to the canonical chain, under the
authorization lifecycle the accounting core pinned.

What shipped, in behaviour terms:

- The canonical chain can now **dispatch** an issued authorization to its
  target mirror as a cross-chain instruction. Dispatching is open to
  anyone and repeatable — the content comes entirely from the stored
  authorization, and the mirror records an instruction at most once — so
  a lost message never needs an operator to recover.
- On the mirror, a recorded instruction is **executed** by anyone willing
  to pay the message fee: the surplus leaves the mirror's recycle bucket
  (bounded so claim backing and the keeper reserve can never be taken),
  and the value travels home with a payload that names the exact
  authorization it answers. Execution happens at most once, permanently.
- Cancellation now works end-to-end: the canonical chain requests it, the
  mirror marks the instruction dead — even one that never arrived, so a
  late instruction lands on a closed record — and sends back a signed-off
  confirmation. Only that confirmation releases the authorized amount for
  re-offering, exactly as part 1 promised. A cancellation can never race
  an execution into doing both: the two outcomes share one record.
- The value returns over a **new, shared return channel** with its own
  send and receive endpoints on each side. Each kind of return traffic is
  its own wire protocol on that channel; a delivery of a kind a receiver
  does not yet understand fails cleanly and can be re-delivered after the
  upgrade — a partial rollout can never mis-book a return silently. The
  planned stranded-value recovery path ("Mode B") will join the same
  channel later with its own protocol.
- Deployment tooling deploys and wires the two channel endpoints per
  chain role, arms the Diamond's endpoints, and puts both under the same
  incident-pause guardian as every other cross-chain surface. Both
  endpoints also join the governance ownership handover ceremony, so
  after handover no single operator key retains upgrade or re-pointing
  authority over the channel.
- Authorizations gained a **per-destination ceiling sized to each lane's
  transfer capacity**: a single transfer above either side's capacity
  would be rejected permanently by the transport, so an over-capacity
  authorization — which could only ever strand its reserved amount until
  cancellation — is now refused at issuance instead. The deploy tooling
  arms each destination with the minimum of the two capacities its
  return would consume (each chain records its configured capacity for
  the canonical chain to read), falling back to the local capacity —
  never wider — until the other side's figure is recorded.
- The mesh watcher now understands repatriation: the availability figure
  it re-derives nets out live draws, a new check pages if authorized
  draws ever exceed what a chain reported holding, and the bucket
  composition picture counts repatriated value as a destination — while a
  deployment that predates this feature is reported as a visible coverage
  gap rather than a false alarm.

Operationally the surface stays **dark by default** on every existing
deployment: nothing moves until the channel endpoints are deployed and
explicitly configured on both sides.
