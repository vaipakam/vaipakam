## Weekly kickoff card replaces the previous one (PR #2522)

The weekly "Iteration kickoff sync" card used to be filed every Monday without ever closing the one before it, so unworked cards piled up; nineteen were open on 2026-10-16 and had to be closed by hand. Each run now closes every older open kickoff card right after filing the new one, and leaves a comment on each that links its successor. A close that fails is retried by the next run, so a missed week cannot leave a card stranded.

Nothing in the ritual is lost when a card closes unworked. The ritual walks every memory note changed since the last sync sentinel, not since the previous Monday, so the new card covers whatever the old one left. The cards now carry a dedicated `iteration-kickoff` label, recorded in the labels guide, which is how older cards are found; no other issue should carry it.
