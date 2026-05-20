## Thread — `docs/internal/ProjectProcedures.md` — consolidated operator handbook (PR #<n>)

Adds a single human-readable operator handbook at
`docs/internal/ProjectProcedures.md` that captures every git / PR / CI
/ project-board / release-notes convention currently in force. The
content has accumulated across `CLAUDE.md`, agent memories, and ad-hoc
session conversations; this file is the canonical reference for it.

The new doc and `CLAUDE.md` are deliberately complementary, not
redundant:

- `CLAUDE.md` is **AI-instruction-shaped** — "do this when working".
  Lives at the repo root so the agent picks it up automatically.
- `docs/internal/ProjectProcedures.md` is **reference-shaped** — "this
  is how we work here". Sectioned for top-to-bottom reading or
  spot-lookup. Includes runnable checklists for "opening a PR",
  "picking up a card", "post-merge sweep", and the eight `Protect
  main` gates.

Eleven sections: repository topology, git procedures, PR workflow,
post-merge sweep, project board (`@vaipakam-labs`) discipline,
release notes + FunctionalSpecs, CI + branch protection, issues +
labels, tooling reference, pre-audit hardening current-state summary,
and living-doc rules.

The doc explicitly distinguishes what lives in the repo (procedures
that need to survive across machines / contributors / time) from
what lives only in agent memory (tool-side conventions like the
polling-launch hygiene or the graphify Solidity patch re-application
flow). Without that boundary, a future contributor sees ambient
discipline that isn't actually written down.

No code change. Pure docs.
