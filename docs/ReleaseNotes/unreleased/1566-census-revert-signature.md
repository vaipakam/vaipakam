## Thread — the custody census tells a bare shell from a stranger again (#1566)

The custody census reads every deployment's state at a block named by its
fingerprint, and shapes the failures those reads return itself. A failure the
census cannot name — the reply a Diamond gives when it is asked for a function
it does not route — was being passed through with nothing but "reverted"
attached, so the three archived base-sepolia deployments whose cut never ran
were reported as contracts that are not Diamonds at all. The distinction
matters to the operator: a shell whose cut never ran is a Diamond with nothing
routed, while a stranger at the recorded address means the record itself needs
correcting. Both are undetermined for the census, so no count changed, and the
committed result predates the fault, so nothing published was wrong. An
unnamed failure now carries its own signature, the way the library the census
replaced had reported it, and the three shells are classed as shells again.
