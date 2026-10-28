## Thread — One writer for the deployment artifact's facet addresses (PR #3016)

Each chain's deployment artifact keeps the address of every Diamond facet
under one section, and the deploy and refresh scripts are meant to record a
facet there only through the dedicated facet writer. Until now the general
purpose writers could reach the same section too, so a script could record a
facet name that matches no facet, use a key the facet writer would never
produce, or overwrite a correctly recorded facet address later in the run.
Nothing checked for any of those.

The general purpose writers now accept a key only in the one plain spelling
the scripts use (dot-separated names of letters, digits and underscores), so a
bracketed or otherwise re-spelled path cannot name the facet section by another
route. They refuse any key inside the facet section and name the facet writer
in the refusal. The facet writer refuses a facet name that is empty or carries
anything but letters, digits and underscores. Every existing
script was checked: none wrote the facet section through a general writer,
so no deploy or refresh changes what it records. A new test writes into a
scratch artifact on both sides of the boundary. Closes #2263.
