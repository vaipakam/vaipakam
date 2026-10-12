## Thread — the never-wired ETH·day tariff knob is removed (#1956)

The ETH·day tariff knob was an administrator setting that charged a quantity of VPFI per unit of ETH loan volume per day. It was never wired into absorption. The absorption formula uses the LIF·year coefficient instead, and the formula revision forbade wiring the ETH·day knob. The programme plan said to delete it once nothing called it, and nothing does.

What changed:
- Its setter, its event and its error are removed.
- The recycling configuration read now returns only the platform margin.
- Its storage slot stays, marked retired, so the layout is unchanged.
- The deploy check that used to alarm if the dead knob moved now confirms it is not routed at all.
- An in-place refresh removes the retired route automatically.
- The administrator knob reference no longer lists it.

Refs #1956, #1347, #1349.
