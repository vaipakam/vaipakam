## Thread — Tenderly: retire the broken actions, and refuse an alert preset that can never fire (PR #TBD)

The Tenderly actions manifest named three retired Diamonds, and the four Web3 Actions it deployed had never worked: the folder had no package file to build them, the health-factor watcher called a function the Diamond does not have, the large-loan action decoded an old event and loan shape, and each action read one project-wide Diamond address, so none could serve more than one chain. The owner chose to retire them (2026-10-27) rather than rebuild them. The four actions and their manifest are gone, and so are the four alert presets that pointed at them. The signals they were meant to give (a pre-liquidation health-factor page, a feed-heartbeat warning, L2 sequencer transitions and a large-loan flag) now have no confirmed home; #2968 lists each one, so the gap is stated rather than hidden behind code that did nothing.

The remaining alert presets had drifted too. The default alert named an old shape of the default event, the fallback alert an old shape of the fallback event, and the health-factor liquidation alert an event the platform declares but never emits. Tenderly accepts such a preset and it simply never fires. The presets now name the events the platform emits today, and the export script that expands them per chain checks every Diamond preset against the Diamond's compiled interface and refuses the whole run, writing nothing, when a preset names a signature the Diamond does not carry. The check proves the signature exists, not that something emits it; the timelock preset is reported as unchecked because no timelock interface is committed.

Closes #2869.

> Caveat: discounted, partial and matched liquidations have no alert preset (tracked in #2968).
