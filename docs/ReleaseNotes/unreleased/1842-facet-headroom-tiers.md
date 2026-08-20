## The facet-size report now ranks, not just lists

An internal check that watches how close each part of the contract is to
Ethereum's hard size limit already warned when one got tight. It listed every
tight component in one flat group, which was fine when that meant one or two —
and stopped being useful once it meant seven, because the one with 32 bytes of
room left read exactly like the one with a thousand.

The report now separates the genuinely-out-of-room from the merely-close, and
puts the former first. Nothing about the pass/fail rule changed: a component
over the limit still fails the check outright, and one that is simply close
still only reports. The difference is that someone glancing at the output can
now tell, without doing arithmetic, which components are one ordinary change
away from blocking work — a situation that has already forced one component to
be split, and is currently holding up a fix on another.
