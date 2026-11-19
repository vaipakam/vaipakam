## CI: workflow lint and a wider docs link check (#3548)

The CI workflows are now checked on every pull request:
- for syntax and shell mistakes in their scripts;
- for common security weaknesses: credentials left behind by checkouts, permissions wider than a job needs, a release check reusing a cache another run wrote, and risky triggers;
- for any template expression written straight into a shell script.

Every workflow was brought to a clean result first:
- Values now reach scripts through environment variables.
- Checkouts no longer keep the repository token on disk.
- The Pages deploy grants write access only to the job that publishes.
- The mainnet release gate compiles from scratch instead of restoring a shared build cache.

The docs path check now also covers links in every living document, not only the operator runbooks; history (shipped release notes and older docs) is left as written. The 75 dead links it found are fixed. Links that had the wrong depth now point at the right file. Links to files that no longer exist are kept as plain text.
