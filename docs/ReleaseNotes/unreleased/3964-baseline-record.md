# The baseline record and its check: what "tagged" means

Closes #3964.

A tag names source, but the refactor pass compares builds, and a later toolchain can build different code from the same source. So a tag of the reference series now comes with a record made at the tag: for every deployable contract the hash of its runtime code, its size and the hash of its interface; the storage layout's recorded file; the gas suite's figure for every measured action; the full regression's manifests with the tests each chunk ran and passed; the compiler, its settings, the build tool and every vendored library; and the commit and source tree it was built from.

A file cannot name the commit that contains it, so the record names its source tree, the tag's message carries the record's hash, and the tag names the commit that adds the record. The baseline check proves the three agree and rebuilds the tagged commit with the recorded versions. It refuses, naming each difference, a lightweight or unsigned tag, a message without the record's hash, a commit that changes more than the record, another source tree, another library pin or layout, another build tool or compiler, and any contract whose code, size or interface differs. It can also judge a build someone already made, by content, which is how the differential run (#3926) will check its reference before it starts.

The full regression's manifest now records each chunk's tests run and passed, which the record carries. The tagging steps, including the keeper bot's matching tag, the private review copy and the testnet deploy from the same commit, are in `docs/procedures/BaselineTagging.md`. The repository rule that protects the series' tags is an owner step, and the launch check's reads of it go with #3937.
