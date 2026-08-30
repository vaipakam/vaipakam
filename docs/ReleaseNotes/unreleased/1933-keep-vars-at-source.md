## Thread — Worker vars now survive a deploy by configuration, not by remembering a flag (PR #1995)

The keeper and the agent both read tuning values that live only in the
Cloudflare dashboard: liquidation thresholds and confidence windows for the
keeper, recipient-token validation and marketplace pagination for the agent. A
plain deployment wipes those, because Wrangler treats the checked-in
configuration as the source of truth and deletes anything not in it before
setting what is. The consequence is not cosmetic — it reverts live risk
behaviour to defaults at the moment it starts mattering, silently.

Until now the defence was to remember a preservation flag on every command
that deploys, and a repository-wide checker that hunted for commands missing
it. That defence is unbounded by construction: a deployment can be spelled
through a package script, an alias in a manifest, a Makefile variable, a
sourced helper, a shell function, a shell alias, a build-matrix value, a
reusable-workflow input, a Windows shim, an eval, or a marketplace action.
Review found two hundred and forty-two distinct spellings across this work and
was still finding more, because each fix taught the reviewer where to look
next. The checker was correct and getting steadily better at an endless task.

The preservation is now declared once per Worker, in the Worker's own
configuration, which is where Wrangler reads it for both immediate deploys and
staged version uploads. Every route to a deployment becomes safe at the same
moment, including routes nobody has written yet, and the five Workers that
carry operator-managed values all declare it. A small test asserts that
declaration, which is a bounded and complete check in a way that searching for
command spellings can never be.

The repository-wide checker is kept, and it now reads the same declaration
Wrangler does. That makes it defence in depth that switches itself off: while a
Worker declares preservation nothing is reported for it, and if the declaration
is ever removed the full command-level scrutiny returns for that Worker
automatically. The trade this accepts is deliberate and worth stating — a
deployment can no longer delete an operator-managed value, so removing one is
now an explicit action in the dashboard rather than a side effect of shipping
code.

Refs #1933.
