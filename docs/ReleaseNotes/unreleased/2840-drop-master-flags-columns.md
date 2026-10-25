## Thread — the indexer's configuration snapshot drops the retired master-flags columns (#2840)

The configuration snapshot table kept two columns for the master-flags read that #2812 retired with the range flags. The indexer stopped reading them in #2839, but it still had to write a placeholder into one of them, because that column was declared as never empty and the database cannot relax that in place. A new shared migration drops both columns, and the snapshot refresh no longer names them.

The migration applies while the previous indexer is still serving. In that short window, the old build's snapshot refresh fails on the missing column. That failure is already handled. It is logged, and the stored snapshot keeps its previous values. If the scan had seen a governance or pause event, the snapshot is also marked out of date, so the app reads the contracts directly until the new build's next scan refreshes it. Nothing else reads or writes these columns.

Closes #2840.
