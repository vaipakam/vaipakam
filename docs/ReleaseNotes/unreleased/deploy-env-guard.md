# Deploy-env guard: builds without the indexer origin can't ship silently

Guard born from a live incident: a connected-app deploy built from a
checkout without its env file compiled and served flawlessly while
silently running the whole app in its all-chain fallback posture — no
indexer offer book, no push rail, no config snapshot. Nothing in the
build or deploy pipeline said a word.

Both connected apps' builds now check for the indexer origin. A plain
build (CI, previews) prints a loud warning and proceeds — automated
builds legitimately lack operator env. The deploy script's build runs
in strict mode and refuses to produce a bundle at all, so the
operator path that publishes to the live site can no longer ship an
indexer-less build by accident.
